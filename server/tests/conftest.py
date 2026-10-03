"""Every test gets its own data dir, set before `polly_server.config` loads."""

import os
import tempfile

_DATA = tempfile.mkdtemp(prefix="polly-test-")
os.environ["POLLY_DATA_DIR"] = _DATA
os.environ.pop("NEBIUS_API_KEY", None)
os.environ.pop("TAVILY_API_KEY", None)
os.environ.pop("COMPOSIO_API_KEY", None)

import pytest  # noqa: E402
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402


class FakeModel(GenericFakeChatModel):
    """Replays scripted messages and ignores tool binding.

    Streams each scripted message as one chunk, so messages that are only
    tool calls (no text) stream too.
    """

    def bind_tools(self, tools, **kwargs):
        return self

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        from langchain_core.messages import AIMessageChunk
        from langchain_core.outputs import ChatGenerationChunk

        message = (
            self._generate(messages, stop=stop, run_manager=run_manager).generations[0].message
        )
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content=message.content,
                id=message.id,
                additional_kwargs=dict(message.additional_kwargs),
                tool_call_chunks=[
                    {
                        "name": c["name"],
                        "args": __import__("json").dumps(c["args"]),
                        "id": c["id"],
                        "index": i,
                        "type": "tool_call_chunk",
                    }
                    for i, c in enumerate(message.tool_calls)
                ],
            )
        )


def scripted(*messages: AIMessage | str) -> FakeModel:
    return FakeModel(
        messages=iter([m if isinstance(m, AIMessage) else AIMessage(content=m) for m in messages])
    )


@pytest.fixture
def memory_checkpointer():
    from langgraph.checkpoint.memory import MemorySaver

    from polly_server import persistence

    saver = MemorySaver()
    persistence.use(saver)
    yield saver
    persistence.use(None)


@pytest.fixture
def configure():
    """Set fields on the (frozen) settings for one test, and rebuild the tool
    registry so tools that depend on a key come and go with it."""
    from polly_server import tools
    from polly_server.config import settings

    saved: dict[str, object] = {}

    def set_(**fields):
        for name, value in fields.items():
            saved.setdefault(name, getattr(settings, name))
            object.__setattr__(settings, name, value)
        tools.registry.cache_clear()

    yield set_
    for name, value in saved.items():
        object.__setattr__(settings, name, value)
    tools.registry.cache_clear()


@pytest.fixture
def composio_account(configure, monkeypatch):
    """Pretend the user connected accounts through Composio. Proxied calls are
    recorded and answered from `replies`."""
    from types import SimpleNamespace

    from polly_server.integrations import composio, github

    connected: dict[str, composio.Connection] = {}
    calls = SimpleNamespace(seen=[], replies={})

    def proxy(slug, method, url, body=None):
        calls.seen.append((slug, method, url, body))
        return calls.replies.get((method, url), (200, None))

    def connect(slug):
        configure(composio_api_key="test-key")
        connected[slug] = composio.Connection(f"ca_{slug}", slug, "active")
        return calls

    monkeypatch.setattr(composio, "connections", lambda fresh=False: connected)
    monkeypatch.setattr(composio, "proxy", proxy)
    monkeypatch.setattr(composio, "tools_for", lambda toolkits: [])
    github._logins.clear()
    return connect


@pytest.fixture
def project(tmp_path):
    from polly_server import projects

    (tmp_path / "README.md").write_text("# demo\n")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('hi')\n")
    return projects.add(str(tmp_path))
