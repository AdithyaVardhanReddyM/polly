"""Chat models, served by Nebius Token Factory.

Every agent gets its model from here so that swapping the default — or giving
a subagent the cheaper `fast` model — is a one-line change.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from polly_server import model_registry
from polly_server.config import settings

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel


def _nebius_chat_class() -> type:
    """`ChatNebius` plus the reasoning stream Token Factory models emit.

    Built lazily so the server (and its tests) import without langchain-nebius
    doing network-capable setup at import time.
    """
    from langchain_core.messages import AIMessage, AIMessageChunk
    from langchain_nebius import ChatNebius

    class NebiusChat(ChatNebius):
        """ChatNebius that keeps `reasoning_content`, both ways.

        langchain-openai drops provider-specific reasoning fields. Nemotron
        and GLM send their thinking as `reasoning_content`; we keep it in
        `additional_kwargs` so the app can show it, and send it back with
        the assistant turns that produced it. Without its earlier reasoning
        in a tool-calling loop, Nemotron re-derives the same step and
        repeats the same tool call indefinitely.
        """

        def _get_request_payload(self, input_, *, stop=None, **kwargs):
            payload = super()._get_request_payload(input_, stop=stop, **kwargs)
            messages = self._convert_input(input_).to_messages()
            wire = payload.get("messages")
            if isinstance(wire, list) and len(wire) == len(messages):
                for source, out in zip(messages, wire, strict=True):
                    reasoning = getattr(source, "additional_kwargs", {}).get("reasoning_content")
                    if source.type == "ai" and reasoning and out.get("role") == "assistant":
                        out["reasoning_content"] = reasoning
            return payload

        def _convert_chunk_to_generation_chunk(
            self, chunk, default_chunk_class, base_generation_info
        ):
            generation = super()._convert_chunk_to_generation_chunk(
                chunk, default_chunk_class, base_generation_info
            )
            if generation is None:
                return None
            choices = chunk.get("choices") or []
            delta = (choices[0].get("delta") or {}) if choices else {}
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if reasoning and isinstance(generation.message, AIMessageChunk):
                generation.message.additional_kwargs["reasoning_content"] = reasoning
            return generation

        def _create_chat_result(self, response, generation_info=None):
            result = super()._create_chat_result(response, generation_info)
            raw = response if isinstance(response, dict) else response.model_dump(warnings=False)
            for gen, choice in zip(result.generations, raw.get("choices") or [], strict=False):
                message = choice.get("message") or {}
                reasoning = message.get("reasoning_content") or message.get("reasoning")
                if reasoning and isinstance(gen.message, AIMessage):
                    gen.message.additional_kwargs["reasoning_content"] = reasoning
            return result

    return NebiusChat


def tier_model(tier: str) -> str:
    """The configured model id for a tier: Nano for fast calls, Super by
    default, Ultra when the job needs serious reasoning."""
    if tier == "fast":
        return settings.fast_model
    if tier == "strong":
        return settings.strong_model
    return settings.model


def chat_model(
    tier: Literal["default", "fast", "strong"] = "default",
    *,
    model: str | None = None,
    reasoning_effort: model_registry.Effort | None = None,
    **kwargs: Any,
) -> BaseChatModel:
    """A LangChain chat model pointed at Token Factory.

    `model` overrides the tier's configured id (the app lets the user pick
    per session). Imported lazily: the server starts, and reports its
    status, without a key.
    """
    if not settings.model_configured:
        raise RuntimeError("NEBIUS_API_KEY is not set; see .env.example")

    model_id = model or tier_model(tier)
    spec = model_registry.get(model_id)
    options: dict[str, Any] = {
        # Token Factory is OpenAI-compatible; ask for usage in the stream so
        # the app can show tokens as they are spent.
        "stream_usage": True,
        "max_tokens": spec.max_output_tokens,
        # Deep Agents reads this to decide when to compact the conversation.
        "profile": {"max_input_tokens": spec.context_window},
    }
    extra = dict(spec.extra_body)
    # How long a thinking model deliberates before it answers: the session's
    # choice, high by default, sent the way this model understands it.
    level = model_registry.effort_for(spec, reasoning_effort)
    if level and spec.efforts[level]:
        extra["reasoning_effort"] = spec.efforts[level]
    if extra:
        options["extra_body"] = extra
    options.update(kwargs)

    cls = _nebius_chat_class()
    return cls(
        model=spec.id,
        api_key=settings.nebius_api_key,
        base_url=settings.nebius_base_url,
        **options,
    )
