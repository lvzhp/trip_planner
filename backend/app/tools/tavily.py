"""Tavily web search client (docs §2 `web_search`)."""

from __future__ import annotations

import hashlib
import json

import httpx

from app.config import Settings
from app.schemas.tools import ToolError, WebResultItem, WebSearchResult




class TavilyError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        self.message = message
        self.retryable = retryable
        super().__init__(message)

    def as_error(self, tool: str) -> ToolError:
        return ToolError(tool=tool, code="tavily_error", message=self.message, retryable=self.retryable)


class TavilyClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.key = settings.tavily_api_key

    @property
    def configured(self) -> bool:
        return bool(self.key)

    async def search(self, query: str, max_results: int = 3) -> WebSearchResult:
        if not self.key:
            raise TavilyError("未配置 TAVILY_API_KEY", retryable=False)
        try:
            async with httpx.AsyncClient(timeout=25.0, trust_env=self.settings.http_trust_env) as client:
                resp = await client.post(
                    f"{self.settings.tavily_base_url.rstrip('/')}/search",
                    json={
                        "api_key": self.key,
                        "query": query,
                        "max_results": max_results,
                        "search_depth": "basic",
                        "include_answer": True,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            raise TavilyError(f"Tavily 请求失败：{exc}", retryable=True) from exc

        results = [
            WebResultItem(
                title=item.get("title") or "",
                url=item.get("url"),
                content=(item.get("content") or "")[:600],
                score=item.get("score"),
            )
            for item in (data.get("results") or [])[:3]
        ]
        payload = {
            "query": query,
            "results": [r.model_dump() for r in results],
            "conclusion": data.get("answer"),
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        payload["source_ref"] = f"web:{hashlib.sha1(raw.encode()).hexdigest()[:12]}"
        return WebSearchResult.model_validate(payload)
