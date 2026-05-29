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

## Long-run / deep-DAG task

`longrun-ledger-library` is the suite's stress task for **long-running, multi-step, parallel** orchestration — the case Spark exists for. It asks the agent to build a 9-module personal-finance ledger library (`money`, `dates`, `categories`, `validate`, `csv` → `transactions` → `budget` → `report` → `index`) whose dependency graph has a wide independent foundation layer (5 modules buildable in parallel) feeding a 3-deep chain. It is scored by 13 deterministic `node -e` gates (6 public, 7 hidden) plus a full end-to-end integration gate through `index` — no LLM judge, so quality is exact and reproducible.

```powershell
$env:SPARK_EVAL_V2_ALLOW_LIVE = "1"
node evals-v2/run-benchmark.cjs --variants spark_sequential,spark_hybrid_parallel --tasks longrun-ledger-library --repetitions 1
node evals-v2/lib/scorecard.cjs evals-v2/results
```

Budget is 2100s; the hybrid variant should finish well under that and show real parallelism on the foundation layer (`maxConcurrentWorkers >= 2`). The gates are self-consistency-checked by `node evals-v2/_selfcheck-ledger.cjs`, which builds a correct reference implementation and runs the **real** gates from `task.json` against it — run it after editing any gate to confirm a correct solution still passes (guards against false-fail gates).

## Manager-context compaction (long-run)

Long runs used to re-send every step's 500-char review summary to the manager on **every** turn (`existingSteps` in `formatCompactRunState`), so the manager prompt grew linearly with run length and crowded out worker reports exactly when a run was longest. The manager now keeps a cheap skeleton (id/index/title/status) for all steps but carries the heavy review summary only for the most recent steps plus any non-terminal (active-frontier) step. `node scripts/check-manager-compaction.cjs` proves the bounding deterministically (≤12 steps: byte-identical to before; 100 steps: ~73% smaller, sub-linear growth) — the right tool because LLM evals can't affordably reach the step depth where the cap engages.

## Result Shape

Every result is `schemaVersion: 2` and includes:

- pass/fail and quality score
- public and hidden gate summaries
- wall-clock duration
- changed files
- retry count, worker count, manager-call count, human interventions
- time-to-first-worker, total worker runtime, estimated critical path, parallel efficiency
- max concurrent workers, parallel launch groups, peer agents, peer mailbox messages
- worker tool calls, preview tool calls, verification round-trips, per-tool histogram
- final Spark/adapter status

### Verification round-trips

`telemetry.workerToolCalls` / `previewToolCalls` / `verificationRoundTrips`
(plus the `toolCallsByName` histogram) count the tool calls workers make,
parsed from `events.jsonl` (`hook.PreToolUse`), with a raw-log fallback. This
is the signal that exposes the verification bottleneck: a worker can write a
deliverable in a handful of edits, then spend most of its wall-clock driving
the live preview one keystroke at a time — each `spark_preview_*` call is a
full MCP round-trip. `verificationRoundTrips` counts the preview calls that
actually drive/inspect the page (click/type/press_key/snapshot/screenshot/
evaluate/wait_for), excluding cheap navigate/list/url. A serial calculator
build that spends 118 round-trips probing the DOM keystroke-by-keystroke is
the canonical "slow verification" failure this metric catches.

NOTE: this metric is populated from `hook.PreToolUse` events, which only fire
in the **interactive desktop app**. The headless eval runner has no renderer
(no `<preview>` tab, and CC runs as a TUI in a PTY whose raw.log is ANSI, not
stream-json), so `workerToolCalls`/`previewToolCalls` read 0 for headless
runs. The headless eval's reliable efficiency signals are wall-clock
(`durationSeconds`, `totalWorkerRuntimeSeconds`, `estimatedCriticalPathSeconds`)
and the parallelism telemetry (`maxConcurrentWorkers`, `parallelEfficiency`,
`timeToFirstWorkerSeconds`). The tool-call metric is for analyzing real
desktop runs (e.g. the calculator run that motivated the preview batch tool).
