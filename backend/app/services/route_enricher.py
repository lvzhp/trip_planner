"""距离行（route legs）派生与刷新（mindtrip/06 §5、§13.2）。

原则：**没有真实数据就不给数字**。`RouteLeg.distance_m` / `duration_min` 只能来自
行程文档里已有的 `transit_from_prev` / `transit_detail`（它们由 `plan_route` 写入），
或者在配置了高德 key 时现算。派生不出就留空，前端显示「距离待算」。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, time as dt_time, timezone
from typing import Any

from app.schemas.plan import ActivityType, LongTransitMode, RouteLeg, Stop, Trip, TransportMode

_MODE_MAP = {
    TransportMode.WALK.value: "walk",
    TransportMode.DRIVE.value: "drive",
    TransportMode.TRANSIT.value: "transit",
}

_LONG_MODE_MAP = {
    LongTransitMode.FLIGHT.value: "flight",
    LongTransitMode.TRAIN.value: "train",
    LongTransitMode.SELF_DRIVE.value: "drive",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short(name: str | None) -> str | None:
    if not name:
        return name
    return name.split(" · ")[-1]


def _has_coords(stop: Stop) -> bool:
    return stop.poi.lng is not None and stop.poi.lat is not None


def _minutes_between(dep: Any, arr: Any) -> int | None:
    def _hm(value: Any) -> tuple[int, int] | None:
        if isinstance(value, dt_time):
            return value.hour, value.minute
        if not value:
            return None
        try:
            hour, minute = (int(x) for x in str(value).split(":")[:2])
            return hour, minute
        except (ValueError, IndexError):
            return None

    a = _hm(dep)
    b = _hm(arr)
    if a is None or b is None:
        return None
    diff = (b[0] * 60 + b[1]) - (a[0] * 60 + a[1])
    if diff < 0:
        diff += 24 * 60
    return diff or None


def _source_kind(source_ref: str | None) -> str | None:
    """来源必须诚实：seed / mock 的 fixture 不能标成「高德路径」。"""
    if not source_ref:
        return None
    if source_ref.startswith(("route:seed", "web:seed", "poi:seed", "mock")):
        return "estimate"
    if source_ref.startswith(("route:", "poi:")):
        return "amap"
    return "estimate"


def _leg_meta(a: Stop, b: Stop) -> dict[str, Any]:
    """从 b 的 transit_from_prev / long_transit 里取出这一段的事实。

    优先级：**长途交通明细优先**。跨城段的 `transit_from_prev` 经常是模型抄错的
    市内时长（例如把「大理古城取车 43 分钟」抄到「信阳→大理」上），一旦按它算，
    地图会把 2000 公里的火车段画成一段自驾路线。长途明细在出发站或到达站上都可能
    出现，两边都要找。
    """
    # 1) 长途交通（到达站第一个活动 / 出发站最后一个 long_transit）
    for stop, is_target in ((b, True), (a, False)):
        acts = list(stop.activities)
        if is_target:
            candidates = acts[:1]
        else:
            candidates = [act for act in reversed(acts) if act.type == ActivityType.LONG_TRANSIT][:1]
        for act in candidates:
            detail = act.transit_detail
            if act.type != ActivityType.LONG_TRANSIT or detail is None:
                continue
            mode = _LONG_MODE_MAP.get(
                detail.mode.value if hasattr(detail.mode, "value") else str(detail.mode), "drive"
            )
            distance_m: int | None = None
            duration_min: int | None = None
            if detail.mode == LongTransitMode.SELF_DRIVE:
                distance_m = int(round(detail.distance_km * 1000)) if detail.distance_km else None
                duration_min = int(detail.drive_minutes) if detail.drive_minutes else None
            else:
                duration_min = _minutes_between(detail.dep_time, detail.arr_time)
                if duration_min is None:
                    tw = act.time_window
                    duration_min = _minutes_between(tw.start, tw.end)
            if distance_m is None and duration_min is None:
                continue
            return {
                "mode": mode,
                "distance_m": distance_m,
                "duration_min": duration_min,
                "source": _source_kind(detail.source_ref),
            }

    # 2) 市内短驳（边）
    for act in b.activities:
        leg = act.transit_from_prev
        if leg is None:
            continue
        return {
            "mode": _MODE_MAP.get(leg.mode.value, "drive"),
            "distance_m": int(round(leg.distance_km * 1000)) if leg.distance_km else None,
            "duration_min": int(leg.minutes) if leg.minutes else None,
            "source": _source_kind(leg.source_ref),
        }
    return {"mode": "drive", "distance_m": None, "duration_min": None, "source": None}


def derive_legs(trip: Trip) -> list[RouteLeg]:
    """按天相邻 stop 派生 route legs（纯函数，不联网、不落库）。"""
    legs: list[RouteLeg] = []
    for day in trip.days:
        stops = list(day.stops)
        for a, b in zip(stops, stops[1:]):
            meta = _leg_meta(a, b)
            legs.append(
                RouteLeg(
                    leg_id=f"{a.stop_id}__{b.stop_id}",
                    trip_id=trip.trip_id,
                    day_index=day.day_index,
                    from_stop_id=a.stop_id,
                    to_stop_id=b.stop_id,
                    from_name=_short(a.poi.name),
                    to_name=_short(b.poi.name),
                    mode=meta["mode"],
                    distance_m=meta["distance_m"],
                    duration_min=meta["duration_min"],
                    source=meta["source"],
                    fetched_at=_now() if meta["distance_m"] or meta["duration_min"] else None,
                    disclaimer=True,
                )
            )
    return legs


def legs_payload(legs: list[RouteLeg]) -> list[dict[str, Any]]:
    return [leg.model_dump(mode="json") for leg in legs]


def changed_legs(legs: list[RouteLeg], stop_ids: list[str] | None, day_indexes: list[int] | None) -> list[RouteLeg]:
    wanted = set(stop_ids or [])
    days = set(day_indexes or [])
    out: list[RouteLeg] = []
    for leg in legs:
        if leg.from_stop_id in wanted or leg.to_stop_id in wanted:
            out.append(leg)
        elif leg.day_index is not None and leg.day_index in days:
            out.append(leg)
    return out


ROAD_MODES = {"walk", "drive", "bike", "transit"}
GEOMETRY_CACHE_TOOL = "route_geometry"
GEOMETRY_CACHE_TTL = 7 * 24 * 3600


def _needs_geometry(leg: RouteLeg) -> bool:
    return leg.mode in ROAD_MODES and not leg.polyline


def _cache_params(a: Stop, b: Stop, mode: str) -> dict[str, Any]:
    return {
        "from": [round(a.poi.lng or 0, 5), round(a.poi.lat or 0, 5)],
        "to": [round(b.poi.lng or 0, 5), round(b.poi.lat or 0, 5)],
        "mode": mode,
    }


async def enrich_legs(
    trip: Trip,
    amap: Any,
    legs: list[RouteLeg],
    db: Any | None = None,
    limit: int = 16,
) -> tuple[list[RouteLeg], int]:
    """配置了高德 key 时，补算真实道路几何（polyline）以及缺失的距离/时间。

    - 先查 `tool_cache`（7 天），避免每刷新一次页面都打高德；
    - 失败就保留原样（前端绘制直线并在信息条标「示意」），不抛错、不阻塞写事务。
    """
    if amap is None or not getattr(amap, "configured", False):
        return legs, 0
    by_stop = {stop.stop_id: stop for day in trip.days for stop in day.stops}
    filled = 0
    for leg in legs:
        if filled >= limit:
            break
        if leg.mode not in ROAD_MODES:
            continue
        if not _needs_geometry(leg) and leg.distance_m is not None and leg.duration_min is not None:
            continue
        a = by_stop.get(leg.from_stop_id)
        b = by_stop.get(leg.to_stop_id)
        if a is None or b is None or not _has_coords(a) or not _has_coords(b):
            continue
        params = _cache_params(a, b, leg.mode)

        cached = None
        if db is not None:
            try:
                cached = await db.cache_get(GEOMETRY_CACHE_TOOL, params)
            except Exception:  # noqa: BLE001 - 缓存不可用不影响主流程
                cached = None
        if cached:
            leg.distance_m = int(round(cached["distance_km"] * 1000)) if cached.get("distance_km") else leg.distance_m
            leg.duration_min = int(cached["minutes"]) if cached.get("minutes") else leg.duration_min
            leg.polyline = cached.get("polyline") or leg.polyline
            leg.source = "amap"
            leg.fetched_at = cached.get("fetched_at") or _now()
            filled += 1
            continue

        route = None
        for attempt in range(3):
            try:
                route = await asyncio.wait_for(
                    amap.plan_route(
                        a.poi.name,
                        b.poi.name,
                        leg.mode,
                        (a.poi.lng, a.poi.lat),
                        (b.poi.lng, b.poi.lat),
                    ),
                    timeout=10.0,
                )
                break
            except Exception as exc:  # noqa: BLE001 - 网络/额度问题都不能影响写事务
                message = f"{getattr(exc, 'code', '')} {getattr(exc, 'message', '')} {exc}"
                retryable = getattr(exc, 'retryable', False) or 'QPS' in message or 'CUQPS' in message or 'LIMIT' in message
                if retryable and attempt < 2:
                    # 高德免费配额约 3 QPS：退避后重试，别把后面的路段全废掉
                    await asyncio.sleep(0.9 * (attempt + 1))
                    continue
                break
        if route is None:
            # 单段失败继续处理后面的段；失败的段保留直线/距离待算，下次刷新再补
            continue
        leg.distance_m = int(round(route.distance_km * 1000)) if route.distance_km else leg.distance_m
        leg.duration_min = int(route.minutes) if route.minutes else leg.duration_min
        if route.polyline:
            leg.polyline = [list(point) for point in route.polyline]
        leg.source = "amap"
        leg.fetched_at = _now()
        filled += 1
        # 控制 QPS：逐段之间留出间隔（高德免费配额约 3 次/秒）
        await asyncio.sleep(0.4)
        if db is not None:
            try:
                await db.cache_set(
                    GEOMETRY_CACHE_TOOL,
                    params,
                    {
                        "distance_km": route.distance_km,
                        "minutes": route.minutes,
                        "polyline": [list(point) for point in (route.polyline or [])],
                        "fetched_at": leg.fetched_at,
                    },
                    GEOMETRY_CACHE_TTL,
                )
            except Exception:  # noqa: BLE001
                pass
    return legs, filled


def ics_for_trip(trip: Trip) -> str:
    """行程单 ICS 导出（P2-4）。只导出 Trip 已有事实，不做预订。"""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Trace Planner//Trip Export//CN",
        "CALSCALE:GREGORIAN",
        f"X-WR-CALNAME:{_ics_escape(trip.title or 'Trace 行程')}",
    ]
    for day in trip.days:
        date = day.date.isoformat() if day.date else None
        for stop in day.stops:
            for act in stop.activities:
                if act.type == ActivityType.MEAL:
                    continue
                uid = f"{act.activity_id}@trace-planner"
                summary = f"{act.title}"
                description = stop.poi.name
                if act.note:
                    description += f" — {act.note}"
                lines.append("BEGIN:VEVENT")
                lines.append(f"UID:{uid}")
                lines.append(f"DTSTAMP:{stamp}")
                if date:
                    start = f"{date.replace('-', '')}T{_hhmm(act.time_window.start)}00"
                    end = f"{date.replace('-', '')}T{_hhmm(act.time_window.end)}00"
                    lines.append(f"DTSTART;TZID=Asia/Shanghai:{start}")
                    lines.append(f"DTEND;TZID=Asia/Shanghai:{end}")
                else:
                    lines.append(f"DTSTART;TZID=Asia/Shanghai:{stamp}")
                lines.append(f"SUMMARY:{_ics_escape(summary)}")
                lines.append(f"DESCRIPTION:{_ics_escape(description)}")
                if stop.poi.address:
                    lines.append(f"LOCATION:{_ics_escape(stop.poi.address)}")
                lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def _hhmm(value: Any) -> str:
    if hasattr(value, "strftime"):
        return value.strftime("%H%M")
    return str(value).replace(":", "")[:4].ljust(4, "0")


def _ics_escape(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )
