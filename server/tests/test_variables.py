"""Variables: settings and secrets for agents, kept out of the chat."""

import asyncio
import stat

import pytest
from deepagents.backends.protocol import ExecuteResponse
from fastapi.testclient import TestClient

from polly_server import sandbox, sessions, variables
from polly_server.api.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean():
    yield
    for v in variables.all_variables():
        variables.delete(v.name)


def test_secret_values_never_leave_the_server():
    res = client.put(
        "/variables/API_TOKEN", json={"value": "tok-123456", "description": "The API token"}
    )
    assert res.status_code == 200 and res.json()["value"] is None and res.json()["is_set"]
    client.put("/variables/SLACK_CHANNEL", json={"value": "#standup", "secret": False})

    listed = {v["name"]: v for v in client.get("/variables").json()["variables"]}
    assert listed["API_TOKEN"]["value"] is None and listed["API_TOKEN"]["secret"]
    assert listed["SLACK_CHANNEL"]["value"] == "#standup"
    assert "tok-123456" not in client.get("/variables").text
    # The file holding them is the user's alone.
    mode = stat.S_IMODE((variables._file()).stat().st_mode)
    assert mode == 0o600


def test_changing_one_field_keeps_the_others():
    variables.put("API_TOKEN", value="tok-123456", description="Token")
    client.put("/variables/API_TOKEN", json={"description": "New words"})
    kept = variables.get("API_TOKEN")
    assert kept.value == "tok-123456" and kept.description == "New words"


def test_names_are_checked():
    assert client.put("/variables/lower", json={"value": "x"}).status_code == 422
    assert client.put("/variables/A", json={"value": "x"}).status_code == 422
    assert client.delete("/variables/NOPE").status_code == 404


def test_a_variable_limited_to_some_agents():
    variables.put("ONLY_A", value="aaaa", agents=["agent-a"])
    variables.put("EVERYONE", value="bbbb")
    variables.put("UNSET")
    assert [v.name for v in variables.usable(["agent-a"])] == ["EVERYONE", "ONLY_A"]
    assert [v.name for v in variables.usable(["agent-b"])] == ["EVERYONE"]
    variables.grant("ONLY_A", "agent-b")
    assert "ONLY_A" in [v.name for v in variables.usable(["agent-b"])]


def test_what_an_agent_is_told():
    variables.put("SLACK_CHANNEL", value="#standup", secret=False, description="Where to post")
    variables.put("API_TOKEN", value="tok-123456")
    with_sandbox = variables.prompt_for("researcher", sandbox=True)
    assert "`SLACK_CHANNEL` = `#standup`: Where to post" in with_sandbox
    assert "`$API_TOKEN`" in with_sandbox and "tok-123456" not in with_sandbox
    # Without a sandbox a secret is no use to the agent: it is not mentioned.
    assert "API_TOKEN" not in variables.prompt_for("researcher", sandbox=False)


def test_secrets_reach_the_sandbox_and_are_blanked_from_its_output():
    variables.put("API_TOKEN", value="tok-'quoted'-123")
    session = sessions.create(None, model="fake", mode="plan", agent_id="researcher")
    seen = []

    class Inner:
        async def aexecute(self, command, timeout=None):
            seen.append(command)
            return ExecuteResponse(output="token is tok-'quoted'-123", exit_code=0)

    box = sandbox.SessionSandbox(session.id)
    box._inner = Inner()
    result = asyncio.run(box._execute("echo $API_TOKEN", None))

    assert seen == ["export API_TOKEN='tok-'\"'\"'quoted'\"'\"'-123'; echo $API_TOKEN"]
    assert result.output == "token is [secret API_TOKEN]" and result.exit_code == 0
