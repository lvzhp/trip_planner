"""Assistant message → segments（mindtrip/06 §1.3）。

模型在正文里写占位符，**服务端**序列化成 segments，前端不做正则猜地点：

    [[poi:<stop_id 或 amap_poi_id>]]             → {"type": "place", ...}
    [[poi:<id>|<显示名>]]                        → 允许带名字，用于已删除/无坐标的点
    [[route:<from_stop_id>:<to_stop_id>:<mode>]] → {"type": "route", ...}

兜底：老消息（以及模型忘了写占位符的回复）里的已知地点名会被**服务端**识别成
place segment —— 链接化是服务端行为，前端只渲染。最多 20 个地点 chip，超出部分
折成「还有 N 个地点」，避免正文刷屏（§1.5）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from app.schemas.plan import ActivityType, Stop, Trip

TOKEN_RE = re.compile(r"\[\[(poi|route):([^\]]+)\]\]")
MAX_PLACES = 20

@dataclass(frozen=True)
class _StopRef:
    stop: Stop
    day_index: int

    @property
    def category(self) -> str:
        """按第一个活动判断（与 PlaceService 的同名规则保持一致）。"""
        kinds = {act.type.value for act in self.stop.activities}
        for kind, category in (
            (ActivityType.VISIT.value, "sight"),
            (ActivityType.MEAL.value, "meal"),
            (ActivityType.STAY.value, "stay"),
            (ActivityType.LONG_TRANSIT.value, "transit"),
        ):
            if kind in kinds:
                return category
        return "place"


def _index(trip: Trip | None) -> tuple[dict[str, _StopRef], dict[str, _StopRef]]:
    by_id: dict[str, _StopRef] = {}
    by_amap: dict[str, _StopRef] = {}
    if trip is None:
        return by_id, by_amap
    for day in trip.days:
        for stop in day.stops:
            ref = _StopRef(stop=stop, day_index=day.day_index)
            by_id[stop.stop_id] = ref
            if stop.poi.amap_poi_id:
                by_amap[stop.poi.amap_poi_id] = ref
    return by_id, by_amap


def _resolve(raw: str, by_id: dict[str, _StopRef], by_amap: dict[str, _StopRef]) -> _StopRef | None:
    key = raw.strip()
    return by_id.get(key) or by_amap.get(key)


def place_segment(ref: _StopRef, display_name: str | None = None) -> dict[str, Any]:
    poi = ref.stop.poi
    name = display_name or (poi.name.split(" · ")[-1] if poi.name else "未命名地点")
    return {
        "type": "place",
        "poiId": ref.stop.stop_id,
        "stopId": ref.stop.stop_id,
        "name": name,
        "fullName": poi.name,
        "category": ref.category,
        "added": True,
        "hasCoords": poi.lng is not None and poi.lat is not None,
        "city": poi.city,
        "address": poi.address,
        "lat": poi.lat,
        "lng": poi.lng,
        "dayIndex": ref.day_index,
    }


def _missing_segment(poi_id: str, name: str) -> dict[str, Any]:
    """占位符引用了已不存在（或本行程之外）的地点：灰色 chip，不静默丢弃。"""
    return {
        "type": "place",
        "poiId": poi_id,
        "stopId": None,
        "name": name,
        "fullName": name,
        "category": "unknown",
        "added": False,
        "hasCoords": False,
        "missing": True,
        "city": None,
        "address": None,
        "lat": None,
        "lng": None,
        "dayIndex": None,
    }


def _route_segment(
    from_id: str,
    to_id: str,
    mode: str,
    by_id: dict[str, _StopRef],
    by_amap: dict[str, _StopRef],
) -> dict[str, Any] | None:
    a = _resolve(from_id, by_id, by_amap)
    b = _resolve(to_id, by_id, by_amap)
    if a is None or b is None:
        return None
    transit = None
    for act in b.stop.activities:
        if act.transit_from_prev is not None:
            transit = act.transit_from_prev
            break
    distance_km = transit.distance_km if transit else None
    minutes = transit.minutes if transit else None
    return {
        "type": "route",
        "fromPoiId": a.stop.stop_id,
        "toPoiId": b.stop.stop_id,
        "fromName": a.stop.poi.name.split(" · ")[-1],
        "toName": b.stop.poi.name.split(" · ")[-1],
        "mode": mode or (transit.mode.value if transit else "drive"),
        "distanceM": int(round(distance_km * 1000)) if distance_km else None,
        "durationMin": int(minutes) if minutes else None,
    }


def _known_names(trip: Trip | None) -> list[tuple[str, _StopRef]]:
    """用于兜底链接化的地点名（长名优先，避免「禾木」吃掉「禾木村」）。"""
    if trip is None:
        return []
    pairs: list[tuple[str, _StopRef]] = []
    seen: set[str] = set()
    for day in trip.days:
        for stop in day.stops:
            ref = _StopRef(stop=stop, day_index=day.day_index)
            full = stop.poi.name or ""
            parts = [part.strip() for part in full.split(" · ") if part.strip()]
            candidates = list(parts)
            city = (stop.poi.city or "").strip()
            # 「禾木村 · 日落观景」也允许命中「禾木村」；但「乌鲁木齐 · 新疆国际大巴扎」
            # 不允许把城市名本身当成地点 chip（会误伤所有提到城市的句子）。
            if len(parts) >= 2 and city and parts[0] not in city and city not in parts[0]:
                candidates.append(parts[0])
            for name in candidates:
                if len(name) < 2 or name in seen:
                    continue
                if name in {"午餐", "晚餐", "早餐", "住宿", "自由活动"}:
                    continue
                seen.add(name)
                pairs.append((name, ref))
    pairs.sort(key=lambda item: len(item[0]), reverse=True)
    return pairs


def _linkify(text: str, trip: Trip | None, budget: int) -> tuple[list[dict[str, Any]], int]:
    """在纯文本里把已知地点名换成 place segment，返回 (segments, 用掉的名额)。"""
    names = _known_names(trip)
    if not names or budget <= 0:
        return ([{"type": "text", "text": text}] if text else []), 0
    slots: list[tuple[str, _StopRef]] = []
    working = text
    for name, ref in names:
        if len(slots) >= budget:
            break
        idx = working.find(name)
        if idx < 0:
            continue
        token = f"\u0000{len(slots)}\u0000"
        working = working.replace(name, token, 1)
        slots.append((token, ref))
    if not slots:
        return ([{"type": "text", "text": text}] if text else []), 0
    out: list[dict[str, Any]] = []
    cursor = 0
    while cursor < len(working):
        nxt = None
        nxt_at = len(working)
        for token, _ref in slots:
            at = working.find(token, cursor)
            if 0 <= at < nxt_at:
                nxt, nxt_at = token, at
        if nxt is None:
            if cursor < len(working):
                out.append({"type": "text", "text": working[cursor:]})
            break
        if nxt_at > cursor:
            out.append({"type": "text", "text": working[cursor:nxt_at]})
        ref = next(r for t, r in slots if t == nxt)
        matched = next(name for name, r in names if r == ref and name in text)
        out.append(place_segment(ref, matched))
        cursor = nxt_at + len(nxt)
    return [seg for seg in out if not (seg.get("type") == "text" and not str(seg.get("text", "")).strip())], len(slots)


def build_segments(text: str, trip: Trip | None) -> tuple[list[dict[str, Any]], str]:
    """把一条 assistant 正文序列化成 segments，并返回给旧客户端用的纯文本。

    纯文本里占位符被替换成可读内容（地点名 / `A → B`），所以老消息、老客户端、
    以及模型上下文的历史消息都不会看到 `[[poi:...]]` 这种脏标记。
    """
    raw = text or ""
    by_id, by_amap = _index(trip)
    segments: list[dict[str, Any]] = []
    plain_parts: list[str] = []
    used = 0
    skipped = 0
    cursor = 0

    for match in TOKEN_RE.finditer(raw):
        before = raw[cursor : match.start()]
        if before:
            # 文本段先做兜底链接化（名额与显式占位符共享 20 个上限）
            chunks, spent = _linkify(before, trip, MAX_PLACES - used)
            used += spent
            segments.extend(chunks)
            plain_parts.append(before)
        cursor = match.end()
        kind = match.group(1)
        body = match.group(2)
        if kind == "route":
            parts = body.split(":")
            if len(parts) == 3:
                seg = _route_segment(parts[0], parts[1], parts[2], by_id, by_amap)
                if seg is not None:
                    segments.append(seg)
                    plain_parts.append(f"{seg['fromName']} → {seg['toName']}")
                    continue
            continue
        # place
        ident, _, label = body.partition("|")
        ref = _resolve(ident, by_id, by_amap)
        if ref is None:
            name = label.strip()
            if not name:
                # 无法解析又没有名字：宁可丢掉标记，也不把内部 id 暴露到正文
                continue
            if used >= MAX_PLACES:
                skipped += 1
                plain_parts.append(name)
                continue
            segments.append(_missing_segment(ident.strip(), name))
            plain_parts.append(name)
            used += 1
            continue
        if used >= MAX_PLACES:
            skipped += 1
            plain_parts.append(ref.stop.poi.name.split(" · ")[-1])
            continue
        segments.append(place_segment(ref))
        plain_parts.append(ref.stop.poi.name.split(" · ")[-1])
        used += 1

    tail = raw[cursor:]
    if tail:
        chunks, spent = _linkify(tail, trip, MAX_PLACES - used)
        used += spent
        segments.extend(chunks)
        plain_parts.append(tail)

    if skipped:
        note = f"还有 {skipped} 个地点，可在地图上查看。"
        segments.append({"type": "text", "text": note})
        plain_parts.append(note)

    if not segments:
        segments = [{"type": "text", "text": raw}]
    # 合并相邻 text，减少前端渲染节点
    merged: list[dict[str, Any]] = []
    for seg in segments:
        if seg["type"] == "text" and merged and merged[-1]["type"] == "text":
            merged[-1]["text"] = f"{merged[-1]['text']}{seg['text']}"
        else:
            merged.append(seg)
    keep = [seg for seg in merged if not (seg["type"] == "text" and not seg["text"].strip())]
    return (keep or [{"type": "text", "text": raw}]), "".join(plain_parts) or raw


def attach_segments(payload: dict[str, Any], trip: Trip | None) -> dict[str, Any]:
    """给 assistant message payload 补 `segments`（就地返回新 dict，不改原事件）。"""
    if not isinstance(payload, dict):
        return payload
    if payload.get("role") != "assistant" or payload.get("hidden"):
        return payload
    text = payload.get("text") or ""
    if not text:
        return payload
    segments, plain = build_segments(text, trip)
    out = dict(payload)
    out["text"] = plain
    out["segments"] = segments
    return out


def place_segments(segments: Iterable[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [seg for seg in (segments or []) if isinstance(seg, dict) and seg.get("type") == "place"]
