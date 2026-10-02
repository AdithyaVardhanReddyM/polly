"""The models Polly offers, all served by Nebius Token Factory.

Ids are case-sensitive and copied from the Token Factory catalog. Context
windows drive context compaction (the agent summarises at 85% of the window)
and the context meter in the app.

Speed and prices are what the Token Factory public endpoints page lists
(tokenfactory.nebius.com/endpoints, read 2026-10-03). Shared endpoints drift,
so treat them as a guide for picking a model, not a guarantee.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from polly_server.config import DEFAULT_FAST_MODEL, DEFAULT_MODEL


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    vendor: str
    context_window: int
    max_output_tokens: int = 16_384
    # The model emits `reasoning_content` alongside its answer.
    reasoning: bool = False
    # Output speed on the shared endpoint, tokens per second.
    tokens_per_second: float | None = None
    # USD per million tokens.
    input_price: float | None = None
    output_price: float | None = None
    # Accepts images as well as text.
    vision: bool = False
    # Extra request options for this model (OpenAI-compatible `extra_body`).
    extra_body: dict[str, Any] = field(default_factory=dict)


MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        "nvidia/nemotron-3-super-120b-a12b",
        "Nemotron 3 Super",
        "NVIDIA",
        256_000,
        tokens_per_second=127,
        input_price=0.30,
        output_price=0.90,
    ),
    ModelSpec(
        "nvidia/Nemotron-3-Ultra-550b-a55b",
        "Nemotron 3 Ultra",
        "NVIDIA",
        1_000_000,
        tokens_per_second=523,
        input_price=1.00,
        output_price=3.00,
    ),
    ModelSpec(
        "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
        "Nemotron 3 Nano",
        "NVIDIA",
        262_000,
        tokens_per_second=60,
        input_price=0.06,
        output_price=0.24,
    ),
    ModelSpec(
        "nvidia/Nemotron-3_5-Lightning",
        "Nemotron 3.5 Lightning",
        "NVIDIA",
        1_000_000,
        tokens_per_second=314,
        input_price=0.06,
        output_price=0.24,
    ),
    ModelSpec(
        "zai-org/GLM-5.3",
        "GLM 5.3",
        "Z.ai",
        1_000_000,
        reasoning=True,
        tokens_per_second=455,
        input_price=1.40,
        output_price=4.40,
    ),
    ModelSpec(
        "zai-org/GLM-5.3-Flash",
        "GLM 5.3 Flash",
        "Z.ai",
        1_000_000,
        reasoning=True,
        tokens_per_second=349,
        input_price=0.15,
        output_price=0.50,
        vision=True,
    ),
    ModelSpec(
        "deepseek-ai/DeepSeek-V4-Pro",
        "DeepSeek V4 Pro",
        "DeepSeek",
        1_000_000,
        tokens_per_second=24,
        input_price=1.75,
        output_price=3.50,
    ),
    ModelSpec(
        "moonshotai/Kimi-K2.7-Code",
        "Kimi K2.7 Code",
        "Moonshot",
        256_000,
        tokens_per_second=231,
        input_price=0.95,
        output_price=4.00,
    ),
)

_BY_ID = {m.id: m for m in MODELS}


def get(model_id: str) -> ModelSpec:
    try:
        return _BY_ID[model_id]
    except KeyError:
        raise LookupError(f"unknown model {model_id!r}; see model_registry.MODELS") from None


def known(model_id: str) -> bool:
    return model_id in _BY_ID


__all__ = ["DEFAULT_FAST_MODEL", "DEFAULT_MODEL", "MODELS", "ModelSpec", "get", "known"]
