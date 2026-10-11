#!/usr/bin/env python3
"""Codara notify program for Codex.

Codex runs the `notify` argv from ~/.codex/config.toml after every finished
turn, with one extra argument: a JSON object such as
{"type": "agent-turn-complete", "turn-id": ..., "input-messages": [...],
"last-assistant-message": ...}. Codara's installer (codex-notify-installer.ts)
sets notify to

    <python> -c <launcher> <this script> -- <previous notify argv...>

so this script gets `-- <previous argv...> <payload>`. It does two things:

1. Inside a Codara terminal ($SPARK_PANE_ID set), write the event to
   <codara-home>/hooks/<uuid>.json as hookName "CodexNotify", the same
   envelope codara-hook.py writes for Claude, so hook-watcher.ts hands it to
   the terminal-agent notifier.
2. Run the notify program the user had before (if any) with the payload, by
   exec, so it behaves exactly as if Codara were not there.

Never fails: Codex ignores the exit status, but a traceback in its log would
be noise, and the previous program must run whatever happens here.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone

_STRING_CAP = 4_000
_MAX_INPUTS = 8


def _codara_home() -> str:
    """Mirror the resolution logic in src/main/codara-home.ts."""
    override = os.environ.get("CODARA_HOME_DIR") or os.environ.get("SPARK_HOME_DIR") or os.environ.get("SPARK_USER_DATA_DIR")
    if override and override.strip():
        return override
    for name in (".codarastudio", ".Codara", ".Cora"):
        candidate = os.path.join(os.path.expanduser("~"), name)
        if os.path.isdir(candidate):
            return candidate
    return os.path.join(os.path.expanduser("~"), ".SparkAgent")


def _iso_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _clamp(value):
    if isinstance(value, str) and len(value) > _STRING_CAP:
        return value[:_STRING_CAP] + f"…[trimmed {len(value) - _STRING_CAP} chars]"
    return value


def _trim(payload):
    # Only the fields the notifier reads. Input messages can be whole pasted
    # files; the notifier only needs to know whether there was one.
    if not isinstance(payload, dict):
        return None
    out = {}
    for key in ("type", "turn-id", "thread-id", "cwd", "last-assistant-message"):
        if key in payload:
            out[key] = _clamp(payload[key])
    inputs = payload.get("input-messages")
    if isinstance(inputs, list):
        out["input-messages"] = [item[:200] if isinstance(item, str) else item for item in inputs[:_MAX_INPUTS]]
    return out


def _write_event(raw: str) -> None:
    pane_id = os.environ.get("SPARK_PANE_ID")
    if not pane_id:
        return
    try:
        payload = json.loads(raw) if raw else None
    except Exception:
        payload = None
    wrapper = {
        "hookName": "CodexNotify",
        "timestamp": _iso_now(),
        "paneId": pane_id,
        "payload": _trim(payload),
    }
    out_dir = os.path.join(_codara_home(), "hooks")
    os.makedirs(out_dir, exist_ok=True)
    name = f"{uuid.uuid4().hex}.json"
    target = os.path.join(out_dir, name)
    tmp = os.path.join(out_dir, f".{name}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(wrapper, ensure_ascii=False))
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    raw = args[-1] if args else ""
    previous = args[:-1]
    try:
        _write_event(raw)
    except Exception as err:
        sys.stderr.write(f"codara-codex-notify: write failed: {err.__class__.__name__}: {err}\n")
    if previous:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            os.execvp(previous[0], previous + [raw])
        except OSError as err:
            sys.stderr.write(f"codara-codex-notify: could not run {previous[0]}: {err}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
