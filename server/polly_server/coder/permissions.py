"""What the Coder may do without asking.

A `Policy` is built per run from the session's mode and the project's rules.
It is consulted twice for every tool call:

* `when` on the interrupt config decides whether to pause for approval
  (Deep Agents raises the interrupt right after the model call);
* `PermissionMiddleware.wrap_tool_call` enforces denials, since a denied
  call must never run even if nothing paused.

In Plan mode the write/run tools are also hidden from the model, so it
cannot even try.
"""

from __future__ import annotations

import contextvars
import fnmatch
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from langchain_core.messages import SystemMessage, ToolMessage
from pydantic import BaseModel

from polly_server.coder.context import Mode

if TYPE_CHECKING:
    from langchain.agents.middleware.types import ModelRequest
    from langgraph.prebuilt.tool_node import ToolCallRequest

    from polly_server.projects import Project

Decision = Literal["allow", "ask", "deny"]

READ_TOOLS = frozenset(
    {
        "ls",
        "read_file",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "web_search",
        "web_extract",
        "research_search",
        "COMPOSIO_SEARCH_TOOLS",
        "COMPOSIO_GET_TOOL_SCHEMAS",
        "write_todos",
        "task",
    }
)
WRITE_TOOLS = frozenset({"write_file", "edit_file"})
DELETE_TOOLS = frozenset({"delete"})
EXEC_TOOLS = frozenset({"execute", "git_commit", "git_branch"})
# Acting in a connected app (send an email, open an issue) is gated like a
# command: it reaches outside the project.
APP_TOOLS = frozenset({"COMPOSIO_MULTI_EXECUTE_TOOL"})
GATED_TOOLS = WRITE_TOOLS | DELETE_TOOLS | EXEC_TOOLS | APP_TOOLS

# Paths the agent keeps for itself (memory, compacted history): never gated,
# never shown as a change.
PRIVATE_PREFIXES = ("/memories/", "/conversation_history/")

PLAN_MODE_ADDENDUM = """
## Plan mode

You are in plan mode: a read-only pass. Explore the code, think the change
through, and reply with a concrete plan — the files to touch, what changes in
each, the order of work, how to verify it, and any open questions. Do not
write or edit files and do not run commands that change anything; the tools
for that are not available right now. Finish with a short summary the user
can approve.
""".strip()


class Rule(BaseModel):
    """An "always allow" rule the user saved from an approval card.

    `pattern` is a glob on the file path for file tools (`src/**`) and a
    command prefix for `execute` (`npm test`).
    """

    tool: str
    pattern: str

    def matches(self, name: str, args: dict[str, Any]) -> bool:
        if self.tool != name:
            return False
        if name in EXEC_TOOLS:
            command = str(args.get("command") or args.get("message") or "")
            return command.startswith(self.pattern)
        path = _rel(str(args.get("file_path") or ""))
        pat = self.pattern.lstrip("/")
        return path == pat or fnmatch.fnmatchcase(path, pat)


def _rel(path: str) -> str:
    return path.lstrip("/")


def _command(args: dict[str, Any]) -> str:
    return str(args.get("command") or "").strip()


@dataclass(frozen=True)
class Policy:
    mode: Mode
    rules: tuple[Rule, ...] = ()
    allow_cmds: tuple[str, ...] = ()
    deny_cmds: tuple[str, ...] = ()
    # For unattended runs (generating POLLY.md): nothing may pause, so what
    # would have asked is refused instead.
    ask_means_deny: bool = False
    # The project folder on disk. Commands that name absolute paths outside
    # it always ask, whatever the mode.
    root: str = ""

    def decide(self, name: str, args: dict[str, Any] | None) -> Decision:
        decision = self._decide(name, args or {})
        if decision == "ask" and self.ask_means_deny:
            return "deny"
        return decision

    def _decide(self, name: str, args: dict[str, Any]) -> Decision:
        if name == "execute":
            cmd = _command(args)
            if any(cmd.startswith(d) or f" {d}" in f" {cmd}" for d in self.deny_cmds if d):
                return "deny"
            if self.mode != "plan" and self.root and outside_paths(cmd, self.root):
                return "ask"
        if name not in GATED_TOOLS:
            return "allow"
        if name in WRITE_TOOLS | DELETE_TOOLS and _is_private(args):
            return "allow"
        if self.mode == "plan":
            return "deny"
        if name == "execute" and any(_command(args).startswith(a) for a in self.allow_cmds if a):
            return "allow"
        if any(r.matches(name, args) for r in self.rules):
            return "allow"
        if self.mode == "autonomous":
            return "allow"
        if self.mode == "trusted" and name in WRITE_TOOLS:
            return "allow"
        return "ask"


# Absolute paths a command may name without leaving the project in any way
# that matters: toolchains, temp space and the null device.
SAFE_ABSOLUTE = (
    "/usr/",
    "/bin/",
    "/sbin/",
    "/opt/",
    "/tmp/",
    "/private/tmp/",
    "/var/folders/",
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
)
_ABS_PATH = re.compile(r"""(?:^|[\s=:'"(<>|;&])((?:/|~/|~$|\$HOME\b)[^\s'"`;|&<>()]*)""")


def outside_paths(command: str, root: str) -> list[str]:
    """Absolute paths in a shell command that point outside the project."""
    base = root.rstrip("/") + "/"
    found = []
    for match in _ABS_PATH.finditer(command):
        path = match.group(1)
        if path == root or path.startswith(base) or path.startswith(SAFE_ABSOLUTE):
            continue
        found.append(path)
    return found


def init_policy() -> Policy:
    """Write `/POLLY.md` and nothing else; never pause."""
    return Policy(
        mode="supervised",
        rules=(
            Rule(tool="write_file", pattern="POLLY.md"),
            Rule(tool="edit_file", pattern="POLLY.md"),
        ),
        ask_means_deny=True,
    )


def _is_private(args: dict[str, Any]) -> bool:
    path = str(args.get("file_path") or "")
    return path.startswith(PRIVATE_PREFIXES)


# The run sets this so middleware inside subagents (which may not see the
# parent's runtime context) still finds the policy.
_policy_var: contextvars.ContextVar[Policy | None] = contextvars.ContextVar(
    "polly_policy", default=None
)


def set_current_policy(policy: Policy | None) -> contextvars.Token:
    return _policy_var.set(policy)


def current_policy(runtime: Any = None) -> Policy:
    context = getattr(runtime, "context", None)
    if isinstance(context, dict) and isinstance(context.get("policy"), Policy):
        return context["policy"]
    found = _policy_var.get()
    return found if found is not None else Policy(mode="supervised")


def policy_for(project: Project, mode: Mode) -> Policy:
    return Policy(
        mode=mode,
        rules=tuple(load_rules(project)),
        allow_cmds=tuple(project.settings.command_allowlist),
        deny_cmds=tuple(project.settings.command_denylist),
        root=project.path,
    )


# ---------- rules on disk ----------


def _rules_file(project: Project) -> Path:
    from polly_server.projects import project_dir

    return project_dir(project) / "rules.json"


def load_rules(project: Project) -> list[Rule]:
    path = _rules_file(project)
    if not path.exists():
        return []
    try:
        return [Rule.model_validate(r) for r in json.loads(path.read_text() or "[]")]
    except ValueError:
        return []


def save_rules(project: Project, rules: list[Rule]) -> None:
    _rules_file(project).write_text(json.dumps([r.model_dump() for r in rules], indent=2))


def add_rule(project: Project, rule: Rule) -> list[Rule]:
    rules = load_rules(project)
    if rule not in rules:
        rules.append(rule)
        save_rules(project, rules)
    return rules


def remove_rule(project: Project, index: int) -> list[Rule]:
    rules = load_rules(project)
    if 0 <= index < len(rules):
        rules.pop(index)
        save_rules(project, rules)
    return rules


# ---------- what the user sees on an approval card ----------


def kind_of(name: str) -> Literal["edit", "delete", "command", "other"]:
    if name in WRITE_TOOLS:
        return "edit"
    if name in DELETE_TOOLS:
        return "delete"
    if name in EXEC_TOOLS:
        return "command"
    return "other"


def describe(tool_call: dict[str, Any], *_: Any) -> str:
    name = tool_call.get("name", "")
    args = tool_call.get("args") or {}
    if name == "execute":
        return f"Run: {_command(args)}"
    if name == "write_file":
        size = len(str(args.get("content", "")))
        return f"Write {args.get('file_path')} ({size} chars)"
    if name == "edit_file":
        return f"Edit {args.get('file_path')}"
    if name == "delete":
        return f"Delete {args.get('file_path')}"
    if name == "git_commit":
        return f"Commit: {args.get('message', '')}"
    if name == "git_branch":
        return f"Switch to branch {args.get('name', '')}"
    if name in APP_TOOLS:
        calls = [t for t in args.get("tools") or [] if isinstance(t, dict)]
        slugs = ", ".join(str(t.get("tool_slug", "")) for t in calls)
        return f"Use connected apps: {slugs}" if slugs else "Use a connected app"
    return f"{name} {json.dumps(args)[:200]}"


def build_interrupt_on() -> dict[str, Any]:
    """Pause for approval on gated tools whenever the policy says `ask`."""
    from langchain.agents.middleware import InterruptOnConfig

    def when(request: ToolCallRequest) -> bool:
        policy = current_policy(request.runtime)
        call = request.tool_call
        return policy.decide(call["name"], call.get("args")) == "ask"

    return {
        name: InterruptOnConfig(
            allowed_decisions=["approve", "edit", "reject"],
            description=describe,
            when=when,
        )
        for name in sorted(GATED_TOOLS)
    }


# ---------- middleware ----------


def _tool_name(tool: Any) -> str:
    if isinstance(tool, dict):
        return str(tool.get("name") or tool.get("function", {}).get("name") or "")
    return str(getattr(tool, "name", ""))


def _with_addendum(system: SystemMessage | None, addendum: str) -> SystemMessage:
    text = system.text if system is not None else ""
    return SystemMessage(content=f"{text}\n\n{addendum}".strip())


def _blocked(request: ToolCallRequest, policy: Policy) -> ToolMessage:
    call = request.tool_call
    why = "plan mode is read-only" if policy.mode == "plan" else "blocked by project policy"
    return ToolMessage(
        content=f"Blocked: {describe(call)} — {why}. Tell the user what you wanted to do instead.",
        tool_call_id=call["id"],
        name=call["name"],
        status="error",
    )


def _make_middleware():
    from langchain.agents.middleware.types import AgentMiddleware

    class PermissionMiddleware(AgentMiddleware):
        """Tells the model where it is, hides write/run tools in plan mode
        and blocks denied calls."""

        name = "PollyPermissions"

        def _model_request(self, request: ModelRequest) -> ModelRequest:
            from polly_server.coder.prompt import project_section

            policy = current_policy(request.runtime)
            system = request.system_message
            if policy.root:
                system = _with_addendum(system, project_section(policy.root))
            if policy.mode != "plan":
                return request.override(system_message=system) if policy.root else request
            tools = [t for t in request.tools if _tool_name(t) not in GATED_TOOLS]
            return request.override(
                tools=tools,
                system_message=_with_addendum(system, PLAN_MODE_ADDENDUM),
            )

        def wrap_model_call(self, request, handler):
            return handler(self._model_request(request))

        async def awrap_model_call(self, request, handler):
            return await handler(self._model_request(request))

        def wrap_tool_call(self, request, handler):
            policy = current_policy(request.runtime)
            call = request.tool_call
            if policy.decide(call["name"], call.get("args")) == "deny":
                return _blocked(request, policy)
            return handler(request)

        async def awrap_tool_call(self, request, handler):
            policy = current_policy(request.runtime)
            call = request.tool_call
            if policy.decide(call["name"], call.get("args")) == "deny":
                return _blocked(request, policy)
            return await handler(request)

    class ReadOnlyToolsMiddleware(AgentMiddleware):
        """For subagents that only look: no writes, no commands, no nesting.

        `also` names tools outside `READ_TOOLS` the subagent may use, such as
        web research for the librarian.
        """

        name = "PollyReadOnly"

        def __init__(self, also: set[str] | frozenset[str] = frozenset()) -> None:
            super().__init__()
            self.allowed = (READ_TOOLS - {"task"}) | frozenset(also)

        def _model_request(self, request: ModelRequest) -> ModelRequest:
            tools = [t for t in request.tools if _tool_name(t) in self.allowed]
            return request.override(tools=tools)

        def wrap_model_call(self, request, handler):
            return handler(self._model_request(request))

        async def awrap_model_call(self, request, handler):
            return await handler(self._model_request(request))

        def wrap_tool_call(self, request, handler):
            name = request.tool_call["name"]
            if name in GATED_TOOLS or name == "task":
                return _blocked(request, Policy(mode="plan"))
            return handler(request)

        async def awrap_tool_call(self, request, handler):
            name = request.tool_call["name"]
            if name in GATED_TOOLS or name == "task":
                return _blocked(request, Policy(mode="plan"))
            return await handler(request)

    return PermissionMiddleware, ReadOnlyToolsMiddleware


PermissionMiddleware, ReadOnlyToolsMiddleware = _make_middleware()
