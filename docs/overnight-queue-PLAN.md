# Overnight Queue + Scheduler — Build Plan

Status: **scaffold landed, full build pending.** This document is the spec for the
complete feature. The scaffold that ships alongside it (see §2) compiles and gives
the renderer a real surface to enqueue/list/remove/run, but it does **not** yet run
unattended — that requires the daemon split (§3). Everything beyond a single JSON
file and real cron firing is stubbed with explicit `TODO(overnight-queue)` markers.

All file paths below are relative to the repo root unless absolute. Existing exports
are cross-referenced inline so the next implementer can wire against ground truth.

---

## 1. Goal

Let the user **batch work and walk away.** Spark's autonomy thesis is
delegate-and-walk-away: the user trusts the agent and wants to queue a stack of
plans at night, close the laptop lid (or at least the window), and wake up to
finished runs. Two capabilities:

1. **Overnight queue** — an ordered list of pending runs that burns down `k`
   at-a-time. Each item is just a `StartAutopilotInput` (the same payload the
   "Run plan" flyout and "Smart Merge" already produce), so a queued item is a
   full autopilot run: plan → spawn Claude Code / Codex workers → cross-engine
   verify → complete.
2. **Scheduler** — cron-style triggers that enqueue a job at a wall-clock time
   ("every weeknight at 02:00", "Sunday 06:00 weekly cleanup"), so recurring work
   fires without the user present.

The north star: the queue keeps draining and the scheduler keeps firing **whether
or not the renderer window is open** — which is exactly the part the scaffold
cannot do yet (§3).

---

## 2. What this scaffold ships now

The scaffold is a **compiling subset** — disjoint, file-scoped, gate-clean. It
exists so the data model and IPC/preload/UI plumbing are real and testable, while
deferring the parts that need a background process.

### New main-process modules

- **`src/main/orchestration/run-queue.ts`** — the `RunQueue` model. Holds an
  ordered list of `QueueItem` records (each wrapping a `StartAutopilotInput` plus
  `id`, `status`, `enqueuedAt`). Exposes `enqueue`, `list`, `remove`, and a
  `burnDown(concurrency)` that pulls the next pending item(s) and calls the
  existing **`startAutopilot(input)`** (`src/main/orchestration/run-store.ts:411`,
  returns `Promise<RunState>`). Persists via single-file JSON (below).
- **`src/main/orchestration/scheduler.ts`** — a scheduler **registry stub**. Holds
  `ScheduleJob` records (`id`, `cronExpr`, the `StartAutopilotInput` template,
  `enabled`). Exposes `register`, `list`, `remove`. `fire()` enqueues the job's
  template onto the `RunQueue`. **No real timer yet** — see the cron TODO in §5.

Both modules import the existing run-store/event-log exports; **`run-store.ts` and
`event-log.ts` are not edited** by the scaffold (the queue/scheduler are pure
consumers of their public surface).

### Persistence (single-file JSON, stub)

- One file each under `sparkHome()` (`src/main/spark-home.ts:15`), e.g.
  `join(sparkHome(), "overnight-queue.json")` and `.../overnight-schedule.json`.
- Writes go through **`writeFileAtomic(path, content)`** (`src/main/fs-atomic.ts:9`)
  so a crash mid-write can't corrupt the file. Reads are a `try/readFile` that
  treats `ENOENT` as empty (same pattern as `listEvents` in
  `src/main/orchestration/event-log.ts:53`).
- **Stub boundary:** the whole queue is one JSON blob rewritten on every mutation.
  Fine for tens of items; replaced by per-record files in §4.

### IPC + preload surface

- **`src/main/ipc.ts`** — add `ipcMain.handle("overnightQueue:*", …)` handlers
  (`enqueue` / `list` / `remove` / `runNow`, plus `schedule:register` / `list` /
  `remove`), following the existing `orchestration:*` block (`src/main/ipc.ts`
  ~813–954) and the lazy module accessor pattern (`getRunStore()` at
  `src/main/ipc.ts:86–90`) — add a sibling `getRunQueue()` / `getScheduler()` so
  the modules stay lazy-loaded.
- **`src/preload/index.ts`** — expose `spark.overnightQueue.*` mirroring
  `spark.orchestration.*` (`src/preload/index.ts:406–461`): each method is a thin
  `ipcRenderer.invoke("overnightQueue:…", input)`. The inferred `SparkApi` type
  picks the new surface up automatically (same as the rest of `window.spark`).

### Renderer panel

- **`src/renderer/src/components/runs/QueuePanel.tsx`** — a self-contained
  default-export React component (style ref: `RunCanvas.tsx` in the same dir).
  Lists queued items + schedule jobs, an **add** affordance, **remove** and
  **run-now** buttons. Per the no-native-dialogs rule, **delete is a two-step
  "double-click to confirm"** in-app interaction — never `window.confirm`.

### Shared types

- **`src/shared/types.ts`** — `QueueItem`, `QueueItemStatus`, `RunQueueSnapshot`,
  `ScheduleJob`, and the IPC input/result shapes. (This file is in both the node
  and web tsconfigs, so it carries both gates.)

### Stubs / TODOs explicitly deferred by the scaffold

- `burnDown` runs **only in the main process while the app is open** (no daemon).
- `scheduler.fire()` is **manual / no cron timer** — registry only.
- Persistence is **one JSON file**, no per-job records, **no crash-recovery** of
  in-flight items.
- Concurrency is **naive**: `burnDown` treats `startAutopilot` resolving as
  "started", not "finished", so it cannot truly cap `k` *running* runs (see §3).
- Queue/schedule mutations are **not** folded into the `events.jsonl` /
  change-broadcast stream yet, so the renderer must poll `list` rather than
  live-update via `onEvent` (see §4).
- No plan/engine picker reuse, no per-item progress, no tab mounting (see §6).

---

## 3. Dependency on the daemon split (REQUIRED)

**The queue and scheduler cannot deliver their core promise — running unattended —
until Spark's orchestration core runs in a background daemon separate from the
renderer/window.** This is a hard prerequisite, not a nice-to-have.

Why the current architecture blocks it:

- **The burn-down loop lives in the main process and only progresses while the app
  runs.** The autopilot engine is driven by `scheduleAutopilotCycles(runId,
  attemptIds)` (`src/main/orchestration/run-store.ts:866`), which tracks work in an
  **in-memory `activeAutopilotCycles` Map of Promises**. Those promises (and any
  `setTimeout` the queue uses to poke the next item) evaporate when the Electron
  main process exits. Close the app → the queue stops draining mid-stack.
- **Scheduler firing is a no-op until a background owner holds the timer.** A cron
  timer registered in the renderer dies on window close; one in the current main
  process dies on app quit. Real "fire at 02:00 while I sleep with the app closed"
  requires a process whose lifetime is independent of the window — a daemon (or a
  detached helper / OS service / login-item) that owns the timer **and** the
  queue-drain loop.
- **`startAutopilot` resolves at run-*creation*, not run-*completion*.** Read
  `src/main/orchestration/run-store.ts:411–473`: it `createRun`s, commits an
  `autopilot.started` change, schedules the first cycle, and returns the
  `RunState`. The promise settles long before the run finishes. So
  `burnDown`'s "start the next item when the previous resolves" gives **N runs
  launched back-to-back**, not **k running at a time**. True k-at-a-time
  concurrency requires the daemon to **watch run-completion events** (the run's
  terminal `run.*` / `autopilot` status transitions on the event stream — see
  `subscribeToEvents` in `src/main/orchestration/event-log.ts:74`) and only then
  pull the next queue item.

What the daemon must own (so this plan stays coherent with the split when it
lands):

1. The **queue-drain loop** (today's `burnDown`), surviving window close.
2. The **scheduler timer set** (today's no-op `fire`).
3. A **run-completion watcher** subscribed to the event stream, feeding (1) so
   concurrency is measured on *running*, not *launched*, runs.
4. The **persistence of in-flight state** (which item is mid-launch) so a daemon
   restart resumes correctly (§4).

Until the daemon exists, the scaffold is intentionally "drains while the app is
open, registry-only scheduler." When the split lands, `run-queue.ts` /
`scheduler.ts` move into (or are invoked by) the daemon with minimal change to
their public surface — that's the reason they're standalone modules now.

---

## 4. Full data model

Promote persistence beyond the single JSON blob from §2:

- **Per-queue / per-job records under `sparkHome()`.** Mirror the runs layout
  (`runsRoot()` / `runDir(runId)` in `src/main/orchestration/event-log.ts:24–34`):
  e.g. `join(sparkHome(), "queue")` with one `queue/<itemId>.json` per item and
  `schedule/<jobId>.json` per job. A small index file (or a glob of the dir) lists
  them. All writes stay on `writeFileAtomic` (`src/main/fs-atomic.ts:9`); reads
  reuse the `ENOENT → empty` pattern. Per-record files mean a single corrupt item
  can't take down the whole queue and concurrent mutations don't rewrite unrelated
  records.
- **Crash-recovery / resume of in-flight items.** Each item carries a richer status
  (`pending → claimed → launching → launched → done | failed`) and, once launched,
  the `runId` it produced. On daemon (or app) restart, scan records: any item stuck
  in `claimed`/`launching` with no live run is **re-queued** (or reconciled against
  its `runId` via `getRun` in `run-store.ts` if it actually started). This is the
  state §3.4 says the daemon must own.
- **Fold queue/schedule state into the event/broadcast stream (if needed) so the
  renderer live-updates.** Today the panel polls `list`. To get push updates,
  emit queue/schedule mutations through the same fan-out the runs use — `appendEvent`
  / `broadcast` in `src/main/orchestration/event-log.ts:36–94`, which sends on the
  `orchestration:event` channel that the preload `onEvent` subscription
  (`src/preload/index.ts:461–465`) already listens to. Options, cheapest first:
  - (a) emit lightweight `queue.*` / `schedule.*` `SparkEvent`s on the existing
    channel; `QueuePanel` filters them in its `onEvent` handler. **No new IPC
    channel, no new preload method** — preferred.
  - (b) a dedicated `overnightQueue:event` channel + `onQueueEvent` preload sub
    (mirrors `onEvent`) if we want queue traffic off the run channel.
  Either way the renderer stops polling and reflects daemon-side burn-down live.

---

## 5. Real cron

Replace the §2 registry stub with actual firing:

- **Parser/timer:** `node-cron` (or `croner` — single-dep, no native build, good
  TS types — decide in review). Each enabled `ScheduleJob` gets a live timer in the
  **daemon** (never the renderer; never a soon-to-die main process — see §3).
- **enable/disable** per job without deleting it: a timer is created on `enabled:
  true` and torn down on `false`. `register` / `remove` already exist in the stub;
  add `setEnabled(jobId, on)`.
- **Missed-fire catch-up policy:** the machine sleeps overnight or the daemon was
  down at the scheduled minute. Per job, choose: `skip` (do nothing — default for
  noisy recurring jobs), `runOnce` (fire one catch-up enqueue on next startup if a
  fire was missed), or `runAll` (enqueue one per missed occurrence — rarely wanted).
  Persist `lastFiredAt` per job (in its §4 record) so catch-up is computed against
  ground truth, not process uptime.
- **Timezone handling:** store the job's IANA tz (e.g. `Europe/Zurich`) alongside
  the cron expression and evaluate in that zone. "02:00 every night" must mean
  02:00 local across DST transitions, not drift by an hour twice a year. Default to
  the host tz; let the UI override.

`scheduler.fire()` stays the enqueue path — cron just calls it on schedule instead
of the user calling it manually.

---

## 6. UI follow-ups

- **Mount `QueuePanel` into a tab/route.** The scaffold ships the component but
  doesn't surface it. Add it to the tab system — `src/renderer/src/tabs/TabBar.tsx`
  / `src/renderer/src/tabs/RunsStack.tsx` (the same machinery that hosts run
  canvases) — as a dedicated "Queue" tab, or a route off the runs view
  (`src/renderer/src/components/RunsView.tsx`).
- **Plan/engine picker reuse from the Run-plan flyout.** Adding a queue item should
  reuse the existing plan-selection + engine (`chatBackend`) picker that the "Run
  plan" flyout already uses to build a `StartAutopilotInput` (the
  `chatBackend?: ChatBackendKind` field, `src/shared/types.ts:1519`). Don't rebuild
  the picker — lift it so both the flyout and `QueuePanel`'s "add" share it.
- **Per-item progress.** Once §4's live events land, show each launched item's run
  status/percent inline (link to its run canvas by `runId`).
- **Concurrency control.** A small "run N at a time" setting feeding the daemon's
  k-at-a-time loop (§3). Persist alongside the queue record.

---

## 7. Migration & rollout

1. **Land the scaffold** (this doc + `run-queue.ts`, `scheduler.ts`, IPC/preload,
   `QueuePanel.tsx`, shared types). Compiles, gate-clean, no behavior change to
   existing runs. Queue drains only while the app is open; scheduler is registry-only.
2. **Daemon split** (separate, larger effort; §3 is its acceptance criterion for
   this feature). Move the drain loop + scheduler timers + run-completion watcher
   into the daemon.
3. **Per-record persistence + crash-recovery** (§4). Migrate the single
   `overnight-queue.json` → `queue/<itemId>.json` on first daemon boot (read old
   blob, fan out to records, leave a `.migrated` marker; keep a one-release
   backward read so a downgrade doesn't lose the queue).
4. **Live events** (§4) — switch `QueuePanel` from polling to `onEvent`.
5. **Real cron** (§5) — wire `node-cron`/`croner` in the daemon; ship enable/disable,
   catch-up, tz.
6. **UI follow-ups** (§6) — tab mount, shared picker, per-item progress, concurrency
   setting.

### Open questions

- **Where does the daemon live** — detached Node helper, OS login-item/service, or
  a hidden always-on Electron background window? Affects packaging, auto-update, and
  how the renderer talks to it (IPC vs local socket).
- **Run isolation:** overnight runs land in worktrees (existing `git-worktrees.ts`
  flow). Do concurrent queued runs each get their own worktree, and how are
  collisions / cleanup handled when the user is asleep?
- **Failure policy:** if a queued run fails or asks a question
  (`spark_ask_user` / a `RunQuestion`), does the queue pause, skip, or hold that
  item for morning review? Walk-away implies it should **not** block the whole
  queue on one stuck item.
- **Catch-up default** (§5): `skip` vs `runOnce` as the global default.
- **Notification on completion** so the user sees overnight results without
  digging through tabs.
- **Cost/limits guardrail:** an optional cap (max runs, or stop on repeated
  failures) so an overnight queue can't burn the whole budget unattended.
