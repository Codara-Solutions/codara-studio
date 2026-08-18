# cora — the Codara Studio CLI

Drive Cora (Codara Studio's orchestrator) from a terminal: start runs, watch
subagents live, answer questions, work the kanban board and whiteboard, manage
automations, and benchmark the whole harness.

```
npm run cora -- help          # inside the repo
node cli/cora.cjs status      # directly
```

## Layout

- `cora.cjs` — entry point: arg parsing, help, dispatch.
- `lib/rpc.cjs` — talks to the running app (reads `~/.Codara/agent-socket.json`
  for the loopback URL + bearer token, POSTs JSON-RPC to `/rpc`).
- `lib/store.cjs` — offline reads of `~/.Codara/runs`; run inspection works
  with the app closed.
- `lib/ui.cjs` — colors, the logo, tables, time formatting.
- `commands/` — one file per command group (sessions, runs, agents/watch,
  board/whiteboard, automations, bench, status).
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
- **efficiency (20)** — wall time and manager tokens against the task's
  frozen "par".
- **discipline (15)** — time spent after the tests first went green is
  over-verification and costs points.
- **orchestration (10)** — parallel tasks must actually fan out; trivial
  tasks must NOT spawn worker armies (effort calibration).
- penalties for questions, crashed workers, and outliving the bench cap.

**Staged (checkpoint) tasks** evolve their spec mid-run: after the run
settles, the bench overwrites test.js with the next stage's contract and
sends the follow-up prompt into the SAME conversation (for `--agent claude`,
via `--continue`). The final state is graded against all stages plus a slop
gate (size and duplication caps) — this probes whether quality survives
iterating on your own code, the regime where a single long context degrades.

Tasks are tiered (trivial 5m cap / standard 10m / hard 15m / project 30m)
and split
**train/holdout**: iterate prompts against train, confirm on holdout so
prompts don't overfit the tasks. Every task ships a reference solution the
offline self-test grades to prove the hidden checks are satisfiable.

`cora bench list` shows the suite; `--split train|holdout|all` picks the
split (default train); `--task NAME` runs one; `--repeat N` measures
reliability (green k/k + score spread); `--keep` keeps workspaces;
`--agent claude` runs the same tasks and grading through headless Claude Code
(opus-5, effort high) as the single-agent rival harness. After grading, the
run is cancelled (a settled run can revive on a late verifier verdict) and
its workspace is deleted and pruned from the app. Each suite appends to
`cli/bench/history.jsonl`, stamped with a hash of the live prompt surfaces —
`cora bench history` shows the trajectory, and the summary prints deltas
against the previous same-split entry plus a vs-rival table when the other
harness has run the split.

Tests: `npm run test:cora-cli` (offline, no app needed).
