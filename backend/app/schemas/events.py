"""SSE event contract (docs §4.4 + mindtrip/06 §13.2).

Seven event types, closed set.  `route` 是 P0 唯一新增的类型：距离行/路线补丁，
旧客户端跳过未知类型即可。地点不再单独发事件 —— 随 assistant message 的
`segments` 到达（mindtrip/06 §13.2）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class EventType(StrEnum):
    THINKING = "thinking"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    PLAN_PATCH = "plan_patch"
    MESSAGE = "message"
    ASK_USER = "ask_user"
    ROUTE = "route"
    #: 子 Agent 运行进度（started / step / finished）；旧客户端跳过未知类型即可
    SUBAGENT = "subagent"


class SseEvent(BaseModel):
    """Envelope persisted in turns.events and streamed over SSE.

    `seq` is monotonic per trip (not per turn) so `?after_seq=N` can replay.
    """

    model_config = ConfigDict(extra="forbid")

    seq: int = 0
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)
    trip_id: str | None = None
    turn_id: str | None = None
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def sse(self) -> str:
        return f"id: {self.seq}\nevent: {self.type}\ndata: {self.model_dump_json()}\n\n"


# --------------------------------------------------------------------------
# Typed payload helpers.  Event payloads stay dicts on the wire so new
# display-only fields do not require a schema migration, but producers use
# these helpers to keep the shape honest.
# --------------------------------------------------------------------------


class ThinkingPayload(BaseModel):
    text: str = ""
    done: bool = False


class MessagePayload(BaseModel):
    role: Literal["assistant", "user"] = "assistant"
    text: str
    markdown: bool = True
    at: str | None = None
    kind: str | None = Field(default=None, description="ready / summary / plain")
    model: str | None = None
    #: 服务端序列化的消息片段（mindtrip/06 §1.3）。旧消息/旧客户端没有它时按纯文本渲染。
    segments: list[dict[str, Any]] | None = None


class ToolCallPayload(BaseModel):
    call_id: str
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""
    verbose: str | None = None


class ToolResultPayload(BaseModel):
    call_id: str
    tool: str
    ok: bool = True
    summary: str = ""
    data: Any = None
    error: str | None = None
    duration_ms: int | None = None


class PlanPatchPayload(BaseModel):
    version: int
    ops: list[dict[str, Any]] = Field(default_factory=list)
    trip: dict[str, Any]
    derived: dict[str, Any]
    changed: dict[str, Any] = Field(default_factory=dict)
    diff: list[dict[str, Any]] = Field(default_factory=list)
    reason: str | None = None
    route_legs: list[dict[str, Any]] = Field(default_factory=list)


class RoutePayload(BaseModel):
    """距离行事件（mindtrip/06 §13.2）。`polyline_ref` 指向 route_legs 行，不内联坐标。"""

    leg_id: str
    from_stop_id: str
    to_stop_id: str
    mode: str
    distance_m: int | None = None
    duration_min: int | None = None
    polyline_ref: str | None = None
    source: str | None = None
