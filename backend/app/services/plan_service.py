"""Plan write pipeline: mutate -> validate -> persist -> patch payload."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from app.config import Settings
from app.core.plan_engine import PlanValidationError, apply_ops, draft_trip
from app.core.validator import validate_and_derive
from app.db import Database
from app.schemas.plan import Derived, Revision, Trip
from app.schemas.tools import ToolError, ToolOutcome
from app.services.route_enricher import derive_legs, legs_payload
from app.services.source_registry import SourceRegistry, collect_trip_refs


@dataclass
class PlanWriteResult:
    ok: bool
    outcome: ToolOutcome
    trip: Trip | None = None
    derived: Derived | None = None
    diff: list[dict[str, Any]] = field(default_factory=list)
    changed: dict[str, Any] = field(default_factory=dict)


class PlanService:
    def __init__(self, settings: Settings, db: Database, sources: SourceRegistry | None = None):
        self.settings = settings
        self.db = db
        # 来源登记簿（new-plan 01 §9.1）：写入前核对 source_ref 是否真的发出过
        self.sources = sources

    async def _write_context(
        self, trip: Trip
    ) -> tuple[set[str] | None, dict[str, dict[str, Any]] | None]:
        if self.sources is None:
            return None, None
        try:
            known = await self.sources.known(trip.trip_id)
            payloads = await self.sources.opening_hours_payloads(trip.trip_id)
        except Exception:  # noqa: BLE001 - 登记簿故障不该阻塞行程写入
            return None, None
        # 补丁没碰过的旧数据不该因为「不在本趟清单里」被整份拒掉
        return known | collect_trip_refs(trip), payloads

    def _today(self) -> date:
        return self.settings.demo_today if self.settings.demo_mode else date.today()

    def derive(self, trip: Trip) -> Derived:
        return validate_and_derive(trip, self._today())

    async def draft(
        self,
        trip: Trip,
        payload: dict[str, Any],
        *,
        summary: str | None = None,
        user_request: str | None = None,
        turn_seq: int | None = None,
        policy: str = "legacy",
        known_refs: set[str] | None = None,
        opening_hours_payloads: dict[str, dict[str, Any]] | None = None,
    ) -> PlanWriteResult:
        if known_refs is None and opening_hours_payloads is None:
            known_refs, opening_hours_payloads = await self._write_context(trip)
        try:
            new_trip, diff = draft_trip(
                trip,
                payload,
                summary=summary,
                user_request=user_request,
                turn_seq=turn_seq,
                known_refs=known_refs,
                opening_hours_payloads=opening_hours_payloads,
                policy=policy,
            )
        except PlanValidationError as exc:
            return PlanWriteResult(
                ok=False,
                outcome=ToolOutcome(
                    ok=False,
                    tool="draft_itinerary",
                    error=ToolError(
                        tool="draft_itinerary", code="validation_error", message=str(exc)
                    ),
                    summary=f"行程写入被拒绝：{exc.errors[0]}",
                    data=exc.as_tool_error(),
                ),
            )
        derived = self.derive(new_trip)
        await self.db.upsert_trip(new_trip)
        await self._persist_legs(new_trip)
        outcome = self._success_outcome("draft_itinerary", new_trip, derived, "生成初版行程")
        return PlanWriteResult(
            ok=True,
            outcome=outcome,
            trip=new_trip,
            derived=derived,
            diff=diff,
            changed={"day_indexes": [d.day_index for d in new_trip.days], "stop_ids": ["*"], "activity_ids": ["*"]},
        )

    async def update(
        self,
        trip: Trip,
        ops: list[dict[str, Any]],
        *,
        summary: str | None = None,
        user_request: str | None = None,
        turn_seq: int | None = None,
        policy: str = "legacy",
        known_refs: set[str] | None = None,
        opening_hours_payloads: dict[str, dict[str, Any]] | None = None,
    ) -> PlanWriteResult:
        if known_refs is None and opening_hours_payloads is None:
            known_refs, opening_hours_payloads = await self._write_context(trip)
        try:
            new_trip, diff, changed = apply_ops(
                trip,
                ops,
                summary=summary,
                user_request=user_request,
                turn_seq=turn_seq,
                known_refs=known_refs,
                opening_hours_payloads=opening_hours_payloads,
                policy=policy,
            )
        except PlanValidationError as exc:
            return PlanWriteResult(
                ok=False,
                outcome=ToolOutcome(
                    ok=False,
                    tool="update_itinerary",
                    error=ToolError(
                        tool="update_itinerary", code="validation_error", message=str(exc)
                    ),
                    summary=f"补丁被拒绝：{exc.errors[0]}",
                    data=exc.as_tool_error(),
                ),
            )
        derived = self.derive(new_trip)
        await self.db.upsert_trip(new_trip)
        await self._persist_legs(new_trip)
        outcome = self._success_outcome(
            "update_itinerary", new_trip, derived, summary or f"{len(ops)} 处修改"
        )
        return PlanWriteResult(
            ok=True,
            outcome=outcome,
            trip=new_trip,
            derived=derived,
            diff=diff,
            changed=changed,
        )

    async def restore(self, trip: Trip, snapshot: dict[str, Any], version: int) -> PlanWriteResult:
        restored = Trip.model_validate(snapshot)
        restored.trip_id = trip.trip_id
        restored.version = trip.version + 1
        restored.updated_at = datetime.now(timezone.utc).isoformat()
        restored.revision_log = list(trip.revision_log) + [
            Revision(
                version=restored.version,
                summary=f"恢复到 v{version}",
                op_count=0,
                changed_stop_ids=["*"],
                changed_activity_ids=["*"],
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        ]
        derived = self.derive(restored)
        await self.db.upsert_trip(restored)
        await self._persist_legs(restored)
        outcome = self._success_outcome("restore_version", restored, derived, f"恢复到 v{version}")
        return PlanWriteResult(ok=True, outcome=outcome, trip=restored, derived=derived)

    def _success_outcome(
        self, tool: str, trip: Trip, derived: Derived, summary: str
    ) -> ToolOutcome:
        conflicts = [c.model_dump(mode="json") for c in derived.conflicts]
        data = {
            "ok": True,
            "version": trip.version,
            "summary": summary,
            "conflicts": conflicts,
            "conflict_count": len(conflicts),
            "error_count": sum(1 for c in derived.conflicts if c.severity.value == "error"),
            "warning_count": sum(1 for c in derived.conflicts if c.severity.value == "warning"),
            "derived": {
                "days": [d.model_dump(mode="json") for d in derived.days],
                "budget_summary": derived.budget_summary.model_dump(mode="json"),
                "booking_count": len(derived.booking_timeline),
                "ok": derived.ok,
            },
        }
        errs = data["error_count"]
        warns = data["warning_count"]
        msg = summary
        if conflicts:
            msg += f" · 校验：{errs} 错误 / {warns} 警告"
        else:
            msg += " · 校验通过"
        return ToolOutcome(
            ok=True,
            tool=tool,
            summary=msg,
            data=data,
            source_refs=[],
        )

    async def _persist_legs(self, trip: Trip) -> None:
        """距离行的唯一事实来源落库（mindtrip/06 §13.4 route_legs 表）。

        行程写入时重新派生 legs，但**不能把已缓存的真实道路几何冲掉**：
        按 leg_id 合并旧的 polyline / source / fetched_at，只有端点变了才丢弃。
        """
        try:
            previous = {
                row["leg_id"]: row for row in await self.db.list_route_legs(trip.trip_id)
            }
            payload = legs_payload(derive_legs(trip))
            for item in payload:
                old = previous.get(item["leg_id"])
                if not old:
                    continue
                if old.get("polyline") and old.get("from_stop_id") == item["from_stop_id"] and old.get("to_stop_id") == item["to_stop_id"]:
                    item["polyline"] = old["polyline"]
                    if item.get("source") is None:
                        item["source"] = old.get("source")
                    if item.get("fetched_at") is None:
                        item["fetched_at"] = old.get("fetched_at")
                    if item.get("distance_m") is None:
                        item["distance_m"] = old.get("distance_m")
                    if item.get("duration_min") is None:
                        item["duration_min"] = old.get("duration_min")
            await self.db.replace_route_legs(trip.trip_id, payload)
        except Exception:  # noqa: BLE001 - 距离行不该阻塞行程写入
            pass

    def patch_payload(self, result: PlanWriteResult, ops: list[dict[str, Any]], reason: str | None) -> dict[str, Any]:
        assert result.trip is not None and result.derived is not None
        # SSE 里不带 polyline：几何有几百个点，会把事件流撑大。
        # 前端保留已有几何，落库的路线由下一次 /routes/refresh 或详情加载补齐。
        legs = legs_payload(derive_legs(result.trip))
        for leg in legs:
            leg["polyline"] = None
        return {
            "version": result.trip.version,
            "ops": ops,
            "trip": result.trip.model_dump(mode="json"),
            "derived": result.derived.model_dump(mode="json"),
            "changed": result.changed,
            "diff": result.diff,
            "reason": reason,
            "route_legs": legs,
        }


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out
