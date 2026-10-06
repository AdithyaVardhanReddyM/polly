"""The copilot's brain: Nemotron decides what, if anything, to offer.

Every snapshot gets one quick triage call, thinking off: refreshed action
chips, at most one hint, and any to-dos aimed at the user. A hint the triage
is confident about is then written in a second, streamed call, so the notch
shows it as it is written. Being quiet is the common, correct answer; the
prompt says so, and confidence thresholds and per-window memory keep
repeats out.
"""

from __future__ import annotations

import logging
import os
import pwd
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from polly_server import memory
from polly_server.copilot import lenses, replies, vision
from polly_server.copilot import settings as copilot_settings
from polly_server.copilot.context import Snapshot, describe, now_line

log = logging.getLogger(__name__)

HINT_CONFIDENCE = 0.6
TODO_CONFIDENCE = 0.65
# The same hint is not offered again for the same window within this time.
HINT_REPEAT_S = 10 * 60

TRIAGE_SYSTEM = """\
You are Polly, a proactive copilot that lives in the notch of the user's Mac. \
You see what the user is doing — text read from their screen and what a \
vision model saw in a screenshot — and decide in a split second whether to \
offer help.

Be useful, never noisy. Most of the time the right call is to offer no hint \
and only refresh the action chips. Offer a hint only when you are confident it \
saves the user real effort right now:
- They are writing an email or message reply (the focused field is a composer \
and there is a thread or message to answer): draft it, or complete what they \
started (kind "reply_draft" or "completion"). A few typed words like "10am" or \
"sounds good" are a cue to write the full reply around them.
- They are in a spreadsheet and a formula is needed — they started typing one, \
or a column's header plainly calls for a calculation from other columns and \
its cells are empty (kind "formula").
- Something on screen is clearly broken and you can fix it: a formula error \
such as #DIV/0! or #REF!, a failing command in a terminal (kind "fix").
Never offer a hint for search boxes, address bars, login forms, passwords or \
payment details. Never repeat a hint listed under "Already offered".

Action chips: up to 4 short actions that fit this exact screen, in sentence \
case, 1-4 words ("Summarize thread", "Draft reply", "Write a formula", "Fill \
form"). Mark "agentic": true when the action produces something (drafts, \
fills, computes). Start from the suggested chips and adapt them. You can only \
use what is on screen, Polly's memory about the user, their knowledge files \
and their to-do list — you cannot read their email, calendar or other apps, so \
never offer actions like "Check calendar".

To-dos: things the user ({user}) is asked to do or has committed to do, with a \
clear action — not things for other people, not general information, not \
things already done, not items already in their to-do list. Resolve relative \
dates against the current time. Copy 1-3 short exact phrases from the screen \
as evidence. Most screens have none; return an empty list then.

Reply with one JSON object and nothing else:
{{
  "label": "short context, e.g. 'Gmail · Meeting with Maria' (app or site · subject)",
  "lens": "email | spreadsheet | pdf | chat | document | code | browser | generic",
  "chips": [{{"id": "snake_case", "label": "Sentence case", "agentic": false}}],
  "hint": null or {{"kind": "reply_draft | completion | formula | fix", \
"title": "what it is, e.g. 'Reply to Alexi' or 'Formula for I4'", \
"brief": "exactly what to write, in one or two sentences", "confidence": 0.0}},
  "todos": [{{"title": "imperative, under 80 characters", "notes": "one sentence of \
context", "due": "YYYY-MM-DDTHH:MM local time, or null", "evidence": ["exact phrase"], \
"confidence": 0.0}}]
}}"""

HINT_SYSTEM = """\
You are Polly, the user's copilot in their Mac's notch. Write the suggestion \
described below, ready to use as is. No preamble, no commentary.

{rules}

{facts}"""

HINT_RULES = {
    "reply_draft": (
        "Write only the full message to put in the field the user is typing in: the "
        "complete reply, built around anything they already typed. Match the thread's "
        "language and tone, keep it short, sign off with the user's first name when the "
        "thread is an email and the name is known. No subject line, no quotation marks."
    ),
    "completion": (
        "Write only the full text that should be in the field: what the user typed, "
        "completed and lightly polished. No quotation marks, no commentary."
    ),
    "formula": (
        "Put the formula in a fenced block that names the cell it goes in, exactly like:\n"
        "```apply cell=I4\n=SUM(D7:D20)\n```\n"
        "Exactly one block with one formula for one cell: the cell the user needs next "
        "(the selected one, or the first empty cell of the column that needs it). Use real "
        "cell references from the visible grid and this app's formula syntax. After the "
        "block, one short sentence on what it does and, if it should be filled down, over "
        "which range."
    ),
    "fix": (
        "Put the corrected text or formula in a fenced block marked apply (add cell=A1 when "
        "it goes in a spreadsheet cell), exactly like:\n```apply\ncorrected text\n```\n"
        "Then one short sentence on what was wrong."
    ),
}


def user_name() -> str:
    """The user's full name from their macOS account; "" when unknown."""
    try:
        return pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
    except (KeyError, OSError):
        return ""


def facts() -> str:
    """What Polly remembers about the user, for prompts; newest kept first."""
    lines: list[str] = []
    used = 0
    for item in reversed(memory.all_memories()):
        if used + len(item.text) > 3_000:
            break
        lines.append(f"- {item.text}")
        used += len(item.text)
    name = user_name()
    head = f"The user's name (from their Mac account): {name}." if name else ""
    known = "What Polly knows about the user:\n" + "\n".join(reversed(lines)) if lines else ""
    return "\n".join(part for part in (head, known) if part)


# ---------- memory of what was offered ----------

# window key → [(title, when)]: hints already shown there.
_offered: OrderedDict[str, list[tuple[str, float]]] = OrderedDict()
# Normalised titles of to-dos proposed or dismissed, so they are not offered twice.
_proposed: OrderedDict[str, float] = OrderedDict()


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.casefold()).split())


def offered_hints(key: str) -> list[str]:
    now = time.time()
    return [title for title, when in _offered.get(key, []) if now - when < HINT_REPEAT_S]


def remember_hint(key: str, title: str) -> None:
    entries = [e for e in _offered.get(key, []) if time.time() - e[1] < HINT_REPEAT_S]
    entries.append((title, time.time()))
    _offered[key] = entries[-6:]
    _offered.move_to_end(key)
    while len(_offered) > 200:
        _offered.popitem(last=False)


def todo_seen(title: str) -> bool:
    return _norm(title) in _proposed


def remember_todo(title: str) -> None:
    _proposed[_norm(title)] = time.time()
    while len(_proposed) > 500:
        _proposed.popitem(last=False)


# ---------- triage ----------


def _open_todos() -> str:
    from polly_server import todos

    try:
        items = todos.all_todos("open")[:15]
    except Exception:  # noqa: BLE001 - the list only helps avoid duplicates
        return ""
    if not items:
        return ""
    return "Already in their to-do list:\n" + "\n".join(f"- {t.title}" for t in items)


def _triage_prompt(trigger: str, snapshot: Snapshot, scene: str | None) -> str:
    lens = lenses.detect(snapshot)
    already = offered_hints(snapshot.window_key)
    parts = [
        now_line(),
        f"Trigger: {TRIGGERS.get(trigger, trigger)}",
        f"Kind of app: {lens.id} — {lens.guidance}",
        "Suggested chips: " + ", ".join(c.label for c in lens.chips),
        "Already offered here: " + ("; ".join(already) if already else "nothing"),
        _open_todos(),
        facts(),
        "",
        describe(snapshot, scene),
    ]
    return "\n".join(part for part in parts if part is not None)


TRIGGERS = {
    "switch": "the user just switched to this window",
    "typing": "the user typed in the focused field and paused",
    "content": "new content appeared in this window",
    "visual": "the window changed noticeably",
    "open": "the user opened the notch to see suggestions",
}


async def triage(trigger: str, snapshot: Snapshot, scene: str | None) -> dict[str, Any]:
    from polly_server.models import chat_model

    prefs = copilot_settings.load()
    model = chat_model(model=prefs.brain_model, reasoning_effort="none", max_tokens=1_500)
    reply = await model.ainvoke(
        [
            SystemMessage(content=TRIAGE_SYSTEM.format(user=user_name() or "the user")),
            HumanMessage(content=_triage_prompt(trigger, snapshot, scene)),
        ]
    )
    return replies.parse_json(replies.text_of(reply)) or {}


def clean_chips(raw: Any) -> list[dict[str, Any]]:
    chips: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        label = " ".join(str(item.get("label") or "").split())[:32]
        if not label:
            continue
        chip_id = re.sub(r"[^a-z0-9_]+", "_", str(item.get("id") or label).casefold()).strip("_")
        agentic = bool(item.get("agentic"))
        chips.append({"id": chip_id or "action", "label": label, "agentic": agentic})
    return chips[:4]


def _due(value: Any) -> float | None:
    if not value or not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.astimezone()
    return when.timestamp()


def todo_proposals(raw: Any, snapshot: Snapshot) -> list[dict[str, Any]]:
    """To-dos worth proposing: confident, new, and not already on the list."""
    from polly_server import todos

    found: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        title = " ".join(str(item.get("title") or "").split())[:120]
        try:
            confidence = float(item.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if not title or confidence < TODO_CONFIDENCE or todo_seen(title):
            continue
        try:
            if todos.similar_open(title):
                remember_todo(title)
                continue
        except Exception:  # noqa: BLE001
            pass
        evidence = [str(e)[:160] for e in item.get("evidence") or [] if str(e).strip()][:3]
        remember_todo(title)
        found.append(
            {
                "id": uuid.uuid4().hex[:10],
                "title": title,
                "notes": str(item.get("notes") or "")[:300],
                "due_at": _due(item.get("due")),
                "evidence": evidence,
                "source": {
                    "kind": "copilot",
                    "app": snapshot.app.name,
                    "bundle_id": snapshot.app.bundleId,
                    "window": snapshot.window.title,
                    "url": snapshot.url,
                    "excerpt": evidence[0] if evidence else None,
                },
            }
        )
    return found


# ---------- hints ----------

_APPLY = re.compile(r"```apply([^\n]*)\n(.*?)```", re.S)
_CELL = re.compile(r"\bcell\s*=\s*\$?([A-Za-z]{1,3}\$?\d{1,7})")


def split_apply(text: str) -> tuple[str, str | None, str | None]:
    """(text without the apply block, the text to apply, its cell)."""
    match = _APPLY.search(text)
    if not match:
        return text.strip(), None, None
    attrs, body = match.group(1), match.group(2).strip("\n")
    cell = _CELL.search(attrs)
    rest = (text[: match.start()] + text[match.end() :]).strip()
    return rest, body, cell.group(1).upper().replace("$", "") if cell else None


def apply_plan(
    kind: str, text: str, snapshot: Snapshot
) -> tuple[str, str | None, dict[str, Any] | None]:
    """(the card's markdown, the suggestion for the app, how Apply puts it there)."""
    focused = snapshot.focused
    editable = bool(focused and focused.editable and not focused.secure)
    if kind in ("reply_draft", "completion", "rewrite"):
        if kind == "rewrite" and snapshot.selection and snapshot.selection.token:
            plan = {"kind": "replace_selection", "text": text, "token": snapshot.selection.token}
        elif editable:
            plan = {"kind": "replace_field", "text": text, "token": focused.token}
        else:
            plan = None
        return "", text, plan

    rest, body, cell = split_apply(text)
    if body is None:
        return text, None, None
    if cell:
        return rest, body, {"kind": "cell", "text": body, "cell": cell, "token": None}
    if snapshot.selection and snapshot.selection.editable and snapshot.selection.token:
        token = snapshot.selection.token
        return rest, body, {"kind": "replace_selection", "text": body, "token": token}
    if editable:
        return rest, body, {"kind": "replace_field", "text": body, "token": focused.token}
    return rest, body, None


async def write_hint(
    hint: dict[str, Any], snapshot: Snapshot, scene: str | None
) -> AsyncIterator[dict[str, Any]]:
    """Streams one hint as card events."""
    from polly_server.models import chat_model

    kind = hint["kind"]
    card_id = uuid.uuid4().hex[:10]
    yield {
        "type": "card.start",
        "id": card_id,
        "kind": kind,
        "title": hint["title"],
        "proactive": True,
    }
    prefs = copilot_settings.load()
    # A formula has to be right; let it think a little. Drafts are fine without.
    effort = "medium" if kind in ("formula", "fix") else "none"
    model = chat_model(model=prefs.brain_model, reasoning_effort=effort, max_tokens=6_000)
    system = HINT_SYSTEM.format(rules=HINT_RULES.get(kind, ""), facts=facts())
    prompt = "\n".join(
        [
            now_line(),
            f"Suggestion to write: {hint['title']} — {hint['brief']}",
            "",
            describe(snapshot, scene),
        ]
    )
    text = ""
    async for chunk in model.astream([SystemMessage(content=system), HumanMessage(content=prompt)]):
        delta = replies.text_of(chunk)
        if delta:
            text += delta
            yield {"type": "card.delta", "id": card_id, "text": delta}
    shown, suggestion, plan = apply_plan(kind, text.strip(), snapshot)
    yield {
        "type": "card.done",
        "id": card_id,
        "text": shown,
        "suggestion": suggestion,
        "apply": plan,
    }


def pick_hint(data: dict[str, Any], snapshot: Snapshot, lens: str) -> dict[str, Any] | None:
    hint = data.get("hint")
    if not isinstance(hint, dict):
        return None
    kind = str(hint.get("kind") or "")
    title = " ".join(str(hint.get("title") or "").split())[:80]
    try:
        confidence = float(hint.get("confidence") or 0)
    except (TypeError, ValueError):
        return None
    if kind not in HINT_RULES or not title or confidence < HINT_CONFIDENCE:
        return None
    if copilot_settings.load().is_muted(lens, kind):
        return None
    if title in offered_hints(snapshot.window_key):
        return None
    return {"kind": kind, "title": title, "brief": str(hint.get("brief") or title)}


async def scene_for(snapshot: Snapshot) -> str | None:
    scene = await vision.glance(snapshot)
    return scene.text() if scene else None
