"""来源登记簿（docs/new-plan 01 §4.2、§9.1、§11；02 §5）。

问题：`validator.hard_errors` 只检查 `source_ref` 是否非空 —— 模型随手编一个
`web:deadbeef` 也能过。方案：服务端记录**本趟行程真实发出过**的 source_ref，
写入时核对，对不上就拒绝或降级为「待核实」。

登记簿条目带 `agent` 字段，所以子 Agent 调工具发出的 ref 与主 Agent 的进同一份
登记簿，能看出是谁调用的（02 §5）。复合工具还会把结构化产物存进 `payload`，
模型只引用 ref，值由服务端回填（02 §3.2）。
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable

from app.db import Database
from app.schemas.sources import Evidence, SourceEntry
from app.schemas.tools import ToolOutcome

#: 不是「本次工具调用」产生的 ref：种子数据、离线高德坐标校正、用户手动加的地点。
#: 这些 ref 不经过工具，但它们是服务端自己写的，不能因为不在登记簿里就拒绝。
BUILTIN_REF_PREFIXES = ("poi:seed:", "poi:amap:", "poi:user:", "route:seed:", "web:seed:", "local:")


def is_builtin_ref(ref: str | None) -> bool:
    return bool(ref) and str(ref).startswith(BUILTIN_REF_PREFIXES)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def content_ref(prefix: str, payload: Any) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return f"{prefix}:{hashlib.sha1(raw.encode()).hexdigest()[:12]}"


def evidence_entries(
    evidence: Iterable[Evidence], *, tool: str, origin: str
) -> list[dict[str, Any]]:
    """证据 → 登记簿条目。没有 url 也没有 source_ref 的条目无法追溯，直接跳过。"""
    out: list[dict[str, Any]] = []
    fetched = now_iso()
    for item in evidence:
        ref = item.source_ref
        if not ref:
            continue
        out.append(
            {
                "source_ref": ref,
                "tool": tool,
                "origin": origin,
                "url": item.url,
                "title": item.title,
                "published_at": item.published_at,
                "snippet": (item.quote or "")[:600] or None,
                "fetched_at": fetched,
                "authority": item.authority,
            }
        )
    return out


class SourceRegistry:
    """登记簿的读写门面。进程内做一层缓存，避免每次写入都查库。"""

    def __init__(self, db: Database):
        self.db = db
        self._known: set[str] = set()
        self._loaded_trips: set[str | None] = set()

    # ------------------------------------------------------------------
    # write
    # ------------------------------------------------------------------
    async def record_outcome(
        self,
        outcome: ToolOutcome,
        *,
        trip_id: str | None = None,
        turn_id: str | None = None,
        agent: str = "main",
    ) -> None:
        """记录一次工具调用发出的所有 source_ref。"""
        if not outcome.ok:
            return
        data = outcome.data if isinstance(outcome.data, dict) else {}
        origin = str(data.get("source") or data.get("origin") or "tool")
        entries = evidence_entries(
            _evidence_of(data), tool=outcome.tool, origin=origin
        )
        fetched = now_iso()
        for ref in outcome.source_refs:
            if not ref or ref in {e["source_ref"] for e in entries}:
                continue
            entries.append(
                {
                    "source_ref": ref,
                    "tool": outcome.tool,
                    "origin": origin,
                    "url": _url_for_ref(data, ref),
                    "title": None,
                    "published_at": None,
                    "snippet": None,
                    "fetched_at": fetched,
                    "authority": data.get("authority"),
                }
            )
        # 复合工具的结构化产物回填用 payload：除了 value，还要带 status/evidence/authority，
        # 否则服务端回填营业时间时拿不到「是否已核实」。
        payload: dict[str, Any] | None = None
        if isinstance(data.get("value"), dict):
            payload = {
                **data["value"],
                "status": data.get("status"),
                "evidence": data.get("evidence") or [],
                "authority": data.get("authority"),
            }
        for entry in entries:
            entry["trip_id"] = trip_id
            entry["turn_id"] = turn_id
            entry["agent"] = agent
            if payload is not None:
                entry["payload"] = payload
        await self.record(entries)

    async def record(self, entries: list[dict[str, Any]]) -> None:
        if not entries:
            return
        clean: list[dict[str, Any]] = []
        for entry in entries:
            if not entry.get("source_ref"):
                continue
            normalized = SourceEntry.model_validate(
                {
                    "source_ref": entry["source_ref"],
                    "tool": entry.get("tool") or "unknown",
                    "origin": entry.get("origin") or "tool",
                    "url": entry.get("url"),
                    "title": entry.get("title"),
                    "published_at": entry.get("published_at"),
                    "snippet": entry.get("snippet"),
                    "fetched_at": entry.get("fetched_at") or now_iso(),
                    "authority": entry.get("authority"),
                    "turn_id": entry.get("turn_id"),
                    "agent": entry.get("agent") or "main",
                    "trip_id": entry.get("trip_id"),
                    "payload": entry.get("payload"),
                }
            )
            clean.append(normalized.model_dump(mode="json"))
            self._known.add(normalized.source_ref)
        await self.db.record_sources(clean)

    # ------------------------------------------------------------------
    # read
    # ------------------------------------------------------------------
    async def known(self, trip_id: str | None = None) -> set[str]:
        """已发出的 ref 集合。

        source_ref 是内容寻址的，登记簿回答的是「这个 ref 是不是工具真的发出过」，
        而不是「是不是本趟发出的」。所以按全局取：否则工具缓存命中（同一查询在另一趟
        用过）时，复用同一份结果反而会被判成伪造。
        """
        if None not in self._loaded_trips:
            try:
                self._known.update(await self.db.known_source_refs(None))
            except Exception:  # noqa: BLE001 - 登记簿不可用不该阻塞写入
                pass
            self._loaded_trips.add(None)
        return set(self._known)

    async def exists(self, trip_id: str | None, source_ref: str | None) -> bool:
        if not source_ref:
            return False
        if is_builtin_ref(source_ref) or source_ref in self._known:
            return True
        row = await self.db.get_source(source_ref)
        if row is not None:
            self._known.add(source_ref)
            return True
        return False

    async def entries(
        self, trip_id: str | None = None, tool: str | None = None
    ) -> list[dict[str, Any]]:
        try:
            return await self.db.list_sources(trip_id, tool)
        except Exception:  # noqa: BLE001
            return []

    async def has_tool(self, trip_id: str | None, tool: str) -> bool:
        return bool(await self.entries(trip_id, tool))

    async def opening_hours_payloads(self, trip_id: str | None = None) -> dict[str, dict[str, Any]]:
        """登记簿里所有营业时间结构化结果，按 source_ref 索引（02 §3.2 回填用）。"""
        out: dict[str, dict[str, Any]] = {}
        for row in await self.entries(trip_id, tool="opening_hours_lookup"):
            payload = row.get("payload")
            if isinstance(payload, dict):
                out[str(row.get("source_ref"))] = payload
        return out

    async def payload_of(self, source_ref: str, trip_id: str | None = None) -> dict[str, Any] | None:
        for row in await self.entries(trip_id):
            if row.get("source_ref") == source_ref and isinstance(row.get("payload"), dict):
                return row["payload"]
        row = await self.db.get_source(source_ref)
        payload = (row or {}).get("payload")
        return payload if isinstance(payload, dict) else None


def collect_trip_refs(trip: Any) -> set[str]:
    """收集一份 Trip 里已有的所有 source_ref。

    写入时把它并进「已知 ref」：补丁没碰过的旧数据不该因为登记簿里没有就整份被拒。
    """
    refs: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str) and value:
            refs.add(value)

    for _day, stop in trip.iter_stops():
        add(stop.poi.source_ref)
        oh = getattr(stop, "opening_hours", None)
        if oh is not None:
            for ref in getattr(oh, "source_refs", []) or []:
                add(ref)
    for _day, _stop, act in trip.iter_activities():
        for ref in act.source_refs:
            add(ref)
        ticket = act.ticket
        if ticket is not None:
            add(ticket.source_ref)
            if ticket.sale_rule is not None:
                add(ticket.sale_rule.source_ref)
            if ticket.limited_quota is not None:
                add(ticket.limited_quota.source_ref)
            for channel in ticket.channels:
                add(getattr(channel, "evidence_url", None))
    for ref in trip.constraints.must_go + trip.constraints.must_avoid:
        add(ref.source_ref)
        if ref.season_closure is not None:
            add(ref.season_closure.source_ref)
    for _day, _stop, act in trip.iter_activities():
        detail = act.transit_detail
        if detail is not None:
            add(getattr(detail, "source_ref", None))
            closure = getattr(detail, "season_closure", None)
            if closure is not None:
                add(closure.source_ref)
    vehicle = trip.constraints.vehicle
    if vehicle is not None:
        for permit in vehicle.permits:
            add(permit.source_ref)
    return {r for r in refs if r and not r.startswith("http")}


def _evidence_of(data: dict[str, Any]) -> list[Evidence]:
    raw = data.get("evidence")
    out: list[Evidence] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                try:
                    out.append(Evidence.model_validate(item))
                except Exception:  # noqa: BLE001 - 单条证据坏了不该丢整批
                    continue
    return out


def _url_for_ref(data: dict[str, Any], ref: str) -> str | None:
    if data.get("source_ref") == ref and isinstance(data.get("url"), str):
        return data["url"]
    for item in data.get("results") or []:
        if isinstance(item, dict) and item.get("source_ref") == ref:
            return item.get("url")
    return None
