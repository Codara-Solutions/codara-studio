import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Dev servers outlive the agent that started them. An agent in a terminal
// pane starts one with `cora server start` (the same codara_terminal_servers
// tool an MCP client calls), its pane is closed, and the server keeps
// answering; an MCP client lists it; one started by hand in a pane is
// learned from its URL; the status popover shows both and stops one; quitting
// Codara stops what it runs.

const ROOT = resolve(__dirname, "..", "..");

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

// One MCP session against the shipped server, over stdio as any agent CLI
// runs it.
async function mcpCall(home: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> {
  const child = spawn(process.execPath, [join(ROOT, "resources", "codara-studio-mcp", "server.js")], {
    env: { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_PANE_ID: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const replies = new Map<number, unknown>();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as { id?: number; result?: unknown };
        if (typeof message.id === "number") replies.set(message.id, message.result);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-client", version: "1" } } });
    await expect.poll(() => replies.has(1), { timeout: 10_000 }).toBe(true);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name, arguments: args } });
    await expect.poll(() => replies.has(2), { timeout: 30_000 }).toBe(true);
    return replies.get(2) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  } finally {
    child.kill();
  }
}

test("a dev server outlives the agent pane that started it and shows in the status view", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-dev-servers-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await writeFile(
    join(cwd, "server.cjs"),
    `const http = require("node:http");
const port = Number(process.argv[2]);
http.createServer((req, res) => { console.log("GET " + req.url); res.end("fixture"); })
  .listen(port, "127.0.0.1", () => console.log("  Local:   http://localhost:" + port + "/"));
`,
  );
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-dev",
      workspaces: [{ id: "ws-dev", name: "Dev", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SPARK_NO_SHELL_INTEGRATION") env[key] = value;
  }
  const keptPort = await freePort();
  const learnedPort = await freePort();
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      SHELL: "/bin/bash",
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-dev"]')).toBeVisible();

    // The agent's pane runs the CLI, which calls the tool with the pane's identity.
    const agentPane = await request("terminal.create", { cwd, title: "agent" });
    const started = await request("terminal.run", {
      paneId: agentPane.paneId,
      command: `CODARA_HOME_DIR='${home}' node '${join(ROOT, "cli", "cora.cjs")}' server start web --command 'node server.cjs ${keptPort}' --port ${keptPort}`,
      timeoutMs: 45_000,
    });
    expect(started.exitCode, started.output).toBe(0);
    expect(started.output).toMatch(/"ready":\s*true/);
    expect(await portAnswers(keptPort)).toBe(true);

    // The agent goes away; the server does not.
    await request("terminal.close", { paneId: agentPane.paneId });
    await new Promise((done) => setTimeout(done, 1_500));
    expect(await portAnswers(keptPort)).toBe(true);

    // Any agent's MCP client sees it, with the URL it printed.
    const listed = await mcpCall(home, "codara_terminal_servers", { action: "list" });
    expect(listed.isError).toBeFalsy();
    const servers = JSON.parse(listed.content[0].text ?? "{}").servers as Array<Record<string, unknown>>;
    expect(servers).toEqual([
      expect.objectContaining({ id: "web", state: "running", health: "up", url: `http://localhost:${keptPort}/`, port: keptPort }),
    ]);
    const twice = await mcpCall(home, "codara_terminal_servers", { action: "start", command: `node server.cjs ${keptPort}` });
    expect(JSON.parse(twice.content[0].text ?? "{}")).toMatchObject({ id: "web", alreadyRunning: true });
    const busy = await mcpCall(home, "codara_terminal_servers", { action: "start", id: "other", command: "node -e 0", port: keptPort });
    expect(busy.isError).toBe(true);
    expect(busy.content[0].text).toMatch(/already used by server "web"/);
    const logs = await mcpCall(home, "codara_terminal_servers", { action: "logs", id: "web" });
    expect(JSON.parse(logs.content[0].text ?? "{}").text).toContain(`http://localhost:${keptPort}/`);

    // A server typed into a shell pane is learned once its URL answers.
    const shell = await request("terminal.create", { cwd, title: "by hand" });
    await request("terminal.write", { paneId: shell.paneId, text: `node server.cjs ${learnedPort}` });
    await expect
      .poll(
        async () => {
          const snapshot = await page.evaluate(() => window.spark.servers.status("ws-dev"));
          return snapshot.servers.map((server) => `${server.id}:${server.state}:${server.port}`).sort();
        },
        { timeout: 45_000 },
      )
      .toEqual(["node:pane:" + learnedPort, `web:running:${keptPort}`]);

    // The status view lists both and stops the kept one.
    const chip = page.getByRole("button", { name: /^Status:/ });
    await chip.click();
    const popover = page.getByRole("dialog", { name: "Status of Dev" });
    await expect(popover).toBeVisible();
    const web = popover.locator('[data-server-id="web"]');
    await expect(web).toContainText("running");
    await expect(popover.locator('[data-server-id="node"]')).toContainText("in a terminal");
    await web.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => portAnswers(keptPort), { timeout: 10_000 }).toBe(false);
    await expect(web).toContainText("stopped");
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
  expect(await portAnswers(keptPort)).toBe(false);
});
