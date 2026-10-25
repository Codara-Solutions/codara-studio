"use strict";

// `cora task` and `cora inbox add`: the workspace's task list from a shell,
// for people and for agents without MCP. A thin face over the codara_task_*
// and codara_inbox_add tools, loaded the way `cora tool` loads them, so it
// acts on the same workspace (the pane it runs in) with the same rules.
//
//   cora task list [--state S] [--all]
//   cora task add <title> --done "how to tell it is finished" [--done ...] [--kind K] [--state S] [--from I1]
//   cora task move <id> <state> [reason...]
//   cora task worktree <id> <claude|codex> <absolute path> [--branch B]
//   cora inbox add <text> [--link URL]

const fs = require("node:fs");
const path = require("node:path");

const USAGE = `usage:
  cora task list [--state S] [--all] [--json]
  cora task add <title> --done "how to tell it is finished" [--done ...]
                [--kind code|browser_op|research|chore] [--state inbox|ready|dispatched] [--from I1]
  cora task move <T1|I1> <state> [reason...]    verifying runs the repo's checks; needs_you takes a reason
  cora task merge <I1> <T1>                      fold an inbox item into a task
  cora task worktree <T1> <claude|codex> <absolute path> [--branch B]
  cora inbox add <text> [--link URL]`;

const REPEATED = new Set(["done"]);
const BOOLEAN = new Set(["all", "json", "help"]);

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) flags[name] = true;
    else if (REPEATED.has(name)) (flags[name] = flags[name] || []).push(argv[++i]);
    else flags[name] = argv[++i];
  }
  return { args, flags };
}

function serverModule() {
  const candidates = [
    process.env.CODARA_STUDIO_MCP_SERVER,
    path.join(__dirname, "..", "..", "codara-studio-mcp", "server.js"),
    path.join(__dirname, "..", "..", "resources", "codara-studio-mcp", "server.js"),
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`Codara's tool server was not found (looked in ${candidates.join(", ")}).`);
  return require(found);
}

async function call(toolName, toolArgs, flags) {
  if (flags.home) process.env.CODARA_HOME_DIR = flags.home;
  const result = await serverModule().callToolByName(toolName, toolArgs);
  const text = result && Array.isArray(result.content) && result.content[0] ? result.content[0].text : "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An error result is plain text.
  }
  if (result && result.isError) {
    console.error(text || "The call failed.");
    process.exitCode = 1;
    return null;
  }
  if (flags.json) {
    console.log(text);
    return null;
  }
  if (parsed && parsed.reason && !parsed.task && !parsed.tasks && !parsed.item) {
    console.error(parsed.note || parsed.reason);
    process.exitCode = 1;
    return null;
  }
  return parsed;
}

function taskLine(task) {
  const head = `${task.id.padEnd(4)} ${task.state.padEnd(10)} ${task.title}`;
  const lines = [head];
  if (task.needsYouReason) lines.push(`     needs you: ${task.needsYouReason}`);
  for (const item of task.evidence || []) {
    lines.push(`     ${item.ok ? "pass" : "FAIL"} ${item.checkId}${item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`}  ${item.artifact || ""}`);
  }
  return lines.join("\n");
}

function printList(result) {
  console.log(result.line);
  for (const task of result.tasks) console.log(taskLine(task));
  for (const item of result.inbox) console.log(`${item.id.padEnd(4)} ${"inbox".padEnd(10)} ${item.text.split("\n")[0]}`);
  console.log(`\n${result.tasksFile}`);
}

async function task(argv) {
  const { args, flags } = parse(argv);
  const [action = "list", ...rest] = args;
  if (flags.help || action === "help" || action === "-h") return console.log(USAGE);
  if (action === "list") {
    const result = await call("codara_task_list", { ...(flags.state ? { state: flags.state } : {}), ...(flags.all ? { all: true } : {}) }, flags);
    if (result) printList(result);
    return;
  }
  if (action === "add") {
    if (!rest.length || !flags.done) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const toolArgs = { title: rest.join(" "), done_when: flags.done };
    if (flags.kind) toolArgs.kind = flags.kind;
    if (flags.state) toolArgs.state = flags.state;
    if (flags.from) toolArgs.from_inbox = flags.from;
    const result = await call("codara_task_add", toolArgs, flags);
    if (result) console.log(`${taskLine(result.task)}\n${result.line}`);
    return;
  }
  if (action === "move" && rest.length >= 2) {
    const [id, state, ...reason] = rest;
    const result = await call("codara_task_update", { id, state, ...(reason.length ? { reason: reason.join(" ") } : {}) }, flags);
    if (result) console.log(result.task ? `${taskLine(result.task)}${result.note ? `\n${result.note}` : ""}` : `${result.item.id} ${result.item.triaged.to}`);
    return;
  }
  if (action === "merge" && rest.length === 2) {
    const result = await call("codara_task_update", { id: rest[0], merge_into: rest[1] }, flags);
    if (result) console.log(`${result.item.id} merged into ${result.item.triaged.taskId}`);
    return;
  }
  if (action === "worktree" && rest.length === 3) {
    const [id, cli, worktree] = rest;
    const assignee = { cli, worktree: path.resolve(worktree), ...(flags.branch ? { branch: flags.branch } : {}) };
    const result = await call("codara_task_update", { id, assignee }, flags);
    if (result) console.log(taskLine(result.task));
    return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}

async function inboxAdd(argv) {
  const { args, flags } = parse(argv);
  if (flags.help) return console.log(USAGE);
  if (!args.length) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const result = await call("codara_inbox_add", { text: args.join(" "), ...(flags.link ? { link: flags.link } : {}) }, flags);
  if (result) console.log(`${result.item.id} filed\n${result.line}`);
}

module.exports = { task, inboxAdd, parse };
