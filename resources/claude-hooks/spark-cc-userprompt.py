#!/usr/bin/env python3
"""Codara UserPromptSubmit hook for Claude Code.

Original purpose was to inject the user's prompt into CC by reading the
queue file and writing it to stdout (CC appends UserPromptSubmit hook stdout
to the user prompt). But Spark's claude-backend ALSO bracketed-pastes the
prompt via PTY stdin — both paths fired on every turn, causing CC to see the
prompt twice (once as the typed user message, once as a hook attachment).
That double injection produced the visible "user prompt rendered twice
side-by-side" in CC's terminal AND doubled the input-token cost.

Resolution: the bracketed-paste path is the primary injection. This hook
now serves only as a queue-file janitor: it deletes the queue file so the
next turn starts clean. Stdout is intentionally left empty so CC does not
append a duplicate of the prompt as an attachment block.

Design constraints mirror spark-hook.py:
- Python 3.6+ only, stdlib only.
- Resolve SPARK_HOME_DIR / SPARK_USER_DATA_DIR exactly like
  src/main/spark-home.ts; fall back to ~/.Codara, then ~/.Cora, then the legacy ~/.SparkAgent.
- Always exit 0 — a non-zero exit fails the hook and blocks CC.
- Read SPARK_RUN_ID from the env (set by claude-backend on spawn).
"""
from __future__ import annotations

import os
import sys


def _spark_home() -> str:
    """Mirror src/main/spark-home.ts resolution order."""
    override = os.environ.get("CODARA_HOME_DIR") or os.environ.get("SPARK_HOME_DIR") or os.environ.get("SPARK_USER_DATA_DIR")
    if override and override.strip():
        return override
    for name in (".Codara", ".Cora"):
        candidate = os.path.join(os.path.expanduser("~"), name)
        if os.path.isdir(candidate):
            return candidate
    return os.path.join(os.path.expanduser("~"), ".SparkAgent")


def _queue_path() -> str | None:
    run_id = os.environ.get("SPARK_RUN_ID")
    if not run_id or not run_id.strip():
        return None
    return os.path.join(_spark_home(), "queues", f"{run_id.strip()}.queue")


def main() -> int:
    path = _queue_path()
    if not path:
        # No run id — nothing to do.
        return 0

    # Best-effort cleanup so the next turn starts clean. The prompt itself
    # arrives via PTY bracketed-paste; this hook intentionally writes nothing
    # to stdout so CC doesn't see the prompt as a duplicate attachment.
    try:
        os.unlink(path)
    except OSError:
        # File may already be gone (e.g. interruptChat unlinked it to
        # prevent replay after a Stop+undo). Harmless.
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
