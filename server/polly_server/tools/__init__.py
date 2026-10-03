"""The pool of tools agents pick from by name (see `AgentSpec.tools`).

Deep Agents provides the file tools, the shell and `task` itself; what lives
here are Polly's own tools: web search, git, reading pull requests, reports
and the design canvas. A tool is only registered when its provider is
configured, so a spec that names it fails loudly (`runtime._pick`) when the
key is missing. The apps a user connects (Gmail, Slack, Linear…) are not in
this pool: they come from Composio, per agent (`integrations/composio.py`).
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
        from polly_server.tools.research import RESEARCH_TOOLS
        from polly_server.tools.web_search import web_search

        tools["web_search"] = web_search()
        tools.update({t.name: t for t in RESEARCH_TOOLS})
    from polly_server.design.tools import DESIGN_TOOLS
    from polly_server.tools.git import GIT_TOOLS
    from polly_server.tools.github import GITHUB_TOOLS
    from polly_server.tools.reports import REPORT_TOOLS

    tools.update({t.name: t for t in GIT_TOOLS})
    # GitHub tools work on public repos without a token, so they are always
    # there; a connected account adds private repos and a higher rate limit.
    tools.update({t.name: t for t in GITHUB_TOOLS})
    tools.update({t.name: t for t in REPORT_TOOLS})
    tools.update({t.name: t for t in DESIGN_TOOLS})
    return tools


def available(names: tuple[str, ...]) -> tuple[str, ...]:
    """The subset of `names` that is registered right now."""
    have = registry()
    return tuple(n for n in names if n in have)
