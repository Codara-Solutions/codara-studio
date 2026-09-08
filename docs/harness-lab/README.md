# Cora harness lab

Work branch: `feat/cora-harness-lab`. Starting product revision: `d7a6bc9e`.
The measured implementation and comparison are complete. See the concise
[results report](RESULTS.md); this is not a claim of universal superiority.

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

## Initial experiment checklist

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


### Reasoning control invalidated the replacement crossover

The replacement `ff5c5329` schedule was also stopped, this time after the first
five three-task suites. Source inspection found that the installed Hermes
fork's top-level `--oneshot` parser accepts `--reasoning high`, but the dispatch
path never passes reasoning or resume to its agent. All six completed Hermes
sessions persisted `reasoning_config: null`; its Codex transport defaults that
case to medium. The schedule cannot establish matched-effort performance and
is excluded from that ranking. Completed suites, scope audits, the stopped
Cora run, and diagnostic history remain under `crossover-ff5c5329` in the lab.

The adapter now uses `hermes chat --quiet --oneshot --query`, which forwards
reasoning and exact-session resume. It reads only the reported session through
`hermes sessions export --session-id`, checks its workspace and persisted effort,
and reports usage increments for continuations. Missing effort or an unsupported
rotated lineage fails the measurement instead of inventing telemetry. The
installed Hermes repository was not modified.

The [live two-turn adapter pilot](hermes-headless-pilot.json) at `0bc9c299`
recorded high effort on both turns, recalled a random marker in the exact same
session, and wrote it with one workspace-local tool call. There were no reads,
searches, or first-turn tool calls. This validates the invocation and accounting;
it is not a latency comparison. The completed corrected crossover is recorded
below and in [the results report](RESULTS.md).

## Expanded project and visual holdouts

`ledger-reconcile` adds a three-file project with strict CSV parsing, revision
conflicts, duplicate handling, void tombstones, arbitrary-precision money,
stable errors, and an import-safe CLI. Its reference implementation passes the
visible and hidden contract checks; targeted defective implementations fail.
It is a holdout, so its failures must not be used to tune the model prompt.
Completed fixed-build coverage and its audited regrade are recorded below.

The canvas fixture presents six randomly ordered stream names with unique
random latency values painted only in a chart. The model must receive a
screenshot before confirming the lowest latency, save exactly once, and reload
the saved choice. The smoke runner checks returned image blocks, permitted
browser tools, exact model telemetry, and persisted state. Unit tests validate
the fixture's outcome checks; completed live coverage is recorded below.

## Manager compaction settlement

Manager sessions now finish their answer before requesting early compaction
through the host. The host waits for summary completion and includes its input,
output, cache, and applicable OpenRouter estimate in the turn totals. Pi's own
completed compaction suppresses an immediate duplicate request. A failed or
unconfirmed summary stops the runtime while preserving the completed answer,
so a later turn can restart from the saved conversation.

The pinned Pi integration test validates one completed manager answer, one
summary, a durable compaction entry, and all reported usage without prompting
the completed answer again. Lifecycle tests cover summary failures and a newer
turn arriving during cleanup. Worker compaction integration still passes and
retains its separate pause-and-resume behavior. These are offline sequencing
checks, not a new live retention or speed result.

## Seven-model browser coverage

The [fixed-build browser matrix](browser-matrix-e1665e3c.json) at `e1665e3c`
passed 13 of 14 strict trials: all seven canvas tasks and six ticket workflows.
Every requested model executed, every persisted application outcome was correct,
and no trial asked for user intervention. All tool arguments were audited for
workspace and browser scope. This is one trial per task/model, not a reliability
estimate or a model speed ranking.

Fable's ticket trial used JavaScript evaluation twice inside preview batches,
despite the task explicitly prohibiting evaluation. Its correct final ticket
state does not override that failure. The original failed result is retained.
A separate code review reproduced a worker-policy gap: an explicitly blocked
preview tool could still execute inside a batch. The policy now preflights all
steps and rejects the entire batch before any earlier mutation. This enforces
structured worker configuration; it does not turn natural-language restrictions
in a direct chat into a hard fence. The batch description also reminds models
that restrictions apply to every step, including read-only evaluation.

All canvas models added keyboard or responsive-layout checks after completing
the requested save and reload. Direct-task UI guidance now scopes that audit to
UI code changes or requested audits; browser operations verify their requested
outcome and finish. Follow-up trials must remain separate from this matrix.

Screenshot results now expose CSS viewport dimensions, image pixel dimensions,
and their scale in both individual and batched calls. The prior Sol visual
pilot needed to recover from a Retina coordinate mismatch. The new metadata is
covered by unit tests and two live Electron browser regressions. Randomized
chart instances prevent treating the pilot and matrix as a matched speed test.

Codex comparisons now require the requested effort in every persisted
`turn_context`, in addition to exact model identity. Missing or mixed values
fail the measurement. Audited sessions from the invalidated second crossover
already recorded high; its invalidity remains the Hermes invocation issue.

### Browser follow-up and remaining instruction failure

At `5dac7ce6`, [three Luna canvas repeats](browser-confirmation-5dac7ce6.json)
all passed and omitted the unsolicited keyboard/responsive audit. They used
105,398, 205,816, and 99,644 tokens (median 105,398), taking 41.0, 73.6, and
45.5 seconds. The earlier Luna matrix trial used 158,012 tokens and 77.7 seconds.
One repeat needed extra visual recovery and a failed placeholder selector.
These randomized instances and unequal sample counts do not establish a causal
speedup or a stable token reduction.

All three Fable ticket repeats still violated the evaluation prohibition, while
passing persisted-state checks. The batch-description reminder was ineffective
on this task; all three are recorded as strict failures. Direct-task system
instructions now state that task restrictions cover batch steps and read-only
verification, with a limitation to report when permitted methods cannot verify.
This remains model guidance rather than a hard natural-language policy parser;
the completed confirmation below retains the failed revisions.

The [direct-instruction confirmation](browser-policy-confirmation-4a4a0539.json)
at `4a4a0539` passed only 1/3 Fable ticket trials. The other two used one
prohibited read-only evaluation each and acknowledged the violation in their
final reports. All three persisted the correct ticket state. The accepted
trial took 95.2 seconds and 249,145 tokens; the failures took 47.0/48.5 seconds
and 244,574/247,078 tokens. This is not a speed gain or a solved instruction
compliance issue. The general instruction is retained, and further prompt
tuning on this fixture stops here. The explicit worker-config batch fence
remains a distinct enforced behavior with a passing regression test.

## Expanded coding matrix and audited regrade

The [21-trial matrix at `4a4a0539`](expanded-matrix-4a4a0539.json) ran
ledger-reconcile, stable-dag, and holdout-lru once on each of seven models at
high effort. Requested model and effort were verified in every exact Pi
session. It ran sequentially with fixed source/build and no overlapping paid
lab calls, builds, or tests. All task files were retained.

The original automated grader reported 20/21 passes. Transcript review found
workspace violations and two missed functional cases. After validating the new
checks against reference implementations and targeted defective variants, all
21 retained solutions were regraded without model retries or workspace edits.
The strengthened functional result is 18/21; strict acceptance including scope
is 15/21. The original records are preserved, not retroactively overwritten.

| Model | Functional checks | Strict audited acceptance |
| --- | ---: | ---: |
| Luna | 3/3 | 3/3 |
| Terra | 3/3 | 3/3 |
| Sonnet | 0/3 | 0/3 |
| Sol | 3/3 | 3/3 |
| Opus | 3/3 | 1/3 |
| Fable | 3/3 | 2/3 |
| Astra | 3/3 | 3/3 |

Sonnet omitted DAG self-dependency validation, corrupted a valid NUL-containing
ledger account, and evicted a live LRU entry while an expired MRU entry remained.
The latter two passed the original grader and now have hidden counterexamples
with reference/defect validation. No problem-specific hints were added to the
user task prompts. Original seed files and task text are unchanged.

Sonnet and Opus used global temporary files on ledger and LRU; Fable did so on
ledger. The common prompt explicitly restricted work to the assigned workspace,
so those trials fail scope even where their code passes. No prior solution reads
were observed. Known leftover scratch files were removed only when their bytes
matched the model's recorded writes; cleanup did not repair any task workspace.

Sol and Astra also disclosed incorrect self-authored boundary assertions and
cited Cora's one-batch verification limit as their reason for not rerunning.
Cora now permits focused repeats to investigate failures or verify corrections,
while discouraging repeats of already-passing checks without relevant changes.
For workspace-restricted tasks, its instructions explicitly keep temporary check
files inside that workspace. These are general workflow changes.

The [targeted Claude ledger development confirmations](workspace-confirmation-e9c710af.json)
at `e9c710af` achieved 2/3 functional passes and 0/3 strict passes. Sonnet repeated
the account-separator defect; Opus and Fable passed the strengthened grader.
All three still used global temporary files, so no reliable scope improvement
was demonstrated. All three investigated and recovered a failed self-authored
check: Sonnet repaired shell quoting, Opus repaired module resolution, and
Fable corrected its own invalid string-sort expectation before running the
remaining assertions. None changed the supplied tests.

These are one development follow-up per model on an already inspected task,
not new blind holdouts or causal performance estimates. Original failures stay
in the record, and further prompt tuning on this fixture stops here.

## Completed corrected CLI crossover

The fixed `e9c710af` app/build completed all 27 sequential Sol/high trials from
05:43:12 to 07:26:14 UTC on September 8. Task order was atomic patch, async pool,
and LRU. Harness order rotated Cora/Codex/Hermes, Codex/Hermes/Cora, then
Hermes/Cora/Codex. No other paid lab calls, builds, or test suites ran alongside
the schedule. Production compaction remained 256,000; fast mode was off.
Only generated benchmark history changed in the primary checkout. Development
drafts were isolated in a separate worktree.

All exact sessions passed scope and persisted Sol/high audits, with zero
questions. Original automated acceptance was Cora 9/9, Codex 9/9, Hermes 8/9.
The installed Hermes fork exhausted three 90-second no-response attempts in
round two's patch trial without writing an implementation. That operational
failure is retained. Three successful Hermes trials also had unmetered timeout
retries: round-one patch and LRU, and round-three patch. Their full elapsed time
is usable; their token totals omit unknown usage and are marked incomplete.
No recorded provider error events were found in the Cora or Codex sessions.
Absence of known usage gaps is not a billing audit.

Trace inspection found a missing oracle case: the task explicitly rejects `-`
outside array add, but the reference accepted object dash paths. Its object
addition also mishandled the valid JSON key `__proto__`. Grader `402c54ca` fixes
the reference and adds a common hidden check, with three targeted defect tests.
Every retained solution was regraded offline with that validated grader.
Task prompts and seeds remained identical, all retained task-file hashes stayed
unchanged, and no model retry or workspace repair occurred. One Codex patch
solution changed from pass to fail. Strengthened strict acceptance is **Cora
9/9, Codex 8/9, Hermes 8/9**. Original checks remain in the artifact and history.

Across the eight identical round/task pairs accepted by Cora and Codex, Cora
used 405,940 versus 957,733 tokens (57.6% fewer) and 1,325.7 versus 1,714.2 seconds
(22.7% less time). Across eight pairs accepted by Cora and Hermes, Cora took
1,344.9 versus 2,337.3 seconds (42.5% less time). The Hermes token comparison
has five successful pairs without known usage gaps: 219,067 versus 356,060
(38.5% fewer). It contains no patch trials. These comparisons condition on joint
success and, for tokens, telemetry availability; they do not erase failures.

The [comparison artifact](crossover-e9c710af.json) contains all 27 outcomes,
original and strengthened checks, session hashes, full-call audit counts,
provider retry evidence, versions, and exact matched cohorts. Codex was 0.153.4.
Hermes was the installed 0.21.0 local fork `30478b6e` with 6,600 carried commits,
not stock upstream. Claude Code remained unavailable, not defeated. Three
repetitions on one machine/model, uncontrolled cache/provider conditions, and
repeated development tasks limit generalization. The two invalidated schedules
above remain excluded from rankings.

## Final validation

At final code revision `402c54ca`, all 241 registry suites passed in 292 seconds,
all three typecheck projects passed, and the six focused benchmark/CLI suites
passed. The last product build passed at `e9c710af`; later changes only touch
benchmark grading, tests, and reports. Both macOS background-capture and trusted
keyboard end-to-end tests passed at `e1665e3c`. Windows native validation remains
unrun. [Validation provenance](validation.json) records log hashes.

The final history adds exactly three targeted Claude suites and nine comparison
suites. Each appended record was checked against its original artifact, and the
previously committed history was preserved byte-for-byte. Dedicated lab apps
and paid runners are stopped; retained workspaces and raw evidence remain in
the separate lab home.
