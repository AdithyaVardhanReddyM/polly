"""How the Designer draws: tools that edit the session's design document and
tell the app what changed, so the canvas follows along as the agent works."""

from __future__ import annotations

import asyncio
import uuid
from typing import Annotated, Any

from langchain.tools import ToolRuntime
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from polly_server import artifacts
from polly_server.config import settings
from polly_server.design import document
from polly_server.design.document import Artboard, DesignDoc, Position
from polly_server.design.prompt import CRITIC_PROMPT

SCREENSHOT_TIMEOUT = 25  # seconds to wait for the app to send a picture

# Screenshots the app owes a running `review_design`, by request id.
_screenshots: dict[str, asyncio.Future[str]] = {}


def deliver_screenshot(request_id: str, data_url: str) -> bool:
    future = _screenshots.get(request_id)
    if future is None or future.done():
        return False
    future.set_result(data_url)
    return True


def _emit(runtime: ToolRuntime, event: dict[str, Any]) -> None:
    writer = getattr(runtime, "stream_writer", None)
    if writer is None:
        return
    try:
        writer(event)
    except Exception:  # noqa: BLE001 - the document is saved either way
        pass


def _changed(
    runtime: ToolRuntime,
    session_id: str,
    doc: DesignDoc,
    board: Artboard,
    action: str,
    focus: list[str] | None = None,
) -> None:
    document.save(session_id, doc)
    _emit(
        runtime,
        {
            "type": "design.artboard",
            "action": action,
            "artboard": board.model_dump(),
            "focus": focus or [],
            "rev": doc.rev,
        },
    )


class NodeUpdate(BaseModel):
    node_id: str = Field(description="The node's data-id.")
    classes: str | None = Field(
        default=None, description="The full new Tailwind class list (replaces the old one)."
    )
    style: dict[str, str | None] | None = Field(
        default=None,
        description="Inline CSS to merge, e.g. {'left': '40px'}. null removes a property.",
    )
    text: str | None = Field(default=None, description="New text, for a node with no children.")
    attributes: dict[str, str | None] | None = Field(
        default=None, description="Other attributes to set (src, alt, href…); null removes."
    )


@tool
def get_design(
    runtime: ToolRuntime,
    artboard_id: Annotated[str | None, "Look inside one artboard; omit for all of them."] = None,
    node_id: Annotated[str | None, "Only this node's subtree."] = None,
) -> str:
    """Read the canvas: the artboards and the tree of nodes on them, with ids.
    Call it before editing a design you did not just write."""
    doc = document.load(artifacts.session_id_of(runtime))
    if not doc.artboards:
        return "The canvas is empty. Create an artboard to start."
    try:
        boards = [doc.artboard(artboard_id)] if artboard_id else doc.artboards
        parts = [document.summary(doc), ""]
        for board in boards:
            parts.append(f"## {board.id} — {board.name}")
            parts.append(document.outline(board, node_id))
            parts.append("")
        return "\n".join(parts).strip()
    except LookupError as why:
        return f"Error: {why}"


@tool
def get_html(
    runtime: ToolRuntime,
    artboard_id: Annotated[str, "The artboard to read."],
    node_id: Annotated[str | None, "Only this node; omit for the whole artboard."] = None,
) -> str:
    """Read the exact HTML of an artboard or one node, to rewrite part of it."""
    doc = document.load(artifacts.session_id_of(runtime))
    try:
        html = document.node_html(doc.artboard(artboard_id), node_id)
    except LookupError as why:
        return f"Error: {why}"
    if len(html) > 30_000:
        return html[:30_000] + "\n… (truncated; read a smaller node)"
    return html or "(empty)"


@tool
def create_artboard(
    runtime: ToolRuntime,
    name: Annotated[str, "What the frame is, e.g. 'Dashboard' or 'Launch poster'."],
    width: Annotated[int, "Width in px (390 phone, 1440 desktop, 1080 square post…)."],
    height: Annotated[int, "Height in px."],
    background: Annotated[str, "CSS colour behind the content."] = "#ffffff",
) -> str:
    """Add an empty artboard to the canvas, placed next to the others. Create
    every artboard you plan to design first, then fill them with write_html."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    width = max(16, min(int(width), 8000))
    height = max(16, min(int(height), 12000))
    x, y = document.place_next(doc, width)
    board = Artboard(
        id=document.new_id("a"),
        name=name.strip() or "Artboard",
        x=x,
        y=y,
        width=width,
        height=height,
        background=background,
    )
    doc.artboards.append(board)
    _changed(runtime, session_id, doc, board, "create")
    return f"Created artboard {board.id} ({width}x{height}). Fill it with write_html."


@tool
def update_artboard(
    runtime: ToolRuntime,
    artboard_id: str,
    name: str | None = None,
    width: int | None = None,
    height: int | None = None,
    background: str | None = None,
) -> str:
    """Rename or resize an artboard, or change its background colour."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    try:
        board = doc.artboard(artboard_id)
    except LookupError as why:
        return f"Error: {why}"
    if name:
        board.name = name.strip()
    if width:
        board.width = max(16, min(int(width), 8000))
    if height:
        board.height = max(16, min(int(height), 12000))
    if background:
        board.background = background
    _changed(runtime, session_id, doc, board, "edit")
    return f"Updated {board.id}: {board.name}, {round(board.width)}x{round(board.height)}."


@tool
def delete_artboard(runtime: ToolRuntime, artboard_id: str) -> str:
    """Remove an artboard and everything on it."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    if not any(b.id == artboard_id for b in doc.artboards):
        return f"Error: no artboard {artboard_id!r}"
    doc.artboards = [b for b in doc.artboards if b.id != artboard_id]
    document.save(session_id, doc)
    _emit(runtime, {"type": "design.removed", "artboard_id": artboard_id, "rev": doc.rev})
    return f"Deleted {artboard_id}."


@tool
def write_html(
    runtime: ToolRuntime,
    artboard_id: Annotated[str, "The artboard to draw on."],
    html: Annotated[str, "An HTML fragment styled with Tailwind classes and inline styles."],
    target_id: Annotated[
        str | None, "A node to write relative to; omit to target the artboard itself."
    ] = None,
    position: Annotated[
        Position,
        "replace_children (default: the fragment becomes the content), append, prepend, "
        "or relative to target_id: replace, before, after.",
    ] = "replace_children",
) -> str:
    """Draw on an artboard by writing HTML. With no target it sets the whole
    artboard; with a target it rewrites or adds to one part and leaves the
    rest alone. Every element gets a data-id you can use afterwards."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    try:
        board = doc.artboard(artboard_id)
        was_empty = not board.html.strip()
        top = document.insert(board, html, target_id, position)
    except LookupError as why:
        return f"Error: {why}"
    whole = target_id is None and position in ("replace", "replace_children")
    _changed(runtime, session_id, doc, board, "write" if whole or was_empty else "edit", top)
    tree = "\n".join(document.outline(board, node, limit=60) for node in top[:8])
    return f"Written to {board.id}. New nodes:\n{tree}"


@tool
def update_nodes(
    runtime: ToolRuntime,
    artboard_id: Annotated[str, "The artboard the nodes are on."],
    updates: Annotated[list[NodeUpdate], "One entry per node to change."],
) -> str:
    """Change existing nodes in place: classes, inline style, text or
    attributes. Cheaper and safer than rewriting HTML for small edits."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    try:
        board = doc.artboard(artboard_id)
    except LookupError as why:
        return f"Error: {why}"
    done: list[str] = []
    problems: list[str] = []
    for item in updates:
        change = item if isinstance(item, NodeUpdate) else NodeUpdate.model_validate(item)
        try:
            document.update(
                board,
                change.node_id,
                classes=change.classes,
                style=change.style,
                text=change.text,
                attributes=change.attributes,
            )
            done.append(change.node_id)
        except (LookupError, ValueError) as why:
            problems.append(str(why))
    if done:
        _changed(runtime, session_id, doc, board, "edit", done)
    report = f"Updated {len(done)} node(s) on {board.id}."
    if problems:
        report += " Problems: " + "; ".join(problems)
    return report


@tool
def delete_nodes(
    runtime: ToolRuntime,
    artboard_id: str,
    node_ids: Annotated[list[str], "data-ids of the nodes to remove."],
) -> str:
    """Remove nodes (and their children) from an artboard."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    try:
        board = doc.artboard(artboard_id)
    except LookupError as why:
        return f"Error: {why}"
    removed = document.delete(board, node_ids)
    if removed:
        _changed(runtime, session_id, doc, board, "edit")
    return f"Removed {removed} of {len(node_ids)} node(s) from {board.id}."


@tool
def set_fonts(
    runtime: ToolRuntime,
    families: Annotated[list[str], "Google Fonts family names, e.g. ['Inter', 'Fraunces']."],
) -> str:
    """Load Google Fonts on the canvas. Then use them with an inline
    `font-family` style or a Tailwind arbitrary value like font-['Fraunces']."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    doc.fonts = document.clean_fonts([*doc.fonts, *families])
    document.save(session_id, doc)
    _emit(runtime, {"type": "design.fonts", "fonts": doc.fonts, "rev": doc.rev})
    return "Fonts loaded: " + ", ".join(doc.fonts)


@tool
async def review_design(
    runtime: ToolRuntime,
    artboard_id: Annotated[str, "The artboard to look at."],
    brief: Annotated[str, "What the design is for, in a sentence, so the critique fits."],
) -> str:
    """Take a screenshot of an artboard and have a design critic look at it.
    Returns concrete problems to fix (overflow, clipped text, weak contrast,
    misalignment). Use it once after finishing a design, then fix what it finds."""
    session_id = artifacts.session_id_of(runtime)
    doc = document.load(session_id)
    try:
        board = doc.artboard(artboard_id)
    except LookupError as why:
        return f"Error: {why}"

    request_id = uuid.uuid4().hex[:12]
    future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    _screenshots[request_id] = future
    _emit(
        runtime,
        {"type": "design.screenshot", "request_id": request_id, "artboard_id": board.id},
    )
    try:
        data_url = await asyncio.wait_for(future, SCREENSHOT_TIMEOUT)
    except TimeoutError:
        return "No screenshot: the canvas is not open in the app. Skip the review."
    finally:
        _screenshots.pop(request_id, None)

    from polly_server.models import chat_model

    try:
        # A reasoning model: its thinking counts against the budget, so leave room.
        critic = chat_model(model=settings.vision_model, max_tokens=6000)
        reply = await critic.ainvoke(
            [
                HumanMessage(
                    content=[
                        {
                            "type": "text",
                            "text": CRITIC_PROMPT.format(
                                brief=brief,
                                name=board.name,
                                width=round(board.width),
                                height=round(board.height),
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ]
                )
            ]
        )
    except Exception as exc:  # noqa: BLE001 - a failed critique must not fail the design
        return f"The critic could not look at it ({type(exc).__name__}: {exc}). Skip the review."
    text = reply.text if isinstance(reply.text, str) else str(reply.content)
    return text.strip() or "The critic returned nothing. Skip the review."


DESIGN_TOOLS = (
    get_design,
    get_html,
    create_artboard,
    update_artboard,
    delete_artboard,
    write_html,
    update_nodes,
    delete_nodes,
    set_fonts,
    review_design,
)
