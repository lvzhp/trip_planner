"""Live integration checks used by the settings UI.

These deliberately hit the configured external services (with short timeouts)
instead of reporting the mere presence of a key.  A failed check never changes
server state; it only returns a structured status.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from app.config import Settings
from app.llm.jev import JevClient, JevError, JevQuestion, JevQuestionType
from app.llm.providers import build_provider
from app.tools.amap import AmapClient
from app.tools.tavily import TavilyClient


def _result(
    service: str,
    label: str,
    ok: bool,
    message: str,
    started: float,
    *,
    status: str | None = None,
    details: Any = None,
) -> dict[str, Any]:
    return {
        "service": service,
        "label": label,
        "ok": ok,
        "status": status or ("ok" if ok else "error"),
        "message": message,
        "latencyMs": int((time.perf_counter() - started) * 1000),
        "details": details,
    }


async def _check_llm(settings: Settings, provider_id: str, model: str) -> dict[str, Any]:
    started = time.perf_counter()
    if provider_id == "mock":
        return _result(
            "llm",
            "LLM",
            False,
            "当前选择的是 Mock 演示 provider；请选择真实模型并填写 API Key",
            started,
            status="demo",
        )
    try:
        provider = build_provider(settings, provider_id)
        resp = await asyncio.wait_for(
            provider.chat(
                [{"role": "user", "content": "这是连通性测试，只回复 OK。"}],
                [],
                model,
            ),
            timeout=30,
        )
        text = (resp.content or "").strip()
        return _result(
            "llm",
            "LLM",
            True,
            f"{provider.display_name} / {model} 连接成功" + (f" · 回复：{text[:40]}" if text else ""),
            started,
        )
    except asyncio.TimeoutError:
        return _result("llm", "LLM", False, "LLM 请求超时（30s）", started)
    except Exception as exc:
        return _result("llm", "LLM", False, f"LLM 连接失败：{exc}", started)


async def _check_amap(settings: Settings) -> dict[str, Any]:
    started = time.perf_counter()
    if not settings.amap_web_key:
        return _result("amap", "高德 Web 服务", False, "未配置 AMAP_WEB_KEY", started, status="not_configured")
    try:
        client = AmapClient(settings)
        pois = await asyncio.wait_for(client.search_poi("喀纳斯", "布尔津", "景点", 1), timeout=20)
        if not pois:
            return _result("amap", "高德 Web 服务", False, "接口连通但未返回 POI", started)
        return _result(
            "amap",
            "高德 Web 服务",
            True,
            f"POI 搜索成功：{pois[0].name}",
            started,
            details={"lat": pois[0].lat, "lng": pois[0].lng},
        )
    except asyncio.TimeoutError:
        return _result("amap", "高德 Web 服务", False, "高德请求超时（20s）", started)
    except Exception as exc:
        return _result("amap", "高德 Web 服务", False, f"高德连接失败：{exc}", started)


async def _check_tavily(settings: Settings) -> dict[str, Any]:
    started = time.perf_counter()
    if not settings.tavily_api_key:
        return _result("tavily", "Tavily 搜索", False, "未配置 TAVILY_API_KEY", started, status="not_configured")
    try:
        client = TavilyClient(settings)
        result = await asyncio.wait_for(client.search("独库公路 开放时间", 1), timeout=25)
        return _result(
            "tavily",
            "Tavily 搜索",
            True,
            f"搜索成功：{len(result.results)} 条结果",
            started,
        )
    except asyncio.TimeoutError:
        return _result("tavily", "Tavily 搜索", False, "Tavily 请求超时（25s）", started)
    except Exception as exc:
        return _result("tavily", "Tavily 搜索", False, f"Tavily 连接失败：{exc}", started)


async def _check_jev(settings: Settings) -> dict[str, Any]:
    """决策模型连通性：发一个 noul 问题，看能不能拿到答案。

    Jev 是可选组件（未配置时路由降级），所以它不参与总体的 `ok` 判定。
    """
    started = time.perf_counter()
    if not settings.jev_configured:
        return _result(
            "jev",
            "Jev 决策路由",
            False,
            "未配置 JEV_API_KEY；工具路由会按降级规则收缩",
            started,
            status="not_configured",
        )
    client = JevClient(settings)
    try:
        result = await asyncio.wait_for(
            client.evaluate(
                "连通性测试：用户说「你好」，没有提出任何行程修改。",
                [
                    JevQuestion(
                        id="ping",
                        type=JevQuestionType.NOUL,
                        instructions="这句话是否需要修改行程？",
                    )
                ],
            ),
            timeout=15,
        )
        answer = result.answers.get("ping")
        probability = answer.true_probability() if answer else None
        return _result(
            "jev",
            "Jev 决策路由",
            True,
            f"{result.model_version or settings.jev_model} 连接成功"
            + (f" · p(true)={probability:.2f}" if probability is not None else ""),
            started,
            details={"model": result.model_version, "usage": result.usage},
        )
    except asyncio.TimeoutError:
        return _result("jev", "Jev 决策路由", False, "Jev 请求超时（15s）", started)
    except JevError as exc:
        return _result("jev", "Jev 决策路由", False, f"Jev 连接失败（{exc.code}）：{exc.message}", started)
    except Exception as exc:  # noqa: BLE001
        return _result("jev", "Jev 决策路由", False, f"Jev 连接失败：{exc}", started)


def _check_map(settings: Settings) -> dict[str, Any]:
    started = time.perf_counter()
    mode = settings.effective_map_provider
    if mode == "amap":
        ok = bool(settings.amap_js_key)
        return _result(
            "map",
            "地图",
            ok,
            "高德 JS API 2.0" if ok else "选择了高德地图但未配置 AMAP_JS_KEY",
            started,
            status="ok" if ok else "not_configured",
        )
    if mode == "leaflet":
        return _result("map", "地图", True, "Leaflet + OpenStreetMap（无需 key）", started)
    return _result("map", "地图", True, "SVG 离线画布", started, status="offline")


async def check_integrations(
    settings: Settings, provider_id: str | None = None, model: str | None = None
) -> dict[str, Any]:
    provider = provider_id or settings.default_provider
    selected_model = model or settings.default_model
    llm, amap, tavily, jev = await asyncio.gather(
        _check_llm(settings, provider, selected_model),
        _check_amap(settings),
        _check_tavily(settings),
        _check_jev(settings),
    )
    map_result = _check_map(settings)
    results = [llm, amap, tavily, jev, map_result]
    # Jev 是可选组件（未配置时路由降级），不参与总体 ok
    required = {"llm", "amap", "tavily", "map"}
    return {
        "ok": all(r["ok"] for r in results if r["service"] in required),
        "results": results,
        "provider": provider,
        "model": selected_model,
    }
