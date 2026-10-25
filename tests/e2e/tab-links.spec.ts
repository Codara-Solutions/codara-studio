import { test, expect, type Locator, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FAKE_AGENT, paneMcp } from "./in-pane-mcp";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Tab links. The user copies a tab's codara://tab link from its menu and
// clicks one in a terminal to bring the tab on screen; Split right docks a
// tab beside the one on screen. An agent closes its own tab at once, but a
// tab the user opened waits for the approval card: Deny keeps it, Allow once
// closes it, and "Always allow" stores a grant that skips the next card.
// Agents call from inside their terminal, as a real one does: another agent's
// terminal needs the card, and so does a new process in the opener's pane
// whose session Codara never captured; a pane id set from outside that pane
// counts for nothing, and a card whose agent stopped waiting is withdrawn.
//
// TAB_LINKS_SHOTS=<dir> also saves screenshots of the menu and the card.

const ROOT = resolve(__dirname, "..", "..");
const SERVER = join(ROOT, "resources", "codara-studio-mcp", "server.js");

type Fixture = {
  root: string;
  // The in-pane MCP caller (IN_PANE_CALLER) and a counter for its files.
  caller: string;
  calls: number;
  home: string;
  cwd: string;
  origin: string;
  server: Server;
  launch: () => Promise<{ app: ElectronApplication; page: Page }>;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
};

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-tab-links-"));
  const home = join(root, "home");
  const cwd = join(root, "a");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const caller = join(root, "mcp-call.cjs");
  await writeFile(caller, IN_PANE_CALLER);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Links", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${req.url}</title><body><h1>${req.url}</h1></body>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    ...process.env,
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
  };
  const launch = async () => {
    const app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();
    return { app, page };
  };
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  return { root, caller, calls: 0, home, cwd, origin, server, launch, request };
}

async function teardown(fixture: Fixture, app: ElectronApplication | null): Promise<void> {
  await app?.close();
  await new Promise<void>((done) => fixture.server.close(() => done()));
  await rm(fixture.root, { recursive: true, force: true });
}

function agentEnv(home: string, paneId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_PANE_ID: paneId };
  for (const key of ["SPARK_RUN_ID", "SPARK_AGENT_PANE_ID", "SPARK_MCP_MODE"]) delete env[key];
  return env;
}

// One tools/call over the codara-studio MCP server's stdio, as an agent in
// that pane would make it. A refusal (ok: false) comes back as isError.
async function mcpCall(home: string, paneId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const child = spawn(process.execPath, [SERVER], { env: agentEnv(home, paneId), stdio: ["pipe", "pipe", "inherit"] });
  try {
    let buffer = "";
    const waiting = new Map<number, (message: any) => void>();
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    });
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const call = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<any>((done) => {
        waiting.set(id, done);
        send({ id, method, params });
      });
    await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } });
    send({ method: "notifications/initialized" });
    const reply = await call(2, "tools/call", { name, arguments: args });
    const text = reply.result.content[0].text as string;
    if (!text.startsWith("{")) throw new Error(`${name}: ${text}`);
    const result = JSON.parse(text);
    expect(Boolean(reply.result?.isError), JSON.stringify(reply.result)).toBe(result.ok === false);
    return result;
  } finally {
    child.kill();
  }
}

// One tools/call made by a codara-studio MCP server started inside a pane, so
// its process descends from that pane's shell as an agent CLI's does.
// Arguments: server, codara home, request file, result file.
const IN_PANE_CALLER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [server, home, requestFile, resultFile] = process.argv.slice(2);
const { name, args } = JSON.parse(fs.readFileSync(requestFile, "utf8"));
const env = { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home };
const child = spawn(process.execPath, [server], { env, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 2) {
      fs.writeFileSync(resultFile + ".tmp", JSON.stringify(message.result));
      fs.renameSync(resultFile + ".tmp", resultFile);
      child.kill();
      process.exit(0);
    }
  }
});
const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } } });
send({ method: "notifications/initialized" });
send({ id: 2, method: "tools/call", params: { name, arguments: args } });
`;

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

// A plain shell standing in for an agent CLI's terminal.
async function agentPane(fixture: Fixture, title: string): Promise<string> {
  const pane = await fixture.request("terminal.create", { cwd: fixture.cwd, title });
  return pane.paneId as string;
}

// codara_* tool call from inside `paneId`; resolves with the parsed result.
// A refusal (ok: false) comes back as isError.
async function mcpCallInPane(fixture: Fixture, paneId: string, name: string, args: Record<string, unknown>): Promise<any> {
  fixture.calls += 1;
  const requestFile = join(fixture.root, `call-${fixture.calls}.json`);
  const resultFile = join(fixture.root, `result-${fixture.calls}.json`);
  await writeFile(requestFile, JSON.stringify({ name, args }));
  const command = [process.execPath, fixture.caller, SERVER, fixture.home, requestFile, resultFile].map(shellQuote).join(" ");
  await fixture.request("terminal.write", { paneId, text: command });
  let raw = "";
  await expect
    .poll(async () => (raw = await readFile(resultFile, "utf8").catch(() => "")), { timeout: 75_000 })
    .not.toBe("");
  const reply = JSON.parse(raw);
  const text = reply.content[0].text as string;
  if (!text.startsWith("{")) throw new Error(`${name}: ${text}`);
  const result = JSON.parse(text);
  expect(Boolean(reply.isError), raw).toBe(result.ok === false);
  return result;
}

// An agent CLI in `paneId`'s shell with one MCP server for its whole life, as
// Claude Code or Codex runs one, so what it opens stays its own. In the
// background it leaves the shell free for another process in the same pane;
// in the foreground Ctrl-C in the pane ends it.
async function startAgent(
  fixture: Fixture,
  paneId: string,
  name: string,
  { background }: { background: boolean },
): Promise<{ call(tool: string, args: Record<string, unknown>): Promise<any> }> {
  const bin = join(fixture.root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), FAKE_AGENT, { mode: 0o755 });
  const link = paneMcp(join(bin, name), fixture.home, fixture.root, name);
  let nextId = 1;
  const replies = new Map<number, (message: any) => void>();
  link.onMessage((message) => {
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((done, fail) => {
      const id = nextId++;
      replies.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      link.send({ id, method, params });
    });
  await fixture.request("terminal.write", { paneId, text: background ? `${link.command} &` : link.command });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
  link.send({ method: "notifications/initialized" });
  return {
    async call(tool, args) {
      const reply = await request("tools/call", { name: tool, arguments: args });
      const text = reply.content[0].text as string;
      if (!text.startsWith("{")) throw new Error(`${tool}: ${text}`);
      const result = JSON.parse(text);
      expect(Boolean(reply.isError), text).toBe(result.ok === false);
      return result;
    },
  };
}

// A call left waiting on the card. If a step fails first, its rejection must
// not hide that step's error.
function waiting<T>(call: Promise<T>): Promise<T> {
  call.catch(() => undefined);
  return call;
}

const stripIds = (page: Page) =>
  page.$$eval(".spark-tabbar-scroll [data-tab-id]", (nodes) => nodes.map((node) => (node as HTMLElement).dataset.tabId ?? ""));

const tab = (id: string) => `.spark-tabbar-scroll [data-tab-id="${id}"]`;

async function openUserTab(fixture: Fixture, page: Page, path: string): Promise<string> {
  const before = new Set(await stripIds(page));
  await page.evaluate(
    (url) => window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url, forceNew: true, background: true } })),
    `${fixture.origin}${path}`,
  );
  let id = "";
  await expect
    .poll(async () => {
      id = (await stripIds(page)).find((item) => !before.has(item)) ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  const dir = process.env.TAB_LINKS_SHOTS;
  if (dir) await target.screenshot({ path: join(dir, name) });
}

// The row and column of `text` on the pane's visible screen, and the grid size
// the shell reported with `stty size` right above it.
async function locateOnScreen(fixture: Fixture, paneId: string, text: string): Promise<{ row: number; col: number; rows: number; cols: number }> {
  let found: { row: number; col: number; rows: number; cols: number } | null = null;
  await expect
    .poll(async () => {
      const read = await fixture.request("terminal.read", { paneId, mode: "screen" });
      const lines = String(read.text).split("\n");
      const row = lines.findIndex((line) => line.trim() === text);
      const size = row > 0 ? /^(\d+) (\d+)$/.exec(lines[row - 1].trim()) : null;
      found = size ? { row, col: lines[row].indexOf(text), rows: Number(size[1]), cols: Number(size[2]) } : null;
      return Boolean(found);
    }, { timeout: 20_000 })
    .toBe(true);
  return found!;
}

test("copy a tab's link, click it in a terminal, split right; an agent closes tabs it did not open only with approval", async () => {
  test.setTimeout(240_000);
  const fixture = await setup();
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await fixture.launch());
    const target = await openUserTab(fixture, page, "/target");

    // Copy link writes the tab's codara://tab link.
    await page.locator(tab(target)).click({ button: "right" });
    const copy = page.getByRole("button", { name: /^Copy link/ });
    await expect(copy).toBeVisible();
    await shot(page, "tab-context-menu.png");
    await copy.click();
    const link = `codara://tab/ws-a/${target}`;
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(link);

    // Clicking the link in a terminal brings its tab on screen. The typed
    // command spells it with quotes so only the echoed line is a link.
    const quoted = link.replace("codara://", "codara:''//");
    const term = await fixture.request("terminal.create", {
      cwd: fixture.cwd,
      title: "links",
      command: `L=${quoted}; stty size; echo "$L"`,
    });
    await page.locator(tab(term.tabId)).click();
    await expect(page.locator(`${tab(term.tabId)}.spark-tab--active`)).toHaveCount(1);
    const at = await locateOnScreen(fixture, term.paneId, link);
    const pane = page.locator(`[data-terminal-pane-id="${term.paneId}"]`);
    const box = await pane.locator(".xterm-screen").first().boundingBox();
    expect(box).toBeTruthy();
    const x = box!.x + (at.col + 10 + 0.5) * (box!.width / at.cols);
    const y = box!.y + (at.row + 0.5) * (box!.height / at.rows);
    await page.mouse.move(x - 3, y);
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator(`${tab(target)}.spark-tab--active`)).toHaveCount(1);

    // Split right docks the browser tab beside the terminal on screen.
    await page.locator(tab(term.tabId)).click();
    await page.locator(tab(target)).click({ button: "right" });
    await expect(page.getByRole("button", { name: "Split right", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Split down", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Split right", exact: true }).click();
    await expect(page.locator("[data-dock-cell-id]")).toHaveCount(1, { timeout: 20_000 });

    // The agent's list tools hand out the same links.
    const agent = { paneId: await agentPane(fixture, "Agent") };
    const listed = (await fixture.request("preview.list", { callerPaneId: agent.paneId })).tabs as Array<{ id: string; link?: string }>;
    expect(listed.find((item) => item.id === target)?.link).toBe(link);
    const panes = (await fixture.request("terminal.list", { callerPaneId: agent.paneId })).panes as Array<{ paneId: string; link?: string }>;
    expect(panes.find((item) => item.paneId === term.paneId)?.link).toBe(`codara://tab/ws-a/${term.tabId}`);

    // A tab the agent opened closes without asking.
    const running = await startAgent(fixture, agent.paneId, "claude", { background: true });
    const own = await running.call("codara_preview_navigate", { url: `${fixture.origin}/own` });
    const closedOwn = await running.call("codara_tab", { action: "close", link: `codara://tab/ws-a/${own.tabId}` });
    expect(closedOwn).toMatchObject({ ok: true, closed: [own.tabId] });
    expect(closedOwn.approvedBy).toBeUndefined();
    await expect(page.locator(tab(own.tabId))).toHaveCount(0);

    // A tab the user opened waits for the card. Deny keeps it.
    const userTab = await openUserTab(fixture, page, "/mine");
    const card = page.locator("[data-tab-action-approval]");
    let pending = waiting(mcpCallInPane(fixture, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${userTab}` }));
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("wants to close");
    await expect(card.locator(".tab-action-prompt__row")).toHaveCount(1);
    await expect(card.locator(".tab-action-prompt__kind")).toHaveText("Browser");
    await expect(card.getByRole("button", { name: /^Always allow “Links” to close tabs here$/ })).toBeVisible();
    await shot(card, "tab-approval-card.png");
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    expect(await pending).toMatchObject({ ok: false, reason: "denied" });
    await expect(page.locator(tab(userTab))).toHaveCount(1);

    // Allow once closes it.
    pending = waiting(mcpCallInPane(fixture, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${userTab}` }));
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
    expect(await pending).toMatchObject({ ok: true, closed: [userTab], approvedBy: "card" });
    await expect(page.locator(tab(userTab))).toHaveCount(0);

    // Always allow closes this one, is listed for Settings, and the next tab
    // closes without a card.
    const second = await openUserTab(fixture, page, "/second");
    pending = waiting(mcpCallInPane(fixture, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${second}` }));
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: /^Always allow/ }).click();
    expect(await pending).toMatchObject({ ok: true, closed: [second] });
    await expect
      .poll(() => page.evaluate(() => window.spark.tabActions.grants()))
      .toEqual([expect.objectContaining({ action: "close", callerWorkspaceId: "ws-a", targetWorkspaceId: "ws-a" })]);
    const third = await openUserTab(fixture, page, "/third");
    const granted = await mcpCallInPane(fixture, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${third}` });
    expect(granted).toMatchObject({ ok: true, closed: [third], approvedBy: "grant" });
    await expect(card).toHaveCount(0);

    // Revoked, the card comes back.
    await page.evaluate(() => window.spark.tabActions.revoke("close", "ws-a", "ws-a"));
    const fourth = await openUserTab(fixture, page, "/fourth");
    pending = waiting(mcpCallInPane(fixture, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${fourth}` }));
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    expect(await pending).toMatchObject({ ok: false, reason: "denied" });

    // A link to a closed tab says so instead of doing nothing.
    await page.evaluate((url) => window.dispatchEvent(new CustomEvent("spark:open-tab-link", { detail: { url } })), `codara://tab/ws-a/${second}`);
    await expect(page.getByText("That tab is closed")).toBeVisible();
  } finally {
    await teardown(fixture, app);
  }
});

test("an agent closes only the terminals it opened; a borrowed pane id or a gone agent changes nothing", async () => {
  test.setTimeout(240_000);
  const fixture = await setup();
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await fixture.launch());
    const card = page.locator("[data-tab-action-approval]");
    const claude = await agentPane(fixture, "Claude");
    const codex = await agentPane(fixture, "Codex");
    const claudeAgent = await startAgent(fixture, claude, "claude", { background: true });

    // Claude opens a dev server terminal.
    const dev = await claudeAgent.call("codara_terminal_create", { title: "dev", command: "sleep 600" });
    const devLink = `codara://tab/ws-a/${dev.tabId}`;

    // Another process started in Claude's pane, with no session Codara
    // captured, is not Claude: its pane alone proves nothing.
    let pending = waiting(mcpCallInPane(fixture, claude, "codara_tab", { action: "close", link: devLink }));
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    expect(await pending).toMatchObject({ ok: false, reason: "denied" });
    await expect(mcpCallInPane(fixture, claude, "codara_terminal_close", { paneId: dev.paneId })).rejects.toThrow(/another agent opened/);
    await expect(page.locator(tab(dev.tabId))).toHaveCount(1);

    // Codex, in another pane, may not close it alone: the card asks.
    pending = waiting(mcpCallInPane(fixture, codex, "codara_tab", { action: "close", link: devLink }));
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator(".tab-action-prompt__row")).toHaveCount(1);
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    expect(await pending).toMatchObject({ ok: false, reason: "denied" });
    await expect(mcpCallInPane(fixture, codex, "codara_terminal_close", { paneId: dev.paneId })).rejects.toThrow(/another agent opened/);
    await expect(page.locator(tab(dev.tabId))).toHaveCount(1);

    // A process outside Claude's pane that names Claude's pane is no one's
    // pane, so it has no workspace to act in and closes nothing.
    const spoofed = await mcpCall(fixture.home, claude, "codara_tab", { action: "close", link: devLink });
    expect(spoofed).toMatchObject({ ok: false, reason: "not_in_codara_workspace" });
    await expect(page.locator(tab(dev.tabId))).toHaveCount(1);

    // The agent leaves while the card is open: the card is withdrawn and a
    // late Allow cannot close anything.
    const userTab = await openUserTab(fixture, page, "/left");
    void waiting(mcpCallInPane(fixture, codex, "codara_tab", { action: "close", link: `codara://tab/ws-a/${userTab}` }));
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).not.toHaveAttribute("data-expired", "true");
    await fixture.request("terminal.write", { paneId: codex, text: "\u0003", submit: false });
    await expect(card).toHaveAttribute("data-expired", "true", { timeout: 20_000 });
    await expect(card).toContainText("stopped waiting");
    await expect(page.locator(tab(userTab))).toHaveCount(1);

    // Claude closes its own terminal without a card.
    const closed = await claudeAgent.call("codara_tab", { action: "close", link: devLink });
    expect(closed).toMatchObject({ ok: true, closed: [dev.tabId] });
    expect(closed.approvedBy).toBeUndefined();
    await expect(page.locator(tab(dev.tabId))).toHaveCount(0);
  } finally {
    await teardown(fixture, app);
  }
});
