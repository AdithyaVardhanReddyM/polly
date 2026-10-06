"""Reading model replies: the JSON the brain is asked for, and plain text."""

from __future__ import annotations

import json
import re
from typing import Any

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_json(text: str) -> dict[str, Any] | None:
    """The first JSON object in a reply, fenced or bare; None if there is none.

    Models asked for "JSON only" still wrap it in fences or add a sentence
    around it now and then.
    """
    text = text.strip()
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    for candidate in candidates:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start == -1 or end <= start:
            continue
        try:
            value = json.loads(candidate[start : end + 1])
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def text_of(message: Any) -> str:
    """The answer text of a model message, without its reasoning."""
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in content
        )
    return str(content or "")
