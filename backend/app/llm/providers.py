"""LLM provider abstraction.

The loop only needs `chat(messages, tools) -> ProviderResponse`.  Adding a
model backend means adding one implementation + one config entry (docs §6.7).
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import Settings
from app.schemas.tools import ToolCall


class ProviderError(Exception):
    def __init__(self, message: str, code: str = "provider_error", retryable: bool = False):
        self.message = message
        self.code = code
        self.retryable = retryable
        super().__init__(message)


@dataclass
class ProviderResponse:
    content: str = ""
    reasoning: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


class Provider(ABC):
    id: str = "base"
    display_name: str = "Base"

    def __init__(self, settings: Settings):
        self.settings = settings

    @abstractmethod
    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str
    ) -> ProviderResponse: ...


class MockProvider(Provider):
    """Minimal echo provider. The demo loop bypasses this with the scripted
    acceptance agent, but keeping it makes provider switching testable."""

    id = "mock"
    display_name = "Mock"

    async def chat(self, messages, tools, model):
        last = next((m for m in reversed(messages) if m.get("role") == "user"), None)
        text = last.get("content") if last else ""
        return ProviderResponse(
            content=f"（Mock 模型）收到：{text[:200]}。请在 .env 配置真实模型 API Key 以启用联网规划。",
            finish_reason="stop",
            usage={"prompt_tokens": 0, "completion_tokens": 0},
        )


class OpenAICompatibleProvider(Provider):
    """DeepSeek / Qwen / OpenAI / custom OpenAI-compatible endpoints."""

    def __init__(self, settings: Settings, provider_id: str, api_key: str, base_url: str):
        super().__init__(settings)
        self.id = provider_id
        self.display_name = {
            "deepseek": "DeepSeek",
            "qwen": "Qwen",
            "openai": "OpenAI",
            "custom": "自定义兼容端点",
        }.get(provider_id, provider_id)
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    async def chat(self, messages, tools, model) -> ProviderResponse:
        if not self.api_key and self.id != "custom":
            raise ProviderError(f"{self.id} 未配置 API Key", code="no_key")
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": 0.2,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        url = f"{self.base_url}/chat/completions"
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        calls: dict[int, dict[str, Any]] = {}
        finish_reason = "stop"
        usage: dict[str, Any] = {}
        try:
            async with httpx.AsyncClient(timeout=180.0, trust_env=self.settings.http_trust_env) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode(errors="ignore")[:800]
                        raise ProviderError(
                            f"{self.id} HTTP {resp.status_code}: {body}",
                            retryable=resp.status_code in {429, 500, 502, 503, 504},
                        )
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            chunk = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if chunk.get("usage"):
                            usage = chunk["usage"]
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        if delta.get("content"):
                            content_parts.append(delta["content"])
                        if delta.get("reasoning_content"):
                            reasoning_parts.append(delta["reasoning_content"])
                        for tc in delta.get("tool_calls") or []:
                            idx = int(tc.get("index", 0))
                            slot = calls.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""}
                            )
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
                        if choice.get("finish_reason"):
                            finish_reason = choice["finish_reason"]
        except httpx.HTTPError as exc:
            raise ProviderError(f"{self.id} 连接失败：{exc}", retryable=True) from exc

        parsed_calls: list[ToolCall] = []
        for idx in sorted(calls):
            slot = calls[idx]
            if not slot["name"]:
                continue
            try:
                args = json.loads(slot["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {"_raw": slot["arguments"]}
            parsed_calls.append(
                ToolCall(
                    id=slot["id"] or f"call_{idx}",
                    name=slot["name"],
                    arguments=args,
                )
            )
        return ProviderResponse(
            content="".join(content_parts),
            reasoning="".join(reasoning_parts),
            tool_calls=parsed_calls,
            finish_reason=finish_reason,
            usage=usage,
        )


class AnthropicProvider(Provider):
    id = "anthropic"
    display_name = "Anthropic"

    def __init__(self, settings: Settings, api_key: str, base_url: str):
        super().__init__(settings)
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    async def chat(self, messages, tools, model) -> ProviderResponse:
        if not self.api_key:
            raise ProviderError("Anthropic 未配置 API Key", code="no_key")
        system_parts: list[str] = []
        converted: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role")
            if role == "system":
                system_parts.append(str(msg.get("content") or ""))
            elif role == "tool":
                converted.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": msg.get("tool_call_id"),
                                "content": str(msg.get("content") or ""),
                            }
                        ],
                    }
                )
            elif role == "assistant":
                blocks: list[dict[str, Any]] = []
                if msg.get("content"):
                    blocks.append({"type": "text", "text": str(msg["content"])})
                for call in msg.get("tool_calls") or []:
                    fn = call.get("function") or {}
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    blocks.append(
                        {"type": "tool_use", "id": call.get("id"), "name": fn.get("name"), "input": args}
                    )
                if blocks:
                    converted.append({"role": "assistant", "content": blocks})
            else:
                converted.append({"role": "user", "content": str(msg.get("content") or "")})

        payload = {
            "model": model,
            "max_tokens": 8192,
            "system": "\n\n".join(system_parts),
            "messages": converted,
            "temperature": 0.2,
            "tools": [
                {
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"],
                }
                for t in tools
            ],
        }
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=180.0, trust_env=self.settings.http_trust_env) as client:
                resp = await client.post(f"{self.base_url}/messages", json=payload, headers=headers)
                if resp.status_code >= 400:
                    raise ProviderError(
                        f"Anthropic HTTP {resp.status_code}: {resp.text[:800]}",
                        retryable=resp.status_code in {429, 500, 502, 503, 504},
                    )
                data = resp.json()
        except httpx.HTTPError as exc:
            raise ProviderError(f"Anthropic 连接失败：{exc}", retryable=True) from exc

        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in data.get("content") or []:
            if block.get("type") == "text":
                text_parts.append(block.get("text") or "")
            elif block.get("type") == "tool_use":
                calls.append(
                    ToolCall(
                        id=block.get("id") or "call",
                        name=block.get("name") or "",
                        arguments=block.get("input") or {},
                    )
                )
        return ProviderResponse(
            content="".join(text_parts),
            tool_calls=calls,
            finish_reason=data.get("stop_reason") or "stop",
            usage=data.get("usage") or {},
            raw=data,
        )


def build_provider(settings: Settings, provider: str) -> Provider:
    provider = (provider or settings.default_provider).lower()
    if provider == "mock":
        return MockProvider(settings)
    if provider == "deepseek":
        return OpenAICompatibleProvider(
            settings, "deepseek", settings.deepseek_api_key, settings.deepseek_base_url
        )
    if provider == "qwen":
        return OpenAICompatibleProvider(
            settings, "qwen", settings.qwen_api_key, settings.qwen_base_url
        )
    if provider == "openai":
        return OpenAICompatibleProvider(
            settings, "openai", settings.openai_api_key, settings.openai_base_url
        )
    if provider == "anthropic":
        return AnthropicProvider(settings, settings.anthropic_api_key, settings.anthropic_base_url)
    if provider == "custom":
        if not settings.custom_base_url:
            raise ProviderError("自定义端点需要 CUSTOM_BASE_URL（本地模型可填任意 Key 或留空）", code="no_key")
        return OpenAICompatibleProvider(
            settings, "custom", settings.custom_api_key, settings.custom_base_url
        )
    raise ProviderError(f"未知 provider：{provider}", code="unknown_provider")
