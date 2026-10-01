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
    assert [a["id"] for a in agents] == [a.id for a in CATALOG]
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
