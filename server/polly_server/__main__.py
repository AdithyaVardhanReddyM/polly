from __future__ import annotations

import uvicorn

from polly_server.config import settings


def main() -> None:
    uvicorn.run(
        "polly_server.api.app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
