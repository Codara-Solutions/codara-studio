"use strict";

// `cora server`: the workspace's dev servers from a shell, for people and for
// agents without MCP. A thin face over the codara_terminal_servers tool, so
// it acts on the same workspace (the pane it runs in), with the same rules.
//
//   cora server list
//   cora server start [id] [--command "pnpm dev" --cwd DIR --port 3101 --autoStart]
//   cora server stop|restart|forget <id>
//   cora server logs <id> [--since CURSOR] [--follow]
//   cora server save <id> [--command C --port P --url U --autoStart true|false]

const fs = require("node:fs");
const path = require("node:path");

const { parseToolArgs, tool } = require("./tool.cjs");

const ACTIONS = new Set(["list", "start", "stop", "restart", "logs", "save", "forget"]);

const USAGE = `usage:
  cora server list
  cora server start [id] [--command "pnpm dev" --cwd DIR --port N --env '{"NAME":"value"}' --autoStart]
  cora server stop|restart|forget <id>
  cora server logs <id> [--since CURSOR] [--follow]
  cora server save <id> [--command C --cwd DIR --port N --url U --autoStart true|false]`;

function serverArgv(argv) {
  const [action = "list", ...rest] = argv;
  if (!ACTIONS.has(action)) return null;
  const out = ["terminal_servers", "--action", action];
  const [first] = rest;
  if (first !== undefined && !first.startsWith("--")) out.push("--id", first, ...rest.slice(1));
  else out.push(...rest);
  return out;
}

// The same server module `cora tool` loads: packaged next to the CLI, or in
// the repository checkout.
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

async function callServers(argv) {
  const { args, own } = parseToolArgs(argv);
  if (own.home) process.env.CODARA_HOME_DIR = own.home;
  return serverModule().callToolByName("codara_terminal_servers", args);
}

function printList(result) {
  let parsed;
  try {
    parsed = JSON.parse(result.content[0].text);
  } catch {
    return false;
  }
  if (!parsed || !Array.isArray(parsed.servers)) return false;
  if (parsed.servers.length === 0) {
    console.log(parsed.hint || "No servers.");
    return true;
  }
  for (const entry of parsed.servers) {
    const where = entry.url || (entry.port ? `port ${entry.port}` : "");
    console.log(`${entry.id.padEnd(16)} ${String(entry.state).padEnd(8)} ${String(entry.health).padEnd(8)} ${where}`);
    console.log(`${"".padEnd(16)} ${entry.command}  (${entry.cwd})`);
  }
  return true;
}

async function servers(argv) {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    return;
  }
  const mapped = serverArgv(argv);
  if (!mapped) {
    console.error(`unknown action: ${argv[0]}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const follow = mapped.includes("--follow");
  const json = mapped.includes("--json");
  const cleaned = mapped.filter((token) => token !== "--follow");
  if (mapped[2] === "list" && !json) {
    const result = await callServers(cleaned.slice(1));
    if (result.isError || !printList(result)) {
      for (const block of result.content || []) if (block.type === "text") console.log(block.text);
    }
    if (result.isError) process.exitCode = 1;
    return;
  }
  if (mapped[2] === "logs" && follow) {
    let since;
    for (;;) {
      const result = await callServers([...cleaned.slice(1), ...(since !== undefined ? ["--since", String(since)] : [])]);
      if (result.isError) {
        console.error(result.content?.[0]?.text ?? "logs failed");
        process.exitCode = 1;
        return;
      }
      const reply = JSON.parse(result.content[0].text);
      if (reply.text) process.stdout.write(reply.text.endsWith("\n") ? reply.text : `${reply.text}\n`);
      since = reply.cursor;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return tool(cleaned);
}

module.exports = { servers, serverArgv };
