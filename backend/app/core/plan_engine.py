"""Plan mutation engine.

`draft_itinerary` writes a whole plan once; every later change goes through a
typed op list on `update_itinerary` (docs §2.1).  Ops are applied to a deep copy,
hard invariants are checked, and only then is the new plan returned for
persistence.  IDs are never regenerated: stop_id / activity_id must survive a
replan (docs §2.2).

Fatal validation failures raise `PlanValidationError`; the caller returns them
to the model as a tool error and *does not persist* anything.
"""

from __future__ import annotations

import copy
import uuid
from datetime import date, datetime, timezone
from enum import StrEnum
from typing import Any

from pydantic import ValidationError

from app.core.opening_hours import hydrate_opening_hours
from app.core.validator import build_diff, hard_errors
from app.schemas.plan import (
    Activity,
    Constraints,
    Day,
    Revision,
    Rhythm,
    Stop,
    Ticket,
    TicketKind,
    Trip,
)


class OpType(StrEnum):
    UPDATE_STOP = "update_stop"
    REMOVE_STOP = "remove_stop"
    INSERT_STOP = "insert_stop"
    REORDER = "reorder"
    UPDATE_ACTIVITY = "update_activity"
    REMOVE_ACTIVITY = "remove_activity"
    INSERT_ACTIVITY = "insert_activity"
    SET_DAY_RHYTHM = "set_day_rhythm"
    SET_CONSTRAINTS = "set_constraints"


class PlanValidationError(Exception):
    def __init__(self, errors: list[str], op_index: int | None = None):
        self.errors = errors
        self.op_index = op_index
        super().__init__("; ".join(errors))

    def as_tool_error(self) -> dict[str, Any]:
        return {
            "ok": False,
            "error": "validation_error",
            "message": "行程写入被校验器拒绝，未做任何修改。请修正后重试。",
            "details": self.errors,
            "op_index": self.op_index,
        }


STOP_PATCH_FIELDS = {"poi", "seq", "opening_hours"}
ACTIVITY_PATCH_FIELDS = {
    "seq",
    "type",
    "title",
    "time_window",
    "note",
    "tips",
    "transit_from_prev",
    "transit_detail",
    "ticket",
    "source_refs",
}
CONSTRAINT_PATCH_FIELDS = {
    "origin",
    "destination",
    "date_range",
    "travelers",
    "budget",
    "transport_mode",
    "vehicle",
    "pace",
    "diet",
    "must_go",
    "must_avoid",
    "assumptions",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def find_day(trip: Trip, day_index: int) -> Day:
    for day in trip.days:
        if day.day_index == day_index:
            return day
    raise PlanValidationError([f"找不到 Day {day_index}"])


def find_stop(trip: Trip, stop_id: str) -> tuple[Day, Stop]:
    found = trip.find_stop(stop_id)
    if not found:
        raise PlanValidationError([f"找不到 stop_id={stop_id}"])
    return found


def _new_stop_id() -> str:
    return "s_" + uuid.uuid4().hex[:8]


def _new_activity_id() -> str:
    return "a_" + uuid.uuid4().hex[:8]


def draft_trip(
    existing: Trip,
    payload: dict[str, Any],
    *,
    summary: str | None = None,
    user_request: str | None = None,
    turn_seq: int | None = None,
    known_refs: set[str] | None = None,
    opening_hours_payloads: dict[str, dict[str, Any]] | None = None,
    policy: str = "legacy",
) -> tuple[Trip, list[dict[str, Any]]]:
    """Create the first version, or replace the plan wholesale with a new version."""
    if not isinstance(payload, dict):
        raise PlanValidationError(["draft_itinerary 的 trip 必须是对象"])
    data = copy.deepcopy(payload)
    days = data.get("days")
    if not isinstance(days, list) or not days:
        raise PlanValidationError(
            ["draft_itinerary 缺少 trip.days：初版行程至少要有 1 天，空行程会被拒绝"]
        )
    if not any(isinstance(day, dict) and day.get("stops") for day in days):
        raise PlanValidationError(
            ["trip.days 里没有任何 stops：初版行程至少安排一个地点，不能写空行程"]
        )
    data["trip_id"] = existing.trip_id
    data.setdefault("title", existing.title)
    data["version"] = max(1, existing.version + 1) if existing.days else 1
    data.setdefault("created_at", existing.created_at or _now_iso())
    data["updated_at"] = _now_iso()

    # ensure ids exist for the model's convenience, but never touch existing ones
    for day in data.get("days", []):
        for stop in day.get("stops", []):
            stop.setdefault("stop_id", _new_stop_id())
            for act in stop.get("activities", []):
                act.setdefault("activity_id", _new_activity_id())
        # 初版按时间排：卡片流、地图编号、抽屉都依赖数组顺序体现先后
        _sort_day_by_time(day)

    try:
        new_trip = Trip.model_validate(data)
    except ValidationError as exc:
        raise PlanValidationError([str(e) for e in exc.errors()]) from exc

    # 营业时间：模型只引用 source_ref，值由服务端从登记簿回填（02 §3.2）
    missing_hours = hydrate_opening_hours(new_trip, opening_hours_payloads)
    if policy == "agent":
        # 01 §9.2 分级规则：票价/渠道/班次没有来源就置空，行程照常写入
        _sanitize_unsourced_facts(new_trip, known_refs)
    errors = hard_errors(new_trip, known_refs)
    errors.extend(_opening_hours_errors(new_trip, missing_hours))
    if policy == "agent":
        errors.extend(_reject_new_hotel_tickets(existing, new_trip))
    if errors:
        raise PlanValidationError(errors)

    old = existing
    new_trip.revision_log = list(existing.revision_log) + [
        Revision(
            version=new_trip.version,
            turn_seq=turn_seq,
            summary=summary or ("重写行程" if old.days else "生成初版行程"),
            user_request=user_request,
            op_count=sum(len(s.activities) + 1 for d in new_trip.days for s in d.stops),
            changed_stop_ids=["*"],
            changed_activity_ids=["*"],
            created_at=_now_iso(),
        )
    ]
    diff = build_diff(old, new_trip) if old.days else []
    return new_trip, diff


def apply_ops(
    existing: Trip,
    ops: list[dict[str, Any]],
    *,
    summary: str | None = None,
    user_request: str | None = None,
    turn_seq: int | None = None,
    known_refs: set[str] | None = None,
    opening_hours_payloads: dict[str, dict[str, Any]] | None = None,
    policy: str = "legacy",
) -> tuple[Trip, list[dict[str, Any]], dict[str, Any]]:
    if not ops:
        raise PlanValidationError(["ops 不能为空"])
    trip = existing.model_copy(deep=True)
    changed_stops: set[str] = set()
    changed_activities: set[str] = set()
    changed_days: set[int] = set()

    for idx, raw in enumerate(ops):
        if not isinstance(raw, dict):
            raise PlanValidationError(["op 必须是对象"], idx)
        op = raw.get("op")
        try:
            if op == OpType.UPDATE_STOP:
                stop_id = raw.get("stop_id")
                if not stop_id:
                    raise PlanValidationError(["update_stop 缺少 stop_id"], idx)
                day, stop = find_stop(trip, stop_id)
                patch = raw.get("patch") or {}
                _ensure_fields(patch, STOP_PATCH_FIELDS, "update_stop.patch", idx)
                data = stop.model_dump()
                data.update(patch)
                data["stop_id"] = stop.stop_id  # immutable
                updated = Stop.model_validate(data)
                stop_idx = day.stops.index(stop)
                day.stops[stop_idx] = updated
                changed_stops.add(stop_id)
                changed_days.add(day.day_index)

            elif op == OpType.REMOVE_STOP:
                stop_id = raw.get("stop_id")
                if not stop_id:
                    raise PlanValidationError(["remove_stop 缺少 stop_id"], idx)
                day, stop = find_stop(trip, stop_id)
                day.stops.remove(stop)
                changed_stops.add(stop_id)
                changed_activities.update(a.activity_id for a in stop.activities)
                changed_days.add(day.day_index)

            elif op == OpType.INSERT_STOP:
                day = find_day(trip, int(raw.get("day_index", 0)))
                stop_data = copy.deepcopy(raw.get("stop") or {})
                stop_data.setdefault("stop_id", _new_stop_id())
                if any(s.stop_id == stop_data["stop_id"] for s in day.stops):
                    raise PlanValidationError([f"stop_id 已存在：{stop_data['stop_id']}"], idx)
                at_seq = int(raw.get("at_seq", len(day.stops) + 1))
                stop_data["seq"] = at_seq
                new_stop = Stop.model_validate(stop_data)
                day.stops.append(new_stop)
                day.stops.sort(key=lambda s: (s.seq, s.stop_id))
                _resequence(day)
                changed_stops.add(new_stop.stop_id)
                changed_activities.update(a.activity_id for a in new_stop.activities)
                changed_days.add(day.day_index)

            elif op == OpType.REORDER:
                day = find_day(trip, int(raw.get("day_index", 0)))
                stop_ids = raw.get("stop_ids") or []
                by_id = {s.stop_id: s for s in day.stops}
                if set(stop_ids) != set(by_id) or len(stop_ids) != len(by_id):
                    raise PlanValidationError(
                        [f"reorder 的 stop_ids 必须恰好包含当天全部 stop（当前 {sorted(by_id)}）"], idx
                    )
                day.stops = [by_id[sid] for sid in stop_ids]
                _resequence(day)
                changed_stops.update(stop_ids)
                changed_days.add(day.day_index)

            elif op == OpType.UPDATE_ACTIVITY:
                activity_id = raw.get("activity_id")
                if not activity_id:
                    raise PlanValidationError(["update_activity 缺少 activity_id"], idx)
                found = trip.find_activity(activity_id)
                if not found:
                    raise PlanValidationError([f"找不到 activity_id={activity_id}"], idx)
                day, stop, act = found
                patch = raw.get("patch") or {}
                _ensure_fields(patch, ACTIVITY_PATCH_FIELDS, "update_activity.patch", idx)
                data = act.model_dump()
                data.update(patch)
                data["activity_id"] = act.activity_id
                updated = Activity.model_validate(data)
                stop_idx = day.stops.index(stop)
                activity_idx = stop.activities.index(act)
                stop.activities[activity_idx] = updated
                stop.activities.sort(key=lambda a: (a.seq, a.activity_id))
                changed_activities.add(activity_id)
                changed_stops.add(stop.stop_id)
                changed_days.add(day.day_index)

            elif op == OpType.REMOVE_ACTIVITY:
                activity_id = raw.get("activity_id")
                found = trip.find_activity(str(activity_id)) if activity_id else None
                if not found:
                    raise PlanValidationError([f"找不到 activity_id={activity_id}"], idx)
                day, stop, act = found
                stop.activities.remove(act)
                changed_activities.add(act.activity_id)
                changed_stops.add(stop.stop_id)
                changed_days.add(day.day_index)

            elif op == OpType.INSERT_ACTIVITY:
                stop_id = raw.get("stop_id")
                if not stop_id:
                    raise PlanValidationError(["insert_activity 缺少 stop_id"], idx)
                day, stop = find_stop(trip, stop_id)
                act_data = copy.deepcopy(raw.get("activity") or {})
                act_data.setdefault("activity_id", _new_activity_id())
                if any(a.activity_id == act_data["activity_id"] for a in stop.activities):
                    raise PlanValidationError([f"activity_id 已存在：{act_data['activity_id']}"], idx)
                act_data["seq"] = int(raw.get("at_seq", len(stop.activities) + 1))
                new_act = Activity.model_validate(act_data)
                stop.activities.append(new_act)
                stop.activities.sort(key=lambda a: (a.seq, a.activity_id))
                changed_activities.add(new_act.activity_id)
                changed_stops.add(stop.stop_id)
                changed_days.add(day.day_index)

            elif op == OpType.SET_DAY_RHYTHM:
                day = find_day(trip, int(raw.get("day_index", 0)))
                rhythm = Rhythm.model_validate(raw.get("rhythm") or {})
                day.rhythm = rhythm
                changed_days.add(day.day_index)

            elif op == OpType.SET_CONSTRAINTS:
                patch = raw.get("patch") or {}
                _ensure_fields(patch, CONSTRAINT_PATCH_FIELDS, "set_constraints.patch", idx)
                data = trip.constraints.model_dump()
                data.update(patch)
                trip.constraints = Constraints.model_validate(data)

            else:
                raise PlanValidationError([f"未知 op：{op}"], idx)
        except PlanValidationError:
            raise
        except (ValidationError, ValueError, TypeError) as exc:
            raise PlanValidationError([f"第 {idx + 1} 个 op 参数不合法：{exc}"], idx) from exc

    trip.version = existing.version + 1
    trip.updated_at = _now_iso()
    missing_hours = hydrate_opening_hours(trip, opening_hours_payloads)
    if policy == "agent":
        _sanitize_unsourced_facts(trip, known_refs)
    errors = hard_errors(trip, known_refs)
    errors.extend(_opening_hours_errors(trip, missing_hours))
    if policy == "agent":
        errors.extend(_reject_new_hotel_tickets(existing, trip))
    if errors:
        raise PlanValidationError(errors)

    changed = {
        "day_indexes": sorted(changed_days),
        "stop_ids": sorted(changed_stops),
        "activity_ids": sorted(changed_activities),
    }
    trip.revision_log = list(existing.revision_log) + [
        Revision(
            version=trip.version,
            turn_seq=turn_seq,
            summary=summary or (f"{len(ops)} 处修改"),
            user_request=user_request,
            op_count=len(ops),
            changed_stop_ids=sorted(changed_stops),
            changed_activity_ids=sorted(changed_activities),
            created_at=_now_iso(),
        )
    ]
    diff = build_diff(existing, trip)
    return trip, diff, changed


UNSOURCED_NOTE = "票价/渠道/班次未核实（没有工具来源），已置空"


def _sanitize_unsourced_facts(trip: Trip, known_refs: set[str] | None) -> None:
    """没有来源的时效事实一律置空，行程照常写入（01 §9.2）。

    坐标与路程时长是硬拒写；票价、渠道、班次这些则是「留空 + 待核实」。
    只对模型写入路径生效，避免把种子数据/历史快照冲掉。
    """
    for _day, _stop, act in trip.iter_activities():
        ticket = act.ticket
        if ticket is not None and ticket.kind != TicketKind.NONE:
            sourced = bool(ticket.source_ref) and _ref_ok(ticket.source_ref, known_refs)
            has_facts = bool(
                ticket.price_range
                or ticket.channels
                or ticket.lead_time_days
                or ticket.sale_rule
                or ticket.limited_quota
            )
            if has_facts and not sourced:
                ticket.price_range = None
                ticket.channels = []
                ticket.lead_time_days = None
                ticket.sale_rule = None
                ticket.limited_quota = None
                ticket.note = UNSOURCED_NOTE if not ticket.note else f"{ticket.note}（{UNSOURCED_NOTE}）"
        detail = act.transit_detail
        if detail is not None and getattr(detail, "mode", None) in {
            "flight",
            "train",
        }:
            sourced = bool(getattr(detail, "source_ref", None)) and _ref_ok(
                getattr(detail, "source_ref", None), known_refs
            )
            if not sourced:
                # 没有来源的班次不许写；站名/机场名可以留（它们不是时效事实）
                for field in ("flight_no", "train_no", "dep_time", "arr_time"):
                    if hasattr(detail, field):
                        setattr(detail, field, None)


def _ref_ok(ref: str | None, known_refs: set[str] | None) -> bool:
    from app.core.validator import _known

    return _known(ref, known_refs)


def _sort_day_by_time(day: dict[str, Any]) -> None:
    """按当天活动开始时间重排 stops / activities（只用于初版行程）。

    用户后续用 reorder op 明确调整过的顺序不会被这一步覆盖（那条路径不经过这里）。
    """
    stops = day.get("stops") or []
    if not isinstance(stops, list):
        return

    def start_of(stop: Any) -> str:
        if not isinstance(stop, dict):
            return "99:99"
        times = [
            (act.get("time_window") or {}).get("start")
            for act in stop.get("activities") or []
            if isinstance(act, dict)
        ]
        values = [str(value) for value in times if value]
        return min(values) if values else "99:99"

    for stop in stops:
        if not isinstance(stop, dict):
            continue
        acts = stop.get("activities") or []
        if isinstance(acts, list):
            acts.sort(
                key=lambda act: str(
                    ((act.get("time_window") or {}) if isinstance(act, dict) else {}).get("start")
                    or "99:99"
                )
            )
    stops.sort(key=start_of)


def _opening_hours_errors(trip: Trip, missing_stop_ids: list[str]) -> list[str]:
    names = {
        stop.stop_id: stop.poi.name
        for _day, stop in trip.iter_stops()
        if stop.stop_id in set(missing_stop_ids)
    }
    return [
        f"地点「{names.get(sid, sid)}」的营业时间来源不在来源登记簿里；"
        "请重新调用 opening_hours_lookup 并把返回的 source_ref 填进 opening_hours.source_refs"
        for sid in sorted(names)
    ]


def _hotel_ticket_ids(trip: Trip) -> set[str]:
    return {
        act.activity_id
        for _day, _stop, act in trip.iter_activities()
        if act.ticket is not None and act.ticket.kind == TicketKind.HOTEL
    }


def _reject_new_hotel_tickets(existing: Trip, new: Trip) -> list[str]:
    """住宿收缩为区域级（01 §10）：只拒绝**新写入**的酒店票。

    历史快照与种子数据里的 hotel 票必须还能读出来，所以不能在校验器里一刀切。
    """
    allowed = _hotel_ticket_ids(existing)
    errors: list[str] = []
    for _day, stop, act in new.iter_activities():
        ticket = act.ticket
        if ticket is None or ticket.kind != TicketKind.HOTEL:
            continue
        if act.activity_id in allowed:
            continue
        errors.append(
            f"「{stop.poi.name}」的「{act.title}」写了酒店票（ticket.kind=hotel）。"
            "住宿已收缩为区域级：只写住在哪个地点（stay 活动标题形如「住宿 · 禾木村（自行安排）」），"
            "不要写酒店名、价格、渠道或酒店票。"
        )
    return errors


def _ensure_fields(patch: dict[str, Any], allowed: set[str], where: str, idx: int) -> None:
    unknown = sorted(set(patch) - allowed)
    if unknown:
        raise PlanValidationError(
            [f"{where} 不允许字段：{', '.join(unknown)}（只允许 {', '.join(sorted(allowed))}）"], idx
        )


def _resequence(day: Day) -> None:
    for i, stop in enumerate(day.stops, start=1):
        stop.seq = i
        for j, act in enumerate(
            sorted(stop.activities, key=lambda a: (a.seq, a.activity_id)), start=1
        ):
            act.seq = j


def draft_from_template(
    template: Trip,
    existing: Trip,
    *,
    title: str | None = None,
    known_refs: set[str] | None = None,
) -> Trip:
    """Used by the mock planner: copy the acceptance itinerary as v1."""
    new = template.model_copy(deep=True)
    new.trip_id = existing.trip_id
    new.title = title or existing.title or template.title
    new.version = 1
    new.created_at = _now_iso()
    new.updated_at = _now_iso()
    new.revision_log = [
        Revision(
            version=1,
            summary="根据澄清结果生成初版北疆 8 日环线",
            user_request="马上五一了，我想去新疆旅游，给个推荐路线",
            op_count=1,
            changed_stop_ids=["*"],
            changed_activity_ids=["*"],
            created_at=_now_iso(),
        )
    ]
    errors = hard_errors(new, known_refs)
    if errors:
        raise PlanValidationError(errors)
    return new


__all__ = [
    "OpType",
    "PlanValidationError",
    "apply_ops",
    "draft_trip",
    "draft_from_template",
    "find_day",
    "find_stop",
]
