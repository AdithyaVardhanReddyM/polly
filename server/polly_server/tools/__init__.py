"""The pool of tools agents pick from by name (see `AgentSpec.tools`).

Deep Agents provides the file tools, the shell and `task` itself; what lives
here are the integrations: web search, git, and later GitHub, Gmail and the
rest. A tool is only registered when its provider is configured, so a spec
that names it fails loudly (`runtime._pick`) when the key is missing.
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

from polly_server.config import settings

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool


@lru_cache(maxsize=1)
def registry() -> dict[str, BaseTool]:
    tools: dict[str, BaseTool] = {}
    if settings.tavily_api_key:
        from polly_server.tools.web_search import web_search

        tools["web_search"] = web_search()
    from polly_server.tools.git import GIT_TOOLS

    tools.update({t.name: t for t in GIT_TOOLS})
    return tools


def available(names: tuple[str, ...]) -> tuple[str, ...]:
    """The subset of `names` that is registered right now."""
    have = registry()
    return tuple(n for n in names if n in have)
