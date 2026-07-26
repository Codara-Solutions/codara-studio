# Daemon split — phased migration plan

- **Date:** 2026-06-03
- **Status:** Phase 0 landed (scaffold only — nothing rewired)
- **Scaffold dir:** `src/main/orchestration/daemon/`
- **Inert integration point:** `registerDaemonHostScaffold()` called from `src/main/index.ts` (after `startAgentSocket()`)
- **Compile gate:** `npm run typecheck:node` (baseline 0 errors)

This document describes the full phased extraction of Spark's orchestration core
out of the Electron main process and into a **detached daemon process** that owns
`RunState`, the autopilot manager loop, and (eventually) every worker/terminal
PTY. The renderer becomes a thin client over a loopback HTTP + bearer transport,
modeled exactly on the existing `agent-socket.ts` JSON-RPC server.

Phase 0 is already on disk. Phases 1–4 are sequenced so each one compiles on its
own, ships behind a flag or an inert seam, and can be rolled back by reverting a
single integration point.

---

## 1. Motivation & current state

Today the entire orchestrator lives inside the Electron **main** process:

- **`src/main/orchestration/run-store.ts` (~9100 lines)** is the single owner of
  `RunState`. It holds the in-memory run map, the **autopilot manager loop**
  (`startAutopilot()` @ `run-store.ts:411` → `commitRunChange` → the OpenRouter
  manager decision in `openrouter-manager.ts` → `createWorkerTask` /
  `prepareWorkerTask` / `launchWorkerAttempt`), **PTY ownership** for workers
  (the `ActiveWorkerProcess` handles around `run-store.ts:107` that wrap
  `pty-manager` panes), and the **checkpoint** writes via
  `checkpoints.ts` (`createCheckpoint` / `rewindShadowRef`).
- **`event-log.ts`** is the fan-out hub. `appendEvent()` writes
  `<spark-home>/runs/{runId}/events.jsonl` and then `broadcast()`s each
  `SparkEvent` to (a) in-process `mainSubscribers` and (b) every
  `BrowserWindow.webContents.send("orchestration:event", event)`. The renderer's
  whole live view is built by listening to that one `orchestration:event` IPC
  channel.
- **The renderer** (chat, run graph, timeline) is a pure consumer: it calls
  `orchestration:*` IPC verbs to start/cancel/answer, and rehydrates from
  `orchestration:event`. It never owns run state.

Two existing facts make the split tractable and are the load-bearing anchors for
every phase below:

1. **There is already a headless, renderer-free entry into the orchestrator.**
   `src/main/eval/headless-runner.ts` (`runHeadlessEval`) calls
   `startAutopilot()` directly (`headless-runner.ts:33` imports it from
   `../orchestration/run-store`), subscribes to the bus via
   `subscribeToEvents()` from `event-log.ts`, and on
   `worker_task.envelope_prepared` spawns the worker PTY itself — because in
   headless mode no renderer exists to do it. **The daemon host is structurally
   the same actor as the headless runner**: an event-loop owner with no
   `BrowserWindow` that drives `startAutopilot` and reacts to the event bus.
   `startAutopilot` @ `run-store.ts:411` already carries a Phase-0 comment
   marking it as the entry the daemon reuses verbatim.

2. **`agent-socket.ts` is a working, in-tree loopback HTTP + bearer JSON-RPC
   server we can copy wholesale.** It binds `127.0.0.1` on an ephemeral port
   (`startAgentSocket()` @ `agent-socket.ts:86`), mints a per-process token,
   writes a handshake file (`agent-socket.json` under `sparkHome()` via
   `writeFileAtomic`), constant-time-compares the `Authorization: Bearer`
   header, and — crucially — reaches `run-store` through a **lazy dynamic
   import** (`getRunStore()` @ `agent-socket.ts:67`) so cold startup never pays
   the orchestrator's module-load cost. Out-of-process MCP children already read
   that handshake file to dial back in. The daemon transport is the same shape
   with a different verb set.

**Why split at all.** Three concrete pains, all rooted in the orchestrator being
co-resident with the UI process:

- **Renderer reloads kill in-flight work.** A renderer crash / workspace switch
  / dev hot-reload tears down `webContents`; today `pty.detachForWebContents`
  (`index.ts:167`) keeps worker PTYs alive, but the binding is fragile (see the
  PTY respawn / stranded-binding / drain-leak traps in Phase 2). A detached
  daemon makes "the UI went away" a non-event for a running plan.
- **`run-store.ts` is a 9100-line god-module** fused to Electron (`BrowserWindow`
  in `event-log.ts`, `app` paths, pty-manager). It cannot be unit-tested or
  reused headlessly without dragging Electron in. The daemon boundary forces a
  clean RPC contract.
- **No path to remote.** Users want delegate-and-walk-away (the Spark autonomy
  thesis). A daemon that already speaks loopback HTTP + bearer is one tunnel away
  from running the orchestrator on a remote box and attaching the desktop UI to
  it over SSH (Phase 4).

---

## 2. Target architecture

```
┌─────────────────────────┐         loopback HTTP + Bearer          ┌──────────────────────────────┐
│  Electron renderer       │  ── daemon.start / attach ──────────▶  │  daemon-host process          │
│  (chat, run graph,       │  ── daemon.streamEvents (SSE/poll) ◀── │   owns RunState               │
│   timeline)              │  ── daemon.cancel / answer / stop ──▶  │   owns autopilot manager loop │
│                          │                                         │   owns worker + terminal PTYs │
│  thin DaemonClient       │   handshake file: daemon-socket.json    │   owns checkpoint shadow refs │
└─────────────────────────┘   (sparkHome(), bearer token)           └──────────────────────────────┘
                                                                          │  spawns
                                                                          ▼
                                                                    claude / codex CLI workers
```

- **`daemon-host`** is a headless Node process (initially still *inside* Electron
  main as an in-process module, then split to a real detached child once the
  contract is proven — see Phase rollback notes). It owns the `RunState` map, the
  manager loop, the PTYs, and the checkpoint refs. It exposes a small JSON-RPC
  verb set over `127.0.0.1` with a per-launch bearer token, persisted to a
  `daemon-socket.json` handshake file (same mechanism as `agent-socket.json`).
- **The renderer** becomes a **thin `DaemonClient`**: it POSTs verbs to `/rpc`
  with `Authorization: Bearer <token>` read from the handshake file, and
  consumes a `daemon.streamEvents` stream (a `SparkEvent` feed filtered by
  `runId`) instead of the `orchestration:event` IPC channel. No run state lives
  renderer-side; it is a projection of the event stream, exactly as today.
- **A future remote-attach variant** swaps the local handshake file for a remote
  endpoint descriptor and tunnels the bearer over SSH (Phase 4). The client code
  is unchanged; only the endpoint+transport resolution differs.

### Phase-0 scaffold modules (already on disk)

The scaffold is three loosely-coupled modules + a barrel under
`src/main/orchestration/daemon/`. They compile and are reachable from boot but
**start no server and rewire nothing**:

- **`daemon-ipc.ts`** — types-only seam. Defines the `DaemonRequest` /
  `DaemonResponse` discriminated unions, a `SparkEvent`-carrying
  `DaemonEventFrame`, and the handshake constants (file name, bearer header
  shape). **Imports no run-store** — it is pure shared vocabulary so both host
  and client can depend on it without pulling the orchestrator tree.
- **`daemon-host.ts`** — the headless host, shaped like
  `startAgentSocket` / `stopAgentSocket` (idempotent start/stop, handshake JSON
  via `sparkHome()` + `writeFileAtomic`). Its dispatch delegates `start` →
  `startAutopilot` and `streamEvents` → `subscribeToEvents` filtered by `runId`,
  reaching `run-store` through the **same lazy `getRunStore()` dynamic import**
  as `agent-socket.ts`. Phase 0 exports an **inert `registerDaemonHostScaffold()`**
  that only logs/records readiness — it does not call `listen()`.
- **`daemon-client.ts`** — a thin `DaemonClient` stub that POSTs to `/rpc` with
  Bearer auth, reading the handshake file the way MCP children read
  `agent-socket.json`. Not yet consumed by the renderer.
- **`index.ts` (barrel)** — re-exports the above so `index.ts`'s single import
  (`registerDaemonHostScaffold` from `./orchestration/daemon`) resolves.

The one integration point in `src/main/index.ts` calls
`registerDaemonHostScaffold()` right after `startAgentSocket()`, mirroring that
lazy-startup site. It is a no-op today.

---

## 3. Phases

Each phase lists: **what moves out of `run-store.ts`**, **what stays**, **IPC
verbs added**, **rollback / compile-gate strategy**, and **risks**.

### Phase 0 — Scaffold (this change)

- **Moves out of `run-store.ts`:** nothing. `run-store.ts` gains only a tiny
  additive marker — a stable comment on `startAutopilot` @ `run-store.ts:411`
  identifying it as the daemon's reused headless entry. No code is removed or
  rewired.
- **Stays:** everything. The renderer still talks `orchestration:*` IPC +
  `orchestration:event`. The headless runner is untouched.
- **IPC verbs added:** none live. The `daemon-ipc.ts` union *declares*
  `daemon.start` / `daemon.attach` / `daemon.streamEvents` / `daemon.cancel` /
  `daemon.answer` / `daemon.stop` as types so later phases have a stable
  contract, but no handler is registered and no port is bound.
- **Rollback / gate:** delete the `daemon/` dir and the one
  `registerDaemonHostScaffold()` line in `index.ts`. Gate is
  `npm run typecheck:node` = 0 errors; `tsconfig.node.json` (`include
  src/main/**/*`, `@shared/*` alias) picks up the new files automatically.
- **Risks:** essentially none — inert by construction. The only failure mode is a
  type error in the new union, caught by the gate.

### Phase 1 — Manager loop + run state behind daemon dispatch

Make the daemon host the real owner of the autopilot loop and run reads/writes,
behind a feature flag so interactive Spark can fall back to the in-process path.

- **Moves out of `run-store.ts`:**
  - The **autopilot manager loop** driver — `startAutopilot` @ `run-store.ts:411`
    and the `commitRunChange` → `requestOpenRouterManagerDecision`
    (`openrouter-manager.ts`) → `createWorkerTask` / `prepareWorkerTask` cycle —
    is invoked **only** through `daemon-host`'s `start` dispatch. The functions
    stay in `run-store.ts` (no code motion yet); ownership of *who calls them*
    moves to the daemon.
  - **Run read access** for the renderer: `getRun` / `listRuns` projections are
    served by `daemon.streamEvents` + a `daemon.snapshot` verb instead of the
    `orchestration:getRun` IPC.
- **Stays in `run-store.ts`:** the actual `RunState` mutation primitives
  (`commitRunChange`, `addRunMessage`, `updateRunStatus`, step/worker CRUD), and
  the on-disk `run.json` / `events.jsonl` writers.
  Phase 1 is a **call-site move, not a file move** — keeps the diff
  reviewable and the rollback trivial.
- **IPC verbs added (live):** `daemon.start` (→ `startAutopilot`),
  `daemon.snapshot` (→ `getRun` / `listRuns`), `daemon.streamEvents`
  (→ `subscribeToEvents` filtered by `runId`, replacing `orchestration:event`),
  `daemon.cancel` (→ `cancelRun`), `daemon.answer` (→ `addRunMessage` kind
  `answer`).
- **Rollback / compile-gate:** a `SPARK_DAEMON=1` env flag (read in `index.ts`
  next to `registerDaemonHostScaffold`) selects daemon dispatch; unset = today's
  in-process IPC, byte-for-byte. The daemon host still runs **in-process** in
  Phase 1 (same `node` process as Electron main) so there is no IPC-serialization
  or process-lifetime risk yet — only the *call path* is rerouted. Gate stays
  `npm run typecheck:node` = 0; add a smoke run of `runHeadlessEval` (which
  already exercises `startAutopilot`) to CI as a behavior gate.
- **Risks:**
  - **Event-stream parity.** The renderer must rebuild identical run state from
    `daemon.streamEvents` as it did from `orchestration:event`. Mitigation:
    `event-log.broadcast()` already fans out to both `mainSubscribers` and
    `webContents`; Phase 1 keeps `event-log.ts` unchanged and layers
    `daemon.streamEvents` on top of `subscribeToEvents`, so the two feeds are the
    *same events*.
  - **Replay / resume traps.** Resuming a CC/Codex run must keep
    `skipExistingJsonl` semantics (the JSONL-replay trap) and the late
    `pendingMcpToolCalls` turn-cap extension; these live below the dispatch
    boundary and must not be bypassed by the new entry.
  - **Backpressure on streamEvents** for long/deep runs (hundreds of steps) —
    apply the same manager-context compaction discipline; the stream is
    append-only `SparkEvent`s so a slow client must not stall the host
    (best-effort fan-out, like `subscribeToEvents` today).

### Phase 2 — PTY ownership handoff

Move worker/terminal PTY ownership into the daemon so PTYs survive renderer
reloads. This is the highest-risk phase because of three documented ConPTY
hazards on Windows.

- **Moves out of `run-store.ts` / main:**
  - `pty-manager.ts` (1047 lines) and `cli-session.ts` (the node-pty CLI
    wrapper) move under the daemon process. The `ActiveWorkerProcess` handles
    (`run-store.ts:107`) that today hold `write` / `kill` closures over
    pty-manager panes become **daemon-owned**; the renderer's TerminalView
    attaches to a daemon-side PTY over a `daemon.terminal.*` stream rather than
    `pty.attachForWebContents`.
  - The `worker_task.envelope_prepared` → spawn-PTY reaction (today done by the
    renderer, or by `headless-runner.ts` when headless) becomes unconditionally
    the daemon's job — converging interactive and headless on one owner.
- **Stays in `run-store.ts`:** the *logical* worker lifecycle
  (`prepareWorkerTask`, `launchWorkerAttempt`, attempt status transitions). It
  asks the daemon's PTY layer to spawn/kill; it does not hold the OS handle.
- **IPC verbs added:** `daemon.terminal.attach` / `daemon.terminal.write` /
  `daemon.terminal.resize` / `daemon.terminal.read` (the last mirrors
  `agent-socket.ts`'s existing `terminal.read` tail reader at
  `agent-socket.ts:322`, reusable nearly verbatim), and `daemon.terminal.stream`
  for live output frames.
- **Rollback / compile-gate:** keep `pty-manager` importable from both main and
  daemon during the transition; the `SPARK_DAEMON` flag chooses which process
  binds the PTY. If daemon PTYs misbehave, unset the flag to fall back to
  renderer-attached PTYs. Gate: `typecheck:node` + a manual interactive smoke
  (spawn a worker, reload the renderer, confirm the worker PTY survives and
  reattaches).
- **Risks (all previously hit, must be carried forward):**
  - **PTY respawn trap.** `cli-session.dispose()` must use `pty.killImmediate`,
    **not** `pty.dispose` — the `GRACE_MS` soft-kill leaves a dying PTY in the
    sessions map and the next `pty.spawn` returns it instead of spawning new
    (`cli-session.ts:299`). Moving cli-session into the daemon must preserve this
    exactly.
  - **Stranded-binding stash.** Kill+respawn at the same `sessionId` must
    preserve the renderer's `webContents` binding via the 10s TTL stash; without
    it the Terminal tab sticks to the dead pid after a mode-flip respawn. Across
    a process boundary this binding is now a *daemon→renderer* attach token, not
    an in-process `webContents` — the riskiest re-derivation in the whole split.
  - **ConPTY drain leak.** Windows ConPTY drains for ~1s after `pty.kill()`; the
    host must set `Session.disposed = true` synchronously in `killNow`
    (`cli-session.ts:140` gate) and emit an xterm reset (`\x1bc`) on adoption, or
    leaked drain bytes corrupt the next pane.
  - **SIGWINCH clamp.** CC v2.x Ink doesn't clear the old frame on resize-up;
    daemon-owned PTYs must keep `maxCols: 120` pinned across resize cycles.

### Phase 3 — Durable checkpoints

Make undo survive a daemon restart by having the daemon own and persist the git
shadow refs.

- **Moves out of `run-store.ts`:** the checkpoint write path
  (`createCheckpoint` / `rewindShadowRef` / `deleteRunCheckpoints` from
  `checkpoints.ts`, called around the autopilot mutation points in
  `run-store.ts`) becomes daemon-owned and is persisted as part of daemon run
  state. The shadow ref `refs/spark/runs/{runId}` (`checkpoints.ts:53`,
  `shadowRef()`) is already a durable git object — the change is that the
  **daemon** is the writer/restorer of record, and it reconstructs the
  checkpoint index from the refs on restart instead of from in-memory
  `RunState`.
- **Stays in `run-store.ts`:** the `Checkpoint[]` projection inside `RunState`
  (so the renderer's undo UI is unchanged) and the `undoToCheckpoint`
  scope=chat semantics that back the Stop-button "give back" flow. Those read the
  daemon-owned refs.
- **IPC verbs added:** `daemon.checkpoint.list` / `daemon.checkpoint.restore`
  (→ `restoreCheckpointCode` / `rewindShadowRef`). Restore must remain
  HEAD/branch-safe: `read-tree -u --reset <sha>` then `reset HEAD`, never a
  checkout/branch write (per `checkpoints.ts` header contract).
- **Rollback / compile-gate:** checkpoints are already on-disk git objects, so
  the fallback is "the in-process path still works"; the daemon merely takes over
  *issuing* the git commands. Flag-gated; revert restores the in-process caller.
  Gate: `typecheck:node` + a checkpoint round-trip test (create checkpoint →
  restart daemon → list shows it → restore matches worktree).
- **Risks:**
  - **Concurrent git access** to the same repo from daemon + a user-driven Source
    Control action (`components/git/*`, `git-*.ts`). Shadow-ref writes touch only
    `refs/spark/*` and never HEAD, but `git add -A`/`write-tree` race a user
    commit; serialize daemon git ops per-repo.
  - **Restart consistency:** an autopilot crash mid-checkpoint must leave the ref
    chain browsable (`git log refs/spark/runs/{runId}`); parent each checkpoint to
    the prior one (already the design) so a partial write is a missing tip, not a
    corrupt chain.
  - **Worktrees:** copy-branch workspaces are separate worktrees
    (`git-worktrees.ts`); the daemon must resolve the correct `cwd` per run from
    `run.settingsSnapshot.workspaceCwd` (as `agent-socket.ts:458` already does)
    so the shadow ref lands in the right repo.

### Phase 4 — Remote attach over SSH

Run the daemon on a remote host; attach the desktop UI over a tunnel.

- **Moves out of `run-store.ts`:** nothing new — Phase 4 is a **transport
  change**, not a code-ownership change. The daemon already owns everything by
  Phase 3.
- **Stays:** the entire daemon verb set and the `DaemonClient`. Only endpoint
  resolution and auth transport change.
- **IPC verbs added:** none semantically new; `daemon.attach` gains a remote
  descriptor variant. The `daemon-socket.json` handshake file becomes a **remote
  endpoint descriptor** (host\:port reachable through the tunnel) and the bearer
  token is carried over the SSH-forwarded loopback port. Because the client
  already only knows "an URL + a bearer from a handshake file," pointing it at a
  forwarded port is a config change, not a code rewrite.
- **Rollback / compile-gate:** local daemon remains the default; remote attach is
  opt-in via a connection profile. If the tunnel drops, the client reconnects
  using the same `streamEvents` resume logic as a local reconnect. Gate:
  `typecheck:node` + an integration test against a daemon on a second loopback
  port standing in for "remote."
- **Risks:**
  - **PTY streams over a high-latency link** — the `daemon.terminal.stream`
    frames need batching/coalescing so a slow tunnel doesn't make the terminal
    feel laggy; reuse the tail-read fallback (`terminal.read`) for catch-up.
  - **Auth surface widens** beyond a single trusted local machine: the bearer is
    now only as safe as the SSH tunnel; never expose `/rpc` on a non-loopback
    bind without the tunnel.
  - **Clock/path skew** between the desktop and the remote box — run `cwd`s,
    workspace roots, and `sparkHome()` paths are remote-side; the renderer must
    stop assuming local filesystem access for run artifacts and read them through
    the daemon.

---

## 4. Non-goals (for the Phase 0 scaffold)

- **No server is started.** `registerDaemonHostScaffold()` binds no port, writes
  no handshake file, and registers no JSON-RPC handler. It only makes the new
  modules reachable from boot.
- **No `run-store.ts` rewiring.** The autopilot loop, PTY ownership, and
  checkpoints are untouched. `run-store.ts` gains at most a comment marking the
  headless entry (`startAutopilot` @ `run-store.ts:411`); no behavior changes.
- **No renderer changes.** `DaemonClient` exists but nothing in
  `src/renderer/**` imports it. The renderer still uses `orchestration:*` IPC and
  the `orchestration:event` channel exclusively.
- **No `event-log.ts` edit.** It already exports `subscribeToEvents` and the
  `SparkEvent` type the daemon needs; the scaffold consumes those, it does not
  modify the fan-out.
- **No detached child process yet.** Even when wired (Phase 1), the host first
  runs **in-process** with Electron main; spawning a real separate OS process is
  deferred until the in-process contract is proven, to avoid taking on process
  lifetime / serialization / orphan-cleanup risk before the verb surface is
  stable.
- **No new third-party dependency.** Transport reuses `node:http` +
  `node:crypto` exactly as `agent-socket.ts` does; no `npm install`.
- **No removal of the headless eval path.** `runHeadlessEval` remains the
  canonical renderer-free driver and the behavior oracle the daemon is validated
  against — they share `startAutopilot`, so they must not diverge.
