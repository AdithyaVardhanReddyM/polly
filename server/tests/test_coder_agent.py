"""End to end on a fake model: tools run, approvals pause, decisions resume."""

import asyncio

import pytest
from langchain_core.messages import AIMessage

from polly_server import sessions
from polly_server.coder import agent as coder_agent
from polly_server.coder import runs
from polly_server.coder.runs import RunManager
from tests.conftest import scripted


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _build_with(fake):
    def build(project, session):
        return coder_agent.build_coder(project, session, model=fake, fast_model=fake)

    return build


def _types(run):
    return [e["type"] for e in run.events]


async def _finished(run):
    await run.task
    return run


@pytest.mark.usefixtures("memory_checkpointer")
def test_supervised_run_pauses_for_a_write_then_resumes(project, monkeypatch):
    fake = scripted(
        _call("ls", {"path": "/"}, "c1"),
        _call("write_file", {"file_path": "/hello.txt", "content": "hi\n"}, "c2"),
        "done",
    )
    monkeypatch.setattr(runs, "build_coder", _build_with(fake))
    manager = RunManager()
    session = sessions.create(project.id, model=project.settings.default_model, mode="supervised")

    async def go():
        run = await manager.start(project, session, "say hello")
        await _finished(run)
        return run

    run = asyncio.run(go())
    types = _types(run)
    assert types[0] == "run.started"
    assert "tool.call" in types and "tool.result" in types
    assert "approval.required" in types
    assert run.events[-1]["type"] == "run.finished"
    assert run.events[-1]["status"] == "awaiting_approval"
    approval = next(e for e in run.events if e["type"] == "approval.required")
    assert approval["requests"][0]["name"] == "write_file"
    assert approval["requests"][0]["kind"] == "edit"
    assert not (project.root / "hello.txt").exists()
    assert sessions.get(session.id).status == "awaiting_approval"
    assert sessions.get(session.id).title == "say hello"

    async def approve():
        run = await manager.resume(project, sessions.get(session.id), [{"type": "approve"}])
        await _finished(run)
        return run

    run2 = asyncio.run(approve())
    assert run2.events[-1]["status"] == "completed"
    assert (project.root / "hello.txt").read_text() == "hi\n"
    final = [e for e in run2.events if e["type"] == "message.completed"][-1]
    assert final["text"] == "done"
    assert sessions.get(session.id).status == "idle"


@pytest.mark.usefixtures("memory_checkpointer")
def test_autonomous_run_does_not_pause(project, monkeypatch):
    fake = scripted(_call("write_file", {"file_path": "/a.txt", "content": "a"}, "c1"), "ok")
    monkeypatch.setattr(runs, "build_coder", _build_with(fake))
    manager = RunManager()
    session = sessions.create(project.id, model=project.settings.default_model, mode="autonomous")

    run = _go(manager, project, session)
    assert "approval.required" not in _types(run)
    assert run.events[-1]["status"] == "completed"
    assert (project.root / "a.txt").read_text() == "a"


@pytest.mark.usefixtures("memory_checkpointer")
def test_plan_mode_blocks_writes(project, monkeypatch):
    fake = scripted(_call("write_file", {"file_path": "/a.txt", "content": "a"}, "c1"), "plan")
    monkeypatch.setattr(runs, "build_coder", _build_with(fake))
    manager = RunManager()
    session = sessions.create(project.id, model=project.settings.default_model, mode="plan")

    run = _go(manager, project, session)
    results = [e for e in run.events if e["type"] == "tool.result"]
    assert results and results[0]["status"] == "blocked"
    assert not (project.root / "a.txt").exists()
    assert run.events[-1]["status"] == "completed"


def _go(manager, project, session):
    async def inner():
        run = await manager.start(project, session, "go")
        await _finished(run)
        return run

    return asyncio.run(inner())


def test_coder_prompt_introduces_every_subagent():
    from polly_server.agents import catalog
    from polly_server.coder.prompt import SYSTEM_PROMPT

    spec = catalog.get("coder")
    names = [s.name for s in spec.subagents]
    assert names == ["explorer", "tester", "librarian"]
    for name in names:
        assert f"`{name}`" in SYSTEM_PROMPT
    librarian = next(s for s in spec.subagents if s.name == "librarian")
    assert set(librarian.tools) == {"research_search", "web_extract"}


@pytest.mark.usefixtures("memory_checkpointer")
def test_coder_builds_without_web_search(project):
    """Without a Tavily key the librarian has no tools, so it is left out and
    the Coder still builds (the tests run with the key unset)."""
    session = sessions.create(project.id, model="x", mode="supervised")
    fake = scripted("hi")
    agent = coder_agent.build_coder(project, session, model=fake, fast_model=fake, use_cache=False)
    assert agent is not None
