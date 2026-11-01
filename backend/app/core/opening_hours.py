"""营业时间的校验规则与登记簿回填（docs/new-plan 02 §3.2、§3.3）。

两个职责，都必须是确定性的纯代码：

1. `hydrate_opening_hours`：模型只写 `source_refs`，值从来源登记簿取出填入；
2. `opening_hours_conflicts`：星期几、日期匹配、时间比较全部由代码算。

分级规则（02 §3.3）：
- `verified` + 闭馆日 → error
- `verified` + 整段活动落在营业时间外 → error
- `verified` + 开始时间晚于最后入园 → error
- `verified` + 开始合规但结束晚于闭园 → warning
- `clue` / `unverified` / `conflict` → 不报冲突（卡片显示「营业时间待核实」）
- 季节段匹配不到游玩日期 → 按未核实处理
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.schemas.opening_hours import (
    OpeningHours,
    OpeningPeriod,
    hm_to_minutes,
    weekday_code,
)
from app.schemas.plan import (
    Activity,
    ActivityType,
    Conflict,
    ConflictSeverity,
    ConflictType,
    Day,
    Stop,
    Trip,
)
from app.schemas.sources import EvidenceStatus

#: 只有计划层的景点与长途节点参与营业时间校验；攻略层的美食不引入营业时间。
CHECKED_ACTIVITY_TYPES = {ActivityType.VISIT, ActivityType.LONG_TRANSIT}


# --------------------------------------------------------------------------
# 登记簿回填
# --------------------------------------------------------------------------


def hydrate_opening_hours(
    trip: Trip, payloads: dict[str, dict[str, Any]] | None
) -> list[str]:
    """用登记簿里的营业时间产物覆盖模型写的占位。

    返回无法回填的 stop_id 列表 —— 调用方把它们变成 hard error，因为「引用了
    一个不存在的来源」比「没有营业时间」更危险。
    """
    if not payloads:
        return []
    missing: list[str] = []
    for _day, stop in trip.iter_stops():
        current = stop.opening_hours
        if current is None:
            continue
        refs = [r for r in (current.source_refs or []) if r]
        if not refs:
            missing.append(stop.stop_id)
            continue
        payload = next((payloads[r] for r in refs if payloads.get(r)), None)
        if payload is None:
            missing.append(stop.stop_id)
            continue
        data = {**payload, "source_refs": refs}
        stop.opening_hours = OpeningHours.model_validate(data)
    return missing


# --------------------------------------------------------------------------
# 校验
# --------------------------------------------------------------------------


def opening_hours_conflicts(trip: Trip) -> list[Conflict]:
    out: list[Conflict] = []
    for day in trip.days:
        for stop in day.stops:
            out.extend(_check_stop(day, stop))
    return out


def _check_stop(day: Day, stop: Stop) -> list[Conflict]:
    hours = stop.opening_hours
    if hours is None or hours.status != EvidenceStatus.VERIFIED:
        return []
    if day.date is None:
        return []
    checked = [a for a in stop.activities if a.type in CHECKED_ACTIVITY_TYPES]
    if not checked:
        return []

    date_value = day.date
    weekday = weekday_code(date_value)
    if weekday in hours.normalized_closed_days() or date_value in set(hours.closed_dates):
        return [
            _conflict(
                ConflictType.OPENING_HOURS_CLOSED,
                ConflictSeverity.ERROR,
                day,
                stop,
                None,
                f"「{stop.poi.name}」{date_value.isoformat()}（{weekday}）闭馆，当天却排了活动。",
                "换一天再排这个景点，或删掉当天的该景点活动。",
            )
        ]

    periods = hours.periods_for(date_value)
    if periods is None:
        # 季节段匹配不到游玩日期 → 按未核实处理，不报冲突
        return []
    if not periods:
        return [
            _conflict(
                ConflictType.OPENING_HOURS_CLOSED,
                ConflictSeverity.ERROR,
                day,
                stop,
                None,
                f"「{stop.poi.name}」在 {date_value.isoformat()} 当天不营业（证据为已核实）。",
                "换一天再排这个景点，或删掉当天的该景点活动。",
            )
        ]

    out: list[Conflict] = []
    for act in checked:
        out.extend(_check_activity(day, stop, act, periods))
    return out


def _check_activity(
    day: Day, stop: Stop, act: Activity, periods: list[OpeningPeriod]
) -> list[Conflict]:
    start = hm_to_minutes(act.time_window.start.strftime("%H:%M"))
    end = hm_to_minutes(act.time_window.end.strftime("%H:%M"))
    if start is None or end is None:
        return []
    if end < start:  # 跨零点
        end += 24 * 60

    candidates = [p for p in periods if p.contains(start)]
    if not candidates:
        windows = "、".join(
            f"{p.open}–{p.close}" + (f"（最后入园 {p.last_entry}）" if p.last_entry else "")
            for p in periods
        )
        return [
            _conflict(
                ConflictType.OPENING_HOURS_OUTSIDE,
                ConflictSeverity.ERROR,
                day,
                stop,
                act,
                f"「{act.title}」计划 {start // 60:02d}:{start % 60:02d} 开始，"
                f"不在「{stop.poi.name}」的营业时间 {windows} 内。",
                "把活动挪进营业时段，或换到开放的那一天。",
            )
        ]

    out: list[Conflict] = []
    period = candidates[0]
    last_entry = hm_to_minutes(period.last_entry)
    if last_entry is not None and start > last_entry:
        out.append(
            _conflict(
                ConflictType.OPENING_HOURS_LAST_ENTRY,
                ConflictSeverity.ERROR,
                day,
                stop,
                act,
                f"「{act.title}」开始时间 {start // 60:02d}:{start % 60:02d} "
                f"晚于「{stop.poi.name}」最后入园时间 {period.last_entry}。",
                f"把开始时间提前到 {period.last_entry} 之前。",
            )
        )
    close = hm_to_minutes(period.close)
    if close is not None and end > close:
        out.append(
            _conflict(
                ConflictType.OPENING_HOURS_OUTSIDE,
                ConflictSeverity.WARNING,
                day,
                stop,
                act,
                f"「{act.title}」结束时间 {_fmt(end)} 晚于「{stop.poi.name}」闭园时间 {period.close}。",
                "提前结束时间，或把收尾活动挪到闭园前。",
            )
        )
    return out


def _fmt(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _conflict(
    ctype: ConflictType,
    severity: ConflictSeverity,
    day: Day,
    stop: Stop,
    act: Activity | None,
    message: str,
    fix: str,
) -> Conflict:
    from app.core.validator import _conflict_id

    activity_id = act.activity_id if act is not None else None
    return Conflict(
        id=_conflict_id(ctype, day.day_index, stop.stop_id, activity_id),
        type=ctype,
        severity=severity,
        day_index=day.day_index,
        stop_id=stop.stop_id,
        activity_id=activity_id,
        message=message,
        suggested_fix=fix,
    )


def check_date_in_range(value: date, start_raw: str | None, end_raw: str | None) -> bool:
    """季节段/日期的月-日匹配辅助函数（保留给外部调用）。"""

    def parse(raw: str | None) -> tuple[int, int] | None:
        if not raw:
            return None
        parts = str(raw).split("-")
        if len(parts) < 2:
            return None
        try:
            return int(parts[-2]), int(parts[-1])
        except ValueError:
            return None

    start = parse(start_raw)
    end = parse(end_raw)
    if start is None or end is None:
        return True
    current = (value.month, value.day)
    if start <= end:
        return start <= current <= end
    return current >= start or current <= end
