"""Agents working together: teams, `ask_teammate`, and groups."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from polly_server import sessions
from polly_server.agents import builders, custom, delegation, groups, team
from polly_server.api.app import app
from polly_server.coder.runs import RunManager
from polly_server.integrations import assignments
from polly_server.persistence import get_checkpointer
from tests.conftest import scripted

client = TestClient(app)


def _ask(teammate, message, call_id):
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "ask_teammate",
                "args": {"teammate": teammate, "message": message},
                "id": call_id,
            }
        ],
    )


@pytest.fixture(autouse=True)
def clean():
    yield
    for group in groups.all_groups():
        groups.delete(group.id)
    for agent in custom.all_agents():
        custom.delete(agent.id)
        assignments.clear(agent.id)
        team.clear(agent.id)
    team.set_open(False)


def _make(name, **fields):
    res = client.post("/agents", json={"name": name, "search": False, **fields})
    assert res.status_code == 201, res.text
    return res.json()


def _models(monkeypatch, fakes):
    """Each agent in a run answers from its own script."""
    real = builders.build_agent

    def build(session, as_agent=None, **_):
        fake = fakes[as_agent or session.agent_id]
        return real(session, model=fake, use_cache=False, as_agent=as_agent)

    monkeypatch.setattr(builders, "build_agent", build)


def _send(session, *texts):
    async def go():
        manager = RunManager()
        runs = []
        for text in texts:
            run = await manager.start(None, sessions.get(session.id), text)
            await run.task
            runs.append(run)
        return runs

    return asyncio.run(go())


def _events(run, kind):
    return [e for e in run.events if e["type"] == kind]


def test_a_lead_hands_work_to_a_teammate_and_gets_its_reply(memory_checkpointer, monkeypatch):
    analyst = _make("Analyst", tagline="Turns data into charts")
    lead = _make("Lead", teammates=[analyst["id"]])
    _models(
        monkeypatch,
        {
            lead["id"]: scripted(_ask("Analyst", "Chart the revenue.", "c1"), "Here is the chart."),
            analyst["id"]: scripted("Revenue is up 12%."),
        },
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    (run,) = _send(session, "How is revenue?")

    assert _events(run, "run.finished")[0]["status"] == "completed"
    result = next(e for e in _events(run, "tool.result") if e["call_id"] == "c1")
    assert result["name"] == "ask_teammate" and result["output"] == "Revenue is up 12%."
    # The teammate's reply streams up inside the lead's run, marked with the call.
    passed_up = [e for e in run.events if e.get("via") == "c1"]
    assert {e["teammate"] for e in passed_up} == {analyst["id"]}
    said = [e for e in passed_up if e["type"] == "message.completed"]
    assert said and said[-1]["text"] == "Revenue is up 12%."
    # The lead's own messages are not marked.
    final = [e for e in _events(run, "message.completed") if "via" not in e][-1]
    assert final["agent"] == lead["id"] and final["text"] == "Here is the chart."


def test_a_teammate_remembers_what_it_did_earlier(memory_checkpointer, monkeypatch):
    analyst = _make("Analyst")
    lead = _make("Lead", teammates=[analyst["id"]])
    _models(
        monkeypatch,
        {
            lead["id"]: scripted(
                _ask(analyst["id"], "Chart the revenue.", "c1"),
                "Charted.",
                _ask("analyst", "Now by region.", "c2"),
                "Split by region.",
            ),
            analyst["id"]: scripted("One chart.", "Same chart, by region."),
        },
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    _, second = _send(session, "How is revenue?", "And by region?")

    again = next(e for e in _events(second, "tool.result") if e["call_id"] == "c2")
    assert again["output"] == "Same chart, by region."
    # One thread per teammate and session: the second brief lands after the first.
    thread = delegation.thread_of(session.id, analyst["id"])
    saved = get_checkpointer().get_tuple({"configurable": {"thread_id": thread}})
    kept = [(m.type, m.text) for m in saved.checkpoint["channel_values"]["messages"]]
    assert [kind for kind, _ in kept] == ["human", "ai", "human", "ai"]
    assert "Chart the revenue." in kept[0][1] and "Now by region." in kept[2][1]
    assert kept[1][1] == "One chart."
    # The lead's thread holds the lead's conversation only.
    lead_thread = get_checkpointer().get_tuple({"configurable": {"thread_id": session.id}})
    texts = [m.text for m in lead_thread.checkpoint["channel_values"]["messages"]]
    assert "One chart." in texts and not any("is working with the user" in t for t in texts)


def test_a_teammate_has_no_team_of_its_own(memory_checkpointer, monkeypatch):
    analyst = _make("Analyst")
    writer = _make("Writer", teammates=[analyst["id"]])
    lead = _make("Lead", teammates=[writer["id"]])
    _models(
        monkeypatch,
        {
            lead["id"]: scripted(_ask("Writer", "Write it up.", "c1"), "Done."),
            # On its own the Writer could ask the Analyst; called on, it cannot.
            writer["id"]: scripted(_ask("Analyst", "Numbers?", "w1"), "Written."),
            analyst["id"]: scripted("42"),
        },
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    (run,) = _send(session, "Report please")
    nested = next(e for e in _events(run, "tool.result") if e["call_id"] == "w1")
    assert nested["via"] == "c1" and "not a valid tool" in nested["output"]
    assert (
        next(e for e in _events(run, "tool.result") if e["call_id"] == "c1")["output"] == "Written."
    )


def test_an_unknown_teammate_is_told_who_is_there(memory_checkpointer, monkeypatch):
    analyst = _make("Analyst")
    lead = _make("Lead", teammates=[analyst["id"]])
    _models(monkeypatch, {lead["id"]: scripted(_ask("Nobody", "Hi", "c1"), "Never mind.")})
    session = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    (run,) = _send(session, "Hello")
    output = next(e for e in _events(run, "tool.result") if e["call_id"] == "c1")["output"]
    assert "No teammate called 'Nobody'" in output and "Analyst" in output


def test_teammate_usage_counts_towards_the_session(memory_checkpointer, monkeypatch):
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk

    from tests.conftest import FakeModel

    class Metered(FakeModel):
        def _stream(self, messages, stop=None, run_manager=None, **kwargs):
            usage = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
            yield ChatGenerationChunk(
                message=AIMessageChunk(content=next(self.messages), usage_metadata=usage)
            )

    analyst = _make("Analyst")
    lead = _make("Lead", teammates=[analyst["id"]])
    _models(
        monkeypatch,
        {
            lead["id"]: scripted(_ask("Analyst", "Go.", "c1"), "Done."),
            analyst["id"]: Metered(messages=iter(["Did it."])),
        },
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    (run,) = _send(session, "Hello")
    assert sessions.get(session.id).usage.total_tokens == 15
    # The teammate's prompt size says nothing about how full the lead's context is.
    assert sessions.get(session.id).context_tokens == 0
    assert [e["context_tokens"] for e in _events(run, "usage")] == [0]


# ---------- teams ----------


def test_teams_are_set_listed_and_checked():
    analyst = _make("Analyst")
    lead = _make("Lead", teammates=[analyst["id"], "researcher"])
    assert lead["teammates"] == [analyst["id"], "researcher"] and lead["can_join"]
    assert client.get(f"/agents/{lead['id']}/config").json()["teammates"] == lead["teammates"]

    by_id = {a["id"]: a for a in client.get("/agents").json()["agents"]}
    assert by_id["coder"]["teammates"] == ["deep-research"] and not by_id["coder"]["can_join"]
    assert by_id["researcher"]["can_join"] and not by_id["inbox"]["can_join"]

    # Built-in agents take a team too.
    res = client.put("/agents/coder/teammates", json={"teammates": [analyst["id"]]})
    assert res.status_code == 200 and res.json()["teammates"] == [analyst["id"]]
    assert client.put("/agents/coder/teammates", json={"teammates": ["deep-research"]}).is_success

    for bad in (["coder"], ["nope"], ["inbox"], [lead["id"]]):
        res = client.patch(f"/agents/{lead['id']}", json={"teammates": bad})
        assert res.status_code == 422, bad
    assert client.post("/agents", json={"name": "X", "teammates": ["designer"]}).status_code == 422


def test_a_deleted_agent_leaves_every_team():
    analyst = _make("Analyst")
    lead = _make("Lead", teammates=[analyst["id"], "researcher"])
    assert client.delete(f"/agents/{analyst['id']}").status_code == 204
    assert client.get(f"/agents/{lead['id']}").json()["teammates"] == ["researcher"]


def test_open_collaboration_puts_everyone_on_every_team():
    analyst = _make("Analyst")
    session = sessions.create(None, model="fake", mode="plan", agent_id=analyst["id"])
    assert team.roster(session) == ()
    assert client.put("/collaboration", json={"open": True}).json() == {"open": True}
    assert client.get("/collaboration").json() == {"open": True}
    ids = [m.id for m in team.roster(session)]
    assert {"researcher", "deep-research", "reviewer"} <= set(ids)
    assert not {"coder", "designer", "change-research", analyst["id"]} & set(ids)
    # The agent's own team is still what the user picked.
    assert client.get(f"/agents/{analyst['id']}").json()["teammates"] == []


def test_a_conversation_can_have_its_own_team():
    analyst = _make("Analyst")
    lead = _make("Lead", teammates=["researcher"])
    made = client.post("/sessions", json={"agent_id": lead["id"], "members": [analyst["id"]]})
    assert made.status_code == 201 and made.json()["members"] == [analyst["id"]]
    session = sessions.get(made.json()["id"])
    assert [m.id for m in team.roster(session)] == [analyst["id"]]

    patched = client.patch(f"/sessions/{session.id}", json={"members": []})
    assert patched.json()["members"] == []
    assert team.roster(sessions.get(session.id)) == ()
    assert client.patch(f"/sessions/{session.id}", json={"members": ["coder"]}).status_code == 422

    # Left alone, a conversation follows the agent's team as it changes.
    plain = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    assert [m.id for m in team.roster(plain)] == ["researcher"]
    client.patch(f"/agents/{lead['id']}", json={"teammates": [analyst["id"]]})
    assert [m.id for m in team.roster(plain)] == [analyst["id"]]


def test_addressing_an_agent_brings_it_into_the_conversation(
    memory_checkpointer, monkeypatch, configure
):
    configure(nebius_api_key="test")
    analyst = _make("Analyst")
    lead = _make("Lead")
    _models(
        monkeypatch,
        {
            lead["id"]: scripted(_ask("Analyst", "The user wants a chart.", "c1"), "Done."),
            analyst["id"]: scripted("Chart made."),
        },
    )
    session = client.post("/sessions", json={"agent_id": lead["id"]}).json()
    with client.stream(
        "POST",
        f"/sessions/{session['id']}/messages",
        json={"content": "@Analyst chart this", "mentions": [analyst["id"], "coder", "nope"]},
    ) as res:
        body = "".join(res.iter_text())
    assert res.status_code == 200 and "Chart made." in body
    assert sessions.get(session["id"]).members == [analyst["id"]]
    shown = client.get(f"/sessions/{session['id']}/messages").json()["messages"]
    assert shown[0] == {"role": "user", "id": shown[0]["id"], "text": "@Analyst chart this"}


# ---------- groups ----------


def test_groups_are_made_changed_and_deleted():
    analyst = _make("Analyst")
    writer = _make("Writer")
    body = {"name": " Launch ", "members": [analyst["id"], writer["id"], "researcher"]}
    made = client.post("/groups", json={**body, "lead": writer["id"]})
    assert made.status_code == 201, made.text
    group = made.json()
    assert group["name"] == "Launch" and group["lead"] == writer["id"]
    assert [g["id"] for g in client.get("/groups").json()["groups"]] == [group["id"]]

    for bad in (
        {**body, "lead": "reviewer"},  # the lead is not in the group
        {**body, "members": [analyst["id"]], "lead": analyst["id"]},  # one agent is not a group
        {**body, "members": [analyst["id"], "coder"], "lead": analyst["id"]},
        {**body, "members": [analyst["id"], "nope"], "lead": analyst["id"]},
    ):
        assert client.post("/groups", json=bad).status_code == 422, bad

    session = client.post("/sessions", json={"group_id": group["id"]}).json()
    assert session["agent_id"] == writer["id"] and session["group_id"] == group["id"]
    assert [m.id for m in team.roster(sessions.get(session["id"]))] == [analyst["id"], "researcher"]
    # A group conversation is listed with the group, not with the agent that leads.
    listed = client.get("/sessions", params={"group_id": group["id"]}).json()["sessions"]
    assert [s["id"] for s in listed] == [session["id"]]
    assert client.get("/sessions", params={"agent_id": writer["id"]}).json()["sessions"] == []
    assert client.patch(f"/sessions/{session['id']}", json={"members": []}).status_code == 400

    # A new lead takes new conversations; one already started keeps its own.
    patched = client.patch(f"/groups/{group['id']}", json={"lead": analyst["id"]}).json()
    assert patched["lead"] == analyst["id"]
    assert [m.id for m in team.roster(sessions.get(session["id"]))] == [analyst["id"], "researcher"]
    assert (
        client.post("/sessions", json={"group_id": group["id"]}).json()["agent_id"] == analyst["id"]
    )
    assert client.patch(f"/groups/{group['id']}", json={"lead": "reviewer"}).status_code == 422

    assert client.delete(f"/groups/{group['id']}").status_code == 204
    assert sessions.get(session["id"]) is None and client.get("/groups").json()["groups"] == []
    assert client.get(f"/agents/{writer['id']}").status_code == 200


def test_a_group_lead_is_told_about_its_group(memory_checkpointer, monkeypatch):
    analyst = _make("Analyst", tagline="Turns data into charts")
    lead = _make("Lead")
    group = groups.create("Launch", [lead["id"], analyst["id"]], lead["id"])
    session = sessions.create(
        None, model="fake", mode="plan", agent_id=lead["id"], group_id=group.id
    )
    text = team.prompt(session, team.roster(session))
    assert 'the group "Launch"' in text and "**Analyst**" in text
    assert "Turns data into charts" in text

    _models(
        monkeypatch,
        {
            lead["id"]: scripted(_ask("Analyst", "Chart it.", "c1"), "Here you go."),
            analyst["id"]: scripted("Charted."),
        },
    )
    (run,) = _send(session, "Chart the launch numbers")
    assert (
        next(e for e in _events(run, "tool.result") if e["call_id"] == "c1")["output"] == "Charted."
    )


def test_deleting_an_agent_reshapes_its_groups():
    a, b, c = _make("A"), _make("B"), _make("C")
    trio = groups.create("Trio", [a["id"], b["id"], c["id"]], a["id"])
    duo = groups.create("Duo", [a["id"], b["id"]], b["id"])
    kept = sessions.create(None, model="fake", mode="plan", agent_id=b["id"], group_id=duo.id)
    led = sessions.create(None, model="fake", mode="plan", agent_id=a["id"], group_id=trio.id)

    assert client.delete(f"/agents/{a['id']}").status_code == 204
    trio = groups.get(trio.id)
    assert trio.members == [b["id"], c["id"]] and trio.lead == b["id"]
    # Two agents make a group; one does not.
    assert groups.get(duo.id) is None
    assert sessions.get(kept.id) is None and sessions.get(led.id) is None


@pytest.mark.usefixtures("memory_checkpointer")
def test_the_coder_calls_on_its_teammates(project, monkeypatch):
    from polly_server.coder import agent as coder_agent
    from polly_server.coder import runs

    coder = scripted(_ask("Deep Research", "Is FastAPI 0.115 safe?", "c1"), "It is.")
    monkeypatch.setattr(
        runs,
        "build_coder",
        lambda project, session: coder_agent.build_coder(
            project, session, model=coder, fast_model=coder, use_cache=False
        ),
    )
    _models(monkeypatch, {"deep-research": scripted("Safe: no advisories.")})
    session = sessions.create(project.id, model="fake", mode="plan")

    async def go():
        run = await RunManager().start(project, session, "Upgrade FastAPI")
        await run.task
        return run

    run = asyncio.run(go())
    result = next(e for e in _events(run, "tool.result") if e["call_id"] == "c1")
    assert result["output"] == "Safe: no advisories." and result["status"] == "ok"


def test_two_teammates_asked_in_one_step_work_at_the_same_time(memory_checkpointer, monkeypatch):
    import time

    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk

    from tests.conftest import FakeModel

    spans = {}

    def slow(name):
        class Slow(FakeModel):
            def _stream(self, messages, stop=None, run_manager=None, **kwargs):
                started = time.monotonic()
                time.sleep(0.3)
                spans[name] = (started, time.monotonic())
                yield ChatGenerationChunk(message=AIMessageChunk(content=next(self.messages)))

        return Slow(messages=iter([f"{name} done."]))

    analyst = _make("Analyst")
    writer = _make("Writer")
    lead = _make("Lead", teammates=[analyst["id"], writer["id"]])
    both = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "ask_teammate",
                "args": {"teammate": "Analyst", "message": "Numbers."},
                "id": "c1",
            },
            {
                "name": "ask_teammate",
                "args": {"teammate": "Writer", "message": "Words."},
                "id": "c2",
            },
        ],
    )
    _models(
        monkeypatch,
        {
            lead["id"]: scripted(both, "Both in."),
            analyst["id"]: slow("Analyst"),
            writer["id"]: slow("Writer"),
        },
    )
    session = sessions.create(None, model="fake", mode="plan", agent_id=lead["id"])
    (run,) = _send(session, "Report please")

    results = {e["call_id"]: e["output"] for e in _events(run, "tool.result") if "via" not in e}
    assert results == {"c1": "Analyst done.", "c2": "Writer done."}
    # Each started before the other finished.
    assert spans["Analyst"][0] < spans["Writer"][1] and spans["Writer"][0] < spans["Analyst"][1]
    # And each teammate's events are marked with its own call.
    assert {e["via"]: e["teammate"] for e in run.events if "via" in e} == {
        "c1": analyst["id"],
        "c2": writer["id"],
    }
