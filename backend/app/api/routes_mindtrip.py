"""地图优先那一层功能的 REST 面（mindtrip/06 §13.3）。

与 `routes.py` 分开的原因：这些都是「地图/浮卡/抽屉/导入」旁路，读写的仍然是同一份
Trip（走 PlanService / apply_ops），但契约、错误语义与对话流互不影响。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse

from app.api.serialize import to_camel
from app.db import Database
from app.schemas.api import (
    AddStopRequest,
    ImportImagesRequest,
    ImportLinkRequest,
    ModelSelection,
    ReorderStopsRequest,
    TripDetail,
    UpdateStopPoiRequest,
)
from app.schemas.plan import (
    Activity,
    ActivityType,
    Day,
    Pace,
    Stop,
    TimeWindow,
    Trip,
    TripConstraints,
)
from app.schemas.places import (
    CandidatePlace,
    CommentCreateRequest,
    PlaceFeedbackRequest,
    PlaceSearchResult,
    SavedPlaceRequest,
    ThreadCreateRequest,
)
from app.services.imports import import_images, import_link
from app.services.plan_service import PlanService
from app.services.places import PlaceService
from app.services.route_enricher import derive_legs, enrich_legs, ics_for_trip, legs_payload
from app.services.threads import ThreadService
from app.services.trip_actions import publish_patch
from app.tools.amap import AmapClient

router = APIRouter(prefix="/api")

SAVED_USER = "local"


# --------------------------------------------------------------------------
# small accessors
# --------------------------------------------------------------------------


def _settings(request: Request):
    return request.app.state.settings


def _db(request: Request) -> Database:
    return request.app.state.db


def _plans(request: Request) -> PlanService:
    return request.app.state.plan_service


def _places(request: Request) -> PlaceService:
    return PlaceService(_settings(request), _db(request), AmapClient(_settings(request)))


def _threads(request: Request) -> ThreadService:
    return ThreadService(_settings(request), _db(request))


def _today(request: Request):
    settings = _settings(request)
    return settings.demo_today if settings.demo_mode else datetime.now().date()


async def _detail(request: Request, trip: Trip) -> dict[str, Any]:
    """和 routes._detail 同形，供写接口直接回全量快照。"""
    from app.api.routes import _detail as base_detail

    return await base_detail(request, trip)


async def _load_trip(request: Request, trip_id: str) -> Trip:
    trip = await _db(request).get_trip(trip_id)
    if trip is None:
        raise HTTPException(404, "trip not found")
    return trip


def _find_day(trip: Trip, day_index: int) -> Day:
    day = next((d for d in trip.days if d.day_index == day_index), None)
    if day is None:
        raise HTTPException(404, f"Day {day_index} 不存在")
    return day


def _parse_hm(value: time | str | None, fallback: time) -> time:
    if isinstance(value, time):
        return value
    if not value:
        return fallback
    try:
        hour, minute = (int(x) for x in str(value).split(":")[:2])
        return time(hour, minute)
    except (ValueError, IndexError):
        return fallback


def _next_window(day: Day) -> tuple[str, str]:
    """新加入的点排在这一天最后一个活动之后（不覆盖既有时间）。"""
    latest = None
    for stop in day.stops:
        for act in stop.activities:
            end = _parse_hm(act.time_window.end, time(18, 0))
            if latest is None or end > latest:
                latest = end
    base = _parse_hm(day.rhythm.wake, time(9, 0)) if latest is None else latest
    start = (datetime.combine(date.today(), base) + timedelta(minutes=30)).time()
    if start.hour >= 22:
        start = time(21, 30)
    end_dt = datetime.combine(date.today(), start) + timedelta(minutes=90)
    end = end_dt.time() if end_dt.time() <= time(23, 30) else time(23, 30)
    return start.strftime("%H:%M"), end.strftime("%H:%M")


# --------------------------------------------------------------------------
# places（浮卡 / 搜索 / 反馈）
# --------------------------------------------------------------------------


@router.get("/places/search")
async def search_places(
    request: Request,
    q: str = Query(default="", min_length=1),
    city: str | None = Query(default=None),
    limit: int = Query(default=8, ge=1, le=20),
    trip_id: str | None = Query(default=None),
):
    """无坐标 chip 的「确认位置」小卡、导入面板里的手动搜索都走这里。"""
    places = _places(request)
    trip = await _db(request).get_trip(trip_id) if trip_id else None
    items = _mark_added(await places.search(q, city, limit=limit), trip)
    source = "amap" if places.amap.configured else "mock"
    message = None if items else "没找到匹配地点，换个关键词或加上城市。"
    return to_camel(
        PlaceSearchResult(items=items, available=bool(items), message=message, source=source).model_dump(
            mode="json"
        )
    )


def _mark_added(items: list[Any], trip: Trip | None) -> list[Any]:
    """把「已在行程」的候选点标出来（§4.6：加入后应变成行程编号点，不再算候选）。"""
    if trip is None:
        return items
    index: list[tuple[str | None, str, int, str]] = []
    for day in trip.days:
        for stop in day.stops:
            index.append((stop.poi.amap_poi_id, stop.poi.name or "", day.day_index, stop.stop_id))
    for item in items:
        for amap_id, name, day_index, stop_id in index:
            short = name.split(" · ")[-1]
            matched = (amap_id and amap_id == item.poi_id) or item.name in {name, short} or (
                len(item.name) >= 3 and (item.name in name or name in item.name)
            )
            if matched:
                item.added = True
                item.stop_id = stop_id
                item.day_index = day_index
                break
    return items


@router.get("/places/nearby")
async def nearby_places(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    kind: str = Query(default="play"),
    radius: int = Query(default=3000, ge=300, le=20000),
    limit: int = Query(default=20, ge=1, le=40),
    trip_id: str | None = Query(default=None),
):
    """地图「加地点」的分类环：在当前视野中心做周边搜索。"""
    trip = await _db(request).get_trip(trip_id) if trip_id else None
    items = _mark_added(await _places(request).nearby(lng, lat, kind, radius, limit), trip)
    message = None
    if not items:
        message = "附近没找到，换个分类或扩大范围试试。"
    return to_camel({"items": [i.model_dump(mode="json") for i in items], "message": message, "kind": kind})


@router.get("/places/{poi_id}")
async def get_place(request: Request, poi_id: str, trip_id: str | None = Query(default=None)):
    db = _db(request)
    trip = None
    if trip_id:
        trip = await db.get_trip(trip_id)
    if trip is None:
        # 未指定 trip 时，尽量在最近更新的行程里找这个点（浮卡不要求带 trip_id）
        rows = await db.list_trips()
        for row in rows[:10]:
            try:
                candidate = Trip.model_validate(row["plan"])
            except Exception:  # noqa: BLE001
                continue
            if any(
                stop.stop_id == poi_id or stop.poi.amap_poi_id == poi_id
                for _day, stop in candidate.iter_stops()
            ):
                trip = candidate
                break
    detail = await _places(request).get(trip, poi_id)
    if detail is None:
        raise HTTPException(404, "place not found")
    return to_camel(detail.model_dump(mode="json"))


@router.post("/places/{poi_id}/feedback")
async def place_feedback(request: Request, poi_id: str, body: PlaceFeedbackRequest):
    """点赞/点踩先只记录，不做统计展示（mindtrip/06 §2.1 第 8 条）。"""
    await _db(request).cache_set(
        "place_feedback",
        {"poi_id": poi_id, "vote": body.vote},
        {"poi_id": poi_id, "vote": body.vote, "note": body.note, "at": datetime.now(timezone.utc).isoformat()},
        90 * 24 * 3600,
    )
    return {"ok": True, "recorded": True}


# --------------------------------------------------------------------------
# stops：加 / 删 / 换位置 / 重排
# --------------------------------------------------------------------------


@router.post("/trips/{trip_id}/stops")
async def add_stop(request: Request, trip_id: str, body: AddStopRequest):
    trip = await _load_trip(request, trip_id)
    day = _find_day(trip, body.day_index)
    source_ref = body.source_ref or (
        f"poi:amap:{body.amap_poi_id}" if body.amap_poi_id else f"poi:user:{uuid.uuid4().hex[:8]}"
    )
    start, end = _next_window(day)
    category = (body.category or "").lower()
    is_stay = category in {"stay", "hotel", "住宿", "酒店"}
    # 住宿收缩为区域级（new-plan 01 §10）：导入住宿类地点不再自动建 hotel 票，
    # 只写「住宿 · 地点（自行安排）」，没有酒店名/价格/渠道。
    activity = Activity(
        activity_id="a_" + uuid.uuid4().hex[:8],
        seq=len([a for s in day.stops for a in s.activities]) + 1,
        type=ActivityType.STAY if is_stay else ActivityType.VISIT,
        title=f"住宿 · {body.name}（自行安排）" if is_stay else body.name,
        time_window=TimeWindow(start=start, end=end),
        tips=[body.note] if body.note else [],
        source_refs=[source_ref],
        ticket=None,
    )
    poi = {
        "name": body.name,
        "amap_poi_id": body.amap_poi_id,
        "lng": body.lng,
        "lat": body.lat,
        "city": body.city,
        "address": body.address,
        "source_ref": source_ref,
    }
    stop_payload = {
        "stop_id": "s_" + uuid.uuid4().hex[:8],
        "seq": body.at_seq or (len(day.stops) + 1),
        "poi": poi,
        "activities": [activity.model_dump(mode="json")],
    }
    ops = [
        {
            "op": "insert_stop",
            "day_index": body.day_index,
            "at_seq": body.at_seq or (len(day.stops) + 1),
            "stop": stop_payload,
        }
    ]
    result = await _plans(request).update(
        trip, ops, summary=f"加入「{body.name}」到 Day {body.day_index}", user_request="地图/对话加入地点"
    )
    if not result.ok or result.trip is None:
        raise HTTPException(400, result.outcome.summary)
    await publish_patch(_db(request), _plans(request), result, ops, "加入地点")
    return to_camel(await _detail(request, result.trip))


@router.patch("/trips/{trip_id}/stops/{stop_id}")
async def update_stop_poi(request: Request, trip_id: str, stop_id: str, body: UpdateStopPoiRequest):
    """确认位置：给无坐标的地点补坐标/改名（mindtrip/06 §1.5）。"""
    trip = await _load_trip(request, trip_id)
    found = trip.find_stop(stop_id)
    if found is None:
        raise HTTPException(404, "stop not found")
    _, stop = found
    poi = stop.poi.model_dump()
    for key in ("name", "city", "address", "lat", "lng", "amap_poi_id"):
        value = getattr(body, key)
        if value not in (None, ""):
            poi[key] = value
    if body.source_ref:
        poi["source_ref"] = body.source_ref
    elif poi.get("lat") is not None and not poi.get("source_ref"):
        poi["source_ref"] = f"poi:user:{uuid.uuid4().hex[:8]}"
    ops = [{"op": "update_stop", "stop_id": stop_id, "patch": {"poi": poi}}]
    result = await _plans(request).update(trip, ops, summary="确认地点位置", user_request="确认位置")
    if not result.ok or result.trip is None:
        raise HTTPException(400, result.outcome.summary)
    await publish_patch(_db(request), _plans(request), result, ops, "确认位置")
    return to_camel(await _detail(request, result.trip))


@router.delete("/trips/{trip_id}/stops/{stop_id}")
async def delete_stop(request: Request, trip_id: str, stop_id: str):
    trip = await _load_trip(request, trip_id)
    found = trip.find_stop(stop_id)
    if found is None:
        raise HTTPException(404, "stop not found")
    _, stop = found
    ops = [{"op": "remove_stop", "stop_id": stop_id}]
    result = await _plans(request).update(
        trip, ops, summary=f"移出「{stop.poi.name}」", user_request="移出行程"
    )
    if not result.ok or result.trip is None:
        raise HTTPException(400, result.outcome.summary)
    await publish_patch(_db(request), _plans(request), result, ops, "移出行程")
    return to_camel(await _detail(request, result.trip))


@router.post("/trips/{trip_id}/reorder")
async def reorder_stops(request: Request, trip_id: str, body: ReorderStopsRequest):
    trip = await _load_trip(request, trip_id)
    day = _find_day(trip, body.day_index)
    if set(body.stop_ids) != {stop.stop_id for stop in day.stops}:
        raise HTTPException(400, "stop_ids 必须恰好包含当天全部 stop")
    ops = [{"op": "reorder", "day_index": body.day_index, "stop_ids": body.stop_ids}]
    result = await _plans(request).update(
        trip, ops, summary=f"Day {body.day_index} 重新排序", user_request="拖拽换序"
    )
    if not result.ok or result.trip is None:
        raise HTTPException(400, result.outcome.summary)
    patch = await publish_patch(_db(request), _plans(request), result, ops, "拖拽换序")
    detail = await _detail(request, result.trip)
    detail["patch"] = to_camel(patch)
    return to_camel(detail)


# --------------------------------------------------------------------------
# constraints（参数条 chips）
# --------------------------------------------------------------------------


@router.patch("/trips/{trip_id}/constraints")
async def patch_constraints(request: Request, trip_id: str, body: TripConstraints):
    trip = await _load_trip(request, trip_id)
    patch: dict[str, Any] = {}
    if body.destination is not None:
        patch["destination"] = body.destination
    if body.origin is not None:
        patch["origin"] = body.origin
    if body.travelers is not None:
        patch["travelers"] = body.travelers
    if body.budget is not None:
        patch["budget"] = {**trip.constraints.budget.model_dump(), "total": body.budget}
    if body.pace is not None:
        patch["pace"] = {"relaxed": Pace.RELAXED, "normal": Pace.NORMAL, "packed": Pace.INTENSE}[
            body.pace
        ].value

    working = trip.model_copy(deep=True)
    if body.start_date or body.end_date:
        start = body.start_date or (trip.constraints.date_range.start if trip.constraints.date_range else None)
        end = body.end_date or (trip.constraints.date_range.end if trip.constraints.date_range else None)
        if start and end and end < start:
            raise HTTPException(400, "结束日期不能早于开始日期")
        patch["date_range"] = {
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            # 改日期后原来的 note（如「只有 5.1–5.8 有假」）会变成误导，清空
            "note": None,
        }
        if start:
            for index, day in enumerate(working.days):
                day.date = start + timedelta(days=index)
            if end and body.sync_days == "trim":
                span = (end - start).days + 1
                if span < 1:
                    raise HTTPException(400, "日期范围不足一天")
                if span >= len(working.days):
                    pass  # 不删天，只把日期平移到新起始日
                else:
                    working.days = working.days[:span]
                    if not working.days:
                        raise HTTPException(400, "这个日期范围会把所有天都删掉")

    if not patch:
        raise HTTPException(400, "没有要修改的约束")
    ops = [{"op": "set_constraints", "patch": patch}]
    result = await _plans(request).update(
        working, ops, summary="更新行程参数", user_request="参数条 chips"
    )
    if not result.ok or result.trip is None:
        raise HTTPException(400, result.outcome.summary)
    payload = await publish_patch(_db(request), _plans(request), result, ops, "更新参数")
    detail = await _detail(request, result.trip)
    detail["patch"] = to_camel(payload)
    return to_camel(detail)


# --------------------------------------------------------------------------
# routes（距离行）
# --------------------------------------------------------------------------


@router.get("/trips/{trip_id}/routes")
async def list_routes(request: Request, trip_id: str):
    trip = await _load_trip(request, trip_id)
    rows = await _db(request).list_route_legs(trip_id)
    if rows:
        return to_camel({"legs": rows, "source": rows[0].get("source"), "stored": True})
    return to_camel({"legs": legs_payload(derive_legs(trip)), "stored": False})


@router.post("/trips/{trip_id}/routes/refresh")
async def refresh_routes(request: Request, trip_id: str):
    """拖拽/加地点后补算距离；失败保留旧值（前端显示「待更新」）。"""
    trip = await _load_trip(request, trip_id)
    from app.services.route_enricher import derive_legs

    legs = derive_legs(trip)
    message = None
    enriched = 0
    amap = AmapClient(_settings(request))
    if amap.configured:
        legs, enriched = await enrich_legs(trip, amap, legs, db=_db(request))
    else:
        message = "未配置高德 Web 服务 key，路线按两点示意，距离显示为「距离待算」"
    await _db(request).replace_route_legs(trip_id, legs_payload(legs))
    return to_camel({"legs": legs_payload(legs), "enriched": enriched, "message": message})


# --------------------------------------------------------------------------
# saved places（收藏 / 想去层）
# --------------------------------------------------------------------------


@router.get("/saved")
async def list_saved(request: Request):
    rows = await _db(request).list_saved(SAVED_USER)
    return to_camel({"items": rows})


@router.post("/saved", status_code=201)
async def save_place(request: Request, body: SavedPlaceRequest):
    await _db(request).save_place(
        SAVED_USER,
        {
            "poi_id": body.poi_id,
            "name": body.name or body.poi_id,
            "category": body.category,
            "lat": body.lat,
            "lng": body.lng,
            "city": body.city,
            "address": body.address,
            "note": body.note,
        },
    )
    rows = await _db(request).list_saved(SAVED_USER)
    return to_camel({"items": rows})


@router.delete("/saved/{poi_id}")
async def delete_saved(request: Request, poi_id: str):
    await _db(request).delete_saved(SAVED_USER, poi_id)
    rows = await _db(request).list_saved(SAVED_USER)
    return to_camel({"items": rows})


# --------------------------------------------------------------------------
# import（链接 / 文本 / 截图）
# --------------------------------------------------------------------------


@router.post("/import/link")
async def import_link_endpoint(request: Request, body: ImportLinkRequest, trip_id: str | None = Query(default=None)):
    trip = await _db(request).get_trip(trip_id) if trip_id else None
    result = await import_link(
        url=body.url,
        text=body.text,
        trip=trip,
        places=_places(request),
        settings=_settings(request),
        city=body.city,
    )
    return to_camel(result.model_dump(mode="json"))


@router.post("/import/images")
async def import_images_endpoint(request: Request, body: ImportImagesRequest):
    """截图 / 拍照导入：未接 OCR / 视觉模型时显式失败（不落盘原图）。"""
    pairs = [(img.filename or "image", img.data_base64) for img in body.images]
    return to_camel((await import_images(pairs, mode=body.mode)).model_dump(mode="json"))


# --------------------------------------------------------------------------
# threads（同行人评论 + @助手）
# --------------------------------------------------------------------------


@router.get("/trips/{trip_id}/threads")
async def list_threads(request: Request, trip_id: str):
    await _load_trip(request, trip_id)
    threads = await _threads(request).list(trip_id)
    return to_camel({"threads": [t.model_dump(mode="json") for t in threads]})


@router.post("/trips/{trip_id}/threads", status_code=201)
async def create_thread(request: Request, trip_id: str, body: ThreadCreateRequest):
    await _load_trip(request, trip_id)
    thread = await _threads(request).create(trip_id, body.title)
    return to_camel(thread.model_dump(mode="json"))


@router.get("/threads/{thread_id}")
async def get_thread(request: Request, thread_id: str):
    thread = await _threads(request).get(thread_id)
    if thread is None:
        raise HTTPException(404, "thread not found")
    return to_camel(thread.model_dump(mode="json"))


@router.post("/threads/{thread_id}/comments", status_code=201)
async def add_comment(request: Request, thread_id: str, body: CommentCreateRequest):
    service = _threads(request)
    thread_before = await service.get(thread_id)
    if thread_before is None:
        raise HTTPException(404, "thread not found")
    trip = await _load_trip(request, thread_before.trip_id)
    comment, reply = await service.comment(trip, thread_id, body.body, body.author)
    thread = await service.get(thread_id)
    return to_camel(
        {
            "thread": thread.model_dump(mode="json") if thread else None,
            "comment": comment.model_dump(mode="json"),
            "reply": reply.model_dump(mode="json") if reply else None,
        }
    )


# --------------------------------------------------------------------------
# export（ICS / 行程单）
# --------------------------------------------------------------------------


@router.get("/trips/{trip_id}/export.ics")
async def export_ics(request: Request, trip_id: str):
    trip = await _load_trip(request, trip_id)
    ics = ics_for_trip(trip)
    # HTTP 头只能是 latin-1：中文名走 RFC 5987 的 filename*，ASCII 名兜底
    encoded = quote(f"{trip.title or 'trace-trip'}.ics")
    return PlainTextResponse(
        ics,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=\"trace-trip.ics\"; filename*=UTF-8''{encoded}"
        },
    )
