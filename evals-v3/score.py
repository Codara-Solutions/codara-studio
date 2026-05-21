#!/usr/bin/env python3
"""Wrap the official SWE-bench harness and produce a normalized score JSON.

Invokes ``python -m swebench.harness.run_evaluation`` as a subprocess, streams
its stdout/stderr live (Docker pulls can take a while), then locates the
harness's report JSON and rewrites it into our own schema.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import threading
from pathlib import Path

def _shquote(s: str) -> str:
    return shlex.quote(s)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run the SWE-bench harness on a predictions file and emit a normalized score JSON."
    )
    p.add_argument("--predictions", required=True, help="Path to predictions JSONL.")
    p.add_argument("--run-id", required=True, help="Run identifier used by the harness for log directories.")
    p.add_argument("--max-workers", type=int, default=4, help="Parallel workers (default: 4).")
    p.add_argument("--timeout", type=int, default=1800, help="Per-instance test timeout in seconds (default: 1800).")
    p.add_argument(
        "--cache-level",
        choices=["none", "base", "env", "instance"],
        default="env",
        help="Harness cache level (default: env).",
    )
    p.add_argument(
        "--dataset",
        default="princeton-nlp/SWE-bench_Verified",
        help="Dataset name or local path (default: princeton-nlp/SWE-bench_Verified).",
    )
    p.add_argument("--output", default=None, help="Output JSON path (default: evals-v3/results/<run-id>/score.json).")
    return p.parse_args()


def load_predictions(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"error: predictions file not found: {path}")
    preds: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                sys.exit(f"error: predictions line {lineno} is not valid JSON: {exc}")
            for field in ("instance_id", "model_name_or_path", "model_patch"):
                if field not in obj:
                    sys.exit(f"error: predictions line {lineno} missing field '{field}'")
            preds.append(obj)
    if not preds:
        sys.exit("error: predictions file contained no records")
    return preds


def _tee(stream, sinks) -> None:
    for line in iter(stream.readline, ""):
        for s in sinks:
            try:
                s.write(line)
                s.flush()
            except Exception:
                pass
    stream.close()


def win_to_wsl(p: str) -> str:
    """Translate a Windows path 'C:\\foo\\bar' to WSL '/mnt/c/foo/bar'."""
    if len(p) >= 2 and p[1] == ":":
        drive = p[0].lower()
        rest = p[2:].replace("\\", "/")
        if rest.startswith("/"):
            rest = rest[1:]
        return f"/mnt/{drive}/{rest}"
    return p.replace("\\", "/")


def run_harness(args, instance_ids: list[str], log_path: Path) -> int:
    use_wsl = sys.platform == "win32"
    if use_wsl:
        preds = win_to_wsl(str(args.predictions))
        wsl_cwd = win_to_wsl(os.getcwd())
        inner = [
            "python3",
            "-m",
            "swebench.harness.run_evaluation",
            "--predictions_path", preds,
            "--run_id", args.run_id,
            "--max_workers", str(args.max_workers),
            "--timeout", str(args.timeout),
            "--cache_level", args.cache_level,
            "--dataset_name", args.dataset,
            "--instance_ids", *instance_ids,
        ]
        cmd = [
            "wsl.exe", "-d", "Ubuntu", "-e", "bash", "-lc",
            f"cd {wsl_cwd} && " + " ".join(_shquote(a) for a in inner),
        ]
    else:
        cmd = [
            sys.executable,
            "-m",
            "swebench.harness.run_evaluation",
            "--predictions_path",
            str(args.predictions),
            "--run_id",
            args.run_id,
            "--max_workers",
            str(args.max_workers),
            "--timeout",
            str(args.timeout),
            "--cache_level",
            args.cache_level,
            "--dataset_name",
            args.dataset,
            "--instance_ids",
            *instance_ids,
        ]
    print(f"[score] invoking harness: {' '.join(cmd)}", flush=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as logfh:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=os.getcwd(),
        )
        t_out = threading.Thread(target=_tee, args=(proc.stdout, [sys.stdout, logfh]), daemon=True)
        t_err = threading.Thread(target=_tee, args=(proc.stderr, [sys.stderr, logfh]), daemon=True)
        t_out.start()
        t_err.start()
        proc.wait()
        t_out.join()
        t_err.join()
    return proc.returncode


def locate_report(model_name: str, run_id: str) -> Path | None:
    candidates = [
        Path.cwd() / f"{model_name}.{run_id}.json",
        Path.cwd() / f"{model_name.replace('/', '__')}.{run_id}.json",
    ]
    for c in candidates:
        if c.exists():
            return c
    # Fall back: any json that matches the run-id suffix in cwd.
    for path in Path.cwd().glob(f"*.{run_id}.json"):
        return path
    return None


def normalize(report: dict, preds: list[dict], run_id: str, report_path: Path, log_path: Path) -> dict:
    resolved = set(report.get("resolved_ids") or [])
    unresolved = set(report.get("unresolved_ids") or [])
    errored = set(report.get("error_ids") or [])
    empty_by_id = {p["instance_id"]: not (p.get("model_patch") or "").strip() for p in preds}
    model_name = preds[0]["model_name_or_path"]

    per_instance: dict[str, dict] = {}
    for pred in preds:
        iid = pred["instance_id"]
        if iid in resolved:
            status = "resolved"
        elif iid in errored:
            status = "errored"
        elif iid in unresolved:
            status = "unresolved"
        else:
            # Not present in any bucket — treat as errored so it's visible.
            status = "errored"
        log_dir = str(Path("logs") / "run_evaluation" / run_id / model_name.replace("/", "__") / iid)
        per_instance[iid] = {
            "status": status,
            "log_dir": log_dir,
            "patch_was_empty": empty_by_id.get(iid, False),
        }

    total = len(preds)
    n_resolved = sum(1 for v in per_instance.values() if v["status"] == "resolved")
    n_unresolved = sum(1 for v in per_instance.values() if v["status"] == "unresolved")
    n_errored = sum(1 for v in per_instance.values() if v["status"] == "errored")
    return {
        "run_id": run_id,
        "total_instances": total,
        "resolved": n_resolved,
        "unresolved": n_unresolved,
        "errored": n_errored,
        "resolved_rate": (n_resolved / total) if total else 0.0,
        "per_instance": per_instance,
        "harness_report_path": str(report_path),
        "harness_log_path": str(log_path),
    }


def print_summary(result: dict) -> None:
    print("\n## SWE-bench scoring summary\n", flush=True)
    print(f"- run_id: `{result['run_id']}`")
    print(f"- total: {result['total_instances']}  resolved: {result['resolved']}  "
          f"unresolved: {result['unresolved']}  errored: {result['errored']}")
    print(f"- resolved_rate: {result['resolved_rate']:.3f}\n")
    print("| instance_id | status | empty_patch |")
    print("| --- | --- | --- |")
    for iid, info in result["per_instance"].items():
        print(f"| {iid} | {info['status']} | {info['patch_was_empty']} |")


def main() -> int:
    args = parse_args()
    preds_path = Path(args.predictions).resolve()
    preds = load_predictions(preds_path)
    instance_ids = [p["instance_id"] for p in preds]
    model_name = preds[0]["model_name_or_path"]

    out_path = Path(args.output) if args.output else (
        Path.cwd() / "evals-v3" / "results" / args.run_id / "score.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = out_path.parent / "harness.log"

    rc = run_harness(args, instance_ids, log_path)
    if rc != 0:
        print(f"[score] harness exited with code {rc}", file=sys.stderr, flush=True)
        return rc

    report_path = locate_report(model_name, args.run_id)
    if report_path is None:
        print("[score] could not locate harness report JSON in cwd", file=sys.stderr, flush=True)
        return 2
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[score] failed to read harness report at {report_path}: {exc}", file=sys.stderr, flush=True)
        return 3

    result = normalize(report, preds, args.run_id, report_path, log_path)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"\n[score] wrote {out_path}", flush=True)
    print_summary(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
