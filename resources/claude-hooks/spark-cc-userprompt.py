#!/usr/bin/env python3
"""Spark Agent UserPromptSubmit hook for Claude Code (Talk mode).

Claude Code invokes this script when the user submits a prompt. In Spark's
backend-driven flow, the "user" is the Spark main process — it drops the
prompt for this turn into <spark-home>/queues/<SPARK_RUN_ID>.queue and waits
for CC to ingest it. This hook reads that queue file, prints its contents to
stdout (which is how CC ingests a UserPromptSubmit hook's response — the
stdout becomes the effective user prompt for the turn), and deletes the
queue file so the next turn starts clean.

Design constraints mirror spark-hook.py:
- Python 3.6+ only, stdlib only.
- Resolve SPARK_HOME_DIR / SPARK_USER_DATA_DIR exactly like
  src/main/spark-home.ts; fall back to ~/.SparkAgent.
- Always exit 0 — a non-zero exit fails the hook and blocks CC.
- Read SPARK_RUN_ID from the env (set by claude-backend on spawn).
"""
from __future__ import annotations

import os
import sys


def _spark_home() -> str:
    """Mirror src/main/spark-home.ts resolution order."""
    override = os.environ.get("SPARK_HOME_DIR") or os.environ.get("SPARK_USER_DATA_DIR")
    if override and override.strip():
        return override
    return os.path.join(os.path.expanduser("~"), ".SparkAgent")


def _queue_path() -> str | None:
    run_id = os.environ.get("SPARK_RUN_ID")
    if not run_id or not run_id.strip():
        return None
    return os.path.join(_spark_home(), "queues", f"{run_id.strip()}.queue")


def main() -> int:
    path = _queue_path()
    if not path:
        # No run id — nothing to inject. Stay silent rather than fail the
        # hook; CC will fall back to whatever stdin (none) it had.
        return 0

    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except FileNotFoundError:
        # Queue file not present (e.g. user ran /clear from inside CC and
        # CC dispatched a UserPromptSubmit before Spark wrote one). Print
        # nothing and bow out.
        return 0
    except Exception as err:
        # Surface the failure to CC's stderr for diagnostics but stay exit 0
        # so we don't block the user's prompt.
        sys.stderr.write(f"spark-cc-userprompt: read failed: {err}\n")
        return 0

    # Stdout becomes the effective user prompt for this turn.
    try:
        sys.stdout.write(content)
        sys.stdout.flush()
    except Exception as err:
        sys.stderr.write(f"spark-cc-userprompt: stdout write failed: {err}\n")

    # Best-effort cleanup so the next turn starts clean. A failure here is
    # harmless — Spark will overwrite the queue file on the next turn.
    try:
        os.unlink(path)
    except OSError:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
