"""REST 快路径的写事务收尾（mindtrip/06 §13.3）。

对话之外，地图/抽屉/浮卡也会改行程（加地点、删地点、拖拽、改约束）。它们**必须**
与 agent loop 走同一条管线：apply_ops → validator → upsert → revision log，并且要发
`plan_patch`（+ `route`）事件，否则重连/回放会看到一份不一致的行程。
"""

from __future__ import annotations

from typing import Any

from app.db import Database
from app.schemas.events import EventType, SseEvent
from app.services.plan_service import PlanService, PlanWriteResult
from app.services.route_enricher import changed_legs, derive_legs


async def publish_patch(
    db: Database,
    plans: PlanService,
    result: PlanWriteResult,
    ops: list[dict[str, Any]],
    reason: str | None,
    model: str = "rest",
) -> dict[str, Any]:
    """把一次写出成并发的 `plan_patch` + `route` 事件，返回 patch payload。"""
    assert result.trip is not None
    trip = result.trip
    payload = plans.patch_payload(result, ops, reason)
    turn_id = await db.create_turn(trip.trip_id, model)
    seq = await db.reserve_seq(trip.trip_id)
    event = SseEvent(
        seq=seq,
        type=EventType.PLAN_PATCH,
        payload=payload,
        trip_id=trip.trip_id,
        turn_id=turn_id,
    )
    await db.append_event(turn_id, event)

    legs = derive_legs(trip)
    touched = changed_legs(
        legs,
        list((payload.get("changed") or {}).get("stop_ids") or []),
        list((payload.get("changed") or {}).get("day_indexes") or []),
    )
    for leg in touched[:24]:
        await db.append_event(
            turn_id,
            SseEvent(
                seq=await db.reserve_seq(trip.trip_id),
                type=EventType.ROUTE,
                payload={
                    "leg_id": leg.leg_id,
                    "from_stop_id": leg.from_stop_id,
                    "to_stop_id": leg.to_stop_id,
                    "mode": leg.mode,
                    "distance_m": leg.distance_m,
                    "duration_min": leg.duration_min,
                    "polyline_ref": None,
                    "source": leg.source,
                },
                trip_id=trip.trip_id,
                turn_id=turn_id,
            ),
        )
    await db.finish_turn(
        turn_id,
        messages=[],
        status="done",
        plan_snapshot=trip.model_dump(mode="json"),
    )
    return payload
