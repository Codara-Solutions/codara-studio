"use strict";

// Session lifecycle: start a run, reply to it, wait on it, stream it, stop it.
// These are the "human at the top of the chat" verbs (chat.* on the socket).

const path = require("node:path");

const { rpc, rpcRaw } = require("../lib/rpc.cjs");
const { blockedQuestion } = require("../lib/store.cjs");
const { c, statusColor, fail } = require("../lib/ui.cjs");

const DEFAULT_WAIT_MS = 20 * 60_000;

function timeoutMs(flags) {
  return flags.timeout ? Math.max(1, Number(flags.timeout)) * 1000 : DEFAULT_WAIT_MS;
}

function printSession(result) {
  const run = result.run ?? result;
  console.log(`${c.cyan(run.id)}  ${statusColor(run.status)}  ${run.title ?? ""}`);
  const question = blockedQuestion(run);
  if (question) {
    console.log(`\n${c.yellow("Cora asks:")} ${question.message}`);
    (question.questionOptions ?? []).forEach((option, i) => {
      console.log(`  ${i + 1}. ${option.label}${option.recommended ? c.dim("  (recommended)") : ""}`);
    });
    console.log(c.dim(`\nreply with: cora send ${run.id.slice(0, 12)} <text or option number>`));
  } else if (["complete", "failed", "cancelled"].includes(run.status)) {
    const last = (run.humanMessages ?? []).filter((m) => m.author !== "user").at(-1);
    if (last?.message) console.log(`\n${last.message}`);
  }
}

/** Poll chat.events and print each new event line until the run settles. */
async function follow(flags, runId, { fromStart = false, deadline } = {}) {
  let cursor = fromStart ? 0 : undefined;
  const done = new Set(["complete", "failed", "cancelled", "blocked"]);
  for (;;) {
    if (deadline && Date.now() > deadline) return { timedOut: true };
    const res = await rpcRaw(flags, "chat.events", {
      runId,
      ...(cursor !== undefined ? { afterSequence: cursor } : {}),
      waitMs: 10_000,
    });
    if (res.error) fail(`chat.events: ${res.error.message}`);
    const { events = [], run } = res.result;
    for (const event of events) {
      cursor = Math.max(cursor ?? 0, event.sequence ?? 0);
      const text = event.message ?? event.type;
      if (text) console.log(`${c.dim(String(event.timestamp ?? "").slice(11, 19))}  ${text}`);
    }
    const status = run?.status ?? res.result.status;
    if (status && done.has(status)) return { status };
  }
}

async function start(args, flags) {
  if (args.length === 0) fail("usage: cora start <prompt> [--cwd DIR --model M --effort E --wait]");
  const params = {
    cwd: path.resolve(flags.cwd || process.cwd()),
    prompt: args.join(" "),
    backend: "pi",
  };
  for (const key of ["title", "model", "effort"]) if (flags[key]) params[key] = flags[key];
  const started = await rpc(flags, "chat.create", params);
  if (flags.json && !flags.wait) return console.log(JSON.stringify(started, null, 2));
  console.log(`${c.cyan(started.run.id)}  started`);
  if (started.workspaceCreated) console.log(c.dim("registered a new Codara workspace"));
  if (!flags.wait) {
    console.log(c.dim(`follow with: cora watch ${started.run.id.slice(0, 12)}`));
    return;
  }
  await follow(flags, started.run.id, { fromStart: true, deadline: Date.now() + timeoutMs(flags) });
  const final = await rpc(flags, "chat.wait", { runId: started.run.id, timeoutMs: 0 });
  printSession(final);
}

async function send(args, flags) {
  if (!args[0] || !args[1]) fail("usage: cora send <run> <message|option#> [--wait]");
  let content = args.slice(1).join(" ");
  // A bare number answers the pending question by option index.
  if (/^\d+$/.test(content.trim())) {
    const snapshot = await rpcRaw(flags, "chat.wait", { runId: args[0], timeoutMs: 0 }).catch(() => null);
    const option = blockedQuestion(snapshot?.result?.run)?.questionOptions?.[Number(content.trim()) - 1];
    if (option) {
      content = option.answer || option.label;
      if (!flags.json) console.log(c.dim(`answering: ${option.label}`));
    }
  }
  const sent = await rpc(flags, "chat.send", { runId: args[0], content });
  if (flags.json && !flags.wait) return console.log(JSON.stringify(sent, null, 2));
  if (!flags.wait) return printSession(sent);
  await follow(flags, sent.run.id, { deadline: Date.now() + timeoutMs(flags) });
  printSession(await rpc(flags, "chat.wait", { runId: sent.run.id, timeoutMs: 0 }));
}

async function wait(args, flags) {
  if (!args[0]) fail("usage: cora wait <run> [--timeout SECONDS]");
  const waited = await rpc(flags, "chat.wait", { runId: args[0], timeoutMs: timeoutMs(flags) });
  if (flags.json) return console.log(JSON.stringify(waited, null, 2));
  printSession(waited);
}

async function tail(args, flags) {
  if (!args[0]) fail("usage: cora tail <run> [--all] [--timeout SECONDS]");
  const followed = await follow(flags, args[0], {
    fromStart: Boolean(flags.all),
    deadline: flags.timeout ? Date.now() + timeoutMs(flags) : undefined,
  });
  if (followed.timedOut) console.log(c.dim("(tail timed out; the run is still going)"));
  else printSession(await rpc(flags, "chat.wait", { runId: args[0], timeoutMs: 0 }));
}

async function cancel(args, flags) {
  if (!args[0]) fail("usage: cora cancel <run> [reason]");
  const cancelled = await rpc(flags, "chat.cancel", {
    runId: args[0],
    reason: args.slice(1).join(" ") || undefined,
  });
  if (flags.json) return console.log(JSON.stringify(cancelled, null, 2));
  printSession(cancelled);
}

module.exports = { start, send, wait, tail, cancel, follow, printSession };
