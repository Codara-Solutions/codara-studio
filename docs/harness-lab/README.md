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

## Model selection and provider compatibility findings

The first multi-model attempt revealed that direct chat silently coerced Luna
onto the delegated-worker default, Sol. The requested chat model and task hint
said Luna while both launched attempts recorded Sol. That matrix was stopped
and marked invalid; it is not evidence about Luna.

Commit `a0187848` makes direct chat preserve the exact selected catalog ID in
both launch and queued UI labels. Delegated workers still obey the worker
favorites list. The benchmark now checks the launched model and cancels a
mismatched direct trial. The subsequent [model-fidelity probe](model-fidelity-a0187848.json)
passed the small task on Luna, Terra, Sonnet 5, Sol, Opus 5, and Astra.

Fable 5.1 was rejected by the provider because Pi 0.84.4's compatibility client
was older than the required Claude Code client version. Cora then attempted a
Sol fallback, which the new fidelity check rejected. Updating to the published
Pi 0.85.1 runtime resolved that provider rejection: the same task passed on
Fable 5.1 in 14 seconds. See [the live validation artifact](fable-pi-0851.json).
[Pi's release notes](https://github.com/earendil-works/pi/releases/tag/v0.85.1)
also document updated Astra support and GPT-5.6+ prompt-cache request handling.
The published 0.85.1 provider implementation uses compatibility client 2.1.251.
No local spoof of the client version was applied.

This means all seven requested representative model families have completed
one simple live task with their intended model. It does not yet establish
hard-task reliability, speed improvements, or superiority to another harness.
Direct chats now retain the selected model during failure recovery as well.
Transient failures can retry the same runtime; automatic cross-provider
fallback remains available to managed workers and automations. The benchmark
also guards against labeling a different model as the requested one.


## Browser workflow fixture

`cli/bench/browser/ticket-fixture.cjs` serves a local ticket application with
pagination, asynchronous reads, native form controls, a confirmation dialog,
and an injected concurrent owner change. The evaluator checks persisted state,
conflict recovery, exactly one successful write, and untouched neighboring
tickets. The agent cannot read the evaluator through a fixture endpoint.

```sh
CODARA_BROWSER_SMOKE_HOME="$HOME/.codara-harness-lab" \
CODARA_BROWSER_SMOKE_MODEL=gpt-5.6-sol \
CODARA_BROWSER_SMOKE_OUTPUT=/tmp/cora-browser-sol.json \
node scripts/smoke-cora-browser.cjs
```

The runner retains actual tool calls and model IDs from Pi transcripts, rejects
shell/HTTP/evaluation shortcuts, and checks outcomes rather than trusting the
agent's completion message. Batch browser actions are inspected individually.
`smoke-browser-reference.cjs` executes the same workflow deterministically to
check the fixture and browser transport before a paid trial.

This exposed dropped keyboard input when the app lacked OS focus. The keyboard
path now focuses the embedded browser frame and dispatches trusted CDP events.
The isolated Electron regression checks typing, newlines, native Tab navigation,
and dropdown selection while every application window remains hidden. Native
macOS dropdown popups do not reliably respond to these background keystrokes;
`codara_preview_type` selects their exact option value directly and rejects an
unknown or disabled option without clearing the previous selection.


## First browser before/after observation

The same Sol/high prompt and state evaluator passed at both `ab9d2740` and
`0735844e`. The latter fixes false dialog visibility timeouts and swallowed
batch failures, and exposes current form values in smaller rendered snapshots.
No browser task prompt tuning was applied between these trials.

| Metric | Before | After |
| --- | ---: | ---: |
| Full acceptance | pass | pass |
| Wall time | 145.0 s | 104.7 s |
| Total provider tokens | 260,033 | 182,052 |
| Uncached input tokens | 30,166 | 25,903 |
| Cache-read tokens | 227,584 | 154,624 |
| Output tokens | 2,283 | 1,525 |
| Tool calls, including batches and completion | 18 | 15 |
| Reopened-ticket snapshot bytes | 2,836 | 1,926 |

These are **one trial per revision**, with approximately 28% lower wall time and
30% fewer total provider tokens in this pair. They do not establish a stable
average, causal contribution of each fix, or superiority to another harness.
The deterministic snapshot comparison is 32% smaller for the same application
state, while adding the saved field values. The baseline already includes the
keyboard and native dropdown fixes. See the [check outcomes and tool traces](browser-workflow-before-after.json).


## Direct conversation continuity and compaction

The live baseline exposed a missing handoff: direct follow-ups launched cold
with only the newest request. In a three-turn Sonnet probe, Cora acknowledged
settings and a region correction, then could not recover the settings needed
to write the final file. `/compact` also rejected the run because direct chats
have no manager session.

The direct path now carries canonical user/Cora dialogue into follow-ups.
A successful compaction replaces older dialogue with a durable summary while
later corrections continue to be replayed. Compaction can summarize a direct
conversation in a fresh provider session. Follow-ups automatically request that
summary when prior dialogue reaches 48,000 characters; summary failure retains
the original dialogue. Existing epoch checks and additional direct-run guards
prevent cutover over newly arrived user input or active workers.

Live validation so far:

- Sonnet: the original three-turn task passes with manual compaction, an epoch
  advance, exact settings, and no questions.
- Luna: a seven-turn task accumulates more than 48,000 characters of valid-sized
  messages, triggers actual automatic compaction, applies another correction
  afterward, and writes the exact settings. No files, commands, or memory tools
  were used to persist settings before the final request.

The first oversized auto-compaction probe was invalid: the CLI truncated its
initial prompt to 16,000 characters, so the threshold was never reached. The
runner now rejects truncation and accumulates history through multiple turns.
The [recorded checks](context-continuity.json) separate the failure reproduction,
manual-compaction validation, and expanded automatic-compaction validation.
They do not establish arbitrary long-task retention or persistent-memory quality.

```sh
CODARA_CONTEXT_SMOKE_HOME="$HOME/.codara-harness-context-lab" \
CODARA_CONTEXT_SMOKE_MODEL=gpt-5.6-luna \
CODARA_CONTEXT_SMOKE_AUTO=1 \
CODARA_CONTEXT_SMOKE_OUTPUT=/tmp/cora-context-auto.json \
node scripts/smoke-cora-context.cjs
```

## Headless adapter pilots

The Codex and Hermes Sol/high pilots passed the same typo-fix checks, including
model telemetry. These were adapter validation runs that overlapped other lab
work, not isolated speed comparisons. Codex reports actual turn models through
its isolated session log; Claude reports model usage in JSON; Hermes reports a
model in its aggregate usage artifact, which cannot establish every intermediate
request's model. Exact session IDs are required for staged continuations.

Claude Code 2.1.263 could not run with the current CLI account: its JSON result
reported that the organization disabled Claude subscription access for Claude
Code. This is an unavailable competitor, not a model-quality failure or a Cora
win. The first Codex pilot had open stdin and the first Claude pilot had a
variadic-argument parsing error; both are excluded from capability comparisons.

## Background screenshots

Inactive preview tabs can now supply screenshots without selecting their tab.
Temporary CSS attributes let Chromium compose the guest through transparent
ancestors; reference-counted cleanup supports overlapping captures and preserves
React visibility changes. Captures have a bounded wait and release their paint
state on success or error.

The Electron regression verifies distinct pixels from two concurrent background
tabs, fresh content after the OS window is hidden, unchanged tab selection,
restored visibility, and an unfocused/hidden app after capture. Keyboard and
form-state regressions also pass. This is local macOS validation; Windows still
needs a native run.

## Seven-model coding coverage

The frozen `9025530c` run passed all 21 model/task pairs: the interpreter, atomic
JSON patch, and asynchronous pool contracts on all seven requested models at
high effort. Every trial completed without a question and reported its requested
model. The evaluator also verified protected files remained unchanged.

| Model | Accepted one-shots | Median tokens across three tasks |
| --- | ---: | ---: |
| gpt-5.6-luna | 3/3 | 78,543 |
| gpt-5.6-terra | 3/3 | 57,272 |
| claude-sonnet-5 | 3/3 | 93,874 |
| gpt-5.6-sol | 3/3 | 61,074 |
| claude-opus-5 | 3/3 | 44,534 |
| claude-fable-5-1 | 3/3 | 33,423 |
| gpt-6-astra | 3/3 | 51,717 |

Tokens include cached input and are not dollar costs. Context probes, adapter
pilots, builds, and Electron tests overlapped portions of the matrix, so the
[recorded wall times](hard-matrix.json) cannot support an isolated speed ranking.
One trial per contract is a coverage check; these saturated train tasks need
repeated, harder, and holdout validation before broader reliability claims.

## Direct memory, skills, and long tool loops

Direct Cora now receives a compact `codara_remember` tool even when the task
needs no Studio UI tools. Its writes use the calling run's workspace and profile.
Delegated and automation workers retain their existing restrictions. The direct
prompt no longer tells Cora to hand memory curation to a manager that is absent.
Offline checks cover the roster, scoped run identity, existing memory guards,
and a tool-schema size below 1,500 characters.

`scripts/smoke-cora-memory.cjs` passed all six live Luna/high stages on build
`5b0d5400`: save preferences, recall in a fresh conversation, correct a stale
preference while retaining a user-authored line, recall the correction, then
check workspace and profile isolation. Recall stages could use only the memory
already supplied to the new chat, with no reads of files or prior sessions.
The [checks and tool rosters](live-memory-skills.json) record each stage.

`scripts/smoke-cora-skills.cjs` also passed all three Luna/high stages on build
`04c754ff`: discover and apply the relevant project skill, update it on explicit
request, and apply the revision in a fresh chat. The irrelevant skill was neither
read nor changed. This validates existing Pi project-skill discovery and a
user-directed update workflow; it does not add autonomous skill rewriting or
prove that automatic learned revisions improve performance. Both feature probes
are single synthetic sequences, not broad reliability estimates.

Long worker tasks now pause at a completed tool-round boundary when they cross
the configured context threshold. The host waits for Pi to settle, requests
compaction, and resumes the same session. Cancellation and compaction failures
prevent continuation. Worker totals include the summary request's reported usage.
This avoids calling Pi's aborting compact command inside an active tool round.

The pinned Pi 0.85.1 integration test uses a local deterministic model and a
side-effecting tool. It confirms a durable compaction entry, a resumed task, and
one execution of the tool. Unit checks cover repeated compaction, duplicate
settlements, cancellation, summary failure, and usage accounting. This proves
runtime sequencing, not a real model's retention quality.

`scripts/smoke-cora-long-context.cjs` is ready for the live retention check. Start
a dedicated lab app with `CODARA_PI_COMPACT_AT_TOKENS=32768`; the probe reads
eight large evidence batches exactly once and checks original instructions and
all markers after compaction. Live probes retained all evidence and avoided
repeating side effects, but exposed tool-restriction drift in the summaries.
The host now replays the original task contract, path boundaries, and subsequent
steering verbatim after compaction. The final Luna/high trial at `8f523b85` passed every check after three
compactions, with all eight evidence markers and the original approval code
retained and every side effect occurring once. The two earlier strict-audit
failures remain in the [complete revision record](long-tool-context.json).

At the forced 32,768-token threshold, the accepted baseline used 469,517 tokens
and the accepted contract-replay trial used 233,503, a 50.3% reduction including
summary requests and cached input. Run elapsed time rose from 52.2 to 81.9
seconds. These are single synthetic trials; production still defaults to
256,000 tokens, so this is a demonstrated compaction tradeoff rather than a
production-default token or speed improvement. The baseline audit was recomputed
for a macOS `/var` versus `/private/var` path alias, with the original artifact
retained and no model retry or workspace repair.

### Invalidated first crossover

The first sequential Sol/high crossover at `cedf3b8c` was stopped during
round 2. In round 1, Hermes's async-pool session lost track of its assigned
workspace, searched unrelated directories and prior session artifacts, then
read and verified the previous Codex trial's solution. Its own starter file
remained unchanged. This is cross-trial contamination, so the schedule is
excluded from harness rankings, including its apparently successful trials.
The raw suite artifacts and a scoped incident record remain in the dedicated
lab's `measurements/crossover-cedf3b8c` directory. Raw personal search results
are not exported.

The next protocol gives every harness the same explicit workspace path and
instruction to avoid other workspaces, sessions, and benchmark artifacts.
Hermes also receives `--in` and `TERMINAL_CWD`; rival session IDs are retained
for audit. These instructions are not an OS sandbox. A replacement comparison
still needs session auditing before its numbers can be reported as valid.
