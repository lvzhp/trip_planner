"""调用前的工具路由：常开 / 代码强制放行 / Jev 裁量（docs/new-plan 01 §2，02 §2.7、§6）。

三档分工：

- 常开：便宜且确定，不问 Jev；
- 强制：证据缺口由确定性代码算，Jev 不能剔除（票务、封路、准入、营业时间，
  首次规划且没有目的地级调研证据时的 `dispatch_research`）；
- Jev 裁量：每轮一次意图 `Choice` + 每步对每个工具一个 `Noul`。

Jev 不可用时按 01 §2.4 降级，**不**回退成全量放行：常开档与强制档不受影响，
第三档只剩「首次规划 → climate_reference」。02 §6 已把 `social_digest` 从主 Agent
移走（改由经验类子 Agent 使用），所以这里不再对主 Agent 放行它。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.config import Settings
from app.schemas.plan import ActivityType, LongTransitMode, Trip
from app.schemas.tools import ToolTier
from app.llm.jev import JevAnswer, JevClient, JevError, JevQuestion, JevQuestionType

#: 意图选项（01 §2.3）。带兜底项；key 是中文 label，value 是给 Jev 的判定标准。
INTENT_CRITERIA: dict[str, str] = {
    "首次规划": "还没有行程，或用户要求整体重写一版行程（改了目的地、天数、出发地等）",
    "局部重规划": "已有行程，用户只想改某几天或某些活动的时间、顺序、增删",
    "问答": "用户只是询问信息（预算、天气、路线、攻略、门票渠道），不要求修改行程",
    "澄清": "用户在补充信息或回答提问卡，还不适合直接规划",
    "其他": "以上都不符合",
}

INTENT_LABEL_TO_INTENT: dict[str, "Intent"] = {}  # 下方 Intent 定义后填充

#: 「用户明确点名」的社媒关键词：主 Agent 不直接抓，改为派经验类子 Agent（02 §2.7）。
SOCIAL_MENTIONS = ("小红书", "抖音", "微博", "知乎", "B站", "b站", "游记", "攻略")

#: 可能涉及边防证/车辆准入的目的地关键词（代码算缺口，不交给 Jev）。
PERMIT_HINTS = (
    "边境", "白哈巴", "塔县", "红其拉甫", "珠峰", "阿里", "墨脱", "察隅",
    "洛佐", "亚东", "普兰", "樟木", "吉隆", "喀纳斯边境",
)

#: 主 Agent 可见的第三档工具（`social_digest` 只在子 Agent 里）。
MAIN_JEV_TOOLS = {
    "web_search",
    "search_around",
    "place_detail",
    "climate_reference",
    "transport_info_lookup",
    "dispatch_research",
}

#: 代码强制放行档的候选。
FORCED_TOOLS = {
    "ticket_channel_lookup",
    "closure_notice_lookup",
    "permit_policy_lookup",
    "opening_hours_lookup",
}


class Intent(StrEnum):
    FIRST_PLAN = "first_plan"
    REPLAN = "replan"
    QA = "qa"
    CLARIFY = "clarify"
    OTHER = "other"


INTENT_LABEL_TO_INTENT.update(
    {
        "首次规划": Intent.FIRST_PLAN,
        "局部重规划": Intent.REPLAN,
        "问答": Intent.QA,
        "澄清": Intent.CLARIFY,
        "其他": Intent.OTHER,
    }
)


def _intent_question() -> JevQuestion:
    return JevQuestion(
        id="intent",
        type=JevQuestionType.CHOICE,
        instructions="根据用户这句话、行程摘要与已有证据，判断本轮用户真正想要什么。只从 criteria 的选项里选一个。",
        criteria=INTENT_CRITERIA,
    )


def _tool_question(name: str, spec: Any) -> JevQuestion:
    return JevQuestion(
        id=name,
        type=JevQuestionType.NOUL,
        instructions=(
            f"本步是否需要调用「{name}」工具？工具用途：{spec.description[:200]}\n"
            "如果用户本轮诉求与它无关、或已有足够证据，回答 false。"
        ),
    )


@dataclass
class GapReport:
    ticket: bool = False
    closure: bool = False
    permit: bool = False
    opening_hours: bool = False
    research: bool = False

    def tools(self) -> set[str]:
        out: set[str] = set()
        if self.ticket:
            out.add("ticket_channel_lookup")
        if self.closure:
            out.add("closure_notice_lookup")
        if self.permit:
            out.add("permit_policy_lookup")
        if self.opening_hours:
            out.add("opening_hours_lookup")
        return out

    def labels(self) -> list[str]:
        names = []
        if self.ticket:
            names.append("缺票务证据")
        if self.closure:
            names.append("缺封路/季节开放证据")
        if self.permit:
            names.append("缺准入政策证据")
        if self.opening_hours:
            names.append("缺营业时间证据")
        if self.research:
            names.append("缺目的地级调研证据")
        return names


@dataclass
class RoutingDecision:
    intent: Intent
    allowed: set[str]
    forced: list[str] = field(default_factory=list)
    released: list[str] = field(default_factory=list)
    degraded: bool = False
    reason: str | None = None
    gaps: GapReport = field(default_factory=GapReport)
    records: list[dict[str, Any]] = field(default_factory=list)
    model_version: str | None = None

    def describe(self) -> str:
        if self.degraded:
            return f"路由降级：{self.reason}；本步放行 {len(self.allowed)} 个工具"
        return f"路由：{self.intent.value} · 放行 {len(self.allowed)} 个工具"


class ToolRouter:
    def __init__(self, settings: Settings, registry: Any):
        self.settings = settings
        self.registry = registry
        self.jev = JevClient(settings)

    # ------------------------------------------------------------------
    @property
    def always_on(self) -> set[str]:
        return set(self.registry.tools_by_tier(ToolTier.ALWAYS)) | set(
            self.registry.tools_by_tier(ToolTier.WRITE)
        )

    # ------------------------------------------------------------------
    async def decide(
        self,
        *,
        trip: Trip,
        text: str,
        has_research: bool,
        has_answers: bool = False,
        intent_override: Intent | None = None,
        tool_summary: str | None = None,
    ) -> RoutingDecision:
        records: list[dict[str, Any]] = []
        heuristic = _heuristic_intent(trip, text, has_answers)
        intent = intent_override or heuristic
        degraded = False
        reason: str | None = None
        model_version: str | None = None

        if intent_override is not None:
            pass
        elif self.jev.configured:
            try:
                result = await self.jev.evaluate(
                    _state_text(trip, text, heuristic, tool_summary=tool_summary),
                    [_intent_question()],
                )
                model_version = result.model_version
                answer = result.answers.get("intent")
                label, probability = answer.best_choice() if answer else (None, 0.0)
                records.append(
                    {
                        "question": "intent",
                        "type": "choice",
                        "picked": label,
                        "probability": round(probability, 3),
                        "probabilities": answer.probabilities if answer else {},
                        "threshold": self.settings.jev_intent_threshold,
                        "model_version": model_version,
                    }
                )
                mapped = INTENT_LABEL_TO_INTENT.get(label or "")
                if mapped is not None and probability >= self.settings.jev_intent_threshold:
                    intent = mapped
                elif mapped is None:
                    degraded, reason = True, "Jev 意图答案读不到或不在选项内，按关键词降级"
                else:
                    degraded, reason = True, "Jev 意图置信度低于阈值，按降级规则收缩工具"
            except JevError as exc:
                degraded, reason = True, f"Jev 不可用（{exc.code}），按降级规则收缩工具"
        else:
            degraded, reason = True, "未配置 Jev，第三档按降级规则收缩"

        gaps = await self.compute_gaps(trip, intent=intent, has_research=has_research)
        forced = sorted(FORCED_TOOLS & gaps.tools())
        if gaps.research:
            forced.append("dispatch_research")

        released: list[str] = []
        if not degraded and self.jev.configured:
            released, release_error = await self._jev_release(
                trip, text, intent, records, gaps=gaps, tool_summary=tool_summary
            )
            if release_error:
                degraded, reason = True, release_error
        else:
            released = self._degraded_release(trip, text, intent)
        if self._mentions_social(text) and _llm_ready(self.settings):
            # 用户点名社媒/攻略：主 Agent 不直接抓，改为派经验类子 Agent（02 §2.7）
            if "dispatch_research" not in released and "dispatch_research" not in forced:
                released.append("dispatch_research")

        allowed = set(self.always_on)
        allowed |= set(forced)
        allowed |= {name for name in released if name in MAIN_JEV_TOOLS}
        # 防御：子 Agent 专属工具永远不进主 Agent 的工具列表
        allowed -= {"submit_findings", "fetch_page", "social_digest"}

        return RoutingDecision(
            intent=intent,
            allowed=allowed,
            forced=forced,
            released=sorted({name for name in released if name in MAIN_JEV_TOOLS}),
            degraded=degraded,
            reason=reason,
            gaps=gaps,
            records=records,
            model_version=model_version,
        )

    # ------------------------------------------------------------------
    async def compute_gaps(
        self, trip: Trip, *, intent: Intent, has_research: bool
    ) -> GapReport:
        gap = GapReport()
        # 票务：计划层有景点活动，但票里没有开售规则 → 放行票务工具
        for _day, _stop, act in trip.iter_activities():
            if act.type != ActivityType.VISIT:
                continue
            ticket = act.ticket
            if ticket is None or ticket.sale_rule is None:
                gap.ticket = True
                break
        # 封路：自驾长途段带路名，或整趟自驾且有日期
        for _day, _stop, act in trip.iter_activities():
            detail = act.transit_detail
            if detail is None:
                continue
            mode = getattr(detail, "mode", None)
            mode = mode.value if hasattr(mode, "value") else mode
            if mode == LongTransitMode.SELF_DRIVE.value and (
                getattr(detail, "road_refs", None) or getattr(detail, "season_closure", None)
            ):
                gap.closure = True
                break
        if not gap.closure and trip.constraints.transport_mode is not None:
            mode = getattr(trip.constraints.transport_mode, "value", trip.constraints.transport_mode)
            if mode == LongTransitMode.SELF_DRIVE.value and trip.constraints.date_range:
                gap.closure = bool(trip.days)
        # 准入：目的地/必去点命中边境类关键词
        haystack = [trip.constraints.destination or "", trip.constraints.origin or ""]
        haystack += [ref.name for ref in trip.constraints.must_go]
        haystack += [stop.poi.name for _day, stop in trip.iter_stops()]
        joined = " ".join(haystack)
        gap.permit = any(hint in joined for hint in PERMIT_HINTS)
        # 营业时间：有 visit 活动却没有营业时间证据
        for _day, stop in trip.iter_stops():
            if stop.opening_hours is not None:
                continue
            if any(act.type == ActivityType.VISIT for act in stop.activities):
                gap.opening_hours = True
                break
        # 调研：只要还没有行程（首次规划），或缺目的地级调研证据的重写，
        # 就必须放行 dispatch_research。**不能只看 Jev 的意图**：用户回答开场卡时
        # Jev 常把它判成「澄清」，于是工具被关掉，子 Agent 永远没机会被调用。
        gap.research = not has_research and (not trip.days or intent == Intent.FIRST_PLAN)
        return gap

    # ------------------------------------------------------------------
    async def _jev_release(
        self,
        trip: Trip,
        text: str,
        intent: Intent,
        records: list[dict[str, Any]],
        *,
        gaps: GapReport | None = None,
        tool_summary: str | None = None,
    ) -> tuple[list[str], str | None]:
        """一次请求并行评估所有第三档工具：每个工具一个 `noul` 问题（01 §2.3）。

        返回 `(放行的工具, 降级原因)`。Jev 单步失败只收缩第三档，不回退全量放行。
        """
        questions: list[JevQuestion] = []
        thresholds: dict[str, float] = {}
        for name in sorted(MAIN_JEV_TOOLS):
            spec = self.registry.spec(name)
            if spec is None:
                continue
            thresholds[name] = (
                self.settings.jev_tool_threshold_expensive
                if spec.expensive
                else self.settings.jev_tool_threshold
            )
            questions.append(_tool_question(name, spec))
        try:
            result = await self.jev.evaluate(
                _state_text(trip, text, intent, gaps=gaps, tool_summary=tool_summary),
                questions,
            )
        except JevError as exc:
            # 单步失败 → 按降级规则收缩，不回退为全量放行
            records.append({"stage": "tool_noul", "error": exc.code})
            return (
                self._degraded_release(trip, text, intent, fallback=True),
                f"Jev 工具路由失败（{exc.code}），第三档按降级规则收缩",
            )
        released: list[str] = []
        for name, threshold in thresholds.items():
            answer: JevAnswer | None = result.answers.get(name)
            probability = answer.true_probability() if answer else 0.0
            records.append(
                {
                    "question": name,
                    "type": "noul",
                    "p_true": round(probability, 3),
                    "threshold": threshold,
                    "model_version": result.model_version,
                }
            )
            if probability >= threshold:
                released.append(name)
        return released, None

    @staticmethod
    def _degraded_release(
        trip: Trip, text: str, intent: Intent, fallback: bool = False
    ) -> list[str]:
        """01 §2.4 的降级：首次规划放行 climate_reference，其余第三档关闭。

        02 §6 把 `social_digest` 移出主 Agent，所以原来的「首次规划放行
        social_digest」不再适用；攻略调研改由 `dispatch_research` 强制放行承担。
        """
        if intent == Intent.FIRST_PLAN:
            return ["climate_reference"]
        return []

    @staticmethod
    def _mentions_social(text: str) -> bool:
        return any(keyword in (text or "") for keyword in SOCIAL_MENTIONS)


# --------------------------------------------------------------------------
# 辅助
# --------------------------------------------------------------------------


def _llm_ready(settings: Settings) -> bool:
    return bool(settings.llm_configured) and (settings.default_provider or "mock") != "mock"


def _heuristic_intent(trip: Trip, text: str, has_answers: bool) -> Intent:
    text = text or ""
    if not trip.days:
        return Intent.FIRST_PLAN
    if has_answers:
        return Intent.REPLAN
    if any(k in text for k in ("？", "?", "为什么", "怎么", "多少", "什么", "介绍", "讲讲")):
        return Intent.QA
    if any(
        k in text
        for k in ("改", "换", "删", "加", "重排", "重新", "起晚", "晚点", "后移", "提前", "预算", "太赶", "太满")
    ):
        return Intent.REPLAN
    if any(k in text for k in ("帮我", "能不能", "可以")):
        return Intent.CLARIFY
    return Intent.REPLAN


def _state_text(
    trip: Trip,
    text: str,
    intent: Intent,
    *,
    gaps: GapReport | None = None,
    tool_summary: str | None = None,
) -> str:
    """Jev 的 state 只放本轮意图、行程摘要、已有工具结果摘要、缺口清单（01 §2.3）。

    不放整份 Trip：无关内容多时 Jev 的准确率会下降（01 §2.1）。
    """
    summary = {
        "user_text": (text or "")[:600],
        "intent_guess": intent.value,
        "destination": trip.constraints.destination,
        "date_range": trip.constraints.date_range.model_dump(mode="json")
        if trip.constraints.date_range
        else None,
        "travelers": trip.constraints.travelers,
        "transport_mode": getattr(trip.constraints.transport_mode, "value", None),
        "days": len(trip.days),
        "stops": [
            {"name": stop.poi.name, "activities": [a.type.value for a in stop.activities]}
            for _day, stop in trip.iter_stops()
        ][:12],
        "tool_results_summary": (tool_summary or "")[:600],
        "evidence_gaps": gaps.labels() if gaps else [],
    }
    return json.dumps(summary, ensure_ascii=False)
