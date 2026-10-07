"""Polly's tools: putting a team of agents together for a task.

Polly (`catalog.py`, `polly.py`) leads a conversation like any agent, and
hands work out with `ask_teammate` (`delegation.py`). What it has besides:

    list_agents        who can join a team, and what each is for
    assemble_team      put agents on this conversation's team
    hire_agent         propose a new agent: the user approves it on a card
    ask_user           a question only the user can answer, on a card
    request_app        ask the user to connect an app an agent needs
    request_variables  ask the user for settings or keys (never in the chat)
    save_team          keep this team as a group
    propose_routine    run this task on a schedule or on a GitHub event

Every tool that changes something asks first (`asks.py`): nothing is made,
connected or scheduled without the user saying yes. A routine has no one to
ask, so in one these tools change nothing and say so.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Annotated, Any

from langchain_core.tools import InjectedToolCallId, tool

from polly_server import sessions, variables
from polly_server.agents import asks, catalog, custom, groups, team
from polly_server.integrations import assignments, composio
from polly_server.integrations import catalog as apps
from polly_server.sessions import Session

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

    from polly_server.agents.spec import AgentSpec

log = logging.getLogger(__name__)

# New agents Polly may make in one conversation.
MAX_HIRES = 3

PROMPT = """\
## Your team in this conversation

{listing}

Hand work to them with `ask_teammate`. Add agents with `assemble_team` or `hire_agent`."""


def _current(session_id: str) -> Session:
    session = sessions.get(session_id)
    if session is None:
        raise LookupError(session_id)
    return session


def _line(spec: AgentSpec) -> str:
    about = " ".join(part for part in (spec.tagline, spec.description) if part)
    return f"- **{spec.name}** (`{spec.id}`): {about}".rstrip(": ")


def prompt(session: Session, mates: tuple[AgentSpec, ...]) -> str:
    """The section of Polly's instructions about the team it has so far."""
    listing = "\n".join(_line(m) for m in mates) or "No one yet."
    text = PROMPT.format(listing=listing)
    group = groups.get(session.group_id)
    return f"{team.GROUP_PROMPT.format(name=group.name)}\n\n{text}" if group else text


def _emit(event: dict[str, Any]) -> None:
    """Pass an event to the app, when the run is streaming."""
    from langgraph.config import get_stream_writer

    try:
        get_stream_writer()(event)
    except Exception:  # noqa: BLE001 - not streaming: nothing to tell
        pass


def _summary(spec: AgentSpec) -> dict[str, Any]:
    from polly_server.api.schemas import AgentSummary

    return AgentSummary.of(spec).model_dump()


def _app(slug: str) -> dict[str, Any]:
    item = apps.get(slug)
    return {
        "slug": slug,
        "name": item.name if item else slug,
        "connected": item is not None and (item.auth == "none" or composio.is_connected(slug)),
    }


def _join(session: Session, agent_ids: list[str]) -> tuple[str, ...]:
    """Add `agent_ids` to the conversation's team; returns the team."""
    now = [m.id for m in team.roster(session)]
    wanted = list(dict.fromkeys([*now, *agent_ids]))[: team.MAX_TEAMMATES]
    sessions.update(session.id, members=wanted)
    return tuple(m.id for m in team.roster(_current(session.id)))


def tools_for(session: Session) -> list[BaseTool]:
    """Polly's tools for one conversation."""
    session_id = session.id

    @tool
    def list_agents() -> str:
        """List every agent that can join your team: id, what it does, its apps,
        and whether it is on your team already."""
        here = _current(session_id)
        on_team = {m.id for m in team.roster(here)}
        lines = []
        for spec in catalog.everyone():
            if not team.can_join(spec):
                continue
            enabled = assignments.enabled(spec.id)
            parts = [_line(spec)]
            if enabled:
                parts.append(f"  apps: {', '.join(enabled)}")
            if spec.sandbox:
                parts.append("  runs code in a sandbox")
            if spec.id in on_team:
                parts.append("  ON YOUR TEAM")
            lines.append("\n".join(parts))
        return "\n".join(lines) or "No agents can join a team yet."

    @tool
    def assemble_team(
        agent_ids: Annotated[list[str], "Ids of agents to add, as `list_agents` shows them."],
    ) -> str:
        """Put existing agents on your team for this conversation."""
        here = _current(session_id)
        if groups.get(here.group_id) is not None:
            return "This is a group conversation: your team is the group's members."
        try:
            ids = team.check(agent_ids, here.agent_id)
        except ValueError as exc:
            return f"Not done: {exc}."
        result = _join(here, ids)
        _emit({"type": "team.updated", "members": list(result)})
        names = ", ".join(s.name for i in result if (s := catalog.get(i)) is not None)
        return f"Your team now: {names}."

    @tool
    def hire_agent(
        name: Annotated[str, "Short name, like 'Standup Writer' (at most 40 characters)."],
        tagline: Annotated[str, "What it does, in a few words (at most 80 characters)."],
        description: Annotated[str, "Two sentences on what it is for (at most 400)."],
        instructions: Annotated[
            str, "Its complete system prompt: role, how to work, what to hand back."
        ],
        reason: Annotated[str, "One sentence for the user: why no existing agent fits."],
        tool_call_id: Annotated[str, InjectedToolCallId],
        apps_needed: Annotated[
            list[str] | None, "Composio app slugs it acts in, like 'gmail' or 'slack'."
        ] = None,
        variables_needed: Annotated[
            list[str] | None, "Names of settings or keys it needs, like 'SLACK_CHANNEL'."
        ] = None,
        sandbox: Annotated[bool, "Whether it runs code in a sandbox."] = False,
    ) -> str:
        """Propose a new agent for your team. The user sees it on a card and approves
        or rejects it; it is only made if they approve."""
        here = _current(session_id)
        if groups.get(here.group_id) is not None:
            return "This is a group conversation: its members are fixed."
        hired = [m for m in team.roster(here) if m.metadata.get("origin") == "polly"]
        if len(hired) >= MAX_HIRES:
            return f"You have made {MAX_HIRES} agents here already: use the ones you have."
        if len(team.roster(here)) >= team.MAX_TEAMMATES:
            return f"Your team is full ({team.MAX_TEAMMATES} agents)."
        name = " ".join(name.split())[:40]
        if not name:
            return "Give the agent a name."
        slugs = [s for s in dict.fromkeys(apps_needed or []) if s in apps.SLUGS]
        unknown = [s for s in apps_needed or [] if s not in apps.SLUGS]
        names: list[str] = []
        for raw in dict.fromkeys(variables_needed or []):
            try:
                names.append(variables.check_name(raw))
            except ValueError:
                unknown.append(raw)
        avatar = {"seed": f"hire-{tool_call_id}"}
        card = {
            "agent": {
                "name": name,
                "tagline": tagline[:80],
                "description": description[:400],
                "avatar": avatar,
                "sandbox": sandbox,
                "apps": [_app(s) for s in slugs],
                "variables": [{"name": n, "is_set": variables.is_set(n)} for n in names],
            },
            "reason": reason[:300],
        }
        answer = asks.ask("hire", **card)
        if answer is None:
            return asks.UNATTENDED
        if not answer.get("approved"):
            note = (answer.get("answer") or "").strip()
            return "The user said no to this agent." + (f" They said: {note}" if note else "")

        made = custom.create(
            name=name,
            tagline=tagline[:80],
            description=description[:400],
            system_prompt=instructions[:20_000],
            search=True,
            sandbox=sandbox,
            memory=True,
            avatar=avatar,
            origin="polly",
        )
        assignments.set_enabled(made.id, slugs)
        for n in names:
            variables.declare(n, agent=made.id)
        result = _join(here, [made.id])
        spec = made.to_spec()
        _emit({"type": "agent.hired", "agent": _summary(spec), "members": list(result)})
        todo = [s for s in slugs if not _app(s)["connected"]]
        missing = [n for n in names if not variables.is_set(n)]
        lines = [f"{made.name} (`{made.id}`) is on your team."]
        if todo:
            lines.append(f"Apps it needs, not connected: {', '.join(todo)} (`request_app`).")
        if missing:
            lines.append(
                f"Settings it needs that are not set: {', '.join(missing)} (`request_variables`)."
            )
        if unknown:
            lines.append(f"Left out, not known: {', '.join(unknown)}.")
        return " ".join(lines)

    @tool
    def ask_user(
        question: Annotated[str, "One clear question."],
        options: Annotated[list[str] | None, "Up to 5 answers to pick from, when you can."] = None,
    ) -> str:
        """Ask the user something only they know. Never use this for passwords,
        tokens or keys: those go through `request_variables`."""
        choices = [o.strip()[:120] for o in options or [] if o.strip()][:5]
        answer = asks.ask("question", question=question.strip()[:500], options=choices)
        if answer is None:
            return asks.UNATTENDED
        text = str(answer.get("answer") or "").strip()
        return f"The user answered: {text}" if text else "The user did not answer."

    @tool
    def request_app(
        app: Annotated[str, "The Composio app slug, like 'gmail', 'slack' or 'notion'."],
        for_agent: Annotated[str, "Id of the agent that will use it."],
    ) -> str:
        """Ask the user to connect an app an agent on your team needs, and let that
        agent use it."""
        item = apps.get(app.strip())
        if item is None:
            return f"No app {app!r}. Known apps: {', '.join(sorted(apps.SLUGS))}."
        spec = catalog.get(for_agent.strip())
        if spec is None:
            return f"No agent {for_agent!r}."
        if not composio.configured():
            return "Apps are not set up here (no COMPOSIO_API_KEY). Carry on without it."

        def allow() -> None:
            enabled = assignments.enabled(spec.id)
            if item.slug not in enabled:
                assignments.set_enabled(spec.id, [*enabled, item.slug])

        if item.auth == "none" or composio.is_connected(item.slug):
            allow()
            return f"{item.name} is connected; {spec.name} can use it now."
        answer = asks.ask(
            "connect",
            app={"slug": item.slug, "name": item.name, "description": item.description},
            agent={"id": spec.id, "name": spec.name},
        )
        if answer is None:
            return asks.UNATTENDED
        composio.connections(fresh=True)
        if not composio.is_connected(item.slug):
            return f"{item.name} is still not connected. Carry on without it, and say so."
        allow()
        return f"{item.name} is connected; {spec.name} can use it from its next task."

    @tool
    def request_variables(
        names: Annotated[list[str], "Names in capitals, like 'OPENWEATHER_API_KEY'."],
        why: Annotated[str, "One sentence for the user: what they are for."],
        for_agent: Annotated[str, "Id of the agent that will use them."] = "",
        secret: Annotated[bool, "Whether they are secrets (keys, tokens)."] = True,
    ) -> str:
        """Ask the user for settings or keys an agent needs. The user fills them in on a
        card; you only learn whether they are set, never the values."""
        wanted: list[str] = []
        for raw in dict.fromkeys(names):
            try:
                wanted.append(variables.check_name(raw))
            except ValueError as exc:
                return f"Not done: {exc}."
        if not wanted:
            return "Name at least one setting."
        about = why.strip()[:200]
        agent_id = for_agent.strip()
        if catalog.get(agent_id) is None:
            agent_id = ""
        # Listed (unset) so the card and Settings both show them; harmless to
        # repeat when the run resumes.
        found = [variables.declare(n, about, secret=secret, agent=agent_id) for n in wanted]
        missing = [v for v in found if not v.is_set]
        if missing:
            answer = asks.ask(
                "variables",
                why=why.strip()[:300],
                agent=for_agent.strip(),
                variables=[
                    {"name": v.name, "secret": v.secret, "description": v.description}
                    for v in missing
                ],
            )
            if answer is None:
                return asks.UNATTENDED
        ready = [n for n in wanted if variables.is_set(n)]
        still = [n for n in wanted if n not in ready]
        lines = []
        if ready:
            lines.append(f"Set: {', '.join(ready)}.")
        if still:
            lines.append(f"Still not set: {', '.join(still)}; carry on without them.")
        return " ".join(lines)

    @tool
    def save_team(
        name: Annotated[str, "A name for the group, like 'Launch crew'."],
    ) -> str:
        """Offer to keep your current team as a group the user can talk to again."""
        here = _current(session_id)
        members = [m.id for m in team.roster(here)]
        if not members:
            return "You have no team to save yet."
        name = " ".join(name.split())[:40] or "Polly's team"
        answer = asks.ask(
            "confirm",
            action="save_team",
            title=f"Save this team as “{name}”?",
            detail=", ".join(s.name for i in members if (s := catalog.get(i)) is not None),
        )
        if answer is None:
            return asks.UNATTENDED
        if not answer.get("approved"):
            return "The user did not want to keep this team."
        everyone = [here.agent_id, *members][: groups.MAX_MEMBERS]
        try:
            group = groups.create(name, everyone, here.agent_id)
        except ValueError as exc:
            return f"Not saved: {exc}."
        _emit({"type": "group.created", "group_id": group.id})
        return f"Saved as the group {group.name}."

    @tool
    def propose_routine(
        name: Annotated[str, "A short name, like 'Morning briefing'."],
        task: Annotated[str, "The message the team gets each time: complete on its own."],
        cron: Annotated[
            str, "When it runs, as a cron expression ('0 8 * * 1-5' is 08:00 on weekdays)."
        ] = "",
        timezone: Annotated[str, "IANA time zone for the schedule, like 'Europe/London'."] = "UTC",
        github_repo: Annotated[str, "Instead of a schedule: run on events in owner/repo."] = "",
        github_event: Annotated[
            str, "With github_repo: 'pull_request.opened' or 'issues.opened'."
        ] = "",
    ) -> str:
        """Offer to run a task again by itself: on a schedule, or whenever something
        happens on GitHub. Your current team runs it. The user approves it on a card."""
        from polly_server.routines import store

        here = _current(session_id)
        try:
            trigger = store.trigger_from(
                cron=cron, timezone=timezone, repo=github_repo, event=github_event
            )
        except ValueError as exc:
            return f"Not done: {exc}."
        name = " ".join(name.split())[:60] or "Routine"
        answer = asks.ask(
            "confirm",
            action="routine",
            title=f"Start the routine “{name}”?",
            detail=store.describe(trigger),
            task=task.strip()[:2000],
        )
        if answer is None:
            return asks.UNATTENDED
        if not answer.get("approved"):
            return "The user did not want this routine."
        group = groups.get(here.group_id)
        routine = store.create(
            name=name,
            prompt=task.strip()[:4000],
            trigger=trigger,
            agent_id=here.agent_id,
            group_id=group.id if group else None,
            members=None if group else [m.id for m in team.roster(here)],
        )
        _emit({"type": "routine.created", "routine_id": routine.id})
        return f"The routine {routine.name} is on: {store.describe(trigger)}."

    return [
        list_agents,
        assemble_team,
        hire_agent,
        ask_user,
        request_app,
        request_variables,
        save_team,
        propose_routine,
    ]
