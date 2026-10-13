import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// The browser tools as any agent reaches them (feedback round 5, items 1, 4,
// 5, 11, 18, 19): the agent socket, the stdio MCP server and `cora tool`,
// against fixture pages on a local server, with Codara's window hidden. Also
// the user's own chords in a page, the in-pane dialog card, and the Content-
// Security-Policy of Codara's window in the built app.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const SERVER = resolve(__dirname, "../../resources/codara-studio-mcp/server.js");
const CORA = resolve(__dirname, "../../cli/cora.cjs");
const execFileAsync = promisify(execFile);
const MOD = process.platform === "darwin" ? "meta" : "control";

const PALETTE = `<!doctype html><title>Palette</title>
  <input id="field" placeholder="Type here">
  <div id="palette" hidden role="dialog" aria-label="Command palette">Palette</div>
  <script>
    window.chords = [];
    window.addEventListener("keydown", (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      window.chords.push((event.shiftKey ? "Shift+" : "") + event.key + ":" + event.isTrusted);
      const key = event.key.toLowerCase();
      if (key === "k" || key === "l" || key === "p") {
        event.preventDefault();
        if (key === "k") document.getElementById("palette").hidden = false;
      }
    });
  </script>`;

const DIALOGS = `<!doctype html><title>Dialogs</title>
  <button id="del" onclick="document.body.dataset.confirm = String(confirm('Delete project?'))">Delete</button>
  <button id="name" onclick="document.body.dataset.prompt = String(prompt('Your name?', 'anon'))">Name</button>
  <button id="saved" onclick="alert('Saved'); document.body.dataset.alert = 'done'">Save</button>`;

const LEAVE = `<!doctype html><title>Leave</title><h1>Unsaved work</h1>
  <script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; });</script>`;

const SHOP = `<!doctype html><title>Shop</title>
  <style>a, button { display: inline-block; min-width: 20px; min-height: 20px; }</style>
  <nav>
    <a href="/docs/getting-started">Docs</a>
    <a href="https://github.com/acme/shop"><svg width="16" height="16"><path d="M0 0h16v16z"/></svg></a>
    <a href="/help"><svg width="16" height="16"><title>Help center</title><path d="M0 0h16v16z"/></svg></a>
  </nav>
  <form onsubmit="event.preventDefault(); document.body.dataset.searched = this.q.value">
    <input name="q" type="search" placeholder="Search products">
    <button id="go"><i class="fa-solid fa-magnifying-glass"></i></button>
  </form>
  <h1>Products</h1>
  <button id="next" onclick="setTimeout(() => { history.pushState({}, '', '/shop/page-2'); document.querySelector('h1').remove(); document.body.insertAdjacentHTML('beforeend', '<h1>Page 2</h1>'); }, 300)">Next page</button>
  <button id="load" onclick="setTimeout(() => fetch('/delay?ms=800'), 50)">Load more</button>
  <script>console.log("shop ready");</script>`;

function startFixture(): Promise<{ server: Server; url: (path: string) => string }> {
  const pages: Record<string, string> = { "/palette": PALETTE, "/plain": "<!doctype html><title>Plain</title><h1>Plain</h1>", "/dialogs": DIALOGS, "/leave": LEAVE, "/shop": SHOP, "/docs/getting-started": "<!doctype html><title>Docs</title><h1>Docs</h1>" };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/delay") {
      setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("late"), Number(url.searchParams.get("ms") ?? 500));
      return;
    }
    const page = pages[url.pathname];
    if (page) res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    else res.writeHead(404).end();
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    done({ server, url: (path) => `http://127.0.0.1:${port}${path}` });
  }));
}

/** This machine's environment without the Codara pane that runs the suite. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(SPARK|CODARA)_/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home };
}

/** A stdio MCP client of the codara-studio server, as any MCP agent runs it. */
function startMcp(home: string) {
  const child = spawn(process.execPath, [SERVER], { env: cleanEnv(home), stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (message: { result?: any; error?: any }) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((done, fail) => {
      const id = nextId++;
      pending.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    request,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await request("tools/call", { name, arguments: args });
      const text = result.content.find((part: { type: string }) => part.type === "text")?.text ?? "null";
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: text, isError: result.isError === true };
      }
    },
    close: () => child.kill(),
  };
}

async function cora(home: string, ...args: string[]) {
  const { stdout } = await execFileAsync(process.execPath, [CORA, "tool", ...args, "--home", home, "--json"], { env: cleanEnv(home) });
  const result = JSON.parse(stdout);
  return JSON.parse(result.content.find((part: { type: string }) => part.type === "text").text);
}

async function guestKey(app: ElectronApplication, urlPrefix: string, keyCode: string, modifiers: string[]) {
  await app.evaluate(({ webContents }, input) => {
    const guests = webContents.getAllWebContents().filter((wc) => wc.getType() === "webview");
    const guest = guests.find((wc) => wc.getURL().startsWith(input.urlPrefix));
    if (!guest) throw new Error(`no guest at ${input.urlPrefix}: ${guests.map((wc) => wc.getURL()).join(", ")}`);
    guest.sendInputEvent({ type: "keyDown", keyCode: input.keyCode, modifiers: input.modifiers as Electron.InputEvent["modifiers"] });
    guest.sendInputEvent({ type: "keyUp", keyCode: input.keyCode, modifiers: input.modifiers as Electron.InputEvent["modifiers"] });
  }, { urlPrefix, keyCode, modifiers });
}

const runSwitcher = (page: Page) => page.getByRole("dialog", { name: "Switch Cora run" });

test("agents and users drive pages through keys, waits, dialogs, find and the outline, on any agent path", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-agent-input-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspaceDir);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-input",
    workspaces: [{ id: "ws-input", name: "Input test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startFixture();
  const app = await electron.launch({ args: ["."], env: {
    ...cleanEnv(home),
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
    ELECTRON_ENABLE_SECURITY_WARNINGS: "true",
  } });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const evaluate = async (code: string) => (await request("preview.evaluate", { code })).value;
  const hideWindows = () => app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
  const focused = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()));
  let mcp: ReturnType<typeof startMcp> | null = null;
  try {
    const page = await app.firstWindow();
    // Playwright answers the dialogs of every page it sees, the tab's guest
    // included; a listener stops it, so Codara alone decides as it would
    // outside a test.
    const leaveDialogsAlone = (seen: Page) => seen.on("dialog", () => {});
    app.context().pages().forEach(leaveDialogsAlone);
    app.context().on("page", leaveDialogsAlone);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Input test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    await app.evaluate(({ app: electronApp }) => {
      const log: string[] = [];
      (globalThis as { __guestConsole?: string[] }).__guestConsole = log;
      electronApp.on("web-contents-created", (_event, contents) => {
        if (contents.getType() !== "webview") return;
        contents.on("console-message", (event: { message?: string }, _level?: unknown, message?: unknown) => {
          log.push(typeof message === "string" ? message : event.message ?? "");
        });
      });
    });

    mcp = startMcp(home);
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } });
    const { tools } = await mcp.request("tools/list");
    const byName = new Map<string, { description: string; inputSchema: { properties: Record<string, unknown> } }>(tools.map((tool: { name: string }) => [tool.name, tool]));
    for (const name of ["codara_preview_find", "codara_preview_dialog", "codara_preview_wait_for", "codara_preview_key"]) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.description).not.toMatch(/claude/i);
    }
    expect(Object.keys(byName.get("codara_preview_wait_for")!.inputSchema.properties)).toEqual(
      expect.arrayContaining(["selector", "fresh", "url", "navigation", "load", "stableMs", "hmr", "timeoutMs"]),
    );
    expect(Object.keys(byName.get("codara_preview_dialog")!.inputSchema.properties)).toEqual(
      expect.arrayContaining(["accept", "promptText", "policy", "autoMs"]),
    );

    // Item 1: an agent's chords reach the page, never Codara, with the window hidden.
    await mcp.call("codara_preview_navigate", { url: fixture.url("/palette") });
    await hideWindows();
    expect(await focused()).toBe(false);
    expect(await mcp.call("codara_preview_key", { key: "Control+K" })).toMatchObject({ ok: true });
    await expect.poll(() => evaluate("document.getElementById('palette').hidden")).toBe(false);
    for (const key of ["Mod+K", "Control+L", "Control+P", "Control+Shift+P"]) await mcp.call("codara_preview_key", { key });
    await mcp.call("codara_preview_key", { key: "k", modifiers: ["Ctrl"] });
    await mcp.call("codara_preview_key", { key: "K", modifiers: ["meta"] });
    expect(await evaluate("window.chords")).toEqual(["k:true", "k:true", "l:true", "p:true", "Shift+P:true", "k:true", "k:true"]);
    await expect(runSwitcher(page)).toHaveCount(0);
    expect(await focused()).toBe(false);
    expect(await mcp.call("codara_preview_key", { key: "Hyper+K" })).toMatchObject({ ok: false, error: expect.stringMatching(/Unsupported key chord/) });

    // The user's own Ctrl+K in the page: the page handles it, so Codara does not.
    await evaluate("window.chords = []; document.getElementById('palette').hidden = true");
    await guestKey(app, fixture.url("/palette"), "K", [MOD]);
    await expect.poll(() => evaluate("window.chords")).toEqual(["k:true"]);
    expect(await evaluate("document.getElementById('palette').hidden")).toBe(false);
    await page.waitForTimeout(500);
    await expect(runSwitcher(page)).toHaveCount(0);
    // A page that does not handle it hands it to Codara.
    await request("preview.navigate", { url: fixture.url("/plain") });
    expect(await request("preview.wait_for", { url: "/plain", load: "load" })).toMatchObject({ ok: true });
    await guestKey(app, fixture.url("/plain"), "K", [MOD]);
    await expect(runSwitcher(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(runSwitcher(page)).toHaveCount(0);
    await hideWindows();

    // Item 18: the outline shows link targets and names icon-only links and buttons.
    await mcp.call("codara_preview_navigate", { url: fixture.url("/shop") });
    const outline = (await mcp.call("codara_preview_snapshot")).snapshot as string;
    expect(outline).toMatch(/link @\S+ "Docs" -> \/docs\/getting-started/);
    expect(outline).toMatch(/link @\S+ "github\.com" -> https:\/\/github\.com\/acme\/shop/);
    expect(outline).toMatch(/link @\S+ "Help center" -> \/help/);
    expect(outline).toMatch(/button @\S+ #go "magnifying glass"/);

    // Item 19: find by description through `cora tool`, then act on the reference.
    const found = await cora(home, "preview_find", JSON.stringify({ query: "the search button" }));
    expect(found.candidates[0]).toMatchObject({ role: "button", selector: "#go" });
    expect(outline).toContain(found.candidates[0].ref);
    const field = (await mcp.call("codara_preview_find", { query: "search field" })).candidates[0];
    expect(field.role).toBe("searchbox");
    await mcp.call("codara_preview_type", { selector: field.ref, text: "boots" });
    await mcp.call("codara_preview_click", { selector: found.candidates[0].ref });
    expect(await evaluate("document.body.dataset.searched")).toBe("boots");

    // Item 4: waits.
    const stale = await mcp.call("codara_preview_click", { selector: "#next" });
    expect(stale).toMatchObject({ ok: true });
    const fresh = await mcp.call("codara_preview_wait_for", { selector: "h1", fresh: true });
    expect(fresh).toMatchObject({ ok: true, element: { text: "Page 2" } });
    expect(await mcp.call("codara_preview_wait_for", { url: "/shop/page-2" })).toMatchObject({ ok: true, url: fixture.url("/shop/page-2") });
    await mcp.call("codara_preview_click", { selector: "#load" });
    const idle = await mcp.call("codara_preview_wait_for", { load: "networkidle" });
    expect(idle).toMatchObject({ ok: true });
    expect(idle.waitedMs).toBeGreaterThanOrEqual(500);
    await mcp.call("codara_preview_click", { selector: "a[href='/docs/getting-started']" });
    expect(await mcp.call("codara_preview_wait_for", { navigation: true, load: "load", selector: "h1" })).toMatchObject({
      ok: true, element: { text: "Docs" }, navigation: { url: fixture.url("/docs/getting-started") },
    });
    await mcp.call("codara_preview_evaluate", { code: "setTimeout(() => console.debug('[vite] hot updated: /src/App.tsx'), 200); true" });
    expect(await mcp.call("codara_preview_wait_for", { hmr: true })).toMatchObject({ ok: true, hmr: { kind: "update" } });
    const timedOut = await mcp.call("codara_preview_wait_for", { selector: "#nope", timeoutMs: 300 });
    expect(timedOut).toMatchObject({ ok: false, error: "Timed out after 300 ms waiting for #nope visible. Seen: #nope is not visible: no element matches." });
    expect(await focused()).toBe(false);

    // Item 5: Electron's own warnings never reach the agent's console.
    const consoleResult = await mcp.call("codara_preview_console", {});
    const messages = JSON.stringify(consoleResult);
    expect(messages).not.toMatch(/Electron Security Warning/);
    const raw = await app.evaluate(() => (globalThis as { __guestConsole?: string[] }).__guestConsole ?? []);
    expect(raw.some((message) => /Electron Security Warning/.test(message)), "Electron printed its warning into the page").toBe(true);

    // Item 11: dialogs never freeze the session.
    await mcp.call("codara_preview_navigate", { url: fixture.url("/dialogs") });
    const started = Date.now();
    const opened = await mcp.call("codara_preview_click", { selector: "#del" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(opened).toMatchObject({ ok: true, dialogs: [{ type: "confirm", message: "Delete project?" }] });
    expect(opened.note).toMatch(/codara_preview_dialog/);
    const blocked = await mcp.call("codara_preview_snapshot");
    expect(blocked).toMatchObject({ ok: false, dialogs: [{ type: "confirm" }] });
    expect(blocked.error).toMatch(/showing a confirm dialog "Delete project\?".*codara_preview_dialog/);
    expect(await mcp.call("codara_preview_dialog", {})).toMatchObject({ ok: true, dialogs: [{ type: "confirm" }], policy: { action: "ask", autoMs: 30000 } });
    expect(await mcp.call("codara_preview_dialog", { accept: true })).toMatchObject({ ok: true, answered: { type: "confirm", accepted: true }, dialogs: [] });
    expect(await evaluate("document.body.dataset.confirm")).toBe("true");

    await mcp.call("codara_preview_click", { selector: "#name" });
    expect(await cora(home, "preview_dialog", "--accept", "true", "--promptText", "Ada")).toMatchObject({ ok: true, answered: { type: "prompt", promptText: "Ada" } });
    expect(await evaluate("document.body.dataset.prompt")).toBe("Ada");

    // The user answers in the pane's card; the agent hears about it next time.
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.showInactive(); });
    await page.getByText(/^127\.0\.0\.1:\d+$/).first().click();
    await mcp.call("codara_preview_click", { selector: "#del" });
    const card = page.getByRole("alertdialog");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Delete project?");
    await expect(card).toContainText(/Cancelled automatically in \d+ s/);
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toHaveCount(0);
    const afterUser = await mcp.call("codara_preview_evaluate", { code: "document.body.dataset.confirm" });
    expect(afterUser.value).toBe("false");
    expect(afterUser.dialogsAnswered).toEqual([expect.objectContaining({ type: "confirm", accepted: false, by: "user" })]);

    // A page that keeps opening dialogs leaves no listeners behind on its guest.
    const guestListeners = () => app.evaluate(({ webContents }, prefix) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getURL().startsWith(prefix));
      return guest ? ["did-start-navigation", "render-process-gone", "destroyed"].map((name) => guest.listenerCount(name)) : null;
    }, fixture.url("/dialogs"));
    const listenersBefore = await guestListeners();
    for (let i = 0; i < 3; i++) {
      await mcp.call("codara_preview_click", { selector: "#del" });
      expect(await mcp.call("codara_preview_dialog", { accept: false })).toMatchObject({ ok: true, answered: { type: "confirm" } });
    }
    expect(await guestListeners()).toEqual(listenersBefore);

    // Policies: dismiss at once, then ask with a short wait.
    expect(await mcp.call("codara_preview_dialog", { policy: "dismiss" })).toMatchObject({ policy: { action: "dismiss" } });
    const dismissed = await mcp.call("codara_preview_click", { selector: "#del" });
    expect(dismissed.dialogsAnswered).toEqual([expect.objectContaining({ type: "confirm", accepted: false, by: "policy" })]);
    await mcp.call("codara_preview_dialog", { policy: "ask", autoMs: 1000 });
    await mcp.call("codara_preview_click", { selector: "#saved" });
    await expect(card).toBeVisible();
    await expect.poll(() => evaluate("document.body.dataset.alert ?? null"), { timeout: 5000 }).toBe("done");
    await expect(card).toHaveCount(0);
    await mcp.call("codara_preview_dialog", { policy: "ask", autoMs: 30000 });

    // beforeunload: an agent's navigation leaves the page under the ask policy.
    await mcp.call("codara_preview_navigate", { url: fixture.url("/leave") });
    await mcp.call("codara_preview_mouse", { selector: "h1" });
    const left = await mcp.call("codara_preview_navigate", { url: fixture.url("/plain") });
    expect(left.ok, JSON.stringify(left)).not.toBe(false);
    // The outcome is told once, to whichever call comes next.
    const leaveNews: unknown[] = [...(left.dialogsAnswered ?? [])];
    const agent = mcp;
    await expect.poll(async () => {
      const result = await agent.call("codara_preview_evaluate", { code: "location.pathname" });
      leaveNews.push(...(result.dialogsAnswered ?? []));
      return result.value;
    }).toBe("/plain");
    leaveNews.push(...((await mcp.call("codara_preview_dialog", {})).dialogsAnswered ?? []));
    expect(leaveNews).toEqual([expect.objectContaining({ type: "beforeunload", accepted: true, by: "policy" })]);

    // Item 5: Codara's own window runs under its Content-Security-Policy.
    expect(await page.evaluate(() => document.head.firstElementChild?.getAttribute("http-equiv"))).toBe("Content-Security-Policy");
    const policy = await page.evaluate(() => document.head.firstElementChild?.getAttribute("content") ?? "");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("unsafe-eval");
    // DevTools lets code it evaluates use eval; a timer runs outside that.
    expect(await page.evaluate(() => new Promise((done) => setTimeout(() => {
      try {
        done(String((0, eval)("1 + 1")));
      } catch (error) {
        done((error as Error).name);
      }
    }, 0)))).toBe("EvalError");
    expect(await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__injected = true";
      document.head.append(script);
      return (window as { __injected?: boolean }).__injected ?? false;
    })).toBe(false);
    const violations: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text()); });
    await page.reload();
    await expect(page.getByText("Input test", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(1500);
    expect(violations).toEqual([]);
  } finally {
    mcp?.close();
    await app.close();
    fixture.server.closeAllConnections();
    fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
