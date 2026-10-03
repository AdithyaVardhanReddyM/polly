"""The built-in agents. Coder, Reviewer, Researcher and Deep Research run
today; the rest are declared only. `change-research` is internal: it runs
after a Coder session and is not listed as an agent of its own."""

from __future__ import annotations

from polly_server.agents.spec import AgentSpec, SubagentSpec
from polly_server.coder.prompt import (
    EXPLORER_PROMPT,
    LIBRARIAN_PROMPT,
    SYSTEM_PROMPT,
    TESTER_PROMPT,
)
from polly_server.research.prompts import (
    CHANGE_RESEARCH_PROMPT,
    CRITIC_PROMPT,
    DEEP_RESEARCH_PROMPT,
    RESEARCHER_PROMPT,
    SCOUT_PROMPT,
)
from polly_server.reviewer.prompt import RESEARCH_HELPER_PROMPT, REVIEWER_PROMPT

RESEARCH = ("research_search", "web_extract")
GITHUB = ("github_pr_overview", "github_pr_files", "github_file", "github_pr_checks")

SCOUT = SubagentSpec(
    "scout",
    "Researches one sub-question on the web and returns notes with numbered sources. "
    "Give it a precise brief; run several in parallel for independent threads.",
    system_prompt=SCOUT_PROMPT,
    tools=RESEARCH,
)

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
            "Plans a change, edits the project, runs the tests and commits "
            "when they pass. Asks before anything you have not trusted it with."
        ),
        status="ready",
        system_prompt=SYSTEM_PROMPT,
        tools=("web_search", "git_status", "git_diff", "git_branch", "git_commit"),
        subagents=(
            SubagentSpec(
                "explorer",
                "Reads the codebase and reports where things live and how they connect.",
                system_prompt=EXPLORER_PROMPT,
            ),
            SubagentSpec(
                "tester",
                "Writes and runs tests for a change and reports what passed.",
                system_prompt=TESTER_PROMPT,
            ),
            SubagentSpec(
                "librarian",
                "Looks up a library, API, version change or error message on the web "
                "and returns short notes with sources. Read-only.",
                system_prompt=LIBRARIAN_PROMPT,
                tools=RESEARCH,
            ),
        ),
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
        tagline="Scores and reviews pull requests",
        description=(
            "Paste a GitHub PR link: it reads the diff in context, checks CI and "
            "dependencies, and scores the PR against a fixed rubric with "
            "line-level findings you can post as a comment."
        ),
        status="ready",
        system_prompt=REVIEWER_PROMPT,
        tools=(*GITHUB, *RESEARCH, "submit_scorecard"),
        subagents=(
            SubagentSpec(
                "researcher",
                "Checks a dependency or API on the web: advisories and CVEs, deprecations, "
                "documented usage. Returns short notes with numbered sources.",
                system_prompt=RESEARCH_HELPER_PROMPT,
                tools=RESEARCH,
            ),
        ),
        model_tier="strong",
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
        status="ready",
        system_prompt=RESEARCHER_PROMPT,
        tools=RESEARCH,
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
            "Breaks a question into threads, researches them in parallel with "
            "scouts, has a critic check the draft and writes a cited report."
        ),
        status="ready",
        system_prompt=DEEP_RESEARCH_PROMPT,
        tools=RESEARCH,
        subagents=(
            SCOUT,
            SubagentSpec(
                "critic",
                "Checks a draft report for unsupported claims, gaps and contradictions "
                "and returns a list of fixes.",
                system_prompt=CRITIC_PROMPT,
                tools=RESEARCH,
            ),
        ),
    ),
    AgentSpec(
        id="change-research",
        name="Change research",
        division="research",
        runtime="deep",
        avatar={
            "eyesVariant": "round",
            "topVariant": "twin",
            "chestVariant": "buttons",
            "mouthVariant": "speaker",
            "bodyColor": "63e6be",
        },
        tagline="Checks a Coder change against the docs",
        description=(
            "Runs after the Coder: checks the APIs and dependencies a change uses "
            "against current docs and advisories and drafts the PR description."
        ),
        status="ready",
        system_prompt=CHANGE_RESEARCH_PROMPT,
        tools=(*RESEARCH, "submit_change_report"),
        subagents=(SCOUT,),
        metadata={"internal": "true"},
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
