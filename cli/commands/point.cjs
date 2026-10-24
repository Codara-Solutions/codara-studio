"use strict";

// `cora inbox` and `cora inspect`: pointing at the page from a shell. They
// are short names for two `cora tool` calls, so an agent without MCP pulls
// what the user picked or commented on, and describes an element, with the
// same results MCP clients get.
//
//   cora inbox [--peek] [--limit N] [--json]
//   cora inspect <@ref|selector> [--tabId ID] [--json]
//   cora inspect --x N --y N [--tabId ID] [--json]

const { tool } = require("./tool.cjs");

const INBOX_USAGE = "usage: cora inbox [--peek] [--limit N] [--json]";
const INSPECT_USAGE = "usage: cora inspect <@ref|selector> [--tabId ID] [--json]\n       cora inspect --x N --y N [--tabId ID] [--json]";

/** The `cora tool` argv for `cora inbox`. */
function inboxArgv(args, flags) {
  if (args.length) throw new Error(INBOX_USAGE);
  const params = {};
  if (flags.peek) params.peek = true;
  if (flags.limit !== undefined) {
    const limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(INBOX_USAGE);
    params.limit = limit;
  }
  return withOwnFlags(["codara_preview_inbox", JSON.stringify(params)], flags);
}

/** The `cora tool` argv for `cora inspect`. */
function inspectArgv(args, flags) {
  const params = {};
  if (args.length > 1) throw new Error(INSPECT_USAGE);
  if (args[0]) params.ref = args[0];
  if (flags.x !== undefined || flags.y !== undefined) {
    const x = Number(flags.x);
    const y = Number(flags.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(INSPECT_USAGE);
    params.x = x;
    params.y = y;
  }
  if (!params.ref && params.x === undefined) throw new Error(INSPECT_USAGE);
  if (typeof flags.tabId === "string") params.tabId = flags.tabId;
  return withOwnFlags(["codara_preview_inspect", JSON.stringify(params)], flags);
}

function withOwnFlags(argv, flags) {
  if (flags.json) argv.push("--json");
  if (typeof flags.home === "string") argv.push("--home", flags.home);
  return argv;
}

function run(build) {
  return async (args, flags) => {
    let argv;
    try {
      argv = build(args, flags);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    return tool(argv);
  };
}

/** `cora inspect` reads --x/--y/--limit as values and --peek as a switch. */
function parsePointArgs(argv) {
  const flags = {};
  const args = [];
  const switches = new Set(["json", "peek"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const name = token.slice(2);
    if (switches.has(name)) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { args, flags };
}

module.exports = {
  inbox: run(inboxArgv),
  inspect: run(inspectArgv),
  inboxArgv,
  inspectArgv,
  parsePointArgs,
};
