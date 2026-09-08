# Cora harness lab

Work branch: `feat/cora-harness-lab`. Starting product revision: `d7a6bc9e`.
This is an ongoing experiment, not a claim that Cora outperforms every harness.

The objective covers hard one-shot work across the live model catalog, short
prompts, speed and token efficiency, integrated browsing, compaction, durable
memory, skills, and controlled comparisons with other harnesses. The existing
16-task coding suite is one part of that objective. Its historical results do
not prove the broader objective.

## Reproduce a measurement

Start a development Studio instance with a separate home and browser profile
outside the repository. Set `CODARA_HOME_DIR`, `SPARK_HOME_DIR`, and
`SPARK_USER_DATA_DIR` to that same directory, with
`SPARK_SKIP_LEGACY_MIGRATION=1`, `SPARK_NO_SHELL_INTEGRATION=1`, and
`SPARK_ALLOW_MULTI=1`. Keep account credentials outside the repository. Reuse
the existing credential store when testing an existing subscription; duplicate
refresh credentials can diverge. Do not copy browser profiles, personal memory,
automations, or prior conversations into the test instance.

```sh
node cli/cora.cjs bench --home "$HOME/.codara-harness-lab" \
  --task typo-fix,patch-atomic,async-pool --model gpt-5.6-sol \
  --effort high --keep --output /tmp/cora-baseline-sol.json

node cli/cora.cjs bench matrix --home "$HOME/.codara-harness-lab" \
  --models gpt-6-astra,claude-fable-5-1,claude-opus-5,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,claude-sonnet-5 \
  --task typo-fix,patch-atomic,async-pool --repeat 3 --keep \
  --output /tmp/cora-baseline-matrix
```

The matrix discovers provider IDs from the live Studio catalog and validates
model/effort selections. Catalog presence is not proof of successful provider
access. `--models all` includes every catalog entry and can consume substantial
subscription usage. Trials run sequentially to limit local resource contention.
Each model has a separate artifact. The matrix manifest is updated after each
model; an incomplete artifact set is not a completed measurement. Inspect the
actual runner process and Studio run state before recovering interrupted work.

Keep the product build and prompt resources fixed for an entire measurement.
Record the build revision and do not let development hot reload change the
product mid-suite. Run the same matrix after a change with identical tasks,
models, effort, repetition count, and evaluator version. Before/after numbers
are not available until both measurements finish. Keep holdout tasks out of
prompt tuning. Collect repeated trials before claiming reliability.

## What is measured

- Acceptance: terminal completion and every visible, hidden, and protected-file
  check passing. The individual check outcomes are retained in JSON artifacts.
- One-shot acceptance: acceptance on a non-staged task with zero auto-answered
  questions. Staged tasks measure continuation separately.
- Reliability: per-task pass fractions, Wilson 95% intervals, and whether every
  observed repetition passed. A small number of successes is weak evidence.
- Efficiency: wall time and provider tokens. Successful-trial medians exclude
  fast failures. Missing usage is reported, not treated as free execution.
  Cora artifacts retain input, output, cache-read, and cache-write token totals.
  Tokens are not dollar costs or a direct measure of subscription consumption.
- The legacy 0-100 score remains a secondary diagnostic. Passing visible tests
  alone does not establish acceptance; speed cannot repair a failed contract.

Grading executes evaluator-owned CommonJS test source against the workspace.
Agent changes to `test.js` cannot replace the oracle. Explicitly protected files
must match their expected stage byte-for-byte. Hidden source is not written
into the agent workspace. This is protection against accidental or ordinary
test weakening, not a sandbox against a malicious local process. The agent can
execute code under the same operating-system user; stronger adversarial
benchmark isolation needs separate containers or accounts.

The grader and metric modules participate in the comparison hash. Old scores
remain in history, but are not automatically compared with the revised grader.
The LRU task no longer awards points for choosing a particular vendor/model.

## Required work still open

1. Capture the repeated baseline across available model families, including
   provider failures and slow tails. Add harder tasks where the suite saturates.
2. Exercise the integrated Studio browser on stateful workflows, navigation,
   forms, asynchronous UI, stale references, screenshots, and recovery. Verify
   application state, not a textual claim that the task was done.
3. Force real compaction during long tasks; verify preservation of requirements,
   corrections, active operation IDs, unresolved outcomes, and next actions.
4. Test memory recall, stale-memory correction, workspace/profile isolation,
   bounded retrieval, and useful skill reuse. Evaluate any learned skill on
   fresh tasks before promoting it; retain provenance and rollback.
5. Optimize runtime and prompts from observed failures and token traces. Keep
   correctness gates intact and measure each change with controlled ablations.
6. Validate Hermes and add Codex/Claude headless adapters using their actual
   installed CLI interfaces. Compare identical available models where possible;
   otherwise label a comparison as model plus harness, not harness alone.
7. Run holdout/repeated confirmation, inspect real UI behavior, run relevant
   unit/e2e suites and all typechecks, then publish the branch and before/after
   report with limitations. Do not claim universal superiority from this suite.

## Research informing the experiments

[Anthropic's agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
emphasizes outcome grading, transcript inspection, and repeated trials. This
motivates preserving check-level evidence and reporting reliability separately
from a composite score.

[OpenAI's third-party evaluation guidance](https://openai.com/index/trustworthy-third-party-evaluations-foundations/)
describes how harness choices, including compaction, can materially affect
measured capability. This motivates recording the runtime configuration and
holding it fixed across models, then changing one harness component at a time.

## Initial live measurement, September 8

The unmodified product at `d7a6bc9e` ran three Sol/high tasks through the live
Studio app. All three completed without questions. Their retained workspaces
also pass the revised grader. See [the recorded artifact](initial-sol-baseline.json).

| Task | Full acceptance | Wall time | Total provider tokens |
| --- | --- | ---: | ---: |
| typo-fix | pass | 30.5 s | 15,289 |
| patch-atomic | pass | 224.1 s | 58,087 |
| async-pool | pass | 131.2 s | 34,920 |

These are one trial per task, not reliability estimates or before/after gains.
The original legacy score was 99.3/100. It is not comparable to newly graded
scores; the regrade records check outcomes rather than retroactively relabeling
that score. No competitor or product improvement is measured in this artifact.
