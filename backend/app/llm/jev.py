"""Jev（TypeSafe System One）决策模型客户端 —— 与 chat provider 完全分开的一层。

为什么单独一个模块：Jev **不生成文本**，它只对给定 `state` 并行回答一组结构化问题
（choice / score / noul）。这跟 `app/llm/providers.py` 里「把 messages 变成 assistant
回复」的聊天模型不是一类东西，所以不塞进 Provider 抽象，也不当普通工具用。

接口（实测定稿）：`POST {base}/typesafe/v1/systemone`

```json
{
  "model": "jev-1.14.0",
  "state": "共享上下文",
  "questions": {
    "intent":  {"type": "choice", "instructions": "...", "criteria": {"选项": "判定标准"}},
    "satisfaction": {"type": "score", "instructions": "...", "criteria": ["低", "...", "高"]},
    "refund":  {"type": "noul", "instructions": "..."}
  }
}
```

返回 `{"model": "...", "answers": {"intent": {...}}, "usage": {...}}`。

`questions` 是**对象**（key 为问题 ID），不是数组；choice 的 `criteria` 是
「选项 → 判定标准」的字典，score 的 `criteria` 是按低到高排列的档位数组，noul
只需要 `type` 与 `instructions`。

响应里每个答案的具体字段没有公开 schema，所以 `_parse_answer` 做容错抽取：
显式 label / 概率分布 / 分数 / 布尔值都能归一化。读不出来就当 Jev 不可用，
由调用方降级 —— 绝不回退成全量放行（new-plan 01 §2.4）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import httpx

from app.config import Settings

DEFAULT_ENDPOINT = "/typesafe/v1/systemone"

TRUE_LABELS = {"true", "yes", "y", "1", "是", "需要", "要", "true_probability"}
FALSE_LABELS = {"false", "no", "n", "0", "否", "不需要", "不要"}

LABEL_KEYS = ("choice", "label", "answer", "selection", "result", "option")
PROB_DICT_KEYS = ("probabilities", "distribution", "options", "candidates", "scores", "confidence_map")
SCORE_KEYS = ("score", "rating", "value", "probability", "prob", "p", "p_true", "true_probability", "noul")
CONFIDENCE_KEYS = ("confidence", "certainty", "confidence_score")


class JevQuestionType(StrEnum):
    CHOICE = "choice"
    SCORE = "score"
    NOUL = "noul"


class JevError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass
class JevQuestion:
    """一个问题定义。`criteria`：choice 用字典，score 用数组，noul 不需要。"""

    id: str
    type: JevQuestionType
    instructions: str
    criteria: dict[str, str] | list[str] | None = None

    def to_payload(self) -> dict[str, Any]:
        body: dict[str, Any] = {"type": self.type.value, "instructions": self.instructions}
        if self.type == JevQuestionType.CHOICE:
            if not isinstance(self.criteria, dict) or not self.criteria:
                raise ValueError(f"choice 问题 {self.id} 必须给 criteria 字典")
            body["criteria"] = dict(self.criteria)
        elif self.type == JevQuestionType.SCORE:
            if not isinstance(self.criteria, list) or not self.criteria:
                raise ValueError(f"score 问题 {self.id} 必须给 criteria 数组")
            body["criteria"] = list(self.criteria)
        return body


@dataclass
class JevAnswer:
    """归一化后的一条答案。原始结构放 `raw`，标定时仍能看到。"""

    id: str
    kind: JevQuestionType
    label: str | None = None
    score: float | None = None
    confidence: float | None = None
    probabilities: dict[str, float] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    # ---- choice ----
    def best_choice(self) -> tuple[str | None, float]:
        if self.probabilities:
            label = max(self.probabilities, key=lambda key: self.probabilities[key])
            return label, float(self.probabilities[label])
        if self.label:
            return self.label, float(self.confidence or 0.0)
        return None, 0.0

    # ---- noul ----
    def true_probability(self) -> float:
        # 实测的 noul 标量优先（parser 已归一化到 score，这里只是兜底）
        for label in ("true", "yes", "是", "需要"):
            if label in self.probabilities:
                return _clamp(self.probabilities[label])
        if self.probabilities:
            return _clamp(max(self.probabilities.values()))
        if self.score is not None:
            # 0–1 视为概率；1–10 视为打分（文档里的 Score 是 2–10 级）
            value = self.score
            return _clamp(value if value <= 1 else value / 10.0)
        if self.label:
            lowered = self.label.strip().lower()
            if lowered in TRUE_LABELS:
                return _clamp(self.confidence if self.confidence is not None else 1.0)
            if lowered in FALSE_LABELS:
                return _clamp(1.0 - self.confidence if self.confidence is not None else 0.0)
        return 0.0

    # ---- score ----
    def normalized_score(self) -> float | None:
        """把 2–10 档分数归一到 0–1；已经是 0–1 的原样返回。"""
        if self.score is None:
            return None
        return _clamp(self.score if self.score <= 1 else self.score / 10.0)


@dataclass
class JevResult:
    answers: dict[str, JevAnswer] = field(default_factory=dict)
    model_version: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


class JevClient:
    """一次请求评估全部问题（文档：同一 `state` 上多个问题并行评估）。"""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.key = settings.jev_api_key
        self.base = (settings.jev_base_url or "").rstrip("/")
        endpoint = settings.jev_endpoint or DEFAULT_ENDPOINT
        self.endpoint = "/" + endpoint.lstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.key and self.base)

    async def evaluate(self, state: str, questions: list[JevQuestion]) -> JevResult:
        if not self.configured:
            raise JevError("not_configured", "Jev 未配置：缺少 JEV_API_KEY 或 JEV_BASE_URL")
        if not questions:
            return JevResult()
        try:
            payload_questions = {question.id: question.to_payload() for question in questions}
        except ValueError as exc:
            raise JevError("bad_question", str(exc)) from exc
        payload = {
            "model": self.settings.jev_model,
            "state": state,
            "questions": payload_questions,
        }
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        timeout = max(0.2, self.settings.jev_timeout_ms / 1000)
        url = f"{self.base}{self.endpoint}"
        try:
            async with httpx.AsyncClient(timeout=timeout, trust_env=self.settings.http_trust_env) as client:
                response = await client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException as exc:
            raise JevError("timeout", f"Jev 超时（>{int(timeout * 1000)}ms）") from exc
        except httpx.HTTPError as exc:
            raise JevError("http_error", f"Jev 请求失败：{exc}") from exc
        if response.status_code >= 400:
            detail = response.text[:300]
            raise JevError(
                f"http_{response.status_code}",
                f"TypeSafe 接口返回 HTTP {response.status_code}: {detail}",
            )
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise JevError("bad_response", "Jev 返回的不是 JSON") from exc
        if not isinstance(data, dict):
            raise JevError("bad_response", "Jev 返回的顶层不是对象")
        return parse_response(data, payload_questions)


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------


def parse_response(data: dict[str, Any], sent: dict[str, dict[str, Any]]) -> JevResult:
    answers_raw = data.get("answers")
    rows: dict[str, Any] = {}
    if isinstance(answers_raw, dict):
        rows = answers_raw
    elif isinstance(answers_raw, list):  # 兼容数组外壳
        for item in answers_raw:
            if isinstance(item, dict):
                identifier = item.get("id") or item.get("question_id") or item.get("question")
                if identifier:
                    rows[str(identifier)] = item
    if not rows:
        raise JevError("empty_answers", "Jev 响应里没有 answers")

    answers: dict[str, JevAnswer] = {}
    for identifier, raw in rows.items():
        kind = JevQuestionType(sent.get(identifier, {}).get("type") or _infer_type(raw))
        answers[str(identifier)] = _parse_answer(str(identifier), kind, raw)
    return JevResult(
        answers=answers,
        model_version=data.get("model") or data.get("model_version"),
        usage=data.get("usage") or {},
        raw=data,
    )


def _parse_answer(identifier: str, kind: JevQuestionType, raw: Any) -> JevAnswer:
    if isinstance(raw, bool):
        return JevAnswer(
            id=identifier,
            kind=kind,
            label="true" if raw else "false",
            score=1.0 if raw else 0.0,
            raw={"value": raw},
        )
    if isinstance(raw, (int, float)):
        return JevAnswer(id=identifier, kind=kind, score=float(raw), raw={"value": raw})
    if isinstance(raw, str):
        return JevAnswer(id=identifier, kind=kind, label=raw.strip(), raw={"value": raw})
    if not isinstance(raw, dict):
        return JevAnswer(id=identifier, kind=kind, raw={"unexpected": raw})

    # 实测 noul 的返回是 {"noul": 0.84, "type": "noul"}；
    # 也兼容 {"noul": {"probability": 0.84}} 这种嵌套写法
    if isinstance(raw.get("noul"), dict):
        raw = {**raw, **raw["noul"]}

    label = None
    for key in LABEL_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            label = value.strip()
            break
    score = None
    for key in SCORE_KEYS:
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            score = float(value)
            break
    confidence = None
    for key in CONFIDENCE_KEYS:
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            confidence = _clamp(float(value)) if key != "confidence_score" else _clamp(float(value))
            break
    probabilities: dict[str, float] = {}
    for key in PROB_DICT_KEYS:
        value = raw.get(key)
        if isinstance(value, dict):
            for option, prob in value.items():
                try:
                    probabilities[str(option)] = float(prob)
                except (TypeError, ValueError):
                    continue
            if probabilities:
                break

    # noul 常见写法：{"answer": true, "confidence": 0.86}
    answer_value = raw.get("answer")
    if kind == JevQuestionType.NOUL:
        if isinstance(answer_value, bool):
            label = "true" if answer_value else "false"
        probability = raw.get("probability") or raw.get("prob") or raw.get("p")
        if isinstance(probability, (int, float)) and not isinstance(probability, bool):
            score = float(probability)

    return JevAnswer(
        id=identifier,
        kind=kind,
        label=label,
        score=score,
        confidence=confidence,
        probabilities=probabilities,
        raw=raw,
    )


def _infer_type(raw: Any) -> str:
    if isinstance(raw, dict):
        if raw.get("type") in {item.value for item in JevQuestionType}:
            return str(raw["type"])
        if any(key in raw for key in LABEL_KEYS):
            return JevQuestionType.CHOICE.value
        if any(key in raw for key in ("score", "rating")):
            return JevQuestionType.SCORE.value
    return JevQuestionType.NOUL.value


def _clamp(value: float) -> float:
    if value != value:  # NaN
        return 0.0
    return max(0.0, min(1.0, float(value)))
