# Spark Eval V2

Independent benchmark harness for comparing:

- `claude_single`: one Claude Code worker
- `codex_single`: one Codex worker
- `spark_sequential`: Spark manager with one worker at a time
- `spark_hybrid_parallel`: Spark manager with Claude + Codex parallel implementers and cross-model verifiers

The old `evals/` directory is left intact. V2 records orchestration telemetry that matters for Spark: time to first worker, worker count, manager calls, total worker runtime, estimated critical path, and parallel efficiency.

## Quick Checks

```bash
node evals-v2/run-benchmark.cjs --adapter noop --repetitions 1
node evals-v2/lib/scorecard.cjs evals-v2/results
```

Live adapters intentionally fail closed unless `SPARK_EVAL_V2_ALLOW_LIVE=1` is set. This keeps CI and local typechecks from accidentally launching paid/interactive agent CLIs.

## Result Shape

Every result is `schemaVersion: 2` and includes:

- pass/fail and quality score
- public and hidden gate summaries
- wall-clock duration
- changed files
- retry count, worker count, manager-call count, human interventions
- time-to-first-worker, total worker runtime, estimated critical path, parallel efficiency
- final Spark/adapter status

