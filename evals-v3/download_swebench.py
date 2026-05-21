"""Download SWE-bench Verified to evals-v3/datasets/swe-bench-verified/.

Saves one .json per instance under instances/, plus a manifest.json with the
full list and category counts. The dataset is ~5 MB of metadata (no repo
content — repos are cloned on demand by the SWE-bench harness).
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

from datasets import load_dataset


HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "datasets" / "swe-bench-verified"
INSTANCES_DIR = OUT_DIR / "instances"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    INSTANCES_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading SWE-bench/SWE-bench_Verified test split...", flush=True)
    ds = load_dataset("SWE-bench/SWE-bench_Verified", split="test")
    print(f"  {len(ds)} instances", flush=True)

    repo_counts: Counter[str] = Counter()
    manifest: list[dict[str, str]] = []
    for row in ds:
        instance_id = row["instance_id"]
        repo = row["repo"]
        repo_counts[repo] += 1
        # Persist the full row as JSON so the adapter can read it without
        # the datasets package at runtime.
        path = INSTANCES_DIR / f"{instance_id}.json"
        path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding="utf-8")
        manifest.append({
            "instance_id": instance_id,
            "repo": repo,
            "base_commit": row["base_commit"],
            "version": row.get("version", ""),
        })

    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps({
            "split": "test",
            "count": len(manifest),
            "instances": manifest,
            "by_repo": dict(sorted(repo_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        }, indent=2),
        encoding="utf-8",
    )

    print(f"Wrote {len(manifest)} instance files to {INSTANCES_DIR}", flush=True)
    print(f"Manifest: {manifest_path}", flush=True)
    print("Top repos by instance count:", flush=True)
    for repo, count in repo_counts.most_common(10):
        print(f"  {count:4d}  {repo}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
