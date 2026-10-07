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
# Serious reasoning: scoring pull requests, critiquing research drafts.
DEFAULT_STRONG_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b"
# Looks at screenshots: the Designer's critic.
DEFAULT_VISION_MODEL = "zai-org/GLM-5.3-Flash"
# The copilot's eyes: describes the window in front. The fastest vision model
# on Token Factory; the Designer's critic keeps POLLY_VISION_MODEL.
DEFAULT_COPILOT_VISION_MODEL = "Qwen/Qwen3.8-27B"
# Turns text into vectors for knowledge bases and the copilot's recall. The
# only embedding model Token Factory serves.
DEFAULT_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B"


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
    strong_model: str
    vision_model: str
    embedding_model: str

    sandbox_provider: str
    tavily_api_key: str

    # Composio: the accounts a user connects (Gmail, GitHub, Slack…) and the
    # tools agents get from them.
    composio_api_key: str

    # OpenShell (`POLLY_SANDBOX=openshell`): the image sandboxes start from, and
    # the gateway to use; empty is the one the `openshell` CLI has active.
    openshell_image: str = "python:3.12-slim"
    openshell_gateway: str = ""

    @property
    def search_configured(self) -> bool:
        return bool(self.tavily_api_key)

    @property
    def model_configured(self) -> bool:
        return bool(self.nebius_api_key)

    @property
    def sandbox_configured(self) -> bool:
        # ConTree signs in with the Token Factory key and the Nebius project.
        if self.sandbox_provider == "contree":
            return bool(self.nebius_api_key and self.nebius_project_id)
        # OpenShell signs in with the CLI's gateway credentials.
        return self.sandbox_provider == "openshell"

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
        strong_model=_env("POLLY_STRONG_MODEL", DEFAULT_STRONG_MODEL),
        vision_model=_env("POLLY_VISION_MODEL", DEFAULT_VISION_MODEL),
        embedding_model=_env("POLLY_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL),
        sandbox_provider=_env("POLLY_SANDBOX", "contree"),
        tavily_api_key=_env("TAVILY_API_KEY"),
        composio_api_key=_env("COMPOSIO_API_KEY"),
        openshell_image=_env("POLLY_OPENSHELL_IMAGE", "python:3.12-slim"),
        openshell_gateway=_env("POLLY_OPENSHELL_GATEWAY"),
    )


settings = load()
