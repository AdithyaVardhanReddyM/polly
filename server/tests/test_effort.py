"""Reasoning effort: which models offer it, what each level sends, and how a
conversation keeps its choice."""

import pytest
from fastapi.testclient import TestClient

from polly_server.api.app import app
from polly_server.models import chat_model

client = TestClient(app)


def _sent(model: str, effort: str | None = None) -> dict:
    llm = chat_model(model=model, reasoning_effort=effort)
    return llm.extra_body or {}


OFF = {"chat_template_kwargs": {"enable_thinking": False}}


@pytest.mark.parametrize(
    ("model", "effort", "sent"),
    [
        # GLM always thinks; it runs at max until told otherwise.
        ("zai-org/GLM-5.3-Flash", None, {"reasoning_effort": "max"}),
        ("zai-org/GLM-5.3-Flash", "low", {"reasoning_effort": "low"}),
        ("zai-org/GLM-5.3-Flash", "high", {"reasoning_effort": "high"}),
        # A level the model does not have falls back to its default.
        ("zai-org/GLM-5.3-Flash", "none", {"reasoning_effort": "max"}),
        ("deepseek-ai/DeepSeek-V4-Pro", None, {"reasoning_effort": "high"}),
        ("deepseek-ai/DeepSeek-V4-Pro", "none", {"reasoning_effort": "none"}),
        ("deepseek-ai/DeepSeek-V4-Pro", "max", {"reasoning_effort": "max"}),
        # Nemotron is switched through its chat template; high sends nothing.
        ("nvidia/nemotron-3-super-120b-a12b", None, {}),
        ("nvidia/nemotron-3-super-120b-a12b", "none", OFF),
        (
            "nvidia/nemotron-3-super-120b-a12b",
            "low",
            {"chat_template_kwargs": {"low_effort": True}},
        ),
        ("nvidia/nemotron-3-super-120b-a12b", "medium", {}),
        (
            "nvidia/Nemotron-3-Ultra-550b-a55b",
            "medium",
            {"chat_template_kwargs": {"medium_effort": True}},
        ),
        ("nvidia/Nemotron-3_5-Lightning", "none", OFF),
        ("nvidia/Nemotron-3_5-Lightning", "low", {}),
        # Kimi has no setting, so it is never sent one.
        ("moonshotai/Kimi-K2.7-Code", "none", {}),
    ],
)
def test_each_level_sends_what_the_model_understands(configure, model, effort, sent):
    configure(nebius_api_key="test-key")
    assert _sent(model, effort) == sent


def test_models_list_their_levels():
    by_id = {m["id"]: m for m in client.get("/models").json()["models"]}
    assert by_id["zai-org/GLM-5.3"]["efforts"] == ["low", "high", "max"]
    assert by_id["zai-org/GLM-5.3"]["default_effort"] == "max"
    assert by_id["deepseek-ai/DeepSeek-V4-Pro"]["efforts"] == ["none", "high", "max"]
    assert by_id["nvidia/nemotron-3-super-120b-a12b"]["efforts"] == ["none", "low", "high"]
    assert by_id["nvidia/Nemotron-3-Ultra-550b-a55b"]["efforts"] == ["none", "medium", "high"]
    assert by_id["nvidia/Nemotron-3_5-Lightning"]["efforts"] == ["none", "high"]
    assert by_id["moonshotai/Kimi-K2.7-Code"]["efforts"] == []
    assert by_id["moonshotai/Kimi-K2.7-Code"]["default_effort"] is None


def test_a_conversation_keeps_its_effort():
    made = client.post(
        "/sessions",
        json={"agent_id": "designer", "model": "zai-org/GLM-5.3-Flash", "reasoning_effort": "low"},
    )
    assert made.status_code == 201, made.text
    sid = made.json()["id"]
    assert made.json()["reasoning_effort"] == "low"
    changed = client.patch(f"/sessions/{sid}", json={"reasoning_effort": "max"})
    assert changed.json()["reasoning_effort"] == "max"
    assert client.patch(f"/sessions/{sid}", json={"reasoning_effort": "xhigh"}).status_code == 422
