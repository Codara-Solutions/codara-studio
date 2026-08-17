"use strict";

// Subagent visibility and control. `agents` prints a snapshot; `watch` is the
// live dashboard: run status, every worker with its state/model/age, the
// kanban lanes, and the last few events — redrawn in place until the run
// settles (or forever with --forever).

const { rpc } = require("../lib/rpc.cjs");
const { findRun, listRuns, latestRun, tailEvents, blockedQuestion } = require("../lib/store.cjs");
const { c, statusColor, table, timeAgo, duration, fail } = require("../lib/ui.cjs");

// ── snapshot ────────────────────────────────────────────────────────────────

function workerRows(run) {
  const attemptsByTask = new Map();
  for (const attempt of run.workerAttempts ?? []) {
    attemptsByTask.set(attempt.workerTaskId, attempt);
  }
  return (run.workerTasks ?? []).map((task) => {
    const attempt = attemptsByTask.get(task.id);
    return [
      c.cyan(task.id.slice(0, 14)),
      statusColor(attempt?.status ?? task.status),
      task.runtimePreference ?? "?",
      attempt?.model ?? task.modelHint ?? c.dim("roster"),
      attempt?.startedAt ? duration(attempt.startedAt, attempt.finishedAt) : "",
      (task.title ?? "").slice(0, 56),
    ];
  });
}

function agents(args, flags) {
  const target = args[0] ? findRun(flags, args[0]) : latestRun(flags);
  if (!target) fail("no runs found — start one with `cora start`");
  if (flags.json) return console.log(JSON.stringify({ run: target.id, workers: target.workerTasks, attempts: target.workerAttempts }, null, 2));
  console.log(`${c.cyan(target.id)}  ${statusColor(target.status)}  ${target.title ?? ""}`);
  const rows = workerRows(target);
  if (rows.length === 0) return console.log(c.dim("(no subagents on this run yet)"));
  console.log("");
  console.log(table([["id", "status", "runtime", "model", "time", "task"].map((h) => c.dim(h)), ...rows]));
}

// ── live dashboard ──────────────────────────────────────────────────────────

function renderDashboard(flags, run) {
  const lines = [];
  const push = (line = "") => lines.push(line);

  push(`${c.violet("◆ cora watch")}  ${c.cyan(run.id)}  ${statusColor(run.status)}  ${c.dim(timeAgo(run.updatedAt))}`);
  push(`${c.bold(run.title ?? "(untitled)")}`);
  push();

  const rows = workerRows(run);
  if (rows.length > 0) {
    push(c.bold(`subagents (${rows.length})`));
    push(table([["id", "status", "runtime", "model", "time", "task"].map((h) => c.dim(h)), ...rows]));
    push();
  }

  const steps = run.steps ?? [];
  if (steps.length > 0) {
    push(c.bold("steps"));
    for (const step of steps) push(`  ${statusColor(step.status)}  ${step.title ?? ""}`);
    push();
  }

  const question = blockedQuestion(run);
  if (question) {
    push(`${c.yellow("Cora asks:")} ${question.message}`);
    (question.questionOptions ?? []).forEach((option, i) => push(`  ${i + 1}. ${option.label}`));
    push(c.dim(`reply: cora send ${run.id.slice(0, 12)} <text or number>`));
    push();
  }

  const events = tailEvents(flags, run.id, 6);
  if (events.length > 0) {
    push(c.bold("activity"));
    for (const event of events) {
      push(`  ${c.dim(String(event.timestamp ?? "").slice(11, 19))}  ${(event.message ?? event.type ?? "").slice(0, 100)}`);
    }
  }
  push();
  push(c.dim("ctrl-c to leave (the run keeps going)"));
  return lines.join("\n");
}

async function watch(args, flags) {
  let target = args[0]
    ? findRun(flags, args[0])
    : listRuns(flags).find((run) => ["working", "running", "blocked", "paused"].includes(run.status)) ?? latestRun(flags);
  if (!target) fail("no runs found — start one with `cora start`");
  const settled = new Set(["complete", "failed", "cancelled"]);
  const interval = 1000;
  const startedSettled = settled.has(target.status);

  for (;;) {
    target = findRun(flags, target.id);
    const frame = renderDashboard(flags, target);
    // Clear + repaint in place; \x1b[H home, \x1b[2J clear.
    process.stdout.write(`\x1b[2J\x1b[H${frame}\n`);
    if (settled.has(target.status) && !startedSettled) {
      console.log(statusColor(target.status));
      return;
    }
    if (settled.has(target.status) && !flags.forever) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// ── typed control: spawn / message ──────────────────────────────────────────

async function agent(args, flags) {
  const [sub, ...rest] = args;
  if (sub === "spawn") {
    if (!rest[0] || rest.length < 2) {
      fail("usage: cora agent spawn <run> <brief> [--title T --runtime claude|codex --model M --effort E --class feature|leaf|verifier]");
    }
    const run = findRun(flags, rest[0]);
    const worker = {
      title: flags.title || rest.slice(1).join(" ").slice(0, 80),
      description: rest.slice(1).join(" "),
    };
    if (flags.runtime) worker.runtimePreference = flags.runtime;
    if (flags.model) worker.modelHint = flags.model;
    if (flags.effort) worker.effortHint = flags.effort;
    if (flags.class) worker.taskClass = flags.class;
    const spawned = await rpc(flags, "orchestrator.spawn_workers", { runId: run.id, workers: [worker] });
    if (flags.json) return console.log(JSON.stringify(spawned, null, 2));
    for (const taskId of spawned.worker_task_ids ?? []) console.log(`spawned  ${c.cyan(taskId)}  on ${run.id}`);
    if (spawned.note) console.log(c.dim(spawned.note));
    return;
  }
  if (sub === "message") {
    if (!rest[0] || !rest[1] || rest.length < 3) fail("usage: cora agent message <run> <all|task-id> <message>");
    const run = findRun(flags, rest[0]);
    const to = rest[1] === "all" ? "all" : [rest[1]];
    const result = await rpc(flags, "orchestrator.message_workers", {
      runId: run.id,
      to,
      message: rest.slice(2).join(" "),
    });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`message sent to ${rest[1]} on ${run.id}`);
    return;
  }
  fail("usage: cora agent <spawn|message> ...");
}

module.exports = { agents, watch, agent, renderDashboard, workerRows };
