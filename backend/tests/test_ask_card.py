"""提问卡解析（模型输出不可靠，必须归一化 + 失败可见）。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.agent.loop import parse_ask_block  # noqa: E402
from app.agent.prompts import SYSTEM_PROMPT  # noqa: E402
from app.config import Settings  # noqa: E402
from app.db import Database, set_db  # noqa: E402


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'ask.db'}",
        demo_mode=False,
        seed_demo=False,
        mock_latency_ms=0,
        runtime_settings_path=str(tmp_path / "runtime.json"),
    )


@pytest_asyncio.fixture
async def db(settings):
    database = Database(settings)
    await database.connect()
    set_db(database)
    yield database
    await database.close()


#: 线上实际复现的形态：q / chips / 字符串选项（DeepSeek flash）
REAL_WORLD = """带爸妈在大理慢走 5 天，这个节奏很合适。

先确认几件事，我一次问完（都可以跳过）：
<ask_user>
{"intro":"带爸妈大理 5 天，慢节奏——再确认 4 件事就能开始排（都可以跳过）","questions":[{"q":"大概什么时候去？","chips":["11 月中下旬","12 月","寒假 / 春节前后","3 月花开时","其他（备注里写具体日期）"]},{"q":"从哪个城市出发？","chips":["成都","重庆","北京","上海","广州","其他（备注里写城市）"]},{"q":"主要怎么走？","chips":["飞机往返 + 当地包车","高铁往返 + 当地打车","全程自驾"]},{"q":"爸妈有忌口或饮食限制吗？","chips":["无特殊忌口","不吃辣","少油少盐 / 清淡","素食","其他（备注里写）"]}],"allow_note":true,"allow_skip":true}
</ask_user>"""


def test_parse_real_world_alias_shape():
    ask, error, found = parse_ask_block(REAL_WORLD)
    assert found is True and error is None
    assert ask is not None
    assert len(ask.questions) == 4
    first = ask.questions[0]
    assert first.question == "大概什么时候去？"
    assert [o.label for o in first.options][:2] == ["11 月中下旬", "12 月"]
    assert all(o.id for o in first.options)
    assert ask.allow_note is True and ask.allow_skip is True
    assert ask.ask_id


def test_parse_option_objects_and_dict_map():
    text = """<ask_user>
{"intro":"x","questions":[
  {"question":"几个人？","multi":false,"options":[
     {"id":"p2","label":"2 人","note_hint":"默认"},
     {"text":"3–4 人","name":"p3"}]},
  {"question":"怎么走？","multi":true,"options":{"飞机":"直飞","高铁":"动车"}}
]}
</ask_user>"""
    ask, error, _found = parse_ask_block(text)
    assert error is None and ask is not None
    assert ask.questions[0].options[0].id == "p2"
    assert ask.questions[0].options[0].note_hint == "默认"
    assert ask.questions[0].options[1].label == "3–4 人"
    assert ask.questions[1].multi is True
    # 字典形态：key 是选项名，value 是说明
    assert {o.label for o in ask.questions[1].options} == {"飞机", "高铁"}
    assert {o.note_hint for o in ask.questions[1].options} == {"直飞", "动车"}


def test_parse_missing_closing_tag():
    text = '先确认：\n<ask_user>\n{"intro":"x","questions":[{"question":"几个人？","options":["1 人","2 人"]}]}'
    ask, error, found = parse_ask_block(text)
    assert found is True and error is None
    assert ask is not None and ask.questions[0].options[1].label == "2 人"


def test_parse_broken_json_is_reported_not_silent():
    ask, error, found = parse_ask_block('<ask_user>{"intro": "x", </ask_user>')
    assert ask is None
    assert found is True
    assert error == "json"


def test_parse_empty_questions_is_reported():
    ask, error, found = parse_ask_block('<ask_user>{"intro":"x","questions":[]}</ask_user>')
    assert ask is None and found is True
    assert error == "schema"


def test_no_block_means_not_found():
    ask, error, found = parse_ask_block("就是一句普通回复")
    assert (ask, error, found) == (None, None, False)


def test_prompt_has_concrete_ask_example():
    # 提示词里必须是可直接照抄的字段名，不能再用 questions:[...] 这种占位
    assert '"questions":[' in SYSTEM_PROMPT
    assert '"options":[{"id"' in SYSTEM_PROMPT
    assert '"questions":[...]' not in SYSTEM_PROMPT
    assert "hidden" in SYSTEM_PROMPT


# --------------------------------------------------------------------------
# 循环层：坏块不能静默结束，好块要真的变成提问卡
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_loop_emits_card_from_alias_shape(settings, db, monkeypatch):
    from app.agent import loop as loop_module
    from app.agent.loop import AgentLoop
    from app.llm.providers import ProviderResponse
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    class FakeProvider:
        id = "fake"
        display_name = "Fake"

        async def chat(self, messages, tools, model):
            return ProviderResponse(content=REAL_WORLD, finish_reason="stop")

    monkeypatch.setattr(loop_module, "build_provider", lambda *_: FakeProvider())
    loop = AgentLoop(settings, db, ToolRegistry(settings, db))
    trip = Trip(trip_id="ask-alias", title="t", version=0)
    await db.upsert_trip(trip, 0)
    events = [
        event
        async for event in loop.stream(
            trip,
            ChatRequest(content="带爸妈去大理 5 天", model={"provider": "deepseek", "model": "deepseek-flash"}),
        )
    ]
    asks = [event for event in events if event.type.value == "ask_user"]
    assert len(asks) == 1
    payload = asks[0].payload
    assert len(payload["questions"]) == 4
    assert payload["questions"][0]["options"][0]["label"] == "11 月中下旬"
    # 正文里不能漏出 JSON
    messages = [e.payload.get("text", "") for e in events if e.type.value == "message"]
    assert not any("<ask_user>" in text for text in messages)


@pytest.mark.asyncio
async def test_loop_reports_broken_card_instead_of_silence(settings, db, monkeypatch):
    from app.agent import loop as loop_module
    from app.agent.loop import AgentLoop
    from app.llm.providers import ProviderResponse
    from app.schemas.api import ChatRequest
    from app.schemas.plan import Trip
    from app.tools.registry import ToolRegistry

    broken = '先确认几件事：\n<ask_user>{"intro":"x", </ask_user>'

    class FakeProvider:
        id = "fake"
        display_name = "Fake"

        async def chat(self, messages, tools, model):
            return ProviderResponse(content=broken, finish_reason="stop")

    monkeypatch.setattr(loop_module, "build_provider", lambda *_: FakeProvider())
    loop = AgentLoop(settings, db, ToolRegistry(settings, db))
    trip = Trip(trip_id="ask-broken", title="t", version=0)
    await db.upsert_trip(trip, 0)
    events = [
        event
        async for event in loop.stream(
            trip,
            ChatRequest(content="带爸妈去大理 5 天", model={"provider": "deepseek", "model": "deepseek-flash"}),
        )
    ]
    assert not [event for event in events if event.type.value == "ask_user"]
    errors = [
        event
        for event in events
        if event.type.value == "message"
        and (event.payload or {}).get("error")
    ]
    assert errors, "坏块必须给出可见提示，不能静默结束"
    text = errors[-1].payload["text"]
    assert "提问卡" in text and "几个人" in text
    # 不能让残缺 JSON 漏到界面上
    assert "<ask_user>" not in text


# --------------------------------------------------------------------------
# 选择器：城市 / 日期（模型没写 input 时按题面推断）
# --------------------------------------------------------------------------


def test_input_type_inference_and_explicit_values():
    text = """<ask_user>
{"intro":"x","questions":[
  {"question":"从哪个城市出发？","options":["北京","上海"]},
  {"question":"大概什么时候去？","options":["五一","暑假"]},
  {"question":"几个人去？","options":["1 人","2 人"]},
  {"question":"去几天？","options":["4 天","6 天"]},
  {"question":"奇怪的问题？","input":"slider","options":["a","b"]},
  {"question":"返程日期定了吗？","input":"date","options":["定了","没定"]}
]}
</ask_user>"""
    ask, error, _found = parse_ask_block(text)
    assert error is None and ask is not None
    assert [q.input for q in ask.questions] == ["city", "date", "chips", "chips", "chips", "date"]
    # 选择器题仍然保留快捷选项
    assert ask.questions[0].options[0].label == "北京"


def test_scope_hint_renders_picker_value():
    from app.agent.prompts import scope_hint

    rendered = scope_hint(
        [],
        [
            {
                "question_index": 4,
                "option_ids": [],
                "value": "成都",
                "note": "带爸妈，少走路",
            }
        ],
    )
    assert "填写：成都" in rendered
    assert "备注：带爸妈，少走路" in rendered


def test_answer_model_accepts_picker_value():
    from app.schemas.plan import AskUserAnswer

    answer = AskUserAnswer.model_validate(
        {"question_index": 1, "option_ids": [], "note": "", "value": "2026-11-08"}
    )
    assert answer.value == "2026-11-08"


def test_purpose_inference_does_not_mistake_opening_for_outline():
    """开场卡 intro 里也有「路线」二字，不能因此被当成方案确认卡（否则跳过门禁）。"""
    opening = """<ask_user>
{"intro":"为了排出合适的路线，先确认这几件事（都可以跳过）","questions":[
 {"question":"几个人去？","options":["2 人","3 人"]},
 {"question":"从哪个城市出发？","options":["北京","上海"]},
 {"question":"什么时候去？","options":["五一","暑假"]}]}
</ask_user>"""
    ask, _err, _found = parse_ask_block(opening)
    assert ask is not None and ask.purpose == "opening"

    outline = """<ask_user>
{"intro":"给你两条路线，选一条我来细化","questions":[
 {"question":"走哪条？","options":["A · 环洱海慢线","B · 苍山 + 古镇"]}]}
</ask_user>"""
    ask2, _err2, _found2 = parse_ask_block(outline)
    assert ask2 is not None and ask2.purpose == "outline"


def test_explicit_purpose_wins():
    ask, _err, _found = parse_ask_block(
        '<ask_user>{"purpose":"outline","intro":"x","questions":[{"question":"走哪条？","options":["a","b"]}]}</ask_user>'
    )
    assert ask is not None and ask.purpose == "outline"
