"""API-edge JSON helpers.

Pydantic models stay snake_case internally (matching docs/01 architecture).
The HTTP/SSE boundary is camelCase to match the React contracts in docs/02 and
the prototype's props.  Converting in one place keeps both sides honest.
"""

from __future__ import annotations

import re
from typing import Any

_CAMEL_RE = re.compile(r"_([a-z0-9])")


def camel_key(key: str) -> str:
    return _CAMEL_RE.sub(lambda m: m.group(1).upper(), key)


def to_camel(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            camel_key(str(k)): to_camel(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [to_camel(v) for v in value]
    if isinstance(value, tuple):
        return [to_camel(v) for v in value]
    if isinstance(value, str) and re.fullmatch(r"\d{2}:\d{2}:\d{2}", value):
        return value[:5]
    return value


def to_snake(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            snake = re.sub(r"(?<!^)(?=[A-Z])", "_", str(key)).lower()
            out[snake] = to_snake(item)
        return out
    if isinstance(value, list):
        return [to_snake(v) for v in value]
    return value
