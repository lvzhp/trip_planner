"""docs/new-plan 01 + 02 的行为测试（02 与 01 冲突处以 02 为准）。"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.db import Database, set_db  # noqa: E402


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'newplan.db'}",
        demo_mode=False,
        seed_demo=False,
        mock_latency_ms=0,
        runtime_settings_path=str(tmp_path / "runtime_settings.json"),
    )


@pytest_asyncio.fixture
async def db(settings):
    database = Database(settings)
    await database.connect()
    set_db(database)
    yield database
    await database.close()


# --------------------------------------------------------------------------
# 构造小行程
# --------------------------------------------------------------------------


def _trip_payload(opening_ref: str | None = None, *, start: str = "10:00", end: str = "12:00"):
    stop: dict = {
        "stop_id": "s1",
        "poi": {"name": "测试景区", "lng": 87.0, "lat": 48.0, "source_ref": "poi:seed:s1"},
        "activities": [
            {
                "activity_id": "a1",
                "type": "visit",
                "title": "进景区",
                "time_window": {"start": start, "end": end},
            }
        ],
    }
    if opening_ref:
        stop["opening_hours"] = {"source_refs": [opening_ref]}
    return {
        "trip_id": "np-test",
        "version": 0,
        "title": "测试行程",
        "days": [
            {
                "day_index": 1,
                "date": "2026-05-02",
                "theme": "测试",
                "rhythm": {"wake": "08:00", "sleep": "22:00"},
                "stops": [stop],
            }
        ],
    }


def _empty_trip():
    from app.schemas.plan import Trip

    return Trip(trip_id="np-test", title="测试", version=0)


def _verified_hours(**overrides):
    from app.schemas.opening_hours import OpeningHours

    data = {
        "status": "verified",
        "regular": [{"days": ["sat"], "open": "09:00", "close": "17:00", "last_entry": "16:00"}],
        "closed_days": [],
        "source_refs": ["tool:opening_hours_lookup:test"],
    }
    data.update(overrides)
    return OpeningHours.model_validate(data)


# --------------------------------------------------------------------------
# 1. 来源登记簿
# --------------------------------------------------------------------------


def test_hard_errors_reject_fabricated_source_ref():
    from app.core.validator import hard_errors
    from app.schemas.plan import Trip

    trip = Trip.model_validate(_trip_payload())
    # 不核对时（读库/种子）不报错
    assert hard_errors(trip) == []
    # 写入时核对：poi:seed: 是服务端自己写的，允许；编造的业务 ref 拒绝
    assert hard_errors(trip, {"something"}) == []
    trip.days[0].stops[0].poi.source_ref = "web:deadbeef1234"
    errors = hard_errors(trip, {"something"})
    assert any("来源登记簿" in e for e in errors)


@pytest.mark.asyncio
async def test_source_registry_records_and_answers(settings, db):
    from app.schemas.tools import ToolOutcome
    from app.services.source_registry import SourceRegistry
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    sources = registry.sources
    outcome = ToolOutcome(
        ok=True,
        tool="web_search",
        data={
            "source": "deepseek",
            "source_ref": "web:abc123",
            "evidence": [{"url": "https://example.com/a", "source_ref": "web:ev1", "quote": "x"}],
        },
        source_refs=["web:abc123"],
    )
    await sources.record_outcome(outcome, trip_id="np-test", turn_id="t1", agent="sub:r1")
    assert await sources.exists("np-test", "web:abc123")
    assert await sources.exists("np-test", "web:ev1")
    assert not await sources.exists("np-test", "web:made-up")
    rows = await sources.entries("np-test")
    assert rows and rows[0]["agent"] == "sub:r1"


# --------------------------------------------------------------------------
# 2. 营业时间：回填 + 分级校验（02 §3.2、§3.3）
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_opening_hours_hydrated_from_registry(settings, db):
    from app.services.plan_service import PlanService
    from app.services.source_registry import SourceRegistry
    from app.tools.registry import ToolRegistry

    sources = ToolRegistry(settings, db).sources
    await sources.record(
        [
            {
                "source_ref": "tool:opening_hours_lookup:test",
                "trip_id": "np-test",
                "tool": "opening_hours_lookup",
                "origin": "deepseek",
                "fetched_at": "2026-11-01T00:00:00+00:00",
                "payload": {
                    "regular": [
                        {"days": ["sat"], "open": "08:00", "close": "18:00", "last_entry": "17:00"}
                    ],
                    "closed_days": [],
                    "closed_dates": [],
                    "seasonal": [],
                    "reservation_required": True,
                    "status": "verified",
                    "evidence": [],
                    "authority": 3,
                },
            }
        ]
    )
    plans = PlanService(settings, db, sources)
    result = await plans.draft(
        _empty_trip(),
        _trip_payload("tool:opening_hours_lookup:test"),
        policy="agent",
    )
    assert result.ok, result.outcome.summary
    hours = result.trip.days[0].stops[0].opening_hours
    assert hours is not None
    assert hours.status.value == "verified"
    assert hours.regular[0].open == "08:00"
    assert hours.reservation_required is True


@pytest.mark.asyncio
async def test_opening_hours_unknown_ref_is_rejected(settings, db):
    from app.services.plan_service import PlanService
    from app.services.source_registry import SourceRegistry

    plans = PlanService(settings, db, SourceRegistry(db))
    result = await plans.draft(
        _empty_trip(), _trip_payload("tool:opening_hours_lookup:nope"), policy="agent"
    )
    assert not result.ok
    assert "来源登记簿" in result.outcome.summary or "营业时间" in result.outcome.summary


def _trip_with_hours(hours, *, start="10:00", end="12:00"):
    from app.schemas.plan import Trip

    payload = _trip_payload(None, start=start, end=end)
    trip = Trip.model_validate(payload)
    trip.days[0].stops[0].opening_hours = hours
    return trip


def test_opening_hours_closed_day_is_error():
    from app.core.validator import validate_and_derive

    hours = _verified_hours(closed_days=["sat"])
    derived = validate_and_derive(_trip_with_hours(hours), date(2026, 4, 1))
    closed = [c for c in derived.conflicts if c.type.value == "opening_hours_closed"]
    assert closed and closed[0].severity.value == "error"


def test_opening_hours_outside_is_error():
    from app.core.validator import validate_and_derive

    hours = _verified_hours(
        regular=[{"days": ["sat"], "open": "14:00", "close": "17:00"}]
    )
    derived = validate_and_derive(_trip_with_hours(hours), date(2026, 4, 1))
    outside = [c for c in derived.conflicts if c.type.value == "opening_hours_outside"]
    assert outside and outside[0].severity.value == "error"


def test_opening_hours_last_entry_is_error():
    from app.core.validator import validate_and_derive

    hours = _verified_hours(
        regular=[{"days": ["sat"], "open": "08:00", "close": "18:00", "last_entry": "09:00"}]
    )
    derived = validate_and_derive(
        _trip_with_hours(hours, start="10:00", end="11:00"), date(2026, 4, 1)
    )
    last_entry = [c for c in derived.conflicts if c.type.value == "opening_hours_last_entry"]
    assert last_entry and last_entry[0].severity.value == "error"


def test_opening_hours_late_checkout_is_warning():
    from app.core.validator import validate_and_derive

    hours = _verified_hours(
        regular=[{"days": ["sat"], "open": "09:00", "close": "11:00", "last_entry": "10:30"}]
    )
    derived = validate_and_derive(
        _trip_with_hours(hours, start="10:00", end="12:00"), date(2026, 4, 1)
    )
    outside = [c for c in derived.conflicts if c.type.value == "opening_hours_outside"]
    assert outside and outside[0].severity.value == "warning"


def test_unverified_hours_never_conflict():
    from app.core.validator import validate_and_derive

    hours = _verified_hours(status="clue", closed_days=["sat"])
    derived = validate_and_derive(_trip_with_hours(hours), date(2026, 4, 1))
    assert not [c for c in derived.conflicts if c.type.value.startswith("opening_hours")]


def test_seasonal_without_match_is_treated_as_unverified():
    from app.core.validator import validate_and_derive

    hours = _verified_hours(
        regular=[],
        seasonal=[
            {
                "from": "06-01",
                "to": "10-31",
                "regular": [{"days": [], "open": "08:00", "close": "18:00"}],
            }
        ],
    )
    derived = validate_and_derive(_trip_with_hours(hours), date(2026, 4, 1))
    assert not [c for c in derived.conflicts if c.type.value.startswith("opening_hours")]


# --------------------------------------------------------------------------
# 3. 开售规则与渠道状态（01 §5.3）
# --------------------------------------------------------------------------


def _ticket_trip(channel_status: str):
    from app.schemas.plan import Ticket, Trip

    payload = _trip_payload()
    payload["days"][0]["stops"][0]["activities"][0]["ticket"] = {
        "kind": "attraction",
        "channels": [
            {
                "name": "测试景区公众号",
                "type": "wechat_mp",
                "status": channel_status,
                "evidence_url": "web:ev1",
            }
        ],
        "sale_rule": {
            "mode": "advance_days_at_time",
            "advance_days": 7,
            "release_time": "20:00",
            "source_ref": "web:ev1",
        },
        "source_ref": "web:ev1",
    }
    trip = Trip.model_validate(payload)
    return trip


def test_sale_rule_produces_booking_hint():
    from app.core.validator import validate_and_derive

    derived = validate_and_derive(_ticket_trip("verified"), date(2026, 4, 1))
    item = derived.booking_timeline[0]
    assert item.sale_date == date(2026, 4, 25)
    assert item.sale_hint and "开售" in item.sale_hint
    assert item.channel_status == "verified"


def test_unverified_channel_gets_no_sale_reminder():
    from app.core.validator import validate_and_derive

    derived = validate_and_derive(_ticket_trip("clue"), date(2026, 4, 1))
    item = derived.booking_timeline[0]
    assert item.sale_date is None
    assert item.sale_hint == "开售时间未核实，请关注官方公告"


# --------------------------------------------------------------------------
# 4. 子 Agent（02 §2）
# --------------------------------------------------------------------------


def test_subagent_whitelist_narrows_only():
    from app.agent.subagent import compute_allowed

    allowed = compute_allowed("experience", [])
    assert allowed == {"social_digest", "web_search", "fetch_page", "submit_findings"}
    narrowed = compute_allowed("experience", ["web_search"])
    assert "web_search" not in narrowed
    # 主 Agent 的工具不可扩充进来
    assert "dispatch_research" not in compute_allowed("route", [])
    assert "draft_itinerary" not in compute_allowed("route", [])


def test_subagent_render_tools_uses_same_list(settings, db):
    from app.agent.subagent import build_task_prompt
    from app.schemas.research import ResearchTask
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    task = ResearchTask(task_id="t1", role="experience", goal="查攻略")
    allowed = {"web_search", "social_digest", "submit_findings"}
    specs = [s for s in registry.specs if s.name in allowed]
    prompt = build_task_prompt(task, specs, max_tool_calls=10, max_steps=6)
    for spec in specs:
        assert spec.name in prompt
    assert "fetch_page" not in prompt


@pytest.mark.asyncio
async def test_findings_validation_drops_invalid(settings, db):
    from app.agent.subagent import ResearchRunner
    from app.schemas.research import ResearchTask
    from app.tools.registry import ToolRegistry

    runner = ResearchRunner(settings, ToolRegistry(settings, db))
    task = ResearchTask(task_id="t1", role="experience", goal="查攻略")
    raw = {
        "task_id": "t1",
        "role": "experience",
        "status": "ok",
        "summary": "摘要" * 600,
        "findings": [
            {"kind": "fact", "claim": "票价 100", "source_refs": ["web:unknown"]},
            {"kind": "experience", "claim": "五一很挤", "evidence": [{"url": "https://a.com/x"}]},
            {
                "kind": "experience",
                "claim": "建议早去",
                "evidence": [
                    {
                        "url": "https://a.com/x",
                        "published_at": "2026-09-01",
                        "quote": "早上人少",
                    }
                ],
            },
        ],
        "gaps": [],
    }
    result = await runner._validate(task, raw, 3)
    assert len(result.findings) == 1
    assert result.status.value == "partial"
    assert any("丢弃" in gap for gap in result.gaps)
    assert result.independent_sources == 1
    # 摘要必须被截断到上限
    assert len(result.summary) <= task.max_summary_chars + 1


@pytest.mark.asyncio
async def test_demo_mode_dispatch_research_is_not_configured(settings, db):
    from app.agent.subagent import ResearchUnavailable, ResearchRunner
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    runner = ResearchRunner(settings, registry)
    with pytest.raises(ResearchUnavailable) as excinfo:
        await runner.run([{"task_id": "t1", "role": "route", "goal": "查路线"}])
    assert excinfo.value.code == "not_configured"

    # 走工具层也一样：明确 not_configured，不用 fixture 兜底
    outcome = await registry.execute("dispatch_research", {"tasks": [
        {"task_id": "t1", "role": "route", "goal": "查路线"}
    ]}, "real")
    assert not outcome.ok
    assert outcome.error is not None and outcome.error.code == "not_configured"


@pytest.mark.asyncio
async def test_subagent_runs_and_submits_with_fake_provider(settings, db, monkeypatch):
    from app.agent import subagent as subagent_module
    from app.llm.providers import ProviderResponse
    from app.schemas.tools import ToolCall
    from app.tools.registry import ToolRegistry

    live = settings.model_copy(
        update={"default_provider": "deepseek", "deepseek_api_key": "test-key"}
    )

    class FakeProvider:
        async def chat(self, messages, tools, model):
            return ProviderResponse(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c1",
                        name="submit_findings",
                        arguments={
                            "task_id": "t1",
                            "role": "route",
                            "status": "ok",
                            "summary": "独库公路 6 月上旬通车，五一走不过去。",
                            "findings": [
                                {
                                    "kind": "clue",
                                    "claim": "五一期间独库公路大概率未开放",
                                    "evidence": [
                                        {
                                            "url": "https://example.com/a",
                                            "published_at": "2026-09-01",
                                            "quote": "往年 6 月上旬通车",
                                        }
                                    ],
                                    "confidence": "medium",
                                }
                            ],
                            "gaps": [],
                        },
                    )
                ],
                finish_reason="tool_calls",
            )

    monkeypatch.setattr(subagent_module, "build_provider", lambda *_: FakeProvider())
    registry = ToolRegistry(live, db)
    runner = subagent_module.ResearchRunner(live, registry)
    results = await runner.run([{"task_id": "t1", "role": "route", "goal": "查独库公路"}])
    assert len(results) == 1
    assert results[0].status.value in {"ok", "partial"}
    assert results[0].findings
    assert "五一" in results[0].summary


# --------------------------------------------------------------------------
# 5. 路由（01 §2.2、§2.4；02 §2.7）
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_router_degraded_but_forced_tools_released(settings, db):
    from app.agent.routing import ToolRouter
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    router = ToolRouter(settings, registry)
    trip = Trip(trip_id="np-route", title="t", version=0)
    decision = await router.decide(trip=trip, text="五一去新疆", has_research=False)
    assert decision.degraded is True
    assert decision.intent.value == "first_plan"
    # 常开档 + 写工具始终在
    assert {"search_poi", "plan_route", "draft_itinerary", "update_itinerary"} <= decision.allowed
    # 首次规划且没有调研证据 → dispatch_research 强制放行
    assert "dispatch_research" in decision.allowed
    # 降级规则：首次规划放行 climate_reference
    assert "climate_reference" in decision.allowed
    # 子 Agent 专属工具永远不在主 Agent 清单里
    assert not {"submit_findings", "social_digest", "fetch_page"} & decision.allowed


@pytest.mark.asyncio
async def test_router_forced_opening_hours_gap(settings, db):
    from app.agent.routing import Intent, ToolRouter
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    router = ToolRouter(settings, registry)
    trip = Trip.model_validate(_trip_payload())
    decision = await router.decide(
        trip=trip, text="把 Day1 晚一点", has_research=True, intent_override=Intent.REPLAN
    )
    assert "opening_hours_lookup" in decision.allowed
    assert "opening_hours_lookup" in decision.forced
    # 有调研证据或非首次规划 → 不再强制调研
    assert "dispatch_research" not in decision.forced


@pytest.mark.asyncio
async def test_registry_enforces_allowed_at_execution(settings, db):
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    outcome = await registry.execute(
        "web_search", {"query": "x"}, "mock", allowed={"search_poi"}
    )
    assert not outcome.ok
    assert outcome.error is not None and outcome.error.code == "tool_not_allowed"

    sub_only = await registry.execute("submit_findings", {"task_id": "t1"}, "mock", agent="main")
    assert not sub_only.ok
    assert sub_only.error is not None and sub_only.error.code == "tool_not_allowed"


# --------------------------------------------------------------------------
# 6. 确定性环境工具与天气修复
# --------------------------------------------------------------------------


def test_sun_times_reasonable():
    from app.tools.local_facts import sun_times

    hemu = sun_times(87.62, 48.05, "2026-05-01")
    assert hemu["sunrise"] and hemu["sunset"]
    assert hemu["sunrise"] < hemu["sunset"]
    assert hemu["sunset"] >= "20:30"  # 北疆五一日落很晚
    shanghai = sun_times(121.47, 31.23, "2026-05-01")
    assert "05:" in shanghai["sunrise"] and "18:" in shanghai["sunset"]


def test_holiday_calendar_reports_missing_years():
    from app.tools.local_facts import holiday_calendar

    known = holiday_calendar("2025-05-01", "2025-05-05")
    assert known["status"] == "reference"
    assert any(item["name"] == "劳动节" for item in known["holidays"])
    unknown = holiday_calendar("2026-05-01", "2026-05-05")
    assert unknown["status"] == "unverified"
    assert unknown["missing_years"] == [2026]
    assert "不编造" in (unknown["note"] or "")


@pytest.mark.asyncio
async def test_weather_out_of_forecast_is_explicit(settings, monkeypatch):
    from app.tools.amap import AmapClient, AmapError

    client = AmapClient(settings.model_copy(update={"amap_web_key": "k"}))

    async def fake_get(self, path, params):
        return {
            "status": "1",
            "forecasts": [
                {
                    "casts": [
                        {"date": "2026-05-01", "dayweather": "晴", "daytemp": "20", "nighttemp": "8"},
                        {"date": "2026-05-02", "dayweather": "晴", "daytemp": "21", "nighttemp": "9"},
                        {"date": "2026-05-03", "dayweather": "多云", "daytemp": "19", "nighttemp": "7"},
                    ]
                }
            ],
        }

    monkeypatch.setattr(AmapClient, "_get", fake_get)
    with pytest.raises(AmapError) as excinfo:
        await client.weather("布尔津", "2026-05-10")
    assert excinfo.value.code == "out_of_forecast"
    ok = await client.weather("布尔津", "2026-05-02")
    assert ok.high == 21


@pytest.mark.asyncio
async def test_route_parses_tolls(settings, monkeypatch):
    from app.tools.amap import AmapClient

    client = AmapClient(settings.model_copy(update={"amap_web_key": "k"}))

    async def fake_get(self, path, params):
        if path == "geocode/geo":
            return {"status": "1", "geocodes": [{"location": "87.0,48.0"}]}
        return {
            "status": "1",
            "route": {
                "paths": [
                    {
                        "distance": "120000",
                        "duration": "7200",
                        "tolls": "45",
                        "toll_distance": "80000",
                        "steps": [{"road": "G217", "toll_road": "1", "polyline": "87.0,48.0;87.1,48.1"}],
                    }
                ]
            },
        }

    monkeypatch.setattr(AmapClient, "_get", fake_get)
    route = await client.plan_route("A", "B", "drive")
    assert route.tolls == 45.0
    assert route.toll_distance_km == 80.0
    assert route.has_toll_road is True


# --------------------------------------------------------------------------
# 7. 复合工具没有 Key 时明确 not_configured
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_composite_tool_without_keys_is_not_configured(settings, db):
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    for name, args in {
        "ticket_channel_lookup": {"poi": "喀纳斯"},
        "opening_hours_lookup": {"poi": "喀纳斯"},
        "closure_notice_lookup": {"target": "独库公路"},
        "permit_policy_lookup": {"region": "塔县"},
        "transport_info_lookup": {"from": "上海", "to": "乌鲁木齐"},
        "climate_reference": {"city": "阿勒泰"},
    }.items():
        outcome = await registry.execute(name, args, "real")
        assert not outcome.ok, name
        assert outcome.error is not None and outcome.error.code == "not_configured", name


@pytest.mark.asyncio
async def test_local_tools_work_without_keys(settings, db):
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    sun = await registry.execute("sun_times", {"lng": 87.62, "lat": 48.05, "date": "2026-05-01"}, "real")
    assert sun.ok and sun.data["sunset"]
    holiday = await registry.execute("holiday_calendar", {"start": "2025-05-01", "end": "2025-05-05"}, "real")
    assert holiday.ok and holiday.data["status"] == "reference"


# --------------------------------------------------------------------------
# 8. 开场提问卡 7 项（02 §4.1）
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mock_opening_card_has_seven_questions(settings, db):
    from app.agent.loop import AgentLoop
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    loop = AgentLoop(settings, db, registry)
    trip = Trip(trip_id="np-ask", title="新行程", version=0)
    await db.upsert_trip(trip, 0)
    events = [e async for e in loop.stream(trip, ChatRequest(content="我想五一去新疆"))]
    ask_events = [e for e in events if e.type.value == "ask_user"]
    assert ask_events
    ask = ask_events[0].payload
    assert len(ask["questions"]) == 7
    assert ask["allow_skip"] is True
    # 日期/目的地这类 chips 列不全的题要有「其他」选项
    questions = {q["question"]: q for q in ask["questions"]}
    assert any("想去哪里" in title for title in questions)
    for title, question in questions.items():
        if any(key in title for key in ("想去哪里", "什么时候去", "去几天", "从哪个城市出发")):
            assert any(option["id"] == "other" for option in question["options"]), title


# --------------------------------------------------------------------------
# 9. 字段级事实由代码并行补齐（02 §2.6 第 3 步）
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fact_enricher_skips_without_keys(settings, db):
    from app.services.fact_enrichment import FactEnricher
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    enricher = FactEnricher(settings, ToolRegistry(settings, db))
    assert enricher.available is False
    trip = Trip.model_validate(_trip_payload())
    result = await enricher.plan_ops(trip, trip_id=trip.trip_id, turn_id="t")
    assert result.ok is False and result.ops == []


@pytest.mark.asyncio
async def test_fact_enricher_fills_verified_facts(settings, db, monkeypatch):
    from app.services.fact_enrichment import FactEnricher
    from app.services.plan_service import PlanService
    from app.schemas.plan import Trip
    from app.tools import registry as registry_module
    from app.tools.registry import ToolRegistry

    live = settings.model_copy(
        update={"deepseek_api_key": "k", "tavily_api_key": "t"}
    )

    async def fake_hours(*_args, **kwargs):
        return (
            {
                "value": {
                    "regular": [{"days": [], "open": "09:00", "close": "17:00"}],
                    "closed_days": [],
                    "closed_dates": [],
                    "seasonal": [],
                    "reservation_required": True,
                    "note": None,
                },
                "evidence": [
                    {"url": "https://example.gov.cn/a", "source_ref": "web:gov1", "source_type": "government"}
                ],
                "authority": 4,
                "conflict": False,
                "status": "verified",
                "source_refs": ["tool:opening_hours_lookup:fake", "web:gov1"],
                "providers": ["deepseek"],
                "retrieval_errors": [],
            },
            "09:00-17:00",
        )

    async def fake_ticket(*_args, **kwargs):
        return {
            "value": {
                "price_range": [100, 150],
                "currency": "CNY",
                "lead_time_days": 3,
                "real_name_required": True,
                "reservation_required": None,
                "channels": [
                    {
                        "name": "测试景区公众号",
                        "type": "wechat_mp",
                        "official": True,
                        "status": "verified",
                        "evidence_url": "web:gov1",
                        "how_to_find": "微信搜索测试景区",
                    }
                ],
                "sale_rule": {
                    "mode": "advance_days_at_time",
                    "advance_days": 7,
                    "release_time": "20:00",
                    "fixed_date": None,
                },
                "limited_quota": None,
                "note": None,
            },
            "evidence": [
                {"url": "https://example.gov.cn/a", "source_ref": "web:gov1", "source_type": "government"}
            ],
            "authority": 4,
            "conflict": False,
            "status": "verified",
            "source_refs": ["tool:ticket_channel_lookup:fake", "web:gov1"],
            "providers": ["deepseek"],
            "retrieval_errors": [],
        }

    monkeypatch.setattr(registry_module, "opening_hours_lookup", fake_hours)
    monkeypatch.setattr(registry_module, "ticket_channel_lookup", fake_ticket)

    registry = ToolRegistry(live, db)
    enricher = FactEnricher(live, registry)
    assert enricher.available is True
    trip = Trip.model_validate(_trip_payload())
    await db.upsert_trip(trip)
    result = await enricher.plan_ops(trip, trip_id=trip.trip_id, turn_id="t1")
    assert result.ok and len(result.ops) == 2

    plans = PlanService(live, db, registry.sources)
    updated = await plans.update(
        trip, result.ops, summary="补齐字段级事实", policy="legacy"
    )
    assert updated.ok, updated.outcome.summary
    stop = updated.trip.days[0].stops[0]
    assert stop.opening_hours is not None
    assert stop.opening_hours.status.value == "verified"
    assert stop.opening_hours.regular[0].open == "09:00"
    ticket = stop.activities[0].ticket
    assert ticket is not None
    assert ticket.price_range == (100.0, 150.0)
    assert ticket.sale_rule is not None and ticket.sale_rule.source_ref == "tool:ticket_channel_lookup:fake"
    assert ticket.channels[0].status.value == "verified"


# --------------------------------------------------------------------------
# 10. 无来源的时效事实：置空而不是写入（01 §9.2）
# --------------------------------------------------------------------------


def _payload_with_unsourced_ticket():
    payload = _trip_payload()
    payload["days"][0]["stops"][0]["activities"][0]["ticket"] = {
        "kind": "attraction",
        "price_range": [100, 150],
        "channels": [{"name": "某公众号", "type": "wechat_mp", "status": "verified"}],
        "lead_time_days": 3,
    }
    payload["days"][0]["stops"][0]["activities"].append(
        {
            "activity_id": "a2",
            "type": "long_transit",
            "title": "飞乌鲁木齐",
            "time_window": {"start": "13:00", "end": "17:00"},
            "transit_detail": {
                "mode": "flight",
                "flight_no": "MU9999",
                "dep_time": "13:00",
                "arr_time": "17:00",
            },
        }
    )
    return payload


@pytest.mark.asyncio
async def test_agent_writes_blank_unsourced_facts(settings, db):
    from app.services.plan_service import PlanService
    from app.services.source_registry import SourceRegistry

    plans = PlanService(settings, db, SourceRegistry(db))
    result = await plans.draft(_empty_trip(), _payload_with_unsourced_ticket(), policy="agent")
    assert result.ok, result.outcome.summary
    stop = result.trip.days[0].stops[0]
    ticket = stop.activities[0].ticket
    assert ticket is not None
    assert ticket.price_range is None and ticket.channels == [] and ticket.lead_time_days is None
    assert "未核实" in (ticket.note or "")
    flight = stop.activities[1].transit_detail
    assert flight.flight_no is None and flight.dep_time is None


@pytest.mark.asyncio
async def test_legacy_writes_keep_seed_facts(settings, db):
    from app.services.plan_service import PlanService
    from app.services.source_registry import SourceRegistry

    plans = PlanService(settings, db, SourceRegistry(db))
    # legacy 通道（种子/验收脚本）不置空，历史数据必须原样保留
    result = await plans.draft(_empty_trip(), _payload_with_unsourced_ticket(), policy="legacy")
    assert result.ok, result.outcome.summary
    ticket = result.trip.days[0].stops[0].activities[0].ticket
    assert ticket.price_range == (100.0, 150.0)


# --------------------------------------------------------------------------
# 11. 协作流程相关：初版按时间排序 + 长途段优先
# --------------------------------------------------------------------------


def _two_stop_payload(first_start: str, second_start: str):
    return {
        "trip_id": "np-order",
        "version": 0,
        "title": "排序测试",
        "days": [
            {
                "day_index": 1,
                "date": "2026-05-02",
                "stops": [
                    {
                        "stop_id": "late",
                        "poi": {"name": "景点 B", "lng": 87.0, "lat": 48.0, "source_ref": "poi:seed:b"},
                        "activities": [
                            {"activity_id": "b1", "type": "visit", "title": "B",
                             "time_window": {"start": first_start, "end": "23:00"}}
                        ],
                    },
                    {
                        "stop_id": "early",
                        "poi": {"name": "景点 A", "lng": 87.1, "lat": 48.1, "source_ref": "poi:seed:a"},
                        "activities": [
                            {"activity_id": "a1", "type": "visit", "title": "A",
                             "time_window": {"start": second_start, "end": "10:30"}}
                        ],
                    },
                ],
            }
        ],
    }


@pytest.mark.asyncio
async def test_draft_sorts_stops_and_activities_by_time(settings, db):
    from app.services.plan_service import PlanService
    from app.services.source_registry import SourceRegistry

    plans = PlanService(settings, db, SourceRegistry(db))
    result = await plans.draft(
        _empty_trip(), _two_stop_payload("15:00", "09:00"), policy="agent"
    )
    assert result.ok, result.outcome.summary
    stops = result.trip.days[0].stops
    assert [stop.stop_id for stop in stops] == ["early", "late"]


def test_leg_mode_prefers_long_transit_over_bogus_local_transit():
    """跨城段的 transit_from_prev 常被模型抄成市内时长；长途明细必须优先。"""
    from app.schemas.plan import Trip
    from app.services.route_enricher import derive_legs

    trip = Trip.model_validate(
        {
            "trip_id": "np-legs",
            "title": "长途腿",
            "days": [
                {
                    "day_index": 1,
                    "stops": [
                        {
                            "stop_id": "from",
                            "poi": {"name": "信阳东站", "lng": 114.0, "lat": 32.1, "source_ref": "poi:seed:x"},
                            "activities": [
                                {
                                    "activity_id": "t1",
                                    "type": "long_transit",
                                    "title": "高铁去大理",
                                    "time_window": {"start": "13:00", "end": "17:15"},
                                    "transit_detail": {
                                        "mode": "train",
                                        "station_from": "信阳东",
                                        "station_to": "大理",
                                        "dep_time": "13:00",
                                        "arr_time": "17:15",
                                    },
                                }
                            ],
                        },
                        {
                            "stop_id": "to",
                            "poi": {"name": "大理古城", "lng": 100.164, "lat": 25.695, "source_ref": "poi:seed:y"},
                            "activities": [
                                {
                                    "activity_id": "f1",
                                    "type": "free",
                                    "title": "取车",
                                    "time_window": {"start": "17:15", "end": "18:45"},
                                    # 模型抄错的市内时长：不能被当成跨城段的真实耗时
                                    "transit_from_prev": {
                                        "mode": "drive", "minutes": 43, "distance_km": 19.3,
                                        "source_ref": "route:bogus",
                                    },
                                }
                            ],
                        },
                    ],
                }
            ],
        }
    )
    legs = derive_legs(trip)
    assert len(legs) == 1
    assert legs[0].mode == "train"
    assert legs[0].distance_m is None  # 火车段不编造道路距离
    assert legs[0].duration_min == 255


@pytest.mark.asyncio
async def test_router_forces_research_even_when_intent_is_clarify(settings, db):
    """用户回答开场卡时 Jev 常判成「澄清」；只要还没有行程，调研工具就必须放行。"""
    from app.agent.routing import Intent, ToolRouter
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    router = ToolRouter(settings, ToolRegistry(settings, db))
    trip = Trip(trip_id="np-clarify", title="t", version=0)
    decision = await router.decide(
        trip=trip,
        text="（回答提问）3 人，12 月 1 日出发",
        has_research=False,
        has_answers=True,
        intent_override=Intent.CLARIFY,
    )
    assert "dispatch_research" in decision.forced
    assert "dispatch_research" in decision.allowed


@pytest.mark.asyncio
async def test_subagent_trace_records_each_step(settings, db, monkeypatch):
    """子 Agent 的运行轨迹要能点开看：工具、成败、耗时、提交方式都要有。"""
    from app.agent import subagent as subagent_module
    from app.llm.providers import ProviderResponse
    from app.schemas.tools import ToolCall
    from app.tools.registry import ToolRegistry

    live = settings.model_copy(
        update={"default_provider": "deepseek", "deepseek_api_key": "test-key"}
    )

    class FakeProvider:
        calls = 0

        async def chat(self, messages, tools, model):
            FakeProvider.calls += 1
            if FakeProvider.calls == 1:
                return ProviderResponse(
                    content="",
                    tool_calls=[
                        ToolCall(
                            id="c1",
                            name="sun_times",
                            arguments={"lng": 100.16, "lat": 25.69, "date": "2026-12-01"},
                        )
                    ],
                    finish_reason="tool_calls",
                )
            return ProviderResponse(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c2",
                        name="submit_findings",
                        arguments={
                            "task_id": "t1",
                            "role": "conditions",
                            "status": "ok",
                            "summary": "12 月初大理日出约 07:50。",
                            "findings": [
                                {
                                    "kind": "fact",
                                    "claim": "12 月初大理日出约 07:50",
                                    "source_refs": ["local:sun:test"],
                                }
                            ],
                            "gaps": [],
                        },
                    )
                ],
                finish_reason="tool_calls",
            )

    monkeypatch.setattr(subagent_module, "build_provider", lambda *_: FakeProvider())
    runner = subagent_module.ResearchRunner(live, ToolRegistry(live, db))
    results = await runner.run([{"task_id": "t1", "role": "conditions", "goal": "查日出"}])
    result = results[0]
    assert result.trace is not None
    trace = result.trace
    assert trace.model and trace.duration_ms >= 0
    assert trace.task_id == "t1" and trace.role.value == "conditions"
    tool_steps = [step for step in trace.steps if step.kind == "tool"]
    assert tool_steps and tool_steps[0].tool == "sun_times"
    assert tool_steps[0].ok is True
    assert tool_steps[0].duration_ms is not None
    assert any(step.kind == "submit" for step in trace.steps)
    assert trace.tool_calls_used >= 1


@pytest.mark.asyncio
async def test_subagent_emits_progress_events(settings, db, monkeypatch):
    """子 Agent 的 started/step/finished 要实时推给前端（SSE sink）。"""
    from app.agent import subagent as subagent_module
    from app.llm.providers import ProviderResponse
    from app.schemas.tools import ToolCall
    from app.tools.registry import ToolRegistry

    live = settings.model_copy(
        update={"default_provider": "deepseek", "deepseek_api_key": "test-key"}
    )

    class FakeProvider:
        calls = 0

        async def chat(self, messages, tools, model):
            FakeProvider.calls += 1
            if FakeProvider.calls == 1:
                return ProviderResponse(
                    content="",
                    tool_calls=[
                        ToolCall(
                            id="c1",
                            name="sun_times",
                            arguments={"lng": 100.16, "lat": 25.69, "date": "2026-12-01"},
                        )
                    ],
                    finish_reason="tool_calls",
                )
            return ProviderResponse(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c2",
                        name="submit_findings",
                        arguments={
                            "task_id": "t1",
                            "role": "conditions",
                            "status": "ok",
                            "summary": "日出 07:50",
                            "findings": [
                                {"kind": "fact", "claim": "日出 07:50", "source_refs": ["local:sun:test"]}
                            ],
                            "gaps": [],
                        },
                    )
                ],
                finish_reason="tool_calls",
            )

    monkeypatch.setattr(subagent_module, "build_provider", lambda *_: FakeProvider())
    events: list[dict] = []

    async def sink(payload):
        events.append(payload)

    runner = subagent_module.ResearchRunner(live, ToolRegistry(live, db))
    await runner.run([{"task_id": "t1", "role": "conditions", "goal": "查日出"}], sink=sink)

    states = [event["state"] for event in events]
    assert states[0] == "started"
    assert "step" in states
    assert states[-1] == "finished"
    steps = [event["step"] for event in events if event["state"] == "step"]
    assert any(step["kind"] == "tool" and step["tool"] == "sun_times" for step in steps)
    assert any(step["kind"] == "submit" for step in steps)
    finished = events[-1]
    assert finished["status"] in {"ok", "partial"}
    assert finished["findings_count"] == 1


@pytest.mark.asyncio
async def test_loop_streams_read_tool_progress(settings, db):
    """_stream_reads 要在工具执行过程中把事件吐出来，而不是等结束。"""
    from app.agent.loop import AgentLoop
    from app.agent.routing import RoutingDecision, Intent
    from app.schemas.plan import Trip
    from app.schemas.tools import ToolCall, ToolOutcome
    from app.tools.registry import ToolRegistry

    registry = ToolRegistry(settings, db)
    loop = AgentLoop(settings, db, registry)

    async def fake_execute(name, args, data_source="auto", *, event_sink=None, **kwargs):
        if event_sink is not None:
            await event_sink({"task_id": "t1", "state": "started"})
            await event_sink({"task_id": "t1", "state": "finished", "status": "ok"})
        return ToolOutcome(ok=True, tool=name, summary="done", data={})

    registry.execute = fake_execute
    trip = Trip(trip_id="np-stream", title="t", version=0)
    decision = RoutingDecision(intent=Intent.FIRST_PLAN, allowed={"dispatch_research"})
    results: dict = {}
    seen = []
    async for payload in loop._stream_reads(
        [ToolCall(id="c1", name="dispatch_research", arguments={})],
        trip,
        "turn-1",
        decision,
        results,
    ):
        seen.append(payload["state"])
    assert seen == ["started", "finished"]
    assert results["c1"].ok is True
