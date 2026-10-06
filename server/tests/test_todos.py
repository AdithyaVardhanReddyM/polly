"""To-dos and reminders: the HTTP API the app and the notch use, the Python
API the copilot uses, and the tools agents get with their memory."""

import asyncio
import datetime as dt
import time

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from polly_server import sessions, todos
from polly_server.agents import builders, custom
from polly_server.api.app import app
from polly_server.coder.runs import RunManager
from tests.conftest import scripted

client = TestClient(app)


@pytest.fixture(autouse=True)
def own_data(configure, tmp_path):
    configure(data_dir=tmp_path)


def _add(**fields):
    res = client.post("/todos", json={"title": "Something", **fields})
    assert res.status_code == 201, res.text
    return res.json()


def test_add_list_edit_and_delete():
    now = time.time()
    later = _add(title="  Send   Maria the deck ", due_at=now + 7200)
    sooner = _add(title="Book flights", due_at=now + 3600)
    undated = _add(title="Read the RFC")

    assert later["title"] == "Send Maria the deck"
    assert later["source"] == {
        "kind": "user",
        "app": None,
        "bundle_id": None,
        "window": None,
        "url": None,
        "excerpt": None,
        "agent_id": None,
    }
    assert later["status"] == "open" and later["completed_at"] is None
    assert later["created_at"] == later["updated_at"] and later["created_at"] >= now

    listed = client.get("/todos").json()["todos"]
    assert [t["id"] for t in listed] == [sooner["id"], later["id"], undated["id"]]

    done = client.patch(f"/todos/{sooner['id']}", json={"status": "done"}).json()
    assert done["status"] == "done" and done["completed_at"] is not None
    assert [t["id"] for t in client.get("/todos").json()["todos"]] == [later["id"], undated["id"]]
    assert [t["id"] for t in client.get("/todos?status=done").json()["todos"]] == [sooner["id"]]
    assert len(client.get("/todos?status=all").json()["todos"]) == 3

    reopened = client.patch(f"/todos/{sooner['id']}", json={"status": "open"}).json()
    assert reopened["status"] == "open" and reopened["completed_at"] is None

    # Only what is sent changes; null clears a time.
    edited = client.patch(f"/todos/{later['id']}", json={"notes": "v3", "due_at": None}).json()
    assert edited["notes"] == "v3" and edited["due_at"] is None
    assert edited["title"] == "Send Maria the deck"

    assert client.delete(f"/todos/{undated['id']}").status_code == 204
    assert client.delete(f"/todos/{undated['id']}").status_code == 404
    assert client.patch("/todos/nope", json={"title": "x"}).status_code == 404


def test_titles_are_required_and_bounded():
    assert client.post("/todos", json={"title": "   "}).status_code == 422
    assert client.post("/todos", json={"notes": "no title"}).status_code == 422
    assert len(_add(title="x" * 500)["title"]) == 200
    made = _add(title="Keep")
    assert client.patch(f"/todos/{made['id']}", json={"title": " "}).status_code == 422


def test_done_list_is_newest_completed_first():
    first, second = _add(title="First"), _add(title="Second")
    todos.update(second["id"], {"status": "done"})
    time.sleep(0.01)
    todos.update(first["id"], {"status": "done"})
    assert [t.id for t in todos.all_todos("done")] == [first["id"], second["id"]]


def test_reminders_fire_once_and_snooze():
    now = time.time()
    due = _add(title="Call the bank", remind_at=now - 5)
    _add(title="Later", remind_at=now + 3600)
    _add(title="No reminder")

    assert [t["id"] for t in client.get("/todos/due").json()["todos"]] == [due["id"]]
    shown = client.post(f"/todos/{due['id']}/reminded").json()
    assert shown["reminded_at"] is not None
    assert client.get("/todos/due").json()["todos"] == []

    snoozed = client.post(f"/todos/{due['id']}/snooze", json={"minutes": 10}).json()
    assert snoozed["reminded_at"] is None
    assert snoozed["remind_at"] == pytest.approx(time.time() + 600, abs=5)
    assert todos.due() == []
    assert [t.id for t in todos.due(now + 601)] == [due["id"]]
    assert client.post(f"/todos/{due['id']}/snooze", json={"minutes": 0}).status_code == 422
    assert client.post("/todos/nope/reminded").status_code == 404

    # A new reminder time lets a shown reminder fire again; the same one does not.
    todos.mark_reminded(due["id"])
    same = todos.update(due["id"], {"remind_at": snoozed["remind_at"]})
    assert same.reminded_at is not None
    moved = todos.update(due["id"], {"remind_at": now - 1})
    assert moved.reminded_at is None and [t.id for t in todos.due()] == [due["id"]]

    # Done to-dos do not remind.
    todos.update(due["id"], {"status": "done"})
    assert todos.due() == []


def test_similar_open_finds_near_duplicates():
    made = todos.add({"title": "Send the Q3 deck to Maria!"})
    assert todos.similar_open("send the q3 deck to   maria").id == made.id
    assert todos.similar_open("Send Q3 deck to Maria").id == made.id
    assert todos.similar_open("Send the Q4 plan to Bob") is None
    assert todos.similar_open("!!!") is None
    todos.update(made.id, {"status": "done"})
    assert todos.similar_open("Send the Q3 deck to Maria") is None


def test_the_copilot_records_where_it_saw_one():
    made = todos.add(
        {"title": "Reply to Maria", "notes": "about Thursday"},
        source={"kind": "copilot", "app": "Slack", "excerpt": "can you reply by Thu?"},
    )
    assert made.source.kind == "copilot" and made.source.app == "Slack"
    assert todos.get(made.id) == made
    assert todos.remove(made.id) and todos.get(made.id) is None


def test_local_times_parse_in_the_users_zone():
    naive = todos.parse_local("2026-10-07T15:30")
    assert naive == dt.datetime(2026, 10, 7, 15, 30).astimezone().timestamp()
    assert (
        todos.parse_local("2026-10-07T15:30:00Z")
        == dt.datetime(2026, 10, 7, 15, 30, tzinfo=dt.UTC).timestamp()
    )
    assert todos.parse_local("2026-10-07", date_only=(23, 59)) == (
        dt.datetime(2026, 10, 7, 23, 59).astimezone().timestamp()
    )
    with pytest.raises(ValueError, match="ISO 8601"):
        todos.parse_local("next tuesday")


def test_agent_tools_edit_the_same_list():
    add, list_, update, complete = todos.tools_for("researcher")
    reply = add.invoke({"title": "Renew passport", "due": "2026-11-01", "remind": "2026-10-25"})
    assert reply.startswith("Added [")
    (made,) = todos.all_todos()
    assert made.source.kind == "agent" and made.source.agent_id == "researcher"
    assert made.due_at == dt.datetime(2026, 11, 1, 23, 59).astimezone().timestamp()
    assert made.remind_at == dt.datetime(2026, 10, 25, 9, 0).astimezone().timestamp()
    assert "Not added" in add.invoke({"title": "x", "due": "soon"})

    assert f"[{made.id}] Renew passport" in list_.invoke({})
    changed = update.invoke({"todo_id": f"[{made.id}]", "title": "Renew both passports"})
    assert "Renew both passports" in changed
    update.invoke({"todo_id": made.id, "due": "none"})
    assert todos.get(made.id).due_at is None
    assert complete.invoke({"todo_id": made.id}) == "Done: Renew both passports"
    assert list_.invoke({}) == "No open to-dos."
    assert "No to-do" in complete.invoke({"todo_id": "nope"})


def test_the_prompt_lists_open_todos_with_ids():
    for n in range(12):
        todos.add({"title": f"Task {n}"})
    text = todos.prompt()
    assert "## The user's to-do list" in text
    assert text.count("] Task ") == todos.PROMPT_LIMIT
    assert "and 2 more" in text


# ---------- agents get the tools with their memory ----------


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _run(agent_id, fake, text, monkeypatch):
    real = builders.build_agent
    monkeypatch.setattr(
        builders, "build_agent", lambda session, **_: real(session, model=fake, use_cache=False)
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=agent_id)

    async def go():
        run = await RunManager().start(None, session, text)
        await run.task
        return run

    return asyncio.run(go())


def _custom(**fields):
    res = client.post("/agents", json={"name": "Helper", "search": False, **fields})
    assert res.status_code == 201, res.text
    return res.json()["id"]


@pytest.mark.usefixtures("memory_checkpointer")
def test_an_agent_with_memory_adds_a_todo(configure, monkeypatch):
    configure(nebius_api_key="test-key")
    agent_id = _custom()
    seen = {}
    fake = scripted(
        _call("add_todo", {"title": "Email the landlord", "remind": "2026-10-08T09:00"}, "c1"),
        "Added it.",
    )
    generate = type(fake)._generate

    def spy(self, messages, *args, **kwargs):
        seen.setdefault("system", messages[0].text)
        return generate(self, messages, *args, **kwargs)

    monkeypatch.setattr(type(fake), "_generate", spy)
    try:
        run = _run(agent_id, fake, "Remind me to email the landlord tomorrow at 9", monkeypatch)
    finally:
        custom.delete(agent_id)
    assert run.events[-1]["status"] == "completed", run.events[-1]
    assert "## The user's to-do list" in seen["system"]
    assert "What you know about the user" in seen["system"]

    (made,) = todos.all_todos()
    assert made.title == "Email the landlord" and made.source.agent_id == agent_id
    assert made.remind_at == dt.datetime(2026, 10, 8, 9, 0).astimezone().timestamp()


@pytest.mark.usefixtures("memory_checkpointer")
def test_an_agent_without_memory_has_no_todo_list(configure, monkeypatch):
    configure(nebius_api_key="test-key")
    agent_id = _custom(memory=False)
    seen = {}
    fake = scripted("Hello.")
    generate = type(fake)._generate

    def spy(self, messages, *args, **kwargs):
        seen["system"] = messages[0].text
        return generate(self, messages, *args, **kwargs)

    monkeypatch.setattr(type(fake), "_generate", spy)
    try:
        run = _run(agent_id, fake, "hi", monkeypatch)
    finally:
        custom.delete(agent_id)
    assert run.events[-1]["status"] == "completed", run.events[-1]
    assert "to-do list" not in seen["system"]
