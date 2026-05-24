#!/usr/bin/env python3
"""Spark Agent hook script for Claude Code.

Claude Code invokes this script for each configured hook event (SessionStart,
PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification, PreCompact, ...).
The CLI pipes a single line of JSON to stdin describing the event; we read
that, wrap it with the hook name (passed as argv[1]), an ISO-8601 timestamp,
and the Spark pane id (from $SPARK_PANE_ID), then write the wrapper as one
JSON object to <spark-home>/hooks/<uuid>.json so the Spark main process can
pick it up via fs.watch.

Design constraints:
- Python 3.6+ only, no third-party deps (Claude users may not have pip
  packages installed).
- Robust to malformed input: if stdin can't be parsed as JSON we still write
  the wrapper (with payload=null and a parse_error field) so Spark sees the
  event landed. We NEVER fail the hook — Claude would surface that as a red
  banner to the user.
- Atomic-ish writes: write to a tmp sibling then rename so the watcher never
  sees a half-written file.
- Resolve SPARK_HOME_DIR / SPARK_USER_DATA_DIR override variables exactly
  like src/main/spark-home.ts does; otherwise fall back to ~/.SparkAgent.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone


def _spark_home() -> str:
    """Mirror the resolution logic in src/main/spark-home.ts."""
    override = os.environ.get("SPARK_HOME_DIR") or os.environ.get("SPARK_USER_DATA_DIR")
    if override and override.strip():
        return override
    return os.path.join(os.path.expanduser("~"), ".SparkAgent")


def _hooks_dir() -> str:
    return os.path.join(_spark_home(), "hooks")


def _iso_now() -> str:
    # ISO 8601 with timezone; matches the new Date().toISOString() format used
    # everywhere else in Spark so the events sort cleanly with other logs.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def _hook_name() -> str:
    # argv[0] is the script path; argv[1] should be the hook name as configured
    # in ~/.claude/settings.json. Default to "unknown" so we still record the
    # event even if the installer/operator forgot the argument.
    if len(sys.argv) > 1 and sys.argv[1]:
        return sys.argv[1]
    return "unknown"


def _read_stdin_payload() -> tuple[object, str | None]:
    """Read one line (or the whole stream) of JSON from stdin.

    Returns (parsed, parse_error). parsed is None if stdin was empty.
    parse_error is None on success or a short reason string on failure.
    """
    try:
        raw = sys.stdin.read()
    except Exception as err:  # OSError, etc.
        return (None, f"stdin_read_failed: {err.__class__.__name__}")

    if not raw or not raw.strip():
        return (None, None)

    try:
        return (json.loads(raw), None)
    except Exception as err:  # json.JSONDecodeError or similar
        return (None, f"invalid_json: {err.__class__.__name__}")


def _atomic_write(target: str, data: str) -> None:
    """Write to a tmp sibling then rename, so the watcher never sees half a file."""
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    tmp = os.path.join(parent, f".{os.path.basename(target)}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                # fsync isn't available on every fd (e.g. some Windows tmp
                # paths). Best-effort only.
                pass
        os.replace(tmp, target)
    except Exception:
        # Best-effort cleanup of the tmp file; never raise from a hook.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main() -> int:
    payload, parse_error = _read_stdin_payload()
    wrapper = {
        "hookName": _hook_name(),
        "timestamp": _iso_now(),
        "paneId": os.environ.get("SPARK_PANE_ID") or "",
        "payload": payload,
    }
    if parse_error is not None:
        wrapper["parseError"] = parse_error

    out_dir = _hooks_dir()
    filename = f"{uuid.uuid4().hex}.json"
    target = os.path.join(out_dir, filename)

    try:
        # ensure_ascii=False so non-ASCII tool names / paths round-trip cleanly.
        _atomic_write(target, json.dumps(wrapper, ensure_ascii=False))
    except Exception as err:
        # Last resort: print to stderr so Claude's hook debug surface shows
        # something. Never fail the hook (exit 0) — a non-zero exit can block
        # the agent.
        sys.stderr.write(f"spark-hook: write failed: {err.__class__.__name__}: {err}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
