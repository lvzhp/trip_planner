"""FastAPI routes.

POST /trips/{id}/messages is the only streaming endpoint: seven SSE event types
(`route` 为 mindtrip/06 §13.2 新增)，each with a per-trip monotonic seq.
GET /trips/{id}/events?after_seq=N is the reconnect/replay endpoint (docs §6.5).
地图旁路接口（浮卡 / 加地点 / 收藏 / 导入 / 评论 / 导出）在 routes_mindtrip.py。
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.api.serialize import to_camel
from app.agent.loop import AgentLoop
from app.config import Settings
from app.core.validator import validate_and_derive
from app.db import Database
from app.schemas.api import (
    ChatRequest,
    GuideRequest,
    IntegrationCheckRequest,
    ProfileUpdate,
    RuntimeSettingsUpdate,
    ConfigResponse,
    CreateTripRequest,
    HealthResponse,
    ModelSelection,
    RenameTripRequest,
    RestoreRequest,
    TripDetail,
    TripSummary,
    VersionDetail,
    VersionItem,
)
from app.schemas.events import EventType, SseEvent
from app.schemas.plan import Trip
from app.seed.loader import DEMO_TRIP_ID
from app.services.guide_service import GuideService
from app.services.message_segments import attach_segments
from app.services.plan_service import PlanService
from app.services.route_enricher import derive_legs
from app.services.user_profile import UserProfileStore
from app.services.integrations import check_integrations
from app.services.wiring import wire_services
from app.runtime import RuntimeSettingsError, RuntimeSettingsStore

router = APIRouter(prefix="/api")

PLACEHOLDER_TITLES = {"未命名行程", "New trip", ""}


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _db(request: Request) -> Database:
    return request.app.state.db


def _loop(request: Request) -> AgentLoop:
    return request.app.state.agent_loop


def _plans(request: Request) -> PlanService:
    return request.app.state.plan_service


def _guides(request: Request):
    return request.app.state.guides


def _profile_store(request: Request):
    return request.app.state.profile


def _today(settings: Settings):
    return settings.demo_today if settings.demo_mode else datetime.now().date()


def _summary(trip: Trip, derived) -> TripSummary:
    start = trip.constraints.date_range.start if trip.constraints.date_range else None
    end = trip.constraints.date_range.end if trip.constraints.date_range else None
    errors = sum(1 for c in derived.conflicts if c.severity.value == "error")
    warnings = sum(1 for c in derived.conflicts if c.severity.value == "warning")
    dest = None
    if trip.days:
        first = trip.days[0].stops[0].poi.city if trip.days[0].stops else None
        dest = first or (trip.days[0].stops[0].poi.name if trip.days[0].stops else None)
    return TripSummary(
        trip_id=trip.trip_id,
        title=trip.title or "未命名行程",
        version=trip.version,
        origin=trip.constraints.origin,
        dest=dest,
        date_start=start,
        date_end=end,
        days=len(trip.days),
        transport_mode=(
            trip.constraints.transport_mode.value if trip.constraints.transport_mode else None
        ),
        updated_at=trip.updated_at,
        error_count=errors,
        warning_count=warnings,
        done=bool(trip.days) and errors == 0,
        route_points=[
            (stop.poi.lng, stop.poi.lat)
            for _, stop in trip.iter_stops()
            if stop.poi.lng is not None and stop.poi.lat is not None
        ],
    )


async def _route_legs(db: Database, trip: Trip) -> list[dict[str, Any]]:
    """距离行：以行程文档派生为准，用 route_legs 表里更完整的高德结果覆盖。"""
    legs = derive_legs(trip)
    try:
        rows = await db.list_route_legs(trip.trip_id)
    except Exception:  # noqa: BLE001 - 距离行不该让整份详情 500
        rows = []
    by_id = {row["leg_id"]: row for row in rows}
    out: list[dict[str, Any]] = []
    for leg in legs:
        row = by_id.get(leg.leg_id)
        if row:
            if row.get("distance_m") is not None:
                leg.distance_m = int(row["distance_m"])
            if row.get("duration_min") is not None:
                leg.duration_min = int(row["duration_min"])
            if row.get("source"):
                leg.source = row["source"]
            if row.get("fetched_at"):
                leg.fetched_at = row["fetched_at"]
            if row.get("polyline"):
                leg.polyline = [[float(point[0]), float(point[1])] for point in row["polyline"] if len(point) >= 2]
        out.append(leg.model_dump(mode="json"))
    return out


def _attach_segments(events: list[SseEvent], trip: Trip) -> list[SseEvent]:
    out: list[SseEvent] = []
    for event in events:
        if event.type == EventType.MESSAGE and isinstance(event.payload, dict):
            payload = attach_segments(event.payload, trip)
            if payload is not event.payload:
                event = event.model_copy(update={"payload": payload})
        out.append(event)
    return out


async def _detail(request: Request, trip: Trip, *, readonly: bool = False) -> dict[str, Any]:
    settings = request.app.state.settings
    derived = validate_and_derive(trip, _today(settings))
    db = _db(request)
    events = await db.get_events_after(trip.trip_id, 0)
    if readonly:
        # 分享页隐私（docs/07 §10）：qa 回合是行程主人的个人消费性提问，
        # 对看行程的人没价值，却暴露行为习惯 —— 过滤掉，只保留 plan 侧。
        events = _strip_qa_events(events)
    events = _attach_segments(events, trip)
    meta = await db.get_trip_meta(trip.trip_id) or {}
    return to_camel(
        {
            "trip": trip.model_dump(mode="json"),
            "derived": derived.model_dump(mode="json"),
            "events": [e.model_dump(mode="json") for e in events],
            "route_legs": await _route_legs(db, trip),
            "last_seq": int(meta.get("last_seq") or 0),
            "readonly": readonly,
        }
    )


def _strip_qa_events(events: list[SseEvent]) -> list[SseEvent]:
    """与前端 analyzeTurns 同一判据（docs/07 §8）：turn 含 plan_patch 或
    ask_user → plan 侧保留；否则是 qa 回合，整体剔除。"""
    plan_turns: set[str] = set()
    for e in events:
        if e.type.value in {"plan_patch", "ask_user"} and e.turn_id:
            plan_turns.add(e.turn_id)
    return [e for e in events if not e.turn_id or e.turn_id in plan_turns]


def _sse(event: SseEvent) -> str:
    payload = to_camel(event.model_dump(mode="json"))
    import json

    return f"id: {event.seq}\nevent: {event.type}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


# --------------------------------------------------------------------------
# health / config
# --------------------------------------------------------------------------


@router.get("/health", response_model=HealthResponse)
async def health(request: Request):
    db = _db(request)
    settings = request.app.state.settings
    return HealthResponse(database=db.backend, demo_mode=settings.demo_mode)


@router.get("/config")
async def config(request: Request):
    settings = request.app.state.settings
    provider = settings.default_provider
    model = settings.default_model
    catalog = settings.provider_catalog()
    current = next((p for p in catalog if p["id"] == provider), None)
    if current is None or not current["available"]:
        if settings.demo_mode:
            provider, model = "mock", "trace-mock-v1"
        else:
            # Production mode must not silently pretend a real provider exists.
            # If another real provider is configured, prefer it; otherwise keep
            # the requested provider so the UI can show "needs configuration".
            real = next(
                (p for p in catalog if p["id"] != "mock" and p["available"] and p["models"]),
                None,
            )
            if real:
                provider = real["id"]
                model = real["models"][0]["id"]
    selected = next((p for p in catalog if p["id"] == provider), None)
    agent_mode = "real" if (provider != "mock" and selected is not None and selected.get("available")) else "demo"
    return to_camel(
        ConfigResponse(
            app_name=settings.app_name,
            demo_mode=settings.demo_mode,
            agent_mode=agent_mode,
            amap_js_key=settings.amap_js_key,
            amap_js_security_code=settings.amap_js_security_code,
            amap_web_configured=bool(settings.amap_web_key),
            tavily_configured=bool(settings.tavily_api_key),
            llm_configured=settings.llm_configured,
            demo_today=_today(settings),
            default_model=ModelSelection(provider=provider, model=model),
            providers=catalog,
            map_provider=settings.effective_map_provider,
        ).model_dump(mode="json")
    )


# --------------------------------------------------------------------------
# runtime settings / integrations
# --------------------------------------------------------------------------


@router.get("/settings")
async def get_runtime_settings(request: Request):
    settings = request.app.state.settings
    runtime: RuntimeSettingsStore = request.app.state.runtime
    return to_camel(runtime.public(settings))


@router.put("/settings")
async def update_runtime_settings(request: Request, body: RuntimeSettingsUpdate):
    settings = request.app.state.settings
    runtime: RuntimeSettingsStore = request.app.state.runtime
    before = {
        "amap_js_key": settings.amap_js_key,
        "amap_js_security_code": settings.amap_js_security_code,
        "effective_map_provider": settings.effective_map_provider,
        "default_provider": settings.default_provider,
        "default_model": settings.default_model,
    }
    try:
        runtime.update(settings, body.model_dump())
    except RuntimeSettingsError as exc:
        raise HTTPException(400, str(exc)) from exc
    wire_services(request.app, settings, request.app.state.db)
    after = {
        "amap_js_key": settings.amap_js_key,
        "amap_js_security_code": settings.amap_js_security_code,
        "effective_map_provider": settings.effective_map_provider,
        "default_provider": settings.default_provider,
        "default_model": settings.default_model,
    }
    reload_required = any(
        before[k] != after[k]
        for k in ("amap_js_key", "amap_js_security_code", "effective_map_provider")
    )
    return to_camel(
        {
            "settings": runtime.public(settings),
            "reloadRequired": reload_required,
        }
    )


@router.post("/settings/check")
async def check_runtime_integrations(request: Request, body: IntegrationCheckRequest):
    settings = request.app.state.settings
    result = await check_integrations(settings, body.provider, body.model)
    return to_camel(result)


# --------------------------------------------------------------------------
# profile (用户长期口味档案 · docs/07 §7)
# --------------------------------------------------------------------------


@router.get("/profile")
async def get_profile(request: Request):
    """首屏问卷与设置弹窗「我的偏好」读取入口。

    隐私铁律：本档案绝不进 Trip / 详情 / 分享任何响应，只有这个独立端点。
    """
    store: UserProfileStore = _profile_store(request)
    profile = store.load()
    return to_camel({**profile.to_dict(), "exists": profile.exists, "options": store.options()})


@router.put("/profile")
async def put_profile(request: Request, body: ProfileUpdate):
    """写入长期口味档案。skip=True（首屏问卷跳过）后 dismissed 永久为真，不再弹问卷。"""
    store: UserProfileStore = _profile_store(request)
    profile = store.save(body.model_dump(exclude_none=True))
    return to_camel({**profile.to_dict(), "exists": profile.exists, "options": store.options()})


# --------------------------------------------------------------------------
# trips
# --------------------------------------------------------------------------


@router.get("/trips")
async def list_trips(request: Request):
    db = _db(request)
    settings = request.app.state.settings
    rows = await db.list_trips()
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            trip = Trip.model_validate(row["plan"])
        except Exception:
            continue
        derived = validate_and_derive(trip, _today(settings))
        out.append(to_camel(_summary(trip, derived).model_dump(mode="json")))
    return {"trips": out}


@router.post("/trips", status_code=201)
async def create_trip(request: Request, body: CreateTripRequest):
    db = _db(request)
    now = datetime.now(timezone.utc).isoformat()
    trip = Trip(
        trip_id="trip_" + uuid.uuid4().hex[:12],
        title=body.title or "未命名行程",
        version=0,
        created_at=now,
        updated_at=now,
    )
    await db.upsert_trip(trip, last_seq=0)
    return await _detail(request, trip)


@router.get("/trips/{trip_id}")
async def get_trip(request: Request, trip_id: str):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    return await _detail(request, trip)


@router.patch("/trips/{trip_id}")
async def rename_trip(request: Request, trip_id: str, body: RenameTripRequest):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    trip.title = body.title
    trip.updated_at = datetime.now(timezone.utc).isoformat()
    await db.upsert_trip(trip)
    return await _detail(request, trip)


@router.get("/trips/{trip_id}/events")
async def replay_events(
    request: Request,
    trip_id: str,
    after_seq: int = Query(default=0, ge=0),
):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    events = _attach_segments(await db.get_events_after(trip_id, after_seq), trip)
    meta = await db.get_trip_meta(trip_id) or {}
    return {
        "events": to_camel([e.model_dump(mode="json") for e in events]),
        "lastSeq": int(meta.get("last_seq") or 0),
    }


@router.post("/trips/{trip_id}/messages")
async def post_message(request: Request, trip_id: str, body: ChatRequest):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    stream = _loop(request).stream(trip, body)

    async def generate():
        yield ": connected\n\n"
        try:
            async for event in stream:
                if event.type == EventType.MESSAGE and (event.payload or {}).get("role") == "assistant":
                    latest = await db.get_trip(trip_id)
                    payload = attach_segments(event.payload, latest)
                    if payload is not event.payload:
                        event = event.model_copy(update={"payload": payload})
                yield _sse(event)
        except asyncio.CancelledError:
            raise
        finally:
            yield ": done\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------------
# guide (攻略层 · docs/07 §9)
# --------------------------------------------------------------------------


def _guide_sse(stage) -> str:
    """详情专用 SSE：与主对话流完全隔离，不进 turns、不占 per-trip seq。"""
    import json

    payload = to_camel(stage.model_dump(mode="json"))
    return f"event: {stage.stage}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def _find_stop_for_guide(trip: Trip, stop_id: str):
    found = trip.find_stop(stop_id)
    if found is None:
        raise HTTPException(404, f"stop not found: {stop_id}")
    day, stop = found
    return day, stop


@router.get("/trips/{trip_id}/stops/{stop_id}/guide")
async def stop_guide(
    request: Request,
    trip_id: str,
    stop_id: str,
    filters: str = Query(default=""),
    refresh: bool = Query(default=False),
    provider: str | None = Query(default=None),
    model: str | None = Query(default=None),
):
    """攻略层流式生成（stage + done，不做 partial）。

    分享页（readonly）**不能**触发本端点 —— 见 /share/{id}/guide。
    """
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    day, stop = _find_stop_for_guide(trip, stop_id)

    settings = _settings(request)
    profile: UserProfileStore = _profile_store(request)
    user = profile.load()
    guides: GuideService = _guides(request)

    model_sel = ModelSelection(
        provider=provider or settings.default_provider,
        model=model or settings.default_model,
    )
    season_note = _season_note_for(day)
    stream = guides.stream(
        trip_id=trip_id,
        trip_title=trip.title,
        season_note=season_note,
        stop=stop,
        filters=[f for f in filters.split(",") if f.strip()],
        diet=user.diet,
        taste=user.taste,
        provider_id=model_sel.provider,
        model=model_sel.model,
        refresh=refresh,
    )

    async def generate():
        yield ": connected\n\n"
        try:
            async for stage in stream:
                yield _guide_sse(stage)
        except asyncio.CancelledError:
            raise
        finally:
            yield ": done\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _season_note_for(day) -> str | None:
    """给攻略生成器的季节上下文（如「五一期间独库公路未开放」）。"""
    if day.date:
        return f"{day.date.month} 月出行"
    return None


@router.get("/share/{trip_id}/stops/{stop_id}/guide")
async def share_stop_guide(request: Request, trip_id: str, stop_id: str, filters: str = Query(default="")):
    """分享页只读攻略：**只能读缓存，不能触发生成**（docs/07 §10）。

    否则任何拿到链接的人都能无限刷 token（成本攻击面），而且是拿分享者的
    API Key 花钱。缓存未命中就返回空，前端显示「行程主人未生成此地攻略」。
    """
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    _, stop = _find_stop_for_guide(trip, stop_id)

    guides: GuideService = _guides(request)
    profile: UserProfileStore = _profile_store(request)
    user = profile.load()
    filter_list = [f for f in filters.split(",") if f.strip()]
    params = guides.cache_params(trip_id, stop, filter_list, user.diet, user.taste)
    cached = await guides.cached(params)
    if cached is None:
        return to_camel({"available": False, "guide": None})
    return to_camel({"available": True, "guide": cached.model_dump(mode="json")})


# --------------------------------------------------------------------------
# versions / share
# --------------------------------------------------------------------------


@router.get("/trips/{trip_id}/versions")
async def list_versions(request: Request, trip_id: str):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    turns = await db.list_turns(trip_id)
    snapshots = {
        int(t["plan_snapshot"].get("version", -1))
        for t in turns
        if t.get("plan_snapshot")
    }
    items: list[dict[str, Any]] = []
    for rev in reversed(trip.revision_log):
        item = VersionItem(
            version=rev.version,
            title=trip.title,
            summary=rev.summary,
            user_request=rev.user_request,
            op_count=rev.op_count,
            created_at=rev.created_at,
            changed_stop_ids=rev.changed_stop_ids,
            changed_activity_ids=rev.changed_activity_ids,
        ).model_dump(mode="json")
        item["available"] = rev.version == trip.version or rev.version in snapshots
        items.append(item)
    return to_camel({"versions": items, "currentVersion": trip.version})


@router.get("/trips/{trip_id}/versions/{version}")
async def get_version(request: Request, trip_id: str, version: int):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    if version == trip.version:
        derived = validate_and_derive(trip, _today(request.app.state.settings))
        return to_camel(
            VersionDetail(
                version=trip.version,
                title=trip.title,
                summary=(trip.revision_log[-1].summary if trip.revision_log else None),
                op_count=0,
                trip=trip,
                derived=derived,
            ).model_dump(mode="json")
        )
    snapshot = await db.find_snapshot(trip_id, version)
    if snapshot is None:
        raise HTTPException(404, f"v{version} 没有可恢复的快照")
    snap_trip = Trip.model_validate(snapshot)
    derived = validate_and_derive(snap_trip, _today(request.app.state.settings))
    rev = next((r for r in trip.revision_log if r.version == version), None)
    return to_camel(
        VersionDetail(
            version=version,
            title=snap_trip.title,
            summary=rev.summary if rev else None,
            user_request=rev.user_request if rev else None,
            op_count=rev.op_count if rev else 0,
            created_at=rev.created_at if rev else None,
            changed_stop_ids=rev.changed_stop_ids if rev else [],
            changed_activity_ids=rev.changed_activity_ids if rev else [],
            trip=snap_trip,
            derived=derived,
        ).model_dump(mode="json")
    )


@router.post("/trips/{trip_id}/restore")
async def restore_version(request: Request, trip_id: str, body: RestoreRequest):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    snapshot = await db.find_snapshot(trip_id, body.version)
    if snapshot is None:
        raise HTTPException(404, f"v{body.version} 没有可恢复的快照")
    result = await _plans(request).restore(trip, snapshot, body.version)
    if not result.ok or result.trip is None:
        raise HTTPException(400, result.outcome.summary)
    return await _detail(request, result.trip)


@router.get("/share/{trip_id}")
async def share(trip_id: str, request: Request):
    db = _db(request)
    trip = await db.get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    return await _detail(request, trip, readonly=True)
