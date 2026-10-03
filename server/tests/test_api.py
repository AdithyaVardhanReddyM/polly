from fastapi.testclient import TestClient

from polly_server.agents.catalog import CATALOG
from polly_server.api.app import app

client = TestClient(app)


def test_health_reports_providers():
    body = client.get("/health").json()
    assert body["service"] == "polly-server"
    assert body["model"]["provider"] == "Nebius Token Factory"
    assert {"configured", "id"} <= body["model"].keys()


def test_agents_lists_the_catalog():
    agents = client.get("/agents").json()["agents"]
    assert [a["id"] for a in agents] == [
        a.id for a in CATALOG if a.metadata.get("internal") != "true"
    ]
    assert "change-research" not in {a["id"] for a in agents}
    assert {a["runtime"] for a in agents} <= {"deep", "agent", "graph"}


def test_agent_ids_are_unique():
    ids = [a.id for a in CATALOG]
    assert len(ids) == len(set(ids))


def test_unknown_agent_is_404():
    assert client.get("/agents/nope").status_code == 404


def test_cors_allows_the_desktop_renderer():
    res = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert res.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_every_agent_has_a_distinct_avatar():
    agents = client.get("/agents").json()["agents"]
    assert all(a["avatar"]["seed"] for a in agents)
    looks = {tuple(sorted(a["avatar"].items() - {("seed", a["avatar"]["seed"])})) for a in agents}
    assert len(looks) == len(agents)


def test_integrations_list_and_agent_assignments(composio_account):
    composio_account("gmail")
    body = client.get("/integrations").json()
    assert body["composio"]["configured"] is True
    items = {i["slug"]: i for i in body["items"]}
    assert items["gmail"]["state"] == "connected"
    assert items["slack"]["state"] == "available"
    assert items["hackernews"]["state"] == "ready"
    assert "researcher" in items["hackernews"]["agents"]

    res = client.put("/agents/researcher/integrations", json={"integrations": ["gmail", "nope"]})
    assert res.status_code == 422
    res = client.put("/agents/researcher/integrations", json={"integrations": ["gmail", "slack"]})
    assert res.json()["integrations"] == ["gmail", "slack"]

    from polly_server.integrations import assignments

    # Allowed and connected: Slack is allowed but nobody signed in.
    assert assignments.active("researcher") == ("gmail",)
    assert client.get("/integrations/nope/logo").status_code == 404
    assert client.post("/integrations/hackernews/connect").status_code == 400
