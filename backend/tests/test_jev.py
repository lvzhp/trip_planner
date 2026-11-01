"""Jev / TypeSafe System One 决策模型客户端（真实接口形态）。"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.db import Database, set_db  # noqa: E402
from app.llm.jev import (  # noqa: E402
    JevAnswer,
    JevClient,
    JevError,
    JevQuestion,
    JevQuestionType,
    JevResult,
    parse_response,
)
from app.schemas.plan import Trip  # noqa: E402

SENT_TYPES = {
    "intent": {"type": "choice"},
    "web_search": {"type": "noul"},
    "satisfaction": {"type": "score"},
}


class FakeTypeSafe(BaseHTTPRequestHandler):
    requests: list[dict] = []

    def log_message(self, *args):
        pass

    def _json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        FakeTypeSafe.requests.append(
            {"path": parsed.path, "authorization": self.headers.get("authorization"), "body": body}
        )
        if parsed.path != "/typesafe/v1/systemone":
            self._json({"error": "unknown"}, 404)
            return
        if body.get("model") == "jev-unauthorized":
            self._json({"error": "unauthorized"}, 401)
            return
        self._json(
            {
                "model": body.get("model"),
                "answers": {
                    "intent": {"choice": "局部重规划", "confidence": 0.88},
                    "web_search": {"probability": 0.81},
                    "satisfaction": {"score": 2},
                },
                "usage": {"total_tokens": 321},
            }
        )


@pytest.fixture(scope="module")
def jev_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeTypeSafe)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


def jev_settings(base: str, *, model: str = "jev-1.14.0") -> Settings:
    return Settings(
        _env_file=None,
        database_url="sqlite:///:memory:",
        demo_mode=False,
        seed_demo=False,
        http_trust_env=False,
        jev_api_key="test-jev-key",
        jev_base_url=base,
        jev_endpoint="/typesafe/v1/systemone",
        jev_model=model,
        jev_timeout_ms=5000,
    )


# --------------------------------------------------------------------------
# 请求形态
# --------------------------------------------------------------------------


def test_question_payloads_match_documented_shape():
    choice = JevQuestion(
        id="intent",
        type=JevQuestionType.CHOICE,
        instructions="本轮用户想要什么？",
        criteria={"首次规划": "没有行程", "问答": "只问信息"},
    )
    assert choice.to_payload() == {
        "type": "choice",
        "instructions": "本轮用户想要什么？",
        "criteria": {"首次规划": "没有行程", "问答": "只问信息"},
    }

    score = JevQuestion(
        id="satisfaction",
        type=JevQuestionType.SCORE,
        instructions="满意度",
        criteria=["非常不满", "一般", "非常满意"],
    )
    assert score.to_payload()["criteria"] == ["非常不满", "一般", "非常满意"]

    noul = JevQuestion(id="refund", type=JevQuestionType.NOUL, instructions="客户要退款吗？")
    assert noul.to_payload() == {"type": "noul", "instructions": "客户要退款吗？"}


@pytest.mark.asyncio
async def test_client_posts_questions_object_and_parses_answers(jev_server):
    FakeTypeSafe.requests.clear()
    settings = jev_settings(jev_server)
    client = JevClient(settings)
    assert client.configured is True

    result = await client.evaluate(
        "【客服工单】客户说再拖就退款",
        [
            JevQuestion(
                id="intent",
                type=JevQuestionType.CHOICE,
                instructions="判断意图",
                criteria={"首次规划": "没有行程", "局部重规划": "只改部分"},
            ),
            JevQuestion(id="web_search", type=JevQuestionType.NOUL, instructions="需要联网检索吗？"),
            JevQuestion(
                id="satisfaction",
                type=JevQuestionType.SCORE,
                instructions="满意度",
                criteria=["非常不满", "一般", "非常满意"],
            ),
        ],
    )

    assert len(FakeTypeSafe.requests) == 1
    request = FakeTypeSafe.requests[0]
    assert request["path"] == "/typesafe/v1/systemone"
    assert request["authorization"] == "Bearer test-jev-key"
    body = request["body"]
    assert body["model"] == "jev-1.14.0"
    assert isinstance(body["questions"], dict)  # 问题集合是对象，不是数组
    assert set(body["questions"]) == {"intent", "web_search", "satisfaction"}
    assert body["questions"]["intent"]["criteria"] == {"首次规划": "没有行程", "局部重规划": "只改部分"}
    assert "criteria" not in body["questions"]["web_search"]
    assert body["questions"]["satisfaction"]["criteria"] == ["非常不满", "一般", "非常满意"]

    assert result.model_version == "jev-1.14.0"
    assert result.usage == {"total_tokens": 321}
    assert result.answers["intent"].best_choice() == ("局部重规划", pytest.approx(0.88))
    assert result.answers["web_search"].true_probability() == pytest.approx(0.81)
    assert result.answers["satisfaction"].normalized_score() == pytest.approx(0.2)


@pytest.mark.asyncio
async def test_choice_question_requires_criteria(jev_server):
    client = JevClient(jev_settings(jev_server))
    with pytest.raises(JevError) as excinfo:
        await client.evaluate(
            "state", [JevQuestion(id="bad", type=JevQuestionType.CHOICE, instructions="x")]
        )
    assert excinfo.value.code == "bad_question"


@pytest.mark.asyncio
async def test_http_error_is_explicit(jev_server):
    client = JevClient(jev_settings(jev_server, model="jev-unauthorized"))
    with pytest.raises(JevError) as excinfo:
        await client.evaluate("state", [JevQuestion(id="q", type=JevQuestionType.NOUL, instructions="x")])
    assert excinfo.value.code == "http_401"


# --------------------------------------------------------------------------
# 答案解析容错（答案字段没有公开 schema）
# --------------------------------------------------------------------------


def test_parse_answer_variants():
    result = parse_response(
        {
            "model": "jev-1.14.0",
            "answers": {
                "urgency": {"choice": "高", "confidence": 0.91},
                "satisfaction": {"score": 2},
                "refund_requested": {"probability": 0.86},
                "noul_field": {"noul": 0.84, "type": "noul"},
                "noul_nested": {"noul": {"probability": 0.77}},
                "need_fetch": {"answer": True, "confidence": 0.8},
                "need_search": {"answer": False, "confidence": 0.8},
                "with_distribution": {"probabilities": {"高": 0.7, "中": 0.2, "低": 0.1}},
                "scalar_label": "中",
                "scalar_number": 0.73,
                "scalar_bool": True,
            },
        },
        {
            "urgency": {"type": "choice"},
            "satisfaction": {"type": "score"},
            "refund_requested": {"type": "noul"},
            "noul_field": {"type": "noul"},
            "noul_nested": {"type": "noul"},
            "need_fetch": {"type": "noul"},
            "need_search": {"type": "noul"},
            "with_distribution": {"type": "choice"},
            "scalar_label": {"type": "choice"},
            "scalar_number": {"type": "noul"},
            "scalar_bool": {"type": "noul"},
        },
    )
    assert result.answers["urgency"].best_choice() == ("高", pytest.approx(0.91))
    assert result.answers["satisfaction"].normalized_score() == pytest.approx(0.2)
    assert result.answers["refund_requested"].true_probability() == pytest.approx(0.86)
    # 实测的 TypeSafe 返回形态：{"noul": 0.84, "type": "noul"}
    assert result.answers["noul_field"].true_probability() == pytest.approx(0.84)
    assert result.answers["noul_nested"].true_probability() == pytest.approx(0.77)
    assert result.answers["need_fetch"].true_probability() == pytest.approx(0.8)
    assert result.answers["need_search"].true_probability() == pytest.approx(0.2)
    assert result.answers["with_distribution"].best_choice() == ("高", pytest.approx(0.7))
    assert result.answers["scalar_label"].best_choice()[0] == "中"
    assert result.answers["scalar_number"].true_probability() == pytest.approx(0.73)
    assert result.answers["scalar_bool"].true_probability() == pytest.approx(1.0)


def test_parse_without_answers_is_error():
    with pytest.raises(JevError) as excinfo:
        parse_response({"model": "jev-1.14.0"}, {"q": {"type": "noul"}})
    assert excinfo.value.code == "empty_answers"


# --------------------------------------------------------------------------
# 路由接入：意图 choice + 工具 noul
# --------------------------------------------------------------------------


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'jev.db'}",
        demo_mode=False,
        seed_demo=False,
        mock_latency_ms=0,
        runtime_settings_path=str(tmp_path / "runtime.json"),
        jev_api_key="test-jev-key",
        jev_base_url="http://jev.local",
        jev_model="jev-1.14.0",
    )


@pytest_asyncio.fixture
async def db(settings):
    database = Database(settings)
    await database.connect()
    set_db(database)
    yield database
    await database.close()


@pytest.mark.asyncio
async def test_router_uses_choice_and_noul(settings, db, monkeypatch):
    from app.agent import routing as routing_module
    from app.agent.routing import Intent, ToolRouter
    from app.tools.registry import ToolRegistry

    recorded: dict[str, list[str]] = {"ids": []}

    async def fake_evaluate(self, state, questions):
        recorded["ids"] = [q.id for q in questions]
        state_payload = json.loads(state)
        assert "evidence_gaps" in state_payload
        if [q.id for q in questions] == ["intent"]:
            return JevResult(
                answers={
                    "intent": JevAnswer(
                        id="intent",
                        kind=JevQuestionType.CHOICE,
                        label="局部重规划",
                        confidence=0.92,
                    )
                },
                model_version="jev-1.14.0",
            )
        probabilities = {
            "web_search": 0.91,
            "search_around": 0.12,
            "place_detail": 0.4,
            "climate_reference": 0.2,
            "transport_info_lookup": 0.8,
            "dispatch_research": 0.85,
        }
        return JevResult(
            answers={
                name: JevAnswer(id=name, kind=JevQuestionType.NOUL, score=value)
                for name, value in probabilities.items()
                if name in [q.id for q in questions]
            },
            model_version="jev-1.14.0",
        )

    monkeypatch.setattr(routing_module.JevClient, "evaluate", fake_evaluate)
    trip = Trip(trip_id="jev-trip", title="t", version=0)
    router = ToolRouter(settings, ToolRegistry(settings, db))
    decision = await router.decide(
        trip=trip, text="我起晚了，今天下午再出门", has_research=True
    )

    assert decision.intent == Intent.REPLAN
    assert decision.degraded is False
    assert decision.model_version == "jev-1.14.0"
    # Noul 阈值：贵的工具（dispatch_research 0.85 / transport 0.8）在默认阈值上放行，
    # search_around / place_detail / climate_reference 被拒
    assert "web_search" in decision.allowed
    assert "transport_info_lookup" in decision.allowed
    assert "dispatch_research" in decision.allowed
    assert "search_around" not in decision.allowed
    assert "place_detail" not in decision.allowed
    assert "climate_reference" not in decision.allowed
    assert recorded["ids"] and "intent" not in recorded["ids"]  # 第二轮只问工具


@pytest.mark.asyncio
async def test_router_degrades_on_low_confidence(settings, db, monkeypatch):
    from app.agent import routing as routing_module
    from app.agent.routing import ToolRouter
    from app.tools.registry import ToolRegistry

    async def fake_evaluate(self, state, questions):
        return JevResult(
            answers={
                "intent": JevAnswer(
                    id="intent",
                    kind=JevQuestionType.CHOICE,
                    label="问答",
                    confidence=0.12,
                )
            },
            model_version="jev-1.14.0",
        )

    monkeypatch.setattr(routing_module.JevClient, "evaluate", fake_evaluate)
    trip = Trip(trip_id="jev-low", title="t", version=0)
    router = ToolRouter(settings, ToolRegistry(settings, db))
    decision = await router.decide(trip=trip, text="预算大概多少", has_research=True)
    # 置信度低于阈值 → 降级，第三档不按 Jev 放行
    assert decision.degraded is True
    assert "web_search" not in decision.allowed


# --------------------------------------------------------------------------
# 接入配置里的连通性检测
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_check_reports_jev(jev_server):
    from app.services.integrations import _check_jev

    ok = await _check_jev(jev_settings(jev_server))
    assert ok["service"] == "jev"
    assert ok["ok"] is True
    assert "jev-1.14.0" in ok["message"]

    missing = await _check_jev(
        Settings(_env_file=None, jev_api_key="", jev_base_url="https://www.dmxapi.cn")
    )
    assert missing["ok"] is False
    assert missing["status"] == "not_configured"
