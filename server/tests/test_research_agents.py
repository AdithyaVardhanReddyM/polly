"""The research and review agents end to end on fake models, and change
research chained after a Coder run."""

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from polly_server import artifacts, projects, sessions
from polly_server.agents import builders
from polly_server.api.app import app
from polly_server.coder import agent as coder_agent
from polly_server.coder import runs
from polly_server.coder.runs import RunManager
from polly_server.research import tavily
from polly_server.reviewer.scoring import CATEGORIES
from tests.conftest import scripted

client = TestClient(app)


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _types(run):
    return [e["type"] for e in run.events]


@pytest.fixture
def keys(configure):
    configure(nebius_api_key="test-key", tavily_api_key="tvly-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [
                    {"url": "https://docs.example.com/flask", "title": "Flask docs", "content": "x"}
                ]
            },
        )

    tavily.use_transport(httpx.MockTransport(handler))
    yield
    tavily.use_transport(None)


def _fake_agents(monkeypatch, fake):
    real = builders.build_agent

    def build(session, **_):
        return real(session, model=fake, fast_model=fake, strong_model=fake, use_cache=False)

    monkeypatch.setattr(builders, "build_agent", build)


@pytest.mark.usefixtures("memory_checkpointer", "keys")
def test_researcher_answers_with_numbered_sources(monkeypatch):
    fake = scripted(
        _call("research_search", {"query": "flask latest"}, "c1"),
        "Flask 3 is current [1].",
    )
    _fake_agents(monkeypatch, fake)
    session = sessions.create(None, model="m", mode="plan", agent_id="researcher")

    async def go():
        run = await RunManager().start(None, session, "what is the latest flask?")
        await run.task
        return run

    run = asyncio.run(go())
    types = _types(run)
    assert run.events[-1]["status"] == "completed", run.events[-1]
    assert "sources.added" in types
    added = next(e for e in run.events if e["type"] == "sources.added")
    assert added["sources"][0] == {**added["sources"][0], "id": 1, "title": "Flask docs"}
    final = [e for e in run.events if e["type"] == "message.completed"][-1]
    assert final["text"] == "Flask 3 is current [1]."
    assert run.events[0]["agent_id"] == "researcher"


@pytest.mark.usefixtures("memory_checkpointer", "keys")
def test_reviewer_hands_in_a_scorecard(monkeypatch):
    categories = [
        {"key": k, "score": 8, "rationale": "solid", "evidence": ["src/a.py:3"]} for k in CATEGORIES
    ]
    fake = scripted(
        _call(
            "submit_scorecard",
            {
                "summary": "Adds login.",
                "categories": categories,
                "findings": [
                    {
                        "severity": "medium",
                        "title": "No rate limit",
                        "detail": "Brute force possible.",
                        "file": "src/a.py",
                        "line": 3,
                    }
                ],
                "strengths": ["small"],
            },
            "c1",
        ),
        "Scored 80.",
    )
    _fake_agents(monkeypatch, fake)
    session = sessions.create(None, model="m", mode="plan", agent_id="reviewer")
    artifacts.save(
        session.id,
        "pr",
        {
            "url": "https://github.com/a/b/pull/1",
            "slug": "a/b#1",
            "ci": {"state": "passing"},
            "code_files": 1,
            "tests_touched": ["tests/test_a.py"],
        },
    )

    async def go():
        run = await RunManager().start(None, session, "review it")
        await run.task
        return run

    run = asyncio.run(go())
    assert run.events[-1]["status"] == "completed", run.events[-1]
    card = next(e for e in run.events if e["type"] == "scorecard")["scorecard"]
    assert card["total"] == 80 and card["verdict"] == "approve"

    body = client.get(f"/sessions/{session.id}/artifacts").json()
    assert body["scorecard"]["total"] == 80
    preview = client.get(f"/sessions/{session.id}/scorecard/preview").json()["markdown"]
    assert "80/100" in preview and "No rate limit" in preview
    # Posting needs a connected account.
    assert client.post(f"/sessions/{session.id}/scorecard/post").status_code == 401


def _coder_then_research(project, monkeypatch, *, child_script=None):
    coder_fake = scripted(
        _call("write_file", {"file_path": "/src/new.py", "content": "import flask\n"}, "c1"),
        "Added src/new.py.",
    )
    monkeypatch.setattr(
        runs,
        "build_coder",
        lambda p, s: coder_agent.build_coder(p, s, model=coder_fake, fast_model=coder_fake),
    )
    child_fake = scripted(
        *(
            child_script
            or [
                _call("research_search", {"query": "flask import"}, "r1"),
                _call(
                    "submit_change_report",
                    {
                        "summary": "Fine.",
                        "verdict": "looks_good",
                        "findings": [
                            {
                                "severity": "info",
                                "title": "Current API",
                                "detail": "ok",
                                "sources": [1],
                            }
                        ],
                        "pr_title": "Add new module",
                        "pr_description": "## Why\nBecause.",
                    },
                    "r2",
                ),
                "All good.",
            ]
        )
    )
    _fake_agents(monkeypatch, child_fake)
    manager = RunManager()
    session = sessions.create(project.id, model=project.settings.default_model, mode="autonomous")

    async def go():
        run = await manager.start(project, session, "add a module")
        await run.task
        child_run = None
        started = [e for e in run.events if e["type"] == "research.started"]
        if started:
            child_run = manager.for_session(started[0]["session_id"])
            await child_run.task
        return run, child_run

    return session, *asyncio.run(go())


@pytest.mark.usefixtures("memory_checkpointer", "keys")
def test_change_research_follows_a_coder_run(project, monkeypatch):
    session, run, child_run = _coder_then_research(project, monkeypatch)
    assert run.events[-1]["type"] == "run.finished"
    started = next(e for e in run.events if e["type"] == "research.started")
    child = sessions.get(started["session_id"])
    assert child.agent_id == "change-research"
    assert child.parent_session_id == session.id
    assert child.project_id == project.id

    assert child_run.events[-1]["status"] == "completed", child_run.events[-1]
    report = next(e for e in child_run.events if e["type"] == "report")["report"]
    assert report["pr_title"] == "Add new module"
    assert report["sources"][0]["url"] == "https://docs.example.com/flask"

    # The prompt carried the request, the Coder's summary and the diff; the
    # transcript shows the short display text instead.
    shown = client.get(f"/sessions/{child.id}/messages").json()["messages"]
    assert shown[0]["role"] == "user" and shown[0]["text"].startswith(
        "Research the change (1 file)"
    )

    listed = client.get(f"/sessions/{session.id}/research").json()["sessions"]
    assert [s["id"] for s in listed] == [child.id]
    # Not listed as a Coder session of the project.
    assert child.id not in {s.id for s in sessions.list_for(project.id)}

    # Same changes again: not researched a second time automatically.
    with pytest.raises(runs.NothingToResearch, match="already researched"):
        asyncio.run(RunManager().research_change(project, session, auto=True))


@pytest.mark.usefixtures("memory_checkpointer", "keys")
def test_no_change_research_when_the_project_turns_it_off(project, monkeypatch):
    projects.update(project.id, auto_research=False)
    project = projects.get(project.id)
    _, run, child_run = _coder_then_research(project, monkeypatch)
    assert run.events[-1]["status"] == "completed"
    assert "research.started" not in _types(run)
    assert child_run is None


@pytest.mark.usefixtures("memory_checkpointer")
def test_no_change_research_without_a_search_key(project, monkeypatch, configure):
    configure(nebius_api_key="test-key", tavily_api_key="")
    _, run, child_run = _coder_then_research(project, monkeypatch)
    assert run.events[-1]["status"] == "completed"
    assert "research.started" not in _types(run)


@pytest.mark.usefixtures("memory_checkpointer", "keys")
def test_research_button_without_changes_is_409(project):
    session = sessions.create(project.id, model=project.settings.default_model, mode="supervised")
    res = client.post(f"/sessions/{session.id}/research")
    assert res.status_code == 409
    assert "no pending changes" in res.json()["detail"]


def test_agent_sessions_are_listed_per_agent():
    a = sessions.create(None, model="m", mode="plan", agent_id="deep-research")
    sessions.create(None, model="m", mode="plan", agent_id="researcher")
    listed = client.get("/sessions", params={"agent_id": "deep-research"}).json()["sessions"]
    assert a.id in {s["id"] for s in listed}
    assert all(s["agent_id"] == "deep-research" for s in listed)


def test_create_session_for_agents(project):
    res = client.post("/sessions", json={"agent_id": "researcher"})
    assert res.status_code == 201
    body = res.json()
    assert body["agent_id"] == "researcher" and body["project_id"] is None
    assert body["mode"] == "plan"
    assert client.post("/sessions", json={"agent_id": "coder"}).status_code == 404
    assert client.post("/sessions", json={"agent_id": "inbox"}).status_code == 400
    assert client.post("/sessions", json={"agent_id": "change-research"}).status_code == 404
    coder = client.post("/sessions", json={"project_id": project.id}).json()
    assert coder["agent_id"] == "coder"


def test_old_session_files_still_load():
    session = sessions.create("p1", model="m", mode="supervised")
    path = sessions.session_dir(session) / "session.json"
    data = __import__("json").loads(path.read_text())
    for key in ("agent_id", "parent_session_id"):
        data.pop(key)
    path.write_text(__import__("json").dumps(data))
    loaded = sessions.get(session.id)
    assert loaded.agent_id == "coder" and loaded.parent_session_id is None


def test_research_agents_need_a_search_key(configure):
    configure(nebius_api_key="test-key", tavily_api_key="")
    session = sessions.create(None, model="m", mode="plan", agent_id="researcher")
    res = client.post(f"/sessions/{session.id}/messages", json={"content": "hi"})
    assert res.status_code == 503
