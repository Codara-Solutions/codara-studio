"use strict";

// Run inspection. Everything here reads ~/.codarastudio directly, so it works with
// the app closed.

const { listRuns, findRun } = require("../lib/store.cjs");
const { c, statusColor, table, timeAgo, fail } = require("../lib/ui.cjs");

function runs(args, flags) {
  const all = listRuns(flags);
  if (flags.json) return console.log(JSON.stringify(all, null, 2));
  if (all.length === 0) return console.log(c.dim("(no runs yet)"));
  console.log(
    table(
      all.map((run) => [
        c.cyan(run.id.slice(0, 22)),
        statusColor(run.status),
        `${(run.workerTasks ?? []).length}w`,
        timeAgo(run.updatedAt),
        run.title ?? "",
      ]),
    ),
  );
}

function run(args, flags) {
  if (!args[0]) fail("usage: cora run <id-or-prefix>");
  const match = findRun(flags, args[0]);
  if (flags.json) return console.log(JSON.stringify(match, null, 2));
  console.log(`${c.cyan(match.id)}  ${statusColor(match.status)}`);
  console.log(`title      ${match.title ?? c.dim("(untitled)")}`);
  console.log(`cwd        ${match.cwd ?? "?"}`);
  console.log(`updated    ${timeAgo(match.updatedAt) || match.updatedAt || "?"}`);
  const steps = match.steps ?? [];
  const tasks = match.workerTasks ?? [];
  console.log(`steps      ${steps.length}   workers ${tasks.length}   attempts ${(match.workerAttempts ?? []).length}`);
  if (steps.length > 0) {
    console.log("");
    console.log(table(steps.map((step) => [`  ${statusColor(step.status)}`, step.title ?? ""])));
  }
  console.log(c.dim(`\nmore: cora agents ${match.id.slice(0, 12)} · cora log ${match.id.slice(0, 12)} · cora watch ${match.id.slice(0, 12)}`));
}

function log(args, flags) {
  if (!args[0]) fail("usage: cora log <id-or-prefix>");
  const match = findRun(flags, args[0]);
  if (flags.json) return console.log(JSON.stringify(match.humanMessages ?? [], null, 2));
  console.log(`${c.cyan(match.id)}  ${statusColor(match.status)}  ${match.title ?? ""}`);
  const messages = match.humanMessages ?? [];
  if (messages.length === 0) return console.log(c.dim("(no messages)"));
  for (const message of messages) {
    const who = message.author === "user" ? c.bold("you") : c.violet("cora");
    const when = String(message.createdAt ?? "").slice(0, 16).replace("T", " ");
    console.log(`\n${who} ${c.dim(when)}`);
    for (const line of String(message.message ?? "").split("\n")) console.log(`  ${line}`);
    (message.questionOptions ?? []).forEach((option, i) => {
      console.log(`    ${i + 1}. ${option.label}${option.recommended ? c.dim(" (recommended)") : ""}`);
    });
  }
}

module.exports = { runs, run, log };
