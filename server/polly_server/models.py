"""Chat models, served by Nebius Token Factory.

Every agent gets its model from here so that swapping the default — or giving
a subagent the cheaper `fast` model — is a one-line change.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from polly_server.config import settings

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel


def chat_model(tier: Literal["default", "fast"] = "default", **kwargs) -> BaseChatModel:
    """A LangChain chat model pointed at Token Factory. Imported lazily: the
    server starts (and reports its status) without a key."""
    from langchain_nebius import ChatNebius

    if not settings.model_configured:
        raise RuntimeError("NEBIUS_API_KEY is not set; see .env.example")

    return ChatNebius(
        model=settings.fast_model if tier == "fast" else settings.model,
        api_key=settings.nebius_api_key,
        base_url=settings.nebius_base_url,
        **kwargs,
    )
