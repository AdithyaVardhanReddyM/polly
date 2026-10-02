"""GitHub tools for reading a pull request. Read-only: posting a review is
something the user does from the app, never the agent."""

from __future__ import annotations

from typing import Annotated, Literal

from langchain_core.tools import tool

from polly_server.integrations import github
from polly_server.integrations.github import GitHubError, parse_pr_url

FILES_PER_PAGE = 15
PATCH_CHARS = 6_000
PAGE_CHARS = 45_000
FILE_CHARS = 30_000
BODY_CHARS = 4_000


def _ref(pr_url: str):
    try:
        return parse_pr_url(pr_url)
    except ValueError as exc:
        raise GitHubError(400, str(exc)) from exc


def _guard(fn):
    def inner(*args, **kwargs) -> str:
        try:
            return fn(*args, **kwargs)
        except GitHubError as exc:
            return f"GitHub error ({exc.status}): {exc}"

    return inner


@tool
def github_pr_overview(pr_url: Annotated[str, "The pull request URL."]) -> str:
    """Title, author, branches, size, CI state, the description and the list of changed files."""
    return _guard(_overview)(pr_url)


def _overview(pr_url: str) -> str:
    ref = _ref(pr_url)
    facts = github.pr_facts(ref)
    files = github.pr_files(ref)
    body = github.pr_body(ref)
    lines = [
        f"{facts['slug']}: {facts['title']}",
        f"Author: {facts['author']} · {facts['state']}{' (draft)' if facts['draft'] else ''}",
        f"{facts['head']} → {facts['base']} · +{facts['additions']} −{facts['deletions']} "
        f"in {facts['changed_files']} files",
        f"CI: {facts['ci']['state']}"
        + (
            f" (failing: {', '.join(facts['ci'].get('failing') or [])})"
            if facts["ci"].get("failing")
            else ""
        ),
        "",
        "Description:",
        (body[:BODY_CHARS] + (" …" if len(body) > BODY_CHARS else ""))
        if body.strip()
        else "(none)",
        "",
        "Files:",
    ]
    for f in files:
        skip = (
            " (generated/lockfile, skipped in diffs)"
            if github.SKIP_PATH.search(f["filename"])
            else ""
        )
        added, removed = f.get("additions", 0), f.get("deletions", 0)
        lines.append(f"- {f['filename']} [{f.get('status')}] +{added} −{removed}{skip}")
    pages = (len(files) + FILES_PER_PAGE - 1) // FILES_PER_PAGE
    lines.append(f"\nRead the diffs with github_pr_files, pages 1–{max(pages, 1)}.")
    return "\n".join(lines)


@tool
def github_pr_files(
    pr_url: Annotated[str, "The pull request URL."],
    page: Annotated[int, "Page of changed files to show (15 per page), from 1."] = 1,
) -> str:
    """The unified diff of the PR's changed files, one page at a time, with line numbers."""
    return _guard(_files)(pr_url, page)


def _files(pr_url: str, page: int) -> str:
    ref = _ref(pr_url)
    files = github.pr_files(ref)
    page = max(page, 1)
    chunk = files[(page - 1) * FILES_PER_PAGE : page * FILES_PER_PAGE]
    if not chunk:
        return f"No files on page {page}; the PR has {len(files)} changed files."
    out: list[str] = []
    used = 0
    for f in chunk:
        name = f["filename"]
        head = f"### {name} [{f.get('status')}] +{f.get('additions', 0)} −{f.get('deletions', 0)}"
        if github.SKIP_PATH.search(name):
            out.append(f"{head}\n(generated or lockfile; skipped)")
            continue
        patch = f.get("patch")
        if not patch:
            out.append(f"{head}\n(binary or too large for a diff; use github_file to read it)")
            continue
        if len(patch) > PATCH_CHARS:
            patch = patch[:PATCH_CHARS] + "\n… (diff truncated; read the file with github_file)"
        if used + len(patch) > PAGE_CHARS:
            out.append(f"{head}\n(omitted to keep this page small; read it with github_file)")
            continue
        used += len(patch)
        out.append(f"{head}\n```diff\n{patch}\n```")
    pages = (len(files) + FILES_PER_PAGE - 1) // FILES_PER_PAGE
    out.append(f"Page {page} of {pages}.")
    return "\n\n".join(out)


@tool
def github_file(
    pr_url: Annotated[str, "The pull request URL."],
    path: Annotated[str, "File path in the repository."],
    side: Annotated[
        Literal["head", "base"], "The PR's version (head) or the target branch (base)."
    ] = "head",
) -> str:
    """Read a whole file from the PR's head or base branch, for context around a change."""
    return _guard(_file)(pr_url, path, side)


def _file(pr_url: str, path: str, side: str) -> str:
    ref = _ref(pr_url)
    pr = github.get_json(f"{ref.api}/pulls/{ref.number}")
    sha = (pr.get(side) or {}).get("sha") or (pr.get(side) or {}).get("ref")
    text = github.file_at(ref, path, sha)
    numbered = "\n".join(f"{i:>5}  {line}" for i, line in enumerate(text.splitlines(), 1))
    if len(numbered) > FILE_CHARS:
        numbered = numbered[:FILE_CHARS] + "\n… (truncated)"
    return f"{path} @ {side}\n{numbered}"


@tool
def github_pr_checks(pr_url: Annotated[str, "The pull request URL."]) -> str:
    """CI for the PR's latest commit: each check and status, with the summary of failures."""
    return _guard(_checks)(pr_url)


def _checks(pr_url: str) -> str:
    ref = _ref(pr_url)
    pr = github.get_json(f"{ref.api}/pulls/{ref.number}")
    sha = (pr.get("head") or {}).get("sha")
    runs = github.get_json(f"{ref.api}/commits/{sha}/check-runs", per_page=100).get(
        "check_runs", []
    )
    lines = [f"CI: {github.ci_state(ref, sha)['state']}"]
    for run in runs:
        result = run.get("conclusion") or run.get("status")
        lines.append(f"- {run.get('name')}: {result}")
        if run.get("conclusion") in ("failure", "timed_out"):
            summary = ((run.get("output") or {}).get("summary") or "").strip()
            if summary:
                lines.append("  " + summary[:800].replace("\n", "\n  "))
    if len(lines) == 1:
        lines.append("No check runs on the head commit.")
    return "\n".join(lines)


GITHUB_TOOLS = (github_pr_overview, github_pr_files, github_file, github_pr_checks)
