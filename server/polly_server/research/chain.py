"""Research after the Coder: when a Coder run finishes with changes, a
`change-research` session checks them against current docs, deprecations
and advisories and drafts the PR description.

The prompt is built here from the Coder's thread (what the user asked, what
the Coder said it did) and the tracked changes (the diff).
"""

from __future__ import annotations

import difflib
import logging
from typing import TYPE_CHECKING, Any

from polly_server.integrations.github import MANIFEST_PATH

if TYPE_CHECKING:
    from polly_server.coder.changes import ChangeTracker
    from polly_server.coder.permissions import Policy
    from polly_server.projects import Project
    from polly_server.sessions import Session

log = logging.getLogger(__name__)

MAX_DIFF_CHARS = 40_000
MAX_FILE_DIFF_CHARS = 8_000
MAX_TEXT_CHARS = 4_000


def wanted(project: Project | None, session: Session, policy: Policy | None, status: str) -> bool:
    """Whether a finished Coder run should be followed by change research.
    The tracker and the keys are checked by the caller."""
    return (
        status == "completed"
        and session.agent_id == "coder"
        and project is not None
        and project.settings.auto_research
        and not (policy is not None and policy.ask_means_deny)  # e.g. writing POLLY.md
    )


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content or "")


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "\n… (truncated)"


def conversation(messages: list[Any]) -> tuple[str, str]:
    """The user's last request and the Coder's last reply, from its thread."""
    asked = said = ""
    for message in reversed(messages):
        kind = getattr(message, "type", "")
        if not said and kind == "ai" and not getattr(message, "tool_calls", None):
            said = _text(message.content)
        if kind == "human":
            extra = getattr(message, "additional_kwargs", None) or {}
            asked = str(extra.get("polly_display") or _text(message.content))
            break
    return _clip(asked, MAX_TEXT_CHARS), _clip(said, MAX_TEXT_CHARS)


def diff_text(tracker: ChangeTracker) -> tuple[list[str], str, list[str]]:
    """(changed paths, unified diff capped in size, touched manifests)."""
    changes = tracker.list()
    paths = [c.path for c in changes]
    manifests = [p for p in paths if MANIFEST_PATH.search(p)]
    # Manifests first: they are short and what the advisory checks need.
    ordered = sorted(changes, key=lambda c: (c.path not in manifests, c.path))
    parts: list[str] = []
    used = 0
    for change in ordered:
        found = tracker.diff(change.path)
        if found is None:
            continue
        if found.binary:
            chunk = f"--- {change.path} (binary, {change.kind})\n"
        else:
            lines = difflib.unified_diff(
                found.before.splitlines(keepends=True),
                found.after.splitlines(keepends=True),
                fromfile=f"a/{change.path}" if change.kind != "created" else "/dev/null",
                tofile=f"b/{change.path}" if change.kind != "deleted" else "/dev/null",
                n=3,
            )
            chunk = _clip("".join(lines), MAX_FILE_DIFF_CHARS) + "\n"
        if used + len(chunk) > MAX_DIFF_CHARS:
            parts.append(f"… diff truncated; {len(ordered) - len(parts)} more file(s) not shown\n")
            break
        parts.append(chunk)
        used += len(chunk)
    return paths, "".join(parts), manifests


def prompt(asked: str, said: str, paths: list[str], diff: str, manifests: list[str]) -> str:
    listed = "\n".join(f"- {p}" for p in paths)
    touched = (
        "Dependency manifests changed: " + ", ".join(manifests) + ". Check the added or "
        "bumped packages for advisories and whether the versions are current."
        if manifests
        else "No dependency manifest changed."
    )
    return f"""Research this change and hand in the report.

## What the user asked the Coder
{asked or "(not recorded)"}

## What the Coder said it did
{said or "(no summary)"}

## Changed files ({len(paths)})
{listed}

{touched}

## Diff
```diff
{diff}
```
"""


def display(paths: list[str]) -> str:
    n = len(paths)
    return f"Research the change ({n} file{'s' if n != 1 else ''}): docs, deprecations, advisories."
