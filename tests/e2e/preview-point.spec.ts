import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Pointing at the page, end to end: the inspect tool through the agent
// socket, the stdio MCP server and `cora inspect`; a pick from the UI queued
// in the inbox and pasted into a terminal pane; a comment drawn on a frozen
// page; copying a tab's id. The page comes from a local server this file
// starts and stops.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const ROOT = resolve(__dirname, "../..");
const MCP_SERVER = join(ROOT, "resources/codara-studio-mcp/server.js");
const CORA = join(ROOT, "cli/cora.cjs");

const PAGE = `<!doctype html><html><head><title>Point fixture</title><link rel="stylesheet" href="/app.css"></head>
<body><main id="hero" class="wrap"><h1 id="title">Point fixture</h1>
<button id="cta" class="cta" data-source="src/Hero.tsx:3:5">Get started</button>
<div style="height: 1600px"></div></main></body></html>`;
const CSS = `body { margin: 0; font-family: sans-serif; } main { padding: 160px 40px 40px; }
.cta { color: rgb(255, 0, 0); padding: 8px 16px; border-radius: 6px; font-size: 16px; }`;

interface Fixture {
  app: ElectronApplication;
  page: Page;
  home: string;
  workspaceDir: string;
  url: string;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
}

// Child processes must not inherit a Codara pane identity from the terminal
// the tests run in, or the tools would scope to a pane this app never had.
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(SPARK_|CODARA_)/.test(key)) env[key] = value;
  }
  return { ...env, CODARA_HOME_DIR: home };
}

async function launch(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-point-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(join(workspaceDir, "src"), { recursive: true });
  await writeFile(join(workspaceDir, "src/Hero.tsx"), "export function Hero() {\n  return (\n    <button className=\"cta\">Get started</button>\n  );\n}\n");
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-point",
    workspaces: [{ id: "ws-point", name: "Point test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const server: Server = createServer((req, res) => {
    if (req.url === "/app.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(CSS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Point test", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  await expect.poll(async () => request("app.info").then(() => true).catch(() => false), { timeout: 30_000 }).toBe(true);
  return {
    app, page, home, workspaceDir, url, request,
    close: async () => {
      await app.close();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Opens a browser tab on the fixture the way the user does, and returns its id. */
async function openBrowserTab(fixture: Fixture): Promise<string> {
  const { page, url, request } = fixture;
  await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
  await page.getByText("Browser", { exact: true }).dispatchEvent("click");
  const tabId = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-id");
  const address = page.getByPlaceholder("http://localhost:3000").first();
  await expect(address).toBeVisible({ timeout: 10_000 });
  await address.fill(url);
  await address.press("Enter");
  await expect.poll(async () => request("preview.evaluate", { tabId, code: "!!document.getElementById('cta') && getComputedStyle(document.getElementById('cta')).color" })
    .then((r) => r.value).catch(() => null), { timeout: 20_000 }).toBe("rgb(255, 0, 0)");
  return tabId!;
}

/** Where an element is on the window, through the layer that covers the page. */
async function pointOnPage(fixture: Fixture, tabId: string, selector: string, layer: string) {
  const { element } = await fixture.request("preview.inspect", { tabId, ref: selector });
  const host = (await fixture.page.locator(layer).boundingBox())!;
  return { x: host.x + element.box.x + element.box.width / 2, y: host.y + element.box.y + element.box.height / 2, box: element.box, host };
}

async function chooseDestination(page: Page, name: RegExp) {
  await page.locator(".cp-dest").click();
  await page.getByRole("option", { name }).click();
}

function jpegSize(data: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < data.length) {
    const marker = data.readUInt16BE(offset);
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xffc0 && marker <= 0xffc2) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  throw new Error("not a JPEG");
}

test("codara_preview_inspect describes an element through the socket, MCP and cora, on a hidden tab", async () => {
  test.setTimeout(120_000);
  const fixture = await launch();
  const { request, home } = fixture;
  try {
    const tabId = await openBrowserTab(fixture);

    const snapshot = await request("preview.snapshot", {});
    expect(snapshot.tabId, "a result names the tab it acted on, even when the call named none").toBe(tabId);

    const inspected = await request("preview.inspect", { tabId, ref: "#cta" });
    expect(inspected.tabId).toBe(tabId);
    expect(inspected.url).toBe(fixture.url);
    expect(inspected.element.selector).toBe("#cta");
    expect(inspected.element.role).toBe("button");
    expect(inspected.element.name).toBe("Get started");
    expect(inspected.element.source).toEqual({ file: "src/Hero.tsx", line: 3, column: 5, via: "data-attribute", exists: true });
    expect(inspected.element.styles.color).toBe("rgb(255, 0, 0)");
    expect(inspected.element.boxModel.padding).toEqual([8, 16, 8, 16]);
    expect(inspected.element.rules.some((rule: { selector: string; source: string }) => rule.selector === ".cta" && rule.source.endsWith("/app.css"))).toBe(true);
    expect(inspected.element.path).toMatch(/main#hero\.wrap > button#cta\.cta$/);
    expect(inspected.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(inspected.path.startsWith(join(home, "workspace-data"))).toBe(true);
    expect((await readFile(inspected.path)).subarray(0, 2).toString("hex")).toBe("ffd8");

    const atPoint = await request("preview.inspect", { tabId, x: inspected.element.box.x + 4, y: inspected.element.box.y + 4 });
    expect(atPoint.element.selector).toBe("#cta");

    // The stdio MCP server an agent CLI runs: image content plus the text,
    // which names the tab and the file.
    const mcp = spawn(process.execPath, [MCP_SERVER], { env: childEnv(home), stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, any>();
    let buffer = "";
    mcp.stdout.setEncoding("utf8");
    mcp.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.set(message.id, message);
      }
    });
    const call = async (id: number, method: string, params: Record<string, unknown>) => {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await expect.poll(() => replies.has(id), { timeout: 20_000 }).toBe(true);
      return replies.get(id);
    };
    try {
      await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "point-e2e", version: "1" } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await call(2, "tools/list", {});
      const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "codara_preview_inspect");
      expect(tool.inputSchema.properties).toHaveProperty("tabId");
      expect(JSON.stringify(tool)).not.toMatch(/claude/i);
      const viaMcp = await call(3, "tools/call", { name: "codara_preview_inspect", arguments: { tabId, ref: "#cta" } });
      expect(viaMcp.result.isError).toBeFalsy();
      const image = viaMcp.result.content.find((block: { type: string }) => block.type === "image");
      expect(image.mimeType).toBe("image/jpeg");
      const text = viaMcp.result.content.find((block: { type: string }) => block.type === "text").text;
      expect(text).toContain(`"tabId":"${tabId}"`);
      expect(text).toContain("src/Hero.tsx");
      expect(text).toContain(".jpg");
    } finally {
      mcp.kill();
    }

    const cli = await promisify(execFile)(process.execPath, [CORA, "inspect", "#cta", "--tabId", tabId, "--json", "--home", home], { env: childEnv(home) });
    const cliResult = JSON.parse(cli.stdout);
    expect(cliResult.content.some((block: { type: string; text?: string }) => block.type === "text" && block.text!.includes("src/Hero.tsx"))).toBe(true);

    // Background and hidden: another tab on screen, then the window hidden.
    await fixture.page.getByRole("tab", { name: /terminals/i }).first().dispatchEvent("click");
    await fixture.app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    const hidden = await request("preview.inspect", { tabId, ref: "#title" });
    expect(hidden.tabId).toBe(tabId);
    expect(hidden.element.tag).toBe("h1");
    expect(hidden.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(await fixture.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("a pick from the browser tab is queued in the inbox and pasted into a terminal", async () => {
  test.setTimeout(150_000);
  const fixture = await launch();
  const { page, request } = fixture;
  try {
    const tabId = await openBrowserTab(fixture);
    await page.keyboard.press("Control+Shift+E");
    const picker = page.getByTestId("point-picker");
    await expect(picker).toBeVisible();
    const cta = await pointOnPage(fixture, tabId, "#cta", '[data-testid="point-picker"]');
    await page.mouse.move(cta.x, cta.y, { steps: 4 });
    await expect(page.locator(".cp-tag")).toContainText("button#cta.cta");
    await page.keyboard.down("Shift");
    await page.mouse.click(cta.x, cta.y);
    await page.keyboard.up("Shift");
    await expect(page.locator(".cp-hint__count")).toContainText("1 picked");
    const title = await pointOnPage(fixture, tabId, "#title", '[data-testid="point-picker"]');
    await page.mouse.move(title.x, title.y, { steps: 4 });
    await expect(page.locator(".cp-tag")).toContainText("h1#title");
    await page.mouse.click(title.x, title.y);

    const composer = page.getByTestId("point-composer");
    await expect(composer.getByTestId("point-element")).toHaveCount(2, { timeout: 20_000 });
    await expect(composer.getByTestId("point-element").first()).toContainText("src/Hero.tsx:3:5");
    await composer.getByLabel("Note for the agent").fill("Make the button blue");
    await chooseDestination(page, /Agent inbox/);
    await composer.getByRole("button", { name: "Queue", exact: true }).click();
    await expect(page.getByTestId("point-notice")).toContainText("Queued in Agent inbox");
    await expect(composer).toHaveCount(0);

    const { items } = await request("preview.inbox", { workspaceId: "ws-point" });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.tabId).toBe(tabId);
    expect(item.source).toBe("picker");
    expect(item.text).toMatch(new RegExp(`^\\[Codara\\] Picked 2 elements on ${fixture.url.replace(/[.]/g, "\\.")} \\(tab ${tabId}\\)`));
    expect(item.text).toContain("Note: Make the button blue");
    expect(item.text).toContain("selector: #cta");
    expect(item.text).toContain("source: src/Hero.tsx:3:5");
    expect(item.text).toContain("rules: .cta");
    expect(item.text).not.toMatch(/claude/i);
    expect(item.paths).toHaveLength(2);
    for (const path of item.paths) {
      expect(path).toMatch(/element-\d\.jpg$/);
      expect((await readFile(path)).subarray(0, 2).toString("hex")).toBe("ffd8");
    }

    // The same pick pasted into a terminal pane, not submitted.
    await page.getByRole("button", { name: /Point at an element/ }).click();
    await expect(picker).toBeVisible();
    await page.mouse.move(cta.x, cta.y, { steps: 3 });
    await expect(page.locator(".cp-tag")).toContainText("button#cta.cta");
    await page.mouse.click(cta.x, cta.y);
    await expect(composer.getByTestId("point-element")).toHaveCount(1, { timeout: 20_000 });
    await chooseDestination(page, /Terminal · terminals/);
    await composer.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(page.getByTestId("point-notice")).toContainText("Pasted into Terminal · terminals");
    const { panes } = await request("terminal.list", {});
    const pane = panes.find((entry: { title?: string }) => /terminals/i.test(entry.title ?? "")) ?? panes[0];
    // The line editor redraws a multi-line paste, so read the rendered screen.
    const screen = async () => {
      const read = await request("terminal.read", { paneId: pane.paneId, mode: "screen" });
      return String(read.text ?? "");
    };
    await expect.poll(screen, { timeout: 20_000 }).toContain("[Codara] Picked element on");
    const read = await screen();
    expect(read).toContain("Attached: ");
    expect(read).not.toContain("command not found");
  } finally {
    await fixture.close();
  }
});

test("a comment drawn on a frozen page reaches the inbox with page coordinates, notes and an annotated image", async () => {
  test.setTimeout(150_000);
  const fixture = await launch();
  const { page, request } = fixture;
  try {
    const tabId = await openBrowserTab(fixture);
    await request("preview.evaluate", { tabId, code: "scrollTo(0, 60); scrollY" });
    await page.getByRole("button", { name: /Comment on the page/ }).click();
    const overlay = page.getByTestId("comment-overlay");
    await expect(overlay).toBeVisible();
    await overlay.getByRole("button", { name: "Freeze", exact: true }).click();
    await expect(overlay.getByRole("button", { name: "Frozen", exact: true })).toBeVisible({ timeout: 10_000 });
    const cta = await pointOnPage(fixture, tabId, "#cta", '[data-testid="comment-overlay"]');
    const left = cta.host.x + cta.box.x - 12;
    const top = cta.host.y + cta.box.y - 12;
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(left + cta.box.width + 24, top + cta.box.height + 24, { steps: 8 });
    await page.mouse.up();
    const markNote = page.getByLabel("Note for mark 1");
    await expect(markNote).toBeFocused();
    await markNote.fill("make it blue");
    await markNote.press("Enter");
    await overlay.getByRole("button", { name: "Arrow", exact: true }).click();
    const title = await pointOnPage(fixture, tabId, "#title", '[data-testid="comment-overlay"]');
    await page.mouse.move(title.x + 260, title.y + 80);
    await page.mouse.down();
    await page.mouse.move(title.x, title.y, { steps: 8 });
    await page.mouse.up();
    await page.getByLabel("Note for mark 2").press("Enter");
    await overlay.getByLabel("Overall note").fill("two things");
    await chooseDestination(page, /Agent inbox/);
    await overlay.getByRole("button", { name: "Queue", exact: true }).click();
    await expect(page.getByTestId("point-notice")).toContainText("Queued in Agent inbox", { timeout: 20_000 });

    const { items: [item] } = await request("preview.inbox", { workspaceId: "ws-point" });
    expect(item.source).toBe("comment");
    expect(item.tabId).toBe(tabId);
    expect(item.text).toMatch(/^\[Codara\] 2 comments on .* \(tab [^)]+\); the annotated screenshot is attached \(numbers match the list, drawn on a frozen screenshot\)/);
    expect(item.text).toContain("Note: two things");
    const box = /1\. "make it blue"; box at page (\d+),(\d+) size (\d+)x(\d+) \(viewport (\d+),(\d+)\)/.exec(item.text);
    expect(box).toBeTruthy();
    expect(Number(box![2]) - Number(box![6]), "page coordinates add the scroll").toBe(60);
    expect(Math.abs(Number(box![5]) - (cta.box.x - 12))).toBeLessThanOrEqual(2);
    expect(item.text).toMatch(/has <button> "Get started" @\S+ #cta, src\/Hero\.tsx:3/);
    expect(item.text).toMatch(/2\. \(no note\); arrow from page \d+,\d+ to \d+,\d+/);
    expect(item.text).toMatch(/<h1> heading "Point fixture" @\S+ #title/);
    expect(item.paths).toHaveLength(1);
    expect(item.paths[0]).toMatch(/comments\.jpg$/);
    const jpeg = await readFile(item.paths[0]);
    const size = jpegSize(jpeg);
    expect(size.width).toBeGreaterThan(300);
    expect(size.width).toBeLessThanOrEqual(1600);
    const red = await fixture.app.evaluate(({ nativeImage }, path) => {
      const bitmap = nativeImage.createFromPath(path).toBitmap();
      let count = 0;
      for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2] > 200 && bitmap[i + 1] < 110 && bitmap[i] < 110) count++;
      return count;
    }, item.paths[0]);
    expect(red, "the marks are drawn on the image").toBeGreaterThan(200);
  } finally {
    await fixture.close();
  }
});

test("copy tab id gives the id agents use, with its URL and session on request", async () => {
  test.setTimeout(120_000);
  const fixture = await launch();
  const { page, app, request } = fixture;
  try {
    const tabId = await openBrowserTab(fixture);
    const { tabs } = await request("preview.list", {});
    expect(tabs.map((tab: { id: string }) => tab.id)).toContain(tabId);
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());

    await page.getByRole("button", { name: `Copy tab id ${tabId}`, exact: true }).click();
    await expect.poll(clipboard).toBe(tabId);
    await expect(page.getByTestId("point-notice")).toContainText(`Copied ${tabId}`);

    await page.getByRole("button", { name: "More ways to copy this tab", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy id, URL and session" }).click();
    await expect.poll(clipboard).toContain(`tabId: ${tabId}`);
    const reference = await clipboard();
    expect(reference).toContain(`url: ${fixture.url}`);
    expect(reference).toContain("title: Point fixture");
    expect(reference).toContain(`--tabId ${tabId}`);

    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await page.locator(`[data-tab-id="${tabId}"]`).click({ button: "right" });
    await page.locator('[role="menu"]').getByRole("button", { name: /Copy tab id/ }).click();
    await expect.poll(clipboard).toBe(tabId);
    expect(existsSync(fixture.workspaceDir)).toBe(true);
  } finally {
    await fixture.close();
  }
});
