"""Polly puts a team together: cards the user answers, agents it hires."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from polly_server import sessions, variables
from polly_server.agents import asks, builders, custom, groups, team
from polly_server.api.app import app
from polly_server.coder import permissions
from polly_server.coder.runs import RunManager
from polly_server.integrations import assignments
from tests.conftest import scripted

client = TestClient(app)


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


HIRE = {
    "name": "Standup Writer",
    "tagline": "Writes the daily standup",
    "description": "Turns yesterday's work into a short standup note.",
    "instructions": "You write standup notes.",
    "reason": "No agent writes standups.",
    "variables_needed": ["STANDUP_CHANNEL"],
}


@pytest.fixture(autouse=True)
def clean():
    yield
    for group in groups.all_groups():
        groups.delete(group.id)
    for agent in custom.all_agents():
        custom.delete(agent.id)
        assignments.clear(agent.id)
        team.clear(agent.id)
    for v in variables.all_variables():
        variables.delete(v.name)


def _models(monkeypatch, polly, others=None):
    """Polly answers from `polly`; any other agent from `others`."""
    real = builders.build_agent

    def build(session, as_agent=None, **_):
        fake = polly if (as_agent or session.agent_id) == "polly" else others
        return real(session, model=fake, use_cache=False, as_agent=as_agent)

    monkeypatch.setattr(builders, "build_agent", build)


def _events(run, kind):
    return [e for e in run.events if e["type"] == kind]


def _polly_session():
    return sessions.create(None, model="fake", mode="plan", agent_id="polly")


def _start(session, text, policy=None):
    async def go():
        run = await RunManager().start(None, sessions.get(session.id), text, policy=policy)
        await run.task
        return run

    return asyncio.run(go())


def _answer(session, interrupt_id, **value):
    async def go():
        run = await RunManager().answer(None, sessions.get(session.id), interrupt_id, value)
        await run.task
        return run

    return asyncio.run(go())


def test_polly_is_listed_and_cannot_be_a_teammate():
    listed = {a["id"]: a for a in client.get("/agents").json()["agents"]}
    assert listed["polly"]["orchestrator"] and not listed["polly"]["can_join"]
    with pytest.raises(ValueError, match="leads teams"):
        team.check(["polly"])


def test_a_hire_waits_for_the_user_and_rejecting_makes_nothing(memory_checkpointer, monkeypatch):
    polly = scripted(_call("hire_agent", HIRE, "h1"), "Fine, I'll write it myself.")
    _models(monkeypatch, polly)
    session = _polly_session()

    run = _start(session, "Post my standup every morning")
    (card,) = _events(run, "ask.required")
    assert card["kind"] == "hire" and card["interrupt_id"]
    assert card["agent"]["name"] == "Standup Writer"
    assert card["agent"]["variables"] == [{"name": "STANDUP_CHANNEL", "is_set": False}]
    assert _events(run, "run.finished")[0]["status"] == "awaiting_approval"
    assert sessions.get(session.id).status == "awaiting_approval"
    # Nothing is made before the user answers.
    assert custom.all_agents() == []

    run = _answer(session, card["interrupt_id"], approved=False, answer="Not now")
    result = next(e for e in _events(run, "tool.result") if e["call_id"] == "h1")
    assert "said no" in result["output"] and "Not now" in result["output"]
    assert custom.all_agents() == []
    assert sessions.get(session.id).status == "idle"


def test_an_approved_hire_joins_the_team_and_takes_work(memory_checkpointer, monkeypatch):
    polly = scripted(
        _call("hire_agent", HIRE, "h1"),
        _call("ask_teammate", {"teammate": "Standup Writer", "message": "Write it."}, "t1"),
        "Here is your standup.",
    )
    _models(monkeypatch, polly, scripted("Yesterday: shipped routines."))
    session = _polly_session()

    (card,) = _events(_start(session, "Write my standup"), "ask.required")
    run = _answer(session, card["interrupt_id"], approved=True)

    (made,) = custom.all_agents()
    assert made.origin == "polly" and made.name == "Standup Writer"
    assert sessions.get(session.id).members == [made.id]
    (hired,) = _events(run, "agent.hired")
    assert hired["agent"]["id"] == made.id and hired["agent"]["hired"]
    # The variable it needs is listed for the user to fill in, for it alone.
    needed = variables.get("STANDUP_CHANNEL")
    assert needed is not None and not needed.is_set and needed.agents == [made.id]
    # Polly was built before the agent existed, and still reaches it.
    result = next(e for e in _events(run, "tool.result") if e["call_id"] == "t1")
    assert result["output"] == "Yesterday: shipped routines."
    assert _events(run, "run.finished")[0]["status"] == "completed"


def test_a_routine_run_never_stops_to_ask(memory_checkpointer, monkeypatch):
    polly = scripted(_call("hire_agent", HIRE, "h1"), "Done without help.")
    _models(monkeypatch, polly)
    session = _polly_session()

    run = _start(session, "Standup", policy=permissions.Policy(mode="plan", ask_means_deny=True))
    assert _events(run, "ask.required") == []
    result = next(e for e in _events(run, "tool.result") if e["call_id"] == "h1")
    assert result["output"] == asks.UNATTENDED
    assert _events(run, "run.finished")[0]["status"] == "completed"
    assert custom.all_agents() == []


def test_polly_asks_for_settings_and_only_learns_whether_they_are_set(
    memory_checkpointer, monkeypatch
):
    ask = {"names": ["WEATHER_KEY"], "why": "To read the forecast."}
    polly = scripted(_call("request_variables", ask, "v1"), "Thanks.")
    _models(monkeypatch, polly)
    session = _polly_session()

    (card,) = _events(_start(session, "Weather?"), "ask.required")
    assert card["kind"] == "variables"
    assert card["variables"] == [
        {"name": "WEATHER_KEY", "secret": True, "description": "To read the forecast."}
    ]
    # The user saves the value from the card, straight to the store.
    assert client.put("/variables/WEATHER_KEY", json={"value": "sk-weather-123"}).status_code == 200
    run = _answer(session, card["interrupt_id"], done=True)
    result = next(e for e in _events(run, "tool.result") if e["call_id"] == "v1")
    assert result["output"] == "Set: WEATHER_KEY."
    assert "sk-weather-123" not in str(run.events)


def test_the_transcript_and_the_answer_endpoint(memory_checkpointer, monkeypatch, configure):
    configure(nebius_api_key="test-key")
    polly = scripted(
        _call("ask_user", {"question": "Which repo?", "options": ["api", "web"]}, "q1"),
        "On it.",
    )
    _models(monkeypatch, polly)
    session = _polly_session()

    assert client.post(f"/sessions/{session.id}/answer", json={"answer": "x"}).status_code == 409
    (card,) = _events(_start(session, "Review my repo"), "ask.required")
    pending = client.get(f"/sessions/{session.id}/messages").json()["pending_ask"]
    assert pending["kind"] == "question" and pending["options"] == ["api", "web"]
    assert pending["interrupt_id"] == card["interrupt_id"]

    res = client.post(
        f"/sessions/{session.id}/answer",
        json={"interrupt_id": card["interrupt_id"], "answer": "web"},
    )
    assert res.status_code == 200
    assert "The user answered: web" in res.text
    assert client.get(f"/sessions/{session.id}/messages").json()["pending_ask"] is None


def test_saving_the_team_makes_a_group_led_by_polly(memory_checkpointer, monkeypatch):
    mate = custom.create(name="Analyst")
    polly = scripted(
        _call("assemble_team", {"agent_ids": [mate.id]}, "a1"),
        _call("save_team", {"name": "Numbers"}, "s1"),
        "Saved.",
    )
    _models(monkeypatch, polly)
    session = _polly_session()

    (card,) = _events(_start(session, "Keep this team"), "ask.required")
    assert card["kind"] == "confirm" and "Numbers" in card["title"]
    _answer(session, card["interrupt_id"], approved=True)
    (group,) = groups.all_groups()
    assert group.lead == "polly" and group.members == ["polly", mate.id]
