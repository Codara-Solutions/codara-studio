"use strict";

// The run's kanban board and whiteboard, rendered for the terminal.
// Reads go through the app (orchestrator.board_get / whiteboard_get) so the
// CLI always sees the same state as the Studio UI.

const { rpc } = require("../lib/rpc.cjs");
const { findRun } = require("../lib/store.cjs");
const { c, statusColor, fail } = require("../lib/ui.cjs");

const LANES = ["idea", "queued", "running", "blocked", "review", "done", "failed"];

async function board(args, flags) {
  if (!args[0]) fail("usage: cora board <run>  ·  cora board <run> add <title> [--desc TEXT]");
  const run = findRun(flags, args[0]);
  const [action, ...rest] = args.slice(1);

  if (action === "add") {
    if (rest.length === 0) fail("usage: cora board <run> add <title> [--desc TEXT]");
    const current = await rpc(flags, "orchestrator.board_get", { runId: run.id });
    const cards = [
      ...(current.cards ?? []),
      { title: rest.join(" "), status: "idea", ...(flags.desc ? { description: flags.desc } : {}) },
    ];
    await rpc(flags, "orchestrator.board_update", { runId: run.id, cards });
    console.log(`added ${c.bold(rest.join(" "))} to ${c.cyan(run.id)}`);
    return;
  }

  const result = await rpc(flags, "orchestrator.board_get", { runId: run.id });
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  const cards = result.cards ?? [];
  console.log(`${c.violet("▦ board")}  ${c.cyan(run.id)}  ${c.dim(`${cards.length} cards · revision ${result.revision ?? 0}`)}`);
  if (cards.length === 0) return console.log(c.dim("(empty board)"));
  for (const lane of LANES) {
    const inLane = cards.filter((card) => card.status === lane);
    if (inLane.length === 0) continue;
    console.log(`\n${statusColor(lane)} ${c.dim(`(${inLane.length})`)}`);
    for (const card of inLane.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      console.log(`  ${c.bold(card.title ?? "")}${card.runId ? c.dim(`  → ${card.runId.slice(0, 18)}`) : ""}`);
      if (card.description && flags.verbose) console.log(c.dim(`    ${card.description.slice(0, 110)}`));
    }
  }
}

async function whiteboard(args, flags) {
  if (!args[0]) fail("usage: cora whiteboard <run>  ·  cora whiteboard <run> set <markdown...>");
  const run = findRun(flags, args[0]);
  const [action, ...rest] = args.slice(1);

  if (action === "set") {
    if (rest.length === 0) fail("usage: cora whiteboard <run> set <markdown...>");
    await rpc(flags, "orchestrator.whiteboard_update", { runId: run.id, content: rest.join(" ") });
    console.log(`whiteboard updated on ${c.cyan(run.id)}`);
    return;
  }

  const result = await rpc(flags, "orchestrator.whiteboard_get", { runId: run.id });
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  const content = result.content ?? result.markdown ?? "";
  if (!content.trim()) return console.log(c.dim("(empty whiteboard)"));
  console.log(`${c.violet("▤ whiteboard")}  ${c.cyan(run.id)}\n`);
  console.log(content);
}

module.exports = { board, whiteboard };
