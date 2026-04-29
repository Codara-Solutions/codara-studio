# Spark Agent Progress

This file tracks what has been decided and completed so we do not lose the
thread between build sessions.

## Current Direction

Spark Agent is a local-first desktop orchestration app. The current workbench
already gives us workspace selection, terminals, file tree/editor surfaces, and
git context. The next goal is to turn the durable orchestration foundation into
a simple manager flow where the human can hand Spark a complete plan, click
run, pause if the direction looks wrong, add guidance, and resume without
understanding the low-level worker machinery.

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
- The primary product mode should be autopilot: Spark reads the plan, creates
  steps/tasks, prepares workers, executes them, reviews progress, and only asks
  the human when blocked or when approval is needed.
- Manual mode should remain available for advanced use: create tasks, launch
  workers, open panes, inspect artifacts, and steer specific agents directly.
- Users must be able to stop a run, say what they want changed, and resume.
  Those messages are part of the run record, not transient UI state.
- Stop should send an interrupt-style signal to active worker terminals or
  processes. Resume should let Spark decide whether a worker receives plain
  `continue` or a new manager prompt based on the user's correction.
- Most users will provide the project plan as a Markdown file in the workspace.
  The primary Spark panel should let them select that file and run it, instead
  of making them understand step/task/prepare/execute controls.
- The user should not configure Claude/Codex worker routing for normal use.
  Spark owns worker selection and should decide whether Claude, Codex, shell,
  or no worker is appropriate for each task.
- The manager loop should first create a durable step-by-step division of the
  selected plan. After that, worker planning should use a compact context made
  from the project plan plus that step division, not the full earlier manager
  conversation.
- OpenRouter manager calls should use strict JSON Schema structured outputs,
  not loose JSON mode, so malformed manager decisions fail clearly.

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
- Validated in the UI that `CREATE -> STEP -> TASK -> PREP` writes the envelope
  artifacts and emits `worker_task.envelope_prepared`.
- Added a controlled manual worker execution MVP.
- Added `orchestration:launchWorkerAttempt` to launch prepared attempts.
- Added worker attempt lifecycle events for launch request, running, stdout,
  stderr, and finished.
- Added worker execution artifacts: `stdout.log`, `stderr.log`, `raw.log`, and
  `final-report.json`.
- Added an `EXEC` control in the Spark panel and Dev Inspector artifact paths
  for worker logs.
- Added Playwright Electron E2E coverage for
  `CREATE -> STEP -> TASK -> PREP -> EXEC`.
- Added isolated test userData support through `SPARK_USER_DATA_DIR`.
- Confirmed `npm run test:e2e` passes against the real Electron UI.
- Added the first Autopilot Run MVP controls.
- Added durable `autopilot` state on runs.
- Added durable human/Spark run messages for corrections, answers, and future
  clarification questions.
- Added `AUTO`, `STOP`, `RESUME`, and `SEND` controls to the Spark panel.
- Added orchestration APIs for starting autopilot, pausing runs, resuming runs,
  and recording run messages.
- Added an initial one-button manager cycle: create/reuse run, create the first
  step/task if needed, prepare a worker envelope, launch the controlled worker,
  and return to review.
- Added E2E coverage for pause/message/resume and the one-button autopilot
  cycle.
- Simplified the primary Spark panel by removing dev-stage buttons from the
  main user surface.
- Added workspace Markdown plan discovery for `.md` files.
- Added a plan selector so the user can choose a plan file from the project and
  click `RUN`.
- Autopilot now stores the selected plan as `PlanState` with `sourceFile` and
  raw Markdown content.
- Updated E2E coverage so the primary flow starts from a selected `PLAN.md`
  file.
- Fixed compact-window right sidebar layout so the Spark panel, Dev Inspector,
  and Explorer stay ordered instead of visually overlapping.
- Added E2E coverage for compact-window sidebar ordering.
- Added active worker process tracking for launched worker attempts.
- `STOP` now sends an Esc control signal to active worker attempts before
  marking the run paused.
- `RESUME` now sends active workers either `continue` or a manager update prompt
  built from the user's pause reason or latest message.
- The controlled manual worker runner now understands pause/resume input so the
  same contract can be used by real terminal-backed Claude/Codex workers later.
- Autopilot worker cycles now run in the background instead of blocking the
  `RUN` request.
- Added an `autopilot.cycle_scheduled` event so the UI can observe that manager
  work has been handed off.
- Added background-cycle failure handling that marks the run/autopilot failed
  and records `autopilot.cycle_failed`.
- Updated E2E coverage to stop a delayed active worker, resume it with user
  guidance, and wait for the background cycle to complete.
- Added hidden PTY-backed worker sessions for orchestration worker attempts.
- Replaced direct child-process worker control with terminal-style session
  control so `STOP` and `RESUME` write into the same path real Claude/Codex
  workers will use.
- Added configurable Claude/Codex worker command routing through
  `SPARK_CLAUDE_WORKER_COMMAND`, `SPARK_CLAUDE_WORKER_ARGS`,
  `SPARK_CODEX_WORKER_COMMAND`, and `SPARK_CODEX_WORKER_ARGS`.
- Added the first OpenRouter-backed Spark manager adapter.
- Spark can now use `SPARK_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY` plus
  `SPARK_OPENROUTER_MODEL` to ask a cheap manager model for initial steps and
  worker tasks.
- Added durable Spark call artifacts under `runs/<run-id>/spark-calls/`:
  `request.json`, `response.json`, and `parsed-decision.json`.
- Added `spark_call.started`, `spark_call.completed`, `spark_call.failed`, and
  `spark_manager.decision_applied` events.
- Added a fake-OpenRouter Electron E2E test that verifies Spark can plan
  fixture Claude/Codex tasks, route both through configured worker commands,
  and review both reports.
- Fixed the first multi-worker scheduling race by preparing selected attempts
  before scheduling launches and queueing the background launches sequentially.
- Added visible attach-mode worker panes in the Workers tab for Spark-launched
  attempts.
- The visible worker terminal attaches to the orchestration PTY session, so
  Claude/Codex output and user input go through the same worker process Spark is
  tracking.
- Windows defaults now use `claude.exe` and `codex.cmd` for real local worker
  launches when no explicit worker command env vars are set.
- Normal app runs no longer silently launch the manual test runner when
  OpenRouter is missing. Spark asks the user to configure the manager model
  instead; `SPARK_ENABLE_MANUAL_FALLBACK=1` keeps the E2E fallback available.
- Shell detection now also checks `where pwsh` so packaged/WindowsApps
  PowerShell 7 installs are detected and preferred as the default terminal.
- Spark worker panes are not persisted to `spark-state.json`; they are runtime
  views of active orchestration sessions.
- Updated E2E coverage to verify that planned Claude and Codex worker panes are
  visible in the Workers tab.
- Made the Settings button open a real tabbed settings dialog.
- Added persisted user settings in `spark-settings.json`.
- Added a Default Terminal settings tab that controls which detected shell new
  manual worker panes use.
- Added an API + Model settings tab for the OpenRouter API key and manager
  model, and wired those settings into Spark manager planning.
- Restored run deletion from the primary Spark panel with an inline two-step
  `DELETE RUN` / `CONFIRM DELETE` action instead of a native popup.
- Run deletion now disposes active worker sessions for that run before removing
  the run artifact folder.
- Added `final-report.json` parsing and deterministic worker review events:
  `worker_report.parsed`, `worker_report.reviewed`, and
  `worker_report.missing`.
- Added run-save serialization and Windows-safe temp-file replacement so
  concurrent pause/resume/worker-finish writes do not strand `run.json.tmp`.
- Tightened right-sidebar sizing so the Dev Inspector remains visible above the
  Explorer in the normal app viewport.
- Updated E2E coverage to verify worker report review and the Artifacts tab
  final report path.
- Moved initial OpenRouter manager planning fully into the background so
  clicking `RUN` returns control to the UI immediately instead of waiting on
  the model call.
- Changed split-safe worker scheduling so Claude/Codex attempts launch in
  parallel instead of waiting for the previous worker to exit.
- Worker launch prompts now include the submit keystroke after a short startup
  delay, so the prompt is sent to interactive CLIs instead of only being typed.
- Spark-launched worker panes now use the same terminal header style as normal
  user-created terminals instead of naming panes `CLAUDE` or `CODEX`.
- Updated E2E coverage for background planning, visible worker panes, settings,
  run deletion, and parallel fake Claude/Codex worker routing.
- Added the first manager review loop after worker completion. Once all
  parallel worker attempts finish, Spark sends accepted worker report summaries
  back through OpenRouter and can mark the run complete, create follow-up
  workers, or ask the user a question.
- Added a compact `SPARK DECISION` summary to the primary panel so the user can
  see the manager's latest action without opening raw Dev Inspector JSON.
- Hardened interactive Claude/Codex prompt sending by waiting for terminal
  output when possible, with a bounded fallback delay.
- Updated E2E coverage so fake Claude/Codex workers complete, Spark performs a
  second manager review call, and the run is marked complete.
- Added `npm run test:user-flow`, a real-flow Playwright test that uses
  `C:\Users\Etienne\Documents\workspace\test`, copies the saved Spark settings
  into isolated userData, selects `plan.md`, calls the real OpenRouter manager,
  launches real Claude/Codex worker panes, and sends `STOP` after launch
  verification.
- Fixed the paused question path: when Spark asks the user a question before
  workers exist, the user can answer, click `RESUME`, and Spark calls the
  manager again with the updated run messages.
- Split initial manager work into `plan_analysis` and `step_planning`.
  `plan_analysis` creates the durable step-by-step division only. Then
  `step_planning` receives the selected plan plus that division and creates
  focused worker prompts for the first executable step.
- Updated worker prompts so Claude/Codex receive the selected plan, full step
  division, assigned step, focused task, constraints, verification commands,
  and final-report schema.
- Fixed worker terminal launch input so Claude/Codex receive the full prepared
  structured prompt in the terminal, not only the old generic "read prompt.md"
  wrapper. The prompt artifact path remains appended for traceability.
- Changed interactive worker launch to send the full prompt and the submit
  keystroke as separate delayed PTY writes so Claude/Codex should start without
  the user pressing Enter manually.
- Stopped writing every PTY stdout/stderr chunk as a durable event. Terminal
  output still streams live and is written to `stdout.log`, `stderr.log`, and
  `raw.log`, but the Dev Inspector event list should no longer flood.
- Added optional LangSmith tracing for Spark manager calls. Requests still go
  to OpenRouter, while LangSmith receives separate trace records for the
  manager prompt, response, parsed decision, and errors. Tracing can be
  configured through Settings or `LANGSMITH_*` / `LANGCHAIN_*` environment
  variables.
- Updated the manager prompt policy with researched prompt-engineering
  principles: clear success criteria, delimited context, plan-before-execute,
  compact worker context, independent parallelism only, grounded evidence, and
  concise user questions when blocked.
- Replaced the terse manager prompt with an orchestrator prompt that describes
  Spark's real job: preserve compact context, create durable step batches,
  generate worker prompts only after the step division exists, avoid worker
  collisions, and review worker evidence.
- Switched OpenRouter manager requests from basic JSON mode to strict
  `json_schema` structured outputs with `strict: true` and provider
  `require_parameters: true`.
- Added an automatic strict structured-output fallback model. If the selected
  OpenRouter manager model cannot handle `json_schema`, Spark retries the same
  manager call with `SPARK_OPENROUTER_STRUCTURED_FALLBACK_MODEL` or the default
  `openai/gpt-4o-mini`, then records `spark_call.model_fallback`.
- Made worker PTY sessions resize through the same app path as normal terminal
  panes.
- Changed initial worker prompt submission to write prompts in small PTY chunks
  and send Enter only after the chunks finish, which should make Claude/Codex
  panes behave closer to normal user-opened terminals.
- Changed normal Claude/Codex worker launch to open the user's configured
  default terminal first, then run the selected worker CLI command inside it.
  Spark now uses Claude Code `--dangerously-skip-permissions`, `--model`, and
  `--effort`, plus Codex `--yolo`, `-m`, and `model_reasoning_effort`
  arguments derived from the manager's modelHint and effortHint.
- The manager structured output does not include launch commands. Spark reads
  runtimePreference/modelHint/effortHint from JSON and the app builds and runs
  the actual terminal commands.
- Extended the manager step division schema with planned agents so the saved
  plan can look like `agent 1 -> overview -> model -> thinking level` before
  the context is wiped for worker prompt generation.
- Confirmed `npm run typecheck` and deterministic `npm run test:e2e` pass after
  the prompt-loop split. The real user-flow test remains explicit because it
  launches real local workers.

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
- `AutopilotState`
- `HumanRunMessage`
- JSONL event log
- run store
- orchestration IPC/preload API

Missing foundation:

- run state projection from events
- diagnostics
- production defaults for Spark-owned Claude/Codex worker launch
- richer Claude/Codex terminal startup detection beyond output-aware prompt
  send
- cancellation and timeout handling
- a dedicated advanced/manual control surface outside the primary Spark panel
- a long-running autopilot loop with retry/follow-up/question policies across
  many steps
- Spark-generated plan analysis and task decomposition beyond the initial
  manager-decision spike
- CI-safe separation between deterministic fake-worker tests and explicit
  local real-worker tests

## Next Step

Harden the manager loop for real projects and long-running workers.

Immediate target:

```text
Autopilot prompt and behavior hardening:
  build a small prompt-eval fixture set for different project plans
  test whether Spark produces good step divisions before launching workers
  test whether first-step worker prompts are specific enough for Claude/Codex
  turn deterministic report review into accept/retry/follow-up/question actions
  add cancellation and timeouts before long-running real Claude/Codex sessions
  add a stronger user-facing activity/decision timeline
  keep npm run test:user-flow as the explicit local smoke test, not the default
```
