"""HTTP request / response models."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.events import SseEvent
from app.schemas.plan import AskUserAnswer, Derived, Trip, TripWithDerived


class ContextTag(BaseModel):
    """「改这里」插入的 @标签。后端把它翻译成明确的作用域提示。"""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["stop", "activity", "day", "rhythm", "assumption", "conflict"] = "stop"
    id: str | None = None
    label: str
    day_index: int | None = None


class ModelSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = "mock"
    model: str = "trace-mock-v1"


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=8000)
    context_tags: list[ContextTag] = Field(default_factory=list)
    ask_answers: list[AskUserAnswer] = Field(default_factory=list)
    ask_id: str | None = None
    model: ModelSelection | None = None


class CreateTripRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    first_message: str | None = None


class GuideRequest(BaseModel):
    """攻略层生成请求（docs/07 §9）。filters 是美食段上方的口味/范围 chips，
    局部过滤，不写回 Trip JSON。"""

    model_config = ConfigDict(extra="forbid")

    filters: list[str] = Field(default_factory=list)
    refresh: bool = False
    model: ModelSelection | None = None


class ProfileUpdate(BaseModel):
    """长期口味档案写入（docs/07 §7）。skip=True 表示首屏问卷被跳过，
    之后永不再弹。"""

    model_config = ConfigDict(extra="forbid")

    diet: list[str] | None = None
    taste: list[str] | None = None
    dismissed: bool | None = None
    skip: bool | None = None


class AddStopRequest(BaseModel):
    """地图/对话里把候选点加入某一天（mindtrip/06 §8）。走 apply_ops.insert_stop。"""

    model_config = ConfigDict(extra="forbid")

    day_index: int = Field(ge=1, le=60)
    at_seq: int | None = Field(default=None, ge=1)
    poi_id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    category: str | None = None
    city: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    amap_poi_id: str | None = None
    source_ref: str | None = None
    note: str | None = None


class UpdateStopPoiRequest(BaseModel):
    """确认位置（mindtrip/06 §1.5）：给无坐标的 chip 补坐标/改名。"""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    city: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    amap_poi_id: str | None = None
    source_ref: str | None = None


class ReorderStopsRequest(BaseModel):
    """拖拽重排（REST 快路径，不经 LLM）。"""

    model_config = ConfigDict(extra="forbid")

    day_index: int = Field(ge=1, le=60)
    stop_ids: list[str] = Field(min_length=1)


class ImportImageRef(BaseModel):
    """截图/拍照以 base64 提交（无 python-multipart 依赖，移动端也更好处理）。"""

    model_config = ConfigDict(extra="forbid")

    filename: str | None = None
    mime: str | None = None
    data_base64: str = Field(min_length=8)


class ImportImagesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    images: list[ImportImageRef] = Field(min_length=1, max_length=10)
    mode: Literal["screenshot", "photo"] = "screenshot"


class ImportLinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str | None = None
    text: str | None = None
    city: str | None = None


class RenameTripRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=120)


class RestoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)


class TripSummary(BaseModel):
    trip_id: str
    title: str
    version: int
    origin: str | None = None
    dest: str | None = None
    date_start: date | None = None
    date_end: date | None = None
    days: int = 0
    transport_mode: str | None = None
    updated_at: str | None = None
    error_count: int = 0
    warning_count: int = 0
    done: bool = False
    route_points: list[tuple[float, float]] = Field(default_factory=list)


class TripDetail(TripWithDerived):
    events: list[SseEvent] = Field(default_factory=list)
    last_seq: int = 0
    readonly: bool = False


class VersionItem(BaseModel):
    version: int
    title: str | None = None
    summary: str | None = None
    user_request: str | None = None
    op_count: int = 0
    created_at: str | None = None
    changed_stop_ids: list[str] = Field(default_factory=list)
    changed_activity_ids: list[str] = Field(default_factory=list)


class VersionDetail(VersionItem):
    trip: Trip
    derived: Derived


class RuntimeSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    values: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, str] = Field(default_factory=dict)
    clear_secrets: list[str] = Field(default_factory=list)


class IntegrationCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str | None = None
    model: str | None = None


class ConfigResponse(BaseModel):
    app_name: str
    demo_mode: bool
    agent_mode: str = "demo"
    amap_js_key: str
    amap_js_security_code: str
    amap_web_configured: bool
    tavily_configured: bool
    llm_configured: bool
    demo_today: date
    default_model: ModelSelection
    providers: list[dict[str, Any]]
    map_provider: str = "leaflet"
    readonly_share: bool = False


class HealthResponse(BaseModel):
    status: str = "ok"
    database: str
    demo_mode: bool
