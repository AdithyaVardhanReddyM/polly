import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from polly_server.agents import runtime
from polly_server.agents.catalog import CATALOG
from polly_server.agents.spec import AgentSpec, SubagentSpec


class FakeModel(GenericFakeChatModel):
    """Answers once and ignores tools: enough to build and run a graph."""

    def bind_tools(self, tools, **kwargs):
        return self


def fake_model() -> FakeModel:
    return FakeModel(messages=iter([AIMessage(content="done")]))


def spec(**overrides) -> AgentSpec:
    base = dict(id="t", name="T", division="custom", tagline="", description="")
    return AgentSpec(**(base | overrides))


def test_agent_runtime_runs():
    agent = runtime.build(spec(runtime="agent"), model=fake_model())
    out = agent.invoke({"messages": [("user", "hi")]})
    assert out["messages"][-1].content == "done"


def test_deep_runtime_builds_with_subagents():
    s = spec(runtime="deep", subagents=(SubagentSpec("helper", "Helps."),))
    agent = runtime.build(s, model=fake_model())
    out = agent.invoke({"messages": [("user", "hi")]})
    assert out["messages"][-1].content == "done"


def test_graph_runtime_uses_the_registered_builder():
    built = object()
    runtime.graph("custom-flow")(lambda **kw: built)
    assert runtime.build(spec(id="custom-flow", runtime="graph"), model=fake_model()) is built


def test_graph_runtime_without_a_graph_fails_loudly():
    with pytest.raises(LookupError):
        runtime.build(spec(id="unregistered", runtime="graph"), model=fake_model())


def test_missing_tools_fail_loudly():
    with pytest.raises(KeyError, match="github"):
        runtime.build(spec(runtime="agent", tools=("github",)), model=fake_model())


def test_long_running_agents_use_deep_agents():
    deep = {a.id for a in CATALOG if a.runtime == "deep"}
    assert {"coder", "deep-research", "operator"} <= deep
