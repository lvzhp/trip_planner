"""通用社交线索 `social_digest`（docs/new-plan 01 §6，02 §2.3、§6）。

平台无关：每个平台一个小适配器（域名 + 搜索 query）。工具内部先摘要，规划模型
只拿结构化摘要，原文不进上下文。

v1 的两个现实约束，实现里都显式表达：

- 小红书/抖音这类要登录或反爬强的平台**默认关闭**，部署者没开启就返回
  `login_required`/`not_configured`，规划模型不得用自己的知识补写攻略；
- 摘要只是线索，永远 `clue`，不能写进票价、渠道、营业时间这些事实字段。
"""

from __future__ import annotations

import asyncio
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.config import Settings
from app.llm.structured import llm_available
from app.schemas.sources import EvidenceStatus
from app.tools.composite import (
    EXTRACT_SYSTEM,
    Retrieval,
    Retriever,
    _sources_block,
    finalize_result,
)
from app.llm.structured import extract_structured

#: 要登录或反爬强的平台：默认关闭（01 §6.1）。
LOGIN_REQUIRED_PLATFORMS = {"xiaohongshu", "douyin", "weibo", "kuaishou"}

#: 免登录的公开文本平台先上。
PLATFORM_DOMAINS = {
    "zhihu": "zhihu.com",
    "bilibili": "bilibili.com",
    "mafengwo": "mafengwo.cn",
    "qq": "new.qq.com",
    "sohu": "sohu.com",
    "163": "163.com",
    "baijiahao": "baijiahao.baidu.com",
    "xiaohongshu": "xiaohongshu.com",
    "douyin": "douyin.com",
    "weibo": "weibo.com",
    "kuaishou": "kuaishou.com",
}

PLATFORM_LABELS = {
    "zhihu": "知乎",
    "bilibili": "B站专栏",
    "mafengwo": "马蜂窝",
    "qq": "腾讯新闻",
    "sohu": "搜狐",
    "163": "网易",
    "baijiahao": "百家号",
    "xiaohongshu": "小红书",
    "douyin": "抖音",
    "weibo": "微博",
    "kuaishou": "快手",
}


class SocialDigestError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class DigestItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spot_or_route: str = Field(description="地点或路线")
    play: str = Field(description="玩法")
    pitfalls: list[str] = Field(default_factory=list, description="避坑提示")
    platform: str | None = None
    url: str | None = None
    published_at: str | None = None


class DigestExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conflict: bool = False
    conflict_note: str | None = None
    items: list[DigestItem] = Field(default_factory=list)


async def social_digest(
    settings: Settings,
    retriever: Retriever,
    *,
    keyword: str,
    city: str | None = None,
    platforms: list[str] | None = None,
) -> dict[str, Any]:
    if not settings.social_digest_enabled:
        raise SocialDigestError(
            "not_configured",
            "社交线索抓取未开启：登录墙平台默认关闭，请在「接入配置」里显式开启后再试",
        )
    requested = [p.strip().lower() for p in (platforms or settings.social_platforms) if p]
    login_platforms = [p for p in requested if p in LOGIN_REQUIRED_PLATFORMS]
    if not settings.social_digest_login_enabled:
        login_required = login_platforms
    else:
        login_required = []
    public = [p for p in requested if p in PLATFORM_DOMAINS]
    if settings.social_digest_login_enabled:
        # 开启后登录墙平台也走公开检索；登录态本身由 Crawl4AI profile 负责（未实现即返回空结果）
        public += login_platforms
    if not public:
        raise SocialDigestError(
            "login_required",
            "这些平台需要登录或反爬较强（" + "、".join(login_required or requested) + "），"
            "未在接入配置里开启，不抓取",
        )

    where = f"{city}" if city else ""
    queries = [
        f"site:{PLATFORM_DOMAINS[p]} {keyword} {where} 攻略 玩法 避坑".strip()
        for p in public
    ]
    retrieval: Retrieval = await retriever.gather(queries, count=4)
    if not retrieval.hits:
        return finalize_result(
            "social_digest",
            retrieval,
            {
                "items": [],
                "platforms": public,
                "note": "没有抓到可用的公开攻略；未登录平台未开启时不会补写",
            },
            EvidenceStatus.UNVERIFIED,
        )

    items: list[dict[str, Any]] = []
    extraction = None
    if llm_available(settings):
        extraction = await extract_structured(
            settings,
            system=EXTRACT_SYSTEM,
            user=(
                "请把下面的攻略资料压成固定结构。字段：items 数组，每项含 "
                "spot_or_route 地点或路线、play 一句话玩法、pitfalls 避坑提示数组、"
                "platform 平台、url 出处链接、published_at 发布日期。"
                "只保留资料里明确写了的内容，不要补写。\n\n<资料>\n"
                + _sources_block(retrieval)
                + "\n</资料>\n\n只输出 JSON 对象。"
            ),
            schema=DigestExtraction,
            model=settings.subagent_model or settings.default_model,
        )
        if extraction is not None:
            # 平台/链接只能用检索结果里真实存在的，模型自报的链接一律不采信
            urls = {hit.url for hit in retrieval.hits if hit.url}
            items = [
                item.model_dump(mode="json")
                for item in extraction.items
                if not item.url or item.url in urls
            ]

    if not items:
        # 抽取不可用：退化为「每条检索结果的标题 + 摘要前 200 字」，仍标线索
        items = [
            {
                "spot_or_route": hit.title or keyword,
                "play": hit.text(200),
                "pitfalls": [],
                "platform": next(
                    (PLATFORM_LABELS[p] for p in public if PLATFORM_DOMAINS[p] in (hit.url or "")),
                    None,
                ),
                "url": hit.url,
                "published_at": hit.published_at,
            }
            for hit in retrieval.hits[:5]
        ]

    value = {
        "items": items,
        "platforms": public,
        "skipped_platforms": login_required,
        "note": "来自公开文本平台的经验线索，未经官方核实；不能作为票价/渠道/营业时间的事实",
    }
    # 线索永远是 clue：即使来源权威，经验也只是经验（01 §6.1）
    return finalize_result("social_digest", retrieval, value, EvidenceStatus.CLUE)


async def prefetch_pages(
    settings: Settings, urls: list[str], limit: int = 2
) -> list[dict[str, Any]]:
    """按需抓正文；失败就跳过，不影响摘要。"""
    from app.tools.deepseek_search import DeepSeekSearchClient

    client = DeepSeekSearchClient(settings)
    if not client.configured:
        return []
    out: list[dict[str, Any]] = []
    for url in urls[:limit]:
        try:
            out.append(await client.fetch(url))
        except Exception:  # noqa: BLE001
            continue

    async def _noop() -> None:  # pragma: no cover - 保留 asyncio 引入
        await asyncio.sleep(0)

    return out
