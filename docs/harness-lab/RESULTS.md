# Cora harness lab results

Branch: `feat/cora-harness-lab`. Baseline: `d7a6bc9e`.

Cora now preserves the selected model and direct-chat history, supports scoped
memory in direct chats, compacts long worker sessions with the original task
contract, and handles background browser input and screenshots more reliably.
The lab also exposes remaining instruction-following failures. These results do
not establish that Cora is the best harness for every model or task.

## Measured before and after

| Probe | Before | After | Interpretation |
| --- | --- | --- | --- |
| Sol browser workflow | 145.0 s; 260,033 tokens | 104.7 s; 182,052 tokens | Both passed. One pair: 28% less time, 30% fewer tokens. |
| Same-state browser snapshot | 2,836 bytes | 1,926 bytes | 32% smaller while including live form values. |
| Luna forced long-task compaction | 469,517 tokens; 52.2 s | 233,503 tokens; 81.9 s | Both strict passes. 50.3% fewer tokens, but slower; synthetic 32,768 threshold. |
| Direct Sonnet conversation | Lost settings; manual compaction unavailable | Three-turn task and manual compaction passed | Functional repair, one sequence. |
| Direct Luna model selection | Silently launched Sol | Launched Luna; telemetry checked | Functional repair. |
| Fable provider access | Pi 0.84.4 rejected | Pi 0.85.1 completed live tasks | Compatibility repair. |

Tokens include cache reads and writes; they are not dollar costs. Single pairs
are observations, not causal averages. Production compaction still defaults to
256,000 tokens. The browser baseline already included the keyboard and native
select fixes. See [browser evidence](browser-workflow-before-after.json),
[compaction evidence](long-tool-context.json), and
[conversation evidence](context-continuity.json).

## Model and feature coverage

| Coverage | Result | Limits |
| --- | --- | --- |
| Seven models: interpreter, atomic patch, async pool | 21/21 automated one-shots | One per task/model; saturated train tasks; overlapping lab work prevents speed ranking. |
| Seven models: ledger project, DAG, LRU | 18/21 functional; 15/21 strict | Exact sessions audited, including workspace scope. One per task/model. |
| Seven models: visual canvas and ticket workflow | 13/14 strict | Correct application state in all 14; one Fable prohibited-evaluation failure. |
| Fresh-session memory | 6/6 Luna stages | Recall, correction, user-line preservation, workspace/profile isolation. Synthetic sequence. |
| Project skills | 3/3 Luna stages | Discovery, explicitly requested update, fresh application. No autonomous skill rewriting. |
| Automatic direct-chat compaction | Seven-turn Luna sequence passed | More than 48,000 characters, retained later correction. |

The expanded coding matrix's original grader reported 20/21. Auditing exposed
two missing counterexamples, so every retained solution was regraded with the
strengthened checks without model retries or workspace repairs. Original
results remain available. Sonnet failed all three expanded functional tasks;
workspace violations reduced Opus and Fable strict acceptance further.

General verification guidance now permits focused recovery after a failed
check. Three targeted Claude ledger follow-ups all recovered their failed
checks, but still violated workspace scope: 2/3 functional and 0/3 strict.
Fable's final browser-policy confirmation was only 1/3 strict. Prompt guidance
did not solve those instruction failures. Structured blocked-tool policy is
separately enforced across preview batches and covered by regression tests.

See the [full experiment record](README.md) for per-model counts, configurations,
check-level artifacts, failed revisions, and reproduction commands.

## CLI comparison

The completed 27-trial crossover used Sol/high on all harnesses, three tasks,
three repetitions each, and rotating harness order. Cora's app/build stayed at
`e9c710af`; Codex was 0.153.4; Hermes was the installed 0.21.0 local fork at
`30478b6e`, not stock upstream. Every full tool trace and persisted model/effort
was audited. All trials asked zero questions and respected workspace scope.

| Harness | Original automated passes | Common strengthened strict passes |
| --- | --- | --- |
| Cora | 9/9 | 9/9 |
| Codex CLI | 9/9 | 8/9 |
| Hermes local fork | 8/9 | 8/9 |

The patch oracle and reference missed the task's stated restriction on `-`
paths and correct addition of an own JSON `__proto__` member. After validating
reference and defect tests, grader `402c54ca` regraded every retained solution.
One Codex patch solution failed the added path check. No task prompts, seed
files, model outputs, or retained task files were changed; original results
remain recorded. There were no evaluator retries or workspace repairs.

Hermes's failed patch trial exhausted three 90-second no-response attempts
before writing code. This was an operational failure in the installed
CLI/provider path, not evidence of a model coding defect. Three successful
Hermes trials also recovered from timeouts. All four omit unknown usage from
timed-out requests; their reported tokens cannot represent complete cost.

| Pairwise comparison | Matched successful pairs | Cora total | Rival total | Cora reduction |
| --- | --- | --- | --- | --- |
| Time vs Codex | 8 | 1,325.7 s | 1,714.2 s | 22.7% |
| Tokens vs Codex | 8 | 405,940 | 957,733 | 57.6% |
| Time vs Hermes | 8 | 1,344.9 s | 2,337.3 s | 42.5% |
| Tokens vs Hermes | 5 without known usage gaps | 219,067 | 356,060 | 38.5% |

Each row uses identical round/task pairs where both harnesses passed. Latency
includes recovered-request time. Token rows additionally exclude known missing
usage; this leaves no patch trials in the Hermes token comparison. These are
conditional efficiency results, not all-attempt costs or reliability estimates.
All attempted trials remain in the acceptance table. The artifact also includes
cohorts shared by all three harnesses, per-task medians, and every trial.

Three repetitions, one machine, and one model/effort do not establish a universal
ranking. Provider load, cache warmth, subscription behavior, and user activity
were uncontrolled. These were repeated development tasks, not fresh blind
holdouts. See [the audited comparison](crossover-e9c710af.json).

Two earlier schedules were invalidated: one for a prior-solution read, one for
Hermes silently ignoring high effort. Neither supports a ranking. Claude Code
was unavailable because its account organization disabled subscription access;
that is not a Cora win.

## Validation and delivery

All **241/241 regression suites** passed in 292 seconds at final code revision
`402c54ca`, plus all three TypeScript projects and the six targeted benchmark
suites. The product build passed at `e9c710af`; subsequent changes only affect
the grader, tests, and reports. Both background-capture and trusted-keyboard
macOS end-to-end tests passed at `e1665e3c`. Windows still needs a native run.
See [validation provenance](validation.json).

The branch retains all original suite history and the audited result artifacts.
The dedicated lab app and paid runners are stopped; local evidence and retained
workspaces remain available.
