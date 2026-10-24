import { test, expect, type Locator, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Tab links. The user copies a tab's codara://tab link from its menu and
// clicks one in a terminal to bring the tab on screen; Split right docks a
// tab beside the one on screen. An agent closes its own tab at once, but a
// tab the user opened waits for the approval card: Deny keeps it, Allow once
// closes it, and "Always allow" stores a grant that skips the next card.
//
// TAB_LINKS_SHOTS=<dir> also saves screenshots of the menu and the card.

const ROOT = resolve(__dirname, "..", "..");
const SERVER = join(ROOT, "resources", "codara-studio-mcp", "server.js");

type Fixture = {
  root: string;
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
  return { root, home, cwd, origin, server, launch, request };
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
    const agent = await fixture.request("terminal.create", { cwd: fixture.cwd, title: "Agent", command: "sleep 600" });
    const listed = (await fixture.request("preview.list", { callerPaneId: agent.paneId })).tabs as Array<{ id: string; link?: string }>;
    expect(listed.find((item) => item.id === target)?.link).toBe(link);
    const panes = (await fixture.request("terminal.list", { callerPaneId: agent.paneId })).panes as Array<{ paneId: string; link?: string }>;
    expect(panes.find((item) => item.paneId === term.paneId)?.link).toBe(`codara://tab/ws-a/${term.tabId}`);

    // A tab the agent opened closes without asking.
    const own = await mcpCall(fixture.home, agent.paneId, "codara_preview_navigate", { url: `${fixture.origin}/own` });
    const closedOwn = await mcpCall(fixture.home, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${own.tabId}` });
    expect(closedOwn).toMatchObject({ ok: true, closed: [own.tabId] });
    expect(closedOwn.approvedBy).toBeUndefined();
    await expect(page.locator(tab(own.tabId))).toHaveCount(0);

    // A tab the user opened waits for the card. Deny keeps it.
    const userTab = await openUserTab(fixture, page, "/mine");
    const card = page.locator("[data-tab-action-approval]");
    let pending = waiting(mcpCall(fixture.home, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${userTab}` }));
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
    pending = waiting(mcpCall(fixture.home, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${userTab}` }));
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
    expect(await pending).toMatchObject({ ok: true, closed: [userTab], approvedBy: "card" });
    await expect(page.locator(tab(userTab))).toHaveCount(0);

    // Always allow closes this one, is listed for Settings, and the next tab
    // closes without a card.
    const second = await openUserTab(fixture, page, "/second");
    pending = waiting(mcpCall(fixture.home, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${second}` }));
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: /^Always allow/ }).click();
    expect(await pending).toMatchObject({ ok: true, closed: [second] });
    await expect
      .poll(() => page.evaluate(() => window.spark.tabActions.grants()))
      .toEqual([expect.objectContaining({ callerWorkspaceId: "ws-a", targetWorkspaceId: "ws-a" })]);
    const third = await openUserTab(fixture, page, "/third");
    const granted = await mcpCall(fixture.home, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${third}` });
    expect(granted).toMatchObject({ ok: true, closed: [third], approvedBy: "grant" });
    await expect(card).toHaveCount(0);

    // Revoked, the card comes back.
    await page.evaluate(() => window.spark.tabActions.revoke("ws-a", "ws-a"));
    const fourth = await openUserTab(fixture, page, "/fourth");
    pending = waiting(mcpCall(fixture.home, agent.paneId, "codara_tab", { action: "close", link: `codara://tab/ws-a/${fourth}` }));
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
