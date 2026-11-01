"""Feasibility checker + derived fields.

Pure functions: input a Trip, output Derived.  No I/O, no agent loop dependency
(docs §3, 03-mvp §1.3).  Every write is validated with `hard_errors` first; a
hard error rejects the write and goes back to the model as a validation error.
Feasibility problems are persisted but surfaced as conflicts.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from datetime import date, datetime, time, timedelta
from typing import Any

from app.core.opening_hours import opening_hours_conflicts
from app.schemas.plan import (
    Activity,
    ActivityType,
    BookingItem,
    BudgetSummary,
    Conflict,
    ConflictSeverity,
    ConflictType,
    Day,
    DayDerived,
    Derived,
    DerivedWindow,
    PoiRef,
    TicketKind,
    Trip,
)
from app.schemas.sources import EvidenceStatus

PACE_LIMITS = {"relaxed": 10.0, "normal": 12.0, "intense": 14.0}
TRANSIT_LABELS = {
    "wechat_mp": "微信公众号",
    "mini_program": "微信小程序",
    "app": "App",
    "web": "网页",
    "ota": "OTA",
    "onsite": "现场",
}


# --------------------------------------------------------------------------
# time helpers
# --------------------------------------------------------------------------


def minutes_of(t: time) -> int:
    return t.hour * 60 + t.minute


def _hm(t: time | None) -> str:
    return t.strftime("%H:%M") if t else "—"


def _parse_hm(value: str | None) -> int | None:
    if not value:
        return None
    try:
        h, m = value.split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _duration_minutes(act: Activity) -> int:
    start = minutes_of(act.time_window.start)
    end = minutes_of(act.time_window.end)
    if end < start:  # cross-midnight
        end += 24 * 60
    return max(0, end - start)


def _fmt_minutes(total: int) -> str:
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


def _safe_date(raw: Any) -> date | None:
    if isinstance(raw, date):
        return raw
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def _conflict_id(ctype: ConflictType, day_index: int | None, *ids: str | None) -> str:
    base = "_".join(str(x) for x in (ctype.value, day_index, *ids) if x)
    digest = hashlib.sha1(base.encode()).hexdigest()[:6]
    return f"{base}_{digest}"


# --------------------------------------------------------------------------
# hard validation (rejects a write)
# --------------------------------------------------------------------------


def _known(ref: str | None, known_refs: set[str] | None) -> bool:
    """登记簿核对（01 §9.1）。`known_refs is None` 表示这条路径不核对（读库/种子）。"""
    if not ref:
        return False
    if known_refs is None:
        return True
    if ref.startswith(("poi:seed:", "poi:amap:", "poi:user:", "route:seed:", "web:seed:", "local:")):
        return True
    return ref in known_refs


def hard_errors(trip: Trip, known_refs: set[str] | None = None) -> list[str]:
    """Invariants that must never be persisted.

    1. coordinates / amap_poi_id need a source_ref (docs §3, §4.8)
    2. stop_id / activity_id must be unique and non-empty (docs §2.2)
    3. a long_transit must carry its discriminated detail
    4. `source_ref` 必须是来源登记簿里真实出现过的（new-plan 01 §9.1）

    `known_refs` 为 None 时跳过第 4 条：读库、种子数据、离线坐标校正这些路径没有
    登记簿上下文，不能因为「服务端自己写的 ref 不在本趟清单里」就拒绝整份行程。
    """
    errors: list[str] = []
    stop_ids: set[str] = set()
    activity_ids: set[str] = set()
    for day, stop in trip.iter_stops():
        if not stop.stop_id:
            errors.append(f"Day {day.day_index} 存在空的 stop_id")
        elif stop.stop_id in stop_ids:
            errors.append(f"stop_id 重复：{stop.stop_id}")
        stop_ids.add(stop.stop_id)

        poi = stop.poi
        if (poi.lng is not None or poi.lat is not None or poi.amap_poi_id) and not poi.source_ref:
            errors.append(
                f"地点「{poi.name}」的坐标/amap_poi_id 缺少 source_ref；"
                "坐标只能来自 search_poi 的真实返回，请重新调用 search_poi"
            )
        elif poi.source_ref and not _known(poi.source_ref, known_refs):
            errors.append(
                f"地点「{poi.name}」的 source_ref（{poi.source_ref}）不在本趟来源登记簿里；"
                "坐标只能来自本趟 search_poi 的真实返回，请重新调用 search_poi"
            )
        if stop.opening_hours is not None:
            refs = [r for r in stop.opening_hours.source_refs if r]
            if not refs:
                errors.append(
                    f"地点「{poi.name}」的营业时间只允许写 source_refs（值由服务端回填），"
                    "请先用 opening_hours_lookup 取到证据再引用"
                )
            for ref in refs:
                if not _known(ref, known_refs):
                    errors.append(
                        f"地点「{poi.name}」的营业时间来源（{ref}）不在本趟来源登记簿里"
                    )
        if (poi.lng is None) != (poi.lat is None):
            errors.append(f"地点「{poi.name}」的经纬度必须成对出现")

        for act in stop.activities:
            if not act.activity_id:
                errors.append(f"地点「{poi.name}」存在空的 activity_id")
            elif act.activity_id in activity_ids:
                errors.append(f"activity_id 重复：{act.activity_id}")
            activity_ids.add(act.activity_id)

            if act.type == ActivityType.LONG_TRANSIT and act.transit_detail is None:
                errors.append(f"长途活动「{act.title}」缺少 transit_detail")
            for ref in act.source_refs:
                if not _known(ref, known_refs):
                    errors.append(f"活动「{act.title}」的来源（{ref}）不在本趟来源登记簿里")
            if act.ticket is not None:
                ticket = act.ticket
                if ticket.source_ref and not _known(ticket.source_ref, known_refs):
                    errors.append(
                        f"活动「{act.title}」的门票来源（{ticket.source_ref}）不在本趟来源登记簿里"
                    )
                if ticket.sale_rule is not None:
                    if not ticket.sale_rule.source_ref:
                        errors.append(
                            f"活动「{act.title}」写了开售规则却没有 source_ref；"
                            "请先用 ticket_channel_lookup 取到证据"
                        )
                    elif not _known(ticket.sale_rule.source_ref, known_refs):
                        errors.append(
                            f"活动「{act.title}」的开售规则来源不在本趟来源登记簿里"
                        )
                if ticket.limited_quota is not None:
                    if not ticket.limited_quota.source_ref:
                        errors.append(f"活动「{act.title}」的稀缺度描述缺少 source_ref")
                    elif not _known(ticket.limited_quota.source_ref, known_refs):
                        errors.append(
                            f"活动「{act.title}」的稀缺度来源不在本趟来源登记簿里"
                        )
                for channel in ticket.channels:
                    if (
                        channel.status == "verified"
                        and channel.evidence_url
                        and known_refs is not None
                        and channel.evidence_url.startswith(("web:", "tool:"))
                        and not _known(channel.evidence_url, known_refs)
                    ):
                        errors.append(
                            f"活动「{act.title}」的官方渠道「{channel.name}」出处不在登记簿里"
                        )
            if act.type != ActivityType.LONG_TRANSIT and act.transit_detail is not None:
                errors.append(f"非长途活动「{act.title}」不应填写 transit_detail")
    return errors


# --------------------------------------------------------------------------
# public entry point
# --------------------------------------------------------------------------


def validate_and_derive(trip: Trip, today: date | None = None) -> Derived:
    today = today or date.today()
    conflicts: list[Conflict] = []
    day_derived: list[DayDerived] = []

    conflicts.extend(_coord_conflicts(trip))
    conflicts.extend(_season_conflicts(trip))
    # 营业时间（02 §3.3）：只有 verified 证据才报冲突
    conflicts.extend(opening_hours_conflicts(trip))

    for day in trip.days:
        day_conflicts = _check_day(trip, day)
        conflicts.extend(day_conflicts)
        dd = _derive_day(day, day_conflicts)
        day_derived.append(dd)

    conflicts.extend(_must_go_conflicts(trip, conflicts))
    booking_timeline = _booking_timeline(trip, today)
    budget = _budget_summary(trip)
    if budget.budget_total and budget.grand_total > budget.budget_total:
        over = budget.grand_total - budget.budget_total
        conflicts.append(
            Conflict(
                id=_conflict_id(ConflictType.BUDGET_EXCEEDED, None),
                type=ConflictType.BUDGET_EXCEEDED,
                severity=ConflictSeverity.WARNING,
                message=f"行程预算 ¥{budget.grand_total:,.0f} 超出设定 ¥{budget.budget_total:,.0f}，超出 ¥{over:,.0f}。",
                suggested_fix="减少一段机票、换更便宜的交通方式，或在对话中修改预算上限；住宿不参与估算。",
            )
        )

    # severity sort: errors first, then by day
    conflicts.sort(
        key=lambda c: (
            0 if c.severity == ConflictSeverity.ERROR else 1,
            c.day_index if c.day_index is not None else 99,
            c.type.value,
        )
    )
    # attach per-day conflicts
    by_day: dict[int, list[Conflict]] = {}
    for c in conflicts:
        if c.day_index is not None:
            by_day.setdefault(c.day_index, []).append(c)
    for dd in day_derived:
        dd.conflicts = by_day.get(dd.day_index, [])

    return Derived(
        days=day_derived,
        booking_timeline=booking_timeline,
        budget_summary=budget,
        conflicts=conflicts,
        ok=not any(c.severity == ConflictSeverity.ERROR for c in conflicts),
        today=today,
    )


# --------------------------------------------------------------------------
# individual checks
# --------------------------------------------------------------------------


def _coord_conflicts(trip: Trip) -> list[Conflict]:
    out: list[Conflict] = []
    for day, stop in trip.iter_stops():
        if stop.poi.source_ref:
            continue
        out.append(
            Conflict(
                id=_conflict_id(ConflictType.MISSING_COORD_SOURCE, day.day_index, stop.stop_id),
                type=ConflictType.MISSING_COORD_SOURCE,
                severity=ConflictSeverity.ERROR,
                day_index=day.day_index,
                stop_id=stop.stop_id,
                message=f"「{stop.poi.name}」的坐标/POI ID 没有来源（source_ref），无法确认地点真实性。",
                suggested_fix="重新调用 search_poi，用返回结果中的经纬度与 amap_poi_id。",
            )
        )
    return out


def _season_window(sc, trip_date: date | None) -> bool:
    """True when the date is outside [open_from, open_to]. Month-day comparison
    is year-agnostic because these windows shift every year."""
    if trip_date is None:
        return False
    if not sc or not sc.open_from or not sc.open_to:
        return False
    try:
        start = datetime.strptime(sc.open_from, "%m-%d").date()
        end = datetime.strptime(sc.open_to, "%m-%d").date()
    except ValueError:
        return False
    md = date(2000, trip_date.month, trip_date.day)
    if start <= end:
        return not (start <= md <= end)
    return not (md >= start or md <= end)


def _season_conflicts(trip: Trip) -> list[Conflict]:
    out: list[Conflict] = []
    seen: set[str] = set()
    start = trip.constraints.date_range.start if trip.constraints.date_range else None
    end = trip.constraints.date_range.end if trip.constraints.date_range else None
    # check scheduled self-drive legs
    for day, stop, act in trip.iter_activities():
        td = act.transit_detail
        if td is None or getattr(td, "mode", None) != "self_drive":
            continue
        sc = getattr(td, "season_closure", None)
        if sc and _season_window(sc, day.date):
            key = f"leg:{act.activity_id}"
            seen.add(key)
            out.append(
                Conflict(
                    id=_conflict_id(ConflictType.SEASON_CLOSED, day.day_index, act.activity_id),
                    type=ConflictType.SEASON_CLOSED,
                    severity=ConflictSeverity.ERROR,
                    day_index=day.day_index,
                    stop_id=stop.stop_id,
                    activity_id=act.activity_id,
                    message=(
                        f"「{act.title}」途经路段季节性封闭（{sc.open_from}–{sc.open_to} 开放，"
                        f"{day.date or '当天'} 无法通行）。"
                    ),
                    suggested_fix=(
                        sc.note
                        or "改期到开放窗口内，或替换为不受季节影响的路段。"
                    ),
                )
            )
    # check must_go targets that themselves have a seasonal window (e.g. 独库公路)
    for ref in trip.constraints.must_go:
        sc = ref.season_closure
        if not sc:
            continue
        check_date = start or next((d.date for d in trip.days if d.date), None)
        if not check_date:
            continue
        if _season_window(sc, check_date) or (end and _season_window(sc, end)):
            scheduled = _must_go_scheduled(trip, ref)
            if scheduled:
                continue
            out.append(
                Conflict(
                    id=_conflict_id(ConflictType.SEASON_CLOSED, None, sc.open_from, ref.name),
                    type=ConflictType.SEASON_CLOSED,
                    severity=ConflictSeverity.ERROR,
                    day_index=None,
                    message=(
                        f"必去点「{ref.name}」季节性开放：{sc.open_from}–{sc.open_to}，"
                        f"本次行程日期 {check_date} 无法通行。"
                        + (f"（{sc.note}）" if sc.note else "")
                    ),
                    suggested_fix=(
                        "三选一：改期到开放窗口内；用替代方案并把它从必去清单移除；"
                        "或保留为「下次再来」。请在对话中做出选择。"
                    ),
                    ask_user=_season_ask_user(ref),
                )
            )
    return out


def _season_ask_user(ref: PoiRef):
    from app.schemas.plan import AskUser, AskUserOption, AskUserQuestion

    return AskUser(
        ask_id=f"season_{hashlib.sha1(ref.name.encode()).hexdigest()[:6]}",
        intro=f"{ref.name}在本次日期内未开放，怎么处理？",
        questions=[
            AskUserQuestion(
                question=f"{ref.name} 季节性未开放，你想怎么处理？",
                multi=False,
                options=[
                    AskUserOption(id="keep", label="保持现方案", note_hint="把它移到「下次再来」"),
                    AskUserOption(id="june", label="改到 6 月出行", note_hint="例如 6.6–6.13，需重查机票"),
                    AskUserOption(id="replace", label="换成其他目的地", note_hint="例如赛里木湖加一天"),
                ],
                note_hint="补充说明",
            )
        ],
        allow_note=True,
        allow_skip=True,
    )


def _must_go_scheduled(trip: Trip, ref: PoiRef) -> bool:
    needle = ref.name.replace(" ", "")
    for _, stop in trip.iter_stops():
        names = [stop.poi.name, getattr(stop.poi, "address", "") or ""]
        if ref.amap_poi_id and stop.poi.amap_poi_id == ref.amap_poi_id:
            return True
        for name in names:
            if needle and (needle in name.replace(" ", "") or name.replace(" ", "") in needle):
                return True
    return False


def _must_go_conflicts(trip: Trip, existing: Iterable[Conflict]) -> list[Conflict]:
    scheduled_errors = {
        c.message for c in existing if c.type == ConflictType.SEASON_CLOSED
    }
    out: list[Conflict] = []
    for ref in trip.constraints.must_go:
        if _must_go_scheduled(trip, ref):
            continue
        if ref.season_closure:
            # represented by season_closed instead of a duplicate missing error
            continue
        out.append(
            Conflict(
                id=_conflict_id(ConflictType.MUST_GO_MISSING, None, ref.name),
                type=ConflictType.MUST_GO_MISSING,
                severity=ConflictSeverity.ERROR,
                message=f"必去点「{ref.name}」没有排进行程。",
                suggested_fix=f"把它插入某一天，或在对话里说明可以放弃「{ref.name}」。",
            )
        )
    return out


def _check_day(trip: Trip, day: Day) -> list[Conflict]:
    out: list[Conflict] = []
    acts: list[tuple[Any, Activity]] = []
    for stop in day.stops:
        for act in stop.activities:
            acts.append((stop, act))
    acts.sort(key=lambda pair: minutes_of(pair[1].time_window.start))

    # overlaps + insufficient transit
    for i in range(1, len(acts)):
        prev_stop, prev = acts[i - 1]
        stop, cur = acts[i]
        prev_end = minutes_of(prev.time_window.end)
        cur_start = minutes_of(cur.time_window.start)
        if prev_end > minutes_of(prev.time_window.start) and cur_start < prev_end:
            out.append(
                Conflict(
                    id=_conflict_id(ConflictType.TIME_OVERLAP, day.day_index, prev.activity_id, cur.activity_id),
                    type=ConflictType.TIME_OVERLAP,
                    severity=ConflictSeverity.WARNING,
                    day_index=day.day_index,
                    stop_id=stop.stop_id,
                    activity_id=cur.activity_id,
                    message=(
                        f"「{prev.title}」({_hm(prev.time_window.start)}–{_hm(prev.time_window.end)}) 与"
                        f"「{cur.title}」({_hm(cur.time_window.start)}–{_hm(cur.time_window.end)}) 时间窗重叠。"
                    ),
                    suggested_fix="压缩前一项或后移后一项；若路程来不及，考虑删掉其中一项。",
                )
            )
        transit = cur.transit_from_prev
        if transit and transit.minutes and prev_end + 40 <= cur_start:
            gap = cur_start - prev_end
            if gap < transit.minutes * 0.8:
                out.append(
                    Conflict(
                        id=_conflict_id(ConflictType.INSUFFICIENT_TRANSIT, day.day_index, cur.activity_id),
                        type=ConflictType.INSUFFICIENT_TRANSIT,
                        severity=ConflictSeverity.WARNING,
                        day_index=day.day_index,
                        stop_id=stop.stop_id,
                        activity_id=cur.activity_id,
                        message=(
                            f"「{prev.title}」结束到「{cur.title}」开始只有 {gap} 分钟，"
                            f"但路程需要 {transit.minutes} 分钟。"
                        ),
                        suggested_fix="后移后一项，或重新用 plan_route 核对路程时长。",
                    )
                )

    # rhythm window
    wake = minutes_of(day.rhythm.wake)
    sleep = minutes_of(day.rhythm.sleep)
    if sleep <= wake:
        sleep += 24 * 60
    for stop, act in acts:
        start = minutes_of(act.time_window.start)
        end = minutes_of(act.time_window.end)
        if end < start:
            end += 24 * 60
        if start < wake - 5 or end > sleep + 5:
            out.append(
                Conflict(
                    id=_conflict_id(ConflictType.RHYTHM_VIOLATION, day.day_index, act.activity_id),
                    type=ConflictType.RHYTHM_VIOLATION,
                    severity=ConflictSeverity.WARNING,
                    day_index=day.day_index,
                    stop_id=stop.stop_id,
                    activity_id=act.activity_id,
                    message=(
                        f"「{act.title}」({_hm(act.time_window.start)}–{_hm(act.time_window.end)}) "
                        f"越出当天作息 {_hm(day.rhythm.wake)}–{_hm(day.rhythm.sleep)}。"
                    ),
                    suggested_fix="调整 activity.time_window，或修改当天作息 rhythm。",
                )
            )

    # day load
    if acts:
        first = min(minutes_of(a.time_window.start) for _, a in acts)
        last = max(minutes_of(a.time_window.end) for _, a in acts)
        if last < first:
            last += 24 * 60
        available = sleep - wake
        elapsed = last - first
        load_hours = sum(_duration_minutes(a) for _, a in acts) / 60
        pace_limit = PACE_LIMITS.get(trip.constraints.pace.value, 12.0)
        # The pace hint allows a little slack; only flag genuinely dense days.
        if load_hours > pace_limit + 2.4 or elapsed > available:
            reason = (
                f"活动负载 {load_hours:.1f} 小时，按 {trip.constraints.pace.value} 节奏（建议 ≤{pace_limit:.0f} 小时）明显偏满"
                if load_hours > pace_limit + 2
                else f"从 {_fmt_minutes(first)} 排到 {_fmt_minutes(last)}，超出当天可用时间"
            )
            out.append(
                Conflict(
                    id=_conflict_id(ConflictType.DAY_OVERLOAD, day.day_index),
                    type=ConflictType.DAY_OVERLOAD,
                    severity=ConflictSeverity.WARNING,
                    day_index=day.day_index,
                    message=f"Day {day.day_index} {reason}。",
                    suggested_fix="删减一个次级景点，或把部分活动挪到相邻的天。",
                )
            )

    # meal blocks: 长跨度当天必须留用餐时间（docs/07 §2）
    out.extend(_meal_block_conflicts(day, acts))

    # missing tool-sourced durations
    for stop, act in acts:
        td = act.transit_detail
        if td is not None and getattr(td, "mode", None) == "self_drive" and not getattr(td, "drive_minutes", None):
            out.append(
                Conflict(
                    id=_conflict_id(ConflictType.INSUFFICIENT_TRANSIT_INFO, day.day_index, act.activity_id),
                    type=ConflictType.INSUFFICIENT_TRANSIT_INFO,
                    severity=ConflictSeverity.WARNING,
                    day_index=day.day_index,
                    stop_id=stop.stop_id,
                    activity_id=act.activity_id,
                    message=f"自驾段「{act.title}」缺少 plan_route 返回的驾车时长，行程时间无法可靠推算。",
                    suggested_fix="调用 plan_route(mode=drive) 后，用返回值填写 drive_minutes。",
                )
            )
    return out


# 餐点窗口与"算留出了时间"的门槛（分钟）。窗口只用于判断有没有吃饭的机会，
# 不要求 meal 块精确落在正午/傍晚 —— 那是 prompt 的事。
MEAL_WINDOWS = (("午餐", 11 * 60 + 30, 13 * 60 + 30), ("晚餐", 17 * 60 + 30, 20 * 60))
MEAL_GAP_MINUTES = 45  # 空档要够长才吃得成饭
MEAL_OVERLAP_MINUTES = 30  # 活动/空档与餐点窗口的最小重叠


def _meal_block_conflicts(day: Day, acts: list[tuple[Any, Activity]]) -> list[Conflict]:
    """当天要留出吃饭时间（docs/07 §2）。

    查的是"有没有吃饭的机会"，不是"有没有 meal 块"。三种情况都算留出了：
    1. 餐点窗口里有 meal 占位块；
    2. 餐点窗口落在 long_transit / free 里 ≥30 分钟（在路上或随时可吃）；
    3. 当天有 ≥45 分钟的空档与餐点窗口重叠 ≥30 分钟。

    只数 meal 块会把自驾转场日报成"没留饭"——D2 明明有 90 分钟空档，
    实测会把 8 天全部误报，规则就失去信号价值。

    warning 而非 error：缺餐不影响行程可行性，不该触发"自动修 3 轮仍不过
    就交还用户"的重流程。
    """
    if not acts:
        return []
    items = [a for _, a in acts]
    first = min(minutes_of(a.time_window.start) for a in items)
    last = max(minutes_of(a.time_window.end) for a in items)
    if last < first:
        last += 24 * 60
    # 短半天不需要检查
    if (last - first) / 60 < 5:
        return []

    gaps: list[tuple[int, int]] = []
    ordered = sorted(items, key=lambda a: minutes_of(a.time_window.start))
    for prev, cur in zip(ordered, ordered[1:], strict=False):
        gap_start = minutes_of(prev.time_window.end)
        gap_end = minutes_of(cur.time_window.start)
        if gap_end > gap_start:
            gaps.append((gap_start, gap_end))

    missing: list[str] = []
    for label, win_start, win_end in MEAL_WINDOWS:
        # 餐点窗口完全在当天活动范围之外（如赶早班机当天没有晚餐安排）
        if win_end <= first or win_start >= last:
            continue
        covered = False
        for act in items:
            start = minutes_of(act.time_window.start)
            end = minutes_of(act.time_window.end)
            if end < start:
                end += 24 * 60
            overlap = min(end, win_end) - max(start, win_start)
            if overlap <= 0:
                continue
            if act.type == ActivityType.MEAL:
                covered = True
                break
            if act.type in {ActivityType.LONG_TRANSIT, ActivityType.FREE} and overlap >= MEAL_OVERLAP_MINUTES:
                covered = True
                break
        if not covered:
            for gap_start, gap_end in gaps:
                overlap = min(gap_end, win_end) - max(gap_start, win_start)
                if overlap >= MEAL_OVERLAP_MINUTES and (gap_end - gap_start) >= MEAL_GAP_MINUTES:
                    covered = True
                    break
        if not covered:
            missing.append(label)

    if not missing:
        return []
    return [
        Conflict(
            id=_conflict_id(ConflictType.MISSING_MEAL_BLOCK, day.day_index, *missing),
            type=ConflictType.MISSING_MEAL_BLOCK,
            severity=ConflictSeverity.WARNING,
            day_index=day.day_index,
            message=(
                f"Day {day.day_index}（{_fmt_minutes(first)}–{_fmt_minutes(last)}）"
                f"没有留出{'、'.join(missing)}时间。"
            ),
            suggested_fix=(
                f"在{'、'.join(missing)}时段插入 meal 占位活动（标题写「{'、'.join(missing)} · 自行安排」，"
                "不要指定餐厅），或压缩/后移相邻活动腾出空档；"
                "如果当天确实在路上解决，可忽略本条。"
            ),
        )
    ]


def _derive_day(day: Day, conflicts: list[Conflict]) -> DayDerived:
    acts = [a for s in day.stops for a in s.activities]
    if not acts:
        return DayDerived(day_index=day.day_index, conflicts=conflicts)
    first = min(minutes_of(a.time_window.start) for a in acts)
    last = max(minutes_of(a.time_window.end) for a in acts)
    if last < first:
        last += 24 * 60
    transit_minutes = 0
    load_minutes = 0
    for act in acts:
        load_minutes += _duration_minutes(act)
        if act.transit_from_prev and act.transit_from_prev.minutes:
            transit_minutes += int(act.transit_from_prev.minutes)
        td = act.transit_detail
        if td is not None and getattr(td, "mode", None) == "self_drive":
            transit_minutes += int(getattr(td, "drive_minutes", 0) or 0)
        elif td is not None and getattr(td, "mode", None) in {"flight", "train"}:
            # long transit already occupies its own activity block
            transit_minutes += _duration_minutes(act)
    return DayDerived(
        day_index=day.day_index,
        window=DerivedWindow(
            first_start=time(first // 60, first % 60),
            last_end=time((last // 60) % 24, last % 60),
            total_hours=round((last - first) / 60, 1),
            transit_hours=round(transit_minutes / 60, 1),
        ),
        load_hours=round(load_minutes / 60, 1),
        conflicts=conflicts,
    )


# --------------------------------------------------------------------------
# booking timeline / budget
# --------------------------------------------------------------------------


def _channel_hint(channels) -> str | None:
    if not channels:
        return None
    first = next(
        (c for c in channels if getattr(c.status, "value", c.status) == "verified"),
        channels[0],
    )
    prefix = TRANSIT_LABELS.get(first.type.value if hasattr(first.type, "value") else str(first.type), "")
    detail = first.detail or first.name
    if first.type.value in {"wechat_mp", "mini_program"}:
        return f"{prefix}「{detail}」"
    return f"{prefix} · {detail}" if prefix else detail


def _ticket_mid(price_range) -> float:
    if not price_range:
        return 0.0
    lo, hi = float(price_range[0] or 0), float(price_range[1] or 0)
    return (lo + hi) / 2


def _channel_status(channels) -> str | None:
    """首个 verified 渠道的状态；没有 verified 就是 clue/unverified（01 §5.2）。"""
    if not channels:
        return None
    for channel in channels:
        raw = getattr(channel.status, "value", channel.status)
        if raw == "verified":
            return "verified"
    first = channels[0]
    return getattr(first.status, "value", first.status) or "unverified"


def _sale_reminder(ticket, target: date | None, today: date) -> tuple[date | None, str | None, str | None]:
    """开售日由代码算（01 §5.3），不交给模型或 Jev。

    只有官方核实过的渠道才进开售提醒；游记线索/未核实一律显示「开售时间未核实」。
    """
    rule = ticket.sale_rule
    verified = _channel_status(ticket.channels) == "verified"
    if rule is None:
        return None, None, None
    mode = getattr(rule.mode, "value", rule.mode)
    if not verified:
        return None, None, "开售时间未核实，请关注官方公告"
    if mode == "advance_days_at_time":
        if target is None or rule.advance_days is None:
            return None, None, "开售时间未核实，请关注官方公告"
        sale_date = target - timedelta(days=int(rule.advance_days))
        sale_time = rule.release_time
        hint = f"{sale_date.month} 月 {sale_date.day} 日"
        if sale_time:
            hint += f" {sale_time}"
        hint += " 开售，建议提前盯"
        if sale_date < today:
            hint = "已开售，尽快购买"
        return sale_date, sale_time, hint
    if mode == "fixed_date" and rule.fixed_date:
        hint = f"{rule.fixed_date.month} 月 {rule.fixed_date.day} 日开售"
        if rule.release_time:
            hint += f" {rule.release_time}"
        if rule.fixed_date < today:
            hint = "已开售，尽快购买"
        return rule.fixed_date, rule.release_time, hint
    if mode == "rolling_daily":
        return None, None, "每日滚动放票，建议当天尽早购买"
    if mode == "lottery_or_reservation":
        return None, None, "需抽签或提前预约，关注官方公告的开售时间"
    if mode == "onsite_only":
        return None, None, "仅现场购票，无需提前抢"
    return None, None, "开售时间未核实，请关注官方公告"


def _booking_timeline(trip: Trip, today: date | None = None) -> list[BookingItem]:
    today = today or date.today()
    out: list[BookingItem] = []
    for day, stop, act in trip.iter_activities():
        ticket = act.ticket
        if ticket is None or ticket.kind == TicketKind.NONE:
            continue
        target = None
        if ticket.recommended_purchase and ticket.recommended_purchase.target_date:
            target = ticket.recommended_purchase.target_date
        elif day.date:
            target = day.date
        lead = ticket.lead_time_days
        if lead is None and ticket.recommended_purchase:
            lead = ticket.recommended_purchase.lead_time_days
        order_by = None
        if target and lead is not None:
            order_by = target - timedelta(days=lead)
        sale_date, sale_time, sale_hint = _sale_reminder(ticket, target, today)
        if sale_date is not None:
            # 没有 lead_time 时，开售日就是最迟盯票的日期
            order_by = sale_date if order_by is None else min(order_by, sale_date)
        mode = None
        if act.transit_detail is not None:
            mode = getattr(act.transit_detail, "mode", None)
            mode = mode.value if hasattr(mode, "value") else mode
        out.append(
            BookingItem(
                id=f"bk_{act.activity_id}",
                order_by=order_by,
                activity_id=act.activity_id,
                day_index=day.day_index,
                title=act.title,
                kind=ticket.kind,
                channel_hint=_channel_hint(ticket.channels),
                channel_status=_channel_status(ticket.channels),
                price_range=ticket.price_range,
                lead_time_days=lead,
                real_name_required=ticket.real_name_required,
                mode=mode,
                sale_date=sale_date,
                sale_time=sale_time,
                sale_hint=sale_hint,
            )
        )
    out.sort(key=lambda b: (b.order_by or date.max, b.day_index or 99))
    return out


def _budget_summary(trip: Trip) -> BudgetSummary:
    travelers = max(1, trip.constraints.travelers)
    # 住宿收缩为区域级（01 §10）：预算不含住宿，hotels_total 只作兼容字段保留。
    tickets_total = 0.0
    food_est = transit_est = 0.0
    days_with_data = {d.day_index for d in trip.days if d.stops}
    for day, stop, act in trip.iter_activities():
        ticket = act.ticket
        if ticket and ticket.kind != TicketKind.NONE:
            mid = _ticket_mid(ticket.price_range)
            if ticket.kind == TicketKind.ATTRACTION:
                tickets_total += mid * travelers
            elif ticket.kind == TicketKind.TRANSPORT:
                transit_est += mid * travelers
        if act.transit_detail is not None and getattr(act.transit_detail, "mode", None) == "self_drive":
            distance = float(getattr(act.transit_detail, "distance_km", 0) or 0)
            transit_est += distance * 0.8  # fuel + toll estimate
            if getattr(act.transit_detail, "permit_required", False):
                transit_est += 0
    # 餐饮只有每日基线估算：meal 是时间占位块，不含店名与人均（docs/07 §2），
    # 所以没有 per-activity 的餐饮开销可累加。
    food_est += 140.0 * travelers * len(days_with_data)
    transit_est += 40.0 * travelers * len(days_with_data)
    if trip.constraints.vehicle and trip.constraints.vehicle.pickup:
        transit_est += 600  # one-way rental drop-off estimate

    grand = tickets_total + food_est + transit_est
    budget_total = trip.constraints.budget.total
    return BudgetSummary(
        tickets_total=round(tickets_total, 2),
        hotels_total=0.0,
        food_est_total=round(food_est, 2),
        transit_est_total=round(transit_est, 2),
        grand_total=round(grand, 2),
        per_person=round(grand / travelers, 2),
        budget_total=budget_total,
        over_budget_by=round(max(0.0, grand - budget_total), 2) if budget_total else 0.0,
    )


# --------------------------------------------------------------------------
# change diff (used by plan_patch)
# --------------------------------------------------------------------------


def build_diff(old: Trip, new: Trip) -> list[dict[str, Any]]:
    """Human-readable structural diff for the UI's `09:00 → 13:00` badges."""
    diff: list[dict[str, Any]] = []

    def index_activities(trip: Trip) -> dict[str, tuple[Day, Activity]]:
        return {a.activity_id: (d, a) for d, _, a in trip.iter_activities()}

    old_map = index_activities(old)
    new_map = index_activities(new)
    for aid, (day, act) in new_map.items():
        prev = old_map.get(aid)
        if prev is None:
            diff.append(
                {
                    "op": "add",
                    "activity_id": aid,
                    "stop_id": None,
                    "day_index": day.day_index,
                    "title": act.title,
                    "field": "activity",
                    "after": f"{act.time_window.start}–{act.time_window.end}",
                }
            )
            continue
        _, before = prev
        before_tw = f"{_hm(before.time_window.start)}–{_hm(before.time_window.end)}"
        after_tw = f"{_hm(act.time_window.start)}–{_hm(act.time_window.end)}"
        if before_tw != after_tw:
            diff.append(
                {
                    "op": "mod",
                    "activity_id": aid,
                    "day_index": day.day_index,
                    "title": act.title,
                    "field": "time_window",
                    "before": before_tw,
                    "after": after_tw,
                    "label": f"{_hm(before.time_window.start)} → {_hm(act.time_window.start)}",
                }
            )
        if before.title != act.title:
            diff.append(
                {
                    "op": "mod",
                    "activity_id": aid,
                    "day_index": day.day_index,
                    "title": act.title,
                    "field": "title",
                    "before": before.title,
                    "after": act.title,
                }
            )
    for aid, (day, act) in old_map.items():
        if aid not in new_map:
            diff.append(
                {
                    "op": "del",
                    "activity_id": aid,
                    "day_index": day.day_index,
                    "title": act.title,
                    "field": "activity",
                    "before": f"{act.time_window.start}–{act.time_window.end}",
                }
            )

    old_stops = {s.stop_id for _, s in old.iter_stops()}
    new_stops = {s.stop_id for _, s in new.iter_stops()}
    for _, stop in new.iter_stops():
        if stop.stop_id not in old_stops:
            diff.append(
                {
                    "op": "add",
                    "stop_id": stop.stop_id,
                    "title": stop.poi.name,
                    "field": "stop",
                }
            )
    for _, stop in old.iter_stops():
        if stop.stop_id not in new_stops:
            diff.append(
                {
                    "op": "del",
                    "stop_id": stop.stop_id,
                    "title": stop.poi.name,
                    "field": "stop",
                }
            )

    old_rhythm = {d.day_index: d.rhythm for d in old.days}
    for d in new.days:
        before = old_rhythm.get(d.day_index)
        if before and (before.wake != d.rhythm.wake or before.sleep != d.rhythm.sleep):
            diff.append(
                {
                    "op": "mod",
                    "day_index": d.day_index,
                    "field": "rhythm",
                    "title": f"Day {d.day_index} 作息",
                    "before": f"{_hm(before.wake)}–{_hm(before.sleep)}",
                    "after": f"{_hm(d.rhythm.wake)}–{_hm(d.rhythm.sleep)}",
                    "label": f"{_hm(before.wake)} → {_hm(d.rhythm.wake)}",
                }
            )
    return diff
