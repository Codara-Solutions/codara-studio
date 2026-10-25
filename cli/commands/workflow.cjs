"use strict";

// Workflows from the terminal. Like automations, the socket scopes workflow.*
// calls to a chat run's workspace, so every command picks a run for context:
// --run to pin one, else the newest run on disk. `run` and `save` post the
// same approval question in that chat that Cora's calls do: the socket cannot
// tell this CLI from a model, so it never starts agents unasked. `status`
// works offline from the run file.

const fs = require("node:fs");
const path = require("node:path");

const { rpc } = require("../lib/rpc.cjs");
const { findRun, listRuns, readRun } = require("../lib/store.cjs");
const { c, statusColor, table, fail } = require("../lib/ui.cjs");

const USAGE = `usage: cora workflow <command> [--run RUN]
  list                                   saved workflows
  show <name>                            one workflow's source
  check <name|file.js> [--args JSON]     dry run: errors and estimate
  run <name|file.js> [--args JSON --max-agents N --concurrency N --tokens N]
                                         asks for approval in the context chat
  status <workflow-run>                  progress (works offline)
  wait <workflow-run> [--timeout SECONDS]
  stop|resume <workflow-run>
  save <file.js> [--scope user|project]  save under its meta.name`;

function contextRun(flags) {
  const run = flags.run
    ? findRun(flags, flags.run)
    : listRuns(flags).find((candidate) => !candidate.workflow && !candidate.automationId) ?? null;
  if (!run) fail("workflows need a workspace context and no runs exist yet; start one with `cora start`, or pass --run");
  return run;
}

function scriptRef(arg) {
  if (!arg) fail(USAGE);
  if (arg.endsWith(".js") && fs.existsSync(arg)) return { source: fs.readFileSync(path.resolve(arg), "utf8") };
  return { name: arg };
}

function parseArgsFlag(flags) {
  if (flags.args === undefined) return undefined;
  try {
    return JSON.parse(flags.args);
  } catch {
    return fail("--args must be JSON");
  }
}

function capsFlags(flags) {
  const caps = {};
  if (flags["max-agents"]) caps.max_agents = Number(flags["max-agents"]);
  if (flags.concurrency) caps.concurrency = Number(flags.concurrency);
  if (flags.tokens) caps.token_ceiling = Number(flags.tokens);
  return caps;
}

function printStatus(status) {
  console.log(`${c.bold(status.name)}  ${statusColor(status.state)}  ${c.dim(status.workflow_run_id)}`);
  const agents = status.agents ?? {};
  console.log(
    c.dim(
      `${agents.done ?? 0}/${agents.issued ?? 0} agents  ${agents.cached ?? 0} cached  ${agents.nulls ?? 0} null  ${status.tokens ?? 0} tokens`,
    ),
  );
  if (status.error) console.log(c.red(status.error));
  for (const phase of status.phases ?? []) {
    console.log(`  ${phase.title.padEnd(16)} ${phase.done}/${phase.agents} done  ${phase.running} live  ${phase.queued} queued  ${phase.nulls} null  ${phase.cached} cached`);
  }
  for (const problem of status.problems ?? []) console.log(c.dim(`  #${problem.seq} ${problem.label}: ${problem.note}`));
  if (status.result !== undefined) console.log(JSON.stringify(status.result, null, 2));
}

function offlineStatus(flags, id) {
  const run = findRun(flags, id);
  if (!run?.workflow) fail(`not a workflow run: ${id}`);
  const full = readRun(flags, run.id) ?? run;
  const info = full.workflow;
  const phases = (info.tree?.phases ?? []).map((phase) => ({
    title: phase.title,
    agents: phase.calls.length,
    done: phase.calls.filter((call) => call.status === "done").length,
    running: phase.calls.filter((call) => call.status === "running").length,
    queued: phase.calls.filter((call) => call.status === "queued").length,
    nulls: phase.calls.filter((call) => ["null", "skipped", "error"].includes(call.status)).length,
    cached: phase.calls.filter((call) => call.cached).length,
  }));
  return {
    workflow_run_id: full.id,
    name: info.name,
    state: info.state,
    agents: info.counts,
    tokens: info.spent.inputTokens + info.spent.outputTokens,
    error: info.error,
    phases,
  };
}

async function workflow(args, flags) {
  const [sub, ...rest] = args;
  if (!sub || sub === "help") return console.log(USAGE);

  if (sub === "status" && rest[0]) {
    const status = offlineStatus(flags, rest[0]);
    if (flags.json) return console.log(JSON.stringify(status, null, 2));
    return printStatus(status);
  }

  const run = contextRun(flags);
  const base = { runId: run.id };

  switch (sub) {
    case "list": {
      const result = await rpc(flags, "workflow.list", base);
      if (flags.json) return console.log(JSON.stringify(result, null, 2));
      const rows = (result.workflows ?? []).map((entry) => [
        c.cyan(entry.name),
        c.dim(entry.source),
        entry.error ? c.red(entry.error) : entry.description ?? "",
      ]);
      return console.log(rows.length ? table(rows) : c.dim("(no saved workflows)"));
    }
    case "show": {
      if (!rest[0]) fail(USAGE);
      const result = await rpc(flags, "workflow.get", { ...base, name: rest[0] });
      return console.log(flags.json ? JSON.stringify(result, null, 2) : result.source_text);
    }
    case "check": {
      const result = await rpc(flags, "workflow.check", {
        ...base,
        ...scriptRef(rest[0]),
        args: parseArgsFlag(flags),
        ...capsFlags(flags),
      });
      if (flags.json) return console.log(JSON.stringify(result, null, 2));
      for (const error of result.errors ?? []) console.log(c.red(`${error.line ? `line ${error.line}: ` : ""}${error.message}`));
      const estimate = result.estimate;
      if (estimate) {
        console.log(`about ${estimate.agents}${estimate.unbounded ? "+" : ""} agents  ${estimate.tokens.low} to ${estimate.tokens.high} tokens`);
        for (const phase of estimate.phases) console.log(c.dim(`  ${phase.title}: ${phase.agents}`));
      }
      for (const warning of result.warnings ?? []) console.log(c.dim(`note: ${warning}`));
      if (!result.ok) process.exit(1);
      return;
    }
    case "run": {
      console.log(c.dim("approve the workflow in the Codara chat of the context run..."));
      const result = await rpc(
        flags,
        "workflow.run",
        { ...base, ...scriptRef(rest[0]), args: parseArgsFlag(flags), ...capsFlags(flags) },
        { timeoutMs: 20 * 60_000 },
      );
      if (flags.json) return console.log(JSON.stringify(result, null, 2));
      if (!result.started) {
        console.log(result.message ?? "not started");
        for (const error of result.errors ?? []) console.log(c.red(`${error.line ? `line ${error.line}: ` : ""}${error.message}`));
        process.exit(1);
      }
      return console.log(`started  ${c.cyan(result.workflow_run_id)}`);
    }
    case "wait": {
      if (!rest[0]) fail(USAGE);
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 10 * 60_000;
      const result = await rpc(
        flags,
        "workflow.wait",
        { ...base, workflow_run_id: rest[0], timeout_ms: timeoutMs },
        { timeoutMs: timeoutMs + 60_000 },
      );
      return flags.json ? console.log(JSON.stringify(result, null, 2)) : printStatus(result);
    }
    case "stop":
    case "resume": {
      if (!rest[0]) fail(USAGE);
      const result = await rpc(flags, `workflow.${sub}`, { ...base, workflow_run_id: rest[0] });
      return flags.json ? console.log(JSON.stringify(result, null, 2)) : printStatus(result);
    }
    case "save": {
      if (!rest[0] || !fs.existsSync(rest[0])) fail(USAGE);
      console.log(c.dim("approve the save in the Codara chat of the context run..."));
      const result = await rpc(
        flags,
        "workflow.save",
        { ...base, source: fs.readFileSync(path.resolve(rest[0]), "utf8"), scope: flags.scope === "project" ? "project" : "user" },
        { timeoutMs: 20 * 60_000 },
      );
      if (flags.json) return console.log(JSON.stringify(result, null, 2));
      return console.log(result.approved ? `saved  ${c.cyan(result.saved.id)}` : result.message);
    }
    default:
      fail(USAGE);
  }
}

module.exports = { workflow };
