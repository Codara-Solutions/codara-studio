"""Select a deterministic 10-instance smoke-test slice from SWE-bench Verified.

Picks 2 shortest-problem instances from each of 5 target repos, sorted by
problem_statement length (ascending) with instance_id as tiebreaker.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INSTANCES_DIR = ROOT / "datasets" / "swe-bench-verified" / "instances"
SLICES_DIR = ROOT / "slices"
OUT_PATH = SLICES_DIR / "swebench-verified-10.json"

TARGET_REPOS = [
    "django/django",
    "sympy/sympy",
    "sphinx-doc/sphinx",
    "matplotlib/matplotlib",
    "scikit-learn/scikit-learn",
]
PER_REPO = 2


def load_instances() -> list[dict]:
    out: list[dict] = []
    for p in sorted(INSTANCES_DIR.glob("*.json")):
        with p.open("r", encoding="utf-8") as f:
            out.append(json.load(f))
    return out


def select(instances: list[dict]) -> list[dict]:
    by_repo: dict[str, list[dict]] = {r: [] for r in TARGET_REPOS}
    for inst in instances:
        repo = inst.get("repo")
        if repo in by_repo:
            by_repo[repo].append(inst)
    picked: list[dict] = []
    for repo in TARGET_REPOS:
        ranked = sorted(
            by_repo[repo],
            key=lambda i: (len(i.get("problem_statement") or ""), i.get("instance_id", "")),
        )
        for inst in ranked[:PER_REPO]:
            picked.append(
                {
                    "instance_id": inst["instance_id"],
                    "repo": inst["repo"],
                    "base_commit": inst["base_commit"],
                    "problem_len": len(inst.get("problem_statement") or ""),
                }
            )
    return picked


def write_slice(rows: list[dict]) -> None:
    SLICES_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "name": "swebench-verified-10",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "instances": rows,
    }
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def print_table(rows: list[dict]) -> None:
    print("| instance_id | repo | base_commit | problem_len |")
    print("| --- | --- | --- | --- |")
    for r in rows:
        print(
            f"| {r['instance_id']} | {r['repo']} | {r['base_commit'][:8]} | {r['problem_len']} |"
        )


def main() -> None:
    instances = load_instances()
    rows = select(instances)
    write_slice(rows)
    print_table(rows)


if __name__ == "__main__":
    main()
