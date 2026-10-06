"""What the copilot may suggest, what it never looks at, and which models it uses.

Stored in `<data_dir>/copilot.json`. The desktop app passes the exclusions on
to the native helper, which enforces them before reading anything.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from pydantic import BaseModel, Field

from polly_server.config import DEFAULT_COPILOT_VISION_MODEL
from polly_server.config import settings as app_settings


class ExcludedApp(BaseModel):
    bundle_id: str
    name: str


class HiddenWindow(BaseModel):
    bundle_id: str
    app: str
    title: str


class Muted(BaseModel):
    lens: str
    kind: str


class Suggest(BaseModel):
    hints: bool = True
    chips: bool = True
    todos: bool = True
    writing: bool = True


# Password managers: never read, whatever else the user changes.
DEFAULT_EXCLUDED = [
    ExcludedApp(bundle_id="com.1password.1password", name="1Password"),
    ExcludedApp(bundle_id="com.agilebits.onepassword7", name="1Password 7"),
    ExcludedApp(bundle_id="com.bitwarden.desktop", name="Bitwarden"),
    ExcludedApp(bundle_id="com.apple.keychainaccess", name="Keychain Access"),
    ExcludedApp(bundle_id="com.apple.Passwords", name="Passwords"),
]


class Exclusions(BaseModel):
    apps: list[ExcludedApp] = Field(default_factory=lambda: list(DEFAULT_EXCLUDED))
    domains: list[str] = Field(default_factory=list)


class Recall(BaseModel):
    enabled: bool = True
    days: int = 14


class CopilotSettings(BaseModel):
    suggest: Suggest = Field(default_factory=Suggest)
    exclusions: Exclusions = Field(default_factory=Exclusions)
    hidden_windows: list[HiddenWindow] = Field(default_factory=list)
    muted: list[Muted] = Field(default_factory=list)
    brain_model: str = Field(default_factory=lambda: app_settings.strong_model)
    vision_model: str = DEFAULT_COPILOT_VISION_MODEL
    recall: Recall = Field(default_factory=Recall)

    def is_muted(self, lens: str, kind: str) -> bool:
        return any(m.lens == lens and m.kind == kind for m in self.muted)


_lock = threading.Lock()


def _file():
    return app_settings.data_path() / "copilot.json"


def load() -> CopilotSettings:
    with _lock:
        try:
            return CopilotSettings.model_validate(json.loads(_file().read_text()))
        except (OSError, ValueError):
            return CopilotSettings()


def save(value: CopilotSettings) -> CopilotSettings:
    with _lock:
        path = _file()
        draft = path.with_suffix(".tmp")
        draft.write_text(value.model_dump_json(indent=2))
        draft.replace(path)
    return value


def _merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def update(patch: dict[str, Any]) -> CopilotSettings:
    """Applies a partial change: nested objects merge, lists replace."""
    current = load().model_dump()
    return save(CopilotSettings.model_validate(_merge(current, patch)))


def mute(lens: str, kind: str) -> CopilotSettings:
    current = load()
    if not current.is_muted(lens, kind):
        current.muted.append(Muted(lens=lens, kind=kind))
        save(current)
    return current
