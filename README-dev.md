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
- User settings are persisted to `spark-settings.json` under Electron userData.
- Terminal tiles are backed by `node-pty` and survive workspace tab switches.
- The file tree intentionally shows dotfiles and project files as-is.
- Text files can be opened and edited from the file tree.
- File rows in the Explorer support right-click rename and move-to-trash.
- The left rail shows git branch/log information when the workspace is a repo.
- The app scans the active workspace for Markdown files and exposes them as
  selectable project plans.
- `SparkAgentPanel` is the simple user surface: select a Markdown plan, click
  `RUN`, stop/resume, and send guidance or answers.
- The window Settings button opens tabbed settings for the default terminal,
  the OpenRouter API key/model used by Spark manager planning, and optional
  LangSmith tracing for manager calls.
- `DevInspector` shows raw orchestration events, selected event JSON, current
  run state, workspace info, and artifact paths.
- Worker task records can be prepared into non-executing envelopes that write
  `task.json`, `prompt.md`, and `workpad.md` artifacts.
- Prepared worker attempts launch through hidden PTY-backed worker sessions.
  Spark owns Claude/Codex runtime selection; the user should not need to
  configure per-task worker routing.
- Spark worker attempts also appear as visible attach-mode panes in the
  Workers tab. The visible terminal attaches to the orchestration PTY session
  instead of spawning a second process.
- Worker PTY sessions resize through the same renderer path as normal terminal
  panes, and initial prompts are written in small chunks before Spark sends the
  submit keystroke.
- For normal Claude/Codex workers, Spark starts the user's configured default
  terminal first, then types the selected worker CLI command into that terminal.
  This keeps worker panes behaving like user-opened terminals instead of
  directly spawning a bare `claude.exe` or `codex.cmd` process.
- When `SPARK_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY` is configured,
  Spark asks OpenRouter for manager decisions before creating worker tasks.
  Manager calls write `spark_call.*` events and durable
  request/response/parsed-decision artifacts.
- OpenRouter manager calls use strict structured outputs with
  `response_format.type = "json_schema"`, `strict: true`, and provider
  `require_parameters: true` so Spark gets schema-shaped decisions or a clear
  provider failure. If the selected manager model cannot handle strict JSON
  Schema, Spark automatically retries the same manager call with a
  structured-output fallback model and records `spark_call.model_fallback`.
- When LangSmith tracing is configured, Spark also sends manager request and
  response traces to LangSmith while still making the actual model request
  through OpenRouter.
- Worker sessions capture `stdout.log`, `stderr.log`, `raw.log`, and
  `final-report.json`; `STOP` and `RESUME` write control input into the active
  session. Raw PTY output is streamed to the terminal and log files instead of
  being written as one event per output chunk.
- Autopilot has a first one-button manager cycle: create/reuse a run, ask the
  OpenRouter-backed Spark manager for a step-by-step plan division, wipe the
  manager context down to the selected plan plus that division, ask for first
  step worker prompts, prepare worker envelopes, launch controlled workers in
  the background, and return to review. Without an OpenRouter key the app asks
  the user to configure the manager model instead of silently launching the
  manual test runner. The plan text comes from the selected Markdown file.
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
- Worker prompts include the selected project plan, the manager's step-by-step
  division, the assigned step, the focused worker task, constraints,
  verification commands, and final-report schema.
- After all parallel workers in a cycle finish, Spark performs a manager review
  call with compact worker report summaries. The manager can mark the run
  complete, create follow-up workers, or ask the user for clarification.
- The primary Spark panel shows a compact `SPARK DECISION` summary for the
  latest manager call; raw event/state/artifact JSON stays in Dev Inspector.
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
runs/<run-id>/spark-calls/<spark-call-id>/request.json
runs/<run-id>/spark-calls/<spark-call-id>/response.json
runs/<run-id>/spark-calls/<spark-call-id>/parsed-decision.json
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/task.json
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/prompt.md
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/workpad.md
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/stdout.log
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/stderr.log
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/raw.log
runs/<run-id>/steps/<step-id>/workers/<worker-task-id>/attempts/<attempt-id>/final-report.json
```

## Current Engineering Step

Do not add the orchestration graph before the runtime remains observable. The
current foundation includes the Dev Inspector MVP:

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
  OpenRouter-backed initial manager planning
  visible attach-mode worker terminal panes
  worker task envelope preparation
  background PTY-backed worker session execution
  worker report parsing and deterministic review decisions
  OpenRouter-backed manager review after worker completion
```

This keeps the product rule intact:

```text
State is truth.
Events explain state changes.
Terminals are execution surfaces, not the source of truth.
Spark receives compact context packets, not raw logs.
```

## Manager And Worker Configuration

OpenRouter manager settings are available in the app Settings dialog under
`API + MODEL`. LangSmith tracing settings are in the same tab and are optional.
Environment variables are still supported for local development:

```bash
SPARK_OPENROUTER_API_KEY=...
SPARK_OPENROUTER_MODEL=google/gemini-flash-latest
SPARK_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
SPARK_OPENROUTER_STRUCTURED_FALLBACK_MODEL=openai/gpt-4o-mini
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=spark-agent-dev
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

`OPENROUTER_API_KEY` is also accepted. The model defaults to
`google/gemini-flash-latest`. If that selected model cannot serve strict
`json_schema`, Spark retries with `openai/gpt-4o-mini` by default. Saved app
settings take precedence over the API key and model environment variables.
`LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`, and `LANGCHAIN_ENDPOINT` are also
accepted as LangSmith aliases.

Local worker command routing is Spark-owned. These environment variables exist
for development and deterministic tests, not as a normal user setup surface:

```bash
SPARK_CLAUDE_WORKER_COMMAND=claude
SPARK_CLAUDE_WORKER_ARGS=
SPARK_CODEX_WORKER_COMMAND=codex
SPARK_CODEX_WORKER_ARGS=
```

The args variables accept either a JSON string array or a simple shell-style
argument string. On Windows the built-in defaults are `claude.exe` and
`codex.cmd` so the visible worker panes open the real local CLIs when those are
available on `PATH`. For real Claude/Codex workers, Spark opens the configured
default shell, runs
`claude --dangerously-skip-permissions --model <model> --effort <level>` or
`codex --yolo -m <model> -c 'model_reasoning_effort="<level>"'`, then sends the
full prepared task prompt after the CLI has started producing output when
possible, with a bounded fallback delay. Spark then sends the submit keystroke
as a separate delayed PTY write after prompt chunks finish so Claude/Codex
should run automatically without the human pressing Enter. The prompt artifact
path is still included for traceability, but the worker should not only see a
generic "read this file" wrapper.

The manager model does not return terminal launch commands. Its structured
output contains the worker runtime, model hint, effort hint, and task details;
the app reads that JSON and opens the corresponding terminal sessions itself.

Initial manager planning is scheduled in the background. The `RUN` action
creates/updates the run and returns control to the UI while OpenRouter plan
analysis, first-step worker prompt planning, worker preparation, and worker
launch events stream into the Dev Inspector. When the manager returns
split-safe Claude/Codex tasks, Spark schedules those worker attempts in
parallel and shows them as normal terminal panes.

Worker completion now feeds back into the manager. Spark reads the finished
attempts' `final-report.json` files, sends compact report context in a
`worker_result_review` manager call, and applies the next manager decision. A
`complete` decision marks the run complete; a `run_workers` decision creates
the next focused worker tasks and schedules another cycle; an `ask_user`
decision writes a Spark question into the run message stream and pauses.
If the human answers in the text box and clicks `RESUME`, Spark now resumes
manager planning when there are no active worker sessions yet. This covers the
real flow where the manager asks a clarification question before creating the
Claude/Codex worker tasks.

Real user-flow test:

```bash
npm run test:user-flow
```

This builds the app, launches Electron through Playwright, uses the real test
workspace at `C:\Users\Etienne\Documents\workspace\test`, copies the saved Spark
settings into an isolated test userData folder, selects `plan.md`, calls the
real OpenRouter manager, handles a manager question if one appears, verifies
that real Claude/Codex worker terminal panes open, and then sends `STOP`.

Test-only fallback:

```bash
SPARK_ENABLE_MANUAL_FALLBACK=1
```

This enables the manual runner used by E2E tests. Normal app runs should use
OpenRouter manager planning plus real Claude/Codex worker commands.
