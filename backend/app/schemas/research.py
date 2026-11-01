"""子 Agent 调研的结构化契约（docs/new-plan 02 §2）。

主 Agent 用 `dispatch_research` 派任务；子 Agent 收尾时必须调用
`submit_findings`，把 JSON 作为函数调用参数提交，再由 Pydantic 校验。
校验不过的条目被丢弃并记入 `gaps`，不用自由文本凑数。
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.sources import Evidence, SourceType


class ResearchRole(StrEnum):
    """v1 角色预设（02 §2.3）。景点级事实 v1 不设 LLM 子 Agent。"""

    ROUTE = "route"
    EXPERIENCE = "experience"
    TRANSPORT = "transport"
    CONDITIONS = "conditions"


#: 角色默认工具白名单，全部由代码计算（02 §2.3）。
ROLE_PRESETS: dict[str, list[str]] = {
    "route": ["web_search", "fetch_page", "social_digest", "search_poi", "climate_reference"],
    "experience": ["social_digest", "web_search", "fetch_page"],
    "transport": ["transport_info_lookup", "plan_route", "search_poi", "holiday_calendar"],
    "conditions": ["get_weather", "climate_reference", "sun_times", "holiday_calendar"],
}

#: 子 Agent 永远看不到的工具：派子 Agent、写行程、发提问卡（02 §2.2）。
SUBAGENT_DENIED = {"dispatch_research", "draft_itinerary", "update_itinerary", "ask_user"}

#: 子 Agent 专属工具，主 Agent 不可调用。
SUBAGENT_ONLY = {"submit_findings", "fetch_page"}


class ResearchTask(BaseModel):
    """主 Agent 写的一个调研任务。`deny_tools` 只能收窄默认白名单。"""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    role: ResearchRole
    goal: str
    context: dict[str, Any] = Field(default_factory=dict)
    deny_tools: list[str] = Field(default_factory=list)
    max_summary_chars: int = Field(default=800, ge=120, le=2000)


class ResearchTaskList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tasks: list[ResearchTask]

    @field_validator("tasks")
    @classmethod
    def _limit(cls, value: list[ResearchTask]) -> list[ResearchTask]:
        if not value:
            raise ValueError("tasks 不能为空")
        if len(value) > 6:
            raise ValueError("单次最多 6 个调研任务（初值，待标定）")
        return value


class FindingKind(StrEnum):
    FACT = "fact"
    EXPERIENCE = "experience"
    CLUE = "clue"


class Confidence(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Finding(BaseModel):
    """一条调研结论。`fact` 必须引用登记簿里存在的 source_ref；
    `experience` 必须带引文、链接和发布日期（02 §2.5）。"""

    model_config = ConfigDict(extra="forbid")

    kind: FindingKind
    claim: str
    source_refs: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    confidence: Confidence = Confidence.MEDIUM


class FindingsStatus(StrEnum):
    OK = "ok"
    PARTIAL = "partial"
    FAILED = "failed"


class Findings(BaseModel):
    """`submit_findings` 的参数模型。"""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    role: ResearchRole
    status: FindingsStatus = FindingsStatus.OK
    summary: str = ""
    findings: list[Finding] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    tool_calls_used: int = 0


class ResearchStep(BaseModel):
    """子 Agent 的一次动作：调用某个工具、提交结论、兜底收尾。

    只记录给**人**看的过程信息（工具名、精简参数、成败、耗时、结果摘要），
    不把整段结果塞进来；模型侧仍然只看到 `slim_for_model` 的摘要。
    """

    model_config = ConfigDict(extra="forbid")

    index: int = 0
    kind: Literal["tool", "submit", "closing", "error"] = "tool"
    tool: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)
    ok: bool | None = None
    summary: str | None = None
    duration_ms: int | None = None


class ResearchTrace(BaseModel):
    """一个子 Agent 的完整运行轨迹：谁、用什么模型、跑了几步、每一步做了什么。"""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    role: ResearchRole
    goal: str = ""
    model: str | None = None
    status: FindingsStatus = FindingsStatus.OK
    duration_ms: int = 0
    steps_used: int = 0
    tool_calls_used: int = 0
    steps: list[ResearchStep] = Field(default_factory=list)
    error: str | None = None


class ResearchResult(BaseModel):
    """主 Agent 拿到的单份摘要（02 §2.5）。自由文本只有 `summary` 和 `quote`。"""

    model_config = ConfigDict(extra="forbid")

    task_id: str
    role: ResearchRole
    status: FindingsStatus = FindingsStatus.FAILED
    summary: str = ""
    findings: list[Finding] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    tool_calls_used: int = 0
    dropped: list[str] = Field(default_factory=list)
    #: 独立来源数：由代码按域名去重计算，不采信模型自己报的数字（02 §2.5）
    independent_sources: int = 0
    error: str | None = None
    #: 运行轨迹：前端点开子 Agent 时展示（工具调用、成败、耗时、收尾方式）
    trace: ResearchTrace | None = None


class DispatchResearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    results: list[ResearchResult] = Field(default_factory=list)
    degraded: bool = False
    reason: str | None = None


def official_source(evidence: Evidence) -> bool:
    return evidence.source_type in {
        SourceType.OFFICIAL,
        SourceType.ANNOUNCEMENT,
        SourceType.GOVERNMENT,
    }
