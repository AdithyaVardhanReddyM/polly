from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_openai.chat_models.base import _convert_message_to_dict

from polly_server.models import _nebius_chat_class


def _model():
    return _nebius_chat_class()(model="nvidia/nemotron-3-super-120b-a12b", api_key="x")


def test_streamed_reasoning_is_kept():
    chunk = {
        "id": "chatcmpl-1",
        "model": "nvidia/nemotron-3-super-120b-a12b",
        "choices": [
            {"index": 0, "delta": {"role": "assistant", "content": "", "reasoning_content": "hmm"}}
        ],
    }
    gen = _model()._convert_chunk_to_generation_chunk(chunk, AIMessageChunk, None)
    assert gen is not None
    assert gen.message.additional_kwargs["reasoning_content"] == "hmm"


def test_final_reasoning_is_kept():
    response = {
        "id": "chatcmpl-2",
        "model": "nvidia/nemotron-3-super-120b-a12b",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "42", "reasoning_content": "think"},
            }
        ],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
    }
    result = _model()._create_chat_result(response)
    message = result.generations[0].message
    assert message.content == "42"
    assert message.additional_kwargs["reasoning_content"] == "think"
    assert message.usage_metadata["total_tokens"] == 5


def test_reasoning_goes_back_with_its_assistant_turn():
    # Nemotron loops on the same tool call when it cannot see its earlier reasoning.
    history = [
        HumanMessage("list files"),
        AIMessage(
            content="",
            additional_kwargs={"reasoning_content": "check the root first"},
            tool_calls=[{"name": "ls", "args": {"path": "/"}, "id": "c1"}],
        ),
        ToolMessage("['/src/']", tool_call_id="c1"),
    ]
    payload = _model()._get_request_payload(history)
    assert payload["messages"][1]["reasoning_content"] == "check the root first"
    assert "reasoning_content" not in payload["messages"][0]
    assert "reasoning_content" not in payload["messages"][2]
    # the stock converter alone would drop it
    assert "reasoning_content" not in _convert_message_to_dict(history[1])
