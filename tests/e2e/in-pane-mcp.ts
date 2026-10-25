import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A codara-studio MCP server, or the cora CLI, run inside a terminal pane as
// an agent CLI's would be. Codara takes an agent's pane from its process
// tree, not from the pane id in its environment, so a process the test
// started itself belongs to no pane. FAKE_AGENT is a stand-in agent CLI to
// run in a pane: it starts the server as its child, with its stdin and stdout
// on two named pipes the test talks through. runInPane types a command into a
// pane's shell instead and returns what it printed.

export const MCP_SERVER = resolve(__dirname, "..", "..", "resources", "codara-studio-mcp", "server.js");

// argv: server, codara home, input pipe, output pipe.
export const FAKE_AGENT = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [server, home, input, output] = process.argv.slice(2);
const stdin = fs.openSync(input, "r");
const stdout = fs.openSync(output, "w");
const env = { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home };
for (const key of ["SPARK_RUN_ID", "SPARK_MCP_MODE"]) delete env[key];
spawn(process.execPath, [server], { env, stdio: [stdin, stdout, "inherit"] });
setInterval(() => {}, 1 << 30);
`;

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export interface PaneMcp {
  // The command to start the fake agent in a pane.
  command: string;
  // Line-delimited JSON-RPC to and from the server, once the pane runs it.
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: any) => void): void;
  close(): void;
}

// `agent` is the path FAKE_AGENT was written to (mode 0755), named like the
// CLI the pane should look like; `dir` holds the pipes.
export function paneMcp(agent: string, home: string, dir: string, name: string): PaneMcp {
  const input = join(dir, `${name}.in`);
  const output = join(dir, `${name}.out`);
  execFileSync("mkfifo", [input, output]);
  const writer = createWriteStream(input);
  const reader = createReadStream(output, { encoding: "utf8" });
  const listeners: Array<(message: any) => void> = [];
  let buffer = "";
  reader.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        for (const listener of listeners) listener(message);
      }
    }
  });
  return {
    command: [agent, MCP_SERVER, home, input, output].map(quote).join(" "),
    send: (message) => writer.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    onMessage: (listener) => listeners.push(listener),
    close: () => {
      writer.destroy();
      reader.destroy();
    },
  };
}

let runs = 0;

// Runs argv in the shell of `paneId` (a plain shell at its prompt) and
// resolves with its stdout. Files go next to the codara home.
export async function runInPane(home: string, paneId: string, argv: string[], timeoutMs = 75_000): Promise<string> {
  runs += 1;
  const out = join(dirname(home), `pane-run-${process.pid}-${runs}.out`);
  const line = `${argv.map(quote).join(" ")} > ${quote(`${out}.tmp`)}; mv ${quote(`${out}.tmp`)} ${quote(out)}`;
  const written = await rpcRaw({ home }, "terminal.write", { paneId, text: line }, { timeoutMs: 10_000 });
  if (written.error) throw new Error(written.error.message);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(out, "utf8").catch(() => null);
    if (text !== null) return text;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${argv[1] ?? argv[0]} in pane ${paneId}`);
}

// argv: server, codara home, request file. Prints the tools/call result.
const ONE_CALL = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [server, home, requestFile] = process.argv.slice(2);
const { name, args } = JSON.parse(fs.readFileSync(requestFile, "utf8"));
const env = { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home };
for (const key of ["SPARK_RUN_ID", "SPARK_MCP_MODE"]) delete env[key];
const child = spawn(process.execPath, [server], { env, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line && JSON.parse(line).id === 2) {
      process.stdout.write(JSON.stringify(JSON.parse(line).result), () => {
        child.kill();
        process.exit(0);
      });
    }
  }
});
const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } } });
send({ method: "notifications/initialized" });
send({ id: 2, method: "tools/call", params: { name, arguments: args } });
`;

// One tools/call from an MCP server started in `paneId`'s shell; resolves
// with the tools/call result (content, isError).
export async function mcpToolInPane(home: string, paneId: string, name: string, args: Record<string, unknown>): Promise<any> {
  runs += 1;
  const caller = join(dirname(home), "mcp-one-call.cjs");
  const requestFile = join(dirname(home), `mcp-request-${process.pid}-${runs}.json`);
  await writeFile(caller, ONE_CALL);
  await writeFile(requestFile, JSON.stringify({ name, args }));
  return JSON.parse(await runInPane(home, paneId, [process.execPath, caller, MCP_SERVER, home, requestFile]));
}
