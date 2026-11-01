"""结构化证据与来源登记簿（docs/new-plan 01 §4.2、§9.1；02 §1、§3.2、§5）。

跨边界的数据一律是 JSON：复合工具的返回 `{value, evidence[], authority, conflict}`，
证据里的每一条都带一个服务端发的 `source_ref`，写进行程的字段只能引用登记簿里
真实存在过的 ref。自由文本只留在两处：给人读的 `summary`，以及证据引文 `quote`。
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class EvidenceStatus(StrEnum):
    """一条事实证据的可信度分级（01 §4.2、02 §3.2）。

    只有 `verified` 会被校验器当成硬约束（02 §3.3），其余一律按「待核实」展示。
    """

    VERIFIED = "verified"
    CLUE = "clue"
    UNVERIFIED = "unverified"
    CONFLICT = "conflict"


class SourceType(StrEnum):
    """证据来源类型。官方站点 / 官方公告才可能单独支撑 `verified`。"""

    OFFICIAL = "official"
    ANNOUNCEMENT = "announcement"
    GOVERNMENT = "government"
    OTA = "ota"
    TRAVEL_NOTE = "travel_note"
    REFERENCE = "reference"
    OTHER = "other"


OFFICIAL_SOURCE_TYPES = {
    SourceType.OFFICIAL,
    SourceType.ANNOUNCEMENT,
    SourceType.GOVERNMENT,
}


class Evidence(BaseModel):
    """一条可展示、可追溯的证据。`quote` 是原文引文，唯一允许的自由文本。"""

    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, description="来源链接")
    title: str | None = None
    published_at: str | None = Field(default=None, description="YYYY-MM-DD；经验类必须有")
    quote: str | None = Field(default=None, description="原文引文")
    source_type: SourceType = SourceType.OTHER
    source_ref: str | None = Field(
        default=None, description="本次检索发出的 source_ref，必须已进登记簿"
    )
    authority: int | None = Field(
        default=None, description="DeepSeek 检索返回的 authority（-1–4，≥3 视为极权威）"
    )


class SourceEntry(BaseModel):
    """来源登记簿的一行（02 §5）。`agent` 记录是主 Agent 还是哪个子 Agent 调用的。"""

    model_config = ConfigDict(extra="forbid")

    source_ref: str
    tool: str
    origin: str = Field(description="deepseek / tavily / amap / local / mock")
    url: str | None = None
    title: str | None = None
    published_at: str | None = None
    snippet: str | None = None
    fetched_at: str
    authority: int | None = None
    turn_id: str | None = None
    agent: str = Field(default="main", description="main 或 sub:<task_id>")
    trip_id: str | None = None
    #: 复合工具的结构化产物，写入时由服务端回填（营业时间等），模型不自己写值
    payload: dict[str, Any] | None = None


class CompositeValue(BaseModel):
    """时效事实复合工具的统一返回骨架（01 §4.2）。

    `value` 的具体形状由各工具自己定义；这里只约束四个跨工具一致的字段。
    """

    model_config = ConfigDict(extra="forbid")

    value: dict[str, Any] = Field(default_factory=dict)
    evidence: list[Evidence] = Field(default_factory=list)
    authority: int | None = None
    conflict: bool = False
    status: EvidenceStatus = EvidenceStatus.UNVERIFIED
    source_refs: list[str] = Field(default_factory=list)


def strongest(evidence: list[Evidence]) -> int | None:
    """证据里最高的 authority。没有就返回 None。"""
    values = [e.authority for e in evidence if e.authority is not None]
    return max(values) if values else None
