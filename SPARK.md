---
spark:
  planner_model: openrouter/auto
  reviewer_model: openrouter/auto
  max_context_tokens: 24000
  context_policy: minimal_decision_packet

workers:
  max_concurrent: 3
  default_permission_mode: danger_for_dev_only

  claude:
    enabled: true
    default_model: sonnet
    default_effort: high
    command_template: "claude -p --model {model} --effort {effort} --output-format stream-json --max-turns {max_turns} --dangerously-skip-permissions < {prompt_file}"

  codex:
    enabled: true
    default_model: gpt-5.5
    command_template: "codex exec --cd {cwd} --model {model} --json --output-last-message {report_file} --yolo - < {prompt_file}"

safety:
  require_git_checkpoint_before_step: true
  forbidden_paths:
    - .git/**
    - node_modules/**
    - out/**
    - dist/**
    - release/**
    - .env
    - .env.*
    - "**/*.pem"
    - "**/*.key"

verification:
  default_commands:
    - npm run typecheck
---

# Spark Workflow Contract

This file is the local orchestration contract for Spark Agent.

Spark must act as the project leader, not as the main implementer. Spark plans the next step, assigns focused worker tasks, reviews compact evidence, and advances the run. Claude Code and Codex workers do implementation inside terminals.

## Core rule

Spark's active context is gold. Do not keep raw terminal logs, old worker prompts, full transcripts, or huge code dumps in Spark context. Store those outside the model and reload only the compact packet needed for the current decision.

## Step rule

Everything inside one step may run at the same time. Spark must not put two write tasks in the same step when they are likely to edit the same files or fight over package/config state.

## Worker rule

Each worker gets one focused task with:

- exact goal
- allowed paths
- forbidden paths
- expected output
- verification commands
- final report schema
- proof requirement

Workers must not talk to each other. Workers must not decide the overall direction of the project.

## Review rule

A worker is not accepted just because it says it is done. The app must collect evidence first:

- changed files
- git diff summary
- final report
- commands run
- test/typecheck output
- forbidden path check

Spark then reviews only this compact evidence packet.

## Retry rule

If a worker fails, Spark chooses one of:

- accept with minor risk
- continue same worker attempt
- spawn a follow-up worker
- retry with stronger model
- block and ask user

## User-facing visibility

The user should always be able to see:

- what Spark is doing now
- what step is active
- which workers are running
- what each worker is allowed to touch
- what evidence proved completion
- why Spark created a retry or follow-up
