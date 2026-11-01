"""结构化抽取（docs/new-plan 02 §1）。

现状（providers.py:86-94）：请求体没有 `response_format`，`tool_choice` 固定为
`auto`。所以结构化靠「函数调用参数 + Pydantic 校验」或「要求只输出 JSON + 解析 +
校验」，不靠 JSON mode。这里实现后者，并严格遵守两条兜底：

- 解析/校验失败重试一次；
- 仍失败返回 `None`，调用方把字段留空显示「待核实」，绝不用自由文本凑数。
"""

from __future__ import annotations

import json
import re
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.llm.providers import ProviderError, build_provider

T = TypeVar("T", bound=BaseModel)

FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def llm_available(settings: Settings) -> bool:
    return bool(settings.llm_configured) and (settings.default_provider or "mock") != "mock"


def parse_json_block(text: str) -> dict[str, Any] | None:
    """从模型输出里取出第一个 JSON 对象。容忍 ```json 围栏和前后废话。"""
    if not text:
        return None
    fenced = FENCE_RE.search(text)
    raw = fenced.group(1) if fenced else text
    raw = raw.strip()
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(raw)):
        char = raw[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(raw[start : index + 1])
                except json.JSONDecodeError:
                    return None
                return value if isinstance(value, dict) else None
    return None


async def extract_structured(
    settings: Settings,
    *,
    system: str,
    user: str,
    schema: type[T],
    model: str | None = None,
    retries: int = 1,
) -> T | None:
    """让便宜模型把检索结果压成 schema。不可用时返回 None（调用方降级为 clue）。"""
    if not llm_available(settings):
        return None
    try:
        provider = build_provider(settings, settings.default_provider)
    except ProviderError:
        return None
    target_model = model or settings.subagent_model or settings.default_model
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    last_error: str | None = None
    for attempt in range(retries + 1):
        try:
            response = await provider.chat(messages, [], target_model)
        except ProviderError:
            return None
        parsed = parse_json_block(response.content or "")
        if parsed is None:
            last_error = "输出不是合法 JSON 对象"
        else:
            try:
                return schema.model_validate(parsed)
            except ValidationError as exc:
                last_error = str(exc.errors()[0] if exc.errors() else exc)
        if attempt < retries:
            messages.append({"role": "assistant", "content": (response.content or "")[:2000]})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "上面的输出不可用：" + (last_error or "格式不合法")
                        + "。只输出一个 JSON 对象，不要 markdown 代码块，不要解释。"
                    ),
                }
            )
    return None
