# Spark Agent

Spark Agent is a local-first orchestration app for running multiple terminal-based coding workers from one clean orchestrator context.

The core principle is:

```text
Spark Agent context is gold.
```

Spark should keep only the plan, current step, current decision packet, and compact worker evidence in active context. Raw logs, old prompts, terminal history, worker transcripts, diffs, and debugging data live in app state and Dev Inspector artifacts instead.

## Current app state

This repository is currently an Electron + React + TypeScript shell with:

- workspace selection
- terminal tiles using `node-pty` and xterm.js
- basic file explorer
- shell detection
- Claude Code / Codex CLI diagnostics in the Spark panel
- first-pass terminal performance fixes
- docs and prompt templates for the orchestration runtime

It is not yet the full autonomous Spark runtime. The next major build step is the event log + run/step/worker state model.

## Run locally

```bash
npm install
npm run dev
```

## Important docs

- `docs/PROJECT_DESCRIPTION.md` — product description and architecture
- `docs/BUILD_PLAN.md` — step-by-step build path from the current app
- `docs/PROMPTS.md` — Spark and worker prompt templates
- `SPARK.md` — sample project workflow contract
- `docs/TERMINAL_PERFORMANCE_FIXES.md` — what was fixed for terminal lag
- `docs/LANGSMITH_AND_OPENROUTER.md` — tracing strategy

## Worker command targets

Claude Code worker runs should eventually use non-interactive print mode:

```bash
claude -p --model sonnet --effort high --output-format stream-json --max-turns 30 --dangerously-skip-permissions < prompt.md
```

Codex worker runs should eventually use non-interactive exec mode:

```bash
codex exec --cd "$PROJECT_DIR" --model gpt-5.5 --json --output-last-message "$REPORT_PATH" --yolo - < prompt.md
```

Danger mode should be shown clearly in the UI and should be used only with checkpoints or isolated workspaces/worktrees.
