"""Prove the real external-client code paths, not the offline fixtures.

A local HTTP server impersonates AMap / Tavily / an OpenAI-compatible LLM, and
the production clients are pointed at it through Settings.  This catches URL /
auth / parsing / streaming regressions without needing real credentials.
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.runtime import RuntimeSettingsStore
from app.services.integrations import check_integrations
from app.tools.amap import AmapClient
from app.tools.tavily import TavilyClient
from app.llm.providers import OpenAICompatibleProvider


class FakeExternalAPI(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.endswith("/place/text"):
            self._json({
                "status": "1",
                "info": "OK",
                "pois": [{
                    "id": "B0TEST",
                    "name": "喀纳斯湖",
                    "location": "87.0206,48.7231",
                    "cityname": "布尔津县",
                    "address": "喀纳斯景区",
                    "type": "风景名胜",
                }],
            })
            return
        if parsed.path.endswith("/weather/weatherInfo"):
            self._json({
                "status": "1",
                "info": "OK",
                "forecasts": [{"casts": [{
                    "date": "2026-05-03",
                    "dayweather": "晴",
                    "daywind": "西北风",
                    "daypower": "3级",
                    "daytemp": "12",
                    "nighttemp": "-2",
                }]}],
            })
            return
        if parsed.path.endswith("/direction/driving"):
            self._json({
                "status": "1",
                "info": "OK",
                "route": {"paths": [{
                    "distance": "196000",
                    "duration": "9000",
                    "steps": [{"road": "G216"}, {"road": "S232"}],
                }]},
            })
            return
        self._json({"status": "0", "info": "unknown"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if parsed.path.endswith("/chat/completions"):
            assert body["stream"] is True
            assert self.headers.get("authorization") == "Bearer test-llm-key"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"choices": [{"delta": {"content": "OK"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
            for chunk in chunks:
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        if parsed.path.endswith("/search"):
            assert body.get("api_key") == "test-tavily-key"
            self._json({
                "results": [
                    {"title": "独库公路开放时间", "url": "https://example.com", "content": "通常 6 月上旬开放", "score": 0.9}
                ],
                "answer": "6 月上旬开放",
            })
            return
        self._json({"error": "unknown"}, 404)


@pytest.fixture(scope="module")
def fake_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeExternalAPI)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def real_settings(base: str) -> Settings:
    return Settings(
        _env_file=None,
        database_url="sqlite:///:memory:",
        demo_mode=False,
        seed_demo=False,
        http_trust_env=False,
        amap_web_key="test-amap-key",
        amap_base_url=f"{base}/v3",
        tavily_api_key="test-tavily-key",
        tavily_base_url=base,
        deepseek_api_key="test-llm-key",
        deepseek_base_url=f"{base}/v1",
        default_provider="deepseek",
        default_model="deepseek-flash",
        map_provider="leaflet",
    )


@pytest.mark.asyncio
async def test_real_amap_client(fake_server):
    settings = real_settings(fake_server)
    client = AmapClient(settings)
    pois = await client.search_poi("喀纳斯", "布尔津", "景点", 1)
    assert pois[0].amap_poi_id == "B0TEST"
    assert pois[0].lng == pytest.approx(87.0206)
    weather = await client.weather("布尔津", "2026-05-03")
    assert weather.high == 12 and weather.low == -2
    route = await client.plan_route("阿勒泰", "禾木", "drive", from_coord=(88.1, 47.8), to_coord=(87.4, 48.8))
    assert route.distance_km == pytest.approx(196.0)
    assert route.minutes == 150


@pytest.mark.asyncio
async def test_real_tavily_client(fake_server):
    settings = real_settings(fake_server)
    result = await TavilyClient(settings).search("独库公路 开放时间", 1)
    assert result.conclusion == "6 月上旬开放"
    assert result.results[0].content.startswith("通常 6 月")


@pytest.mark.asyncio
async def test_real_openai_provider(fake_server):
    settings = real_settings(fake_server)
    provider = OpenAICompatibleProvider(settings, "deepseek", "test-llm-key", f"{fake_server}/v1")
    resp = await provider.chat([{"role": "user", "content": "仅回复 OK"}], [], "deepseek-flash")
    assert resp.content == "OK"
    assert resp.finish_reason == "stop"


@pytest.mark.asyncio
async def test_check_integrations_all_green(fake_server):
    settings = real_settings(fake_server)
    result = await check_integrations(settings, "deepseek", "deepseek-flash")
    assert result["ok"] is True
    services = {r["service"]: r for r in result["results"]}
    assert services["llm"]["ok"] and services["amap"]["ok"] and services["tavily"]["ok"]
    assert services["map"]["message"].startswith("Leaflet")


def test_runtime_settings_masking_and_persistence(tmp_path):
    settings = Settings(
        _env_file=None,
        database_url="sqlite:///:memory:",
        demo_mode=True,
        seed_demo=False,
    )
    path = tmp_path / "runtime_settings.json"
    store = RuntimeSettingsStore(path)
    store.update(
        settings,
        {
            "values": {
                "default_provider": "deepseek",
                "default_model": "deepseek-flash",
                "map_provider": "amap",
                "demo_mode": False,
            },
            "secrets": {"deepseek_api_key": "sk-secret-123456", "amap_js_key": "js-key-9876"},
        },
    )
    public = store.public(settings)
    assert public["secrets"]["deepseek_api_key"]["configured"] is True
    assert public["secrets"]["deepseek_api_key"]["hint"].endswith("3456")
    assert "sk-secret-123456" not in json.dumps(public)
    assert settings.effective_map_provider == "amap"
    assert path.stat().st_mode & 0o777 == 0o600

    # reload from disk into a fresh Settings object
    fresh = Settings(
        _env_file=None,
        database_url="sqlite:///:memory:")
    RuntimeSettingsStore(path).load(fresh)
    assert fresh.deepseek_api_key == "sk-secret-123456"
    assert fresh.default_provider == "deepseek"
    assert fresh.demo_mode is False

    # clearing a secret persists an empty override
    store.update(settings, {"clear_secrets": ["deepseek_api_key"]})
    assert settings.deepseek_api_key == ""
    again = Settings(
        _env_file=None,
        database_url="sqlite:///:memory:")
    RuntimeSettingsStore(path).load(again)
    assert again.deepseek_api_key == ""


def test_runtime_settings_rejects_bad_fields(tmp_path):
    from app.runtime import RuntimeSettingsError

    settings = Settings(
        _env_file=None,
        database_url="sqlite:///:memory:")
    store = RuntimeSettingsStore(tmp_path / "s.json")
    with pytest.raises(RuntimeSettingsError):
        store.update(settings, {"values": {"database_url": "postgres://evil"}})
    with pytest.raises(RuntimeSettingsError):
        store.update(settings, {"values": {"default_provider": "nope"}})


@pytest.mark.asyncio
async def test_real_tools_never_silently_use_mock_fixtures(tmp_path):
    from app.db import Database
    from app.tools.registry import ToolRegistry

    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'tool.db'}",
        demo_mode=False,
        seed_demo=False,
        runtime_settings_path=str(tmp_path / "runtime.json"),
    )
    db = Database(settings)
    await db.connect()
    try:
        registry = ToolRegistry(settings, db)
        real = await registry.execute("search_poi", {"keyword": "喀纳斯"}, "real")
        assert real.ok is False
        assert real.error is not None and real.error.code == "not_configured"
        auto = await registry.execute("search_poi", {"keyword": "喀纳斯"}, "auto")
        assert auto.ok is True
        assert auto.data["source"] == "mock"
        mock = await registry.execute("search_poi", {"keyword": "喀纳斯"}, "mock")
        assert mock.ok is True
        assert mock.data["source"] == "mock"
    finally:
        await db.close()
