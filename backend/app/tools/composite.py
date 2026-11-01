"""复合时效事实工具（docs/new-plan 01 §4.2、§5、§7、§8；02 §3）。

统一流程：DeepSeek 搜索 + Tavily 并行检索 → 便宜模型按固定 schema 抽取 →
交叉核对 → 对外返回 `{value, evidence[], authority, conflict, status, source_refs}`。

三条硬规则：

1. 没有一个高权威来源（DeepSeek `authority ≥ 3` 或官方域名）时，权威字段留空，
   状态降为 `clue`，卡片显示「待核实」；
2. 两源冲突时字段留空、状态 `conflict`，同时保留两边证据给卡片展示；
3. 抽取失败也只是降级为 `clue`/`unverified`，绝不拿模型记忆补写事实。
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.config import Settings
from app.llm.structured import extract_structured
from app.schemas.opening_hours import (
    OpeningHours,
    OpeningPeriod,
    SeasonalOpening,
    hm_to_minutes,
)
from app.schemas.plan import ChannelStatus, ChannelType, SaleMode
from app.schemas.sources import Evidence, EvidenceStatus, SourceType
from app.services.source_registry import content_ref
from app.tools.amap import AmapClient, AmapError
from app.tools.deepseek_search import (
    DeepSeekSearchClient,
    DeepSeekSearchError,
    SearchHit,
    is_official_url,
    source_type_of,
)
from app.tools.tavily import TavilyClient


# --------------------------------------------------------------------------
# 检索
# --------------------------------------------------------------------------


@dataclass
class Retrieval:
    hits: list[SearchHit] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)

    @property
    def urls(self) -> list[str]:
        return [h.url for h in self.hits if h.url]

    def max_authority(self) -> int | None:
        values = [h.authority for h in self.hits if h.authority is not None]
        return max(values) if values else None

    def official(self) -> list[SearchHit]:
        return [h for h in self.hits if is_official_url(h.url)]

    def verified(self) -> bool:
        """01 §4.2：官方域名页面，或 DeepSeek authority ≥ 3。"""
        authority = self.max_authority()
        return bool(self.official()) or (authority is not None and authority >= 3)


class Retriever:
    """两个检索源并行。单个源失败不影响另一个（错误只记录，不抛）。"""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.deepseek = DeepSeekSearchClient(settings)
        self.tavily = TavilyClient(settings)

    @property
    def configured(self) -> bool:
        return self.deepseek.configured or self.tavily.configured

    async def gather(
        self, queries: list[str], *, count: int = 5, need_content: bool = False
    ) -> Retrieval:
        results: Retrieval = Retrieval()
        tasks = []
        labels: list[str] = []
        tavily_queries = 0
        for query in queries:
            if self.deepseek.configured:
                tasks.append(self.deepseek.search(query, count, need_content))
                labels.append(f"deepseek:{query}")
            # Tavily 每条结果都贵，只补前两个 query 做交叉核对
            if self.tavily.configured and tavily_queries < 2:
                tavily_queries += 1
                tasks.append(self._tavily(query))
                labels.append(f"tavily:{query}")
        if not tasks:
            raise CompositeUnavailable(
                "not_configured",
                "多源检索未配置：请在「接入配置」里填写 DeepSeek 或 Tavily 的 API Key",
            )
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        for label, outcome in zip(labels, outcomes):
            provider = label.split(":", 1)[0]
            if isinstance(outcome, BaseException):
                results.errors.append(f"{label} 失败：{outcome}")
                continue
            if provider not in results.providers:
                results.providers.append(provider)
            results.hits.extend(outcome)
        return results

    async def _tavily(self, query: str) -> list[SearchHit]:
        result = await self.tavily.search(query, 3)
        return [
            SearchHit(
                provider="tavily",
                title=item.title,
                url=item.url,
                snippet=item.content,
                summary=item.content,
                source_type=source_type_of(item.url),
                source_ref=result.source_ref,
            )
            for item in result.results
        ]


class CompositeUnavailable(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


# --------------------------------------------------------------------------
# 证据与状态
# --------------------------------------------------------------------------


def evidence_of(retrieval: Retrieval, limit: int = 6) -> list[Evidence]:
    out: list[Evidence] = []
    seen: set[str] = set()
    for hit in retrieval.hits:
        if not hit.url or hit.url in seen:
            continue
        seen.add(hit.url)
        out.append(
            Evidence(
                url=hit.url,
                title=hit.title or None,
                published_at=hit.published_at,
                quote=hit.text(400) or None,
                source_type=hit.source_type,
                source_ref=hit.source_ref,
                authority=hit.authority,
            )
        )
        if len(out) >= limit:
            break
    return out


def status_of(retrieval: Retrieval, *, has_value: bool, conflict: bool) -> EvidenceStatus:
    if conflict:
        return EvidenceStatus.CONFLICT
    if not retrieval.hits:
        return EvidenceStatus.UNVERIFIED
    if has_value and retrieval.verified():
        return EvidenceStatus.VERIFIED
    return EvidenceStatus.CLUE


def _finalize(
    name: str,
    retrieval: Retrieval,
    value: dict[str, Any],
    status: EvidenceStatus,
    *,
    conflict: bool = False,
) -> dict[str, Any]:
    evidence = evidence_of(retrieval)
    ref = content_ref(f"tool:{name}", {"value": value, "urls": retrieval.urls[:8]})
    composite_ref = Evidence(
        url=retrieval.urls[0] if retrieval.urls else None,
        title=f"{name} 结构化结果",
        source_type=SourceType.OFFICIAL if retrieval.verified() else SourceType.OTHER,
        source_ref=ref,
        authority=retrieval.max_authority(),
    )
    evidence = [composite_ref, *evidence]
    return {
        "value": value,
        "evidence": [e.model_dump(mode="json") for e in evidence],
        "authority": retrieval.max_authority(),
        "conflict": conflict,
        "status": status.value,
        "source_refs": [ref, *[e.source_ref for e in evidence[1:] if e.source_ref]],
        "providers": retrieval.providers,
        "retrieval_errors": retrieval.errors,
    }


#: 公开别名：social_digest 等外部模块复用同一套「统一返回」骨架。
finalize_result = _finalize


# --------------------------------------------------------------------------
# 抽取模型的公共部分
# --------------------------------------------------------------------------


class ChannelValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    type: ChannelType = ChannelType.OTA
    official: bool | None = None
    how_to_find: str | None = None
    evidence_url: str | None = None
    status: ChannelStatus = ChannelStatus.UNVERIFIED


class SaleRuleValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: SaleMode = SaleMode.ONSITE_ONLY
    advance_days: int | None = None
    release_time: str | None = None
    fixed_date: str | None = None


EXTRACT_SYSTEM = """你是结构化事实抽取器。只根据 <资料> 里的原文抽取，禁止使用你自己的先验知识补全；
资料里没有的字段一律填 null。输出单个 JSON 对象，不要 markdown 代码块，不要解释。
如果资料之间互相矛盾，把 conflict 设为 true 并在 conflict_note 里写明矛盾点。"""


def _sources_block(retrieval: Retrieval, limit: int = 8) -> str:
    lines: list[str] = []
    for index, hit in enumerate(retrieval.hits[:limit], start=1):
        authority = f" authority={hit.authority}" if hit.authority is not None else ""
        date = f" date={hit.published_at}" if hit.published_at else ""
        lines.append(
            f"[{index}] {hit.title or '(无标题)'}\nurl: {hit.url or '(无)'}{authority}{date}\n"
            f"{hit.text(700)}"
        )
    return "\n\n".join(lines) or "（没有检索到资料）"


async def _extract(settings: Settings, system_hint: str, user: str, schema):
    return await extract_structured(
        settings,
        system=EXTRACT_SYSTEM,
        user=f"{system_hint}\n\n<资料>\n{user}\n</资料>\n\n只输出 JSON 对象。",
        schema=schema,
        model=settings.subagent_model or settings.default_model,
    )


def _gate_channels(channels: list[ChannelValue], verified: bool) -> list[ChannelValue]:
    out: list[ChannelValue] = []
    for channel in channels:
        item = channel.model_copy(deep=True)
        if verified and item.official:
            item.status = ChannelStatus.VERIFIED
        elif item.status == ChannelStatus.VERIFIED and not verified:
            item.status = ChannelStatus.CLUE
        elif item.status == ChannelStatus.UNVERIFIED and item.evidence_url:
            item.status = ChannelStatus.CLUE
        out.append(item)
    return out


# --------------------------------------------------------------------------
# 门票与购买渠道（01 §5）
# --------------------------------------------------------------------------


class TicketExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    price_range: list[float] | None = None
    currency: str = "CNY"
    lead_time_days: int | None = None
    real_name_required: bool | None = None
    reservation_required: bool | None = None
    channels: list[ChannelValue] = Field(default_factory=list)
    sale_rule: SaleRuleValue | None = None
    limited_quota_quote: str | None = None
    note: str | None = None


async def ticket_channel_lookup(
    settings: Settings,
    retriever: Retriever,
    *,
    poi: str,
    city: str | None = None,
) -> dict[str, Any]:
    where = f"{city} " if city else ""
    queries = [
        f"{where}{poi} 门票 购票渠道 微信公众号 小程序 开售时间",
        f"{where}{poi} 门票 预约 限流 售罄 公告",
        # 01 §5.4：优先用 site: 锁定景区官网与文旅局公告里的购票须知
        f"{poi} 门票 购票须知 site:gov.cn",
    ]
    retrieval = await retriever.gather(queries, count=5, need_content=False)
    hint = (
        "请抽取该景点的票务信息。字段：price_range（[最低价,最高价] 数字，仅成人票）、"
        "currency、lead_time_days（需提前几天订）、real_name_required（是否实名）、"
        "reservation_required（是否必须预约）、channels（购票渠道数组，每项含 name 公众号或小程序全名、"
        "type ∈ wechat_mp/mini_program/app/web/ota/onsite、official 是否景区官方、how_to_find 操作路径、"
        "evidence_url 出处链接、status ∈ verified/clue/unverified）、"
        "sale_rule（mode ∈ advance_days_at_time/fixed_date/rolling_daily/lottery_or_reservation/onsite_only、"
        "advance_days、release_time HH:MM、fixed_date YYYY-MM-DD）、"
        "limited_quota_quote（限流或售罄公告原文引文，没有就 null）、note。"
    )
    extraction = await _extract(settings, hint + f"\n目标景点：{poi}", _sources_block(retrieval), TicketExtraction)
    if extraction is None:
        return _finalize(
            "ticket_channel_lookup",
            retrieval,
            {"channels": [], "note": "检索结果无法结构化为票务事实，字段留空待核实"},
            status_of(retrieval, has_value=False, conflict=False),
        )

    verified = retrieval.verified() and not extraction.conflict
    channels = _gate_channels(extraction.channels, verified)
    value: dict[str, Any] = {
        "price_range": extraction.price_range if verified else None,
        "currency": extraction.currency if verified else None,
        "lead_time_days": extraction.lead_time_days if verified else None,
        "real_name_required": extraction.real_name_required if verified else None,
        "reservation_required": extraction.reservation_required if verified else None,
        "channels": [c.model_dump(mode="json") for c in channels],
        "sale_rule": (
            extraction.sale_rule.model_dump(mode="json")
            if verified and extraction.sale_rule is not None
            else None
        ),
        "limited_quota": (
            {"quote": extraction.limited_quota_quote}
            if verified and extraction.limited_quota_quote
            else None
        ),
        "note": extraction.note or extraction.conflict_note,
    }
    has_value = bool(channels or value["price_range"] or value["sale_rule"])
    status = status_of(retrieval, has_value=has_value, conflict=extraction.conflict)
    return _finalize("ticket_channel_lookup", retrieval, value, status, conflict=extraction.conflict)


# --------------------------------------------------------------------------
# 封路与季节开放（01 §3、§9）
# --------------------------------------------------------------------------


class ClosureItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: str
    open_from: str | None = None
    open_to: str | None = None
    closed: bool | None = None
    note: str | None = None
    evidence_url: str | None = None


class ClosureExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    closures: list[ClosureItem] = Field(default_factory=list)


_MONTH_DAY = re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?")


def normalize_month_day(raw: str | None) -> str | None:
    """把「6月上旬」「10月15日」之类统一成 MM-DD；做不到就返回 None。"""
    if not raw:
        return None
    text = str(raw).strip()
    match = _MONTH_DAY.search(text)
    if match:
        month, day = int(match.group(1)), int(match.group(2))
        if 1 <= month <= 12 and 1 <= day <= 31:
            return f"{month:02d}-{day:02d}"
    iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", text)
    if iso:
        return f"{iso.group(2)}-{iso.group(3)}"
    mmdd = re.match(r"^(\d{1,2})-(\d{1,2})$", text)
    if mmdd:
        return f"{int(mmdd.group(1)):02d}-{int(mmdd.group(2)):02d}"
    return None


async def closure_notice_lookup(
    settings: Settings,
    retriever: Retriever,
    *,
    target: str,
    date_range: str | None = None,
) -> dict[str, Any]:
    window = f" {date_range}" if date_range else ""
    queries = [
        f"{target} 封路 开放时间 公告{window}".strip(),
        f"{target} 季节性封闭 通行 管制 通知",
        f"{target} 开放时间 通行 公告 site:gov.cn",
    ]
    retrieval = await retriever.gather(queries, count=5)
    hint = (
        "请抽取该路段/景区的封路与季节开放信息。字段：closures 数组，每项含 "
        "target 路段或景区名、open_from 开放起始（MM-DD）、open_to 开放结束（MM-DD）、"
        "closed 是否当前封闭（true/false/null）、note 说明、evidence_url 出处。"
        "资料里没写具体日期就填 null，不要推测。"
    )
    extraction = await _extract(settings, hint + f"\n目标：{target}", _sources_block(retrieval), ClosureExtraction)
    if extraction is None:
        return _finalize(
            "closure_notice_lookup",
            retrieval,
            {"closures": [], "note": "检索结果无法结构化，封路信息待核实"},
            status_of(retrieval, has_value=False, conflict=False),
        )
    verified = retrieval.verified() and not extraction.conflict
    closures = [
        {
            "target": item.target,
            "open_from": normalize_month_day(item.open_from),
            "open_to": normalize_month_day(item.open_to),
            "closed": item.closed,
            "note": item.note,
            "evidence_url": item.evidence_url,
        }
        for item in extraction.closures
    ]
    value = {
        "closures": closures if verified else [],
        "note": extraction.conflict_note
        or (None if verified else "没有高权威来源，封路信息待核实"),
    }
    status = status_of(retrieval, has_value=bool(closures), conflict=extraction.conflict)
    return _finalize("closure_notice_lookup", retrieval, value, status, conflict=extraction.conflict)


# --------------------------------------------------------------------------
# 边防证 / 车辆准入（01 §3）
# --------------------------------------------------------------------------


class PermitItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    where_to_apply: str | None = None
    lead_time_days: int | None = None
    applies_to: list[str] = Field(default_factory=list)
    evidence_url: str | None = None


class PermitExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    permits: list[PermitItem] = Field(default_factory=list)


async def permit_policy_lookup(
    settings: Settings, retriever: Retriever, *, region: str
) -> dict[str, Any]:
    queries = [
        f"{region} 边防证 边境管理区 通行证 办理",
        f"{region} 自驾 车辆 准入 管制 通行证",
    ]
    retrieval = await retriever.gather(queries, count=5)
    hint = (
        "请抽取该地区的证件与准入要求。字段：permits 数组，每项含 name 证件名、"
        "where_to_apply 办理地点/方式、lead_time_days 需提前几天、applies_to 适用目的地数组、"
        "evidence_url 出处。没有明确政策就返回空数组。"
    )
    extraction = await _extract(settings, hint + f"\n地区：{region}", _sources_block(retrieval), PermitExtraction)
    if extraction is None:
        return _finalize(
            "permit_policy_lookup",
            retrieval,
            {"permits": [], "note": "检索结果无法结构化，准入政策待核实"},
            status_of(retrieval, has_value=False, conflict=False),
        )
    verified = retrieval.verified() and not extraction.conflict
    permits = [item.model_dump(mode="json") for item in extraction.permits] if verified else []
    status = status_of(retrieval, has_value=bool(permits), conflict=extraction.conflict)
    return _finalize(
        "permit_policy_lookup",
        retrieval,
        {"permits": permits, "note": extraction.conflict_note if not verified else None},
        status,
        conflict=extraction.conflict,
    )


# --------------------------------------------------------------------------
# 交通购买渠道（01 §7）
# --------------------------------------------------------------------------


class TransportExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    channels: list[ChannelValue] = Field(default_factory=list)
    lead_time_days: int | None = None
    duration_hint: str | None = None
    flight_no: str | None = None
    train_no: str | None = None
    dep_time: str | None = None
    arr_time: str | None = None
    note: str | None = None


async def transport_info_lookup(
    settings: Settings,
    retriever: Retriever,
    *,
    from_poi: str,
    to_poi: str,
    date_value: str | None = None,
    mode: str = "flight",
) -> dict[str, Any]:
    mode_label = {"flight": "航班", "train": "火车", "self_drive": "自驾"}.get(mode, mode)
    when = f" {date_value}" if date_value else ""
    queries = [
        f"{from_poi} 到 {to_poi}{when} {mode_label} 购票 渠道 提前预订",
        f"{from_poi} 到 {to_poi} {mode_label} 时长 班次",
    ]
    retrieval = await retriever.gather(queries, count=5)
    hint = (
        "请抽取该段交通的**购买渠道**与预订要求（v1 只给渠道，不给班次）。字段："
        "channels 数组（name 渠道名、type ∈ app/web/ota/wechat_mp/mini_program/onsite、"
        "official 是否官方、how_to_find 操作路径、evidence_url 出处、status）、"
        "lead_time_days 提前预订天数、duration_hint 典型时长区间、"
        "flight_no/train_no/dep_time/arr_time（只有资料里明确写了才填，否则 null）、note。"
    )
    extraction = await _extract(
        settings,
        hint + f"\n航段：{from_poi} → {to_poi}（{mode_label}）",
        _sources_block(retrieval),
        TransportExtraction,
    )
    if extraction is None:
        return _finalize(
            "transport_info_lookup",
            retrieval,
            {"channels": [], "note": "检索结果无法结构化，购买渠道待核实，以购票平台为准"},
            status_of(retrieval, has_value=False, conflict=False),
        )
    verified = retrieval.verified() and not extraction.conflict
    channels = _gate_channels(extraction.channels, verified)
    value = {
        "channels": [c.model_dump(mode="json") for c in channels],
        "lead_time_days": extraction.lead_time_days if verified else None,
        "duration_hint": extraction.duration_hint if verified else None,
        "flight_no": None,
        "train_no": None,
        "dep_time": None,
        "arr_time": None,
        "note": extraction.note or "没有来源就留空，以购票平台为准",
    }
    status = status_of(retrieval, has_value=bool(channels), conflict=extraction.conflict)
    return _finalize("transport_info_lookup", retrieval, value, status, conflict=extraction.conflict)


# --------------------------------------------------------------------------
# 气候参考（01 §8）
# --------------------------------------------------------------------------


class ClimateExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    avg_high: int | None = None
    avg_low: int | None = None
    rainfall_mm: float | None = None
    summary: str | None = None
    advisory: str | None = None


async def climate_reference(
    settings: Settings, retriever: Retriever, *, city: str, month: int | None = None
) -> dict[str, Any]:
    month = month or 5
    queries = [
        f"{city} {month}月 平均气温 降水 气候",
        f"{city} {month}月 天气 穿衣 注意事项",
    ]
    retrieval = await retriever.gather(queries, count=5)
    hint = (
        f"请抽取 {city} {month} 月的气候参考（历史统计，不是预报）。字段：avg_high 平均最高气温（℃）、"
        "avg_low 平均最低气温（℃）、rainfall_mm 平均降水量（mm）、summary 一句话气候概述、"
        "advisory 穿衣/装备建议。"
    )
    extraction = await _extract(
        settings, hint, _sources_block(retrieval), ClimateExtraction
    )
    if extraction is None:
        return _finalize(
            "climate_reference",
            retrieval,
            {"city": city, "month": month, "summary": None, "note": "气候参考待核实"},
            status_of(retrieval, has_value=False, conflict=False),
        )
    verified = retrieval.verified() and not extraction.conflict
    value = {
        "city": city,
        "month": month,
        "avg_high": extraction.avg_high if verified else None,
        "avg_low": extraction.avg_low if verified else None,
        "rainfall_mm": extraction.rainfall_mm if verified else None,
        "summary": extraction.summary or extraction.conflict_note,
        "advisory": extraction.advisory,
        "disclaimer": "气候参考，非预报",
    }
    status = status_of(retrieval, has_value=bool(extraction.summary), conflict=extraction.conflict)
    return _finalize("climate_reference", retrieval, value, status, conflict=extraction.conflict)


# --------------------------------------------------------------------------
# 营业时间（02 §3）
# --------------------------------------------------------------------------


class OpeningExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    regular: list[OpeningPeriod] = Field(default_factory=list)
    closed_days: list[str] = Field(default_factory=list)
    closed_dates: list[str] = Field(default_factory=list)
    seasonal: list[SeasonalOpening] = Field(default_factory=list)
    reservation_required: bool | None = None
    note: str | None = None


_TIME_TOKEN = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})")


def _time_tokens(text: str | None) -> set[str]:
    if not text:
        return set()
    return {f"{int(h):02d}:{m}" for h, m in _TIME_TOKEN.findall(str(text))}


def _agrees_with_amap(amap_text: str | None, periods: list[OpeningPeriod]) -> bool:
    """高德 business_time 与检索结果是否吻合：至少一个开放时刻对得上。"""
    tokens = _time_tokens(amap_text)
    if not tokens:
        return False
    for period in periods:
        if period.open in tokens or (period.last_entry and period.last_entry in tokens):
            return True
    return False


async def opening_hours_lookup(
    settings: Settings,
    retriever: Retriever,
    *,
    poi: str,
    city: str | None = None,
    amap_poi_id: str | None = None,
    amap_client: AmapClient | None = None,
    date_range: str | None = None,
) -> tuple[dict[str, Any], str | None]:
    """返回 `(统一结构, 高德 business_time)`。

    高德 business_time 只是来源之一：单独出现时只算 `clue`，与另一来源吻合才升为
    `verified`（02 §3.2）。
    """
    amap_text: str | None = None
    if amap_poi_id and amap_client is not None and amap_client.configured:
        try:
            detail = await amap_client.place_detail(amap_poi_id)
            amap_text = detail.get("business_time") if isinstance(detail.get("business_time"), str) else None
        except AmapError:
            amap_text = None

    where = f"{city} " if city else ""
    season = f" {date_range}" if date_range else ""
    queries = [
        f"{where}{poi} 开放时间 营业时间 最后入园{season}".strip(),
        f"{where}{poi} 闭园 闭馆 每周 预约 公告",
    ]
    retrieval = await retriever.gather(queries, count=5)
    hint = (
        "请抽取该景区的营业时间（structure 化，不要返回一整个字符串）。字段："
        "regular 数组（days 星期短码数组 mon..sun，空表示每天；open HH:MM；close HH:MM；"
        "last_entry 最后入园 HH:MM 或 null）、closed_days 周几闭馆数组、"
        "closed_dates 具体闭馆日期数组 YYYY-MM-DD、seasonal 季节段数组"
        "（from MM-DD、to MM-DD、regular 同结构）、reservation_required 是否需预约、note。"
        "资料里没写就留空数组或 null，不要推测。"
    )
    extra = f"高德 business_time 原文：{amap_text}" if amap_text else "（没有高德营业时间）"
    extraction = await _extract(
        settings,
        hint + f"\n目标景区：{poi}\n{extra}",
        _sources_block(retrieval),
        OpeningExtraction,
    )
    if extraction is None:
        result = _finalize(
            "opening_hours_lookup",
            retrieval,
            {
                "regular": [],
                "closed_days": [],
                "closed_dates": [],
                "seasonal": [],
                "reservation_required": None,
                "note": "营业时间检索结果无法结构化，待核实"
                + (f"（高德：{amap_text}）" if amap_text else ""),
            },
            EvidenceStatus.UNVERIFIED,
        )
        return result, amap_text

    web_verified = retrieval.verified() and not extraction.conflict
    agree = _agrees_with_amap(amap_text, extraction.regular)
    if web_verified:
        status = EvidenceStatus.VERIFIED
    elif extraction.conflict:
        status = EvidenceStatus.CONFLICT
    elif amap_text and agree:
        # 高德 + 另一来源吻合：升为 verified（02 §3.2）
        status = EvidenceStatus.VERIFIED if retrieval.hits else EvidenceStatus.CLUE
    elif amap_text:
        status = EvidenceStatus.CLUE
    elif extraction.regular:
        status = EvidenceStatus.CLUE
    else:
        status = EvidenceStatus.UNVERIFIED

    value = {
        "regular": [p.model_dump(mode="json") for p in extraction.regular],
        "closed_days": [d.strip().lower()[:3] for d in extraction.closed_days if d],
        "closed_dates": [d for d in extraction.closed_dates if d],
        "seasonal": [s.model_dump(mode="json", by_alias=True) for s in extraction.seasonal],
        "reservation_required": extraction.reservation_required,
        "note": extraction.note or extraction.conflict_note,
        "amap_business_time": amap_text,
    }
    if status != EvidenceStatus.VERIFIED:
        # 未核实的数据不参与校验，但保留在 value 里供卡片展示
        value["note"] = value["note"] or "营业时间待核实"
    result = _finalize("opening_hours_lookup", retrieval, value, status, conflict=extraction.conflict)
    return result, amap_text


def opening_hours_from_payload(payload: dict[str, Any], source_refs: list[str]) -> OpeningHours:
    """把登记簿里的 payload 还原成 Stop.opening_hours。"""
    data = {
        "status": payload.get("status") or EvidenceStatus.UNVERIFIED.value,
        "regular": payload.get("regular") or [],
        "closed_days": payload.get("closed_days") or [],
        "closed_dates": payload.get("closed_dates") or [],
        "seasonal": payload.get("seasonal") or [],
        "reservation_required": payload.get("reservation_required"),
        "note": payload.get("note"),
        "evidence": payload.get("evidence") or [],
        "source_refs": source_refs,
        "authority": payload.get("authority"),
    }
    return OpeningHours.model_validate(data)


def parse_hm_pair(text: str | None) -> tuple[int, int] | None:
    tokens = sorted(_time_tokens(text))
    if len(tokens) < 2:
        return None
    first, second = hm_to_minutes(tokens[0]), hm_to_minutes(tokens[1])
    if first is None or second is None:
        return None
    return first, second
