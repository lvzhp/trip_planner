"""地点浮卡 / 搜索（mindtrip/06 §2.3、§8）。

数据来源优先级：trip 里已有的 stop → tool_cache（高德详情 7 天）→ 按需请求高德详情。
**没有来源就标 null / 进 `missing`，绝不为了「看起来丰富」编造评分或价格。**
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.config import Settings
from app.db import Database
from app.schemas.plan import ActivityType, Stop, Trip
from app.schemas.places import (
    CandidatePlace,
    PlaceActivity,
    PlaceDetail,
    PlaceReview,
    PlaceSource,
    PlaceTransfer,
)
from app.tools.amap import AmapClient, AmapError
from app.tools.mock_data import mock_search_around, mock_search_poi

CACHE_TOOL = "place_detail"
CACHE_TTL_SECONDS = 7 * 24 * 3600
STALE_AFTER_DAYS = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_TYPE_TO_CATEGORY = {
    ActivityType.STAY: "stay",
    ActivityType.MEAL: "meal",
    ActivityType.LONG_TRANSIT: "transit",
    ActivityType.VISIT: "sight",
    ActivityType.FREE: "place",
}


def _category_of(stop: Stop) -> str:
    """按当天第一个活动判断地点类别（多活动 stop 以主活动为准）。"""
    if not stop.activities:
        return "place"
    kinds = {act.type for act in stop.activities}
    for kind in (ActivityType.VISIT, ActivityType.MEAL, ActivityType.STAY, ActivityType.LONG_TRANSIT):
        if kind in kinds:
            return _TYPE_TO_CATEGORY[kind]
    return "place"


def _find_stop(trip: Trip, poi_id: str) -> tuple[int, Stop] | None:
    for day in trip.days:
        for stop in day.stops:
            if stop.stop_id == poi_id or (stop.poi.amap_poi_id and stop.poi.amap_poi_id == poi_id):
                return day.day_index, stop
    return None


def _summary_of(stop: Stop) -> str | None:
    for act in stop.activities:
        text = (act.note or "").strip()
        if text:
            return text[:120]
        for tip in act.tips:
            if tip.strip():
                return tip.strip()[:120]
    return None


def _price_text(stop: Stop) -> str | None:
    """只取景点门票；住宿已收缩为区域级，不再回退取酒店票价（01 §10）。"""
    for act in stop.activities:
        ticket = act.ticket
        if not ticket or not ticket.price_range or ticket.kind.value != "attraction":
            continue
        lo, hi = ticket.price_range
        return f"¥{lo:g}" if lo == hi else f"¥{lo:g}–{hi:g}"
    return None


def _minutes(act) -> int:
    start, end = act.time_window.start, act.time_window.end
    if start is None or end is None:
        return 0
    return max(0, (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute))


def _hm(value) -> str | None:
    if value is None:
        return None
    return f"{value.hour:02d}:{value.minute:02d}"


def _ticket_text(stop: Stop, travelers: int) -> tuple[str | None, str | None]:
    """门票单价/总价：只统计「景点门票」，不要把机票/酒店算成门票。"""
    lows: list[float] = []
    highs: list[float] = []
    for act in stop.activities:
        ticket = act.ticket
        if ticket and ticket.price_range and ticket.kind.value == "attraction":
            lo, hi = ticket.price_range
            lows.append(float(lo))
            highs.append(float(hi))
    if not lows:
        return None, None
    lo, hi = min(lows), max(highs)
    unit = f"¥{lo:g}/人" if lo == hi else f"¥{lo:g}–{hi:g}/人"
    total = f"{travelers} 人约 ¥{lo * travelers:g}" if lo == hi else f"{travelers} 人约 ¥{lo * travelers:g}–{hi * travelers:g}"
    return unit, total


def _needs_reservation(stop: Stop) -> bool | None:
    tickets = [
        act.ticket
        for act in stop.activities
        if act.ticket and act.ticket.kind.value == "attraction"
    ]
    if not tickets:
        return None
    for ticket in tickets:
        if ticket.real_name_required:
            return True
        if ticket.lead_time_days and ticket.lead_time_days > 0:
            return True
        if ticket.channels:
            return True
    return False


def _transfer(row: dict[str, Any] | None, names: dict[str, str] | None = None) -> PlaceTransfer | None:
    if not row:
        return None
    names = names or {}
    return PlaceTransfer(
        from_stop_id=row["from_stop_id"],
        to_stop_id=row["to_stop_id"],
        from_name=row.get("from_name") or names.get(row["from_stop_id"]),
        to_name=row.get("to_name") or names.get(row["to_stop_id"]),
        mode=row.get("mode") or "drive",
        distance_m=row.get("distance_m"),
        duration_min=row.get("duration_min"),
        source=row.get("source"),
    )


def _source_age_days(fetched_at: str | None) -> int | None:
    if not fetched_at:
        return None
    try:
        then = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(timezone.utc) - then).days)


class PlaceService:
    def __init__(self, settings: Settings, db: Database, amap: AmapClient | None = None):
        self.settings = settings
        self.db = db
        self.amap = amap or AmapClient(settings)

    # ------------------------------------------------------------------
    # detail
    # ------------------------------------------------------------------
    async def get(self, trip: Trip | None, poi_id: str) -> PlaceDetail | None:
        found = _find_stop(trip, poi_id) if trip is not None else None
        # chip 传的是 stopId；高德详情必须用真实的 amap_poi_id，不能用 stopId 去查
        remote_id = poi_id
        if found is not None:
            _day_index, stop_ref = found
            if stop_ref.poi.amap_poi_id:
                remote_id = stop_ref.poi.amap_poi_id
            else:
                remote_id = ""
        cached = await self.db.cache_get(CACHE_TOOL, {"poi_id": remote_id or poi_id})
        remote: dict[str, Any] | None = None
        if self.amap.configured and remote_id:
            try:
                remote = await self.amap.place_detail(remote_id)
                remote = {**remote, "fetched_at": _now_iso()}
                await self.db.cache_set(CACHE_TOOL, {"poi_id": remote_id}, remote, CACHE_TTL_SECONDS)
            except AmapError:
                remote = None
        if remote is None and cached:
            remote = cached
        if found is None and remote is None:
            return None

        day_index, stop = (found or (None, None))
        base: dict[str, Any] = {}
        if stop is not None:
            base = {
                "poi_id": poi_id,
                "name": stop.poi.name,
                "category": _category_of(stop),
                "city": stop.poi.city,
                "address": stop.poi.address,
                "lat": stop.poi.lat,
                "lng": stop.poi.lng,
                "summary": _summary_of(stop),
                "price_text": _price_text(stop),
                "stop_id": stop.stop_id,
                "day_index": day_index,
                "in_trip": True,
                "source_name": None,
            }
            travelers = max(1, trip.constraints.travelers if trip is not None else 2)
            unit_text, total_text = _ticket_text(stop, travelers)
            visit_minutes = sum(
                _minutes(act)
                for act in stop.activities
                if act.type.value in {"visit", "free", "meal"}
            )
            if visit_minutes <= 0:
                visit_minutes = sum(_minutes(act) for act in stop.activities)
            base.update(
                {
                    "visit_duration_min": visit_minutes or None,
                    "reservation_required": _needs_reservation(stop),
                    "ticket_unit_text": unit_text,
                    "ticket_total_text": total_text,
                    "activities": [
                        PlaceActivity(
                            title=act.title,
                            type=act.type.value,
                            start=_hm(act.time_window.start),
                            end=_hm(act.time_window.end),
                            note=act.note,
                            tips=act.tips[:2],
                        ).model_dump()
                        for act in sorted(stop.activities, key=lambda item: item.seq)
                    ],
                    "coordinate_verified": bool(
                        stop.poi.source_ref and stop.poi.source_ref.startswith("poi:amap:")
                    ),
                }
            )
            # 相邻两段怎么走：只取高德规划结果（route_legs），不拿行程旧值冒充
            try:
                rows = await self.db.list_route_legs(trip.trip_id)
            except Exception:  # noqa: BLE001
                rows = []
            before = next((row for row in rows if row["to_stop_id"] == stop.stop_id), None)
            after = next((row for row in rows if row["from_stop_id"] == stop.stop_id), None)
            stop_names = {
                item.stop_id: item.poi.name.split(" · ")[-1]
                for _d, item in trip.iter_stops()
            }
            base["transfer_from"] = _transfer(before, stop_names)
            base["transfer_to"] = _transfer(after, stop_names)
        if remote:
            # 高德字段优先（更权威），trip 里的事实做兜底
            base.setdefault("poi_id", poi_id)
            base["name"] = base.get("name") or remote.get("name") or poi_id
            base.setdefault("category", "place")
            for key in ("city", "address", "lat", "lng"):
                if base.get(key) in (None, "") and remote.get(key) not in (None, ""):
                    base[key] = remote.get(key)
            base["rating"] = remote.get("rating")
            if remote.get("cost"):
                base["price_text"] = base.get("price_text") or f"人均 ¥{remote['cost']:g}"
            base["photos"] = list(remote.get("photos") or [])
            base["business_time"] = remote.get("business_time")
            if base.get("source_name") is None:
                base["source_name"] = remote.get("name")
            fetched_at = remote.get("fetched_at")
            base["source"] = {
                "provider": "amap",
                "url": None,
                "fetched_at": fetched_at,
            }
        if base.get("name") is None:
            base["name"] = poi_id
        base.setdefault("category", "place")
        base.setdefault("photos", [])
        base.setdefault("reviews", [])

        detail = PlaceDetail.model_validate(
            {
                **base,
                "source": PlaceSource.model_validate(base["source"]) if base.get("source") else None,
                "reviews": [PlaceReview.model_validate(r) for r in base.get("reviews") or []],
                "fetched_at": (base.get("source") or {}).get("fetched_at") if base.get("source") else None,
            }
        )
        missing: list[str] = []
        for field in ("rating", "review_count", "photos", "summary", "address", "lat", "lng", "open_now"):
            value = getattr(detail, field)
            if value in (None, [], ""):
                missing.append(field)
        detail.missing = missing
        return detail

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------
    async def search(self, query: str, city: str | None = None, limit: int = 8) -> list[CandidatePlace]:
        if self.amap.configured:
            try:
                pois = await self.amap.search_poi(query, city, None, limit=limit)
                return [
                    CandidatePlace(
                        poi_id=p.amap_poi_id or f"q:{p.name}",
                        name=p.name,
                        category="place",
                        lat=p.lat,
                        lng=p.lng,
                        city=p.city,
                        address=getattr(p, "address", None),
                        source="search",
                        rating=getattr(p, "rating", None),
                    )
                    for p in pois
                ]
            except AmapError:
                pass
        pois = mock_search_poi(query, city, None, limit=limit)
        return [
            CandidatePlace(
                poi_id=p.amap_poi_id or f"q:{p.name}",
                name=p.name,
                category="place",
                lat=p.lat,
                lng=p.lng,
                city=p.city,
                address=getattr(p, "address", None),
                source="search",
                rating=getattr(p, "rating", None),
            )
            for p in pois
        ]

    async def nearby(
        self, lng: float, lat: float, kind: str = 'play', radius: int = 3000, limit: int = 20
    ) -> list[CandidatePlace]:
        """当前视野/坐标附近搜索（mindtrip/06 §8）。kind: eat / stay / play / transport / shopping。"""
        mapped = {
            'eat': 'food',
            'food': 'food',
            'stay': 'hotel',
            'hotel': 'hotel',
            'play': 'spot',
            'sight': 'spot',
            'transport': 'transport',
            'shopping': 'shopping',
        }.get(kind, 'spot')
        if self.amap.configured:
            try:
                pois = await self.amap.search_around(lng, lat, mapped, None, radius, limit)
                return [
                    CandidatePlace(
                        poi_id=p.amap_poi_id or f"n:{p.name}",
                        name=p.name,
                        category={'food': 'meal', 'hotel': 'stay', 'transport': 'transit', 'shopping': 'shopping'}.get(
                            mapped, 'sight'
                        ),
                        lat=p.lat,
                        lng=p.lng,
                        city=None,
                        address=p.address,
                        source='nearby',
                    )
                    for p in pois
                    if p.lat is not None and p.lng is not None
                ]
            except AmapError:
                pass
        pois = mock_search_around(lng, lat, mapped, None, radius, limit)
        return [
            CandidatePlace(
                poi_id=p.amap_poi_id or f"n:{p.name}",
                name=p.name,
                category={'food': 'meal', 'hotel': 'stay', 'transport': 'transit', 'shopping': 'shopping'}.get(
                    mapped, 'sight'
                ),
                lat=p.lat,
                lng=p.lng,
                address=getattr(p, 'address', None),
                source='nearby',
            )
            for p in pois
            if p.lat is not None and p.lng is not None
        ]

    async def locate(
        self, name: str, city: str | None = None
    ) -> tuple[str | None, float, float, str | None, str | None, str | None] | None:
        """给导入/加地点用：名字 → (amap_id, lng, lat, address, resolved_name, city)。"""
        results = await self.search(name, city, limit=3)
        if not results:
            return None
        best = results[0]
        if best.lat is None or best.lng is None:
            return None
        if best.poi_id.startswith("q:"):
            # 离线 mock 的兜底结果是「按城市中心猜的」，不能当成真实定位
            return None
        return (
            best.poi_id if not best.poi_id.startswith("q:") else None,
            best.lng,
            best.lat,
            best.address,
            best.name,
            best.city,
        )
