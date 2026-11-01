"""字段级事实由代码并行补齐（docs/new-plan 02 §2.6 第 3 步）。

主 Agent 写出行程后，代码对行程里每个景点并行调用复合工具 —— 营业时间、票务、
封路 —— 再把**核实过的**结果回填进 Trip：

- `opening_hours_lookup` → `stop.opening_hours`（模型只引用 ref 的那套规则在这里由
  服务端自己执行，所以直接把结构化结果写进去）；
- `ticket_channel_lookup` → 该景点的 `ticket`（价格、渠道、开售规则，只有
  `status=verified` 才写权威字段；只有线索的渠道降级为 clue）；
- `closure_notice_lookup` → 自驾长途段的 `season_closure`（只有 verified 才写）。

没有检索 Key、或额度用完时直接返回空结果：不编造、不占预算。补出来的写入走
`PlanService.update`，因此和其它写入一样过校验器、进来源登记簿、推 PLAN_PATCH。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from app.config import Settings
from app.schemas.plan import (
    Activity,
    ActivityType,
    Stop,
    Ticket,
    TicketKind,
    Trip,
)
from app.schemas.sources import EvidenceStatus
from app.tools.registry import ToolRegistry


@dataclass
class EnrichmentResult:
    ok: bool = False
    ops: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    called: int = 0


class FactEnricher:
    def __init__(self, settings: Settings, registry: ToolRegistry):
        self.settings = settings
        self.registry = registry

    @property
    def available(self) -> bool:
        return bool(self.settings.fact_enrichment_enabled) and self.registry.retriever.configured

    async def plan_ops(
        self, trip: Trip, *, trip_id: str | None, turn_id: str | None
    ) -> EnrichmentResult:
        if not self.available:
            return EnrichmentResult()
        targets = self._targets(trip)[: max(0, self.settings.fact_enrichment_max_calls)]
        if not targets:
            return EnrichmentResult()

        semaphore = asyncio.Semaphore(3)

        async def run(kind: str, stop: Stop, activity: Activity | None):
            async with semaphore:
                return await self._lookup(kind, stop, activity, trip_id=trip_id, turn_id=turn_id)

        outcomes = await asyncio.gather(
            *[run(kind, stop, act) for kind, stop, act in targets], return_exceptions=True
        )
        result = EnrichmentResult()
        for outcome in outcomes:
            if isinstance(outcome, BaseException) or outcome is None:
                continue
            ops, note = outcome
            result.called += 1
            if ops:
                result.ops.extend(ops)
            if note:
                result.notes.append(note)
        result.ok = bool(result.ops)
        return result

    # ------------------------------------------------------------------
    def _targets(self, trip: Trip) -> list[tuple[str, Stop, Activity | None]]:
        # 按类别轮转，避免 8 个景点的营业时间把票务/封路的名额全吃掉
        buckets: dict[str, list[tuple[str, Stop, Activity | None]]] = {
            "opening_hours": [],
            "ticket": [],
            "closure": [],
        }
        for _day, stop in trip.iter_stops():
            visits = [a for a in stop.activities if a.type == ActivityType.VISIT]
            if not visits:
                continue
            if stop.opening_hours is None:
                buckets["opening_hours"].append(("opening_hours", stop, None))
            if any(self._needs_ticket(a) for a in visits):
                buckets["ticket"].append(
                    ("ticket", stop, next(a for a in visits if self._needs_ticket(a)))
                )
        # 自驾长途段缺封路证据
        for _day, _stop, act in trip.iter_activities():
            detail = act.transit_detail
            if detail is None:
                continue
            mode = getattr(detail, "mode", None)
            mode = mode.value if hasattr(mode, "value") else mode
            if mode != "self_drive" or getattr(detail, "season_closure", None) is not None:
                continue
            road = next(iter(getattr(detail, "road_refs", []) or []), None)
            if road:
                buckets["closure"].append(("closure", _stop, act))

        ordered: list[tuple[str, Stop, Activity | None]] = []
        while any(buckets.values()):
            for kind in ("opening_hours", "ticket", "closure"):
                if buckets[kind]:
                    ordered.append(buckets[kind].pop(0))
        return ordered

    @staticmethod
    def _needs_ticket(act: Activity) -> bool:
        ticket = act.ticket
        if ticket is None:
            return True
        return not ticket.channels and ticket.price_range is None

    async def _lookup(
        self,
        kind: str,
        stop: Stop,
        activity: Activity | None,
        *,
        trip_id: str | None,
        turn_id: str | None,
    ) -> tuple[list[dict[str, Any]], str | None] | None:
        if kind == "opening_hours":
            outcome = await self.registry.execute(
                "opening_hours_lookup",
                {
                    "poi": stop.poi.name,
                    "city": stop.poi.city,
                    "amap_poi_id": stop.poi.amap_poi_id,
                },
                "real",
                trip_id=trip_id,
                turn_id=turn_id,
                agent="enricher",
            )
            if not outcome.ok or not outcome.source_refs:
                return None
            status = (outcome.data or {}).get("status")
            if status not in {EvidenceStatus.VERIFIED.value, EvidenceStatus.CLUE.value}:
                return [], f"「{stop.poi.name}」营业时间没有可核实来源"
            ref = outcome.source_refs[0]
            return (
                [
                    {
                        "op": "update_stop",
                        "stop_id": stop.stop_id,
                        "patch": {"opening_hours": {"source_refs": [ref]}},
                    }
                ],
                f"「{stop.poi.name}」营业时间（{status}）",
            )

        if kind == "ticket" and activity is not None:
            outcome = await self.registry.execute(
                "ticket_channel_lookup",
                {"poi": stop.poi.name, "city": stop.poi.city},
                "real",
                trip_id=trip_id,
                turn_id=turn_id,
                agent="enricher",
            )
            if not outcome.ok or not outcome.source_refs:
                return None
            data = outcome.data or {}
            ticket = self._ticket_from(data, outcome.source_refs[0])
            if ticket is None:
                return [], f"「{stop.poi.name}」票务信息没有可核实来源"
            note = "已核实" if data.get("status") == EvidenceStatus.VERIFIED.value else "仅有线索"
            return (
                [
                    {
                        "op": "update_activity",
                        "activity_id": activity.activity_id,
                        "patch": {"ticket": ticket},
                    }
                ],
                f"「{activity.title}」票务渠道（{note}）",
            )

        if kind == "closure" and activity is not None:
            road = next(iter(getattr(activity.transit_detail, "road_refs", []) or []), None)
            if not road:
                return None
            outcome = await self.registry.execute(
                "closure_notice_lookup",
                {"target": road},
                "real",
                trip_id=trip_id,
                turn_id=turn_id,
                agent="enricher",
            )
            if not outcome.ok or not outcome.source_refs:
                return None
            closure = self._closure_from(outcome.data or {}, outcome.source_refs[0])
            if closure is None:
                return [], f"「{road}」封路公告没有可核实来源"
            return (
                [
                    {
                        "op": "update_activity",
                        "activity_id": activity.activity_id,
                        "patch": {"transit_detail": {**activity.transit_detail.model_dump(mode="json"), "season_closure": closure}},
                    }
                ],
                f"「{road}」封路窗口",
            )
        return None

    @staticmethod
    def _ticket_from(data: dict[str, Any], ref: str) -> dict[str, Any] | None:
        value = data.get("value") or {}
        verified = data.get("status") == EvidenceStatus.VERIFIED.value
        channels = []
        for channel in value.get("channels") or []:
            if not isinstance(channel, dict) or not channel.get("name"):
                continue
            channels.append(
                {
                    "name": channel["name"],
                    "type": channel.get("type") or "ota",
                    "detail": channel.get("name"),
                    "note": channel.get("how_to_find"),
                    "official": channel.get("official"),
                    "status": channel.get("status") or ("clue" if not verified else "unverified"),
                    "evidence_url": channel.get("evidence_url"),
                    "how_to_find": channel.get("how_to_find"),
                    "source_ref": ref,
                }
            )
        sale_rule = value.get("sale_rule") if verified else None
        if not channels and not verified:
            return None
        ticket: dict[str, Any] = {
            "kind": TicketKind.ATTRACTION.value,
            "channels": channels,
            "source_ref": ref,
        }
        if verified:
            ticket.update(
                {
                    "price_range": value.get("price_range"),
                    "currency": value.get("currency") or "CNY",
                    "lead_time_days": value.get("lead_time_days"),
                    "real_name_required": bool(value.get("real_name_required")),
                }
            )
            if sale_rule:
                ticket["sale_rule"] = {**sale_rule, "source_ref": ref}
            quota = value.get("limited_quota")
            if isinstance(quota, dict) and quota.get("quote"):
                ticket["limited_quota"] = {"quote": quota["quote"], "source_ref": ref}
        ticket["note"] = (
            "来自官方核实" if verified else "来自检索线索，未经官方核实，请核对账号认证主体"
        )
        return Ticket.model_validate(ticket).model_dump(mode="json")

    @staticmethod
    def _closure_from(data: dict[str, Any], ref: str) -> dict[str, Any] | None:
        if data.get("status") != EvidenceStatus.VERIFIED.value:
            return None
        closures = (data.get("value") or {}).get("closures") or []
        item = next((c for c in closures if isinstance(c, dict)), None)
        if item is None:
            return None
        if not item.get("open_from") and not item.get("open_to"):
            return None
        return {
            "open_from": item.get("open_from"),
            "open_to": item.get("open_to"),
            "note": item.get("note"),
            "source_ref": ref,
        }
