"""One agent handing work to another: the `ask_teammate` tool.

A teammate is a whole agent, not a prompt with a few tools: it runs as it
would in a conversation of its own, with its instructions, model, apps and
memory. What makes it a teammate is where it runs:

* in its own LangGraph thread, `<session id>:<agent id>`, on the shared
  checkpointer. The thread outlives the call, so the next time the lead asks
  the same teammate, it still has everything it did before;
* as a run of its own rather than a subgraph of the lead's, which is what
  lets it keep that thread. Its events are translated here and passed up
  through the lead's stream, marked with the call they belong to (`via`), so
  the app shows the teammate at work inside the lead's conversation;
* with the session's sandbox and sources, so files and citations are shared
  by everyone in the conversation.

A teammate does not get `ask_teammate` itself: work goes out from the lead
and comes back to it.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from typing import TYPE_CHECKING, Annotated, Any

from langchain_core.messages import HumanMessage
from langchain_core.tools import InjectedToolCallId, tool

from polly_server import artifacts
from polly_server.agents.spec import AgentSpec
from polly_server.coder import permissions
from polly_server.coder.events import translate
from polly_server.sessions import Session

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

log = logging.getLogger(__name__)

TOOL_NAME = "ask_teammate"

# What a teammate's run reports that only makes sense in a conversation of
# its own: its plan, a pause for approval, a compaction notice.
_OWN_ONLY = frozenset({"todos.updated", "approval.required", "compaction"})

BRIEF = """\
{lead} is working with the user and has asked for your help. Do what the message asks \
and reply to {lead}: your reply goes back to them, and the user sees it too. You keep \
what you did earlier in this conversation, so build on it when asked to follow up.

{message}"""

# One run at a time per teammate thread: two briefs to the same teammate in
# one step are answered in turn, each seeing the one before.
_locks: dict[str, asyncio.Lock] = {}


def thread_of(session_id: str, agent_id: str) -> str:
    """The thread a teammate keeps in a session."""
    return f"{session_id}:{agent_id}"


def forget(session_id: str) -> None:
    for key in [k for k in _locks if k.startswith(f"{session_id}:")]:
        _locks.pop(key, None)


def _find(mates: tuple[AgentSpec, ...], wanted: str) -> AgentSpec | None:
    key = wanted.strip().strip("`@").casefold()
    return next((m for m in mates if key in (m.id.casefold(), m.name.casefold())), None)


async def _work(
    session: Session,
    lead: AgentSpec | None,
    mate: AgentSpec,
    message: str,
    call_id: str,
    emit: Any,
) -> str:
    """Run `mate` on `message` in its thread; returns its reply."""
    from polly_server.agents import builders

    policy = permissions.Policy(mode="plan")
    permissions.set_current_policy(policy)
    artifacts.set_current_session(session.id)
    agent = builders.build_agent(session, as_agent=mate.id)
    brief = BRIEF.format(lead=lead.name if lead else "The lead agent", message=message.strip())
    stream = agent.astream(
        {"messages": [HumanMessage(content=brief)]},
        config={"configurable": {"thread_id": thread_of(session.id, mate.id)}},
        context={
            "project_id": "",
            "project_path": "",
            "session_id": session.id,
            "mode": "plan",
            "policy": policy,
        },
        stream_mode=["messages", "updates", "custom"],
        subgraphs=True,
    )
    reply = ""
    async for event in translate(stream, main_agent=mate.id):
        kind = event["type"]
        if kind in _OWN_ONLY:
            continue
        if kind == "message.completed" and event.get("agent") == mate.id and event.get("text"):
            reply = event["text"]
        if kind == "usage":
            # The lead's context is not the teammate's: only the tokens count.
            event.pop("context_tokens", None)
            event.pop("run_total", None)
        emit({**event, "via": call_id, "teammate": mate.id})
    return reply


def tool_for(session: Session, mates: tuple[AgentSpec, ...]) -> BaseTool:
    """`ask_teammate` for one session: hands work to any of `mates`."""
    from langgraph.config import get_stream_writer

    from polly_server.agents import catalog

    lead = catalog.get(session.agent_id)

    @tool(TOOL_NAME)
    async def ask_teammate(
        teammate: Annotated[str, "The teammate's name or id, as listed under 'Your teammates'."],
        message: Annotated[
            str,
            "The brief: what you need, what you already know and what to hand back. "
            "It is all the teammate sees, besides its own earlier work here.",
        ],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> str:
        """Hand a piece of work to a teammate and get its reply.

        The teammate is another agent with its own skills and tools. It remembers what it
        did for you earlier in this conversation, so ask the same one again to follow up.
        """
        mate = _find(mates, teammate)
        if mate is None:
            names = ", ".join(m.name for m in mates)
            return f"No teammate called {teammate!r}. Your teammates: {names}."
        if not message.strip():
            return "Give the teammate a brief: what you need from them."
        # The lead's stream writer only works in the lead's context, which
        # the teammate's run must not see: events are passed up through a copy.
        here = contextvars.copy_context()
        try:
            writer = get_stream_writer()
        except Exception:  # noqa: BLE001 - not streaming (a plain invoke): nothing to pass up
            writer = None

        def emit(event: dict[str, Any]) -> None:
            if writer is not None:
                here.run(writer, event)

        lock = _locks.setdefault(thread_of(session.id, mate.id), asyncio.Lock())
        async with lock:
            # An empty context: the teammate's run must not see the lead's
            # (LangGraph would make it a subgraph, on the lead's thread).
            work = asyncio.get_running_loop().create_task(
                _work(session, lead, mate, message, tool_call_id, emit),
                context=contextvars.Context(),
            )
            try:
                reply = await work
            except asyncio.CancelledError:
                work.cancel()
                raise
            except Exception as exc:  # noqa: BLE001 - the lead hears about it and carries on
                log.exception("%s could not finish the work %s gave it", mate.id, session.agent_id)
                return f"{mate.name} could not finish: {type(exc).__name__}: {exc}"
        return reply or f"{mate.name} finished without a reply."

    return ask_teammate
