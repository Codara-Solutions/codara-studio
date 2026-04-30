# Spark Agent Project Description

Spark Agent is a desktop orchestration app for running multiple coding agents against a local project workspace.

The user opens a workspace, selects a project directory, imports or writes a plan, and lets Spark coordinate the implementation. Spark itself runs through OpenRouter so the orchestrator model can be switched and benchmarked. Worker agents are terminal-based CLIs such as Claude Code and Codex CLI.

## Product thesis

Most coding-agent tools optimize for one agent in one terminal. Spark Agent optimizes for coordinated work:

```text
Plan → Spark orchestration → focused workers → evidence → review → next step
```

The app should feel like a mission-control view for a small autonomous engineering team.

## Main principle

```text
Spark Agent context is gold.
```

Spark's active model context should stay clean. The app stores state, logs, prompts, diffs, and history outside the active Spark context. Spark receives compact decision packets only when it needs to plan, assign, review, retry, or advance.

## Roles

### Spark Agent

Spark is the orchestrator. It uses OpenRouter. It does not do the whole project itself.

Spark is responsible for:

- understanding the plan
- creating an execution path
- breaking work into steps
- deciding what can run in parallel
- choosing Claude Code or Codex CLI workers
- choosing model and effort level
- writing strong worker prompts
- reviewing worker results
- creating retries or follow-ups
- advancing the project

### Worker agents

Workers are terminal-based agents. Current worker targets:

- Claude Code CLI
- Codex CLI

Workers are responsible for:

- one focused task
- scoped implementation
- running verification commands
- writing a final report
- reporting blockers and risks

Workers do not own project direction and do not talk to each other.

## Workspace model

Each workspace has:

- project directory
- plan
- Spark run state
- steps
- workers
- terminal tiles
- event log
- artifacts
- settings

Suggested durable layout:

```text
.spark-agent/
  workspace.json
  runs/
    run-001/
      run.json
      events.jsonl
      steps/
        step-001/
          step.json
          workers/
            worker-001/
              task.json
              prompt.md
              raw.log
              final-report.json
              diff.patch
              review.json
```

For product builds, full state can live in Electron userData with optional project-local mirrors.

## Orchestration flow

```text
Open app
  ↓
Create/select workspace
  ↓
Choose project directory
  ↓
Run diagnostics
  ↓
Import plan
  ↓
Create project map
  ↓
Spark creates next step
  ↓
App validates parallel safety
  ↓
Spark writes worker prompts
  ↓
App launches workers as terminal tiles
  ↓
Workers run in parallel when safe
  ↓
App collects reports/diffs/tests
  ↓
Spark reviews compact evidence
  ↓
Accept / retry / follow up / block
  ↓
Advance to next step
```

## Visual product

Spark Agent needs two visibility layers.

### User Overview

A clean mission-control view showing:

- current Spark mode
- step graph
- running workers
- worker status
- accepted/rejected results
- follow-ups
- proof of completion

### Dev Inspector

A debugging view for development showing:

- Spark prompts
- Spark responses
- structured JSON
- context packets
- worker prompts
- raw worker output
- parsed final reports
- event log
- state transitions
- model/cost/latency metadata

The normal user should not be overwhelmed with raw logs. The developer must be able to inspect everything.

## Spark should produce structured output

Spark planner/reviewer calls should return JSON objects such as:

- `ExecutionStrategy`
- `StepPlan`
- `WorkerTask[]`
- `WorkerPrompt`
- `ReviewDecision`
- `FollowUpTask`

Freeform Spark responses should be avoided for core orchestration decisions.

## Worker command direction

Use non-interactive modes for automation and terminal tiles for visibility.

Claude Code target:

```bash
claude -p --model sonnet --effort high --output-format stream-json --max-turns 30 --dangerously-skip-permissions < prompt.md
```

Codex target:

```bash
codex exec --cd "$PROJECT_DIR" --model gpt-5.5 --json --output-last-message "$REPORT_PATH" --yolo - < prompt.md
```

The terminal tile displays the run, but state comes from the app's worker/task system, not from parsing terminal text.
