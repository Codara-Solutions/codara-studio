# Spark Agent Build Plan

This plan starts from the current uploaded app: Electron, React, xterm terminal tiles, workspace selection, file explorer, shell detection, and a placeholder Spark panel.

## Phase 0 — Stabilize what already exists

Status: first pass applied in this package.

Done in this cleanup:

- fixed file explorer skip logic so `.git`, `node_modules`, build outputs, and most dotfiles do not flood the UI
- added max entries per directory
- batched PTY output in the Electron main process
- batched xterm writes in the renderer using animation frames
- reduced terminal scrollback from 5000 to 2000
- removed web-link scanning from terminal output for now
- debounced terminal resize work
- added Claude Code / Codex CLI diagnostics
- kept auth-related environment variables available to worker terminals
- added this docs set and better prompt templates

Test this phase:

1. Run `npm run dev`.
2. Open a repo that has `node_modules` and `.git`.
3. Confirm the explorer opens quickly and does not show huge hidden folders.
4. Open 3–6 terminal tiles.
5. Run a noisy command in one tile:

```bash
yes "spark terminal stress test" | head -n 5000
```

6. Confirm the app remains usable.

## Phase 1 — Event log and real run state

Build the state system before building the Spark brain.

Add types:

- `RunState`
- `StepState`
- `WorkerTask`
- `WorkerAttempt`
- `WorkerReport`
- `ReviewDecision`
- `SparkCall`
- `ContextPacket`
- `SparkEvent`

Add an append-only event log:

```text
run.created
plan.imported
spark.call.started
spark.call.completed
step.created
worker.task.created
worker.attempt.started
worker.output.chunk
worker.attempt.completed
worker.report.parsed
review.started
review.completed
step.completed
run.completed
```

The UI should read from state/events. Do not infer state from terminal logs.

## Phase 2 — Dev Inspector

Before full automation, build the debugging surface.

Minimum Dev Inspector tabs:

- Events
- Spark Calls
- Worker Prompts
- Worker Output
- Context Packets
- State JSON

Each Spark call should store:

- mode
- model
- input messages
- schema
- raw response
- parsed response
- validation errors
- token/cost metadata when available

Each worker attempt should store:

- command
- cwd
- prompt file
- raw log
- final report
- exit code
- duration

## Phase 3 — Plan import and project map

Add plan import:

- select Markdown/text file
- store plan path
- store plan content snapshot
- create plan summary

Add project map:

- package manager
- frameworks
- main directories
- ignored directories
- scripts from package.json
- git status
- likely test/typecheck commands

Do not load the entire repo into Spark.

## Phase 4 — Worker runtime adapters

Create a shared interface:

```ts
interface WorkerRuntimeAdapter {
  detect(): Promise<AgentRuntimeDiagnostic>;
  buildCommand(task: WorkerTask, attempt: WorkerAttempt): WorkerCommand;
  launch(command: WorkerCommand): Promise<WorkerProcess>;
}
```

Adapters:

- `ClaudeCodeAdapter`
- `CodexExecAdapter`
- future `CodexAppServerAdapter`

The existing terminal shell spawning should remain for manual terminals. Worker attempts should use structured commands.

## Phase 5 — Manual worker task runner

Before OpenRouter Spark planning, add a UI button to create a manual worker task:

- title
- runtime: Claude/Codex
- model
- prompt
- cwd
- allowed paths
- verification command

The app should:

1. write `prompt.md`
2. spawn the CLI in a terminal tile
3. save logs
4. save final report
5. collect exit code
6. show attempt status

This gives you a way to test prompts without waiting for the Spark brain.

## Phase 6 — Prompt testing harness

Add prompt template versions:

- `spark-planner-v1`
- `worker-contract-v1`
- `spark-reviewer-v1`
- `retry-planner-v1`

Add benchmark plans:

- empty project todo app
- add settings page
- fix terminal lag
- add CLI diagnostics
- review a worker report with missing tests

Metrics:

- did JSON parse?
- did worker stay in scope?
- did worker run verification?
- did review catch missing proof?
- cost
- duration
- retries

## Phase 7 — OpenRouter Spark planner

Add OpenRouter client.

Spark modes:

- `plan_analysis`
- `step_planning`
- `worker_prompt_generation`
- `worker_result_review`
- `retry_planning`

Use structured JSON schemas for every orchestration decision.

Do not keep the old prompt/response in active Spark context. Store it in Dev Inspector and pass only the needed output into the next Spark call.

## Phase 8 — Evidence collector and review loop

Before Spark reviews a worker result, the app collects:

- worker final report
- changed files
- diff summary
- forbidden path check
- verification command output
- raw log tail only if needed

Spark receives a compact review packet and returns:

```json
{
  "decision": "accept | follow_up | retry | blocked | ask_user",
  "confidence": 0.0,
  "reason": "...",
  "issues": [],
  "follow_up_task": null
}
```

## Phase 9 — Parallelism and path locking

Every worker task needs:

- `allowed_paths`
- `forbidden_paths`
- `expected_changed_paths`
- `can_run_parallel`
- `conflicts_with`

The app must block same-step workers that write overlapping paths.

## Phase 10 — Visual orchestration map

Build a read-only graph from run state:

```text
Plan → Spark → Step → Workers → Review → Follow-up → Next Step
```

Start simple. Use cards before fancy graph layout.

## Phase 11 — Worktrees / isolated workspaces

After same-directory mode works, add:

- step worktree mode
- worker worktree mode
- branch naming
- merge worker
- conflict review
- cleanup

This should become the recommended mode for dangerous permissions.
