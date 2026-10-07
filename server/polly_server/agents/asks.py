"""Cards that pause a run until the user answers them.

A tool calls `ask(kind, **payload)`. The run stops (a LangGraph interrupt),
the app shows a card for it (`ask.required`), and the user's answer comes
back through `POST /sessions/{id}/answer` as the return value of `ask`.

LangGraph runs the tool again from the top when the run resumes, so a tool
asks first and acts after: nothing it does before `ask` may have side effects.

Kinds:

    hire       a new agent Polly wants to create        -> {"approved": bool}
    question   something only the user knows            -> {"answer": str}
    connect    an app that is not connected yet         -> {"connected": bool}
    variables  settings or secrets an agent needs       -> {"done": bool}
    confirm    keep a team, start a routine             -> {"approved": bool}

Unattended runs (routines) have no one to ask: `ask` returns None at once and
the tool tells the agent to carry on without the answer.
"""

from __future__ import annotations

from typing import Any, Literal

from polly_server.coder import permissions

AskKind = Literal["hire", "question", "connect", "variables", "confirm"]
KINDS: frozenset[str] = frozenset({"hire", "question", "connect", "variables", "confirm"})

# Marks an interrupt as one of ours, not a Deep Agents approval.
MARK = "polly_ask"

UNATTENDED = (
    "No one is watching this run (it is a routine), so you cannot ask the user. "
    "Carry on with what you have, or stop and say what you would need."
)


def unattended() -> bool:
    """Whether this run must not pause for the user."""
    return permissions.current_policy().ask_means_deny


def ask(kind: AskKind, **payload: Any) -> dict[str, Any] | None:
    """Pause for the user and return their answer; None when unattended."""
    from langgraph.types import interrupt

    if unattended():
        return None
    answer = interrupt({MARK: {"kind": kind, **payload}})
    return answer if isinstance(answer, dict) else {"answer": answer}


def payload_of(interrupt: Any) -> dict[str, Any] | None:
    """The card an interrupt asks for, or None for any other interrupt."""
    if isinstance(interrupt, list | tuple):
        interrupt = interrupt[0] if interrupt else None
    value = getattr(interrupt, "value", interrupt)
    if not isinstance(value, dict) or not isinstance(value.get(MARK), dict):
        return None
    card = value[MARK]
    if card.get("kind") not in KINDS:
        return None
    return {"interrupt_id": getattr(interrupt, "id", None), **card}
