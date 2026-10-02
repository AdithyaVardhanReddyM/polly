"""Scoring a pull request.

The model judges each category from 0 to 10 and backs it with evidence; the
arithmetic is ours. Weights, caps and grade boundaries live here so the same
review always produces the same number, and so every adjustment can be shown.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Severity = Literal["critical", "high", "medium", "low", "info"]

# key: (weight, label, what it covers)
CATEGORIES: dict[str, tuple[int, str, str]] = {
    "correctness": (
        25,
        "Correctness",
        "Does it do what it claims, including edge cases and errors?",
    ),
    "tests": (20, "Tests & CI", "Are the changes covered by tests, and is CI green?"),
    "security": (
        15,
        "Security",
        "Injection, secrets, authz, unsafe input, vulnerable dependencies.",
    ),
    "maintainability": (
        15,
        "Maintainability",
        "Readable, idiomatic, consistent with the codebase.",
    ),
    "performance": (10, "Performance", "No needless work, N+1 calls, blocking I/O or leaks."),
    "scope": (10, "Scope & hygiene", "Focused, sensibly sized, described, linked to an issue."),
    "docs": (5, "Docs", "Public behaviour, config and APIs documented where needed."),
}
assert sum(w for w, _, _ in CATEGORIES.values()) == 100

CAP_CI_FAILING = 60
CAP_CRITICAL = 40
CAP_HIGH = 79
UNTESTED_TESTS_MAX = 5.0
CI_FAILING_TESTS_MAX = 3.0


class CategoryScore(BaseModel):
    key: str = Field(description="One of: " + ", ".join(CATEGORIES))
    score: float = Field(
        ge=0, le=10, description="0 = broken, 5 = significant problems, 8 = good, 10 = exemplary"
    )
    rationale: str = Field(description="One or two sentences on why.")
    evidence: list[str] = Field(
        default_factory=list,
        description="Pointers: 'path/file.py:42' or source numbers like '[3]'.",
    )


class ReviewFinding(BaseModel):
    severity: Severity
    title: str
    detail: str
    file: str | None = None
    line: int | None = None
    suggestion: str | None = Field(default=None, description="A concrete fix, code if short.")
    sources: list[int] = Field(default_factory=list, description="Source numbers backing this.")


def grade(total: int) -> str:
    for floor, letter in ((90, "A"), (80, "B"), (70, "C"), (60, "D")):
        if total >= floor:
            return letter
    return "F"


def missing_categories(categories: list[CategoryScore]) -> list[str]:
    have = {c.key for c in categories}
    return [k for k in CATEGORIES if k not in have]


def compute(
    categories: list[CategoryScore],
    findings: list[ReviewFinding],
    facts: dict[str, Any] | None,
) -> dict[str, Any]:
    """Weighted total, caps and verdict. `categories` must cover every key."""
    facts = facts or {}
    by_key = {c.key: c for c in categories if c.key in CATEGORIES}
    adjustments: list[str] = []
    scores = {k: float(by_key[k].score) for k in CATEGORIES}

    ci = (facts.get("ci") or {}).get("state")
    if ci == "failing" and scores["tests"] > CI_FAILING_TESTS_MAX:
        scores["tests"] = CI_FAILING_TESTS_MAX
        adjustments.append(f"CI is failing: Tests & CI limited to {CI_FAILING_TESTS_MAX:g}/10.")
    elif (
        facts.get("code_files", 0) > 0
        and not facts.get("tests_touched")
        and scores["tests"] > UNTESTED_TESTS_MAX
    ):
        scores["tests"] = UNTESTED_TESTS_MAX
        adjustments.append(
            f"Code changed but no test files did: Tests & CI limited to {UNTESTED_TESTS_MAX:g}/10."
        )

    weighted = sum(CATEGORIES[k][0] * scores[k] / 10 for k in CATEGORIES)
    total = weighted
    severities = {f.severity for f in findings}
    caps: list[tuple[int, str]] = []
    if ci == "failing":
        caps.append((CAP_CI_FAILING, "CI is failing"))
    if "critical" in severities:
        caps.append((CAP_CRITICAL, "a critical issue was found"))
    elif "high" in severities:
        caps.append((CAP_HIGH, "a high-severity issue was found"))
    for cap, why in caps:
        if total > cap:
            total = cap
            adjustments.append(f"Capped at {cap} because {why}.")
    total_int = int(round(total))

    if "critical" in severities or "high" in severities or total_int < 60:
        verdict = "request_changes"
    elif total_int >= 80:
        verdict = "approve"
    else:
        verdict = "comment"

    return {
        "total": total_int,
        "raw_total": round(weighted, 1),
        "grade": grade(total_int),
        "verdict": verdict,
        "adjustments": adjustments,
        "categories": [
            {
                "key": k,
                "label": CATEGORIES[k][1],
                "weight": CATEGORIES[k][0],
                "score": scores[k],
                "model_score": float(by_key[k].score),
                "rationale": by_key[k].rationale,
                "evidence": list(by_key[k].evidence),
            }
            for k in CATEGORIES
        ],
    }


VERDICT_TEXT = {
    "approve": "Approve",
    "comment": "Comment: worth fixing before merge",
    "request_changes": "Request changes",
}
SEVERITY_ICON = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🔵", "info": "⚪"}


def to_markdown(card: dict[str, Any]) -> str:
    """The scorecard as a PR comment."""
    sources = {s["id"]: s for s in card.get("sources") or []}
    lines = [
        f"## Polly review: {card['total']}/100 ({card['grade']})",
        "",
        f"**Verdict:** {VERDICT_TEXT.get(card['verdict'], card['verdict'])}",
        "",
        card.get("summary", "").strip(),
        "",
        "| Category | Weight | Score | Why |",
        "| --- | ---: | ---: | --- |",
    ]
    for c in card["categories"]:
        why = c["rationale"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {c['label']} | {c['weight']} | {c['score']:g}/10 | {why} |")
    if card.get("adjustments"):
        lines += ["", *[f"- {a}" for a in card["adjustments"]]]
    findings = card.get("findings") or []
    if findings:
        lines += ["", "### Findings", ""]
        for f in findings:
            where = (
                f" `{f['file']}{':' + str(f['line']) if f.get('line') else ''}`"
                if f.get("file")
                else ""
            )
            lines.append(
                f"- {SEVERITY_ICON.get(f['severity'], '')} **{f['title']}**{where}: {f['detail']}"
            )
            if f.get("suggestion"):
                lines.append(f"  - Suggestion: {f['suggestion']}")
    used = sorted({i for f in findings for i in f.get("sources") or []} & set(sources))
    if used:
        lines += ["", "### Sources", ""]
        lines += [
            f"{i}. [{sources[i]['title'] or sources[i]['url']}]({sources[i]['url']})" for i in used
        ]
    lines += [
        "",
        "<sub>Scored by Polly's Reviewer on NVIDIA Nemotron via Nebius Token Factory. "
        "Weights: correctness 25, tests 20, security 15, maintainability 15, performance 10, "
        "scope 10, docs 5.</sub>",
    ]
    return "\n".join(lines)
