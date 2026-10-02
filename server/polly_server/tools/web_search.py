"""Web search, by Tavily."""

from __future__ import annotations

from langchain_core.tools import BaseTool

from polly_server.config import settings


def web_search() -> BaseTool:
    from langchain_tavily import TavilySearch

    tool = TavilySearch(max_results=5, tavily_api_key=settings.tavily_api_key)
    tool.name = "web_search"
    tool.description = (
        "Search the web. Use it for documentation, error messages, library "
        "APIs and anything outside this project. Returns titles, URLs and snippets."
    )
    return tool
