"""Git, scoped to the current project.

Only the safe subset: inspect, branch, commit. Pushing and pull requests
arrive with the GitHub integration. Each tool runs `git` in the project
folder it finds in the run's context.
"""

from __future__ import annotations

import subprocess
from typing import Annotated

from langchain.tools import ToolRuntime
from langchain_core.tools import tool

MAX_OUTPUT = 20_000


def _git(cwd: str, *args: str) -> str:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except FileNotFoundError:
        return "git is not installed on this machine."
    except subprocess.TimeoutExpired:
        return "git timed out after 60s."
    out = (proc.stdout + proc.stderr).strip()
    if len(out) > MAX_OUTPUT:
        out = out[:MAX_OUTPUT] + "\n… (truncated)"
    if proc.returncode != 0:
        return f"git exited with {proc.returncode}:\n{out}"
    return out or "(no output)"


def _cwd(runtime: ToolRuntime) -> str:
    context = runtime.context or {}
    path = context.get("project_path") if isinstance(context, dict) else None
    if not path:
        raise RuntimeError("git tools need a project; none in the run context")
    return path


@tool
def git_status(runtime: ToolRuntime) -> str:
    """Show the working tree status: current branch, staged, modified and untracked files."""
    cwd = _cwd(runtime)
    return _git(cwd, "status", "--short", "--branch")


@tool
def git_diff(
    runtime: ToolRuntime,
    path: Annotated[str, "Limit the diff to this file or folder (optional)."] = "",
    staged: Annotated[bool, "Show the staged diff instead of the working tree."] = False,
) -> str:
    """Show uncommitted changes as a unified diff."""
    cwd = _cwd(runtime)
    args = ["diff"]
    if staged:
        args.append("--cached")
    if path:
        args += ["--", path.lstrip("/")]
    return _git(cwd, *args)


@tool
def git_branch(
    runtime: ToolRuntime,
    name: Annotated[str, "Branch name to switch to."],
    create: Annotated[bool, "Create the branch if it does not exist."] = True,
) -> str:
    """Switch to a branch, creating it when needed. Keeps uncommitted changes."""
    cwd = _cwd(runtime)
    if create:
        exists = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", name], cwd=cwd, capture_output=True
        )
        if exists.returncode != 0:
            return _git(cwd, "switch", "-c", name)
    return _git(cwd, "switch", name)


@tool
def git_commit(
    runtime: ToolRuntime,
    message: Annotated[str, "Commit message: a short summary line, then details if needed."],
    add_all: Annotated[bool, "Stage every change first (`git add -A`)."] = True,
) -> str:
    """Commit the current changes. Does not push."""
    cwd = _cwd(runtime)
    if add_all:
        staged = _git(cwd, "add", "-A")
        if staged.startswith("git exited"):
            return staged
    return _git(cwd, "commit", "-m", message)


GIT_TOOLS = (git_status, git_diff, git_branch, git_commit)
