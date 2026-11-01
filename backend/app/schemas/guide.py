"""攻略层 schema —— stop 详情里「美食」「打卡」两段的结构（docs/07 §1、§6）。

与计划层的分界：
- 计划层 = Trip JSON，回答"几点在哪"，只有 agent + 校验器能写，有版本快照。
- 攻略层 = 本 schema，回答"到了这儿怎么选"，由 guide 管线按需检索生成，
  **永不写回 Trip JSON**，无版本，TTL 3 天自动过期。

概览段不在此列（它全部来自 Trip JSON，前端直接投影），问答段也不在
（它是 turn 的双渲染分流，见 docs/07 §8）。
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GuideKind(StrEnum):
    """攻略段类型。封闭集合：只有"吃"和"玩/拍"两类。"""

    FOOD = "food"
    SPOT = "spot"  # 打卡点 + 拍照点合并（数据高度重叠，docs/07 §6）


class GuideItem(BaseModel):
    """A 部分：列表的一行（docs/07 §6）。

    `highlight` 没有检索依据时必须为 None —— 宁可留空也不要编造
    （"坐标必须有 source_ref"铁律在文本层的延伸）。
    `amap_poi_id` 缺失时前端不渲染 [导航] 按钮（如"村口观景台"这种非 POI 地点）。
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    amap_poi_id: str | None = None
    lng: float | None = None
    lat: float | None = None
    distance_m: int | None = None
    highlight: str | None = Field(
        default=None, description="一句话特色（招牌菜 / 最佳机位与时间），必须有检索依据"
    )
    best_time: str | None = Field(
        default=None, description="仅 spot 有意义，如「日出前 30 分钟」"
    )
    source_ref: str | None = None


class GuideSection(BaseModel):
    """一段攻略 = B 叙事在上 + A 列表在下（docs/07 §6）。"""

    model_config = ConfigDict(extra="forbid")

    narrative: list[str] = Field(
        default_factory=list, description="2–3 段短文：当地特色是什么、为什么值得、避坑提示"
    )
    items: list[GuideItem] = Field(
        default_factory=list, description="按匹配度排序；不硬卡条数，但无依据的不要凑"
    )


class StopGuide(BaseModel):
    """一个 stop 的完整攻略。缓存单位为整体（美食+打卡一起生成）。"""

    model_config = ConfigDict(extra="forbid")

    trip_id: str
    stop_id: str
    poi_hash: str = Field(
        description="sha1(amap_poi_id+name+lng+lat)[:12]。stop_id 跨重规划存活，"
        "所以「改这里」换地点后 stop_id 不变，必须靠它区分新旧（docs/07 §9）。"
    )
    filter_hash: str = Field(default="none", description="口味/范围 chips 的组合指纹")
    profile_hash: str = Field(default="none", description="用户长期口味档案指纹")
    food: GuideSection = Field(default_factory=GuideSection)
    spot: GuideSection = Field(default_factory=GuideSection)
    source: Literal["real", "mock"] = Field(
        description="mock 时前端要在段顶挂「演示数据 · 非真实检索」横幅（docs/07 §9）"
    )
    not_configured: str | None = Field(
        default=None,
        description="真实模式但缺 Key 时填缺哪个（AMAP_WEB_KEY / TAVILY_API_KEY），"
        "此时两段的 narrative/items 都为空，前端显示接入引导而不是 fixture 兜底",
    )
    generated_at: str | None = None


class GuideStage(BaseModel):
    """详情专用 SSE 的进度事件（docs/07 §9）。

    与主对话流的 SseEvent 完全隔离：不进 turns 表、不占 per-trip seq、
    不参与断线补发。只有 stage + done 两类，不做 partial 逐段流式
    （Anthropic provider 非流式，做了是欺骗性 UI）。
    """

    model_config = ConfigDict(extra="forbid")

    stage: Literal["searching", "writing", "done", "error"]
    label: str = ""
    detail: StopGuide | None = Field(default=None, description="仅 done 时携带")
    error: str | None = Field(default=None, description="仅 error 时携带")
