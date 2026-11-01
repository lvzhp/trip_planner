"""DeepSeek 搜索 / Fetch 客户端（docs/new-plan 01 §4.1）。

1. 只用官方文档里读到的两个端点：`POST /v1/tools/search`、`POST /v1/tools/fetch`；
2. 响应字段按文档取：`rerank_score`（0–3，≥1.5 优质）、`authority`（-1–4，≥3 极权威）、
   `date`、`snippet`、`summary`、`content`；
3. 文档没写的地方（真实响应外壳、限流数值）用容错解析兜住，读不到就返回显式错误，
   绝不拿模型记忆补写。

未核实项（01 §12）：真实响应外壳、QPS、计费口径。实现时只依赖「有结果就带 url/正文」
这一最小契约。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import Settings
from app.schemas.sources import SourceType

#: 官方域名后缀。命中即视为官方站点（01 §4.2「官方域名页面」）。
OFFICIAL_SUFFIXES = (
    ".gov.cn",
    "gov.cn",
    ".gov",
    ".edu.cn",
)


@dataclass
class SearchHit:
    """两个检索源统一后的结果。Tavily 没有 authority/date，就是 None。"""

    provider: str
    title: str = ""
    url: str | None = None
    snippet: str = ""
    summary: str = ""
    content: str = ""
    published_at: str | None = None
    authority: int | None = None
    rerank_score: float | None = None
    source_type: SourceType = SourceType.OTHER
    source_ref: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def text(self, limit: int = 900) -> str:
        raw = self.summary or self.content or self.snippet
        return (raw or "")[:limit]


class DeepSeekSearchError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)


def source_type_of(url: str | None) -> SourceType:
    """按域名粗分来源类型（官方站点 / 政府 / OTA / 游记 / 其他）。

    这只是「展示与权威度初判」用的启发式；真正的 verified 判定仍要求官方域名或
    DeepSeek 的 authority ≥ 3（01 §4.2），不看这个分类。
    """
    if not url:
        return SourceType.OTHER
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return SourceType.OTHER
    if host.endswith(OFFICIAL_SUFFIXES):
        return SourceType.GOVERNMENT
    if any(k in host for k in ("ctrip", "trip.com", "meituan", "fliggy", "qunar", "ly.com", "mafengwo.cn/ticket")):
        return SourceType.OTA
    if any(k in host for k in ("mafengwo", "xiaohongshu", "zhihu", "douban", "bilibili", "weibo", "douyin", "tieba", "sohu", "163.com")):
        return SourceType.TRAVEL_NOTE
    if any(k in host for k in ("wikipedia", "baike.")):
        return SourceType.REFERENCE
    return SourceType.OTHER


def is_official_url(url: str | None) -> bool:
    return source_type_of(url) in {
        SourceType.OFFICIAL,
        SourceType.ANNOUNCEMENT,
        SourceType.GOVERNMENT,
    }


def _hit_ref(provider: str, payload: Any) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return f"web:{hashlib.sha1(f'{provider}:{raw}'.encode()).hexdigest()[:12]}"


class DeepSeekSearchClient:
    """DeepSeek 官方搜索 / Fetch。没有 Key 就明确 not_configured。"""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.key = settings.deepseek_api_key
        base = (settings.deepseek_base_url or "https://api.deepseek.com").rstrip("/")
        # 文档给的路径是 /v1/tools/*；base_url 可能已经带 /v1
        self.base = base[:-3] if base.endswith("/v1") else base

    @property
    def configured(self) -> bool:
        return bool(self.key) and bool(self.settings.deepseek_search_enabled)

    async def _post(self, path: str, payload: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
        if not self.key:
            raise DeepSeekSearchError("not_configured", "未配置 DEEPSEEK_API_KEY，无法使用 DeepSeek 检索")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.key}",
        }
        try:
            async with httpx.AsyncClient(
                timeout=timeout, trust_env=self.settings.http_trust_env
            ) as client:
                resp = await client.post(f"{self.base}{path}", json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise DeepSeekSearchError("http_error", f"DeepSeek 检索请求失败：{exc}", retryable=True) from exc
        if resp.status_code >= 400:
            body = resp.text[:400]
            raise DeepSeekSearchError(
                f"http_{resp.status_code}",
                f"DeepSeek 检索 HTTP {resp.status_code}: {body}",
                retryable=resp.status_code in {429, 500, 502, 503, 504},
            )
        try:
            data = resp.json()
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive
            raise DeepSeekSearchError("bad_response", "DeepSeek 检索返回的不是 JSON") from exc
        return data if isinstance(data, dict) else {"data": data}

    async def search(
        self, query: str, count: int = 5, need_content: bool = False
    ) -> list[SearchHit]:
        payload = {
            "query": query[:128],
            "count": max(1, min(int(count), 50)),
            "need_content": bool(need_content),
        }
        data = await self._post("/v1/tools/search", payload)
        return [self._hit(item) for item in _result_list(data)]

    async def fetch(self, url: str) -> dict[str, Any]:
        """取网页 Markdown 正文。被安全策略拒绝 → 403，取不到正文 → 404。"""
        data = await self._post("/v1/tools/fetch", {"url": url})
        payload = _first_dict(data.get("data")) or data
        content = payload.get("content") or payload.get("markdown") or payload.get("text") or ""
        if not isinstance(content, str) or not content.strip():
            raise DeepSeekSearchError("not_found", f"取不到 {url} 的正文", retryable=False)
        return {
            "url": payload.get("url") or url,
            "title": payload.get("title"),
            "content": content,
            "published_at": payload.get("date") or payload.get("published_at"),
        }

    @staticmethod
    def _hit(item: dict[str, Any]) -> SearchHit:
        url = item.get("url") or item.get("link")
        authority = item.get("authority")
        try:
            authority = int(authority) if authority is not None else None
        except (TypeError, ValueError):
            authority = None
        score = item.get("rerank_score")
        try:
            score = float(score) if score is not None else None
        except (TypeError, ValueError):
            score = None
        source_ref = _hit_ref("deepseek", [url, item.get("title"), item.get("date")])
        return SearchHit(
            provider="deepseek",
            title=(item.get("title") or "")[:300],
            url=url,
            snippet=(item.get("snippet") or "")[:1200],
            summary=(item.get("summary") or "")[:2000],
            content=(item.get("content") or "")[:6000],
            published_at=(item.get("date") or item.get("published_at") or None),
            authority=authority,
            rerank_score=score,
            source_type=source_type_of(url),
            source_ref=source_ref,
            extra={k: v for k, v in item.items() if k in {"site", "type"}},
        )


def _result_list(data: dict[str, Any]) -> list[dict[str, Any]]:
    """容错地从各种外壳里挖出结果列表（真实外壳未核实，01 §12）。"""
    candidates: list[Any] = [
        data.get("results"),
        data.get("data"),
        (data.get("data") or {}).get("results") if isinstance(data.get("data"), dict) else None,
        data.get("hits"),
        data.get("items"),
    ]
    for value in candidates:
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _first_dict(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return None
