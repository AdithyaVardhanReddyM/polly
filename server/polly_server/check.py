"""`uv run polly-check` — confirm the Token Factory key works and list the
NVIDIA models it can serve. Model ids are case-sensitive and change; trust
this list over any hard-coded one."""

from __future__ import annotations

import sys

import httpx

from polly_server.config import settings


def main() -> None:
    if not settings.nebius_api_key:
        sys.exit("NEBIUS_API_KEY is not set. Copy .env.example to .env and fill it in.")

    res = httpx.get(
        settings.nebius_base_url.rstrip("/") + "/models",
        headers={"Authorization": f"Bearer {settings.nebius_api_key}"},
        timeout=20,
    )
    if res.status_code != 200:
        sys.exit(f"Token Factory returned HTTP {res.status_code}: {res.text[:300]}")

    ids = sorted(m["id"] for m in res.json().get("data", []))
    nvidia = [i for i in ids if "nemotron" in i.lower() or i.lower().startswith("nvidia/")]
    print(f"Key OK — {len(ids)} models available, {len(nvidia)} from NVIDIA:")
    for model_id in nvidia:
        marks = []
        if model_id == settings.model:
            marks.append("default")
        if model_id == settings.fast_model:
            marks.append("fast")
        print(f"  {model_id}" + (f"  ({', '.join(marks)})" if marks else ""))

    for label, configured in (
        ("POLLY_MODEL", settings.model),
        ("POLLY_FAST_MODEL", settings.fast_model),
    ):
        if configured not in ids:
            print(f"\nWarning: {label}={configured} is not in the list above.")


if __name__ == "__main__":
    main()
