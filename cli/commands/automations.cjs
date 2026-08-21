"use strict";

// Automations from the terminal. The socket scopes automation.* calls to a
// caller run's workspace, so every command picks a run for context: --run to
// pin one, else the newest run on disk.

const { rpc } = require("../lib/rpc.cjs");
const { findRun, latestRun } = require("../lib/store.cjs");
const { c, statusColor, table, fail } = require("../lib/ui.cjs");

function contextRun(flags) {
  const run = flags.run ? findRun(flags, flags.run) : latestRun(flags);
  if (!run) fail("automations need a workspace context and no runs exist yet — start one with `cora start`, or pass --run");
  return run;
}

async function auto(args, flags) {
  const [sub, ...rest] = args;
  const run = contextRun(flags);

  if (!sub || sub === "list") {
    const result = await rpc(flags, "automation.list", { runId: run.id });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    const automations = result.automations ?? result ?? [];
    if (!Array.isArray(automations) || automations.length === 0) {
      return console.log(c.dim("(no automations in this workspace)"));
    }
    console.log(
      table(
        automations.map((automation) => [
          c.cyan(String(automation.id ?? "").slice(0, 24)),
          automation.enabled === false ? c.dim("off") : c.green("on"),
          statusColor(automation.status ?? ""),
          automation.name ?? automation.title ?? "",
        ]),
      ),
    );
    return;
  }

  const verbs = {
    run: ["automation.run_now", "triggered"],
    pause: ["automation.pause", "paused"],
    resume: ["automation.resume", "resumed"],
    stop: ["automation.stop", "stopped"],
    on: ["automation.set_enabled", "enabled"],
    off: ["automation.set_enabled", "disabled"],
  };
  const verb = verbs[sub];
  if (!verb) fail("usage: cora auto <list|run|pause|resume|stop|on|off> [automation-id] [--run RUN]");
  if (!rest[0]) fail(`usage: cora auto ${sub} <automation-id> [--run RUN]`);

  const params = { runId: run.id, automationId: rest[0] };
  if (sub === "on") params.enabled = true;
  if (sub === "off") params.enabled = false;
  const result = await rpc(flags, verb[0], params);
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${verb[1]}  ${c.cyan(rest[0])}`);
}

module.exports = { auto };
