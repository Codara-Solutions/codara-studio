#!/usr/bin/env node
"use strict";

// cora — Codara Studio's orchestrator, from your terminal.
//
// Talks to the running app over its authenticated loopback socket
// (lib/rpc.cjs); run inspection also works offline straight from ~/.codarastudio
// (lib/store.cjs). One file per command group under commands/.
//
//   node cli/cora.cjs help        (or `npm run cora -- help`)

const { c, logo, fail } = require("./lib/ui.cjs");

const HELP = `
${logo()}

  ${c.bold("cora")} — drive Cora, Codara Studio's orchestrator, from your terminal

${c.bold("SESSIONS")}
  chat [run] [--cwd DIR --profile NAME --direct]            ${c.cyan("fullscreen Cora chat")}
  start <prompt> [--cwd DIR --profile NAME --direct]        start a Cora run
  send <run> <message|option#> [--wait]                    reply / answer a question
  wait <run> [--timeout SECONDS]                           block until it needs you
  tail <run> [--all]                                       stream live events
  cancel <run> [reason]                                    stop a run

${c.bold("PROFILES & MEMORY")}
  profile list                         list named Cora identities
  profile create <name> [--description TEXT --instructions TEXT]
                                       create isolated profile + memory
  profile use <name|id>                select the default for new chats

${c.bold("ACCOUNTS")}
  auth list [provider]                 list accounts (Cora and CLI sides)
  auth add <provider> [label]          sign in to another account
  auth use <provider> <#|label|id>     make it the Active account (Cora + CLI)
  auth use <provider> system           new sessions use the CLI's own login
  auth login|rename|remove <provider> …
  auth cli list [claude|codex|grok]    list the CLI side of each account
  auth cli rename|remove <runtime> …   rename a CLI side, remove an unused one

${c.bold("RUNS & AGENTS")}
  runs                         list runs (works offline)
  run <run>                    one run in detail
  log <run>                    the conversation transcript
  agents [run]                 subagents: every worker, its status and model
  watch [run]                  ${c.cyan("live dashboard")} of a run and its subagents
  agent spawn <run> <prompt> [--title T --runtime claude|codex|grok --effort E]
  agent message <run> <all|task-id> <message>

${c.bold("SURFACES")}
  board <run>                  the run's kanban board
  whiteboard <run>             the run's whiteboard markdown
  auto list                    automations in the workspace
  auto run|pause|resume|on|off <automation-id>
  workflow list|show|check|run|status|wait|stop|resume|save
                               workflows: scripts that fan work out to many
                               agents (\`cora workflow help\`)

${c.bold("BENCH")}
  bench [--split train|holdout|all] [--task NAME[,NAME]] [--repeat N] [--keep]
                               harness benchmark via the live app: 0-100 score
                               (correctness, par efficiency, post-green
                               discipline, orchestration); appends history.jsonl
  bench --agent hermes|codex|claude [--model M --effort E]
                               same-model comparison through Hermes Agent
  bench matrix --models all|M1,M2 --output DIR [--task NAME --repeat N]
                               run a model matrix with per-model artifacts
  bench --output FILE          save a new JSON artifact with every check
  bench list                   show the suite's tasks (tier, split)
  bench history                score trajectory across runs
  ws prune                     remove workspaces whose directory is gone

${c.bold("APP")}
  status                       is Codara running? version + activity
  read <paneId> [--lines N]    read a terminal pane
  rpc <method> [params-json]   raw JSON-RPC escape hatch

${c.bold("TOOLS")}  the codara-studio tools, for agents without MCP
  tool list                    browser, terminal, worktree and other tools here
  tool help <name>             a tool's description and arguments
  tool <name> [json] [--arg v] call it; images are saved and their paths printed
  inbox [--peek --limit N]     what the user picked or commented on for you
  inspect <@ref|selector>      describe an element to edit it: box model, styles,
          [--x N --y N --tabId ID]  CSS rules, source file:line, image

${c.bold("FLAGS")}  --json (raw output)   --home DIR (Codara home, default ~/.codarastudio)

  <run> accepts a full id or any unique prefix.
`;

function parseArgs(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const boolFlags = new Set(["json", "wait", "all", "keep", "verbose", "direct", "managed", "default", "yes"]);
    if (boolFlags.has(name)) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { args, flags };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { args, flags } = parseArgs(rest);

  switch (command) {
    case undefined:
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return require("./commands/chat.cjs").chat([], flags);
      }
      console.log(HELP);
      return;

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "chat":
      return require("./commands/chat.cjs").chat(args, flags);

    case "profile":
      return require("./commands/profiles.cjs").profile(args, flags);

    case "auth":
    case "accounts":
      return require("./commands/auth.cjs").auth(args, flags);

    case "status":
      return require("./commands/status.cjs").status(args, flags);

    case "start":
    case "send":
    case "wait":
    case "tail":
    case "cancel":
      return require("./commands/session.cjs")[command](args, flags);

    case "runs":
    case "run":
    case "log":
      return require("./commands/runs.cjs")[command](args, flags);

    case "agents":
    case "watch":
    case "agent":
      return require("./commands/agents.cjs")[command](args, flags);

    case "board":
      return require("./commands/board.cjs").board(args, flags);
    case "whiteboard":
      return require("./commands/board.cjs").whiteboard(args, flags);

    case "auto":
      return require("./commands/automations.cjs").auto(args, flags);

    case "workflow":
    case "workflows":
      return require("./commands/workflow.cjs").workflow(args, flags);

    case "bench":
      return require("./commands/bench.cjs").bench(args, flags);

    case "ws": {
      const { rpc } = require("./lib/rpc.cjs");
      const { c } = require("./lib/ui.cjs");
      if (args[0] !== "prune") fail("usage: cora ws prune  (removes workspaces whose directory is gone)");
      const { removed } = await rpc(flags, "workspace.prune", {});
      if (removed.length === 0) return console.log(c.dim("nothing to prune"));
      for (const workspace of removed) console.log(`${c.red("−")} ${workspace.name}  ${c.dim(workspace.cwd)}`);
      console.log(`pruned ${c.bold(String(removed.length))} workspace${removed.length === 1 ? "" : "s"}`);
      return;
    }

    case "read": {
      const { rpc } = require("./lib/rpc.cjs");
      if (!args[0]) fail("usage: cora read <paneId> [--lines N]");
      const params = { paneId: args[0] };
      if (flags.lines) params.lines = Number(flags.lines);
      const result = await rpc(flags, "terminal.read", params);
      console.log(flags.json ? JSON.stringify(result, null, 2) : result.text);
      return;
    }

    case "inbox":
    case "inspect": {
      const point = require("./commands/point.cjs");
      const parsed = point.parsePointArgs(rest);
      return point[command](parsed.args, parsed.flags);
    }

    case "tool":
    case "tools":
      // Tool arguments are the tool's own flags, so they skip parseArgs.
      return require("./commands/tool.cjs").tool(rest);

    case "rpc": {
      const { rpcRaw } = require("./lib/rpc.cjs");
      if (!args[0]) fail("usage: cora rpc <method> [params-json]");
      const res = await rpcRaw(flags, args[0], args[1] ? JSON.parse(args[1]) : {});
      console.log(JSON.stringify(res.error ?? res.result, null, 2));
      if (res.error) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${command}\nRun \`cora help\` for usage.`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
