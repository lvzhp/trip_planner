"""Demo data loader.

Seeds the acceptance itinerary (新疆环线 · 五一自驾, v7) plus its two turns of
events.  This makes the workbench open in the same complete state as the UI
prototype, and lets SSE replay be tested without running the agent.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from app.config import Settings
from app.db import Database
from app.schemas.events import SseEvent
from app.schemas.plan import Revision, Trip

DATA_PATH = Path(__file__).with_name("demo_data.json")
EXTRA_PATH = Path(__file__).with_name("extra_data.json")
AMAP_COORDS_PATH = Path(__file__).with_name("amap_coords.json")
DEMO_TRIP_ID = "xj-2026-wuyi"


def _amap_coords() -> dict[str, dict[str, dict]]:
    """高德 POI 校正表（离线生成，来源 = 高德 place/text）。

    demo 数据是早期手写的 GCJ-02 近似值，和真实 POI 偏差可达十几公里
    （例如禾木村旧值在喀纳斯湖以北）。这层校正把 demo 行程的坐标/POI id
    统一到高德真实结果上，避免地图上"定位不准"。
    """
    if not AMAP_COORDS_PATH.exists():
        return {}
    return json.loads(AMAP_COORDS_PATH.read_text(encoding="utf-8"))


def apply_amap_coords(trip: Trip) -> list[str]:
    """把 stop 的坐标 / amap_poi_id / 地址替换成高德真实 POI。

    返回被修改的 stop_id 列表（空 = 无需迁移）。
    """
    overrides = _amap_coords().get(trip.trip_id)
    if not overrides:
        return []
    changed: list[str] = []
    for _day, stop in trip.iter_stops():
        item = overrides.get(stop.stop_id)
        if not item:
            # 没被高德校正的 seed 点：假的 amap_poi_id 会误导浮卡去查一个不存在的 POI，
            # 清掉它，让 PlaceDetail 明确显示「坐标未在高德确认」。
            if stop.poi.source_ref and stop.poi.source_ref.startswith("poi:seed:") and stop.poi.amap_poi_id:
                stop.poi.amap_poi_id = None
                changed.append(stop.stop_id)
            continue
        poi = stop.poi
        same = (
            poi.amap_poi_id == item["amap_poi_id"]
            and poi.lng == item["lng"]
            and poi.lat == item["lat"]
            and (not item.get("address") or poi.address == item.get("address"))
        )
        if same:
            continue
        poi.amap_poi_id = item["amap_poi_id"]
        poi.lng = item["lng"]
        poi.lat = item["lat"]
        if item.get("address"):
            poi.address = item["address"]
        if item.get("city"):
            poi.city = item["city"]
        poi.source_ref = f"poi:amap:{item['amap_poi_id']}"
        changed.append(stop.stop_id)
    return changed


async def _migrate_amap_coords(db: Database) -> bool:
    """启动时把已有 demo 行程的近似坐标迁到高德真实坐标（只改一次）。"""
    overrides = _amap_coords()
    if not overrides:
        return False
    migrated = False
    for trip_id in overrides:
        trip = await db.get_trip(trip_id)
        if trip is None:
            continue
        changed = apply_amap_coords(trip)
        if not changed:
            continue
        trip.version += 1
        trip.updated_at = datetime.now(timezone.utc).isoformat()
        trip.revision_log = list(trip.revision_log) + [
            Revision(
                version=trip.version,
                summary="坐标校正：统一使用高德 POI（不再使用早期近似坐标）",
                op_count=0,
                changed_stop_ids=changed,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        ]
        await db.upsert_trip(trip)
        # 坐标变了，旧的道路几何/距离失效：清空，让前端按新坐标重新走高德规划
        try:
            await db.replace_route_legs(trip.trip_id, [])
        except Exception:  # noqa: BLE001
            pass
        migrated = True
    return migrated


def _load() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def _load_extra() -> list[Trip]:
    if not EXTRA_PATH.exists():
        return []
    raw = json.loads(EXTRA_PATH.read_text(encoding="utf-8"))
    trips = [Trip.model_validate(item) for item in raw]
    for trip in trips:
        apply_amap_coords(trip)
    return trips


def load_template_trip() -> Trip:
    """The acceptance itinerary used by the mock planner as its draft."""
    trip = Trip.model_validate(_load()["trip"])
    apply_amap_coords(trip)
    return trip


def demo_events(trip_id: str | None = None) -> list[SseEvent]:
    data = _load()
    events: list[SseEvent] = []
    for raw in data["events"]:
        if trip_id:
            raw = {**raw, "trip_id": trip_id}
        events.append(SseEvent.model_validate(raw))
    return events


async def seed_database(db: Database, settings: Settings) -> bool:
    # 坐标校正对已存在的 demo 行程也要生效（用户可能已经跑过旧版本）
    migrated = await _migrate_amap_coords(db)
    if not settings.seed_demo:
        return migrated
    seeded = False
    existing = await db.get_trip(DEMO_TRIP_ID)
    if existing is None:
        data = _load()
        trip = Trip.model_validate(data["trip"])
        last_seq = int(data.get("last_seq") or 0)
        await db.upsert_trip(trip, last_seq=last_seq)

        grouped: dict[str, list[SseEvent]] = {}
        for raw in data.get("events", []):
            event = SseEvent.model_validate(raw)
            grouped.setdefault(event.turn_id or "seed", []).append(event)

        for turn_id, events in grouped.items():
            events.sort(key=lambda e: e.seq)
            turn_messages = [
                {
                    "role": e.payload.get("role"),
                    "content": e.payload.get("text", ""),
                }
                for e in events
                if e.type.value == "message"
            ]
            await db.create_turn(
                trip.trip_id,
                model="Mock · Trace Planner",
                messages=turn_messages,
                turn_id=turn_id,
            )
            for event in events:
                await db.append_event(turn_id, event)
            await db.finish_turn(
                turn_id,
                messages=turn_messages,
                plan_snapshot=trip.model_dump(mode="json"),
                status="done",
            )
        seeded = True

    # archived example trips for the list page
    for extra in _load_extra():
        if await db.get_trip(extra.trip_id) is None:
            await db.upsert_trip(extra, last_seq=0)
            seeded = True
    return seeded or migrated
