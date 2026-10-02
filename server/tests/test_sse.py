"""The HTTP layer: sessions, streaming runs, decisions, transcripts."""

import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from polly_server.api.app import app
from polly_server.api.routers import sessions as sessions_router
from polly_server.coder import agent as coder_agent
from polly_server.coder import runs
from polly_server.config import settings
from tests.conftest import scripted


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _events(response):
    out = []
    for line in response.iter_lines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(sessions_router, "settings", replace(settings, nebius_api_key="k"))
    with TestClient(app) as c:
        yield c


def _fake(monkeypatch, fake):
    def build(project, session):
        return coder_agent.build_coder(project, session, model=fake, fast_model=fake)

    monkeypatch.setattr(runs, "build_coder", build)


def test_models_endpoint(client):
    body = client.get("/models").json()
    assert body["default"] == settings.model
    assert any(m["is_default_fast"] for m in body["models"])


def test_project_and_session_lifecycle(client, project):
    assert client.get("/projects").json()["projects"][0]["id"] == project.id
    assert client.post("/projects", json={"path": "/nope"}).status_code == 400
    tree = client.get(f"/projects/{project.id}/tree").json()
    assert [n["name"] for n in tree] == ["src", "README.md"]

    created = client.post("/sessions", json={"project_id": project.id, "mode": "trusted"})
    assert created.status_code == 201
    session = created.json()
    assert session["mode"] == "trusted" and session["model"] == settings.model
    assert (
        client.get(f"/projects/{project.id}/sessions").json()["sessions"][0]["id"] == session["id"]
    )
    assert client.patch(f"/sessions/{session['id']}", json={"model": "x/y"}).status_code == 400
    assert client.delete(f"/sessions/{session['id']}").status_code == 204
    assert client.get(f"/sessions/{session['id']}").status_code == 404


def test_streamed_run_with_approval(client, project, monkeypatch):
    _fake(
        monkeypatch,
        scripted(
            _call("write_file", {"file_path": "/hello.txt", "content": "hi"}, "c1"),
            "all done",
        ),
    )
    sid = client.post("/sessions", json={"project_id": project.id}).json()["id"]

    with client.stream("POST", f"/sessions/{sid}/messages", json={"content": "hello"}) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        events = _events(res)
    types = [e["type"] for e in events]
    assert types[0] == "run.started" and types[-1] == "run.finished"
    assert events[-1]["status"] == "awaiting_approval"
    assert [e["seq"] for e in events] == list(range(len(events)))

    transcript = client.get(f"/sessions/{sid}/messages").json()
    assert transcript["session"]["status"] == "awaiting_approval"
    assert transcript["pending_approval"]["requests"][0]["name"] == "write_file"
    assert transcript["messages"][0]["role"] == "user"

    # No new messages while a decision is pending.
    assert client.post(f"/sessions/{sid}/messages", json={"content": "again"}).status_code == 409

    with client.stream(
        "POST",
        f"/sessions/{sid}/decisions",
        json={"decisions": [{"type": "approve"}], "remember": [{"index": 0, "pattern": "*.txt"}]},
    ) as res:
        events = _events(res)
    assert events[-1]["status"] == "completed"
    assert (project.root / "hello.txt").read_text() == "hi"
    rules = client.get(f"/projects/{project.id}/rules").json()["rules"]
    assert rules == [{"tool": "write_file", "pattern": "*.txt"}]

    replay = client.get(f"/sessions/{sid}/events?after=-1")
    assert replay.status_code == 200
    assert "run.finished" in replay.text
