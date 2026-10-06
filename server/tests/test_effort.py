"""Reasoning effort: which models offer it, what each level sends, and how a
conversation keeps its choice."""

import pytest
from fastapi.testclient import TestClient

from polly_server import model_registry
from polly_server.api.app import app
from polly_server.models import chat_model

client = TestClient(app)


def _sent(model: str, effort: str | None = None):
    llm = chat_model(model=model, reasoning_effort=effort)
    return (llm.extra_body or {}).get("reasoning_effort")


@pytest.mark.parametrize(
    ("model", "effort", "sent"),
    [
        # High is the default, and on GLM it means leaving the setting out.
        ("zai-org/GLM-5.3-Flash", None, None),
        ("zai-org/GLM-5.3-Flash", "high", None),
        ("zai-org/GLM-5.3-Flash", "low", "low"),
        # A level the model does not have falls back to the default.
        ("zai-org/GLM-5.3-Flash", "medium", None),
        ("deepseek-ai/DeepSeek-V4-Pro", None, "high"),
        ("deepseek-ai/DeepSeek-V4-Pro", "medium", "medium"),
        ("nvidia/nemotron-3-super-120b-a12b", "low", "low"),
        # Models the setting does nothing for are never sent it.
        ("nvidia/Nemotron-3-Ultra-550b-a55b", "low", None),
    ],
)
def test_each_level_sends_what_the_model_understands(configure, model, effort, sent):
    configure(nebius_api_key="test-key")
    assert _sent(model, effort) == sent


def test_models_list_their_levels():
    body = client.get("/models").json()
    by_id = {m["id"]: m for m in body["models"]}
    assert body["default_effort"] == model_registry.DEFAULT_EFFORT == "high"
    assert by_id["zai-org/GLM-5.3"]["efforts"] == ["low", "high"]
    assert by_id["deepseek-ai/DeepSeek-V4-Pro"]["efforts"] == ["low", "medium", "high"]
    assert by_id["nvidia/Nemotron-3_5-Lightning"]["efforts"] == []


def test_a_conversation_keeps_its_effort():
    made = client.post(
        "/sessions",
        json={"agent_id": "designer", "model": "zai-org/GLM-5.3-Flash", "reasoning_effort": "low"},
    )
    assert made.status_code == 201, made.text
    sid = made.json()["id"]
    assert made.json()["reasoning_effort"] == "low"
    changed = client.patch(f"/sessions/{sid}", json={"reasoning_effort": "high"})
    assert changed.json()["reasoning_effort"] == "high"
    assert client.patch(f"/sessions/{sid}", json={"reasoning_effort": "max"}).status_code == 422
