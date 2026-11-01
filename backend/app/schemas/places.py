"""地图/浮卡/收藏/导入/评论的 Pydantic 契约（mindtrip/06 §2.3、§4.3、§7–§12）。

单独成文件的原因：这些结构**不是 Trip 文档的一部分**。Trip 仍然是唯一事实，
浮卡详情、候选点、收藏、导入任务都是围绕它的视图/旁路数据，不该污染脊柱。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PlaceCategory = Literal[
    "place", "stay", "meal", "sight", "shopping", "transit", "unknown"
]
PlaceProvider = Literal["amap", "dianping", "official", "ugc"]
CandidateSource = Literal["chat", "search", "nearby", "import", "saved"]


class PlaceSource(BaseModel):
    """来源行：`高德 · 抓取于 2026-10-28`。没有来源就明说，不许编。"""

    model_config = ConfigDict(extra="forbid")

    provider: PlaceProvider
    url: str | None = None
    fetched_at: str | None = None


class PlaceReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    author: str | None = None
    text: str
    score: float | None = None


class PlaceActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    type: str
    start: str | None = None
    end: str | None = None
    note: str | None = None
    tips: list[str] = Field(default_factory=list)


class PlaceTransfer(BaseModel):
    """相邻地点怎么走：来自 route_legs（高德规划）或行程排期。"""

    model_config = ConfigDict(extra="forbid")

    from_stop_id: str
    to_stop_id: str
    from_name: str | None = None
    to_name: str | None = None
    mode: str
    distance_m: int | None = None
    duration_min: int | None = None
    source: str | None = None


class PlaceDetail(BaseModel):
    """地点浮卡 / Sheet / 详情模板共用的结构（mindtrip/06 §2.3 + P2 模板扩展）。

    `missing` 显式列出「这个来源拿不到」的字段，前端据此显示「暂无」，
    而不是把空白当成 0 或悄悄隐藏。
    """

    model_config = ConfigDict(extra="forbid")

    poi_id: str
    name: str
    category: PlaceCategory = "place"
    city: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    rating: float | None = None
    review_count: int | None = None
    price_level: int | None = Field(default=None, ge=1, le=4)
    price_text: str | None = None
    photos: list[str] = Field(default_factory=list)
    summary: str | None = None
    source: PlaceSource | None = None
    open_now: bool | None = None
    business_time: str | None = None
    reservation_required: bool | None = None
    facilities: list[str] = Field(default_factory=list)
    reviews: list[PlaceReview] = Field(default_factory=list)
    #: 高德 POI 名（与行程里的展示名可能不同）
    source_name: str | None = None
    #: 行程上下文：这个点在第几天、是否已在行程里
    stop_id: str | None = None
    day_index: int | None = None
    in_trip: bool = False
    #: 行程属性（来自同一份 Trip，不估算）
    visit_duration_min: int | None = None
    reservation_required: bool | None = None
    ticket_unit_text: str | None = None
    ticket_total_text: str | None = None
    activities: list[PlaceActivity] = Field(default_factory=list)
    transfer_from: PlaceTransfer | None = None
    transfer_to: PlaceTransfer | None = None
    #: 坐标是否已由高德 POI 校正（§"全部使用高德真实坐标"）
    coordinate_verified: bool | None = None
    #: 取不到或来源未确认的字段名（前端逐项显示「暂无」）
    missing: list[str] = Field(default_factory=list)
    fetched_at: str | None = None


class CandidatePlace(BaseModel):
    """候选点（mindtrip/06 §4.3）。不落库；由最新一轮对话/搜索/导入派生。"""

    model_config = ConfigDict(extra="forbid")

    poi_id: str
    name: str
    category: PlaceCategory = "place"
    lat: float | None = None
    lng: float | None = None
    city: str | None = None
    address: str | None = None
    source: CandidateSource = "chat"
    rating: float | None = None
    price_level: int | None = None
    added: bool = False
    stop_id: str | None = None
    day_index: int | None = None


class SavedPlace(BaseModel):
    """收藏 / 想去层（mindtrip/06 §11）。私有，不做公开清单。"""

    model_config = ConfigDict(extra="forbid")

    poi_id: str
    name: str
    category: PlaceCategory = "place"
    lat: float | None = None
    lng: float | None = None
    city: str | None = None
    address: str | None = None
    note: str | None = None
    created_at: str | None = None


class SavedPlaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    poi_id: str
    name: str | None = None
    category: str | None = None
    lat: float | None = None
    lng: float | None = None
    city: str | None = None
    address: str | None = None
    note: str | None = None


class ImportItem(BaseModel):
    """导入候选确认面板的一行：名称可改、失败项显式「未定位」。"""

    model_config = ConfigDict(extra="forbid")

    poi_id: str | None = None
    name: str
    category: PlaceCategory = "place"
    city: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    located: bool = False
    duplicate: bool = False
    in_trip_day: int | None = None
    amap_poi_id: str | None = None


class ImportResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    kind: Literal["link", "text", "images"]
    source_url: str | None = None
    title: str | None = None
    items: list[ImportItem] = Field(default_factory=list)
    failures: list[str] = Field(default_factory=list)
    message: str | None = None
    fetched_at: str | None = None


class ThreadComment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comment_id: str
    thread_id: str
    author: Literal["me", "companion", "assistant"] = "me"
    body: str
    mentions_assistant: bool = False
    created_at: str | None = None


class Thread(BaseModel):
    model_config = ConfigDict(extra="forbid")

    thread_id: str
    trip_id: str
    title: str
    created_at: str | None = None
    comments: list[ThreadComment] = Field(default_factory=list)


class ThreadCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)


class CommentCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=2000)
    author: Literal["me", "companion"] = "me"


class PlaceSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[CandidatePlace] = Field(default_factory=list)
    available: bool = True
    message: str | None = None
    source: str | None = None


class PlaceFeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vote: Literal["up", "down"]
    note: str | None = None


class RouteRefreshResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    legs: list[dict[str, Any]] = Field(default_factory=list)
    enriched: int = 0
    message: str | None = None
