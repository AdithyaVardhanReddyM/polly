from __future__ import annotations

import argparse
import asyncio
import sys

import uvicorn

from polly_server.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(prog="polly-server")
    commands = parser.add_subparsers(dest="command")
    routines = commands.add_parser("routines", help="list or run routines")
    routine_commands = routines.add_subparsers(dest="action", required=True)
    routine_commands.add_parser("list", help="list routines")
    run = routine_commands.add_parser("run", help="run a routine once and wait for it")
    run.add_argument("routine_id")
    args = parser.parse_args()

    if args.command == "routines":
        sys.exit(asyncio.run(_routines(args.action, getattr(args, "routine_id", ""))))
    uvicorn.run(
        "polly_server.api.app:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


async def _routines(action: str, routine_id: str) -> int:
    """Routines from a terminal, or from the system's own scheduler (cron)."""
    from polly_server import persistence, sessions
    from polly_server.coder.runs import manager
    from polly_server.routines import scheduler, store

    if action == "list":
        for r in store.all_routines():
            state = "on" if r.enabled else "off"
            print(f"{r.id}  [{state}]  {r.name}: {store.describe(r.trigger)}")
        return 0

    routine = store.get(routine_id)
    if routine is None:
        print(f"no routine {routine_id!r}", file=sys.stderr)
        return 2
    await persistence.open_checkpointer()
    try:
        fired = await scheduler.fire(routine, note="run from the terminal")
        if fired.status == "skipped" or fired.session_id is None:
            print(f"not started: {fired.note}", file=sys.stderr)
            return 1
        running = manager.for_session(fired.session_id)
        if running is not None and running.task is not None:
            await running.task
        session = sessions.get(fired.session_id)
        failed = session is not None and session.status == "error"
        store.settle(routine.id, fired.session_id, "error" if failed else "done")
        print(f"session {fired.session_id}: {'failed' if failed else 'done'}")
        if failed and session is not None and session.last_error:
            print(session.last_error, file=sys.stderr)
        return 1 if failed else 0
    finally:
        await persistence.close_checkpointer()


if __name__ == "__main__":
    main()
