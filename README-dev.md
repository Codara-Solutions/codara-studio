# Spark Agent Developer Notes

Spark Agent is currently an Electron + React + TypeScript desktop app for local
workspace control. The present build is a stable workbench skeleton: workspace
selection, terminal tiles, shell detection, file browsing, lightweight editing,
and git graph display.

The next product direction is to turn this workbench into a local-first AI
coding orchestration runtime. The app should own durable state, events, logs,
artifacts, safety checks, and terminal execution. Spark, the orchestrator model,
should make compact structured decisions, drive the default autopilot flow, and
ask the human only when blocked or when approval is needed. Claude Code and
Codex CLI workers should execute focused local tasks.

## Project Structure

```text
src/main/
  index.ts          Electron app entry point and BrowserWindow setup
  ipc.ts            Main-process IPC handlers exposed to the renderer
  storage.ts        Workspace UI state persistence in app userData
  pty-manager.ts    node-pty session lifecycle and terminal streaming
  orchestration/worker-session.ts
                    Hidden PTY-backed worker session lifecycle
  shells.ts         Cross-platform shell detection
  fs-tree.ts        File tree listing, Markdown plan discovery, and text helpers
  git-graph.ts      Git branch and log summary helpers

src/preload/
  index.ts          Context-isolated window.spark API bridge
  preload-types.d.ts

src/shared/
  types.ts          Shared serializable types used by main/preload/renderer

src/renderer/
  index.html
  src/App.tsx       Main workbench state and layout
  src/components/   Workspace rail, terminals, file tree, editor, git graph
  src/styles.css    Global app styling

local-docs/
  Spark-Agent-Project-Description.md
  Spark-Agent-Build-Plan.md
```

`local-docs/` is intentionally ignored by git. Treat it as local planning
context rather than product source.

## Current Behavior

- Workspaces are created by selecting a local directory.
- Workspace state is persisted to `spark-state.json` under Electron userData.
- Terminal tiles are backed by `node-pty` and survive workspace tab switches.
- The file tree intentionally shows dotfiles and project files as-is.
- Text files can be opened and edited from the file tree.
- File rows in the Explorer support right-click rename and move-to-trash.
- The left rail shows git branch/log information when the workspace is a repo.
- The app scans the active workspace for Markdown files and exposes them as
  selectable project plans.
- `SparkAgentPanel` is the simple user surface: select a Markdown plan, click
  `RUN`, stop/resume, and send guidance or answers.
- `DevInspector` shows raw orchestration events, selected event JSON, current
  run state, workspace info, and artifact paths.
- Worker task records can be prepared into non-executing envelopes that write
  `task.json`, `prompt.md`, and `workpad.md` artifacts.
- Prepared worker attempts launch through hidden PTY-backed worker sessions.
  The manual runner is still the default test runtime, and Claude/Codex
  runtimes can be routed through configured commands when tasks request them.
- Worker sessions capture `stdout.log`, `stderr.log`, `raw.log`, and
  `final-report.json`; `STOP` and `RESUME` write control input into the active
  session.
- Autopilot has a first one-button manager cycle: create/reuse a run, create
  the first step/task if needed, prepare a worker envelope, launch the
  controlled worker in the background, and return to review. The plan text
  comes from the selected Markdown file.
- Selected Markdown plans are persisted in `RunState.plans` with `sourceFile`
  and raw content so future planning/review steps can trace the run input.
- Runs can be paused, resumed, and annotated with durable human messages. These
  messages are the path for corrections, answers, and future Spark
  clarification questions.
- Pausing a run sends an Esc control signal to active worker attempts before the
  run is marked paused. Resuming sends active workers either plain `continue` or
  a Spark manager update built from the user's pause reason/latest message.
- Finished worker attempts parse `final-report.json` and emit deterministic
  `worker_report.parsed` and `worker_report.reviewed` events.
- The app has an initial orchestration run store and JSONL event log under
  Electron userData.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run start
npm run test:e2e
```

Packaging commands:

```bash
npm run package:win
npm run package:mac
npm run package:linux
```

## Build Gates

Before committing functional changes, run:

```bash
npm run typecheck
npm run build
npm run test:e2e
```

For UI/terminal changes, also manually verify:

```text
Create workspace
Open terminal tile
Run pwd / dir
Resize app
Close terminal tile
Open files from the tree
Restart app
Confirm workspace persists
```

## Orchestration Foundation

The first orchestration slice is in place:

```text
RunState
PlanState
StepState
WorkerTask
WorkerAttempt
SparkEvent
SparkCall
ContextPacket
ReviewDecision
AutopilotState
HumanRunMessage
```

Main-process services:

```text
src/main/orchestration/event-log.ts
src/main/orchestration/run-store.ts
```

IPC/preload surface:

```text
orchestration:createRun
orchestration:getRun
orchestration:listRuns
orchestration:listEvents
orchestration:appendTestEvent
orchestration:onEvent
orchestration:getArtifactPaths
orchestration:updateRunStatus
orchestration:startAutopilot
orchestration:pauseRun
orchestration:resumeRun
orchestration:addRunMessage
orchestration:createStep
orchestration:updateStep
orchestration:createWorkerTask
orchestration:updateWorkerTask
orchestration:prepareWorkerTask
orchestration:launchWorkerAttempt
orchestration:deleteRun
```

Workspace filesystem IPC also includes:

```text
fs:listMarkdownFiles
```

Run state is stored separately from workspace UI state. Run data lives under
Electron userData:

```text
runs/<run-id>/run.json
runs/<run-id>/events.jsonl
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/task.json
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/prompt.md
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/workpad.md
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/stdout.log
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/stderr.log
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/raw.log
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/final-report.json
```

## Current Engineering Step

Do not add OpenRouter, Claude/Codex launchers, or the orchestration graph before
the runtime remains observable. The current foundation includes the Dev
Inspector MVP:

```text
Events tab:
  event list
  selected event JSON
State tab:
  current RunState JSON
  workspace info
Artifacts tab:
  run folder
  run.json path
  events.jsonl path
Run mutations:
  autopilot start
  pause/resume with active worker control signals
  durable human messages
  worker task envelope preparation
  background PTY-backed worker session execution
  worker report parsing and deterministic review decisions
```

This keeps the product rule intact:

```text
State is truth.
Events explain state changes.
Terminals are execution surfaces, not the source of truth.
Spark receives compact context packets, not raw logs.
```
