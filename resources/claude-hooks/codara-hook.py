#!/usr/bin/env python3
"""Codara hook script for Claude Code.

Claude Code invokes this script for each configured hook event (SessionStart,
PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification, PreCompact, ...).
The CLI pipes a single line of JSON to stdin describing the event; we read
that, wrap it with the hook name (passed as argv[1]), an ISO-8601 timestamp,
and the Codara pane id (from $SPARK_PANE_ID, the pty env contract shared with
hook-rpc.ts), then write the wrapper as one JSON object to
<codara-home>/hooks/<uuid>.json so the Codara main process can pick it up via
fs.watch (hook-watcher.ts).

Design constraints:
- Python 3.8+ only (from __future__ import annotations), no third-party deps
  (Claude users may not have pip packages installed).
- Robust to malformed input: if stdin can't be parsed as JSON we still write
  the wrapper (with payload=null and a parse_error field) so Codara sees the
  event landed. We NEVER fail the hook — a non-zero exit from a PreToolUse
  hook is Claude's "deny this tool call" signal, so failure here would block
  the user's session.
- Atomic-ish writes: write to a tmp sibling then rename so the watcher never
  sees a half-written file.
- Resolve CODARA_HOME_DIR / SPARK_HOME_DIR / SPARK_USER_DATA_DIR override
  variables exactly like src/main/spark-home.ts does; otherwise fall back
  through the legacy home directory names.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone


def _codara_home() -> str:
    """Mirror the resolution logic in src/main/spark-home.ts."""
    override = os.environ.get("CODARA_HOME_DIR") or os.environ.get("SPARK_HOME_DIR") or os.environ.get("SPARK_USER_DATA_DIR")
    if override and override.strip():
        return override
    for name in (".Codara", ".Cora"):
        candidate = os.path.join(os.path.expanduser("~"), name)
        if os.path.isdir(candidate):
            return candidate
    return os.path.join(os.path.expanduser("~"), ".SparkAgent")


def _hooks_dir() -> str:
    return os.path.join(_codara_home(), "hooks")


def _iso_now() -> str:
    # ISO 8601 with timezone; matches the new Date().toISOString() format used
    # everywhere else in Codara so the events sort cleanly with other logs.
    # One clock read: deriving seconds and milliseconds from two separate
    # now() calls could pair second N with the milliseconds of second N+1
    # whenever the calls straddle a rollover.
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


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


# Payload size discipline. Claude embeds entire tool results in PostToolUse
# (`tool_response`) and entire prompts in UserPromptSubmit — a single big file
# read produces a 600KB+ hook file that the watcher must read only to discard
# (its hard cap is 256 KiB), and even sub-cap blobs bloat every run's event
# log. Codara only ever consumes small fields (session ids, tool names, short
# previews), so we clamp at the source: long strings get truncated in place,
# and if the payload is still over budget the bulkiest top-level fields are
# replaced with a preview stub. `payloadTrimmed` tells the inspector.
_STRING_CAP = 16_000
_PAYLOAD_BUDGET = 96_000
_FIELD_PREVIEW = 2_000


def _clamp_strings(value, cap):
    if isinstance(value, str):
        if len(value) <= cap:
            return value, False
        return value[:cap] + f"…[trimmed {len(value) - cap} chars]", True
    if isinstance(value, dict):
        trimmed = False
        out = {}
        for key, item in value.items():
            out[key], t = _clamp_strings(item, cap)
            trimmed = trimmed or t
        return out, trimmed
    if isinstance(value, list):
        trimmed = False
        out = []
        for item in value:
            clamped, t = _clamp_strings(item, cap)
            out.append(clamped)
            trimmed = trimmed or t
        return out, trimmed
    return value, False


def _trim_payload(payload):
    """Bound the payload so the wrapper always stays far below the watcher cap."""
    if payload is None:
        return None, False
    clamped, trimmed = _clamp_strings(payload, _STRING_CAP)
    try:
        total = len(json.dumps(clamped, ensure_ascii=False))
    except Exception:
        return None, True
    if total <= _PAYLOAD_BUDGET:
        return clamped, trimmed
    if not isinstance(clamped, dict):
        preview = json.dumps(clamped, ensure_ascii=False)[:_FIELD_PREVIEW]
        return {"trimmed": True, "preview": preview}, True
    # Replace the bulkiest fields with preview stubs until we fit. Track the
    # running total decrementally rather than re-serializing the whole payload
    # per replaced field: the stub is strictly smaller than what it replaces,
    # so the estimate only ever overstates the final size and the loop can
    # never stop early on an undersized guess.
    sized = []
    for key, item in clamped.items():
        try:
            sized.append((len(json.dumps(item, ensure_ascii=False)), key))
        except Exception:
            sized.append((0, key))
    sized.sort(reverse=True)
    out = dict(clamped)
    for size, key in sized:
        if total <= _PAYLOAD_BUDGET:
            break
        stub = {"trimmed": True, "originalBytes": size,
                "preview": json.dumps(out[key], ensure_ascii=False)[:_FIELD_PREVIEW]}
        out[key] = stub
        total += len(json.dumps(stub, ensure_ascii=False)) - size
    return out, True


def main() -> int:
    payload, parse_error = _read_stdin_payload()
    payload, payload_trimmed = _trim_payload(payload)
    wrapper = {
        "hookName": _hook_name(),
        "timestamp": _iso_now(),
        "paneId": os.environ.get("SPARK_PANE_ID") or "",
        "payload": payload,
    }
    if payload_trimmed:
        wrapper["payloadTrimmed"] = True
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
        sys.stderr.write(f"codara-hook: write failed: {err.__class__.__name__}: {err}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
