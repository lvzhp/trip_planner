"""子 Agent 调研运行器（docs/new-plan 02 §2）。

一个子 Agent = 固定铁律 system prompt + 主 Agent 写的 `goal` + 代码生成的工具清单，
在受限步数内循环，收尾必须调用 `submit_findings` 提交 JSON，再由 Pydantic 校验。

几条硬规则都在这里落地：

- 工具清单由代码计算（角色白名单 − deny_tools − 禁用集 + submit_findings），
  **同一份清单**既渲染进 user prompt，又作为 `tools` 参数传给 provider（02 §2.2）；
- 执行层再校验一次工具名，因为 `providers.py` 不校验、`registry.execute` 只查存在性；
- 子 Agent 看不到 `dispatch_research`，所以无法递归派子 Agent；
- 步数用完还没提交 → 追加一轮「只能输出 JSON」的收尾请求，解析失败重试一次，
  仍失败 `status=failed` 并把原因写进 gaps，不用自由文本凑数（02 §1、§2.5）；
- 演示模式 / Mock provider → 明确 `not_configured`，不用脚本化 fixture 兜底（02 §2.8）。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

from pydantic import ValidationError

from app.config import Settings
from app.llm.providers import ProviderError, build_provider
from app.schemas.research import (
    ROLE_PRESETS,
    SUBAGENT_DENIED,
    Finding,
    FindingKind,
    Findings,
    FindingsStatus,
    ResearchResult,
    ResearchStep,
    ResearchTask,
    ResearchTaskList,
    ResearchTrace,
)
from app.schemas.tools import ToolCall, ToolName, ToolSpec
from app.services.source_registry import is_builtin_ref

#: 单个贵工具在一个子 Agent 内的调用次数上限（初值，待标定）。
TOOL_CALL_LIMITS: dict[str, int] = {
    "social_digest": 2,
    "fetch_page": 3,
    "dispatch_research": 0,
}

#: 固定铁律：写在 system prompt，工具说明放 user prompt（02 §2.2）。
SUBAGENT_SYSTEM = """你是 Trace Planner 的**只读调研子 Agent**。你的产出不是聊天，而是一份结构化结论。

# 铁律（不可违反）
1. 只读：不写行程、不发提问卡、不派子 Agent。你只能调用下面列出的工具。
2. 事实（kind=fact）必须来自工具返回，并且 `source_refs` 里只能放**工具返回过的** ref；
   编造的 ref 会被服务端丢弃。
3. 经验（kind=experience）必须带引文 quote、链接 url 和发布日期 published_at；
   三者缺一就不许提交这一条。
4. 没查到就写进 `gaps`，**不要补写**、不要用自己的记忆填事实。
5. 收尾必须调用 `submit_findings`，把 JSON 作为函数调用参数提交。
6. `summary` 是给人读的摘要，有长度上限；不要贴原文，不要贴检索结果的整段正文。
"""


class ResearchUnavailable(Exception):
    def __init__(self, code: str, message: str, missing: str | None = None):
        self.code = code
        self.message = message
        self.missing = missing
        super().__init__(message)


def compute_allowed(role: str, deny_tools: list[str]) -> set[str]:
    """`(角色默认白名单 - deny_tools) - {派子 Agent/写行程/提问} + {submit_findings}`"""
    base = set(ROLE_PRESETS.get(role, []))
    denied = set(deny_tools or [])
    return (base - denied) - SUBAGENT_DENIED | {ToolName.SUBMIT_FINDINGS.value}


def render_tools_prompt(specs: list[ToolSpec]) -> str:
    """把同一份工具清单渲染成 user prompt 里的说明（02 §2.2）。"""
    if not specs:
        return "（本次没有可用工具，请直接调用 submit_findings 报告 gaps）"
    blocks: list[str] = []
    for spec in specs:
        params = json.dumps(spec.parameters, ensure_ascii=False)
        blocks.append(f"- `{spec.name}`：{spec.description}\n  参数 schema：{params}")
    return "\n".join(blocks)


def build_task_prompt(task: ResearchTask, specs: list[ToolSpec], *, max_tool_calls: int, max_steps: int) -> str:
    return f"""# 你的任务
{task.goal}

# 上下文（主 Agent 提供）
```json
{json.dumps(task.context or {}, ensure_ascii=False)}
```

# 可用工具（由服务端计算，你只能调用这些）
{render_tools_prompt(specs)}

# 运行限制
- 步数上限 {max_steps}，工具调用总数上限 {max_tool_calls}；
- 单个贵工具另有调用次数上限，超限会被拒绝；
- 摘要不超过 {task.max_summary_chars} 字。

# 收尾
调用 `submit_findings`，参数结构：
{{"task_id": "{task.task_id}", "role": "{task.role.value}", "status": "ok|partial|failed",
  "summary": "不超过 {task.max_summary_chars} 字的摘要",
  "findings": [{{"kind": "fact|experience|clue", "claim": "...", "source_refs": ["工具返回的 ref"],
                "evidence": [{{"url": "...", "published_at": "YYYY-MM-DD", "quote": "原文引文"}}],
                "confidence": "low|medium|high"}}],
  "gaps": ["没查到的部分"], "tool_calls_used": 0}}
"""


class ResearchRunner:
    def __init__(self, settings: Settings, registry: Any):
        self.settings = settings
        self.registry = registry

    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        return bool(self.settings.llm_configured) and (
            self.settings.default_provider or "mock"
        ) != "mock"

    async def run(
        self,
        raw_tasks: Any,
        *,
        trip_id: str | None = None,
        turn_id: str | None = None,
        sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> list[ResearchResult]:
        if not self.available:
            raise ResearchUnavailable(
                "not_configured",
                "子 Agent 调研未配置：无 Key 或使用 Mock provider 时不派真实调研，"
                "请到「接入配置」接入模型",
                missing="LLM",
            )
        try:
            tasks = ResearchTaskList.model_validate({"tasks": raw_tasks}).tasks
        except ValidationError as exc:
            first = exc.errors()[0] if exc.errors() else {}
            raise ResearchUnavailable(
                "bad_args", f"dispatch_research 参数不合法：{first.get('msg', '格式错误')}"
            ) from exc

        semaphore = asyncio.Semaphore(max(1, self.settings.subagent_max_concurrency))

        async def one(task: ResearchTask) -> ResearchResult:
            async with semaphore:
                try:
                    return await asyncio.wait_for(
                        self._run_task(task, trip_id=trip_id, turn_id=turn_id, sink=sink),
                        timeout=max(10, self.settings.subagent_timeout_seconds),
                    )
                except asyncio.TimeoutError:
                    return await self._notify_failed(task, "超时：子 Agent 没在限定时间内收尾", None, sink)
                except Exception as exc:  # noqa: BLE001 - 单个子 Agent 失败不拖垮整批
                    return await self._notify_failed(task, f"执行失败：{exc}", None, sink)

        return list(await asyncio.gather(*[one(t) for t in tasks]))

    # ------------------------------------------------------------------
    async def _run_task(
        self,
        task: ResearchTask,
        *,
        trip_id: str | None,
        turn_id: str | None,
        sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> ResearchResult:
        allowed = compute_allowed(task.role.value, task.deny_tools)
        specs = [s for s in self.registry.specs if s.name in allowed]
        allowed = {s.name for s in specs}
        tools = [s.openai_tool() for s in specs]
        model = self.settings.subagent_model or self.settings.default_model
        provider = build_provider(self.settings, self.settings.default_provider)

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SUBAGENT_SYSTEM},
            {
                "role": "user",
                "content": build_task_prompt(
                    task,
                    specs,
                    max_tool_calls=self.settings.subagent_max_tool_calls,
                    max_steps=self.settings.subagent_max_steps,
                ),
            },
        ]

        tool_calls = 0
        per_tool: dict[str, int] = {}
        agent = f"sub:{task.task_id}"
        submitted: dict[str, Any] | None = None
        steps: list[ResearchStep] = []
        started = time.perf_counter()

        await _emit_progress(
            sink,
            {
                "task_id": task.task_id,
                "role": task.role.value,
                "goal": task.goal,
                "model": model,
                "state": "started",
                "allowed_tools": sorted(allowed),
            },
        )

        async def record(
            kind: str,
            *,
            tool: str | None = None,
            args: dict[str, Any] | None = None,
            ok: bool | None = None,
            summary: str | None = None,
            duration_ms: int | None = None,
        ) -> None:
            step = ResearchStep(
                index=len(steps) + 1,
                kind=kind,  # type: ignore[arg-type]
                tool=tool,
                args=_trim_args(args or {}),
                ok=ok,
                summary=(summary or "")[:300] or None,
                duration_ms=duration_ms,
            )
            steps.append(step)
            # 实时推给前端：子 Agent 独立页面边跑边看每一步
            await _emit_progress(
                sink,
                {
                    "task_id": task.task_id,
                    "role": task.role.value,
                    "state": "step",
                    "step": step.model_dump(mode="json"),
                },
            )

        for step in range(self.settings.subagent_max_steps):
            response = await self._chat(provider, messages, tools, model)
            if response is None:
                await record("error", summary="模型调用失败（重试后仍不可用）", ok=False)
                return await self._notify_failed(
                    task,
                    "模型调用失败（重试后仍不可用）",
                    _trace(task, model, steps, tool_calls, started, "failed", "模型调用失败"),
                    sink,
                )
            calls = list(response.tool_calls or [])
            if not calls:
                # 没有工具调用：允许模型直接把 JSON 写在正文里（宽松解析，仍要校验）
                candidate = _parse_json(response.content)
                if candidate is not None:
                    submitted = candidate
                    await record("submit", tool="submit_findings", summary="正文 JSON 提交")
                break

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
                        for call in calls
                    ],
                }
            )
            for call in calls:
                if call.name == ToolName.SUBMIT_FINDINGS:
                    submitted = dict(call.arguments or {})
                    findings_count = len((submitted.get("findings") or []))
                    await record(
                        "submit",
                        tool="submit_findings",
                        args=call.arguments,
                        ok=True,
                        summary=f"提交 {findings_count} 条结论",
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": json.dumps({"ok": True, "received": True}),
                        }
                    )
                    continue
                call_started = time.perf_counter()
                outcome = await self._execute_tool(
                    task,
                    call,
                    allowed=allowed,
                    per_tool=per_tool,
                    tool_calls=tool_calls,
                    trip_id=trip_id,
                    turn_id=turn_id,
                )
                duration = int((time.perf_counter() - call_started) * 1000)
                if outcome is not None:
                    tool_calls += 1
                    per_tool[call.name] = per_tool.get(call.name, 0) + 1
                await record(
                    "tool",
                    tool=call.name,
                    args=call.arguments,
                    ok=bool(outcome and outcome.get("ok")),
                    summary=_outcome_summary(outcome),
                    duration_ms=duration,
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": json.dumps(outcome or {"ok": False}, ensure_ascii=False, default=str),
                    }
                )
            if submitted is not None:
                break
            if tool_calls >= self.settings.subagent_max_tool_calls:
                messages.append(
                    {
                        "role": "user",
                        "content": "工具调用已达上限，不要再调用工具，立刻调用 submit_findings 提交现有结论。",
                    }
                )

        if submitted is None:
            submitted = await self._closing_turn(provider, messages, model, task)
            await record(
                "closing",
                ok=submitted is not None,
                summary="步数用尽，追加「只能输出 JSON」收尾："
                + ("成功" if submitted is not None else "失败"),
            )
        if submitted is None:
            return await self._notify_failed(
                task,
                "步数用完仍未提交结构化结论（兜底收尾也失败）",
                _trace(task, model, steps, tool_calls, started, "failed", "未提交结构化结论"),
                sink,
            )

        result = await self._validate(task, submitted, tool_calls)
        result.trace = _trace(
            task, model, steps, tool_calls, started, result.status.value, result.error
        )
        await _emit_progress(
            sink,
            {
                "task_id": task.task_id,
                "role": task.role.value,
                "state": "finished",
                "status": result.status.value,
                "summary": result.summary,
                "gaps": result.gaps,
                "findings_count": len(result.findings),
                "duration_ms": result.trace.duration_ms,
                "steps_used": result.trace.steps_used,
                "tool_calls_used": result.trace.tool_calls_used,
                "error": result.error,
            },
        )
        return result

    async def _execute_tool(
        self,
        task: ResearchTask,
        call: ToolCall,
        *,
        allowed: set[str],
        per_tool: dict[str, int],
        tool_calls: int,
        trip_id: str | None,
        turn_id: str | None,
    ) -> dict[str, Any] | None:
        """执行一次允许的工具；超限/越界返回显式错误（执行层再校验一次）。"""
        if call.name not in allowed:
            return {
                "ok": False,
                "error": "tool_not_allowed",
                "message": f"工具 {call.name} 不在本子 Agent 的清单里",
            }
        limit = TOOL_CALL_LIMITS.get(call.name)
        if limit is not None and per_tool.get(call.name, 0) >= limit:
            return {
                "ok": False,
                "error": "tool_quota_exceeded",
                "message": f"{call.name} 本次最多调用 {limit} 次",
            }
        if tool_calls >= self.settings.subagent_max_tool_calls:
            return {
                "ok": False,
                "error": "tool_budget_exceeded",
                "message": "工具调用总数已达上限",
            }
        outcome = await self.registry.execute(
            call.name,
            call.arguments,
            "real",
            trip_id=trip_id,
            turn_id=turn_id,
            agent=f"sub:{task.task_id}",
            allowed=allowed,
        )
        from app.tools.registry import ToolRegistry

        return ToolRegistry.slim_for_model(call.name, outcome)

    async def _closing_turn(
        self,
        provider: Any,
        messages: list[dict[str, Any]],
        model: str,
        task: ResearchTask,
    ) -> dict[str, Any] | None:
        """步数用完仍未提交：追加一轮「只能输出 JSON」的收尾请求（02 §1）。"""
        schema_hint = (
            '{"task_id": "' + task.task_id + '", "role": "' + task.role.value + '", '
            '"status": "ok|partial|failed", "summary": "摘要", '
            '"findings": [{"kind": "fact|experience|clue", "claim": "...", '
            '"source_refs": ["ref"], "evidence": [{"url": "...", "published_at": "YYYY-MM-DD", '
            '"quote": "..."}], "confidence": "low|medium|high"}], '
            '"gaps": ["..."], "tool_calls_used": 0}'
        )
        closing = [
            *messages,
            {
                "role": "user",
                "content": (
                    "不要再调用工具。只输出一个 JSON 对象，不要 markdown 代码块，不要解释。格式：\n"
                    + schema_hint
                ),
            },
        ]
        for attempt in range(2):  # 校验失败重试一次
            response = await self._chat(provider, closing, [], model)
            if response is None:
                return None
            parsed = _parse_json(response.content)
            if parsed is not None:
                return parsed
            closing.append({"role": "assistant", "content": (response.content or "")[:2000]})
            closing.append(
                {"role": "user", "content": "上面的输出不是合法 JSON 对象，请只输出 JSON 对象。"}
            )
        return None

    async def _chat(self, provider: Any, messages, tools, model) -> Any:
        """自带有限次退避重试：providers.py 不重试，只把 429/5xx 标成 retryable。"""
        attempts = max(1, self.settings.subagent_retry_times + 1)
        for attempt in range(attempts):
            try:
                return await provider.chat(messages, tools, model)
            except ProviderError as exc:
                if not exc.retryable or attempt >= attempts - 1:
                    return None
                await asyncio.sleep(0.5 * (2**attempt))
        return None

    # ------------------------------------------------------------------
    async def _validate(
        self, task: ResearchTask, raw: dict[str, Any], tool_calls: int
    ) -> ResearchResult:
        raw = dict(raw or {})
        raw.setdefault("task_id", task.task_id)
        raw.setdefault("role", task.role.value)
        raw["task_id"] = task.task_id
        raw["role"] = task.role.value
        raw["tool_calls_used"] = max(tool_calls, int(raw.get("tool_calls_used") or 0))
        try:
            findings = Findings.model_validate(raw)
        except ValidationError as exc:
            return self._failed(task, f"submit_findings 校验失败：{exc.errors()[0] if exc.errors() else exc}")

        known: set[str] = set()
        try:
            known = await self.registry.sources.known(None)
        except Exception:  # noqa: BLE001 - 登记簿不可用时只在结构上校验
            known = set()

        kept: list[Finding] = []
        dropped: list[str] = []
        for index, finding in enumerate(findings.findings, start=1):
            reason = _reject_reason(finding, known)
            if reason:
                dropped.append(f"第 {index} 条（{finding.kind.value}）被丢弃：{reason}")
                continue
            kept.append(finding)

        gaps = list(findings.gaps)
        gaps.extend(dropped)
        summary = (findings.summary or "").strip()
        if len(summary) > task.max_summary_chars:
            summary = summary[: task.max_summary_chars] + "…"

        status = findings.status
        if findings.findings and not kept:
            status = FindingsStatus.FAILED
            gaps.append("所有结论条目都没通过校验，本次按失败处理")
        elif dropped or findings.status == FindingsStatus.PARTIAL:
            status = FindingsStatus.PARTIAL

        return ResearchResult(
            task_id=task.task_id,
            role=task.role,
            status=status,
            summary=summary,
            findings=kept,
            gaps=gaps,
            tool_calls_used=findings.tool_calls_used,
            dropped=dropped,
            independent_sources=_independent_sources(kept),
        )

    # ------------------------------------------------------------------
    async def _notify_failed(
        self,
        task: ResearchTask,
        reason: str,
        trace: ResearchTrace | None,
        sink: Callable[[dict[str, Any]], Awaitable[None]] | None,
    ) -> ResearchResult:
        await _emit_progress(
            sink,
            {
                "task_id": task.task_id,
                "role": task.role.value,
                "state": "finished",
                "status": "failed",
                "summary": "",
                "gaps": [reason],
                "findings_count": 0,
                "duration_ms": trace.duration_ms if trace else None,
                "steps_used": trace.steps_used if trace else 0,
                "tool_calls_used": trace.tool_calls_used if trace else 0,
                "error": reason,
            },
        )
        return self._failed(task, reason, trace)

    def _failed(
        self,
        task: ResearchTask,
        reason: str,
        trace: ResearchTrace | None = None,
    ) -> ResearchResult:
        return ResearchResult(
            task_id=task.task_id,
            role=task.role,
            status=FindingsStatus.FAILED,
            summary="",
            gaps=[reason],
            error=reason,
            trace=trace,
        )


async def _emit_progress(
    sink: Callable[[dict[str, Any]], Awaitable[None]] | None,
    payload: dict[str, Any],
) -> None:
    """向 SSE 推一条子 Agent 进度；前端断线/回调异常都不能影响调研本身。"""
    if sink is None:
        return
    try:
        await sink(payload)
    except Exception:  # noqa: BLE001
        pass


def _trim_args(args: dict[str, Any]) -> dict[str, Any]:
    """只保留给人看的参数摘要：长文本截断，列表/字典只记规模。"""
    out: dict[str, Any] = {}
    for key, value in (args or {}).items():
        if isinstance(value, str):
            out[str(key)] = value[:120] + ("…" if len(value) > 120 else "")
        elif isinstance(value, (int, float, bool)) or value is None:
            out[str(key)] = value
        elif isinstance(value, list):
            out[str(key)] = f"[{len(value)} 项]"
        else:
            out[str(key)] = f"{{{len(value)} 字段}}" if isinstance(value, dict) else str(type(value).__name__)
    return out


def _outcome_summary(outcome: dict[str, Any] | None) -> str | None:
    if not outcome:
        return None
    if outcome.get("ok"):
        return str(outcome.get("summary") or "成功")[:200]
    error = outcome.get("error")
    if isinstance(error, dict):
        return f"失败：{error.get('message') or error.get('code') or '未知错误'}"[:200]
    return f"失败：{outcome.get('message') or '未知错误'}"[:200]


def _trace(
    task: ResearchTask,
    model: str,
    steps: list[ResearchStep],
    tool_calls: int,
    started: float,
    status: str,
    error: str | None,
) -> ResearchTrace:
    return ResearchTrace(
        task_id=task.task_id,
        role=task.role,
        goal=task.goal,
        model=model,
        status=status,  # type: ignore[arg-type]
        duration_ms=int((time.perf_counter() - started) * 1000),
        steps_used=len(steps),
        tool_calls_used=tool_calls,
        steps=steps,
        error=error,
    )


def _reject_reason(finding: Finding, known: set[str] | None = None) -> str | None:
    """校验不过的条目被丢弃并记入 gaps（02 §2.5、§5）。"""
    if finding.kind == FindingKind.FACT:
        if not finding.source_refs:
            return "事实必须引用工具返回的 source_ref"
        if known is not None:
            unknown = [
                ref
                for ref in finding.source_refs
                if ref and ref not in known and not is_builtin_ref(ref)
            ]
            if unknown:
                return f"source_ref 不在来源登记簿里：{', '.join(unknown[:3])}"
        if not finding.claim.strip():
            return "claim 为空"
        return None
    if finding.kind == FindingKind.EXPERIENCE:
        usable = [
            e
            for e in finding.evidence
            if e.url and e.published_at and (e.quote or "").strip()
        ]
        if not usable:
            return "经验必须带引文、链接和发布日期"
        return None
    if not finding.claim.strip():
        return "claim 为空"
    return None


def _independent_sources(findings: list[Finding]) -> int:
    """独立来源数按域名去重（不采信模型自己报的数字）。"""
    domains: set[str] = set()
    for finding in findings:
        for evidence in finding.evidence:
            host = (urlparse(evidence.url or "").hostname or "").lower()
            if host:
                domains.add(host)
    return len(domains)


def _parse_json(text: str | None) -> dict[str, Any] | None:
    from app.llm.structured import parse_json_block

    return parse_json_block(text or "")


__all__ = [
    "ResearchRunner",
    "ResearchUnavailable",
    "compute_allowed",
    "render_tools_prompt",
    "build_task_prompt",
    "SUBAGENT_SYSTEM",
]
