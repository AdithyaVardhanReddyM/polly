"""Composio: the accounts a user connects, and the tools agents get from them.

Connecting happens on the Integrations page only. `connect` asks Composio for
a Connect Link, the app opens it in the browser, and the provider's tokens
(or a pasted API key) stay with Composio. Polly never sees them.

Agents then get a Composio session scoped to the toolkits they are allowed
and that are connected. A session hands the model three meta tools (search
tools, get their schemas, execute them), so an agent with Gmail and Linear
does not carry hundreds of tool schemas in its prompt.

Everything belongs to one Composio user: a random id made on first use and
kept in `<data_dir>/composio.json`.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Literal

from polly_server.config import settings
from polly_server.integrations import catalog

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

log = logging.getLogger(__name__)

DASHBOARD = "https://dashboard.composio.dev"
# How long a list of connections is trusted before asking Composio again.
TTL = 15.0

_lock = threading.Lock()


class ComposioError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(settings.composio_api_key)


def user_id() -> str:
    path = settings.data_path() / "composio.json"
    with _lock:
        try:
            return str(json.loads(path.read_text())["user_id"])
        except (OSError, ValueError, KeyError):
            made = f"polly-{uuid.uuid4().hex}"
            path.write_text(json.dumps({"user_id": made}))
            return made


@lru_cache(maxsize=1)
def _client() -> Any:
    from composio import Composio
    from composio_langchain import LangchainProvider

    return Composio(provider=LangchainProvider(), api_key=settings.composio_api_key)


def client() -> Any:
    if not configured():
        raise ComposioError(400, "set COMPOSIO_API_KEY in .env and restart the server")
    return _client()


def _message(exc: Exception) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])[:300]
    return str(exc)[:300]


def _wrap(exc: Exception) -> ComposioError:
    status = getattr(exc, "status_code", None)
    return ComposioError(status if isinstance(status, int) else 502, _message(exc))


# ---------- connections ----------


@dataclass(frozen=True)
class Connection:
    id: str
    slug: str
    status: Literal["active", "expired"]
    connected_at: str | None = None


_connections: dict[str, Connection] = {}
_fetched_at = 0.0


def connections(*, fresh: bool = False) -> dict[str, Connection]:
    """The user's connected accounts by toolkit slug. An active account wins
    over an expired one. On a network failure the last known answer stands."""
    global _connections, _fetched_at
    if not configured():
        return {}
    if not fresh and time.monotonic() - _fetched_at < TTL:
        return _connections
    try:
        page = client().connected_accounts.list(
            user_ids=[user_id()], statuses=["ACTIVE", "EXPIRED"], limit=200
        )
    except Exception as exc:  # noqa: BLE001 - Composio down must not take agents down
        log.warning("could not list Composio connections: %s", _message(exc))
        return _connections
    found: dict[str, Connection] = {}
    for item in page.items:
        slug = item.toolkit.slug
        status = "active" if item.status == "ACTIVE" else "expired"
        if slug in found and (found[slug].status == "active" or status == "expired"):
            continue
        found[slug] = Connection(item.id, slug, status, getattr(item, "created_at", None))
    _connections, _fetched_at = found, time.monotonic()
    return found


def usable() -> frozenset[str]:
    """Toolkits an agent can use right now: connected, or needing no account."""
    if not configured():
        return frozenset()
    active = {slug for slug, c in connections().items() if c.status == "active"}
    return frozenset(active | {i.slug for i in catalog.CATALOG if i.auth == "none"})


def is_connected(slug: str) -> bool:
    connection = connections().get(slug)
    return connection is not None and connection.status == "active"


def callback_url() -> str:
    return f"http://{settings.host}:{settings.port}/integrations/connected"


def _session(toolkits: list[str]) -> Any:
    # Connections are made in the app, never mid-conversation, and agents
    # have their own sandboxes: no connection manager and no workbench.
    return client().sessions.create(
        user_id=user_id(), toolkits=toolkits, manage_connections=False, sandbox={"enable": False}
    )


def connect(slug: str) -> str:
    """Start connecting `slug`; returns the Connect Link to open."""
    item = catalog.get(slug)
    if item is None:
        raise ComposioError(404, f"no integration named {slug!r}")
    if item.auth == "none":
        raise ComposioError(400, f"{item.name} needs no account")
    try:
        request = _session([slug]).authorize(slug, callback_url=callback_url())
    except Exception as exc:  # noqa: BLE001
        error = _wrap(exc)
        if "auth config" in str(error).lower():
            raise ComposioError(
                409,
                f"{item.name} needs your own OAuth app. Create an auth config for it at "
                f"{DASHBOARD}, then connect again.",
            ) from None
        raise error from None
    if not request.redirect_url:
        raise ComposioError(502, "Composio did not return a link to connect")
    return str(request.redirect_url)


def disconnect(slug: str) -> None:
    """Remove every account of `slug`, including sign-ins that were started
    and never finished."""
    try:
        page = client().connected_accounts.list(
            user_ids=[user_id()], toolkit_slugs=[slug], limit=200
        )
        for item in page.items:
            client().connected_accounts.delete(item.id)
    except ComposioError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _wrap(exc) from None
    finally:
        connections(fresh=True)
        _proxy_session.cache_clear()


# ---------- what each app offers ----------

COUNTS_FOR = 24 * 3600


def tool_counts() -> dict[str, int]:
    """How many tools each catalog app has, from Composio. Asked once a day
    and kept on disk; empty when it cannot be fetched."""
    if not configured():
        return {}
    path = settings.data_path("cache") / "toolkits.json"
    try:
        saved = json.loads(path.read_text())
        if time.time() - saved["at"] < COUNTS_FOR:
            return saved["counts"]
    except (OSError, ValueError, KeyError):
        pass
    try:
        page = client().toolkits.list(limit=1000, sort_by="usage")
        counts = {t.slug: int(t.meta.tools_count) for t in page.items if t.slug in catalog.SLUGS}
        for slug in catalog.SLUGS - set(counts):
            counts[slug] = int(client().toolkits.get(slug).meta.tools_count)
    except Exception as exc:  # noqa: BLE001 - a detail on a card; never worth failing for
        log.warning("could not read Composio toolkits: %s", _message(exc))
        return {}
    path.write_text(json.dumps({"at": time.time(), "counts": counts}))
    return counts


# ---------- tools for agents ----------

PROMPT = """
## Connected apps

You can act in the user's connected apps: {names}. Find the right tool with
`COMPOSIO_SEARCH_TOOLS`, read its inputs with `COMPOSIO_GET_TOOL_SCHEMAS` when
they are not obvious, and run it with `COMPOSIO_MULTI_EXECUTE_TOOL`. Reading
is fine at any time. Before anything that sends, posts, pays, deletes or
changes what other people see, say exactly what you are about to do and wait
for the user to agree, unless they already asked for that exact action. If a
tool says an app is not connected, tell the user to connect it on the
Integrations page.
""".strip()

_tools: dict[tuple[str, ...], list[BaseTool]] = {}


def tools_for(toolkits: tuple[str, ...]) -> list[BaseTool]:
    """The session meta tools scoped to `toolkits` (sorted slugs). Empty when
    there is nothing to scope to or Composio cannot be reached."""
    if not toolkits or not configured():
        return []
    if toolkits not in _tools:
        try:
            _tools[toolkits] = list(_session(list(toolkits)).tools())
        except Exception as exc:  # noqa: BLE001 - the agent still runs, without its apps
            log.warning("could not open a Composio session: %s", _message(exc))
            return []
    return _tools[toolkits]


def prompt_for(toolkits: tuple[str, ...]) -> str:
    names = [item.name for slug in toolkits if (item := catalog.get(slug))]
    return PROMPT.format(names=", ".join(names))


# ---------- calling a provider's API as the user ----------


@lru_cache(maxsize=8)
def _proxy_session(slug: str) -> Any:
    return _session([slug])


def proxy(slug: str, method: str, url: str, body: Any = None) -> tuple[int, Any]:
    """Call `url` with the user's `slug` account; Composio adds the
    credentials. Returns the provider's status and parsed body."""
    try:
        reply = _proxy_session(slug).proxy_execute(
            toolkit=slug,
            endpoint=url,
            method=method,  # type: ignore[arg-type]
            body=body,
        )
    except Exception as exc:  # noqa: BLE001
        _proxy_session.cache_clear()
        raise _wrap(exc) from None
    data = reply["data"]
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            pass
    return int(reply["status"]), data
