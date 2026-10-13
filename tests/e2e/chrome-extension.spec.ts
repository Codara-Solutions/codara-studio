import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, chromium, type BrowserContext, type Worker } from "playwright";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const EXTENSION = resolve(__dirname, "../../extensions/chrome");
const CORA = resolve(__dirname, "../../cli/cora.cjs");
const MCP_SERVER = resolve(__dirname, "../../resources/codara-studio-mcp/server.js");
const SESSION = "ada-session-7f3c";

// The extension API inside the service worker and its pages.
declare const chrome: any;

// A site the user is signed in to: the session lives in an HttpOnly cookie,
// and /account only shows who is signed in when the browser sends it.
function accountSite(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://fixture");
  const signedIn = (request.headers.cookie ?? "").split(/;\s*/).includes(`session=${SESSION}`);
  if (url.pathname === "/login") {
    response.writeHead(302, { "Set-Cookie": `session=${SESSION}; HttpOnly; Path=/; SameSite=Lax`, Location: "/account" });
    response.end();
    return;
  }
  if (url.pathname === "/api/save") {
    response.writeHead(signedIn ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ saved: url.searchParams.get("note") }));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (url.pathname === "/account") {
    response.end(signedIn
      ? `<!doctype html><title>Account</title><h1>Signed in as Ada</h1>
        <label>Note <input id="note"></label>
        <button id="save" onclick="fetch('/api/save?note='+encodeURIComponent(note.value)).then(r=>r.json()).then(j=>{out.innerHTML='<b id=done></b>';done.textContent='saved '+j.saved;console.warn('saved',j.saved)})">Save</button>
        <p id="out"></p><p id="keys"></p>
        <script>note.addEventListener('keydown',e=>{if(e.key==='Enter')keys.textContent='enter pressed'})</script>`
      : `<!doctype html><title>Sign in</title><h1>Please sign in</h1>`);
    return;
  }
  response.end(`<!doctype html><title>Public ${url.pathname}</title><h1>Public page</h1>`);
}

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

// The codara-studio MCP server over stdio, as Claude Code, Codex, Grok and
// Cora launch it: one JSON-RPC object per line each way.
function mcpClient(home: string): { call(method: string, params?: Record<string, unknown>): Promise<any>; tool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: McpContent[] }>; close(): void } {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home, SPARK_MCP_MODE: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let buffered = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = typeof message.id === "number" ? waiting.get(message.id) : undefined;
      if (!waiter) continue;
      waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((done, fail) => {
      const id = nextId++;
      waiting.set(id, { resolve: done, reject: fail });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    call,
    tool: (name, args) => call("tools/call", { name, arguments: args }),
    close: () => child.kill(),
  };
}

const textOf = (result: { content: McpContent[] }): string => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

// Extensions load only in a full Chromium: the headless shell Playwright also
// installs ignores --load-extension.
function fullChromium(): string | null {
  const expected = chromium.executablePath();
  if (existsSync(expected) && !expected.includes("headless_shell")) return expected;
  const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .filter((name) => /^chromium-\d+$/.test(name))
    .flatMap((name) => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"].map((binary) => join(cache, name, binary)))
    .filter((candidate) => existsSync(candidate))
    .sort();
  return found.pop() ?? null;
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

async function tabIdOf(worker: Worker, urlPart: string): Promise<number> {
  return worker.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate: { id?: number; url?: string }) => (candidate.url ?? "").includes(part));
    if (!tab?.id) throw new Error(`no tab on ${part}`);
    return tab.id;
  }, urlPart);
}

test("the Chrome extension pairs, shares one tab with agents, refuses the rest and unpairs", async () => {
  test.setTimeout(180_000);
  const executablePath = fullChromium();
  test.skip(!executablePath, "no Playwright Chromium installed");

  const root = await mkdtemp(join(tmpdir(), "codara-chrome-ext-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  const profile = join(root, "chromium");
  await mkdir(userDataDir);
  await mkdir(workspaceDir);
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-chrome",
    workspaces: [{ id: "ws-chrome", name: "Chrome link", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const site = createServer(accountSite);
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const sitePort = (site.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${sitePort}`;
  const linkPort = await freePort();

  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_USER_DATA_DIR: userDataDir,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
    CODARA_CHROME_LINK: "1", CODARA_CHROME_LINK_PORTS: String(linkPort),
  } });
  let browser: BrowserContext | null = null;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home: userDataDir }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const codara: Page = await app.firstWindow();
    await codara.waitForLoadState("domcontentloaded");
    await expect(codara.getByText("Chrome link", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);

    browser = await chromium.launchPersistentContext(profile, {
      executablePath: executablePath ?? undefined,
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent("serviceworker", { timeout: 15_000 }));
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async (port) => {
      const { blockedSites } = await chrome.storage.local.get({ blockedSites: "" });
      await chrome.storage.local.set({ ports: [port], blockedSites: `${blockedSites}\nlocalhost` });
    }, linkPort);

    // The user signs in, and has two other tabs open.
    const account = await browser.newPage();
    await account.goto(`${origin}/login`);
    await expect(account.getByText("Signed in as Ada")).toBeVisible();
    const other = await browser.newPage();
    await other.goto(`${origin}/elsewhere`);
    const blocked = await browser.newPage();
    await blocked.goto(`http://localhost:${sitePort}/bank`);
    const accountTab = await tabIdOf(worker, "/account");
    const otherTab = await tabIdOf(worker, "/elsewhere");
    const blockedTab = await tabIdOf(worker, "localhost");

    // Pairing: Connect in the popup, the same code in Codara, Allow.
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${accountTab}`);
    await popup.locator("#connect-button").click();
    await expect(popup.locator("#pairing-code")).toHaveText(/^\d{3} \d{3}$/, { timeout: 10_000 });
    const code = (await popup.locator("#pairing-code").textContent()) ?? "";
    const prompt = codara.locator("[data-chrome-pairing]");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByLabel("Pairing code")).toHaveText(code);
    await prompt.getByRole("button", { name: "Allow" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(popup.locator("#status")).toHaveText(/Connected to Codara/);

    // The service worker loses its socket (suspended, or Codara restarted):
    // it reconnects on its own, both sides proving the pairing.
    expect(await worker.evaluate(() => {
      const { link } = (self as unknown as { codara: any }).codara;
      link.lost();
      return link.status.state;
    })).toBe("offline");
    await expect.poll(() => worker.evaluate(() => (self as unknown as { codara: any }).codara.link.status.state), { timeout: 15_000 }).toBe("connected");

    // Nothing is shared yet.
    await expect(request("preview.snapshot", { tabId: `chrome:${accountTab}` })).rejects.toThrow(/is not shared with agents/);

    // The user shares the signed-in tab from the popup.
    await popup.locator("#share-tab").check();
    await expect(popup.locator("#tab-id")).toHaveText(`chrome:${accountTab}`);
    await expect.poll(async () => {
      const { tabs } = await request("preview.list");
      return tabs.filter((tab: { kind?: string }) => tab.kind === "chrome").map((tab: { id: string }) => tab.id);
    }).toEqual([`chrome:${accountTab}`]);

    // The agent drives it with the browser tools, signed in as the user.
    const tabId = `chrome:${accountTab}`;
    const snapshot = await request("preview.snapshot", { tabId });
    expect(JSON.stringify(snapshot)).toContain("Signed in as Ada");
    await request("preview.type", { tabId, selector: "#note", text: "from the agent" });
    await request("preview.click", { tabId, selector: "#save" });
    await request("preview.wait_for", { tabId, selector: "#done" });
    await expect(account.locator("#out")).toHaveText("saved from the agent");
    await request("preview.press_key", { tabId, selector: "#note", key: "Enter" });
    expect(await request("preview.evaluate", { tabId, code: "document.querySelector('#keys').textContent" })).toMatchObject({ value: "enter pressed" });
    // Signed in, yet the session cookie itself stays out of reach.
    expect(await request("preview.evaluate", { tabId, code: "document.cookie" })).toMatchObject({ value: "" });
    const consoleResult = await request("preview.console", { tabId });
    expect(JSON.stringify(consoleResult)).toContain("saved");
    const network = await request("preview.network", { tabId });
    expect(JSON.stringify(network)).toContain("/api/save");
    expect(JSON.stringify(network)).not.toContain(SESSION);
    const shot = await request("preview.screenshot", { tabId });
    expect(shot.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), accountTab)).toBe("AI");

    // The same tools from a shell agent, through cora tool.
    const { stdout } = await promisify(execFile)(process.execPath, [CORA, "tool", "preview_screenshot", "--tabId", tabId, "--home", userDataDir], {
      env: { ...process.env, CODARA_HOME_DIR: userDataDir },
      timeout: 30_000,
    });
    const saved = JSON.parse(stdout.trim().split("\n")[0]);
    expect(saved).toMatchObject({ tabId, url: `${origin}/account`, mimeType: "image/png" });
    expect(existsSync(saved.path), stdout).toBe(true);

    // The same tools through the MCP server over stdio, on the tab while it
    // sits in the background of its window: another tab is in front.
    const mcp = mcpClient(userDataDir);
    try {
      await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
      const roster = await mcp.call("tools/list");
      const names = roster.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["codara_preview_chrome", "codara_preview_list", "codara_preview_snapshot", "codara_preview_screenshot", "codara_preview_run"]));
      expect(JSON.stringify(roster.tools.filter((tool: { name: string }) => tool.name.startsWith("codara_preview_")))).not.toMatch(/claude/i);

      const windowId = await worker.evaluate((id) => chrome.tabs.get(id).then((tab: { windowId: number }) => tab.windowId), accountTab);
      await worker.evaluate((id) => chrome.tabs.create({ windowId: id, url: "about:blank", active: true }), windowId);
      const isActive = () => worker.evaluate((id) => chrome.tabs.get(id).then((tab: { active: boolean }) => tab.active), accountTab);
      await expect.poll(isActive).toBe(false);

      const status = await mcp.tool("codara_preview_chrome", { action: "status" });
      expect(status.isError).toBeFalsy();
      expect(JSON.parse(textOf(status))).toMatchObject({ connected: true, tabs: [{ id: tabId, kind: "chrome", url: `${origin}/account` }] });
      const listedTabs = JSON.parse(textOf(await mcp.tool("codara_preview_list", {}))).tabs;
      expect(listedTabs).toEqual(expect.arrayContaining([expect.objectContaining({ id: tabId, kind: "chrome", title: "Account", url: `${origin}/account` })]));

      const typed = await mcp.tool("codara_preview_type", { tabId, selector: "#note", text: "in the background", clearFirst: true });
      expect(typed.isError, textOf(typed)).toBeFalsy();
      const batch = await mcp.tool("codara_preview_run", {
        tabId,
        steps: [
          { action: "click", selector: "#save" },
          { action: "wait_for", selector: "#done" },
          { action: "evaluate", code: "document.querySelector('#out').textContent" },
        ],
      });
      expect(batch.isError, textOf(batch)).toBeFalsy();
      expect(textOf(batch)).toContain("saved in the background");
      expect(await isActive()).toBe(false);

      const picture = await mcp.tool("codara_preview_screenshot", { tabId });
      expect(picture.isError, textOf(picture)).toBeFalsy();
      const image = picture.content.find((part) => part.type === "image");
      expect(image?.data?.length ?? 0).toBeGreaterThan(100);
      const pictureMeta = JSON.parse(textOf(picture));
      expect(pictureMeta).toMatchObject({ tabId, url: `${origin}/account` });
      expect(pictureMeta.path.startsWith(join(userDataDir, "workspace-data"))).toBe(true);
      expect(existsSync(pictureMeta.path)).toBe(true);
      expect(JSON.stringify(picture)).not.toContain(SESSION);
    } finally {
      mcp.close();
    }

    // Codara logs who did what, and the popup names the agent.
    const state = await codara.evaluate(() => (window as unknown as { spark: any }).spark.chromeLink.state());
    const tools = state.activity.filter((entry: { tab: string }) => entry.tab === tabId).map((entry: { tool: string }) => entry.tool);
    expect(tools).toEqual(expect.arrayContaining(["codara_preview_snapshot", "codara_preview_type", "codara_preview_click", "codara_preview_screenshot"]));
    await expect(popup.locator("#tab-usage")).toContainText("codara_preview_screenshot");

    // Tabs in the user's browser: opening needs the popup's switch, and an
    // agent closes only the tabs it opened.
    expect(await request("preview.chrome", { action: "status" })).toMatchObject({ connected: true, browsers: [{ sharedTabs: 1, mayOpenTabs: false }] });
    await expect(request("preview.chrome", { action: "open", url: `${origin}/opened` })).rejects.toThrow(/open new tabs/);
    await popup.locator("#allow-open").check();
    await expect.poll(async () => (await request("preview.chrome", { action: "status" })).browsers[0].mayOpenTabs).toBe(true);
    const opened = await request("preview.chrome", { action: "open", url: `${origin}/opened` });
    expect(opened).toMatchObject({ ok: true, url: `${origin}/opened`, title: "Public /opened" });
    expect(JSON.stringify(await request("preview.snapshot", { tabId: opened.tabId }))).toContain("Public page");
    await request("preview.chrome", { action: "activate", tabId });
    expect(await worker.evaluate((id) => chrome.tabs.get(id).then((tab: { active: boolean }) => tab.active), accountTab)).toBe(true);
    await expect(request("preview.chrome", { action: "close", tabId })).rejects.toThrow(/not opened by an agent/);
    await request("preview.chrome", { action: "close", tabId: opened.tabId });
    await expect.poll(() => browser?.pages().some((page) => page.url().endsWith("/opened"))).toBe(false);
    await expect(account.getByText("Signed in as Ada")).toBeVisible();

    // An unshared tab, and a shared tab on a blocked site, are refused.
    await expect(request("preview.snapshot", { tabId: `chrome:${otherTab}` })).rejects.toThrow(/is not shared with agents/);
    await worker.evaluate((id) => (self as unknown as { codara: any }).codara.handlePopup({ type: "shareTab", tabId: id, on: true }), blockedTab);
    await expect(request("preview.snapshot", { tabId: `chrome:${blockedTab}` })).rejects.toThrow(/blocked/);
    await expect(request("preview.navigate", { tabId, url: `http://localhost:${sitePort}/bank` })).rejects.toThrow(/blocked/);
    await expect(account.getByText("Signed in as Ada")).toBeVisible();

    // Chrome stops an idle MV3 service worker. The extension comes back on
    // its own (the alarm or the next event), pairs again with its stored
    // token and the shared tab works without the user doing anything.
    const browserCdp = await browser.newCDPSession(other);
    const { targetInfos } = await browserCdp.send("Target.getTargets");
    const serviceWorker = targetInfos.find((info: { type: string; url: string }) => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
    expect(serviceWorker).toBeTruthy();
    await browserCdp.send("Target.closeTarget", { targetId: (serviceWorker as { targetId: string }).targetId });
    await expect.poll(async () => (await codara.evaluate(() => (window as unknown as { spark: any }).spark.chromeLink.state())).browsers[0].connected, { timeout: 15_000 }).toBe(false);
    await popup.reload();
    await expect.poll(async () => (await codara.evaluate(() => (window as unknown as { spark: any }).spark.chromeLink.state())).browsers[0].connected, { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => JSON.stringify(await request("preview.snapshot", { tabId }).catch((error) => String(error))), { timeout: 15_000 }).toContain("Signed in as Ada");

    // Disconnect in Codara: the extension forgets its token and every tab is out of reach.
    const linkId = state.browsers[0].linkId;
    await codara.evaluate((id) => (window as unknown as { spark: any }).spark.chromeLink.disconnect(id), linkId);
    await expect(popup.locator("#status")).toHaveText("Not connected");
    // Playwright does not hand over a restarted worker; the popup reaches the same extension APIs.
    expect(await popup.evaluate(() => chrome.storage.local.get({ token: null }).then((stored: { token: string | null }) => stored.token))).toBeNull();
    await expect(request("preview.snapshot", { tabId })).rejects.toThrow(/No Chrome browser is connected/);
    const { tabs } = await request("preview.list");
    expect(tabs.some((tab: { kind?: string }) => tab.kind === "chrome")).toBe(false);
    await expect.poll(() => popup.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), accountTab)).not.toBe("AI");
  } finally {
    await browser?.close().catch(() => undefined);
    await app.close();
    await new Promise((done) => site.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
