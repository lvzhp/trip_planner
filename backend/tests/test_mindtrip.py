"""P0–P2 地图旁路功能测试（docs/research/mindtrip/06 §15）。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings, get_settings  # noqa: E402
from app.db import Database, set_db  # noqa: E402
from app.schemas.plan import Trip  # noqa: E402
from app.seed.loader import DEMO_TRIP_ID, load_template_trip, seed_database  # noqa: E402
from app.services.message_segments import attach_segments, build_segments  # noqa: E402


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        demo_mode=True,
        seed_demo=True,
        mock_latency_ms=0,
        runtime_settings_path=str(tmp_path / "runtime_settings.json"),
    )


@pytest_asyncio.fixture
async def db(settings):
    database = Database(settings)
    await database.connect()
    set_db(database)
    await seed_database(database, settings)
    yield database
    await database.close()


@pytest.fixture
def trip() -> Trip:
    return load_template_trip()


@pytest.fixture
def client(settings):
    import app.main as main_module

    get_settings.cache_clear()
    main_module.get_settings = lambda: settings
    with TestClient(main_module.app) as c:
        yield c
    get_settings.cache_clear()


# --------------------------------------------------------------------------
# P0-1 segments
# --------------------------------------------------------------------------


def test_segments_from_placeholders(trip):
    text = "先去 [[poi:d1s1]]，再走到 [[poi:d5s1]]；路上 [[route:d1s1:d2s1:drive]]。"
    segments, plain = build_segments(text, trip)
    places = [s for s in segments if s["type"] == "place"]
    routes = [s for s in segments if s["type"] == "route"]
    assert [p["poiId"] for p in places] == ["d1s1", "d5s1"]
    assert all(p["added"] and p["hasCoords"] for p in places)
    assert places[0]["category"] == "sight"
    assert len(routes) == 1 and routes[0]["mode"] == "drive"
    assert "[[poi:" not in plain and "[[route:" not in plain


def test_segments_missing_place_and_linkify_fallback(trip):
    segments, _ = build_segments("这里已经删掉了 [[poi:gone_1|旧地点]]，但禾木村还在。", trip)
    places = [s for s in segments if s["type"] == "place"]
    assert places[0]["missing"] is True and places[0]["name"] == "旧地点"
    assert any(p.get("missing") is not True and "禾木" in p["name"] for p in places)


def test_segments_cap_and_overflow_note(trip):
    stops = [stop for _day, stop in trip.iter_stops()]
    text = " ".join(f"[[poi:{stops[i % len(stops)].stop_id}]]" for i in range(24))
    segments, _ = build_segments(text, trip)
    places = [s for s in segments if s["type"] == "place"]
    assert len(places) == 20
    note = "".join(s["text"] for s in segments if s["type"] == "text")
    assert "还有" in note and "个地点" in note


def test_attach_segments_keeps_legacy_text(trip):
    payload = attach_segments({"role": "assistant", "text": "去禾木村看日落"}, trip)
    places = [seg for seg in payload["segments"] if seg["type"] == "place"]
    assert places and places[0]["name"] == "禾木村"
    assert "禾木" in payload["text"]
    user_payload = attach_segments({"role": "user", "text": "去禾木村"}, trip)
    assert "segments" not in user_payload


# --------------------------------------------------------------------------
# P0-5 route legs + detail
# --------------------------------------------------------------------------


def test_detail_has_route_legs_and_segments(client):
    detail = client.get(f"/api/trips/{DEMO_TRIP_ID}").json()
    assert "routeLegs" in detail and len(detail["routeLegs"]) >= 5
    leg = detail["routeLegs"][0]
    assert {"legId", "fromStopId", "toStopId", "mode", "disclaimer"} <= set(leg)
    messages = [
        e for e in detail["events"] if e["type"] == "message" and e["payload"].get("role") == "assistant"
    ]
    assert any(any(seg["type"] == "place" for seg in m["payload"].get("segments") or []) for m in messages)


def test_route_legs_never_fabricate_distance(trip):
    from app.services.route_enricher import derive_legs

    pair = derive_legs(trip)[0]
    assert pair.distance_m is not None
    trimmed = trip.model_copy(deep=True)
    for day in trimmed.days:
        for stop in day.stops:
            for act in stop.activities:
                act.transit_from_prev = None
                act.transit_detail = None
                act.transit_from_prev = None
    bare = derive_legs(trimmed)
    assert all(leg.distance_m is None and leg.duration_min is None for leg in bare)


# --------------------------------------------------------------------------
# P0-2 place detail
# --------------------------------------------------------------------------


def test_place_detail_from_trip_and_missing(client):
    detail = client.get(f"/api/places/d3s1?trip_id={DEMO_TRIP_ID}").json()
    assert detail["inTrip"] is True and detail["stopId"] == "d3s1" and detail["dayIndex"] == 3
    assert detail["lat"] and detail["lng"]
    assert "rating" in detail["missing"]  # 无 key 时不编造评分
    assert detail["source"] is None
    assert client.get(f"/api/places/nope?trip_id={DEMO_TRIP_ID}").status_code == 404


def test_place_search_returns_candidates(client):
    data = client.get("/api/places/search", params={"q": "赛里木湖"}).json()
    assert data["available"] is True
    assert data["items"] and data["items"][0]["name"] == "赛里木湖"


# --------------------------------------------------------------------------
# P1-3 add / delete / reorder
# --------------------------------------------------------------------------


def test_add_stop_publishes_patch_and_legs(client):
    before = client.get(f"/api/trips/{DEMO_TRIP_ID}").json()
    resp = client.post(
        f"/api/trips/{DEMO_TRIP_ID}/stops",
        json={
            "day_index": 1,
            "name": "新疆博物馆",
            "category": "sight",
            "city": "乌鲁木齐",
            "lat": 43.82,
            "lng": 87.58,
            "amap_poi_id": "BTEST1",
        },
    )
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert len(detail["trip"]["days"][0]["stops"]) == len(before["trip"]["days"][0]["stops"]) + 1
    assert detail["trip"]["version"] == before["trip"]["version"] + 1
    events = client.get(f"/api/trips/{DEMO_TRIP_ID}/events?after_seq=0").json()["events"]
    assert any(e["type"] == "plan_patch" for e in events)
    assert any(e["type"] == "route" for e in events)
    patch = [e for e in events if e["type"] == "plan_patch"][-1]
    assert patch["payload"]["routeLegs"]

    stop_id = detail["trip"]["days"][0]["stops"][-1]["stopId"]
    deleted = client.delete(f"/api/trips/{DEMO_TRIP_ID}/stops/{stop_id}")
    assert deleted.status_code == 200
    assert all(s["stopId"] != stop_id for s in deleted.json()["trip"]["days"][0]["stops"])


def test_reorder_stop_ids(client):
    detail = client.get(f"/api/trips/{DEMO_TRIP_ID}").json()
    day3 = [s["stopId"] for s in detail["trip"]["days"][2]["stops"]]
    resp = client.post(
        f"/api/trips/{DEMO_TRIP_ID}/reorder",
        json={"day_index": 3, "stop_ids": list(reversed(day3))},
    )
    assert resp.status_code == 200, resp.text
    assert [s["stopId"] for s in resp.json()["trip"]["days"][2]["stops"]] == list(reversed(day3))
    bad = client.post(
        f"/api/trips/{DEMO_TRIP_ID}/reorder",
        json={"day_index": 3, "stop_ids": day3[:2]},
    )
    assert bad.status_code == 400


# --------------------------------------------------------------------------
# P1-1 constraints
# --------------------------------------------------------------------------


def test_patch_constraints_and_date_shift(client):
    resp = client.patch(
        f"/api/trips/{DEMO_TRIP_ID}/constraints",
        json={"travelers": 3, "budget": 9000, "pace": "packed", "destination": "北疆"},
    )
    assert resp.status_code == 200, resp.text
    constraints = resp.json()["trip"]["constraints"]
    assert constraints["travelers"] == 3
    assert constraints["budget"]["total"] == 9000
    assert constraints["pace"] == "intense"
    assert constraints["destination"] == "北疆"

    shifted = client.patch(
        f"/api/trips/{DEMO_TRIP_ID}/constraints",
        json={"start_date": "2026-06-01", "end_date": "2026-06-03", "sync_days": "trim"},
    )
    assert shifted.status_code == 200, shifted.text
    trip = shifted.json()["trip"]
    assert trip["constraints"]["dateRange"]["start"] == "2026-06-01"
    assert len(trip["days"]) == 3
    assert trip["days"][0]["date"] == "2026-06-01"
    assert trip["days"][2]["date"] == "2026-06-03"


# --------------------------------------------------------------------------
# P1-6 saved places
# --------------------------------------------------------------------------


def test_saved_places_crud(client):
    created = client.post(
        "/api/saved",
        json={"poi_id": "B03E700I9K", "name": "赛里木湖", "lat": 44.6, "lng": 81.16},
    )
    assert created.status_code == 201
    items = client.get("/api/saved").json()["items"]
    assert any(item["poiId"] == "B03E700I9K" for item in items)
    assert client.delete("/api/saved/B03E700I9K").status_code == 200
    assert client.get("/api/saved").json()["items"] == []


# --------------------------------------------------------------------------
# P1-4 / P2-2 import
# --------------------------------------------------------------------------


def test_import_text_marks_unlocated(client):
    resp = client.post(
        f"/api/import/link?trip_id={DEMO_TRIP_ID}",
        json={"text": "推荐「禾木村」住一晚，再去「冥王星基地」打卡。"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    names = {item["name"]: item for item in data["items"]}
    assert names["禾木村"]["located"] is True
    assert names["禾木村"]["duplicate"] is True  # 已在行程
    assert any(item["located"] is False for item in data["items"])  # 离线不能假装定位
    assert data["message"]


def test_import_images_fails_explicitly(client):
    import base64

    payload = base64.b64encode(b"x" * 32).decode()
    resp = client.post("/api/import/images", json={"images": [{"filename": "a.png", "data_base64": payload}]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["items"] == []
    assert "OCR" in data["message"]


# --------------------------------------------------------------------------
# P2-1 threads / P2-4 ics
# --------------------------------------------------------------------------


def test_threads_comment_and_mention_reply(client):
    thread = client.post(f"/api/trips/{DEMO_TRIP_ID}/threads", json={"title": "住宿怎么分"}).json()
    thread_id = thread["threadId"]

    plain = client.post(f"/api/threads/{thread_id}/comments", json={"body": "我先看下酒店"})
    assert plain.status_code == 201
    assert plain.json()["reply"] is None  # 评论不触发 AI

    mention = client.post(f"/api/threads/{thread_id}/comments", json={"body": "@助手 预算够吗"})
    assert mention.status_code == 201
    reply = mention.json()["reply"]
    assert reply and reply["author"] == "assistant" and "预算" in reply["body"]
    listed = client.get(f"/api/threads/{thread_id}").json()
    assert len(listed["comments"]) == 3


def test_export_ics(client):
    resp = client.get(f"/api/trips/{DEMO_TRIP_ID}/export.ics")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/calendar")
    body = resp.text
    assert body.startswith("BEGIN:VCALENDAR")
    assert "DTSTART;TZID=Asia/Shanghai:20260501T080000" in body
    assert body.rstrip().endswith("END:VCALENDAR")


def test_chat_stream_carries_segments_and_route_events(client):
    """SSE 边界：assistant 消息带 segments，写操作后跟 route 事件（§13.2）。"""
    with client.stream(
        "POST",
        f"/api/trips/{DEMO_TRIP_ID}/messages",
        json={"content": "Day 3 我起晚了，重规划一下"},
    ) as resp:
        assert resp.status_code == 200
        body = "".join(resp.iter_text())
    assert '"segments"' in body
    assert "event: plan_patch" in body
    assert "event: route" in body


# --------------------------------------------------------------------------
# §15 用例 D：不配高德 key 的降级
# --------------------------------------------------------------------------


@pytest.fixture
def degraded_client(tmp_path):
    """用例 D：没有高德 Web/JS key 时，所有接口都不报错，并显式说明降级。"""
    import app.main as main_module

    degraded = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'degraded.db'}",
        demo_mode=True,
        seed_demo=True,
        mock_latency_ms=0,
        runtime_settings_path=str(tmp_path / "degraded_runtime.json"),
        amap_web_key="",
        amap_js_key="",
        amap_js_security_code="",
    )
    get_settings.cache_clear()
    main_module.get_settings = lambda: degraded
    with TestClient(main_module.app) as c:
        yield c
    get_settings.cache_clear()


def test_degraded_mode_without_amap(degraded_client):
    detail = degraded_client.get(f"/api/trips/{DEMO_TRIP_ID}")
    assert detail.status_code == 200
    legs = detail.json()["routeLegs"]
    assert legs and all(leg["disclaimer"] for leg in legs)
    # 没 key 时不能调用高德算距离：要么来自行程已有数据，要么为空（前端显示「距离待算」）
    assert all(leg["source"] in (None, "estimate", "amap") for leg in legs)

    place = degraded_client.get(f"/api/places/d1s1?trip_id={DEMO_TRIP_ID}")
    assert place.status_code == 200
    payload = place.json()
    assert payload["source"] is None
    assert "rating" in payload["missing"]

    nearby = degraded_client.get("/api/places/nearby", params={"lng": 87.6165, "lat": 43.7915, "kind": "eat"})
    assert nearby.status_code == 200
    assert isinstance(nearby.json()["items"], list)

    imported = degraded_client.post(
        f"/api/import/link?trip_id={DEMO_TRIP_ID}",
        json={"text": "「禾木村」和「qzxwvbnm」"},
    )
    assert imported.status_code == 200
    items = imported.json()["items"]
    assert any(item["name"] == "禾木村" for item in items)
    assert any(item["located"] is False for item in items)


def test_reorder_is_reversible(client):
    detail = client.get(f"/api/trips/{DEMO_TRIP_ID}").json()
    day = detail["trip"]["days"][2]
    original = [s["stopId"] for s in day["stops"]]
    reversed_ids = list(reversed(original))
    first = client.post(f"/api/trips/{DEMO_TRIP_ID}/reorder", json={"day_index": 3, "stop_ids": reversed_ids})
    assert first.status_code == 200
    legs_after = {leg["legId"] for leg in first.json()["routeLegs"]}
    assert any("__" in leg for leg in legs_after)
    second = client.post(f"/api/trips/{DEMO_TRIP_ID}/reorder", json={"day_index": 3, "stop_ids": original})
    assert second.status_code == 200
    assert [s["stopId"] for s in second.json()["trip"]["days"][2]["stops"]] == original


# --------------------------------------------------------------------------
# 真实道路几何（polyline）：04-replicate W2 / 用户反馈的「两点一线」
# --------------------------------------------------------------------------


def test_simplify_polyline_keeps_endpoints():
    from app.tools.amap import _simplify_polyline

    points = [[80.0, 40.0]] + [[80.0 + i * 0.00001, 40.0] for i in range(1, 500)] + [[80.1, 40.3]]
    simplified = _simplify_polyline(points)
    assert simplified is not None
    assert simplified[0] == points[0]
    assert simplified[-1] == points[-1]
    assert len(simplified) < len(points)


@pytest.mark.asyncio
async def test_enrich_legs_fetches_and_caches_geometry(db, settings, monkeypatch):
    import app.services.route_enricher as enricher
    from app.schemas.tools import RouteResult

    async def _no_sleep(_seconds):
        return None

    monkeypatch.setattr(enricher.asyncio, "sleep", _no_sleep)

    class FakeAmap:
        configured = True

        def __init__(self):
            self.calls = 0

        async def plan_route(self, from_poi, to_poi, mode, from_coord=None, to_coord=None):
            self.calls += 1
            return RouteResult(
                from_poi=from_poi,
                to_poi=to_poi,
                mode=mode,
                distance_km=52.0,
                minutes=40,
                source_ref="route:test",
                polyline=[[80.0, 40.0], [80.5, 40.5], [81.0, 41.0]],
            )

    trip = load_template_trip()
    fake = FakeAmap()
    legs, filled = await enricher.enrich_legs(trip, fake, enricher.derive_legs(trip), db=db)
    assert filled == len(legs) > 0
    assert all(leg.polyline and len(leg.polyline) >= 2 for leg in legs)
    assert all(leg.source == "amap" for leg in legs)
    first_calls = fake.calls

    # 第二次走 tool_cache：不再请求高德
    legs2, filled2 = await enricher.enrich_legs(trip, fake, enricher.derive_legs(trip), db=db)
    assert fake.calls == first_calls
    assert filled2 == len(legs2)
    assert all(leg.polyline for leg in legs2)


@pytest.mark.asyncio
async def test_persist_legs_keeps_cached_geometry(db, settings):
    from app.schemas.tools import ToolOutcome
    from app.services.plan_service import PlanService, PlanWriteResult
    from app.services.route_enricher import derive_legs, legs_payload
    from app.core.validator import validate_and_derive

    trip = load_template_trip()
    legs = derive_legs(trip)
    legs[0].polyline = [[80.0, 40.0], [81.0, 41.0]]
    legs[0].source = "amap"
    await db.replace_route_legs(trip.trip_id, legs_payload(legs))

    plans = PlanService(settings, db)
    await plans._persist_legs(trip)
    rows = await db.list_route_legs(trip.trip_id)
    kept = next(row for row in rows if row["leg_id"] == legs[0].leg_id)
    assert kept["polyline"] == [[80.0, 40.0], [81.0, 41.0]]

    # SSE 的 plan_patch 不带 polyline（避免事件流膨胀）
    result = PlanWriteResult(
        ok=True,
        outcome=ToolOutcome(ok=True, tool="update_itinerary", summary="x"),
        trip=trip,
        derived=validate_and_derive(trip),
    )
    payload = plans.patch_payload(result, [], "x")
    assert payload["route_legs"]
    assert all(leg["polyline"] is None for leg in payload["route_legs"])


@pytest.mark.asyncio
async def test_detail_merges_polyline_into_route_legs(db, settings):
    from app.api.routes import _route_legs
    from app.services.route_enricher import derive_legs, legs_payload

    trip = load_template_trip()
    legs = derive_legs(trip)
    legs[0].polyline = [[80.0, 40.0], [80.5, 40.5]]
    legs[0].source = "amap"
    await db.replace_route_legs(trip.trip_id, legs_payload(legs))

    merged = await _route_legs(db, trip)
    assert merged[0]["polyline"] == [[80.0, 40.0], [80.5, 40.5]]
    assert merged[0]["source"] == "amap"


# --------------------------------------------------------------------------
# 高德真实坐标 / 地点卡行程事实
# --------------------------------------------------------------------------


def test_demo_trip_uses_amap_coordinates():
    from app.seed.loader import load_template_trip

    trip = load_template_trip()
    first = trip.days[0].stops[0]
    assert first.poi.amap_poi_id == "B03DF05V5I"
    assert first.poi.source_ref == "poi:amap:B03DF05V5I"
    assert (first.poi.lng, first.poi.lat) == (87.617977, 43.780006)
    # 高德查不到的 demo 点：不能再带一个假的 POI id
    unresolved = next(stop for _d, stop in trip.iter_stops() if stop.stop_id == "d4s3")
    assert unresolved.poi.amap_poi_id is None
    assert unresolved.poi.source_ref.startswith("poi:seed:")


@pytest.mark.asyncio
async def test_place_detail_includes_itinerary_facts(db, settings):
    from app.services.places import PlaceService
    from app.services.route_enricher import derive_legs, legs_payload

    trip = load_template_trip()
    # 先放一条高德段，验证「相邻地点怎么走」
    legs = derive_legs(trip)
    target = next(leg for leg in legs if leg.from_stop_id == "d3s2" and leg.to_stop_id == "d3s3")
    target.source = "amap"
    target.distance_m = 144000
    target.duration_min = 166
    target.polyline = [[86.7, 47.8], [87.0, 48.0], [87.05, 48.82]]
    await db.replace_route_legs(trip.trip_id, legs_payload(legs))

    detail = await PlaceService(settings, db).get(trip, "d3s3")
    assert detail is not None
    assert detail.in_trip is True
    assert detail.coordinate_verified is True
    assert detail.address
    assert detail.visit_duration_min and detail.visit_duration_min > 0
    assert detail.reservation_required is not None
    assert detail.ticket_unit_text and "¥" in detail.ticket_unit_text
    assert detail.ticket_total_text and "2 人" in detail.ticket_total_text
    assert detail.activities and detail.activities[0].start
    assert detail.transfer_from is not None
    assert detail.transfer_from.source == "amap"
    assert detail.transfer_from.distance_m == 144000


@pytest.mark.asyncio
async def test_startup_migration_fixes_old_seed_coordinates(db, settings):
    from app.seed.loader import seed_database

    trip = await db.get_trip(DEMO_TRIP_ID)
    assert trip is not None
    stop = trip.days[0].stops[0]
    # 模拟旧版本遗留的近似坐标 + 假 POI id
    stop.poi.lng = 87.6165
    stop.poi.lat = 43.7915
    stop.poi.amap_poi_id = "B0FFG1K9A0"
    stop.poi.source_ref = "poi:seed:d1s1"
    trip.version = 1
    await db.upsert_trip(trip)

    await seed_database(db, settings)
    fixed = await db.get_trip(DEMO_TRIP_ID)
    assert fixed is not None
    stop2 = fixed.days[0].stops[0]
    assert stop2.poi.amap_poi_id == "B03DF05V5I"
    assert (stop2.poi.lng, stop2.poi.lat) == (87.617977, 43.780006)
    assert stop2.poi.source_ref == "poi:amap:B03DF05V5I"
    assert fixed.version == 2
    assert any("坐标校正" in (rev.summary or "") for rev in fixed.revision_log)
