# Spark Agent Progress

This file tracks what has been decided and completed so we do not lose the
thread between build sessions.

## Current Direction

Spark Agent is a local-first desktop orchestration app. The current workbench
already gives us workspace selection, terminals, file tree/editor surfaces, and
git context. The next goal is to add durable orchestration state and events
before adding OpenRouter, Claude/Codex workers, or graph visualization.

## Product Decisions

- The file tree should show dotfiles and project config files. Do not hide
  `.gitignore`, `.env.example`, `.spark/`, or similar project files by default.
- The app owns state, events, logs, artifacts, safety checks, and terminal
  execution.
- Spark should receive compact context packets, not raw terminal logs or full
  repository dumps.
- Terminals are execution surfaces, not the source of truth.
- Build order should stay conservative: state/events first, Dev Inspector next,
  visual map after that, real workers later, OpenRouter after the runtime is
  observable.

## Completed

- Read the existing project structure and local docs.
- Confirmed the current repo is an Electron + Vite + React + TypeScript app.
- Confirmed current app has workspace rail, workspace persistence, terminal
  tiles, shell detection, file tree, editor panes, git graph, status bar, and a
  placeholder Spark panel.
- Confirmed `npm run typecheck` passes.
- Confirmed `npm run build` passes.
- Added `README-dev.md` with current app structure, commands, build gates, and
  next engineering slice.
- Updated the local build plan so Phase 0 no longer asks to hide dotfiles.
- Added Phase 1 shared orchestration types for runs, plans, steps, worker tasks,
  worker attempts, Spark calls, context packets, review decisions, and events.
- Added a main-process JSONL event log and run store under Electron userData.
- Added orchestration IPC/preload APIs for creating/listing runs, listing
  events, appending test events, and subscribing to live events.
- Added temporary Spark panel controls for creating a test run, appending a test
  event, and viewing latest events for the active workspace.
- Manually validated in the Electron UI that events show up in the Spark panel
  after creating a run and appending test events.
- Added Phase 2 Dev Inspector MVP.
- Moved raw event display out of `SparkAgentPanel`.
- Kept `SparkAgentPanel` focused on high-level run controls and run selection.
- Added Dev Inspector Events, State, and Artifacts sections.
- Added selected-event JSON view.
- Added current `RunState` JSON and workspace info view.
- Added concrete artifact paths for the run folder, `run.json`, and
  `events.jsonl`.
- Added Explorer right-click actions for file rename and move-to-trash.
- Added Phase 3 run mutation APIs for run status updates, step create/update,
  worker task create/update, and run deletion.
- Added Dev Inspector validation controls for mutating the active run and
  confirming the matching `run.json` and event stream updates.
- Added Phase 4 worker task envelope preparation without launching workers.
- Added artifact writing for prepared worker tasks: `task.json`, `prompt.md`,
  and `workpad.md`.
- Added Dev Inspector artifact display for prepared worker attempts.

## Current State

The app is still mostly a terminal/workspace workbench, but it now has the first
durable orchestration foundation.

Implemented foundation:

- `RunState`
- `PlanState`
- `StepState`
- `WorkerTask`
- `WorkerAttempt`
- `SparkEvent`
- `SparkCall`
- `ContextPacket`
- `ReviewDecision`
- JSONL event log
- run store
- orchestration IPC/preload API

Missing foundation:

- run state projection from events
- persisted settings
- diagnostics
- real worker process launch and log capture

## Next Step

Finish Phase 4 validation, then move toward controlled worker execution.

Immediate target:

```text
Inspector validation:
  confirm event stream and run.json stay in sync
  add explicit refresh/reload behavior where needed

Worker preparation validation:
  create run -> step -> task -> prep
  confirm task.json, prompt.md, and workpad.md are written
  confirm worker_task.envelope_prepared event is emitted
  confirm RunState has a prompt_ready WorkerAttempt

Controlled execution:
  launch prepared manual workers from task envelopes
  capture stdout/stderr/raw logs as artifacts
  keep all worker output tied back to run state and events
```
