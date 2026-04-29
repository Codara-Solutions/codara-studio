# Spark Agent Developer Notes

Spark Agent is currently an Electron + React + TypeScript desktop app for local
workspace control. The present build is a stable workbench skeleton: workspace
selection, terminal tiles, shell detection, file browsing, lightweight editing,
and git graph display.

The next product direction is to turn this workbench into a local-first AI
coding orchestration runtime. The app should own durable state, events, logs,
artifacts, safety checks, and terminal execution. Spark, the orchestrator model,
should make compact structured decisions. Claude Code and Codex CLI workers
should execute focused local tasks.

## Project Structure

```text
src/main/
  index.ts          Electron app entry point and BrowserWindow setup
  ipc.ts            Main-process IPC handlers exposed to the renderer
  storage.ts        Workspace UI state persistence in app userData
  pty-manager.ts    node-pty session lifecycle and terminal streaming
  shells.ts         Cross-platform shell detection
  fs-tree.ts        File tree listing and text file read/write helpers
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
- `SparkAgentPanel` has high-level controls for test runs and test events.
- `DevInspector` shows raw orchestration events, selected event JSON, current
  run state, workspace info, and artifact paths.
- Runs can be updated through dev controls for status changes, step creation,
  worker task creation, and run deletion.
- The app has an initial orchestration run store and JSONL event log under
  Electron userData.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run start
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
orchestration:createStep
orchestration:updateStep
orchestration:createWorkerTask
orchestration:updateWorkerTask
orchestration:deleteRun
```

Run state is stored separately from workspace UI state. Run data lives under
Electron userData:

```text
runs/<run-id>/run.json
runs/<run-id>/events.jsonl
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
  status updates
  step create/update
  worker task create/update
  run delete
```

This keeps the product rule intact:

```text
State is truth.
Events explain state changes.
Terminals are execution surfaces, not the source of truth.
Spark receives compact context packets, not raw logs.
```
