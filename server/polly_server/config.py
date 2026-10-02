"""Settings, read once from the environment.

The repo-root `.env` is loaded first; real environment variables win over it.
See `.env.example` for every knob.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env", override=False)

NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/"
# Ids are case-sensitive on Token Factory; see `model_registry.MODELS`.
DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"
DEFAULT_FAST_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: Path

    nebius_api_key: str
    nebius_base_url: str
    nebius_project_id: str
    model: str
    fast_model: str

    sandbox_provider: str
    tavily_api_key: str

    @property
    def model_configured(self) -> bool:
        return bool(self.nebius_api_key)

    @property
    def sandbox_configured(self) -> bool:
        if self.sandbox_provider == "contree":
            return bool(self.nebius_api_key and self.nebius_project_id)
        return False

    def data_path(self, *parts: str) -> Path:
        """A path under the data dir, created on first use."""
        path = self.data_dir.joinpath(*parts)
        path.mkdir(parents=True, exist_ok=True)
        return path


def load() -> Settings:
    return Settings(
        host=_env("POLLY_HOST", "127.0.0.1"),
        port=int(_env("POLLY_PORT", "8787")),
        data_dir=Path(_env("POLLY_DATA_DIR", str(REPO_ROOT / ".polly"))),
        nebius_api_key=_env("NEBIUS_API_KEY"),
        nebius_base_url=_env("NEBIUS_BASE_URL", NEBIUS_BASE_URL),
        nebius_project_id=_env("NEBIUS_PROJECT_ID"),
        model=_env("POLLY_MODEL", DEFAULT_MODEL),
        fast_model=_env("POLLY_FAST_MODEL", DEFAULT_FAST_MODEL),
        sandbox_provider=_env("POLLY_SANDBOX", "contree"),
        tavily_api_key=_env("TAVILY_API_KEY"),
    )


settings = load()
