"""The built-in agents. Declared only — none are implemented yet."""

from __future__ import annotations

from polly_server.agents.spec import AgentSpec, SubagentSpec

CATALOG: tuple[AgentSpec, ...] = (
    # ---------- coding ----------
    AgentSpec(
        id="coder",
        name="Coder",
        division="coding",
        runtime="deep",
        avatar={
            "eyesVariant": "visor",
            "topVariant": "antenna",
            "chestVariant": "screen",
            "mouthVariant": "line",
            "bodyColor": "74c0fc",
        },
        tagline="Writes, runs and tests code",
        description=(
            "Plans a change, edits the repo in its sandbox, runs the tests and "
            "opens a pull request when they pass."
        ),
        tools=("sandbox", "github", "web_search"),
        subagents=(
            SubagentSpec("explorer", "Reads a codebase and reports where things live."),
            SubagentSpec("tester", "Writes and runs tests for a change."),
        ),
        computer=True,
    ),
    AgentSpec(
        id="designer",
        name="Designer",
        division="coding",
        runtime="deep",
        avatar={
            "eyesVariant": "happy",
            "topVariant": "lightbar",
            "chestVariant": "dial",
            "mouthVariant": "smile",
            "bodyColor": "b6a6f5",
        },
        tagline="Turns ideas into interfaces",
        description=(
            "Sketches UI, builds working front-end prototypes and checks them in "
            "a real browser on its computer."
        ),
        tools=("sandbox", "browser", "figma"),
        computer=True,
    ),
    AgentSpec(
        id="reviewer",
        name="Reviewer",
        division="coding",
        runtime="deep",
        avatar={
            "eyesVariant": "square",
            "topVariant": "dish",
            "chestVariant": "slot",
            "mouthVariant": "grill",
            "bodyColor": "aeb8c2",
        },
        tagline="Reviews and debugs pull requests",
        description=(
            "Reads a diff in context, reproduces bugs in a sandbox and leaves "
            "line-level review comments with suggested fixes."
        ),
        tools=("sandbox", "github"),
        subagents=(SubagentSpec("debugger", "Reproduces a failure and isolates its cause."),),
    ),
    # ---------- research ----------
    AgentSpec(
        id="researcher",
        name="Researcher",
        division="research",
        runtime="agent",
        avatar={
            "eyesVariant": "round",
            "topVariant": "twin",
            "chestVariant": "buttons",
            "mouthVariant": "speaker",
            "bodyColor": "63e6be",
        },
        tagline="Fast answers with sources",
        description="Searches the web, reads the pages that matter and answers with citations.",
        tools=("web_search", "web_extract"),
        model_tier="fast",
    ),
    AgentSpec(
        id="deep-research",
        name="Deep Research",
        division="research",
        runtime="deep",
        avatar={
            "eyesVariant": "cyclops",
            "topVariant": "fin",
            "chestVariant": "vents",
            "mouthVariant": "line",
            "bodyColor": "69db7c",
        },
        tagline="Long-form reports, done properly",
        description=(
            "Breaks a question into threads, researches them in parallel and "
            "writes a structured report, with charts and data from its sandbox."
        ),
        tools=("web_search", "web_extract", "sandbox"),
        subagents=(
            SubagentSpec("scout", "Researches one sub-question and returns notes with sources."),
            SubagentSpec("critic", "Checks a draft for gaps and unsupported claims."),
        ),
    ),
    # ---------- everyday ----------
    AgentSpec(
        id="inbox",
        name="Inbox",
        division="everyday",
        runtime="agent",
        avatar={
            "eyesVariant": "happy",
            "topVariant": "studs",
            "chestVariant": "slot",
            "mouthVariant": "smile",
            "bodyColor": "ffd43b",
        },
        tagline="Triage, replies and follow-ups",
        description=(
            "Sorts what needs you from what doesn't, drafts replies in your "
            "voice and tracks threads waiting on someone else."
        ),
        tools=("gmail",),
    ),
    AgentSpec(
        id="calendar",
        name="Calendar",
        division="everyday",
        runtime="agent",
        avatar={
            "eyesVariant": "plus",
            "topVariant": "antenna",
            "chestVariant": "dial",
            "mouthVariant": "speaker",
            "bodyColor": "ff9d9d",
        },
        tagline="Scheduling without the back-and-forth",
        description=(
            "Finds time, proposes slots, books meetings and prepares a brief before each one."
        ),
        tools=("google_calendar", "gmail"),
    ),
    AgentSpec(
        id="operator",
        name="Operator",
        division="everyday",
        runtime="deep",
        avatar={
            "eyesVariant": "visor",
            "topVariant": "siren",
            "chestVariant": "buttons",
            "mouthVariant": "grill",
            "bodyColor": "e9ecef",
        },
        tagline="Uses a computer so you don't have to",
        description=(
            "Fills forms, makes slide decks and spreadsheets, and works through "
            "web apps on its own desktop."
        ),
        tools=("computer", "browser", "sandbox"),
        computer=True,
    ),
)


def get(agent_id: str) -> AgentSpec | None:
    return next((a for a in CATALOG if a.id == agent_id), None)
