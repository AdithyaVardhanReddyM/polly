"""Tools an agent calls once at the end to hand in structured results: a
change report (after a Coder run) or a pull request scorecard. The result is
saved next to the session and announced to the app as an event."""

from __future__ import annotations

import time
from typing import Annotated, Any, Literal

from langchain.tools import ToolRuntime
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from polly_server import artifacts
from polly_server.research import sources
from polly_server.reviewer import scoring
from polly_server.reviewer.scoring import CategoryScore, ReviewFinding


class ChangeFinding(BaseModel):
    severity: Literal["critical", "high", "medium", "low", "info"]
    title: str
    detail: str = Field(description="What you found and what to do about it.")
    file: str | None = Field(default=None, description="Project file it concerns, if any.")
    sources: list[int] = Field(default_factory=list, description="Source numbers backing this.")


def _dump(items: list[Any]) -> list[dict[str, Any]]:
    return [i.model_dump() if isinstance(i, BaseModel) else dict(i) for i in items]


def _emit(runtime: ToolRuntime, event: dict[str, Any]) -> None:
    writer = getattr(runtime, "stream_writer", None)
    if writer is None:
        return
    try:
        writer(event)
    except Exception:  # noqa: BLE001 - saved on disk either way
        pass


def _cited(session_id: str, findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ids = sorted({i for f in findings for i in f.get("sources") or []})
    return [s.model_dump() for s in sources.resolve(session_id, ids)]


@tool
def submit_change_report(
    runtime: ToolRuntime,
    summary: Annotated[str, "Two to four sentences: what changed and whether it holds up."],
    verdict: Annotated[
        Literal["looks_good", "needs_attention", "risky"],
        "looks_good: nothing to fix; needs_attention: worth fixing; risky: do not ship as is.",
    ],
    findings: Annotated[list[ChangeFinding], "Issues and confirmations, most severe first."],
    pr_title: Annotated[str, "A pull request title, imperative mood, under 72 characters."],
    pr_description: Annotated[
        str, "A ready-to-paste PR description in markdown: why, what, how it was tested, notes."
    ],
) -> str:
    """Hand in the change report. Call it exactly once, after your research."""
    session_id = artifacts.session_id_of(runtime)
    found = _dump(findings)
    report = {
        "summary": summary.strip(),
        "verdict": verdict,
        "findings": found,
        "pr_title": pr_title.strip(),
        "pr_description": pr_description.strip(),
        "sources": _cited(session_id, found),
        "created_at": time.time(),
    }
    artifacts.save(session_id, "report", report)
    _emit(runtime, {"type": "report", "report": report})
    return "Report saved and shown to the user. Reply with a one-paragraph wrap-up."


@tool
def submit_scorecard(
    runtime: ToolRuntime,
    summary: Annotated[str, "Two to four sentences: what the PR does and how good it is."],
    categories: Annotated[
        list[CategoryScore],
        "One entry per category: " + ", ".join(scoring.CATEGORIES) + ".",
    ],
    findings: Annotated[
        list[ReviewFinding], "Problems worth the author's time, most severe first."
    ],
    strengths: Annotated[list[str] | None, "What the PR does well, briefly."] = None,
) -> str:
    """Hand in the PR scorecard. Call it exactly once, after reading the whole diff."""
    cats = [
        c if isinstance(c, CategoryScore) else CategoryScore.model_validate(c) for c in categories
    ]
    finds = [
        f if isinstance(f, ReviewFinding) else ReviewFinding.model_validate(f) for f in findings
    ]
    missing = scoring.missing_categories(cats)
    if missing:
        return f"Not saved: score every category. Missing: {', '.join(missing)}. Call again."
    session_id = artifacts.session_id_of(runtime)
    facts = artifacts.load(session_id, "pr", {}) or {}
    card = scoring.compute(cats, finds, facts)
    found = _dump(finds)
    card.update(
        {
            "summary": summary.strip(),
            "strengths": [s for s in (strengths or []) if s.strip()],
            "findings": found,
            "sources": _cited(session_id, found),
            "pr": {
                k: facts.get(k)
                for k in (
                    "url",
                    "slug",
                    "title",
                    "author",
                    "additions",
                    "deletions",
                    "changed_files",
                    "ci",
                    "partial",
                )
            },
            "created_at": time.time(),
        }
    )
    artifacts.save(session_id, "scorecard", card)
    _emit(runtime, {"type": "scorecard", "scorecard": card})
    return (
        f"Scorecard saved: {card['total']}/100 ({card['grade']}), verdict {card['verdict']}. "
        "Reply with a short wrap-up for the user; do not repeat the table."
    )


REPORT_TOOLS = (submit_change_report, submit_scorecard)
