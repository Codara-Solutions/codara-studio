#!/usr/bin/env python3
"""Spark Agent Stop hook for Claude Code (Talk mode).

Claude Code invokes this script when a turn ends. The Spark main process is
polling <spark-home>/turns/<SPARK_RUN_ID>.done for this file's appearance; we
write it atomically with an ISO timestamp body so the watcher can act on a
durable filesystem signal rather than scraping the JSONL.

Design constraints mirror spark-hook.py:
- Python 3.6+ only, stdlib only.
- Resolve SPARK_HOME_DIR / SPARK_USER_DATA_DIR exactly like
  src/main/spark-home.ts; fall back to ~/.Cora (or the legacy ~/.SparkAgent when ~/.Cora does not exist yet).
- Atomic-ish writes: write to a tmp sibling then os.replace.
- Always exit 0 — a non-zero exit fails the hook and blocks CC.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone


def _spark_home() -> str:
    """Mirror src/main/spark-home.ts resolution order."""
    override = os.environ.get("CORA_HOME_DIR") or os.environ.get("SPARK_HOME_DIR") or os.environ.get("SPARK_USER_DATA_DIR")
    if override and override.strip():
        return override
    cora = os.path.join(os.path.expanduser("~"), ".Cora")
    if os.path.isdir(cora):
        return cora
    return os.path.join(os.path.expanduser("~"), ".SparkAgent")


def _turn_marker_path() -> str | None:
    run_id = os.environ.get("SPARK_RUN_ID")
    if not run_id or not run_id.strip():
        return None
    return os.path.join(_spark_home(), "turns", f"{run_id.strip()}.done")


def _iso_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _atomic_write(target: str, data: str) -> None:
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
                # fsync isn't available on every fd; best-effort only.
                pass
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main() -> int:
    path = _turn_marker_path()
    if not path:
        # No run id — nothing to signal. Stay silent so we don't fail CC.
        return 0

    try:
        _atomic_write(path, _iso_now())
    except Exception as err:
        sys.stderr.write(f"spark-cc-stop: write failed: {err}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
