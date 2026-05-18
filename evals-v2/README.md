# Spark Eval V2

Independent benchmark harness for comparing:

- `claude_single`: one Claude Code worker
- `codex_single`: one Codex worker
- `spark_sequential`: Spark manager with one worker at a time
- `spark_hybrid_parallel`: Spark manager with Claude + Codex parallel implementers and cross-model verifiers

The old `evals/` directory is left intact. V2 records orchestration telemetry that matters for Spark: time to first worker, worker count, manager calls, total worker runtime, estimated critical path, parallel efficiency, max concurrent workers, parallel launch groups, peer agents, and peer mailbox messages.

## Quick Checks

```bash
node evals-v2/run-benchmark.cjs --adapter noop --repetitions 1
node evals-v2/lib/scorecard.cjs evals-v2/results
node evals-v2/lib/judge.cjs evals-v2/results
```

Live adapters intentionally fail closed unless `SPARK_EVAL_V2_ALLOW_LIVE=1` is set. This keeps CI and local typechecks from accidentally launching paid/interactive agent CLIs.

To compare the new peer-worker behavior against a one-worker-at-a-time Spark baseline:

```bash
SPARK_EVAL_V2_ALLOW_LIVE=1 node evals-v2/run-benchmark.cjs --variants spark_sequential,spark_hybrid_parallel --tasks peer-mailbox-analytics-contract --repetitions 1
node evals-v2/lib/scorecard.cjs evals-v2/results
node evals-v2/lib/judge.cjs evals-v2/results
```

PowerShell:

```powershell
$env:SPARK_EVAL_V2_ALLOW_LIVE = "1"
node evals-v2/run-benchmark.cjs --variants spark_sequential,spark_hybrid_parallel --tasks peer-mailbox-analytics-contract --repetitions 1
node evals-v2/lib/scorecard.cjs evals-v2/results
node evals-v2/lib/judge.cjs evals-v2/results
```

`spark_sequential` pins `workerPolicy.maxParallelWorkers=1` and an eval-only sequential manager profile. `spark_hybrid_parallel` pins the default manager profile, allows up to four workers, and surfaces whether parallel peers actually registered and exchanged mailbox messages.

The judge is intentionally strict: hybrid only earns `promote_hybrid` when it matches or beats sequential quality, wins paired speed/quality comparisons, and proves collaboration on peer-contract tasks (`maxConcurrentWorkers >= 2`, `peerAgentCount >= 2`, and at least one peer mailbox message by default).

To run the blank-workspace calculator eval modeled after `C:\Users\Etienne\Documents\workspace\test`:

```powershell
$env:SPARK_EVAL_V2_ALLOW_LIVE = "1"
npm run eval:v2:test-plan
npm run eval:v2:judge -- evals-v2/results
```

## Result Shape

Every result is `schemaVersion: 2` and includes:

- pass/fail and quality score
- public and hidden gate summaries
- wall-clock duration
- changed files
- retry count, worker count, manager-call count, human interventions
- time-to-first-worker, total worker runtime, estimated critical path, parallel efficiency
- max concurrent workers, parallel launch groups, peer agents, peer mailbox messages
- final Spark/adapter status
