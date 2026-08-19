# cora — the Codara Studio CLI

Drive Cora (Codara Studio's orchestrator) from a terminal: start runs, watch
subagents live, answer questions, work the kanban board and whiteboard, manage
automations, and benchmark the whole harness.

```
npm run cora -- help          # inside the repo
node cli/cora.cjs status      # directly
cora chat                     # fullscreen chat (also the TTY default)
```

## Full-screen chat

Run `cora` in a terminal to open the chat UI, or use `cora chat <run-prefix>`
to resume a run. The transcript follows Cora in real time and the status bar
shows active agents and step progress; closing the UI leaves long-running work
alive in Codara Studio. Type `/help`
for the intentionally small command set (`/new`, `/cancel`, `/quit`). A bare
number answers the matching option when Cora asks a question.

Fresh bounded chats use Cora's compact direct loop: one capable worker, a
small exact prompt, focused checks, and one structured result call. Broad,
long, multi-part, attachment, and explicit parallel work stays on the managed
orchestration path. Use `--direct` or `--managed` to override auto-routing.

The interface uses Pi's MIT-licensed TUI primitives. Its compact status bar,
scrolling transcript, bordered composer, and contextual shortcut row are an
original Cora surface inspired by the clarity of Grok Build's terminal UI.

## Layout

- `cora.cjs` — entry point: arg parsing, help, dispatch.
- `lib/rpc.cjs` — talks to the running app (reads `~/.Codara/agent-socket.json`
  for the loopback URL + bearer token, POSTs JSON-RPC to `/rpc`).
- `lib/store.cjs` — offline reads of `~/.Codara/runs`; run inspection works
  with the app closed.
- `lib/ui.cjs` — colors, the logo, tables, time formatting.
- `commands/` — one file per command group (`chat.cjs` owns the TUI; the rest
  cover sessions, runs, agents/watch, board/whiteboard, automations, bench,
  and status).
- `bench/tasks.cjs` — the harness benchmark suite: tiered tasks with hidden
  contract checks and reference solutions; `bench/score.cjs` is the scorer;
  `bench/adopt.cjs` re-attaches to a live bench run whose bench process was
  killed (resumes green polling, drives remaining checkpoint stages, grades,
  appends a history row flagged `adopted`).

Housekeeping: `cora ws prune` removes workspaces whose directory no longer
exists (bench runs register throwaway tmpdirs as real workspaces; the bench
also prunes its own after grading).

## The live dashboard

`cora watch` repaints a dashboard of the active run every second: status,
every subagent with its model and runtime, steps, the blocking question if
any, and the latest activity. It reads run state from disk, so it costs the
app nothing.

## The benchmark

`cora bench` needs the app running with a Pi subscription. It rates the
HARNESS, not just correctness: per task it seeds a throwaway git workspace,
starts a real Cora run, polls the visible test to catch the moment it first
goes green, waits for the run to settle (auto-answering questions), then
grades a 0-100 score:

- **correctness (55)** — visible tests plus *hidden contract checks*: stated
  requirements the visible tests don't exercise, so test-chasing plateaus and
  100 stays out of reach.
- **efficiency (20)** — wall time and total manager + worker tokens against the task's
  frozen "par".
- **discipline (15)** — time spent after the tests first went green is
  over-verification and costs points.
- **orchestration (10)** — parallel tasks must actually fan out; trivial
  tasks must NOT spawn worker armies (effort calibration).
- penalties for questions, crashed workers, and outliving the bench cap.

**Staged (checkpoint) tasks** evolve their spec mid-run: after the run
settles, the bench overwrites test.js with the next stage's contract and
sends the follow-up prompt into the SAME conversation (including every rival
adapter). The final state is graded against all stages plus a slop
gate (size and duplication caps) — this probes whether quality survives
iterating on your own code, the regime where a single long context degrades.

Tasks are tiered (trivial 5m cap / standard 10m / hard 15m / project 30m)
and split
**train/holdout**: iterate prompts against train, confirm on holdout so
prompts don't overfit the tasks. Every task ships a reference solution the
offline self-test grades to prove the hidden checks are satisfiable.

`cora bench list` shows the suite; `--split train|holdout|all` picks the
split (default train); `--task NAME[,NAME]` runs a focused suite; `--repeat N` measures
reliability (green k/k + score spread); `--keep` keeps workspaces;
`--agent hermes` sends the same workspace through Hermes Agent. Cora and
Hermes are both pinned to the requested `--model` and `--effort` through the
`openai-codex` provider, so the benchmark compares agent harnesses rather than
different underlying models. After grading, Cora runs are cancelled
(a settled run can revive on a late verifier verdict) and their temporary
workspaces are deleted and pruned from the app. Each suite appends to
`cli/bench/history.jsonl`, stamped with the live prompt plus task, scorer,
runner/adapter, source commit, product, and agent versions. Comparisons require
the same task set, scorer, runner, repeat count, model/provider/effort control,
and installed Cora/Hermes versions.

Tests: `npm run test:cora-cli` (offline, no app needed).
