"""Tool argument / result models (docs §2). Six tools, closed set."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.plan import PoiRef


class ToolName(StrEnum):
    """工具清单 v1（docs/new-plan 01 §3，02 §6 的增补已合并进来）。"""

    # 地理
    SEARCH_POI = "search_poi"
    PLAN_ROUTE = "plan_route"
    SEARCH_AROUND = "search_around"
    PLACE_DETAIL = "place_detail"
    # 环境
    GET_WEATHER = "get_weather"
    CLIMATE_REFERENCE = "climate_reference"
    SUN_TIMES = "sun_times"
    HOLIDAY_CALENDAR = "holiday_calendar"
    # 时效事实（复合工具）
    TICKET_CHANNEL_LOOKUP = "ticket_channel_lookup"
    CLOSURE_NOTICE_LOOKUP = "closure_notice_lookup"
    PERMIT_POLICY_LOOKUP = "permit_policy_lookup"
    TRANSPORT_INFO_LOOKUP = "transport_info_lookup"
    OPENING_HOURS_LOOKUP = "opening_hours_lookup"
    # 线索 / 兜底
    SOCIAL_DIGEST = "social_digest"
    WEB_SEARCH = "web_search"
    FETCH_PAGE = "fetch_page"
    # 调研（02 §2）
    DISPATCH_RESEARCH = "dispatch_research"
    SUBMIT_FINDINGS = "submit_findings"
    # 写入
    DRAFT_ITINERARY = "draft_itinerary"
    UPDATE_ITINERARY = "update_itinerary"


class SearchPoiArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str
    city: str | None = None
    category: str | None = Field(default=None, description="景点 / 美食 / 酒店 / 交通")
    limit: int = Field(default=8, ge=1, le=8)


class PlanRouteArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_poi: str = Field(alias="from")
    to_poi: str = Field(alias="to")
    mode: Literal["drive", "walk", "transit"] = "drive"
    # optional coordinates, populated from search_poi results
    from_lng: float | None = None
    from_lat: float | None = None
    to_lng: float | None = None
    to_lat: float | None = None


class WebSearchArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    max_results: int = Field(default=3, ge=1, le=5)


class WeatherArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    city: str
    date: str | None = Field(default=None, description="YYYY-MM-DD，空表示今天起三天")


class DraftItineraryArgs(BaseModel):
    """初版行程全量写入。模型必须产出完整 Trip JSON（不含 derived）。"""

    model_config = ConfigDict(extra="forbid")

    trip: dict[str, Any]
    summary: str | None = None


class UpdateItineraryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ops: list[dict[str, Any]]
    summary: str | None = None


class PoiResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    amap_poi_id: str | None = None
    lng: float
    lat: float
    city: str | None = None
    address: str | None = None
    category: str | None = None
    rating: float | None = None
    source_ref: str


class AroundPoi(BaseModel):
    """`place/around` 的一条结果。

    与 PoiResult 的区别是带 distance_m —— 攻略层的"到了怎么选"需要距离，
    而规划层的 search_poi 不需要。amap_poi_id 让它可以直接生成导航深链
    （docs/07 §4），这是纯 web 检索给不了的。
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    amap_poi_id: str | None = None
    lng: float
    lat: float
    address: str | None = None
    category: str | None = None
    distance_m: int | None = None
    source_ref: str


class RouteResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_poi: str
    to_poi: str
    mode: str
    distance_km: float
    minutes: int
    road_refs: list[str] = Field(default_factory=list)
    #: 过路费（元）与收费路段里程：自驾预算必须有工具来源（01 §9.3）
    tolls: float | None = None
    toll_distance_km: float | None = None
    has_toll_road: bool | None = None
    source_ref: str
    #: 真实道路几何 [[lng, lat], ...]；仅 drive/walk/transit 有，航班/火车为 None
    polyline: list[list[float]] | None = None


class WebResultItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    url: str | None = None
    content: str
    score: float | None = None


class WebSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    results: list[WebResultItem]
    conclusion: str | None = None
    source_ref: str


class WeatherStatus(StrEnum):
    OK = "ok"
    #: 目标日期超出 3 天预报范围。不再静默拿今天的天气顶替（01 §8）
    OUT_OF_FORECAST = "out_of_forecast"


class WeatherResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    city: str
    date: str | None = None
    summary: str
    high: int | None = None
    low: int | None = None
    wind: str | None = None
    status: WeatherStatus = WeatherStatus.OK
    source_ref: str


class ToolError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    code: str
    message: str
    retryable: bool = False

    def display(self) -> str:
        return f"{self.tool} 调用失败（{self.code}）：{self.message}"


class ToolOutcome(BaseModel):
    """Every tool returns this. Failures are explicit (docs §4.8)."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    tool: str
    data: Any = None
    summary: str = ""
    source_refs: list[str] = Field(default_factory=list)
    error: ToolError | None = None
    cached: bool = False
    duration_ms: int = 0


class ToolTier(StrEnum):
    """路由分档（docs/new-plan 01 §2.2，02 §6 的修订：social_digest 归子 Agent）。"""

    ALWAYS = "always"      # 常开：不问 Jev，便宜且确定
    FORCED = "forced"      # 代码按证据缺口强制放行，Jev 不能剔除
    JEV = "jev"            # Jev 裁量
    WRITE = "write"        # 写工具始终可用，仍由校验器把关
    SUBAGENT = "subagent"  # 仅子 Agent 可用


class ToolSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    parameters: dict[str, Any]
    read_only: bool
    write: bool = False
    tier: ToolTier = ToolTier.ALWAYS
    expensive: bool = Field(default=False, description="贵工具：Jev 阈值更高、调用次数单独限额")

    def openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolExecution(BaseModel):
    model_config = ConfigDict(extra="forbid")

    call: ToolCall
    outcome: ToolOutcome
    duration_ms: int = 0
