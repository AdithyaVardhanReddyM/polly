"""Custom agents: making, editing and running them, the shared memory they
read and write, and drafting one from a sentence."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from polly_server import memory, sandbox, sessions
from polly_server.agents import builders, catalog, custom, drafting
from polly_server.api.app import app
from polly_server.coder.runs import RunManager
from polly_server.integrations import assignments
from tests.conftest import scripted

client = TestClient(app)


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


@pytest.fixture(autouse=True)
def clean():
    yield
    for agent in custom.all_agents():
        custom.delete(agent.id)
        assignments.clear(agent.id)
    memory.clear()


def _make(**fields):
    body = {"name": "Analyst", "tagline": "Turns data into charts", **fields}
    res = client.post("/agents", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _run(agent_id, fake, text, monkeypatch):
    real = builders.build_agent
    monkeypatch.setattr(
        builders,
        "build_agent",
        lambda session, **_: real(session, model=fake, use_cache=False),
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=agent_id)

    async def go():
        manager = RunManager()
        run = await manager.start(None, session, text)
        await run.task
        return run

    return asyncio.run(go())


def test_create_lists_edits_and_deletes():
    made = _make(system_prompt="You analyse data.", integrations=["gmail"])
    assert made["id"].startswith("custom-")
    assert made["division"] == "custom" and made["custom"] and made["status"] == "ready"
    assert made["integrations"] == ["gmail"]
    assert made["tools"] == ["research_search", "web_extract"]
    assert made["avatar"]["seed"] == made["id"]

    listed = client.get("/agents").json()["agents"]
    assert made["id"] in [a["id"] for a in listed]
    assert not next(a for a in listed if a["id"] == "coder")["custom"]

    config = client.get(f"/agents/{made['id']}/config").json()
    assert config["system_prompt"] == "You analyse data." and config["integrations"] == ["gmail"]

    patched = client.patch(
        f"/agents/{made['id']}",
        json={"name": "Quant", "sandbox": True, "search": False, "integrations": []},
    ).json()
    assert patched["name"] == "Quant" and patched["sandbox"] and patched["runtime"] == "deep"
    assert patched["tools"] == [] and patched["integrations"] == []

    session = client.post("/sessions", json={"agent_id": made["id"]}).json()
    assert client.delete(f"/agents/{made['id']}").status_code == 204
    assert client.get(f"/agents/{made['id']}").status_code == 404
    assert sessions.get(session["id"]) is None
    assert catalog.get(made["id"]) is None


def test_built_ins_cannot_be_edited_and_bad_input_is_refused():
    assert client.patch("/agents/coder", json={"name": "Mine"}).status_code == 400
    assert client.delete("/agents/researcher").status_code == 400
    assert client.post("/agents", json={"name": "   "}).status_code == 422
    assert client.post("/agents", json={"name": "A", "model": "no/such-model"}).status_code == 400
    assert client.post("/agents", json={"name": "A", "integrations": ["nope"]}).status_code == 422


@pytest.mark.usefixtures("memory_checkpointer")
def test_a_custom_agent_runs_with_its_own_instructions(configure, monkeypatch):
    configure(nebius_api_key="test-key")
    made = _make(system_prompt="You only speak in haiku.", search=False, memory=False)
    seen = {}
    fake = scripted("Leaves fall on the code")
    generate = type(fake)._generate

    def spy(self, messages, *args, **kwargs):
        seen["system"] = messages[0].text
        return generate(self, messages, *args, **kwargs)

    monkeypatch.setattr(type(fake), "_generate", spy)
    run = _run(made["id"], fake, "hello", monkeypatch)
    assert run.events[-1]["status"] == "completed", run.events[-1]
    assert "You only speak in haiku." in seen["system"]
    assert "What you know about the user" not in seen["system"]


@pytest.mark.usefixtures("memory_checkpointer")
def test_agents_share_one_memory(configure, monkeypatch):
    configure(nebius_api_key="test-key")
    made = _make(search=False)
    fake = scripted(_call("remember", {"fact": "The user prefers metric units."}, "c1"), "Noted.")
    run = _run(made["id"], fake, "I use metric units", monkeypatch)
    assert run.events[-1]["status"] == "completed", run.events[-1]

    (saved,) = memory.all_memories()
    assert saved.text == "The user prefers metric units." and saved.source == made["id"]
    # The next agent to be called sees it, whichever agent that is.
    assert f"[{saved.id}] The user prefers metric units." in memory.prompt()

    listed = client.get("/memory").json()["memories"]
    assert [m["text"] for m in listed] == ["The user prefers metric units."]
    client.post("/memory", json={"text": "Lives in Hyderabad"})
    assert len(client.get("/memory").json()["memories"]) == 2
    assert client.delete(f"/memory/{saved.id}").status_code == 200
    assert client.delete(f"/memory/{saved.id}").status_code == 404
    assert [m.text for m in memory.all_memories()] == ["Lives in Hyderabad"]


def test_memory_skips_duplicates_and_keeps_the_newest():
    first = memory.add("Works in  fintech")
    assert memory.add("works in fintech").id == first.id
    assert len(memory.all_memories()) == 1


def test_a_sandbox_agent_is_told_about_its_sandbox_only_when_there_is_one(configure, monkeypatch):
    configure(nebius_project_id="")
    made = _make(sandbox=True, search=False)
    spec = catalog.get(made["id"])
    assert spec.runtime == "deep" and spec.sandbox
    assert "Your sandbox" not in builders._resolve(spec, ()).system_prompt
    monkeypatch.setattr(sandbox, "available", lambda: True)
    assert "Your sandbox" in builders._resolve(spec, ()).system_prompt


def test_outputs_stay_inside_the_output_folder():
    assert str(sandbox.output_path("/outputs/a/chart.png")) == "/outputs/a/chart.png"
    assert str(sandbox.output_path("chart.png")) == "/outputs/chart.png"
    for bad in ("/etc/passwd", "/outputs/../etc/passwd", "/outputs", "/workspace/x.png"):
        with pytest.raises(sandbox.NoSuchOutput):
            sandbox.output_path(bad)
    made = _make()
    session = client.post("/sessions", json={"agent_id": made["id"]}).json()
    res = client.get(f"/sessions/{session['id']}/outputs", params={"path": "/outputs/none.png"})
    assert res.status_code == 404


def test_a_draft_is_read_from_a_chatty_reply():
    reply = (
        "Here you go:\n```json\n"
        '{"name": "Data  Analyst", "tagline": "Turns CSVs into charts.", '
        '"description": "Give it data.", "system_prompt": "You are an analyst.\\nBe exact.", '
        '"search": false, "sandbox": true}\n```'
    )
    draft = drafting.parse(reply)
    assert draft.name == "Data Analyst" and draft.tagline == "Turns CSVs into charts"
    assert draft.sandbox and not draft.search
    with pytest.raises(drafting.DraftFailed):
        drafting.parse("I cannot help with that.")


def test_drafting_needs_a_model_key(configure):
    configure(nebius_api_key="")
    assert client.post("/agents/draft", json={"description": "a trip planner"}).status_code == 503
