from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.db import Database, set_db  # noqa: E402
from app.seed.loader import load_template_trip, seed_database  # noqa: E402


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
def trip():
    return load_template_trip()


def test_demo_data_is_valid(trip):
    from app.core.validator import hard_errors, validate_and_derive

    assert trip.version == 7
    assert len(trip.days) == 8
    assert hard_errors(trip) == []
    derived = validate_and_derive(trip)
    types = [c.type.value for c in derived.conflicts]
    assert "season_closed" in types
    assert len(derived.booking_timeline) >= 10
    assert derived.budget_summary.grand_total > 0
    assert derived.ok is False


def test_season_conflict_has_user_choice(trip):
    from app.core.validator import validate_and_derive

    derived = validate_and_derive(trip)
    season = next(c for c in derived.conflicts if c.type.value == "season_closed")
    assert season.ask_user is not None
    assert len(season.ask_user.questions[0].options) >= 2
    assert "独库" in season.message


def test_hard_error_for_missing_coord_source(trip):
    from app.core.validator import hard_errors

    broken = trip.model_copy(deep=True)
    broken.days[0].stops[0].poi.source_ref = None
    errors = hard_errors(broken)
    assert any("source_ref" in e for e in errors)


def test_ops_preserve_ids_and_bump_version(trip):
    from app.core.plan_engine import apply_ops

    ops = [
        {
            "op": "update_activity",
            "activity_id": "d3s1a1",
            "patch": {"time_window": {"start": "13:00", "end": "17:30"}},
        },
        {"op": "set_day_rhythm", "day_index": 3, "rhythm": {"wake": "13:00", "sleep": "23:30"}},
    ]
    new, diff, changed = apply_ops(trip, ops, summary="test")
    assert new.version == trip.version + 1
    assert new.find_activity("d3s1a1") is not None
    assert new.days[2].rhythm.wake.isoformat().startswith("13:00")
    assert "d3s1a1" in changed["activity_ids"]
    assert any(d.get("field") == "rhythm" for d in diff)


def test_unknown_id_is_rejected(trip):
    from app.core.plan_engine import PlanValidationError, apply_ops

    with pytest.raises(PlanValidationError):
        apply_ops(trip, [{"op": "remove_stop", "stop_id": "nope"}])


def test_draft_rejects_empty_plan(trip):
    from app.core.plan_engine import PlanValidationError, draft_trip

    with pytest.raises(PlanValidationError):
        draft_trip(trip, {})
    with pytest.raises(PlanValidationError):
        draft_trip(trip, {"days": []})
    with pytest.raises(PlanValidationError):
        draft_trip(trip, {"days": [{"day_index": 1, "stops": []}]})


def test_normalize_raw_draft_args():
    from app.agent.loop import AgentLoop

    payload = {
        "days": [
            {
                "day_index": 1,
                "stops": [
                    {
                        "poi": {"name": "测试点", "lng": 100.0, "lat": 25.0},
                        "activities": [],
                    }
                ],
            }
        ]
    }
    args, summary, error = AgentLoop._normalize_draft_args(
        {"Raw": json.dumps({"trip": payload, "summary": "测试"})}
    )
    assert error is None
    assert args == payload
    assert summary == "测试"

    _, _, error = AgentLoop._normalize_draft_args({"Raw": "{not json"})
    assert error

    _, _, error = AgentLoop._normalize_draft_args({})
    assert error


def test_remove_stop_keeps_other_ids(trip):
    from app.core.plan_engine import apply_ops

    before = {s.stop_id for s in trip.days[2].stops}
    new, _, changed = apply_ops(trip, [{"op": "remove_stop", "stop_id": "d3s2"}])
    after = {s.stop_id for s in new.days[2].stops}
    assert before - after == {"d3s2"}
    assert "d3s1" in after
    assert changed["day_indexes"] == [3]


@pytest.mark.asyncio
async def test_db_seed_and_events(db):
    trip = await db.get_trip("xj-2026-wuyi")
    assert trip is not None and trip.version == 7
    events = await db.get_events_after("xj-2026-wuyi", 0)
    assert len(events) == 22
    assert events[0].seq == 1
    replay = await db.get_events_after("xj-2026-wuyi", 5)
    assert replay[0].seq == 6


@pytest.mark.asyncio
async def test_cache_ttl(db):
    await db.cache_set("search_poi", {"keyword": "喀纳斯"}, {"ok": True}, 60)
    cached = await db.cache_get("search_poi", {"keyword": "喀纳斯"})
    assert cached == {"ok": True}
    await db.cache_set("search_poi", {"keyword": "喀纳斯"}, {"ok": True}, -1)
    assert await db.cache_get("search_poi", {"keyword": "喀纳斯"}) is None


@pytest.mark.asyncio
async def test_tool_registry_offline(settings, db):
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    poi = await registry.execute("search_poi", {"keyword": "喀纳斯", "city": "布尔津"})
    assert poi.ok and poi.data["results"]
    assert poi.data["results"][0]["source_ref"].startswith("poi:")
    again = await registry.execute("search_poi", {"keyword": "喀纳斯", "city": "布尔津"})
    assert again.ok and again.cached is True
    route = await registry.execute(
        "plan_route", {"from": "乌鲁木齐", "to": "可可托海", "mode": "drive"}
    )
    assert route.ok and route.data["minutes"] > 0
    web = await registry.execute("web_search", {"query": "独库公路 开放时间"})
    assert web.ok and "6 月" in (web.data["conclusion"] or "")
    weather = await registry.execute("get_weather", {"city": "阿勒泰"})
    assert weather.ok and weather.data["summary"]


@pytest.mark.asyncio
async def test_mock_turn_ask_then_plan(settings, db):
    from app.agent.loop import AgentLoop
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    loop = AgentLoop(settings, db, registry)
    trip = Trip(trip_id="test-new", title="新行程", version=0)
    await db.upsert_trip(trip, 0)

    async def collect(request):
        current = await db.get_trip("test-new")
        return [e async for e in loop.stream(current, request)]

    first = await collect(ChatRequest(content="我想五一去新疆"))
    assert any(e.type.value == "ask_user" for e in first)
    refreshed = await db.get_trip("test-new")
    second = await collect(
        ChatRequest(
            content="（回答提问）",
            ask_id="ask_trip_basics",
            ask_answers=[
                {"question_index": 0, "option_ids": ["d8"]},
                {"question_index": 1, "option_ids": ["sh"]},
                {"question_index": 2, "option_ids": ["drive"]},
            ],
        )
    )
    assert any(e.type.value == "plan_patch" for e in second)
    refreshed = await db.get_trip("test-new")
    assert refreshed is not None and refreshed.version == 1
    assert len(refreshed.days) == 8

    replan = await collect(
        ChatRequest(
            content="我起晚了，想下午再出发，重规划一下",
            context_tags=[
                {"kind": "stop", "id": "d3s1", "label": "阿勒泰 · Day 3", "day_index": 3}
            ],
        )
    )
    assert any(e.type.value == "plan_patch" for e in replan)
    refreshed = await db.get_trip("test-new")
    assert refreshed is not None and refreshed.version == 2
    day3 = refreshed.days[2]
    assert day3.rhythm.wake.isoformat().startswith("13:00")
    assert all(s.stop_id != "d3s2" for s in day3.stops)
    assert any(s.stop_id == "d3s3" for s in day3.stops)


@pytest.mark.asyncio
async def test_api_smoke(settings):
    from fastapi.testclient import TestClient

    import app.main as main_module

    # patch the cached settings so the app boots against the temp DB
    from app.config import get_settings

    get_settings.cache_clear()
    main_module.get_settings = lambda: settings
    with TestClient(main_module.app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        cfg = client.get("/api/config")
        assert cfg.status_code == 200 and cfg.json()["demoMode"] is True
        trips = client.get("/api/trips").json()["trips"]
        assert any(t["tripId"] == "xj-2026-wuyi" for t in trips)
        detail = client.get("/api/trips/xj-2026-wuyi").json()
        assert detail["trip"]["version"] == 7
        assert len(detail["events"]) == 22
        assert detail["trip"]["days"][0]["stops"][0]["activities"][0]["timeWindow"]["start"] == "08:00"
        events = client.get("/api/trips/xj-2026-wuyi/events?after_seq=20").json()
        assert len(events["events"]) == 2
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_extra_demo_trips_seeded(db):
    rows = await db.list_trips()
    ids = {row["trip_id"] for row in rows}
    assert {"xj-2026-wuyi", "yn-2025-autumn", "jp-2025-kansai", "zj-anji-weekend"} <= ids


def test_diff_labels_have_no_seconds(trip):
    from app.core.plan_engine import apply_ops

    new, diff, _ = apply_ops(
        trip,
        [
            {
                "op": "update_activity",
                "activity_id": "d3s1a1",
                "patch": {"time_window": {"start": "13:00", "end": "17:30"}},
            },
            {"op": "set_day_rhythm", "day_index": 3, "rhythm": {"wake": "13:00", "sleep": "23:30"}},
        ],
    )
    labels = [d.get("label") for d in diff if d.get("field") == "time_window"]
    assert labels and labels[0] == "09:30 → 13:00"
    rhythm = [d.get("label") for d in diff if d.get("field") == "rhythm"]
    assert rhythm and ":" in rhythm[0] and rhythm[0].count(":") == 2


def test_api_serializes_camel_and_hhmm(trip):
    from app.api.serialize import to_camel

    out = to_camel(trip.model_dump(mode="json"))
    assert out["tripId"] == trip.trip_id
    assert out["days"][0]["stops"][0]["activities"][0]["timeWindow"]["start"] == "08:00"


def _model_writable_template():
    """验收用 demo 行程含历史酒店票，模型写入必须剔除（new-plan 01 §10）。

    演示/种子数据仍要能读出 hotel 票，所以这里模拟的是「模型产出的 Trip」：
    把 hotel 票换成区域级住宿文案，其余字段原样保留。
    """
    from app.schemas.plan import TicketKind

    trip = load_template_trip()
    for _day, stop, act in trip.iter_activities():
        if act.ticket is not None and act.ticket.kind == TicketKind.HOTEL:
            act.ticket = None
            act.title = f"住宿 · {stop.poi.name}（自行安排）"
    return trip


def test_model_writes_cannot_create_hotel_tickets(trip):
    """住宿收缩为区域级：模型新写入的酒店票会被拒绝（01 §10）。"""
    from app.core.plan_engine import PlanValidationError, draft_trip

    payload = trip.model_dump(mode="json")
    empty = trip.model_copy(deep=True)
    empty.days = []
    with pytest.raises(PlanValidationError) as excinfo:
        draft_trip(empty, payload, policy="agent")
    assert any("酒店票" in error for error in excinfo.value.errors)

    # legacy 通道（种子数据 / 历史快照）不受影响
    new, _diff = draft_trip(empty, payload, policy="legacy")
    assert len(new.days) == 8


@pytest.mark.asyncio
async def test_llm_loop_write_path_with_fake_provider(settings, db, monkeypatch):
    from app.agent import loop as loop_module
    from app.agent.loop import AgentLoop
    from app.llm.providers import ProviderResponse
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.schemas.tools import ToolCall
    from app.tools.registry import ToolRegistry

    template = _model_writable_template()

    class FakeProvider:
        id = "fake"
        display_name = "Fake"
        calls = 0

        async def chat(self, messages, tools, model):
            FakeProvider.calls += 1
            if FakeProvider.calls == 1:
                return ProviderResponse(
                    content="我先检索并写一版初稿。",
                    tool_calls=[
                        ToolCall(
                            id="call_draft",
                            name="draft_itinerary",
                            arguments={
                                "trip": template.model_dump(mode="json"),
                                "summary": "生成初版北疆环线",
                            },
                        )
                    ],
                    finish_reason="tool_calls",
                )
            return ProviderResponse(content="初版行程已生成，冲突已标注。", finish_reason="stop")

    monkeypatch.setattr(loop_module, "build_provider", lambda *_: FakeProvider())
    registry = ToolRegistry(settings, db)
    agent = AgentLoop(settings, db, registry)
    trip = Trip(trip_id="test-llm", title="LLM 测试", version=0)
    await db.upsert_trip(trip, 0)
    events = [
        event
        async for event in agent.stream(
            trip,
            ChatRequest(
                # 「就按这个方案排」是显式授权，允许跳过方案确认卡直接写初版
                content="就按这个方案排，新疆 8 天自驾",
                model={"provider": "deepseek", "model": "deepseek-flash"},
            ),
        )
    ]
    types = [e.type.value for e in events]
    assert "tool_call" in types and "plan_patch" in types and "message" in types
    refreshed = await db.get_trip("test-llm")
    assert refreshed is not None and refreshed.version == 1 and len(refreshed.days) == 8
    assert FakeProvider.calls == 2


@pytest.mark.asyncio
async def test_draft_blocked_without_outline_confirmation(settings, db, monkeypatch):
    """初版行程前必须先和用户确认路线方案（协作流程门禁）。"""
    from app.agent import loop as loop_module
    from app.agent.loop import AgentLoop
    from app.llm.providers import ProviderResponse
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.schemas.tools import ToolCall
    from app.tools.registry import ToolRegistry

    template = _model_writable_template()

    class FakeProvider:
        id = "fake"
        display_name = "Fake"
        calls = 0

        async def chat(self, messages, tools, model):
            FakeProvider.calls += 1
            if FakeProvider.calls == 1:
                return ProviderResponse(
                    content="",
                    tool_calls=[
                        ToolCall(
                            id="call_draft",
                            name="draft_itinerary",
                            arguments={
                                "trip": template.model_dump(mode="json"),
                                "summary": "生成初版",
                            },
                        )
                    ],
                    finish_reason="tool_calls",
                )
            return ProviderResponse(content="我先给你几条方案。", finish_reason="stop")

    monkeypatch.setattr(loop_module, "build_provider", lambda *_: FakeProvider())
    registry = ToolRegistry(settings, db)
    agent = AgentLoop(settings, db, registry)
    trip = Trip(trip_id="test-gate", title="t", version=0)
    await db.upsert_trip(trip, 0)
    # 先满足「必须有调研记录」的门禁，这条测试只关心方案确认门禁
    await registry.sources.record(
        [
            {
                "source_ref": "research:test",
                "trip_id": trip.trip_id,
                "tool": "dispatch_research",
                "origin": "subagents",
                "fetched_at": "2026-11-01T00:00:00+00:00",
            }
        ]
    )
    events = [
        event
        async for event in agent.stream(
            trip,
            ChatRequest(content="排一个新疆 8 天自驾", model={"provider": "deepseek", "model": "deepseek-flash"}),
        )
    ]
    assert not any(e.type.value == "plan_patch" for e in events)
    results = [e.payload for e in events if e.type.value == "tool_result"]
    assert results and results[0]["ok"] is False
    assert "路线方案" in (results[0].get("summary") or "")
    refreshed = await db.get_trip("test-gate")
    assert refreshed is not None and refreshed.days == []


@pytest.mark.asyncio
async def test_free_text_ask_answer_is_marked_hidden(settings, db):
    from app.agent.loop import AgentLoop
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    loop = AgentLoop(settings, db, registry)
    trip = Trip(trip_id="test-free-answer", title="free", version=0)
    await db.upsert_trip(trip, 0)
    async for _ in loop.stream(trip, ChatRequest(content="想去新疆")):
        pass
    current = await db.get_trip("test-free-answer")
    assert current is not None
    events = [
        e async for e in loop.stream(
            current,
            ChatRequest(content="8天，上海出发，自驾", ask_id="ask_trip_basics", ask_answers=[]),
        )
    ]
    user_events = [e for e in events if e.type.value == "message" and e.payload.get("role") == "user"]
    hidden = [e for e in user_events if e.payload.get("hidden")]
    assert hidden and hidden[0].payload.get("answer_to") == "ask_trip_basics"
    planned = await db.get_trip("test-free-answer")
    assert planned is not None and planned.version == 1


@pytest.mark.asyncio
async def test_api_settings_masking_and_update(settings):
    from fastapi.testclient import TestClient
    import app.main as main_module
    from app.config import get_settings

    get_settings.cache_clear()
    main_module.get_settings = lambda: settings
    with TestClient(main_module.app) as client:
        got = client.get("/api/settings").json()
        assert got["values"]["defaultProvider"] == "mock"
        assert got["secrets"]["deepseekApiKey"]["configured"] is False

        updated = client.put(
            "/api/settings",
            json={
                "values": {
                    "default_provider": "deepseek",
                    "default_model": "deepseek-flash",
                    "demo_mode": False,
                    "map_provider": "leaflet",
                },
                "secrets": {"deepseek_api_key": "sk-test-secret-9876"},
            },
        )
        assert updated.status_code == 200
        payload = updated.json()
        assert payload["settings"]["secrets"]["deepseekApiKey"]["configured"] is True
        assert "sk-test-secret-9876" not in updated.text
        assert payload["settings"]["values"]["defaultProvider"] == "deepseek"

        config = client.get("/api/config").json()
        assert config["agentMode"] == "real"
        assert config["llmConfigured"] is True
        assert config["mapProvider"] == "leaflet"

        invalid = client.put("/api/settings", json={"values": {"database_url": "x"}})
        assert invalid.status_code == 400
    get_settings.cache_clear()


def test_llm_payload_tolerates_common_field_drift():
    """Real providers often add/alias fields; normalize instead of burning retries."""
    from app.schemas.plan import Trip
    from app.seed.loader import load_template_trip

    data = load_template_trip().model_dump(mode="json")
    data["constraints"]["must_go"] = ["喀纳斯湖"]
    stop = data["days"][0]["stops"][0]
    act = stop["activities"][1]
    act["description"] = "模型写了 description，应映射到 note"
    act["ticket"] = {
        "kind": "attraction",
        "adult_price": 70,
        "channels": [
            {"name": "携程", "kind": "ota", "url": "https://www.ctrip.com"},
        ],
    }
    # v2 删掉了 food_detail / nearby_food（docs/07 §2），但旧库行与旧 prompt
    # 仍可能带这些键。extra="forbid" 下必须被剥离而不是抛 ValidationError。
    meal = next(a for a in stop["activities"] if a["type"] == "meal")
    meal["food_detail"] = {"shop_name": "遗留店名", "dishes": ["遗留菜"]}
    stop["nearby_food"] = [{"name": "遗留夜市"}]

    trip = Trip.model_validate(data)
    assert trip.constraints.must_go[0].name == "喀纳斯湖"
    assert trip.days[0].stops[0].seq == 1
    assert trip.days[0].stops[0].activities[0].seq == 1
    ticket = trip.days[0].stops[0].activities[1].ticket
    assert ticket is not None and ticket.price_range == (70.0, 70.0)
    assert ticket.channels[0].type.value == "ota"
    assert ticket.channels[0].detail == "https://www.ctrip.com"
    survivor = trip.days[0].stops[0]
    assert not hasattr(survivor.activities[0], "food_detail")
    assert not hasattr(survivor, "nearby_food")
    assert "遗留店名" not in survivor.model_dump_json()


def _synthetic_day(*windows: tuple[str, str], meal_at: int | None = None) -> Trip:
    """构造只有一天的最小行程，用于确定性地测 meal 规则。"""
    from app.schemas.plan import Activity, ActivityType, Day, Poi, Stop, TimeWindow, Trip

    activities = []
    for i, (start, end) in enumerate(windows):
        is_meal = meal_at == i
        activities.append(
            Activity(
                activity_id=f"a{i}",
                seq=i + 1,
                type=ActivityType.MEAL if is_meal else ActivityType.VISIT,
                title="午餐 · 自行安排" if is_meal else f"活动{i}",
                time_window=TimeWindow(start=start, end=end),
            )
        )
    stop = Stop(
        stop_id="s1",
        seq=1,
        poi=Poi(name="测试点", source_ref="poi:test"),
        activities=activities,
    )
    return Trip(trip_id="t-meal", days=[Day(day_index=1, stops=[stop])])


def _meal_conflicts(trip: Trip) -> list:
    from app.core.validator import validate_and_derive
    from app.schemas.plan import ConflictType

    derived = validate_and_derive(trip)
    return [c for c in derived.conflicts if c.type == ConflictType.MISSING_MEAL_BLOCK]


def test_meal_block_flagged_when_no_time_left_for_lunch():
    """一路排到傍晚、午餐窗口没有空档 → warning（docs/07 §2）。"""
    conflicts = _meal_conflicts(_synthetic_day(("09:00", "11:30"), ("11:30", "17:30")))
    assert len(conflicts) == 1
    assert conflicts[0].severity.value == "warning"
    assert "午餐" in conflicts[0].message


def test_meal_block_not_flagged_when_gap_covers_lunch():
    """有 45 分钟以上空档覆盖午餐窗口 → 不报。

    规则查的是「有没有吃饭的机会」而不是「有没有 meal 块」，
    否则自驾转场日会被全部误报（实测 8/8 天误报）。
    """
    assert _meal_conflicts(_synthetic_day(("09:00", "11:30"), ("12:30", "17:30"))) == []


def test_meal_block_not_flagged_for_explicit_meal_activity():
    trip = _synthetic_day(("09:00", "11:30"), ("11:30", "12:30"), ("12:30", "17:30"), meal_at=1)
    assert _meal_conflicts(trip) == []


def test_meal_block_skips_short_days():
    """跨度不足 5 小时的半天行程不检查。"""
    assert _meal_conflicts(_synthetic_day(("09:00", "11:30"), ("11:30", "12:30"))) == []


def test_meal_budget_uses_daily_baseline_only():
    """删掉 per_person_price 后餐饮预算只剩每日基线。"""
    from app.core.validator import validate_and_derive
    from app.seed.loader import load_template_trip

    trip = load_template_trip()
    derived = validate_and_derive(trip)
    days_with_stops = sum(1 for d in trip.days if d.stops)
    assert derived.budget_summary.food_est_total == round(140.0 * trip.constraints.travelers * days_with_stops, 2)


# --------------------------------------------------------------------------
# 攻略层（docs/07 §9）
# --------------------------------------------------------------------------


def _guide_settings(tmp_path, *, demo: bool) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'guide.db'}",
        demo_mode=demo,
        seed_demo=False,
        mock_latency_ms=0,
        runtime_settings_path=str(tmp_path / "runtime_settings.json"),
        user_profile_path=str(tmp_path / "user_profile.json"),
        # 关键：无论 demo 与否都不给 Key，测试绝不外呼真实服务
        amap_web_key="",
        tavily_api_key="",
        default_provider="mock",
        default_model="trace-mock-v1",
    )


def _demo_stop(stop_id: str = "d1s1"):
    trip = load_template_trip()
    return trip, next(s for d in trip.days for s in d.stops if s.stop_id == stop_id)


@pytest.mark.asyncio
async def test_guide_demo_mode_is_labeled_mock(tmp_path):
    """演示模式：source=mock，叙事诚实标注为离线演示数据。"""
    from app.db import Database
    from app.services.guide_service import GuideService

    settings = _guide_settings(tmp_path, demo=True)
    db = Database(settings)
    await db.connect()
    trip, stop = _demo_stop()
    guides = GuideService(settings, db)
    stages = [
        s
        async for s in guides.stream(
            trip_id=trip.trip_id, trip_title=trip.title, season_note=None, stop=stop,
            filters=[], diet=[], taste=[], provider_id="mock", model="x",
        )
    ]
    await db.close()
    done = [s for s in stages if s.stage == "done"][-1]
    guide = done.detail
    assert guide.source == "mock"
    assert guide.food.items, "演示 fixture 应给出候选"
    assert "演示" in guide.food.narrative[0]


@pytest.mark.asyncio
async def test_guide_real_retrieval_without_llm_does_not_lie(tmp_path):
    """真实检索轴 + mock LLM：source=real，叙事绝不谎称演示数据（回归护栏）。

    这是端到端验证时抓到的 bug：检索真假由 demo_mode 决定，LLM 真假由
    provider 决定，两条轴混用会让真实数据被贴上"演示数据"标签。
    """
    from app.db import Database
    from app.services.guide_service import GuideService

    settings = _guide_settings(tmp_path, demo=False)
    db = Database(settings)
    await db.connect()
    _, stop = _demo_stop()
    guides = GuideService(settings, db)
    rows = [{"name": "真实店", "amap_poi_id": "B1", "lng": 87.6, "lat": 43.79, "distance_m": 234}]
    guide = guides._mock_guide("t", stop, [], [], [], rows, [])
    await db.close()
    assert guide.source == "real"
    assert "演示" not in guide.food.narrative[0]
    assert guide.food.items[0].distance_m == 234


@pytest.mark.asyncio
async def test_guide_real_mode_missing_keys_reports_not_configured(tmp_path):
    """真实模式缺 Key：明确报未配置，不用 fixture 兜底（docs/07 §9）。"""
    from app.db import Database
    from app.services.guide_service import GuideService

    settings = _guide_settings(tmp_path, demo=False)
    db = Database(settings)
    await db.connect()
    trip, stop = _demo_stop()
    guides = GuideService(settings, db)
    stages = [
        s
        async for s in guides.stream(
            trip_id=trip.trip_id, trip_title=trip.title, season_note=None, stop=stop,
            filters=[], diet=[], taste=[], provider_id="mock", model="x",
        )
    ]
    await db.close()
    err = [s for s in stages if s.stage == "error"]
    assert err, "缺 Key 应产出 error stage"
    assert err[0].detail is not None
    assert err[0].detail.not_configured  # 填了缺哪个 Key


def test_guide_cache_key_reacts_to_poi_filter_profile(tmp_path):
    """缓存 key 的每个维度都能导致失效（docs/07 §9）。

    stop_id 跨重规划存活，所以换地点（update_stop 改 poi）必须靠 poi_hash 区分，
    否则会把旧地点的攻略显示在新地点名下。
    """
    import copy

    from app.db import Database
    from app.services.guide_service import GuideService, poi_hash

    settings = _guide_settings(tmp_path, demo=True)
    guides = GuideService(settings, Database(settings))
    trip, stop = _demo_stop()
    base = guides.cache_params(trip.trip_id, stop, [], [], [])

    # 换地点：改 poi 名字/坐标，stop_id 不变 → poi_hash 变 → key 变
    swapped = copy.deepcopy(stop)
    swapped.poi.name = "白哈巴村"
    swapped.poi.amap_poi_id = "OTHER"
    assert poi_hash(swapped) != poi_hash(stop)
    assert guides.cache_params(trip.trip_id, swapped, [], [], []) != base
    # 但 stop_id 没变，证明单靠 stop_id 会命中脏缓存
    assert swapped.stop_id == stop.stop_id

    # 口味 chips 与用户档案各自改变 key
    assert guides.cache_params(trip.trip_id, stop, ["清真"], [], []) != base
    assert guides.cache_params(trip.trip_id, stop, [], ["清真"], []) != base


def test_guide_section_drops_items_not_in_candidates():
    """模型只能从候选里挑选：不在候选池的名字被丢弃（铁律 1）。"""
    from app.services.guide_service import _section

    rows = [
        {"name": "海尔巴格餐厅", "amap_poi_id": "B1", "lng": 87.6, "lat": 43.79, "distance_m": 200, "source_ref": "around:x"},
    ]
    model_out = {
        "narrative": ["当地特色", "", "第三段", "第四段超出会被截断"],
        "items": [
            {"name": "海尔巴格餐厅", "highlight": "手抓肉"},
            {"name": "模型编造的店", "highlight": "不该出现"},
            {"name": "海尔巴格餐厅 ", "highlight": "名字带空格应宽松匹配"},
        ],
    }
    section = _section(model_out, rows, with_best_time=False)
    names = [i.name for i in section.items]
    assert names == ["海尔巴格餐厅", "海尔巴格餐厅"], f"编造店名必须被丢弃，得到 {names}"
    assert len(section.narrative) == 3, "叙事最多 3 段，空串被过滤"
    # 坐标/poiid 由服务端回填，模型无权决定
    assert section.items[0].amap_poi_id == "B1"
    assert section.items[0].distance_m == 200


def test_guide_parse_json_tolerates_fences_and_prose():
    from app.services.guide_service import _parse_json_object

    assert _parse_json_object('```json\n{"food": {"items": []}}\n```') == {"food": {"items": []}}
    assert _parse_json_object('好的，这是结果：{"a": 1} 希望有帮助') == {"a": 1}
    assert _parse_json_object('{"a": {"b": "含 } 花括号"}}') == {"a": {"b": "含 } 花括号"}}
    assert _parse_json_object("没有任何 json") is None


@pytest.mark.asyncio
async def test_guide_web_only_fallback_when_around_is_empty(tmp_path):
    """偏远景区 around 无 POI 但 web 检索有内容：不短路，叙事仍生成。

    回归护栏：禾木村周边 3km 内高德餐饮 POI 为空是真实场景，
    旧逻辑直接丢弃 Tavily 结果，现场用户空手而归。
    """
    from app.db import Database
    from app.services.guide_service import GuideService

    settings = _guide_settings(tmp_path, demo=False)
    # 给假 Key 让它进入真实检索路径（missing_keys 为空），再 stub 掉真实网络
    settings.amap_web_key = "fake"
    settings.tavily_api_key = "fake"
    db = Database(settings)
    await db.connect()
    trip, stop = _demo_stop()
    guides = GuideService(settings, db)

    calls = []

    async def fake_retrieve(s, filters):
        calls.append(s.stop_id)
        return [], [], "禾木村以图瓦人奶制品与冷水鱼为特色。", "哈登观景台是经典日落机位。"

    async def fake_chat(messages, tools, model):
        class R:
            content = '{"food": {"narrative": ["图瓦人特色"], "items": []}, "spot": {"narrative": ["日落机位"], "items": [{"name": "编造的店"}]}}'
        return R()

    class FakeProvider:
        display_name = "fake"
        chat = staticmethod(fake_chat)

    guides._retrieve = fake_retrieve
    import app.services.guide_service as gs
    orig_build = gs.build_provider
    gs.build_provider = lambda *a, **k: FakeProvider()
    try:
        stages = [
            s
            async for s in guides.stream(
                trip_id=trip.trip_id, trip_title=None, season_note=None, stop=stop,
                filters=[], diet=[], taste=[], provider_id="deepseek", model="x",
            )
        ]
    finally:
        gs.build_provider = orig_build
    await db.close()

    assert calls, "应真正执行检索"
    done = [s for s in stages if s.stage == "done"]
    assert done, "web-only 不该短路成『无周边结果』"
    guide = done[-1].detail
    assert guide.food.narrative == ["图瓦人特色"]
    # 编造的店不在候选池 → 被回填机制丢弃
    assert guide.spot.items == []
    assert guide.not_configured is None


@pytest.mark.asyncio
async def test_profile_store_validates_and_dismisses_permanently(tmp_path):
    """档案只接受封闭集合内的值；跳过后 dismissed 永久为真（docs/07 §7）。"""
    from app.services.user_profile import UserProfileStore

    settings = _guide_settings(tmp_path, demo=True)
    store = UserProfileStore(settings)
    assert store.load().exists is False

    saved = store.save({"diet": ["清真", "乱写的值"], "taste": ["日料"], "skip": True})
    assert saved.diet == ["清真"], "封闭集合外的值被丢弃"
    assert saved.taste == ["日料"]
    assert saved.dismissed is True

    reloaded = store.load()
    assert reloaded.exists is True and reloaded.dismissed is True
    # 忌口在前（硬约束），偏好在后
    assert reloaded.preferences() == ["清真", "日料"]


def test_mock_search_around_filters_by_radius():
    """周边搜索按半径过滤、按距离排序；半径外不返回（不拿远点凑数）。"""
    from app.tools.mock_data import mock_search_around

    near = mock_search_around(87.6165, 43.7915, "food", radius=3000)
    assert near, "大巴扎附近应有 fixture"
    dists = [p.distance_m for p in near]
    assert dists == sorted(dists), "应按距离升序"
    assert all(d <= 3000 for d in dists)
    far = mock_search_around(0.0, 0.0, "food", radius=3000)
    assert far == [], "半径内没有候选就返回空"
    assert mock_search_around(None, None, "food") == []


@pytest.mark.asyncio
async def test_draft_gate_accepts_free_text_outline_reply(settings, db):
    """用户不点卡片、直接打「C」也要能过门禁（不能把流程卡死）。"""
    from app.agent.loop import AgentLoop
    from app.schemas.api import ChatRequest
    from app.schemas.events import EventType, SseEvent
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    agent = AgentLoop(settings, db, ToolRegistry(settings, db))
    trip = Trip(trip_id="gate-free", title="t", version=0)
    await db.upsert_trip(trip, 0)
    turn_id = await db.create_turn(trip.trip_id, "test")
    ask = SseEvent(
        seq=await db.reserve_seq(trip.trip_id),
        type=EventType.ASK_USER,
        turn_id=turn_id,
        trip_id=trip.trip_id,
        payload={
            "ask_id": "ask_outline",
            "purpose": "outline",
            "intro": "选一条",
            "questions": [
                {
                    "question": "走哪条？",
                    "multi": False,
                    "options": [
                        {"id": "a", "label": "A · 古城住满"},
                        {"id": "c", "label": "C · 包车环湖"},
                    ],
                }
            ],
        },
    )
    await db.append_event(turn_id, ask)

    assert await agent._draft_gate_open(trip, ChatRequest(content="C")) is True
    assert await agent._draft_gate_open(trip, ChatRequest(content="选方案 C 吧")) is True
    assert await agent._draft_gate_open(trip, ChatRequest(content="我再想想")) is False
    # 点卡片提交（ask_id 命中 outline 卡）同样放行
    assert (
        await agent._draft_gate_open(
            trip, ChatRequest(content="（回答提问）", ask_id="ask_outline")
        )
        is True
    )


@pytest.mark.asyncio
async def test_draft_requires_subagent_research(settings, db, monkeypatch):
    """初版前没有子 Agent 调研记录 → 直接拒绝，不能拿 search_poi 顶替。"""
    from app.agent import loop as loop_module
    from app.agent.loop import AgentLoop
    from app.llm.providers import ProviderResponse
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.schemas.tools import ToolCall
    from app.tools.registry import ToolRegistry

    template = _model_writable_template()

    class FakeProvider:
        id = "fake"
        display_name = "Fake"
        calls = 0

        async def chat(self, messages, tools, model):
            FakeProvider.calls += 1
            if FakeProvider.calls == 1:
                return ProviderResponse(
                    content="",
                    tool_calls=[
                        ToolCall(
                            id="call_draft",
                            name="draft_itinerary",
                            arguments={"trip": template.model_dump(mode="json"), "summary": "初版"},
                        )
                    ],
                    finish_reason="tool_calls",
                )
            return ProviderResponse(content="先派子 Agent 调研。", finish_reason="stop")

    monkeypatch.setattr(loop_module, "build_provider", lambda *_: FakeProvider())
    agent = AgentLoop(settings, db, ToolRegistry(settings, db))
    trip = Trip(trip_id="test-research-gate", title="t", version=0)
    await db.upsert_trip(trip, 0)
    events = [
        event
        async for event in agent.stream(
            trip,
            ChatRequest(content="排一个新疆 8 天自驾", model={"provider": "deepseek", "model": "deepseek-flash"}),
        )
    ]
    assert not any(e.type.value == "plan_patch" for e in events)
    results = [e.payload for e in events if e.type.value == "tool_result"]
    assert results and results[0]["ok"] is False
    assert "dispatch_research" in (results[0].get("summary") or "")
