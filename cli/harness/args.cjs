"use strict";

// The command line, read once and before the agent engine loads. The first word
// that is not an option decides what a run is, so that word is found here, by the
// same loop that knows which options take a value, and nowhere else.

const { resolve } = require("node:path");

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const COMMANDS = new Set(["exec", "resume", "login", "logout", "models"]);
/** cora.cjs answers these when they come first, so here they can only follow options. */
const INFO = new Set(["help", "version"]);
/** Agents in Studio's panes call these by name, so they run from here too. */
const STUDIO_TOOLS = new Set([
  "studio", "tool", "tools", "task", "tasks", "inbox", "inspect", "server", "servers", "workflow", "workflows",
]);
const MOVED = new Set([
  "chat", "start", "send", "wait", "tail", "cancel", "runs", "run", "log", "agents", "watch",
  "agent", "board", "whiteboard", "auto", "auth", "accounts", "profile", "status", "bench", "ws",
  "read", "rpc",
]);
/** Pi flags cora forwards as they are. Anything else is refused, never ignored. */
const PI_VALUE_FLAGS = new Set([
  "--tools", "--exclude-tools", "--append-system-prompt", "--skill", "--name", "--session-id",
  "--prompt-template", "--use-theme", "--tui-mode",
]);
const PI_SWITCHES = new Set([
  "--no-tools", "--no-builtin-tools", "--no-skills", "--no-context-files", "--no-session",
  "--no-prompt-templates", "--verbose",
]);

class UsageError extends Error {}

/** Unquoted, a command word never reaches a model: `cora auth list` from an old
 * habit, or `cora --json task list`, must not start a paid run. */
function refuseCommandWord(word, rest) {
  const prompt = [word, ...rest.filter((part) => !part.startsWith("-"))].join(" ");
  const fix = MOVED.has(word)
    ? `\`cora ${word}\` moved: use \`cora studio ${word}\`.`
    : `options go after the command: \`cora ${word} ...\`.`;
  return new UsageError(`${fix} To send it as a prompt, quote it: cora "${prompt}"`);
}

/**
 * @returns the run's settings, or `studioArgs` for a command Studio's CLI answers
 * @throws UsageError for anything that must not start a run
 */
function parseArgs(argv) {
  const cli = { command: "run", positional: [], passthrough: [], resume: undefined };
  const args = [...argv];
  if (COMMANDS.has(args[0])) cli.command = args.shift();
  while (args.length > 0) {
    const arg = args.shift();
    const value = () => {
      if (args.length === 0) throw new UsageError(`${arg} needs a value`);
      return args.shift();
    };
    if (arg === "--") cli.positional.push(...args.splice(0));
    else if (arg === "--model") cli.model = value();
    else if (arg === "--effort") cli.effort = value();
    else if (arg === "--mcp-config") cli.mcpConfig = resolve(value());
    else if (arg === "--json") cli.json = true;
    else if (arg === "--no-limit-wait") cli.noLimitWait = true;
    else if (arg === "--continue" || arg === "-c") cli.continue = true;
    else if (arg === "--resume" || arg === "-r") {
      cli.resume = args[0] && !args[0].startsWith("-") ? args.shift() : true;
    } else if (PI_VALUE_FLAGS.has(arg)) cli.passthrough.push(arg, value());
    else if (PI_SWITCHES.has(arg)) cli.passthrough.push(arg);
    else if (arg.startsWith("-") && arg.length > 1) throw new UsageError(`unknown option: ${arg}`);
    else if (cli.command === "run" && cli.positional.length === 0 && (STUDIO_TOOLS.has(arg) || MOVED.has(arg) || COMMANDS.has(arg) || INFO.has(arg))) {
      if (!STUDIO_TOOLS.has(arg) || arg !== argv[0]) throw refuseCommandWord(arg, args);
      return { ...cli, studioArgs: arg === "studio" ? args : argv };
    } else cli.positional.push(arg);
  }
  if (cli.effort && !EFFORTS.has(cli.effort)) {
    throw new UsageError(`--effort must be one of: ${[...EFFORTS].join(", ")}`);
  }
  if (cli.command === "resume") {
    cli.resume = cli.positional.shift() ?? cli.resume ?? true;
    cli.command = "run";
  }
  return cli;
}

module.exports = { UsageError, parseArgs };
