import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const { decodePng, pixel, near } = require("../../scripts/fixtures/capture-lib.cjs") as {
  decodePng: (png: Buffer) => { width: number; height: number; data: Uint8Array };
  pixel: (image: { width: number; data: Uint8Array }, x: number, y: number) => number[];
  near: (rgb: number[], expected: number[], tolerance?: number) => boolean;
};

const HEADER = [47, 111, 222];
const NARROW = [224, 36, 94];
const FOOTER = [122, 63, 209];
const LIGHT_BG = [244, 246, 250];
const DARK_BG = [16, 20, 24];

const CORA = resolve(__dirname, "../../cli/cora.cjs");
const SERVER = resolve(__dirname, "../../resources/codara-studio-mcp/server.js");

// A page whose layout changes at a phone width and in dark mode, tall
// enough for a full-page capture, with a box the tests can move.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Capture fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font:16px system-ui;background:#f4f6fa;color:#172336}
header{height:80px;background:#2f6fde}
#hero{margin:24px;height:160px;background:#ffb02e}
#narrow{display:none;height:40px;background:#e0245e}
#box{position:absolute;left:40px;top:300px;width:120px;height:120px;background:#16a36a}
footer{position:absolute;top:2200px;height:60px;width:100%;background:#7a3fd1}
@media (max-width:500px){#narrow{display:block}}
@media (prefers-color-scheme:dark){body{background:#101418;color:#e8eef6}}
</style></head><body><header></header><div id="narrow"></div><div id="hero"></div><div id="box"></div><footer></footer></body></html>`;

function startFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(PAGE);
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((closed) => server.close(() => closed())) });
    });
  });
}

// The agent of a run: its tools act in the run's workspace.
function toolEnv(home: string, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODARA_HOME_DIR: home, SPARK_RUN_ID: runId };
  for (const key of ["SPARK_PANE_ID", "SPARK_AGENT_PANE_ID", "SPARK_HOME_DIR", "SPARK_USER_DATA_DIR"]) delete env[key];
  return env;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

/** The codara-studio MCP server over stdio, as any agent's MCP client starts it. */
async function mcpServer(home: string, runId: string) {
  const child = spawn(process.execPath, [SERVER], { env: toolEnv(home, runId), stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    } catch {
      /* not a reply */
    }
  });
  let id = 0;
  const send = (method: string, params: Record<string, unknown>) => new Promise<any>((done, fail) => {
    const current = ++id;
    replies.set(current, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    tools: async () => (await send("tools/list", {})).tools as Array<{ name: string; description: string; inputSchema: unknown }>,
    call: (name: string, args: Record<string, unknown>) => send("tools/call", { name, arguments: args }) as Promise<ToolResult>,
    close: () => {
      child.stdin!.end();
      child.kill();
    },
  };
}

async function cora(home: string, runId: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [CORA, "tool", ...args], { env: toolEnv(home, runId), maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function jpegSize(buffer: Buffer): { width: number; height: number } {
  for (let i = 2; i < buffer.length; ) {
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    i += 2 + length;
  }
  throw new Error("no JPEG frame header");
}

async function selectTab(page: Page, title: string) {
  await page.locator("[data-tab-id]").filter({ hasText: title }).first().click();
}

test("capture tools: screenshot options, before/after diff, sizes and recording, in the background and from the pane", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-preview-capture-tools-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspaceDir);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-capture",
    workspaces: [{ id: "ws-capture", name: "Capture tools", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startFixture();
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const request = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const artifacts = join(home, "workspace-data", "ws-capture", "browser");
  let mcp: Awaited<ReturnType<typeof mcpServer>> | null = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Capture tools", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);

    // The pane: a tab the user has on screen gets the responsive view and
    // the record button.
    const shown = await request("preview.navigate", { url: fixture.url });
    await request("preview.wait_for", { tabId: shown.tabId, selector: "#box" });
    await selectTab(page, new URL(fixture.url).host);
    const record = page.getByTestId("preview-record");
    await expect(record).toBeVisible();
    await page.getByRole("button", { name: "Responsive view" }).click();
    const responsive = page.getByTestId("responsive-view");
    await expect(responsive).toBeVisible();
    await expect(responsive.getByTestId("responsive-frame")).toHaveCount(3);
    await expect(responsive.getByText("Phone", { exact: false }).first()).toBeVisible();
    // Each frame lays the page out at its preset's size, unzoomed, and is
    // shrunk on screen to fit; the scheme switch reaches every frame.
    const frameState = () => page.evaluate(async () => {
      const frames = Array.from(document.querySelectorAll("webview[data-responsive-frame]")) as Array<HTMLElement & { executeJavaScript(code: string): Promise<unknown> }>;
      return Promise.all(frames.map(async (frame) => ({
        key: frame.getAttribute("data-responsive-frame"),
        onScreen: Math.round(frame.getBoundingClientRect().width),
        page: await frame.executeJavaScript('[innerWidth, visualViewport.scale, matchMedia("(prefers-color-scheme: dark)").matches]'),
      })));
    });
    await expect.poll(async () => (await frameState()).map((frame) => frame.page)).toEqual([[390, 1, expect.any(Boolean)], [820, 1, expect.any(Boolean)], [1440, 1, expect.any(Boolean)]]);
    for (const [index, frame] of (await frameState()).entries()) {
      expect(frame.onScreen).toBeLessThan([390, 820, 1440][index]);
    }
    // Scrolling one frame scrolls the others to the same point of the page.
    const scrollFractions = () => page.evaluate(async () => {
      const frames = Array.from(document.querySelectorAll("webview[data-responsive-frame]")) as Array<HTMLElement & { executeJavaScript(code: string): Promise<unknown> }>;
      return Promise.all(frames.map((frame) => frame.executeJavaScript("Math.round(100 * scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight))")));
    });
    await page.evaluate(async () => {
      const phone = document.querySelector("webview[data-responsive-frame]") as HTMLElement & { executeJavaScript(code: string): Promise<unknown> };
      await phone.executeJavaScript("scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2)");
    });
    await expect.poll(scrollFractions).toEqual([50, 50, 50]);
    await responsive.getByRole("radio", { name: "Dark" }).click();
    await expect.poll(async () => (await frameState()).map((frame) => (frame.page as unknown[])[2])).toEqual([true, true, true]);
    await responsive.getByRole("radio", { name: "Light" }).click();
    await expect.poll(async () => (await frameState()).map((frame) => (frame.page as unknown[])[2])).toEqual([false, false, false]);
    await responsive.getByRole("radio", { name: "Auto" }).click();

    // Editing sizes changes each frame in place: a rename or a new width
    // keeps the frame's guest, and two identical sizes are two frames.
    const frameIds = () => page.evaluate(() => Array.from(document.querySelectorAll("webview[data-responsive-frame]")).map((frame) => ({
      key: frame.getAttribute("data-responsive-frame"),
      id: (frame as HTMLElement & { getWebContentsId(): number }).getWebContentsId(),
    })));
    const before = await frameIds();
    await responsive.getByRole("button", { name: "Edit sizes" }).click();
    const editor = responsive.getByRole("dialog", { name: "Edit sizes" });
    await expect(editor).toBeVisible();
    const phoneName = editor.getByLabel("Name").first();
    await phoneName.fill("");
    await phoneName.pressSequentially("Pixel 8");
    await expect(responsive.getByTestId("responsive-frame").first()).toContainText("Pixel 8");
    const phoneWidth = editor.getByLabel("Width").first();
    await phoneWidth.fill("412");
    await phoneWidth.press("Enter");
    await expect.poll(async () => ((await frameState())[0].page as unknown[])[0]).toBe(412);
    expect(await frameIds()).toEqual(before);
    await editor.getByRole("button", { name: "Add size" }).click();
    await editor.getByRole("button", { name: "Add size" }).click();
    await expect(responsive.getByTestId("responsive-frame")).toHaveCount(5);
    const grown = await frameIds();
    expect(new Set(grown.map((frame) => frame.key)).size).toBe(5);
    expect(new Set(grown.map((frame) => frame.id)).size).toBe(5);
    expect(grown.slice(0, 3)).toEqual(before);
    await editor.getByRole("button", { name: "Reset" }).click();
    await expect(responsive.getByTestId("responsive-frame")).toHaveCount(3);

    // Escape in the editor closes the editor only.
    await editor.getByLabel("Name").first().focus();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(responsive).toBeVisible();
    await expect(responsive.getByRole("button", { name: "Edit sizes" })).toBeFocused();
    // An Escape something else already took, or one pressed outside this
    // pane, leaves the view open.
    await page.evaluate(() => window.addEventListener("keydown", (event) => event.preventDefault(), { capture: true, once: true }));
    await page.keyboard.press("Escape");
    await expect(responsive).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(responsive).toBeVisible();
    await responsive.getByRole("radio", { name: "Auto" }).focus();
    await page.keyboard.press("Escape");
    await expect(responsive).toHaveCount(0);

    // Pointing works on the page itself, so it closes the side-by-side view.
    await page.getByRole("button", { name: "Responsive view" }).click();
    await expect(responsive).toBeVisible();
    await page.getByRole("button", { name: /Point at an element/ }).click();
    await expect(responsive).toHaveCount(0);
    const picker = page.getByTestId("point-picker");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    await record.click();
    await expect(record).toHaveAttribute("aria-pressed", "true");
    for (const left of [120, 220, 320]) {
      await request("preview.evaluate", { tabId: shown.tabId, code: `document.getElementById("box").style.left = "${left}px"` });
      await page.waitForTimeout(400);
    }
    await record.click();
    const saved = page.getByTestId("preview-record-result");
    await expect(saved).toContainText("Recording saved", { timeout: 30_000 });
    const savedPath = await saved.getByTestId("preview-record-path").getAttribute("title");
    expect(savedPath).toMatch(/\.gif$/);
    expect(readFileSync(savedPath!).subarray(0, 6).toString("latin1")).toBe("GIF89a");
    await saved.getByRole("button", { name: "Dismiss" }).click();

    // Everything below runs on a run's tab the user never selected.
    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({ workspaceId: "ws-capture", workspaceName: "Capture tools", cwd, title: "Capture run" });
      return run.id as string;
    }, workspaceDir);
    const hidden = await request("preview.navigate", { url: fixture.url, runId });
    const tabId = hidden.tabId as string;
    const asRun = (method: string, params: Record<string, unknown>, timeoutMs?: number) => request(method, { ...params, runId }, timeoutMs);
    await asRun("preview.wait_for", { tabId, selector: "#box" });
    expect(await page.locator("webview").evaluateAll((els) => els.filter((el) => getComputedStyle(el).visibility === "visible").length)).toBe(1);
    // The agent works while the user is elsewhere: the window is minimized and hidden.
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.minimize();
        window.hide();
      }
    });

    // Screenshot options.
    const compact = await asRun("preview.screenshot", { tabId });
    expect(compact.mimeType).toBe("image/jpeg");
    expect(compact.imageSize.width).toBeLessThanOrEqual(1280);
    expect(jpegSize(Buffer.from(compact.dataUrl.split(",")[1], "base64"))).toEqual(compact.imageSize);
    expect(compact.path).toContain(join(artifacts, "screenshots"));
    expect(existsSync(compact.path)).toBe(true);
    const full = await asRun("preview.screenshot", { tabId, fullPage: true, format: "png", maxWidth: 400 });
    expect(full.fullPage).toBe(true);
    expect(full.region.height).toBeGreaterThanOrEqual(2260);
    expect(full.imageSize.width).toBe(400);
    // A guest only paints its on-screen surface: below the first screenful
    // the page must continue, not start over with its header.
    const fullImage = decodePng(Buffer.from(full.dataUrl.split(",")[1], "base64"));
    const fullScale = full.imageSize.width / full.region.width;
    const fullAt = (x: number, y: number) => pixel(fullImage, Math.round(x * fullScale), Math.round(y * fullScale));
    expect(near(fullAt(300, full.viewport.height + 40), HEADER)).toBe(false);
    expect([LIGHT_BG, DARK_BG].some((bg) => near(fullAt(300, full.viewport.height + 40), bg))).toBe(true);
    expect(near(fullAt(300, 2230), FOOTER)).toBe(true);
    // A screen-high section stays one screen tall instead of covering the
    // page below it, and a fixed element shows once, at the top.
    await asRun("preview.evaluate", { tabId, code: `(() => {
      const screen = document.createElement("div");
      screen.id = "screen-high";
      screen.style.cssText = "position:absolute;left:340px;top:0;width:30px;height:100vh;background:rgb(224,36,94)";
      const pin = document.createElement("div");
      pin.id = "pinned";
      pin.style.cssText = "position:fixed;left:390px;top:0;width:30px;height:30px;background:rgb(122,63,209)";
      document.body.append(screen, pin);
    })()` });
    const pinnedFull = await asRun("preview.screenshot", { tabId, fullPage: true, format: "png", maxWidth: 400 });
    expect(pinnedFull.region.height).toBe(full.region.height);
    const pinnedImage = decodePng(Buffer.from(pinnedFull.dataUrl.split(",")[1], "base64"));
    const pinnedScale = pinnedFull.imageSize.width / pinnedFull.region.width;
    const pinnedAt = (x: number, y: number) => pixel(pinnedImage, Math.round(x * pinnedScale), Math.round(y * pinnedScale));
    expect(near(pinnedAt(355, pinnedFull.viewport.height - 30), NARROW)).toBe(true);
    expect(near(pinnedAt(355, pinnedFull.viewport.height + 60), NARROW)).toBe(false);
    expect(near(pinnedAt(405, 15), FOOTER)).toBe(true);
    expect(near(pinnedAt(405, pinnedFull.viewport.height + 15), FOOTER)).toBe(false);
    expect((await asRun("preview.evaluate", { tabId, code: '[scrollY, document.getElementById("pinned").style.visibility]' })).value).toEqual([0, ""]);
    await asRun("preview.evaluate", { tabId, code: 'document.getElementById("screen-high").remove(); document.getElementById("pinned").remove()' });
    const element = await asRun("preview.screenshot", { tabId, selector: "#box", format: "png" });
    expect(element.region).toMatchObject({ width: 120, height: 120 });
    expect(element.imageSize).toEqual({ width: 120, height: 120 });
    const zoomed = await asRun("preview.screenshot", { tabId, clip: { x: 40, y: 300, width: 60, height: 40 }, scale: 2, format: "webp", quality: 80 });
    expect(zoomed.mimeType).toBe("image/webp");
    expect(zoomed.imageSize).toEqual({ width: 120, height: 80 });
    expect(Buffer.from(zoomed.dataUrl.split(",")[1], "base64").subarray(8, 12).toString("latin1")).toBe("WEBP");
    await expect(asRun("preview.screenshot", { tabId, format: "gif" })).rejects.toThrow(/format must be/);

    // Before/after: a reload alone is no change, a moved box is.
    const baseline = await asRun("preview.compare", { tabId, mode: "baseline", name: "home" });
    expect(baseline).toMatchObject({ mode: "baseline", name: "home", replaced: false });
    expect(existsSync(baseline.path)).toBe(true);
    await asRun("preview.navigate", { tabId, url: fixture.url });
    await asRun("preview.wait_for", { tabId, selector: "#box" });
    const same = await asRun("preview.compare", { tabId, name: "home" });
    expect(same).toMatchObject({ mode: "diff", percent: 0, summary: "No visible change." });
    expect(same.dataUrl).toBeUndefined();
    await asRun("preview.evaluate", { tabId, code: 'document.getElementById("box").style.left = "400px"' });
    const changed = await asRun("preview.compare", { tabId, name: "home" });
    expect(changed.percent).toBeGreaterThan(0);
    expect(changed.regions.length).toBeGreaterThanOrEqual(1);
    const union = changed.regions.reduce((acc: { x0: number; x1: number; y0: number; y1: number }, r: { x: number; y: number; width: number; height: number }) => ({
      x0: Math.min(acc.x0, r.x), y0: Math.min(acc.y0, r.y), x1: Math.max(acc.x1, r.x + r.width), y1: Math.max(acc.y1, r.y + r.height),
    }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    expect(union.x0).toBeLessThanOrEqual(42);
    expect(union.x1).toBeGreaterThanOrEqual(518);
    expect(union.y0).toBeLessThanOrEqual(302);
    expect(union.y1).toBeGreaterThanOrEqual(418);
    expect(changed.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(existsSync(changed.path)).toBe(true);
    const listed = await asRun("preview.compare", { tabId, mode: "list" });
    expect(listed.baselines.map((meta: { name: string }) => meta.name)).toEqual(["home"]);

    // Sizes side by side in both schemes; afterwards the tab has its own
    // viewport again and follows the system scheme.
    const viewport = "[innerWidth, innerHeight]";
    const viewportBefore = (await asRun("preview.evaluate", { tabId, code: viewport })).value;
    const sheet = await asRun("preview.compare", { tabId, mode: "sizes", colorScheme: "both", format: "png" });
    type Tile = { name: string; width: number; colorScheme: string; box: { x: number; y: number; width: number } };
    expect(sheet.tiles.map((tile: Tile) => `${tile.name}/${tile.colorScheme}`)).toEqual([
      "phone/light", "tablet/light", "desktop/light", "phone/dark", "tablet/dark", "desktop/dark",
    ]);
    expect(sheet.imageSize.width).toBeLessThanOrEqual(1600);
    // Each size is the page laid out at that size, past the tab's own
    // surface too: the phone gets the narrow layout, a tablet taller than
    // the pane continues below it, and the scheme row is honored.
    const sheetImage = decodePng(Buffer.from(sheet.dataUrl.split(",")[1], "base64"));
    const tileAt = (tile: Tile, x: number, y: number) => {
      const k = tile.box.width / tile.width;
      return pixel(sheetImage, Math.round(tile.box.x + x * k), Math.round(tile.box.y + y * k));
    };
    const [phoneLight, tabletLight, , , tabletDark] = sheet.tiles as Tile[];
    expect(near(tileAt(phoneLight, 200, 90), NARROW)).toBe(true);
    expect(near(tileAt(tabletLight, 200, 90), NARROW)).toBe(false);
    const below = Math.min(1100, viewportBefore[1] + 40);
    expect(near(tileAt(tabletLight, 400, below), LIGHT_BG)).toBe(true);
    expect(near(tileAt(tabletDark, 400, below), DARK_BG)).toBe(true);
    // Scaled down whole, not the previous size's frame cut off at the surface.
    expect(near(tileAt(tabletLight, 790, below), LIGHT_BG)).toBe(true);
    expect(near(tileAt(tabletDark, 790, below), DARK_BG)).toBe(true);
    expect(existsSync(sheet.path)).toBe(true);
    expect((await asRun("preview.evaluate", { tabId, code: viewport })).value).toEqual(viewportBefore);
    const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    expect((await asRun("preview.evaluate", { tabId, code: 'matchMedia("(prefers-color-scheme: dark)").matches' })).value).toBe(systemDark);

    // The same tools through the MCP server over stdio and `cora tool`.
    mcp = await mcpServer(home, runId);
    const captureTools = (await mcp.tools()).filter((tool) => /^codara_preview_(screenshot|compare|record)$/.test(tool.name));
    expect(captureTools.map((tool) => tool.name).sort()).toEqual(["codara_preview_compare", "codara_preview_record", "codara_preview_screenshot"]);
    expect(JSON.stringify(captureTools)).not.toMatch(/claude/i);
    const mcpShot = await mcp.call("codara_preview_screenshot", { tabId, selector: "#hero" });
    expect(mcpShot.isError).toBeFalsy();
    expect(mcpShot.content.find((block) => block.type === "image")?.mimeType).toBe("image/jpeg");
    const mcpText = JSON.parse(mcpShot.content.find((block) => block.type === "text")!.text!);
    expect(existsSync(mcpText.path)).toBe(true);
    expect(mcpText.dataUrl).toBeUndefined();
    const mcpSizes = await mcp.call("codara_preview_compare", { tabId, mode: "sizes", sizes: ["phone", "1024x768"] });
    expect(mcpSizes.content.filter((block) => block.type === "image")).toHaveLength(1);
    const printed = await cora(home, runId, ["preview_compare", "--tabId", tabId, "--name", "home"]);
    expect(JSON.parse(printed).path).toMatch(/home-diff\.jpg$/);

    // Recording with every window hidden: the agent starts and stops it.
    const started = await asRun("preview.record", { tabId, fps: 8, maxWidth: 480 });
    expect(started.recording).toBe(true);
    expect(await asRun("preview.record", { tabId })).toMatchObject({ recording: true, already: true });
    for (const left of [60, 160, 260, 360]) {
      await asRun("preview.evaluate", { tabId, code: `document.getElementById("box").style.left = "${left}px"` });
      await new Promise((done) => setTimeout(done, 350));
    }
    const gif = await asRun("preview.record", { tabId, stop: true }, 60_000);
    expect(gif).toMatchObject({ recording: false, format: "gif", mimeType: "image/gif" });
    expect(gif.frames).toBeGreaterThanOrEqual(3);
    expect(gif.size.width).toBeLessThanOrEqual(480);
    expect(gif.path).toContain(join(artifacts, "recordings"));
    expect(statSync(gif.path).size).toBe(gif.bytes);
    await expect(asRun("preview.record", { tabId, stop: true })).rejects.toThrow(/is not being recorded/);
    const viaMcp = await mcp.call("codara_preview_record", { tabId, maxSeconds: 1, format: "gif" });
    expect(JSON.parse(viaMcp.content[0].text!).recording).toBe(true);
    await new Promise((done) => setTimeout(done, 1600));
    const limited = JSON.parse((await mcp.call("codara_preview_record", { tabId, stop: true })).content[0].text!);
    expect(limited).toMatchObject({ format: "gif", stoppedBy: expect.stringMatching(/maxSeconds/) });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))).toBe(false);
  } finally {
    mcp?.close();
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
