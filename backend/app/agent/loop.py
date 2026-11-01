"""Hand-written agent loop.

No LangGraph / Agents SDK: the loop is "call model -> execute tools -> feed
results back" plus the boundary rules from docs §4 (read concurrency, write
serialization, validator result folded into tool_result, SSE emission, context
trimming, ask_user parsing).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import defaultdict
from datetime import datetime
from typing import Any, AsyncIterator

from pydantic import ValidationError

from app.agent.prompts import SYSTEM_PROMPT, scope_hint
from app.agent.routing import Intent, ToolRouter
from app.config import Settings
from app.core.validator import validate_and_derive
from app.db import Database
from app.llm.providers import ProviderError, build_provider
from app.schemas.api import ChatRequest, ModelSelection
from app.schemas.events import EventType, SseEvent
from app.schemas.plan import AskUser, Trip
from app.schemas.tools import DraftItineraryArgs, ToolCall, ToolError, ToolName, ToolOutcome
from app.services.fact_enrichment import FactEnricher
from app.services.plan_service import PlanService, PlanWriteResult
from app.services.route_enricher import changed_legs, derive_legs
from app.services.user_profile import UserProfileStore
from app.tools.registry import ToolRegistry, WRITE

logger = logging.getLogger("trace.agent")

ASK_RE = re.compile(r"<ask_user>\s*(\{.*?\})\s*</ask_user>", re.S)
#: 模型偶尔忘写 </ask_user>：从开标签开始抓，再用平衡括号解析
ASK_OPEN_RE = re.compile(r"<ask_user>\s*(\{.*)", re.S)
#: 把整块（完整块或残缺块）从正文里摘掉，避免把 JSON 漏给用户
ASK_STRIP_RE = re.compile(r"<ask_user>.*?(?:</ask_user>|$)", re.S)

#: 模型可能用的字段别名（实测 DeepSeek 会写 q / chips / text / type）
_QUESTION_KEYS = ("question", "q", "title", "text", "label", "prompt")
_OPTION_LIST_KEYS = ("options", "chips", "choices", "items", "answers")
_OPTION_LABEL_KEYS = ("label", "text", "name", "value", "title")
_OPTION_ID_KEYS = ("id", "key", "value")
_OPTION_HINT_KEYS = ("note_hint", "hint", "placeholder", "note")
_MULTI_KEYS = ("multi", "multiple", "allow_multi", "multi_select")
_MULTI_TYPE_VALUES = {"multi", "multiple", "multi_select", "checkbox"}

#: 选择器推断：模型没写 input 时，按题面判断该用城市/日期选择器
_INPUT_VALUES = {"chips", "city", "date"}
_CITY_HINTS = ("城市", "出发地", "出发城市", "从哪里出发", "从哪出发", "哪座城市")
_DATE_HINTS = ("什么时候", "日期", "哪几天", "几号", "时间段", "出发日", "返程日")


def _now_hm() -> str:
    return datetime.now().strftime("%H:%M")


# --------------------------------------------------------------------------
# ask_user 解析（模型输出不可靠，这里做归一化而不是严格拒绝）
# --------------------------------------------------------------------------


def _first_value(source: dict[str, Any], keys: tuple[str, ...], *, text_only: bool = False):
    for key in keys:
        value = source.get(key)
        if text_only:
            if isinstance(value, str) and value.strip():
                return value.strip()
        elif value not in (None, "", [], {}):
            return value
    return None


def parse_ask_block(text: str) -> tuple[AskUser | None, str | None, bool]:
    """返回 `(提问卡, 失败原因, 是否出现过 <ask_user> 块)`。

    模型实测会写 `q` / `chips` / 字符串选项，直接 `model_validate` 会整块失败。
    这里先归一化成 AskUser 的字段，再交给 Pydantic 校验。
    """
    raw_text = text or ""
    match = ASK_RE.search(raw_text) or ASK_OPEN_RE.search(raw_text)
    if not match:
        return None, None, False
    raw = match.group(1)
    data = _parse_json_block(raw)
    if data is None:
        return None, "json", True
    payload = _normalize_ask_payload(data)
    if payload is None:
        return None, "schema", True
    if not payload.get("ask_id"):
        payload["ask_id"] = "ask_" + str(abs(hash(raw)) % 100000)
    try:
        return AskUser.model_validate(payload), None, True
    except ValidationError as exc:
        return None, f"validate: {exc.errors()[0] if exc.errors() else exc}", True


def _normalize_ask_payload(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    for wrapper in ("ask_user", "card", "ask"):
        if isinstance(data.get(wrapper), dict):
            data = data[wrapper]
            break
    questions_raw = data.get("questions")
    if isinstance(questions_raw, dict):
        questions_raw = [v for v in questions_raw.values() if isinstance(v, dict)]
    if not isinstance(questions_raw, list) or not questions_raw:
        return None

    questions: list[dict[str, Any]] = []
    for raw in questions_raw:
        if isinstance(raw, str):
            raw = {"question": raw}
        if not isinstance(raw, dict):
            continue
        title = _first_value(raw, _QUESTION_KEYS, text_only=True)
        if not title:
            continue
        multi = bool(_first_value(raw, _MULTI_KEYS))
        qtype = _first_value(raw, ("type",), text_only=True)
        if qtype and qtype.strip().lower() in _MULTI_TYPE_VALUES:
            multi = True
        raw_input = (
            _first_value(raw, ("input", "input_type", "widget", "control"), text_only=True) or ""
        ).lower()
        input_type = raw_input if raw_input in _INPUT_VALUES else _infer_input(title)
        questions.append(
            {
                "question": title[:120],
                "multi": multi,
                "options": _normalize_options(_first_value(raw, _OPTION_LIST_KEYS)),
                "note_hint": (_first_value(raw, _OPTION_HINT_KEYS, text_only=True) or None),
                "input": input_type,
            }
        )
    if not questions:
        return None

    def _flag(key: str, default: bool) -> bool:
        if key not in data:
            return default
        return bool(data.get(key))

    intro = _first_value(data, ("intro", "description", "summary"), text_only=True)
    purpose = (_first_value(data, ("purpose", "kind"), text_only=True) or "").lower()
    if purpose not in {"opening", "outline", "conflict", "other"}:
        purpose = _infer_purpose(intro or "", questions)
    return {
        "ask_id": _first_value(data, ("ask_id", "id"), text_only=True),
        "intro": intro[:300] if intro else None,
        "purpose": purpose,
        "questions": questions,
        "allow_note": _flag("allow_note", True),
        "allow_skip": _flag("allow_skip", True),
    }


def _infer_purpose(intro: str, questions: list[dict[str, Any]]) -> str:
    """模型没写 purpose 时按内容推断，保证「方案确认卡」的门禁不会被绕过。

    注意开场卡的 intro 往往也写着「为了排出合适的路线」，所以先按题目数量与题面
    判断开场卡，再看是不是「一条单选题 + 方案名选项」的方案确认卡。
    """
    titles = " ".join(str(question.get("question") or "") for question in questions)
    if len(questions) >= 3 or any(
        key in titles for key in ("几个人", "什么时候", "城市", "交通", "忌口", "几天")
    ):
        return "opening"
    labels = " ".join(
        str(option.get("label") or "")
        for question in questions
        for option in question.get("options") or []
    )
    haystack = f"{intro} {labels}"
    if "conflict" in haystack:
        return "conflict"
    if any(word in haystack for word in ("方案", "路线", "哪条", "怎么走", "慢线", "环线")):
        return "outline"
    return "opening"


def _infer_input(title: str) -> str:
    """城市/日期题给选择器，其余题保持 chips。

    这是兜底：模型没写 `input` 时（老提示词、别名输出）也能得到正确的控件。
    """
    text = title or ""
    if any(hint in text for hint in _CITY_HINTS):
        return "city"
    if any(hint in text for hint in _DATE_HINTS):
        return "date"
    return "chips"


def _normalize_options(raw: Any) -> list[dict[str, Any]]:
    items = raw
    if isinstance(items, dict):
        # 字典形态：key 当选项名，value 当说明（dict 则合并进选项）
        items = [
            (
                {"label": label, "note_hint": value}
                if isinstance(value, str)
                else {"label": label, **(value if isinstance(value, dict) else {})}
            )
            for label, value in items.items()
        ]
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        if isinstance(item, str):
            option: dict[str, Any] = {"label": item}
        elif isinstance(item, dict):
            option = item
        else:
            continue
        label = _first_value(option, _OPTION_LABEL_KEYS, text_only=True)
        if not label:
            continue
        option_id = _first_value(option, _OPTION_ID_KEYS, text_only=True) or f"o{index + 1}"
        option_id = re.sub(r"[^0-9A-Za-z_\-]", "", option_id)[:32] or f"o{index + 1}"
        while option_id in seen:
            option_id += "_"
        seen.add(option_id)
        hint = _first_value(option, _OPTION_HINT_KEYS, text_only=True)
        out.append(
            {
                "id": option_id,
                "label": label[:40],
                "note_hint": hint[:60] if hint else None,
            }
        )
    return out[:10]


def _parse_json_block(raw: str) -> dict[str, Any] | None:
    """优先严格解析，失败再用平衡括号/围栏容错。"""
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass
    from app.llm.structured import parse_json_block

    return parse_json_block(raw)


class TurnRecorder:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.tool_results: list[dict[str, Any]] = []
        self.final_trip: Trip | None = None


class AgentLoop:
    def __init__(self, settings: Settings, db: Database, registry: ToolRegistry):
        self.settings = settings
        self.db = db
        self.registry = registry
        # 写作管线和工具共用同一份来源登记簿（01 §9.1、02 §5）
        self.sources = registry.sources
        self.plans = PlanService(settings, db, self.sources)
        self.router = ToolRouter(settings, registry)
        # 字段级事实由代码并行补齐（02 §2.6 第 3 步）
        self.enricher = FactEnricher(settings, registry)
        # 长期口味档案（docs/07 §7）：无状态、每次读文件，注入 system 让模型不必再问
        self.profile = UserProfileStore(settings)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    # ------------------------------------------------------------------
    # public streaming entry
    # ------------------------------------------------------------------
    async def stream(self, trip: Trip, request: ChatRequest) -> AsyncIterator[SseEvent]:
        lock = self._locks[trip.trip_id]
        if lock.locked():
            # A second write turn on the same trip would race the plan document.
            yield SseEvent(
                seq=0,
                type=EventType.MESSAGE,
                payload={
                    "role": "assistant",
                    "text": "上一条消息还在处理中，请等它完成再发送。",
                    "at": _now_hm(),
                    "error": True,
                },
                trip_id=trip.trip_id,
            )
            return
        async with lock:
            async for event in self._stream(trip, request):
                yield event

    # ------------------------------------------------------------------
    # event emitter
    # ------------------------------------------------------------------
    async def _emit(
        self, trip_id: str, turn_id: str, etype: EventType, payload: dict[str, Any]
    ) -> SseEvent:
        seq = await self.db.reserve_seq(trip_id)
        event = SseEvent(
            seq=seq,
            type=etype,
            payload=payload,
            trip_id=trip_id,
            turn_id=turn_id,
        )
        await self.db.append_event(turn_id, event)
        return event

    # ------------------------------------------------------------------
    # core stream
    # ------------------------------------------------------------------
    async def _stream(self, trip: Trip, request: ChatRequest) -> AsyncIterator[SseEvent]:
        turns = await self.db.list_turns(trip.trip_id)
        turn_no = len(turns) + 1
        model_sel = request.model or ModelSelection(
            provider=self.settings.default_provider,
            model=self.settings.default_model,
        )
        model_label = f"{model_sel.provider}/{model_sel.model}"
        turn_id = await self.db.create_turn(trip.trip_id, model_label)
        recorder = TurnRecorder()
        current_trip = trip
        status = "done"
        error_text: str | None = None

        try:
            # user event (hidden when it is just the answer to an ask_user card)
            ctx = [t.model_dump() for t in request.context_tags]
            user_payload: dict[str, Any] = {
                "role": "user",
                "text": request.content,
                "at": _now_hm(),
                "context_tags": ctx,
            }
            if request.ask_answers or request.ask_id:
                user_payload.update(
                    {
                        "hidden": True,
                        "answer_to": request.ask_id,
                        "answers": [a.model_dump() for a in request.ask_answers],
                    }
                )
            yield await self._emit(trip.trip_id, turn_id, EventType.MESSAGE, user_payload)
            recorder.messages.append({"role": "user", "content": request.content})

            if model_sel.provider == "mock":
                async for event in self._stream_mock(
                    current_trip, request, turn_id, turn_no, recorder
                ):
                    yield event
                current_trip = recorder.final_trip or current_trip
            else:
                async for event in self._stream_llm(
                    current_trip, request, turn_id, turn_no, model_sel, recorder
                ):
                    yield event
                current_trip = recorder.final_trip or current_trip

        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception as exc:  # keep the stream alive with an explicit error
            status = "error"
            error_text = str(exc)
            try:
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.MESSAGE,
                    {
                        "role": "assistant",
                        "text": f"本轮执行失败：{exc}",
                        "at": _now_hm(),
                        "error": True,
                    },
                )
            except Exception:
                pass
        finally:
            try:
                # qa 回合不存 plan_snapshot（docs/07 §8）：问答不写 Trip JSON，
                # 其快照必然与上一回合完全相同，是纯冗余。只有写过 plan 的回合
                # （recorder.final_trip 被设置）才存快照。
                # find_snapshot 已过滤 IS NOT NULL，版本历史天然安全。
                wrote_plan_this_turn = recorder.final_trip is not None
                await self.db.finish_turn(
                    turn_id,
                    messages=recorder.messages,
                    tool_calls=recorder.tool_calls,
                    tool_results=recorder.tool_results,
                    plan_snapshot=(
                        current_trip.model_dump(mode="json")
                        if wrote_plan_this_turn and current_trip
                        else None
                    ),
                    status=status,
                    error=error_text,
                )
            except Exception:
                pass

    # ==================================================================
    # real LLM loop
    # ==================================================================
    async def _stream_llm(
        self,
        trip: Trip,
        request: ChatRequest,
        turn_id: str,
        turn_no: int,
        model_sel: ModelSelection,
        recorder: TurnRecorder,
    ) -> AsyncIterator[SseEvent]:
        provider = build_provider(self.settings, model_sel.provider)
        model = model_sel.model
        history = await self._history_messages(trip.trip_id, exclude_turn=turn_id)
        messages = await self._build_messages(trip, request, history)
        recorder.messages = [m for m in messages if m.get("role") != "system"]
        conflict_attempts: dict[str, int] = defaultdict(int)
        current_trip = trip
        wrote_plan = False
        enriched = False
        degraded_noted = False
        # 调用前的工具路由（01 §2）：意图每轮一次，工具清单每步重算
        decision = await self.router.decide(
            trip=trip,
            text=request.content,
            has_answers=bool(request.ask_answers or request.ask_id),
            has_research=await self.sources.has_tool(trip.trip_id, "dispatch_research"),
        )
        recorder.tool_results.append(
            {
                "call_id": "routing_0",
                "tool": "tool_router",
                "ok": True,
                "summary": decision.describe(),
                # 供后续标定阈值：问题文本、各工具概率、所走分支、模型版本（01 §2.3）
                "routing": _routing_payload(decision),
            }
        )
        if decision.degraded:
            degraded_noted = True
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.THINKING,
                {"text": decision.describe(), "done": True, "routing": _routing_payload(decision)},
            )

        async for event in self._emit_guarded(
            trip.trip_id,
            turn_id,
            EventType.THINKING,
            {"text": f"使用 {provider.display_name} · {model} 规划中…", "done": False},
        ):
            yield event

        for step in range(self.settings.agent_max_steps):
            if step > 0:
                decision = await self.router.decide(
                    trip=current_trip,
                    text=request.content,
                    has_answers=bool(request.ask_answers or request.ask_id),
                    has_research=await self.sources.has_tool(current_trip.trip_id, "dispatch_research"),
                    intent_override=decision.intent,
                    tool_summary=self._tool_summary(recorder),
                )
                recorder.tool_results.append(
                    {
                        "call_id": f"routing_{step}",
                        "tool": "tool_router",
                        "ok": True,
                        "summary": decision.describe(),
                        "routing": _routing_payload(decision),
                    }
                )
                # 路由降级要在时间线里留痕（01 §2.4），只记第一次
                if decision.degraded and not degraded_noted:
                    degraded_noted = True
                    yield await self._emit(
                        trip.trip_id,
                        turn_id,
                        EventType.THINKING,
                        {
                            "text": decision.describe(),
                            "done": True,
                            "routing": _routing_payload(decision),
                        },
                    )
            tools = self.registry.openai_tools(decision.allowed)
            try:
                response = await provider.chat(messages, tools, model)
            except ProviderError as exc:
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.MESSAGE,
                    {
                        "role": "assistant",
                        "text": f"模型调用失败：{exc.message}",
                        "at": _now_hm(),
                        "error": True,
                    },
                )
                return

            if response.reasoning:
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.THINKING,
                    {"text": response.reasoning[:4000], "done": True},
                )

            text = response.content or ""
            ask, ask_error, ask_found = parse_ask_block(text)
            clean_text = ASK_STRIP_RE.sub("", text).strip()
            if ask_found and ask is None:
                # 以前这种块会被静默吞掉：用户在界面上只看到一句「先确认几件事：」。
                # 现在记日志并给一条可操作的提示，绝不让本轮悄悄结束。
                logger.warning(
                    "ask_user 块解析失败（%s）：%s", ask_error, text[:2000]
                )
            if clean_text:
                payload = {"role": "assistant", "text": clean_text, "at": _now_hm(), "model": model}
                if wrote_plan and not response.tool_calls and ask is None:
                    payload["kind"] = "ready"
                yield await self._emit(trip.trip_id, turn_id, EventType.MESSAGE, payload)
                recorder.messages.append({"role": "assistant", "content": clean_text})

            if ask is not None:
                if ask.questions:
                    yield await self._emit_ask(trip.trip_id, turn_id, ask)
                else:
                    yield await self._emit(
                        trip.trip_id,
                        turn_id,
                        EventType.MESSAGE,
                        {
                            "role": "assistant",
                            "text": "提问卡生成失败（没有有效问题），请直接告诉我：几个人、什么时候去、想去哪里、去几天、从哪个城市出发、什么交通、同行人忌口。",
                            "at": _now_hm(),
                            "error": True,
                        },
                    )
                return

            if ask_found and ask is None:
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.MESSAGE,
                    {
                        "role": "assistant",
                        "text": (
                            "抱歉，这一轮的提问卡格式异常，我把它跳过了。"
                            "你可以直接告诉我这 7 项：几个人、什么时候去、想去哪里、去几天、"
                            "从哪个城市出发、主要交通形态、同行人忌口；也可以只发一句「按默认来」。"
                        ),
                        "at": _now_hm(),
                        "error": True,
                    },
                )
                return

            if not response.tool_calls:
                if not clean_text:
                    yield await self._emit(
                        trip.trip_id,
                        turn_id,
                        EventType.MESSAGE,
                        {
                            "role": "assistant",
                            "text": "我已经完成本轮检查，没有需要继续调用的工具。",
                            "at": _now_hm(),
                            **({"kind": "ready"} if wrote_plan else {}),
                        },
                    )
                return

            # assistant tool-call message for the next model round
            messages.append(
                {
                    "role": "assistant",
                    "content": response.content or None,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": json.dumps(call.arguments, ensure_ascii=False),
                            },
                        }
                        for call in response.tool_calls
                    ],
                }
            )

            # Emit every tool_call before dispatch. Read-only calls run
            # concurrently; writes run strictly one at a time.
            for call in response.tool_calls:
                recorder.tool_calls.append(
                    {"id": call.id, "name": call.name, "arguments": call.arguments}
                )
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.TOOL_CALL,
                    {
                        "call_id": call.id,
                        "tool": call.name,
                        "args": call.arguments,
                        "summary": self._describe_call(call.name, call.arguments),
                        "verbose": self._verbose_call(call.name, call.arguments),
                    },
                )

            reads = [c for c in response.tool_calls if c.name not in {w.value for w in WRITE}]
            writes = [c for c in response.tool_calls if c.name in {w.value for w in WRITE}]

            read_results: dict[str, ToolOutcome] = {}
            if reads:
                # dispatch_research 会边跑边推子 Agent 进度（SUBAGENT 事件），
                # 其余只读工具照旧并发；两者在同一个 gather 批次里执行。
                async for sub_payload in self._stream_reads(
                    reads, trip, turn_id, decision, read_results
                ):
                    yield await self._emit(
                        trip.trip_id, turn_id, EventType.SUBAGENT, sub_payload
                    )

            write_results: dict[str, tuple[ToolOutcome, PlanWriteResult | None]] = {}
            if writes:
                if len(writes) > 1:
                    for extra in writes[1:]:
                        write_results[extra.id] = (
                            ToolOutcome(
                                ok=False,
                                tool=extra.name,
                                error=None,
                                summary="写工具必须单发串行：同一轮只允许一个写工具",
                                data={"ok": False, "error": "write_concurrency"},
                            ),
                            None,
                        )
                call = writes[0]
                result = await self._apply_write(current_trip, call, request, turn_no, trigger="llm")
                write_results[call.id] = (result.outcome, result)

            for call in response.tool_calls:
                if call.id in read_results:
                    outcome = read_results[call.id]
                    result_model = self.registry.slim_for_model(call.name, outcome)
                    yield await self._emit(
                        trip.trip_id,
                        turn_id,
                        EventType.TOOL_RESULT,
                        {
                            "call_id": call.id,
                            "tool": call.name,
                            "ok": outcome.ok,
                            "summary": outcome.summary,
                            "data": outcome.data if outcome.ok else None,
                            "error": outcome.error.model_dump() if outcome.error else None,
                            "duration_ms": outcome.duration_ms,
                            "cached": outcome.cached,
                        },
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": json.dumps(result_model, ensure_ascii=False, default=str),
                        }
                    )
                    recorder.tool_results.append(
                        {
                            "call_id": call.id,
                            "tool": call.name,
                            "ok": outcome.ok,
                            "summary": outcome.summary,
                        }
                    )
                    continue

                outcome, plan_result = write_results.get(
                    call.id,
                    (
                        ToolOutcome(
                            ok=False,
                            tool=call.name,
                            summary="写工具未执行",
                            data={"ok": False},
                        ),
                        None,
                    ),
                )
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.TOOL_RESULT,
                    {
                        "call_id": call.id,
                        "tool": call.name,
                        "ok": outcome.ok,
                        "summary": outcome.summary,
                        "data": outcome.data,
                        "error": outcome.error.model_dump() if outcome.error else None,
                    },
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": json.dumps(outcome.data or {}, ensure_ascii=False, default=str),
                    }
                )
                recorder.tool_results.append(
                    {
                        "call_id": call.id,
                        "tool": call.name,
                        "ok": outcome.ok,
                        "summary": outcome.summary,
                    }
                )
                if plan_result is not None and plan_result.ok:
                    current_trip = plan_result.trip or current_trip
                    recorder.final_trip = current_trip
                    wrote_plan = True
                    patch_payload = self.plans.patch_payload(
                        plan_result,
                        self._ops_from_call(call),
                        summary_from_call(call),
                    )
                    yield await self._emit(
                        trip.trip_id, turn_id, EventType.PLAN_PATCH, patch_payload
                    )
                    async for route_event in self._emit_route_events(
                        current_trip, turn_id, patch_payload.get("changed") or {}
                    ):
                        yield route_event
                    for conflict in (plan_result.derived.conflicts if plan_result.derived else []):
                        key = f"{conflict.type}:{conflict.day_index}:{conflict.activity_id}"
                        conflict_attempts[key] += 1
                    hard = [
                        c
                        for c in (plan_result.derived.conflicts if plan_result.derived else [])
                        if c.severity.value == "error"
                    ]
                    if hard and max(conflict_attempts.values()) > 3:
                        messages.append(
                            {
                                "role": "system",
                                "content": "同一冲突已自动修 3 轮仍未通过。停止硬改，必须用 ask_user 把决定权交还用户。",
                            }
                        )

                    # 02 §2.6 第 3 步：字段级事实由代码并行补齐，不交给 LLM 猜
                    if not enriched:
                        enriched = True
                        enrichment = await self.enricher.plan_ops(
                            current_trip, trip_id=trip.trip_id, turn_id=turn_id
                        )
                        if enrichment.ok:
                            applied = await self.plans.update(
                                current_trip,
                                enrichment.ops,
                                summary="代码并行补齐字段级事实（营业时间/票务/封路）",
                                turn_seq=turn_no,
                                policy="legacy",
                            )
                            if applied.ok and applied.trip is not None:
                                current_trip = applied.trip
                                recorder.final_trip = current_trip
                                enriched_patch = self.plans.patch_payload(
                                    applied, enrichment.ops, "代码补齐字段级事实"
                                )
                                yield await self._emit(
                                    trip.trip_id,
                                    turn_id,
                                    EventType.PLAN_PATCH,
                                    enriched_patch,
                                )
                                async for route_event in self._emit_route_events(
                                    current_trip,
                                    turn_id,
                                    enriched_patch.get("changed") or {},
                                ):
                                    yield route_event
                                note = "；".join(enrichment.notes[:6])
                                yield await self._emit(
                                    trip.trip_id,
                                    turn_id,
                                    EventType.THINKING,
                                    {"text": f"字段级事实已由代码补齐：{note}", "done": True},
                                )
                                messages.append(
                                    {
                                        "role": "system",
                                        "content": (
                                            "服务端已并行调用复合工具补齐字段级事实："
                                            + note
                                            + "。这些字段已带来源，你不需要再自己写；"
                                            "未核实（clue/unverified）的字段不要在正文里当事实陈述。"
                                        ),
                                    }
                                )

            if step >= self.settings.agent_max_steps - 1:
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.MESSAGE,
                    {
                        "role": "assistant",
                        "text": "本轮工具调用步数达到上限，先停在这里。你可以继续让我调整。",
                        "at": _now_hm(),
                        **({"kind": "ready"} if wrote_plan else {}),
                    },
                )

    async def _stream_reads(
        self,
        reads: list[ToolCall],
        trip: Trip,
        turn_id: str,
        decision: Any,
        results: dict[str, ToolOutcome],
    ) -> AsyncIterator[dict[str, Any]]:
        """并发执行只读工具，并在 dispatch_research 运行时把子 Agent 进度实时吐出来。"""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def sink(payload: dict[str, Any]) -> None:
            await queue.put(payload)

        tasks = [
            asyncio.create_task(
                self.registry.execute(
                    call.name,
                    call.arguments,
                    "real",
                    trip_id=trip.trip_id,
                    turn_id=turn_id,
                    agent="main",
                    allowed=decision.allowed,
                    event_sink=sink if call.name == ToolName.DISPATCH_RESEARCH else None,
                )
            )
            for call in reads
        ]
        pending = set(tasks)
        try:
            while pending:
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {*pending, getter}, return_when=asyncio.FIRST_COMPLETED
                )
                if getter in done:
                    yield getter.result()
                else:
                    getter.cancel()
                pending = {task for task in pending if not task.done()}
            while not queue.empty():
                yield queue.get_nowait()
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        for call, outcome in zip(reads, outcomes):
            if isinstance(outcome, BaseException):
                results[call.id] = ToolOutcome(
                    ok=False,
                    tool=call.name,
                    summary=f"工具执行异常：{outcome}",
                    data={"ok": False, "error": "internal_error"},
                )
            else:
                results[call.id] = outcome

    async def _emit_guarded(self, trip_id, turn_id, etype, payload):
        yield await self._emit(trip_id, turn_id, etype, payload)

    async def _emit_route_events(self, trip: Trip, turn_id: str, changed: dict[str, Any]):
        """距离行事件（mindtrip/06 §13.2）：只在改动邻近的 leg 上发，旧客户端跳过。"""
        legs = derive_legs(trip)
        touched = changed_legs(
            legs,
            list(changed.get("stop_ids") or []),
            list(changed.get("day_indexes") or []),
        )
        for leg in touched[:24]:
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.ROUTE,
                {
                    "leg_id": leg.leg_id,
                    "from_stop_id": leg.from_stop_id,
                    "to_stop_id": leg.to_stop_id,
                    "mode": leg.mode,
                    "distance_m": leg.distance_m,
                    "duration_min": leg.duration_min,
                    "polyline_ref": None,
                    "source": leg.source,
                },
            )

    # ==================================================================
    # mock / demo agent (acceptance flow, no keys needed)
    # ==================================================================
    async def _stream_mock(
        self,
        trip: Trip,
        request: ChatRequest,
        turn_id: str,
        turn_no: int,
        recorder: TurnRecorder,
    ) -> AsyncIterator[SseEvent]:
        delay = max(0, self.settings.mock_latency_ms) / 1000
        current_trip = trip

        # 1. no plan yet -------------------------------------------------
        if not current_trip.days:
            if request.ask_answers or request.ask_id:
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.THINKING,
                    {"text": "信息齐了：8 天、上海出发、自驾。先检索路线与关键 POI，再写初版行程。", "done": True},
                )
                async for event in self._mock_tool(
                    trip.trip_id,
                    turn_id,
                    "search_poi",
                    {"keyword": "北疆 五一 自驾 环线", "city": "乌鲁木齐"},
                ):
                    yield event
                await asyncio.sleep(delay)
                async for event in self._mock_tool(
                    trip.trip_id,
                    turn_id,
                    "plan_route",
                    {"from": "乌鲁木齐", "to": "可可托海", "mode": "drive"},
                ):
                    yield event
                async for event in self._mock_tool(
                    trip.trip_id,
                    turn_id,
                    "web_search",
                    {"query": "独库公路 开放时间 2026"},
                ):
                    yield event
                async for event in self._mock_tool(
                    trip.trip_id,
                    turn_id,
                    "get_weather",
                    {"city": "阿勒泰", "date": "2026-05-01"},
                ):
                    yield event

                from app.seed.loader import load_template_trip

                template = load_template_trip()
                payload = template.model_dump(mode="json")
                payload["title"] = "新疆环线 · 五一自驾"
                result = await self.plans.draft(
                    current_trip,
                    payload,
                    summary="生成初版北疆 8 日环线：乌鲁木齐—可可托海—喀纳斯/禾木—赛里木湖—伊宁",
                    user_request=request.content,
                    turn_seq=turn_no,
                )
                if not result.ok:
                    yield await self._emit(
                        trip.trip_id,
                        turn_id,
                        EventType.MESSAGE,
                        {
                            "role": "assistant",
                            "text": f"行程写入失败：{result.outcome.summary}",
                            "at": _now_hm(),
                            "error": True,
                        },
                    )
                    return
                recorder.final_trip = result.trip
                current_trip = result.trip or current_trip
                patch_payload = self.plans.patch_payload(
                    result, [{"op": "draft_itinerary"}], "初版行程"
                )
                yield await self._emit(
                    trip.trip_id, turn_id, EventType.PLAN_PATCH, patch_payload
                )
                async for route_event in self._emit_route_events(
                    current_trip, turn_id, patch_payload.get("changed") or {}
                ):
                    yield route_event
                summary_text = (
                    "已经排好初版 **8 天北疆环线**：\n\n"
                    "#### 整体思路\n"
                    "- **顺时针大环线**：乌鲁木齐 → 可可托海 → 喀纳斯/禾木 → 魔鬼城 → 赛里木湖 → 伊宁 → 特克斯，不走回头路\n"
                    "- 上海往返飞机，**乌鲁木齐取车、伊宁还车**（异地还车费约 ¥600）\n"
                    "- 按 relaxed 节奏，每天驾驶尽量控制在 5 小时内\n\n"
                    "有一个问题需要你知道：**独库公路 5 月初大概率还没开放**（往年 6 月上旬通车）。"
                    "我先按「特克斯+琼库什台」排了 D7 替代，你可以随时让我改。"
                )
                place_line = self._spotlight_line(current_trip, limit=6)
                summary_text = summary_text + ("\n\n" + place_line if place_line else "")
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.MESSAGE,
                    {
                        "role": "assistant",
                        "text": summary_text,
                        "at": _now_hm(),
                        "kind": "ready",
                        "model": "Mock · Trace Planner",
                    },
                )
                recorder.messages.append({"role": "assistant", "content": summary_text})
                return

            # first user message: 一张卡问全 7 项，每项都是 chips 且可跳过（02 §4.1）
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.THINKING,
                {
                    "text": "先确认 7 件事，再开始检索；跳过的项会写进 assumptions，而不是凭空假设。",
                    "done": True,
                },
            )
            ask = AskUser(
                ask_id="ask_trip_basics",
                intro="为了排出合适的路线，先确认这几件事（都可以跳过）",
                questions=[
                    {
                        "question": "几个人去？",
                        "multi": False,
                        "options": [
                            {"id": "p1", "label": "1 人"},
                            {"id": "p2", "label": "2 人", "note_hint": "默认按 2 人估算"},
                            {"id": "p3", "label": "3–4 人"},
                            {"id": "p5", "label": "5 人以上", "note_hint": "例如：两家人一起，4 大 2 小"},
                        ],
                        "note_hint": "影响门票、包车与自驾座位",
                    },
                    {
                        "question": "什么时候去？",
                        "multi": False,
                        "options": [
                            {"id": "wuyi", "label": "五一"},
                            {"id": "duanwu", "label": "端午"},
                            {"id": "shuqi", "label": "暑期"},
                            {"id": "other", "label": "其他日期", "note_hint": "例如：6.6–6.13"},
                        ],
                        "note_hint": "影响季节性开放、机票与节假日加价",
                    },
                    {
                        "question": "想去哪里？",
                        "multi": True,
                        "options": [
                            {"id": "xinjiang", "label": "新疆"},
                            {"id": "xizang", "label": "西藏"},
                            {"id": "yunnan", "label": "云南"},
                            {"id": "qinghai", "label": "青海"},
                            {"id": "other", "label": "其他地方", "note_hint": "写城市或区域，例如：川西"},
                        ],
                        "note_hint": "目的地必须拿到，其余项可以跳过",
                    },
                    {
                        "question": "去几天？",
                        "multi": False,
                        "options": [
                            {"id": "d4", "label": "4 天"},
                            {"id": "d6", "label": "6 天"},
                            {"id": "d8", "label": "8 天"},
                            {"id": "other", "label": "其他天数", "note_hint": "例如：10 天"},
                        ],
                        "note_hint": "决定 days 的长度",
                    },
                    {
                        "question": "从哪个城市出发？",
                        "multi": False,
                        "options": [
                            {"id": "sh", "label": "上海"},
                            {"id": "bj", "label": "北京"},
                            {"id": "gz", "label": "广州"},
                            {"id": "cd", "label": "成都"},
                            {"id": "other", "label": "其他城市", "note_hint": "例如：杭州"},
                        ],
                        "note_hint": "影响机票与首末日安排",
                    },
                    {
                        "question": "主要交通形态？",
                        "multi": False,
                        "options": [
                            {"id": "drive", "label": "全程自驾"},
                            {"id": "flight_drive", "label": "飞机 + 当地租车"},
                            {"id": "charter", "label": "包车"},
                            {"id": "train", "label": "高铁 + 公共交通"},
                        ],
                        "note_hint": "决定路线结构与全程导航方式",
                    },
                    {
                        "question": "同行人有什么忌口？",
                        "multi": True,
                        "options": [
                            {"id": "none", "label": "没有"},
                            {"id": "kid", "label": "带小孩"},
                            {"id": "elder", "label": "带老人"},
                            {"id": "halal", "label": "清真"},
                            {"id": "veg", "label": "素食"},
                        ],
                        "note_hint": "只影响本趟，不会写进长期口味档案",
                    },
                ],
                allow_note=True,
                allow_skip=True,
            )
            yield await self._emit_ask_event(trip.trip_id, turn_id, ask)
            return

        # 2. plan exists --------------------------------------------------
        text = request.content
        ctx = request.context_tags

        if self._looks_like_replan(text, ctx):
            async for event in self._mock_replan(current_trip, request, turn_id, turn_no, recorder):
                yield event
            return

        if self._looks_like_conflict_choice(text):
            async for event in self._mock_conflict_choice(current_trip, request, turn_id, turn_no, recorder):
                yield event
            return

        if "预算" in text or "多少钱" in text:
            derived = self.plans.derive(current_trip)
            b = derived.budget_summary
            md = (
                f"当前预算概览（{current_trip.constraints.travelers} 人，不含住宿）：\n"
                f"- 门票 ¥{b.tickets_total:,.0f}\n"
                f"- 餐饮预估 ¥{b.food_est_total:,.0f} · 交通（机票+租车+油费+过路费）¥{b.transit_est_total:,.0f}\n"
                f"- **合计 ¥{b.grand_total:,.0f}**"
                + (f"，预算 ¥{b.budget_total:,.0f} 内，余量 ¥{b.budget_total - b.grand_total:,.0f}" if b.budget_total else "")
            )
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.MESSAGE,
                {"role": "assistant", "text": md, "at": _now_hm()},
            )
            recorder.messages.append({"role": "assistant", "content": md})
            return

        if "预订" in text or "买票" in text or "门票" in text:
            derived = self.plans.derive(current_trip)
            lines = ["预订提醒（按最迟下单日期倒排）："]
            for item in derived.booking_timeline[:8]:
                lines.append(
                    f"- {item.order_by or '—'} · {item.title}"
                    + (f" · {item.channel_hint}" if item.channel_hint else "")
                )
            lines.append("\n完整清单在顶栏「预订提醒」里，可以逐项勾选已订。")
            md = "\n".join(lines)
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.MESSAGE,
                {"role": "assistant", "text": md, "at": _now_hm()},
            )
            recorder.messages.append({"role": "assistant", "content": md})
            return

        # generic contextual reply
        day = None
        if ctx:
            tag = next((t for t in ctx if t.day_index), None)
            if tag:
                day = next((d for d in current_trip.days if d.day_index == tag.day_index), None)
        if "酒店" in text or "住宿" in text:
            md = (
                "住宿我只排「住在哪个地点」，不写酒店名、价格和渠道。"
                "告诉我你更想住景区内还是县城，我会用补丁把当晚的 stay 活动换到对应地点，其余天不动。"
            )
        elif day:
            md = (
                f"收到。我现在定位在 **Day {day.day_index} · {day.theme}**。"
                "你希望只改当天，还是后面几天也一起调整？直接说「只改今天」或「后面都往后推」即可。"
            )
        else:
            md = (
                "收到。我会结合当前行程上下文处理。你可以：\n"
                "- 点任意卡片上的「改这里」，针对该节点提出变更\n"
                "- 问「预算」查看当前估算\n"
                "- 在冲突面板里处理独库公路的季节性问题\n\n"
                "当前行程是 v{}，{} 天 / {} 个地点。".format(
                    current_trip.version,
                    len(current_trip.days),
                    sum(len(d.stops) for d in current_trip.days),
                )
            )
            day_ctx = day or (current_trip.days[0] if current_trip.days else None)
            if day_ctx is not None:
                names = "、".join(
                    f"[[poi:{stop.stop_id}]]" for stop in day_ctx.stops[:4]
                )
                if names:
                    md += f"\n\n今天这几个点你可以直接在地图上点：{names}"
        yield await self._emit(
            trip.trip_id,
            turn_id,
            EventType.MESSAGE,
            {"role": "assistant", "text": md, "at": _now_hm()},
        )
        recorder.messages.append({"role": "assistant", "content": md})

    # ------------------------------------------------------------------
    # mock helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _spotlight_line(trip: Trip, limit: int = 6) -> str:
        """给 mock 回复注入地点占位符：让 P0 的 chip / 候选 / 高亮有数据可验。"""
        stops = [stop for _day, stop in trip.iter_stops()][:limit]
        if not stops:
            return ""
        chips = " · ".join(f"[[poi:{stop.stop_id}]]" for stop in stops)
        return f"本轮重点：{chips}"

    async def _mock_tool(
        self, trip_id: str, turn_id: str, name: str, args: dict[str, Any]
    ) -> AsyncIterator[SseEvent]:
        call_id = f"mock_{name}_{int(time.time() * 1000) % 100000}"
        yield await self._emit(
            trip_id,
            turn_id,
            EventType.TOOL_CALL,
            {
                "call_id": call_id,
                "tool": name,
                "args": args,
                "summary": self._describe_call(name, args),
                "verbose": self._verbose_call(name, args),
            },
        )
        outcome = await self.registry.execute(
            name, args, "mock", trip_id=trip_id, turn_id=turn_id, agent="main"
        )
        await asyncio.sleep(max(0, self.settings.mock_latency_ms) / 1000)
        yield await self._emit(
            trip_id,
            turn_id,
            EventType.TOOL_RESULT,
            {
                "call_id": call_id,
                "tool": name,
                "ok": outcome.ok,
                "summary": outcome.summary,
                "data": outcome.data,
                "error": outcome.error.model_dump() if outcome.error else None,
                "duration_ms": outcome.duration_ms,
            },
        )

    async def _mock_replan(
        self,
        trip: Trip,
        request: ChatRequest,
        turn_id: str,
        turn_no: int,
        recorder: TurnRecorder,
    ) -> AsyncIterator[SseEvent]:
        day3 = next((d for d in trip.days if d.day_index == 3), None)
        stop_ids = {s.stop_id for d in trip.days for s in d.stops}
        if day3 is None or not {"d3s1", "d3s4"}.issubset(stop_ids):
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.MESSAGE,
                {
                    "role": "assistant",
                    "text": "我定位到了这个节点，但当前行程不是演示用的北疆案例，暂时没有可套用的重规划脚本。"
                    "你可以直接描述要改的时间或地点，我会用补丁修改。",
                    "at": _now_hm(),
                },
            )
            return

        explanation = (
            "我会把 **Day 3** 起床时间改到 `13:00`，并后移当天活动：\n"
            "- **删除** 五彩滩（时间不够）\n"
            "- **取消** 三湾徒步，改为喀纳斯湖边车览（顺带解决与禾木日落的时间重叠警告）\n"
            "- **保留** 禾木日落观景，住宿不变\n\n"
            "只改 Day 3，其余 7 天不动。"
        )
        yield await self._emit(
            trip.trip_id,
            turn_id,
            EventType.MESSAGE,
            {"role": "assistant", "text": explanation, "at": _now_hm()},
        )
        recorder.messages.append({"role": "assistant", "content": explanation})

        async for event in self._mock_tool(
            trip.trip_id,
            turn_id,
            "plan_route",
            {"from": "阿勒泰", "to": "禾木", "mode": "drive"},
        ):
            yield event
        async for event in self._mock_tool(
            trip.trip_id,
            turn_id,
            "web_search",
            {"query": "禾木 5月3日 日落时间"},
        ):
            yield event

        ops = [
            {
                "op": "set_day_rhythm",
                "day_index": 3,
                "rhythm": {"wake": "13:00", "sleep": "23:30"},
            },
            {
                "op": "remove_activity",
                "activity_id": "d3s1a2",
            },
            {
                "op": "remove_activity",
                "activity_id": "d3s1a3",
            },
            {
                "op": "update_activity",
                "activity_id": "d3s1a1",
                "patch": {
                    "title": "可可托海 → 阿勒泰 → 布尔津 · 自驾转场",
                    "time_window": {"start": "13:00", "end": "17:30"},
                    "note": "下午出发，路上简餐",
                },
            },
            {"op": "remove_stop", "stop_id": "d3s2"},
            {
                "op": "update_activity",
                "activity_id": "d3s3a1",
                "patch": {
                    "title": "喀纳斯湖 · 三湾车览（不徒步）",
                    "time_window": {"start": "17:30", "end": "18:10"},
                    "note": "时间不够，取消徒步，改为湖边车览远眺",
                    "tips": ["只停观景台，不下栈道", "19:40 前必须到禾木观景台"],
                },
            },
            {
                "op": "update_activity",
                "activity_id": "d3s4a1",
                "patch": {"time_window": {"start": "19:40", "end": "21:30"}},
            },
        ]
        result = await self.plans.update(
            trip,
            ops,
            summary="Day3 作息 09:00→13:00，删除五彩滩，三湾徒步改车览，禾木日落保留",
            user_request=request.content,
            turn_seq=turn_no,
        )
        yield await self._emit(
            trip.trip_id,
            turn_id,
            EventType.TOOL_RESULT,
            {
                "call_id": "mock_update_itinerary",
                "tool": "update_itinerary",
                "ok": result.ok,
                "summary": result.outcome.summary,
                "data": result.outcome.data,
                "error": result.outcome.error.model_dump() if result.outcome.error else None,
            },
        )
        if not result.ok or result.trip is None:
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.MESSAGE,
                {
                    "role": "assistant",
                    "text": f"补丁没有落地：{result.outcome.summary}",
                    "at": _now_hm(),
                    "error": True,
                },
            )
            return
        recorder.final_trip = result.trip
        patch_payload = self.plans.patch_payload(result, ops, "Day 3 局部重规划")
        yield await self._emit(
            trip.trip_id, turn_id, EventType.PLAN_PATCH, patch_payload
        )
        async for route_event in self._emit_route_events(
            result.trip, turn_id, patch_payload.get("changed") or {}
        ):
            yield route_event
        summary_md = (
            "**Day 3 已重排完成**（v{}）：\n"
            "- 作息 `09:00` → `13:00`，删除五彩滩；三湾徒步改为车览\n"
            "- 阿勒泰简餐取消，直接进山；转场 `13:00–17:30`\n"
            "- 喀纳斯湖保留 **三湾车览**（不徒步），禾木日落完整保留 `19:40–21:30`\n"
            "- 顺带消除了「三湾徒步 × 禾木日落」的时间重叠警告\n\n"
            "改动只涉及 Day 3 的 2 个 stop 与 3 条连线。"
        ).format(result.trip.version)
        yield await self._emit(
            trip.trip_id,
            turn_id,
            EventType.MESSAGE,
            {"role": "assistant", "text": summary_md, "at": _now_hm(), "kind": "summary"},
        )
        recorder.messages.append({"role": "assistant", "content": summary_md})

    async def _mock_conflict_choice(
        self, trip: Trip, request: ChatRequest, turn_id: str, turn_no: int, recorder: TurnRecorder
    ) -> AsyncIterator[SseEvent]:
        text = request.content
        must_go = trip.constraints.must_go
        is_keep = any(k in text for k in ("保持", "保留", "下次", "keep"))
        is_replace = any(k in text for k in ("赛里木湖", "替换", "换"))
        if is_keep or is_replace:
            remaining = [m.model_dump(mode="json") for m in must_go if "独库" not in m.name]
            if is_replace:
                remaining.append({"name": "赛里木湖", "amap_poi_id": "B03E700I9K", "lng": 81.1671, "lat": 44.6083, "city": "博乐", "source_ref": "poi:seed:sayram"})
            result = await self.plans.update(
                trip,
                [{"op": "set_constraints", "patch": {"must_go": remaining}}],
                summary="独库公路移出必去清单，保留现有 D7 替代方案",
                user_request=text,
                turn_seq=turn_no,
            )
            if result.ok and result.trip:
                recorder.final_trip = result.trip
                yield await self._emit(
                    trip.trip_id,
                    turn_id,
                    EventType.PLAN_PATCH,
                    self.plans.patch_payload(
                        result,
                        [{"op": "set_constraints", "patch": {"must_go": remaining}}],
                        "处理季节封路冲突",
                    ),
                )
                md = (
                    "已记录你的决定：**保持现方案**。\n"
                    "- 「独库公路」从必去清单移到「下次再来」\n"
                    "- D7 继续走特克斯 + 琼库什台\n"
                    "- 季节性封路冲突已解除\n\n"
                    "其余行程不变。"
                )
            else:
                md = f"处理失败：{result.outcome.summary}"
            yield await self._emit(
                trip.trip_id,
                turn_id,
                EventType.MESSAGE,
                {"role": "assistant", "text": md, "at": _now_hm()},
            )
            recorder.messages.append({"role": "assistant", "content": md})
            return

        md = (
            "改到 6 月会牵动机票日期与全程住宿，我先把影响说清楚：\n"
            "- 日期整体后移，Day 1–8 的机票/酒店都需要重查\n"
            "- 独库公路 6 月上旬通常刚通车，仍需确认当年公告\n\n"
            "告诉我具体日期（如 6.6–6.13），我会按新日期生成一版并给出 diff。"
        )
        yield await self._emit(
            trip.trip_id,
            turn_id,
            EventType.MESSAGE,
            {"role": "assistant", "text": md, "at": _now_hm()},
        )
        recorder.messages.append({"role": "assistant", "content": md})

    async def _emit_ask(self, trip_id: str, turn_id: str, ask: AskUser) -> SseEvent:
        return await self._emit(
            trip_id,
            turn_id,
            EventType.ASK_USER,
            ask.model_dump(mode="json"),
        )

    async def _emit_ask_event(self, trip_id: str, turn_id: str, ask: AskUser) -> SseEvent:
        return await self._emit_ask(trip_id, turn_id, ask)

    # ==================================================================
    # tool / message helpers
    # ==================================================================
    async def _apply_write(
        self, trip: Trip, call: ToolCall, request: ChatRequest, turn_no: int, trigger: str
    ) -> PlanWriteResult:
        tool = call.name
        args = call.arguments
        if tool == ToolName.DRAFT_ITINERARY:
            # 初版行程前有两道硬门禁（用户明确说「直接排」时一并放行）：
            #   1. 先派子 Agent 调研，拿回结构化摘要；
            #   2. 先给用户 2–3 条路线方案并确认。
            # 这两步都是产品流程的一部分，不能靠模型自觉。
            if not trip.days and not self._draft_bypass(request):
                if not await self._research_evidence(trip):
                    return self._write_error(
                        tool,
                        "还没有任何目的地级调研记录。禁止直接写初版行程："
                        "先调用 dispatch_research 派子 Agent 查攻略/玩法/交通/天候，"
                        "拿到结构化摘要后再写。search_poi 只给坐标，不能代替调研。",
                    )
                if not await self._draft_gate_open(trip, request):
                    return self._write_error(
                        tool,
                        "还没有和用户确认路线方案。禁止直接写初版行程："
                        "先用正文给出 2–3 条路线方案（主题 / 核心节点 / 天数分配 / 适合谁 / 代价），"
                        "再用 ask_user(purpose=\"outline\") 让用户选一条；用户选定后再调用 draft_itinerary。",
                    )
            payload, summary, error = self._normalize_draft_args(args)
            if error:
                return self._write_error(tool, error)
            try:
                parsed = DraftItineraryArgs.model_validate({"trip": payload, "summary": summary})
            except ValidationError as exc:
                first = exc.errors()[0] if exc.errors() else {}
                loc = ".".join(str(x) for x in first.get("loc", []))
                detail = f"{loc}: {first.get('msg', '参数不合法')}".strip(": ")
                return self._write_error(tool, f"draft_itinerary 参数不合法：{detail}")
            if not parsed.trip.get("days"):
                return self._write_error(
                    tool,
                    "draft_itinerary 必须包含至少一天（trip.days 非空）；空行程会被拒绝。"
                    "请重新写全量，不要用 Raw 字符串。",
                )
            return await self.plans.draft(
                trip,
                parsed.trip,
                summary=parsed.summary,
                user_request=request.content,
                turn_seq=turn_no,
                policy="agent",
            )
        if tool == ToolName.UPDATE_ITINERARY:
            return await self.plans.update(
                trip,
                args.get("ops") or [],
                summary=args.get("summary"),
                user_request=request.content,
                turn_seq=turn_no,
                policy="agent",
            )
        return PlanWriteResult(
            ok=False,
            outcome=ToolOutcome(
                ok=False,
                tool=tool,
                summary=f"未知写工具：{tool}",
                data={"ok": False, "error": "unknown_write_tool"},
            ),
        )

    @staticmethod
    def _normalize_draft_args(
        args: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, str | None, str | None]:
        """Normalize the draft tool args.

        Some providers/models return the whole plan as a single JSON string under
        a wrapper key (observed: `{"Raw": "<json>"}`). That would otherwise make
        `_apply_write` pass `{}` to `draft_trip`, silently writing an empty trip.
        This helper unwraps known wrapper keys and returns a clear error instead
        of letting a malformed payload become a valid empty version.
        """
        summary = args.get("summary") if isinstance(args.get("summary"), str) else None
        trip = args.get("trip")
        if isinstance(trip, str):
            try:
                trip = json.loads(trip)
            except Exception:
                trip = None
        if isinstance(trip, dict):
            return trip, summary, None

        for key in ("Raw", "raw", "input", "arguments", "payload"):
            value = args.get(key)
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except Exception as exc:
                    return None, summary, (
                        f"draft_itinerary 的 {key} 不是合法 JSON（{exc}）。"
                        "请直接传结构化的 {trip: {...}, summary: \"...\"}，"
                        "trip.days 至少一天，不要用 Raw 字符串。"
                    )
                if isinstance(parsed, dict):
                    if isinstance(parsed.get("trip"), dict):
                        nested_summary = parsed.get("summary")
                        return (
                            parsed["trip"],
                            summary or (nested_summary if isinstance(nested_summary, str) else None),
                            None,
                        )
                    return parsed, summary, None
            elif isinstance(value, dict):
                if isinstance(value.get("trip"), dict):
                    nested_summary = value.get("summary")
                    return (
                        value["trip"],
                        summary or (nested_summary if isinstance(nested_summary, str) else None),
                        None,
                    )
                return value, summary, None

        return None, summary, (
            "draft_itinerary 缺少 trip 对象。请直接传结构化的 {trip: {...}, summary: \"...\"}，"
            "trip.days 至少一天；不要用 Raw 字符串。"
        )

    #: 用户明确授权「直接排」时的放行词，避免门禁把人卡死
    DRAFT_BYPASS_WORDS = (
        "直接排",
        "就按这个",
        "按这个来",
        "不用确认",
        "开始排",
        "就按你说的",
        "你决定",
    )

    def _draft_bypass(self, request: ChatRequest) -> bool:
        text = request.content or ""
        return any(word in text for word in self.DRAFT_BYPASS_WORDS)

    async def _research_evidence(self, trip: Trip) -> bool:
        """本趟是否真的跑过子 Agent 调研（登记簿里有 dispatch_research 记录）。"""
        try:
            return await self.sources.has_tool(trip.trip_id, "dispatch_research")
        except Exception:  # noqa: BLE001 - 登记簿不可用时按未调研处理
            return False

    async def _draft_gate_open(self, trip: Trip, request: ChatRequest) -> bool:
        """用户是否已经确认过路线方案（purpose=outline 的提问卡）。

        三种放行方式：
        1. 这轮是对 `purpose="outline"` 提问卡的回答（点卡片提交）；
        2. 用户明确说「直接排 / 就按这个」；
        3. 用户用自由文本回答了上一条方案卡，例如直接打 `C` / 「选 C」。
        第 3 种很重要：用户不一定点卡片，不能让流程卡在门禁上。
        """
        text = request.content or ""
        try:
            events = await self.db.get_events_after(trip.trip_id, 0)
        except Exception:  # noqa: BLE001 - 读事件失败时按未确认处理
            events = []
        asks = [
            event.payload or {}
            for event in events
            if event.type == EventType.ASK_USER
        ]

        if request.ask_id:
            for payload in asks:
                if payload.get("ask_id") == request.ask_id:
                    return payload.get("purpose") == "outline"

        if any(word in text for word in self.DRAFT_BYPASS_WORDS):
            return True

        # 自由文本回答方案卡：匹配上一个问题卡里的选项 id / 方案名
        if asks:
            last = asks[-1]
            if last.get("purpose") == "outline":
                tokens = {token.lower() for token in re.findall(r"[0-9A-Za-z]+", text)}
                for question in last.get("questions") or []:
                    for option in question.get("options") or []:
                        option_id = str(option.get("id") or "").strip()
                        label = str(option.get("label") or "")
                        if option_id and option_id.lower() in tokens:
                            return True
                        if option_id and f"方案{option_id}".lower() in text.lower():
                            return True
                        if label and label[:6] in text:
                            return True
        return False

    @staticmethod
    def _write_error(tool: str, message: str) -> PlanWriteResult:
        return PlanWriteResult(
            ok=False,
            outcome=ToolOutcome(
                ok=False,
                tool=tool,
                error=ToolError(tool=tool, code="validation_error", message=message),
                summary=f"行程写入被拒绝：{message}",
                data={"ok": False, "error": message},
            ),
        )

    @staticmethod
    def _ops_from_call(call: ToolCall) -> list[dict[str, Any]]:
        if call.name == ToolName.DRAFT_ITINERARY:
            return [{"op": "draft_itinerary"}]
        return call.arguments.get("ops") or []

    @staticmethod
    def _tool_summary(recorder: TurnRecorder) -> str:
        """给 Jev 的「已有工具结果摘要」（01 §2.3）：只要名字与成败，不放正文。"""
        rows = [
            f"{item.get('tool')}:{'ok' if item.get('ok') else 'fail'}"
            for item in recorder.tool_results
            if item.get("tool") and item.get("tool") != "tool_router"
        ]
        return "、".join(rows[-10:])

    @staticmethod
    def _describe_call(name: str, args: dict[str, Any]) -> str:
        if name == ToolName.SEARCH_POI:
            return f"正在搜索「{args.get('keyword', '')}」…"
        if name == ToolName.PLAN_ROUTE:
            return f"正在计算 {args.get('from', '')} → {args.get('to', '')} 路程…"
        if name == ToolName.WEB_SEARCH:
            return f"正在检索「{args.get('query', '')}」…"
        if name == ToolName.GET_WEATHER:
            return f"正在查询 {args.get('city', '')} 天气…"
        if name == ToolName.DRAFT_ITINERARY:
            return "正在写入初版行程…"
        if name == ToolName.UPDATE_ITINERARY:
            return f"正在应用 {len(args.get('ops') or [])} 处行程补丁…"
        if name == ToolName.TICKET_CHANNEL_LOOKUP:
            return f"正在查「{args.get('poi', '')}」的门票与购票渠道…"
        if name == ToolName.OPENING_HOURS_LOOKUP:
            return f"正在查「{args.get('poi', '')}」的营业时间…"
        if name == ToolName.CLOSURE_NOTICE_LOOKUP:
            return f"正在查「{args.get('target', '')}」的封路与季节开放公告…"
        if name == ToolName.PERMIT_POLICY_LOOKUP:
            return f"正在查「{args.get('region', '')}」的准入政策…"
        if name == ToolName.TRANSPORT_INFO_LOOKUP:
            return f"正在查 {args.get('from', '')} → {args.get('to', '')} 的购票渠道…"
        if name == ToolName.CLIMATE_REFERENCE:
            return f"正在查 {args.get('city', '')} 的气候参考…"
        if name == ToolName.SUN_TIMES:
            return "正在计算日出日落…"
        if name == ToolName.HOLIDAY_CALENDAR:
            return "正在查节假日与调休…"
        if name == ToolName.SEARCH_AROUND:
            return "正在搜索周边地点…"
        if name == ToolName.PLACE_DETAIL:
            return "正在读取地点详情…"
        if name == ToolName.SOCIAL_DIGEST:
            return f"正在抓「{args.get('keyword', '')}」的公开攻略…"
        if name == ToolName.DISPATCH_RESEARCH:
            tasks = args.get("tasks") or []
            return f"正在派 {len(tasks)} 个子 Agent 并行调研…"
        if name == ToolName.SUBMIT_FINDINGS:
            return "正在提交调研结论…"
        if name == ToolName.FETCH_PAGE:
            return f"正在抓取 {args.get('url', '')}…"
        return f"正在调用 {name}…"

    @staticmethod
    def _verbose_call(name: str, args: dict[str, Any]) -> str:
        try:
            return json.dumps(args, ensure_ascii=False)[:800]
        except Exception:
            return str(args)[:800]

    @staticmethod
    def _extract_ask(text: str) -> AskUser | None:
        """解析 `<ask_user>` 块；解析失败返回 None（调用方负责提示用户，不能静默）。"""
        ask, _error, _found = parse_ask_block(text)
        return ask

    @staticmethod
    def _looks_like_replan(text: str, tags: list) -> bool:
        has_day3 = any(getattr(t, "day_index", None) == 3 for t in tags) or bool(
            re.search(r"阿勒泰|Day\s*3|第\s*3\s*天", text)
        )
        wants = bool(re.search(r"起晚|下午|重规划|重排|重新排|后移|改一下", text))
        return has_day3 and wants

    @staticmethod
    def _looks_like_conflict_choice(text: str) -> bool:
        return bool(re.search(r"独库|保持现方案|改到\s*6\s*月|换成赛里木湖", text))

    # ==================================================================
    # context building
    # ==================================================================
    async def _history_messages(self, trip_id: str, exclude_turn: str | None = None) -> list[dict[str, str]]:
        events = await self.db.get_events_after(trip_id, 0)
        out: list[dict[str, str]] = []
        for event in events:
            if event.turn_id == exclude_turn:
                continue
            if event.type != EventType.MESSAGE:
                continue
            payload = event.payload
            role = payload.get("role")
            if role not in {"user", "assistant"}:
                continue
            if payload.get("hidden"):
                continue
            text = (payload.get("text") or "").strip()
            if not text:
                continue
            out.append({"role": role, "content": text})
        return out[-12:]

    def _profile_hint(self) -> str:
        """把长期口味档案渲染成 system 提示（docs/07 §7）。

        忌口在前（硬约束）、偏好在后。未设置时如实说明，让模型知道"可以问"，
        而不是假装用户没有偏好。同行人忌口不在此列——那是每趟 ask_user 的事。
        """
        try:
            profile = self.profile.load()
        except Exception:
            return "（未设置；如影响用餐安排可在提问卡里询问忌口）"
        if not profile.diet and not profile.taste:
            return "（未设置；如影响用餐安排可在提问卡里询问忌口）"
        parts = []
        if profile.diet:
            parts.append("忌口（硬约束，必须避开）：" + "、".join(profile.diet))
        if profile.taste:
            parts.append("口味偏好：" + "、".join(profile.taste))
        return "；".join(parts)

    async def _evidence_hint(self, trip_id: str) -> str:
        """把本趟已发出的 source_ref 列给模型：写事实字段时只能引用这些（01 §9.1）。"""
        try:
            rows = await self.sources.entries(trip_id)
        except Exception:  # noqa: BLE001
            rows = []
        if not rows:
            return "（本趟还没有工具证据；写事实字段前先调用对应工具）"
        lines: list[str] = []
        seen: set[str] = set()
        for row in rows:
            ref = str(row.get("source_ref") or "")
            if not ref or ref in seen:
                continue
            seen.add(ref)
            lines.append(
                f"- {row.get('tool')} · {row.get('origin')} · ref={ref}"
                + (f" · {row.get('url')}" if row.get("url") else "")
                + (f" · agent={row.get('agent')}" if row.get("agent") not in (None, "main") else "")
            )
        return "\n".join(lines[-30:])

    async def _build_messages(
        self, trip: Trip, request: ChatRequest, history: list[dict[str, str]]
    ) -> list[dict[str, Any]]:
        plan = trip.model_copy(deep=True)
        plan.revision_log = plan.revision_log[-5:]
        derived = validate_and_derive(plan, self.settings.demo_today if self.settings.demo_mode else None)
        conflicts = [
            {
                "type": c.type.value,
                "severity": c.severity.value,
                "day_index": c.day_index,
                "stop_id": c.stop_id,
                "activity_id": c.activity_id,
                "message": c.message,
                "suggested_fix": c.suggested_fix,
            }
            for c in derived.conflicts
        ]
        scope = scope_hint(
            [t.model_dump() for t in request.context_tags],
            [a.model_dump() for a in request.ask_answers] if request.ask_answers else None,
        )
        user_text = request.content
        if scope:
            user_text = f"{scope}\n\n{user_text}"
        system = (
            SYSTEM_PROMPT
            + "\n\n# 今天\n"
            + (self.settings.demo_today.isoformat() if self.settings.demo_mode else datetime.now().date().isoformat())
            + "\n\n# 用户长期口味档案（服务端记忆，不要重复问）\n"
            + self._profile_hint()
            + "\n\n# 本趟已获得的工具证据（source_ref 只能引用这里出现过的）\n"
            + await self._evidence_hint(trip.trip_id)
            + "\n\n# 当前行程（权威文档，服务端持有）\n```json\n"
            + json.dumps(plan.model_dump(mode="json"), ensure_ascii=False, default=str)
            + "\n```\n\n# 最近一次校验结果\n```json\n"
            + json.dumps(
                {
                    "conflicts": conflicts,
                    "budget": derived.budget_summary.model_dump(mode="json"),
                    "booking_count": len(derived.booking_timeline),
                    "ok": derived.ok,
                },
                ensure_ascii=False,
                default=str,
            )
            + "\n```\n"
        )
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_text})
        return messages


def _routing_payload(decision) -> dict[str, Any]:
    """路由记录：问题文本、各工具概率、所走分支、模型版本，供后续标定阈值（01 §2.3）。"""
    return {
        "intent": decision.intent.value,
        "degraded": decision.degraded,
        "reason": decision.reason,
        "forced": decision.forced,
        "released": decision.released,
        "gaps": decision.gaps.labels(),
        "model_version": decision.model_version,
        "records": decision.records[:12],
    }


def summary_from_call(call: ToolCall) -> str:
    if call.name == ToolName.DRAFT_ITINERARY:
        return "生成初版行程"
    if call.name == ToolName.UPDATE_ITINERARY:
        return call.arguments.get("summary") or "应用行程补丁"
    return call.name
