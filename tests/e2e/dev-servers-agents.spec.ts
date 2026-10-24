import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Dev servers as agents use them, with Codara in the background: the window
// hidden and the agents' terminal tabs behind another tab. An agent in one
// pane starts a server through the codara-studio tool server over stdio (as
// any MCP client does), with a secret typed before the command; that agent
// goes away and a second one in a new pane finds the server, follows its log
// across a restart, and stops it with `cora server` (the path for agents
// without MCP), which ends the whole process tree. A busy port names the
// process holding it, and an auto-start server comes back when Codara opens
// the workspace again.

const ROOT = resolve(__dirname, "..", "..");

// An MCP client run inside a pane: it gets the pane's identity from the
// pane's environment, calls each tool in order and writes the replies to a file.
const PROBE = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [serverJs, callsFile, outFile] = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));
const child = spawn(process.execPath, [serverJs], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (waiting.has(message.id)) waiting.get(message.id)(message);
  }
});
const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const call = (id, method, params) => new Promise((done) => { waiting.set(id, done); send({ id, method, params }); });
(async () => {
  await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } });
  send({ method: "notifications/initialized" });
  const out = [];
  let id = 2;
  for (const [name, args] of calls) {
    const reply = await call(id++, "tools/call", { name, arguments: args });
    out.push(reply.result);
  }
  fs.writeFileSync(outFile, JSON.stringify(out));
  child.kill();
  console.log("PROBE-DONE");
})();
`;

// Prints its pid and URL, and echoes what is typed into it like a server's
// prompt; started through a shell script so the listener is a grandchild of
// the session Codara runs.
const SERVER = `const http = require("node:http");
const port = Number(process.argv[2]);
http.createServer((req, res) => { console.log("GET " + req.url); res.end("fixture"); })
  .listen(port, "127.0.0.1", () => {
    console.log("pid=" + process.pid + " token=" + (process.env.DEV_TOKEN ? "set" : "missing"));
    console.log("  Local:   http://localhost:" + port + "/");
  });
process.stdin.on("data", (data) => console.log("answer=" + String(data).trim()));
`;

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function body(reply: ToolReply): Record<string, any> {
  return JSON.parse(reply.content[0]?.text ?? "{}");
}

test("agents keep, find, follow and stop dev servers with Codara in the background", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-dev-agents-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await writeFile(join(cwd, "server.cjs"), SERVER);
  await writeFile(join(cwd, "dev.sh"), `node server.cjs "$1"\n`);
  await writeFile(join(root, "probe.cjs"), PROBE);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-dev",
      workspaces: [{ id: "ws-dev", name: "Dev", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const workspaceFiles = (await readdir(cwd)).sort();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SPARK_NO_SHELL_INTEGRATION") env[key] = value;
  }
  const launch = () =>
    electron.launch({
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
  let probeRuns = 0;
  const agentCalls = async (paneId: string, calls: Array<[string, Record<string, unknown>]>): Promise<ToolReply[]> => {
    probeRuns += 1;
    const callsFile = join(root, `calls-${probeRuns}.json`);
    const outFile = join(root, `out-${probeRuns}.json`);
    await writeFile(callsFile, JSON.stringify(calls));
    const ran = await request("terminal.run", {
      paneId,
      command: `node '${join(root, "probe.cjs")}' '${join(ROOT, "resources", "codara-studio-mcp", "server.js")}' '${callsFile}' '${outFile}'`,
      timeoutMs: 60_000,
    });
    expect(String(ran.output), ran.output).toContain("PROBE-DONE");
    return JSON.parse(await readFile(outFile, "utf8"));
  };
  const hide = (target: ElectronApplication) =>
    target.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.blur();
        win.hide();
      }
    });

  const port = await freePort();
  const busyPort = await freePort();
  let holder: Server | null = null;
  let app = await launch();
  let serverPid = 0;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-dev"]')).toBeVisible();

    // Two agent panes, then a later tab in front of them; the window goes away.
    const first = await request("terminal.create", { cwd, title: "agent one" });
    await request("terminal.create", { cwd, title: "in front" });
    await hide(app);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible() || win.isFocused()))).toBe(false);

    const [started, refused] = await agentCalls(first.paneId, [
      ["codara_terminal_servers", { action: "start", id: "web", command: `DEV_TOKEN=tok-not-saved sh dev.sh ${port}`, port }],
      ["codara_terminal_servers", { action: "start", id: "other", command: "node -e 0", port: busyPort }],
    ]);
    expect(started.isError, started.content[0]?.text).toBeFalsy();
    expect(body(started)).toMatchObject({ id: "web", state: "running", health: "up", ready: true, command: `sh dev.sh ${port}`, envNames: ["DEV_TOKEN"] });
    // Nothing held the port yet, so the second start ran; it exits at once.
    expect(refused.isError).toBeFalsy();

    // The first agent goes away (its pane closes, as on a restart).
    await request("terminal.close", { paneId: first.paneId });
    await new Promise((done) => setTimeout(done, 1_000));
    expect(await portAnswers(port)).toBe(true);

    holder = createServer().listen(busyPort, "127.0.0.1");
    await new Promise((done) => holder!.once("listening", done));

    // The restarted agent, in a new pane, finds the server and follows its log across a restart.
    const second = await request("terminal.create", { cwd, title: "agent two" });
    await request("terminal.create", { cwd, title: "in front again" });
    const [listed, logs, busy] = await agentCalls(second.paneId, [
      ["codara_terminal_servers", { action: "list" }],
      ["codara_terminal_servers", { action: "logs", id: "web" }],
      ["codara_terminal_servers", { action: "start", id: "other" }],
    ]);
    const web = body(listed).servers.find((server: { id: string }) => server.id === "web");
    expect(web).toMatchObject({ state: "running", health: "up", url: `http://localhost:${port}/`, envNames: ["DEV_TOKEN"] });
    const firstLog = body(logs);
    expect(firstLog.text).toContain("token=set");
    expect(busy.isError).toBe(true);
    expect(busy.content[0].text).toMatch(new RegExp(`Port ${busyPort} is already in use by .*\\(pid ${process.pid}\\)`));

    const [restarted, followed] = await agentCalls(second.paneId, [
      ["codara_terminal_servers", { action: "restart", id: "web" }],
      ["codara_terminal_servers", { action: "logs", id: "web", since: firstLog.cursor }],
    ]);
    expect(body(restarted)).toMatchObject({ id: "web", ready: true, health: "up" });
    const followedText = String(body(followed).text);
    expect(followedText).toContain(`http://localhost:${port}/`);
    serverPid = Number(/pid=(\d+)/.exec(followedText)?.[1]);
    expect(serverPid).toBeGreaterThan(0);
    expect(pidAlive(serverPid)).toBe(true);

    // Any agent may answer the server's prompts in the session Codara runs it in.
    const serverPane = String(body(restarted).paneId);
    const [answered] = await agentCalls(second.paneId, [["codara_terminal_write", { paneId: serverPane, text: "y" }]]);
    expect(answered.isError, answered.content[0]?.text).toBeFalsy();
    await expect
      .poll(async () => (await page.evaluate(() => window.spark.servers.logs("ws-dev", "web"))).text, { timeout: 10_000 })
      .toContain("answer=y");

    // Codara keeps names, never the value, and only in its own data folder.
    const saved = await readFile(join(home, "workspace-data", "ws-dev", "servers", "servers.json"), "utf8");
    expect(saved).toContain("DEV_TOKEN");
    expect(saved).not.toContain("tok-not-saved");
    expect((await readdir(cwd)).sort()).toEqual(workspaceFiles);

    // An agent without MCP stops it from its shell; the grandchild listener ends too.
    const stopped = await request("terminal.run", {
      paneId: second.paneId,
      command: `CODARA_HOME_DIR='${home}' node '${join(ROOT, "cli", "cora.cjs")}' server stop web`,
      timeoutMs: 45_000,
    });
    expect(stopped.exitCode, stopped.output).toBe(0);
    await expect.poll(() => portAnswers(port), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => pidAlive(serverPid), { timeout: 10_000 }).toBe(false);

    // Shown again, the status view is current without waiting for its poll.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.showInactive();
    });
    await page.getByRole("button", { name: /^Status:/ }).click();
    const popover = page.getByRole("dialog", { name: "Status of Dev" });
    await expect(popover.locator('[data-server-id="web"]')).toContainText("stopped");
    await page.keyboard.press("Escape");

    const [autoStart] = await agentCalls(second.paneId, [["codara_terminal_servers", { action: "save", id: "web", autoStart: true }]]);
    expect(body(autoStart)).toMatchObject({ id: "web", autoStart: true });
  } finally {
    await app.close();
  }

  // Codara opens the workspace again: the auto-start server comes back, without the value it never kept.
  app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect.poll(() => portAnswers(port), { timeout: 30_000 }).toBe(true);
    const snapshot = await page.evaluate(() => window.spark.servers.status("ws-dev"));
    expect(snapshot.servers.find((server) => server.id === "web")).toMatchObject({ state: "running", missingEnv: ["DEV_TOKEN"] });
    const logs = await page.evaluate(() => window.spark.servers.logs("ws-dev", "web"));
    expect(logs.text).toContain("token=missing");

    // The status view's log follows new output.
    await page.getByRole("button", { name: /^Status:/ }).click();
    const row = page.getByRole("dialog", { name: "Status of Dev" }).locator('[data-server-id="web"]');
    await row.getByRole("button", { name: "Logs" }).click();
    const output = row.getByLabel("Output of web");
    await expect(output).toContainText("token=missing");
    await fetch(`http://127.0.0.1:${port}/followed`);
    await expect(output).toContainText("GET /followed", { timeout: 10_000 });
    await expect(output).toContainText("token=missing");
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
    holder?.close();
    await rm(root, { recursive: true, force: true });
  }
  expect(await portAnswers(port)).toBe(false);
});
