"""What the copilot does when asked: chip actions, questions, rewrites.

Each runs Nemotron with the screen as context and a few tools: `look` (the
vision model answers one question about the window), `search_recall` (what
was on screen in past days), `search_knowledge` (the knowledge bases the user
attached) and `propose_todo` (the user accepts or ignores it in the notch).
Answers stream as card events. Text meant for the app comes back in an
```apply block, or a ```fill block for form fields, and becomes the card's
suggestion and its Apply plan.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from polly_server.copilot import brain, lenses, recall, replies, vision
from polly_server.copilot import settings as copilot_settings
from polly_server.copilot.context import Snapshot, describe, now_line

MAX_STEPS = 5

APPLY_RULES = """\
When your answer includes text the user should put into the app (a reply, a \
rewrite, a formula, a command), put exactly that text in one fenced block \
marked apply — add cell=A1 when it belongs in a spreadsheet cell:
```apply
the text
```
Put nothing else inside the block. Write everything else in short plain \
markdown: no headings, no preamble, no sign-off."""

TOOLS_NOTE = """\
Tools: `look` asks a vision model one precise question about the user's window \
when the text you have is not enough (charts, images, layout, a highlighted \
cell, a canvas app). `search_recall` searches what was on the user's screen in \
past days. `propose_todo` offers the user a to-do to accept. Use a tool only \
when it is needed; most answers need none."""

ACT_SYSTEM = """\
You are Polly, the user's copilot in their Mac's notch. The user clicked the \
action "{label}" while looking at the screen described below. Do it now, \
concretely and briefly.

{instructions}

{apply_rules}

{tools}

{facts}"""

ASK_SYSTEM = """\
You are Polly, the user's copilot in their Mac's notch. The user asks you \
something while looking at the screen described below; "this" means what is \
on screen. Answer directly and briefly.

{apply_rules}

{tools}{knowledge}

{facts}"""

REWRITE_SYSTEM = """\
You rewrite text the user selected in another app. Follow the instruction, \
keep the meaning, the language and the user's voice unless told otherwise, \
and keep the formatting (line breaks, lists). Reply with the rewritten text \
only: no quotation marks, no commentary."""

CHIP_INSTRUCTIONS: dict[str, str] = {
    "summarize_thread": "Summarize the thread in 3-6 bullets: who wants what, decisions, "
    "open questions, deadlines. Bold names and dates.",
    "summarize_chat": "Summarize the visible conversation in 3-6 bullets: what was "
    "discussed, what was decided, what is still open, and anything asked of the user.",
    "summarize": "Summarize what is on screen in 3-6 bullets.",
    "summarize_page": "Summarize the page in 3-6 bullets.",
    "key_points": "List the key points as short bullets, most important first.",
    "draft_reply": "Write the reply the user should send, in their voice, in an apply "
    "block. Nothing else.",
    "action_items": "List the action items for the user, with deadlines. Call "
    "`propose_todo` for each one that is the user's to do.",
    "find_todos": "Find what the user is asked to do or has promised to do in this "
    "conversation. Call `propose_todo` for each, then list them briefly.",
    "analyze_selected": "Analyze the selected cells (or the visible data if nothing is "
    "selected): what the numbers show, totals or averages worth knowing, outliers, "
    "trends.",
    "solve_errors": "Find cells showing errors (#DIV/0!, #REF!, #NAME?, #VALUE!, #N/A) "
    "or formulas that look wrong. Explain each cause in one line and give the fixed "
    "formula for the first one in an apply block with its cell.",
    "describe_improve": "Say in two sentences what this sheet does, then suggest three "
    "concrete improvements (formulas, structure, checks). Give the most useful formula "
    "in an apply block with its cell.",
    "write_formula": "Work out the formula the user most likely needs next — for the "
    "selected cell, or the first empty cell of a column whose header calls for a "
    "calculation. Put it in an apply block with its cell, then one sentence on what it "
    "does and whether to fill it down.",
    "fill_form": "Fill the form fields listed below from what Polly knows about the user "
    "and from the screen. Reply with a fenced block marked fill holding a JSON list, "
    'like:\n```fill\n[{"field": 1, "value": "Jane Doe"}, {"field": 4, "value": "1"}]\n'
    '```\nUse the field numbers from the list; check boxes take "1" or "0". Leave out '
    "fields you do not know — never invent personal details. After the block, list in "
    "one line which fields still need the user.",
    "improve_writing": "Rewrite the user's text — the selection, else the field they are "
    "typing in — so it reads better, keeping meaning and voice. Put the full new text "
    "in an apply block, then one line on what changed.",
    "proofread": "Correct spelling, grammar and punctuation only, in the selection or "
    "else the field they are typing in. Put the corrected text in an apply block, then "
    "list the changes in one line.",
    "explain": "Explain what is on screen plainly, in a few sentences or bullets.",
    "explain_screen": "Explain what is on screen plainly, in a few sentences or bullets.",
    "find_bugs": "Look for bugs in the visible code. List concrete issues with where "
    "they are and how to fix each.",
    "fix_error": "Find the error shown (terminal output, compiler, linter, stack trace), "
    "explain the cause in one line and give the fix. If the fix is one command or "
    "snippet, put it in an apply block.",
}

_FILL = re.compile(r"```fill\s*\n(.*?)```", re.S)


def _effort(chip_id: str, agentic: bool) -> str:
    """Actions that produce something think a little first; reading ones answer at once."""
    if agentic or chip_id in ("solve_errors", "write_formula", "fill_form"):
        return "medium"
    return "none"


def _tools(snapshot: Snapshot | None, kb_ids: list[str], events: list[dict[str, Any]]) -> list[Any]:
    """The tools for one run; what they find is also shown in the notch, via `events`."""
    tools: list[Any] = []

    if snapshot is not None and snapshot.screenshot is not None:

        @tool
        async def look(
            question: Annotated[str, "One precise question about what the window shows."],
        ) -> str:
            """Ask a vision model about the user's window (its screenshot)."""
            events.append({"type": "looking", "question": question})
            return await vision.look(snapshot, question)

        tools.append(look)

    if copilot_settings.load().recall.enabled:

        @tool
        async def search_recall(
            query: Annotated[str, "What to look for, in a few words, e.g. 'email about the DPA'."],
        ) -> str:
            """Search the text of windows the user had on screen in past days: emails,
            chats, pages, documents. Returns the best matches with app, window and time."""
            events.append({"type": "status", "text": "Searching what you've seen…"})
            try:
                hits = await recall.search(query)
            except Exception as exc:  # noqa: BLE001
                return f"Recall is not available ({exc})."
            events.append({"type": "recall", "hits": hits})
            if not hits:
                return "Nothing matching on screen in the recent history."
            return "\n".join(
                f"[{n}] {h['app']} · {h['window']} · {h['url'] or ''} · seen "
                f"{_ago(h['at'])}: {h['excerpt']}"
                for n, h in enumerate(hits, start=1)
            )

        tools.append(search_recall)

    if kb_ids:

        @tool
        async def search_knowledge(
            query: Annotated[str, "What to look for in the user's knowledge files."],
        ) -> str:
            """Search the knowledge bases the user attached to this question."""
            from polly_server import knowledge

            hits = await knowledge.search(kb_ids, query, k=8)
            sources = [
                {
                    "n": n,
                    "file_id": h.file_id,
                    "file_name": h.file_name,
                    "page": h.page,
                    "excerpt": h.text[:300],
                }
                for n, h in enumerate(hits, start=1)
            ]
            events.append({"type": "sources", "sources": sources})
            if not hits:
                return "No matching passages in the attached files."
            return "\n\n".join(
                f"[{s['n']}] {s['file_name']}"
                + (f", page {s['page']}" if s["page"] else "")
                + f"\n{h.text}"
                for s, h in zip(sources, hits, strict=True)
            )

        tools.append(search_knowledge)

    @tool
    def propose_todo(
        title: Annotated[str, "Imperative, under 80 characters."],
        due: Annotated[str | None, "YYYY-MM-DDTHH:MM in local time, or null."] = None,
        notes: Annotated[str, "One sentence of context."] = "",
        evidence: Annotated[list[str] | None, "Exact short phrases from the screen."] = None,
    ) -> str:
        """Offer the user a to-do. They accept or ignore it in the notch."""
        found = brain.todo_proposals(
            [
                {
                    "title": title,
                    "due": due,
                    "notes": notes,
                    "evidence": evidence or [],
                    "confidence": 1.0,
                }
            ],
            snapshot or Snapshot(),
        )
        for proposal in found:
            events.append({"type": "todo", "todo": proposal})
        return "Offered to the user." if found else "Already on their list or offered before."

    tools.append(propose_todo)
    return tools


def _ago(at: float) -> str:
    minutes = int((time.time() - at) // 60)
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes} min ago"
    if minutes < 48 * 60:
        return f"{minutes // 60} h ago"
    return f"{minutes // 1440} days ago"


async def _run(
    system: str,
    messages: list[Any],
    tools: list[Any],
    events: list[dict[str, Any]],
    *,
    effort: str,
    card: dict[str, Any],
    finish: Callable[[str], tuple[str, str | None, dict[str, Any] | None]],
) -> AsyncIterator[dict[str, Any]]:
    """Streams one tool-using run as card events."""
    from polly_server.models import chat_model

    prefs = copilot_settings.load()
    model = chat_model(model=prefs.brain_model, reasoning_effort=effort, max_tokens=8_000)
    bound = model.bind_tools(tools) if tools else model
    by_name = {t.name: t for t in tools}
    convo: list[Any] = [SystemMessage(content=system), *messages]
    card_id = card["id"]
    yield {"type": "card.start", **card}
    text = ""
    for _ in range(MAX_STEPS):
        full = None
        async for chunk in bound.astream(convo):
            full = chunk if full is None else full + chunk
            delta = replies.text_of(chunk)
            if delta:
                text += delta
                yield {"type": "card.delta", "id": card_id, "text": delta}
        calls = list(getattr(full, "tool_calls", None) or [])
        if not calls:
            break
        convo.append(
            AIMessage(
                content=full.content,
                tool_calls=calls,
                additional_kwargs=dict(full.additional_kwargs),
            )
        )
        for call in calls:
            chosen = by_name.get(call["name"])
            try:
                result = await chosen.ainvoke(call["args"]) if chosen else "No such tool."
            except Exception as exc:  # noqa: BLE001 - a failed tool is reported to the model
                result = f"The tool failed: {exc}"
            while events:
                yield events.pop(0)
            convo.append(ToolMessage(content=str(result), tool_call_id=call["id"]))
    shown, suggestion, plan = finish(text.strip())
    yield {
        "type": "card.done",
        "id": card_id,
        "text": shown,
        "suggestion": suggestion,
        "apply": plan,
    }


def _fill_plan(text: str, snapshot: Snapshot) -> tuple[str, str | None, dict[str, Any] | None]:
    match = _FILL.search(text)
    rest = (text[: match.start()] + text[match.end() :]).strip() if match else text
    if not match:
        return rest, None, None
    try:
        items = json.loads(match.group(1))
    except ValueError:
        return rest, None, None
    fields = []
    for item in items if isinstance(items, list) else []:
        try:
            index = int(item.get("field")) - 1
        except (AttributeError, TypeError, ValueError):
            continue
        if 0 <= index < len(snapshot.fields) and snapshot.fields[index].token:
            field = snapshot.fields[index]
            fields.append({"token": field.token, "label": field.label, "text": str(item["value"])})
    if not fields:
        return rest, None, None
    listed = "\n".join(f"{f['label'] or 'Field'}: {f['text']}" for f in fields)
    return rest, listed, {"kind": "fill_fields", "text": "", "fields": fields, "token": None}


def clear_form(snapshot: Snapshot) -> list[dict[str, Any]]:
    """Clearing needs no model: every filled field goes back to empty."""
    card_id = uuid.uuid4().hex[:10]
    fields = []
    for field in snapshot.fields:
        if not field.token or field.value in (None, "", "0"):
            continue
        empty = "0" if field.role in ("AXCheckBox", "AXRadioButton") else ""
        fields.append({"token": field.token, "label": field.label, "text": empty})
    start = {
        "type": "card.start",
        "id": card_id,
        "kind": "info",
        "title": "Clear form",
        "proactive": False,
    }
    if not fields:
        done = {
            "type": "card.done",
            "id": card_id,
            "text": "No filled fields to clear.",
            "suggestion": None,
            "apply": None,
        }
        return [start, done]
    listed = "\n".join(f"{f['label'] or 'Field'}" for f in fields)
    done = {
        "type": "card.done",
        "id": card_id,
        "text": f"{len(fields)} filled field{'s' if len(fields) != 1 else ''} will be emptied.",
        "suggestion": listed,
        "apply": {"kind": "fill_fields", "text": "", "fields": fields, "token": None},
    }
    return [start, done]


async def act(
    chip_id: str, label: str, snapshot: Snapshot, kb_ids: list[str], *, agentic: bool = False
) -> AsyncIterator[dict[str, Any]]:
    if chip_id == "clear_form":
        for event in clear_form(snapshot):
            yield event
        return

    scene = vision.cached(snapshot)
    lens = lenses.detect(snapshot)
    instructions = CHIP_INSTRUCTIONS.get(chip_id) or f"Do this for the user: {label}."
    system = ACT_SYSTEM.format(
        label=label,
        instructions=f"{instructions}\n\nKind of app: {lens.guidance}",
        apply_rules=APPLY_RULES,
        tools=TOOLS_NOTE,
        facts=brain.facts(),
    )
    prompt = "\n".join([now_line(), "", describe(snapshot, scene.text() if scene else None)])
    events: list[dict[str, Any]] = []

    def finish(text: str):
        if chip_id == "fill_form":
            return _fill_plan(text, snapshot)
        kind = "reply_draft" if chip_id == "draft_reply" and "```apply" not in text else "answer"
        return brain.apply_plan(kind, text, snapshot)

    card = {
        "id": uuid.uuid4().hex[:10],
        "kind": "answer",
        "title": label,
        "proactive": False,
    }
    async for event in _run(
        system,
        [HumanMessage(content=prompt)],
        _tools(snapshot, kb_ids, events),
        events,
        effort=_effort(chip_id, agentic),
        card=card,
        finish=finish,
    ):
        yield event


async def ask(
    message: str,
    history: list[dict[str, str]],
    snapshot: Snapshot | None,
    kb_ids: list[str],
) -> AsyncIterator[dict[str, Any]]:
    knowledge_note = (
        "\n`search_knowledge` searches the knowledge files the user attached; use it for "
        "anything those files may cover and cite passages as [n]."
        if kb_ids
        else ""
    )
    system = ASK_SYSTEM.format(
        apply_rules=APPLY_RULES, tools=TOOLS_NOTE, knowledge=knowledge_note, facts=brain.facts()
    )
    if snapshot is not None and not snapshot.excluded:
        scene = vision.cached(snapshot)
        screen = describe(snapshot, scene.text() if scene else None)
    else:
        screen = "(The copilot is not reading the screen right now.)"
    messages: list[Any] = []
    for turn in history[-10:]:
        if turn.get("role") == "user":
            messages.append(HumanMessage(content=turn.get("text", "")))
        elif turn.get("role") == "assistant":
            messages.append(AIMessage(content=turn.get("text", "")))
    messages.append(
        HumanMessage(content=f"{now_line()}\n\nOn screen:\n{screen}\n\nThe user asks: {message}")
    )
    events: list[dict[str, Any]] = []
    target = snapshot or Snapshot()
    card = {
        "id": uuid.uuid4().hex[:10],
        "kind": "answer",
        "title": message[:80],
        "proactive": False,
    }
    async for event in _run(
        system,
        messages,
        _tools(snapshot, kb_ids, events),
        events,
        effort="medium",
        card=card,
        finish=lambda text: brain.apply_plan("answer", text, target),
    ):
        yield event


async def rewrite(
    text: str, instruction: str, token: str | None, app: str | None
) -> AsyncIterator[dict[str, Any]]:
    from polly_server.models import chat_model

    card_id = uuid.uuid4().hex[:10]
    yield {
        "type": "card.start",
        "id": card_id,
        "kind": "rewrite",
        "title": instruction[:80],
        "proactive": False,
    }
    prefs = copilot_settings.load()
    model = chat_model(model=prefs.brain_model, reasoning_effort="none", max_tokens=6_000)
    where = f" in {app}" if app else ""
    prompt = f'Instruction: {instruction}\n\nThe text the user selected{where}:\n"""\n{text}\n"""'
    out = ""
    async for chunk in model.astream(
        [SystemMessage(content=REWRITE_SYSTEM), HumanMessage(content=prompt)]
    ):
        delta = replies.text_of(chunk)
        if delta:
            out += delta
            yield {"type": "card.delta", "id": card_id, "text": delta}
    out = out.strip().strip('"').strip()
    plan = {"kind": "replace_selection", "text": out, "token": token} if token else None
    yield {"type": "card.done", "id": card_id, "text": "", "suggestion": out, "apply": plan}
