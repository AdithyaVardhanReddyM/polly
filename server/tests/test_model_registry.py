from dataclasses import replace

import pytest

from polly_server import model_registry, models
from polly_server.config import settings


def test_defaults_are_registered():
    assert model_registry.known(settings.model)
    assert model_registry.known(settings.fast_model)
    assert settings.fast_model == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"


def test_ids_are_unique_and_from_token_factory():
    ids = [m.id for m in model_registry.MODELS]
    assert len(ids) == len(set(ids))
    assert all("/" in i for i in ids)
    assert sum(m.vendor == "NVIDIA" for m in model_registry.MODELS) >= 4


def test_unknown_model_fails_loudly():
    with pytest.raises(LookupError, match="unknown model"):
        model_registry.get("nope/none")


def test_chat_model_needs_a_key(monkeypatch):
    monkeypatch.setattr(models, "settings", replace(settings, nebius_api_key=""))
    with pytest.raises(RuntimeError, match="NEBIUS_API_KEY"):
        models.chat_model()


def test_chat_model_carries_context_window_and_usage(monkeypatch):
    monkeypatch.setattr(models, "settings", replace(settings, nebius_api_key="test-key"))
    model = models.chat_model(model="zai-org/GLM-5.3")
    assert model.model_name == "zai-org/GLM-5.3"
    assert model.profile["max_input_tokens"] == 1_000_000
    assert model.stream_usage is True
    assert str(model.nebius_api_base).startswith("https://api.tokenfactory.nebius.com")
