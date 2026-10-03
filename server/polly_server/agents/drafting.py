"""Writing a first version of a custom agent from one sentence.

The builder's "Write it for me": the user says what they want ("a data
analyst that turns CSVs into charts") and a model drafts the name, tagline
and instructions, and says whether the agent needs web search or a sandbox.
The user edits the result; nothing is saved here.
"""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel

DRAFT_PROMPT = """\
You design AI agents for Polly, a workspace where each agent has a name, a \
robot avatar and a job. The user describes an agent they want; you write its \
configuration.

Reply with one JSON object and nothing else:

{
  "name": "1-2 words, a role or a short name (e.g. 'Analyst', 'Trip Planner'). No 'Bot', \
no 'AI', no 'Agent'.",
  "tagline": "What it does, under 8 words, sentence case, no full stop.",
  "description": "One or two plain sentences for the agent's card: what you give it and \
what you get back.",
  "system_prompt": "The agent's instructions, in markdown, written to the agent as 'you'.",
  "search": true or false,
  "sandbox": true or false
}

Writing "system_prompt" (150-350 words):
- Open with one sentence saying who the agent is and what it is for.
- Then how it works: the steps it follows, what a good answer looks like, the format \
and length of its replies, what to ask the user when a request is unclear.
- Be specific to this job. Leave out generic advice ("be helpful", "be accurate").
- Do not describe tools by name, and do not mention Polly, memory or connected apps: \
those are added separately.

"search": true when the job needs current or external information from the web.
"sandbox": true when the job needs running code: data analysis, charts, calculations, \
file conversion, scripts."""


class Draft(BaseModel):
    name: str
    tagline: str = ""
    description: str = ""
    system_prompt: str = ""
    search: bool = True
    sandbox: bool = False


class DraftFailed(RuntimeError):
    pass


def parse(text: str) -> Draft:
    """The JSON object in a model's reply, tolerating a code fence or prose
    around it."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise DraftFailed("the model did not return a draft")
    try:
        data: Any = json.loads(text[start : end + 1], strict=False)
        draft = Draft.model_validate(data)
    except ValueError as exc:
        raise DraftFailed("the model returned a draft Polly could not read") from exc
    name = re.sub(r"\s+", " ", draft.name).strip().strip("\"'")[:40]
    if not name:
        raise DraftFailed("the model returned a draft without a name")
    return draft.model_copy(
        update={
            "name": name,
            "tagline": draft.tagline.strip().rstrip(".")[:80],
            "description": draft.description.strip()[:400],
            "system_prompt": draft.system_prompt.strip(),
        }
    )


async def draft(description: str, *, model: Any = None) -> Draft:
    from langchain_core.messages import HumanMessage, SystemMessage

    from polly_server.models import chat_model

    model = model or chat_model("default")
    reply = await model.ainvoke(
        [SystemMessage(content=DRAFT_PROMPT), HumanMessage(content=description.strip())]
    )
    return parse(reply.text if hasattr(reply, "text") else str(reply.content))
