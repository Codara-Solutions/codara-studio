import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FAKE_AGENT, paneMcp, type PaneMcp } from "./in-pane-mcp";
import { cleanEnv } from "./agent-env";

// The agent's cursor and driving banner on a Codara browser tab, driven by a
// Claude Code session in a terminal pane through the stdio MCP server, as an
// agent runs it. The cursor glides on a curved path to the button before the
// click lands; the banner names the agent and its workspace; the agent's own
// screenshot of the page does not contain the cursor; and Stop refuses the
// agent's next call until Undo. Frames of the glide and stills land in
// test-results/agent-presence/ for the pull request.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const OUT = resolve(__dirname, "../../test-results/agent-presence");
const WORKSPACE = "AI Continous Improvment";

const PAGE = `<!doctype html><title>Billing settings</title>
  <style>
    :root { color-scheme: light; background: #f6f7f9; color: #111 }
    body { font: 15px system-ui; margin: 0; padding: 32px 40px; overflow: hidden }
    form { display: grid; gap: 12px; max-width: 380px; margin-top: 24px }
    input { font: inherit; padding: 8px 10px; border: 1px solid #bbb; border-radius: 6px }
    #go { position: absolute; left: 300px; top: 250px; width: 260px; height: 150px; border: 0; border-radius: 12px;
          background: rgb(34, 85, 255); color: rgb(34, 85, 255); font: 600 18px system-ui }
  </style>
  <h1>Billing settings</h1>
  <form><label>Invoice email <input id="email" type="email" placeholder="billing@acme.test"></label></form>
  <button id="go">Save</button>
  <script>
    document.getElementById("go").addEventListener("click", () => {
      document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1);
      document.body.dataset.clickedAt = String(performance.timeOrigin + performance.now());
    });
  </script>`;

function startFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    done({ server, url: `http://127.0.0.1:${port}/billing` });
  }));
}

interface Content { type: string; text?: string; data?: string; mimeType?: string }

function startMcp(link: PaneMcp) {
  let nextId = 1;
  const pending = new Map<number, (message: { result?: any; error?: any }) => void>();
  link.onMessage((message) => {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((done, fail) => {
      const id = nextId++;
      pending.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      link.send({ id, method, params });
    });
  return {
    request,
    async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; images: Content[]; isError: boolean }> {
      const result = await request("tools/call", { name, arguments: args });
      const content = result.content as Content[];
      return {
        text: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
        images: content.filter((part) => part.type === "image"),
        isError: result.isError === true,
      };
    },
    close: () => link.close(),
  };
}

interface Frame { t: number; x: number; y: number; active: boolean }

type Rect = { x: number; y: number; width: number; height: number };

const FILMING = process.env.CODARA_PRESENCE_VIDEO === "1" && Boolean(process.env.DISPLAY && process.env.CODARA_E2E_DISPLAY);

function x11grab(area: Rect, output: string[]): ReturnType<typeof spawn> {
  const even = (value: number) => Math.floor(value / 2) * 2;
  return spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30",
    "-video_size", `${even(area.width)}x${even(area.height)}`, "-i", `${process.env.DISPLAY}+${Math.round(area.x)},${Math.round(area.y)}`,
    ...output,
  ], { stdio: ["pipe", "ignore", "inherit"] });
}

/**
 * With CODARA_PRESENCE_VIDEO=1, film an area of the test's private X display
 * (never the desktop) for the demo in the pull request. Returns the stop.
 */
function filmDisplay(area: Rect | null, file: string): () => Promise<void> {
  if (!FILMING || !area) return async () => {};
  const ffmpeg = x11grab(area, ["-pix_fmt", "yuv420p", file]);
  return () => new Promise((done) => {
    ffmpeg.once("exit", () => done());
    ffmpeg.stdin?.end("q");
  });
}

/** One still of an area of the private display, as the user sees it. */
function grabStill(area: Rect, file: string): Promise<void> {
  return new Promise((done) => x11grab(area, ["-frames:v", "1", file]).once("exit", () => done()));
}

/** Every animation frame of the visible tab's agent cursor for ms, in overlay pixels. */
function sampleCursor(page: Page, ms: number): Promise<{ frames: Frame[]; offset: { x: number; y: number } }> {
  return page.evaluate((duration) => new Promise((done) => {
    const pane = Array.from(document.querySelectorAll("[data-browser-pane]") as NodeListOf<HTMLElement>).find((node) => getComputedStyle(node).visibility === "visible");
    const layer = pane?.querySelector("[data-agent-presence]") as HTMLElement | null | undefined;
    const cursor = layer?.querySelector("[data-agent-cursor]") as HTMLElement | null | undefined;
    const webview = pane?.querySelector("webview");
    if (!layer || !cursor || !webview) return done({ frames: [], offset: { x: 0, y: 0 } });
    const page = webview.getBoundingClientRect();
    const root = layer.getBoundingClientRect();
    const frames: Array<{ t: number; x: number; y: number; active: boolean }> = [];
    const end = performance.now() + duration;
    const tick = () => {
      const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(cursor.style.transform);
      if (match) frames.push({ t: performance.timeOrigin + performance.now(), x: Number(match[1]), y: Number(match[2]), active: cursor.hasAttribute("data-active") });
      if (performance.now() < end) requestAnimationFrame(tick);
      else done({ frames, offset: { x: page.left - root.left, y: page.top - root.top } });
    };
    requestAnimationFrame(tick);
  }), ms);
}

test("an agent's cursor glides before it clicks, the banner names it, and Stop takes the tab back", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-agent-presence-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-presence",
    workspaces: [{ id: "ws-presence", name: WORKSPACE, cwd, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startFixture();
  const app = await electron.launch({
    args: ["."],
    env: { ...cleanEnv(home), SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1" },
  });
  const socket = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  // The test's own reads of the page come from the agent's pane too: any
  // socket caller is an agent to the banner, and it names the latest one.
  const agent: Record<string, unknown> = {};
  const pageValue = async (code: string) => (await socket("preview.evaluate", { ...agent, code })).value;
  let mcp: ReturnType<typeof startMcp> | null = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    await expect(page.getByText(WORKSPACE, { exact: true }).first()).toBeVisible();
    await expect.poll(async () => socket("app.info").then(() => true).catch(() => false)).toBe(true);

    // Claude Code in a terminal pane of the workspace: a process Codara
    // recognizes as claude, as the real CLI is.
    const bin = join(root, "bin");
    await mkdir(bin);
    // It runs the MCP server as its child, as the real CLI does.
    await writeFile(join(bin, "claude"), FAKE_AGENT, { mode: 0o755 });
    const link = paneMcp(join(bin, "claude"), home, root, "claude");
    const { paneId } = await socket("terminal.create", { cwd, title: "Claude Code", command: link.command });
    agent.callerPaneId = paneId;

    mcp = startMcp(link);
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    const opened = await mcp.call("codara_preview_navigate", { url: fixture.url });
    expect(opened.isError, opened.text).toBe(false);
    const done = page.getByRole("button", { name: "Done" });
    if (await done.isVisible()) await done.click();
    // The user watches the agent's tab.
    await page.locator(`[data-tab-id="${JSON.parse(opened.text).tabId}"]`).click();
    const pane = page.locator("[data-browser-pane]").filter({ has: page.locator("webview") }).locator("visible=true");
    await expect(pane).toHaveCount(1);
    await expect.poll(() => pageValue("document.title").catch(() => "")).toBe("Billing settings");
    // The pane where the user sees it on the display. A Playwright screenshot
    // draws the <webview>'s pixels at the wrong offset, so stills for people
    // come from the display itself when filming.
    const paneOnScreen = async (): Promise<Rect | null> => {
      const box = await pane.boundingBox();
      const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds() ?? null);
      return box && content ? { x: content.x + box.x, y: content.y + box.y, width: box.width, height: box.height } : null;
    };
    const shoot = async (path: string) => {
      const area = FILMING ? await paneOnScreen() : null;
      if (area) await grabStill(area, path);
      else await page.screenshot({ path, clip: (await pane.boundingBox())! });
    };
    // The banner fades a few seconds after the last call.
    await expect(pane.locator("[data-agent-banner]")).toHaveCount(0, { timeout: 8_000 });
    await shoot(join(OUT, "1-before.png"));

    const stopFilming = filmDisplay(await paneOnScreen(), join(OUT, "glide.mp4"));
    // Type: the cursor lands on the field and outlines it.
    expect((await mcp.call("codara_preview_type", { selector: "#email", text: "billing@acme.test" })).isError).toBe(false);
    const banner = pane.locator("[data-agent-banner]");
    await expect(banner).toContainText(`Claude Code · ${WORKSPACE} is using this tab`);
    await expect(pane.locator(".agent-presence__field[data-active]")).toHaveCount(1);
    await shoot(join(OUT, "2-typing.png"));

    // Click: sample every frame of the glide while the call runs.
    const target = await pageValue(`(() => { const r = document.getElementById("go").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    const [sample, clicked] = await Promise.all([
      sampleCursor(page, 1_400),
      mcp.call("codara_preview_click", { selector: "#go" }),
    ]);
    expect(clicked.isError, clicked.text).toBe(false);
    expect(await pageValue("document.body.dataset.clicks")).toBe("1");
    const frames = sample.frames.filter((frame) => frame.active);
    const last = frames.at(-1)!;
    expect(Math.abs(last.x - sample.offset.x - target.x)).toBeLessThan(1.5);
    expect(Math.abs(last.y - sample.offset.y - target.y)).toBeLessThan(1.5);
    const moving = frames.filter((frame, index) => index > 0 && (frame.x !== frames[index - 1].x || frame.y !== frames[index - 1].y));
    expect(moving.length, "the cursor glides through many frames, it does not teleport").toBeGreaterThan(8);
    const arrived = frames.find((frame) => Math.abs(frame.x - last.x) < 0.5 && Math.abs(frame.y - last.y) < 0.5)!;
    const glideMs = arrived.t - moving[0].t;
    expect(glideMs).toBeGreaterThan(180);
    expect(glideMs).toBeLessThan(600);
    const start = frames.find((frame) => frame === moving[0]) ?? frames[0];
    const length = Math.hypot(last.x - start.x, last.y - start.y);
    const bow = Math.max(...moving.map((frame) => Math.abs((last.x - start.x) * (start.y - frame.y) - (start.x - frame.x) * (last.y - start.y)) / length));
    expect(bow, "the path curves like a hand, not a ruler").toBeGreaterThan(3);
    const clickedAt = Number(await pageValue("document.body.dataset.clickedAt"));
    expect(clickedAt, "the page got the click only after the cursor arrived").toBeGreaterThanOrEqual(arrived.t - 20);
    await shoot(join(OUT, "3-clicked.png"));
    await page.waitForTimeout(600);
    await stopFilming();

    // The agent's own screenshot of the page has no cursor in it, even now
    // that the cursor sits on the button.
    await expect(pane.locator("[data-agent-cursor][data-active]")).toHaveCount(1);
    const shot = await mcp.call("codara_preview_screenshot");
    expect(shot.images).toHaveLength(1);
    const viewportWidth = Number(await pageValue("innerWidth"));
    const pixels = await app.evaluate(({ nativeImage }, { data, target, viewportWidth }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
      const { width } = image.getSize();
      const bitmap = image.toBitmap();
      const scale = width / viewportWidth;
      // The arrow's body and its name tag run down and to the right of the tip.
      return [[2, 3], [4, 9], [6, 14], [3, 17], [30, 26], [60, 26]].map(([dx, dy]) => {
        const x = Math.round((target.x + dx) * scale);
        const y = Math.round((target.y + dy) * scale);
        const index = (y * width + x) * 4;
        return [bitmap[index + 2], bitmap[index + 1], bitmap[index]];
      });
    }, { data: shot.images[0].data!, target, viewportWidth });
    for (const [r, g, b] of pixels) {
      expect(Math.abs(r - 34) + Math.abs(g - 85) + Math.abs(b - 255), `pixel ${r},${g},${b} is the button, not the cursor`).toBeLessThan(60);
    }

    // Stop: the agent's next call is refused, on this tab, with a reason.
    await banner.getByRole("button", { name: "Stop" }).click();
    await expect(banner).toContainText("Stopped Claude Code. It can no longer use this tab.");
    await expect(pane.locator("[data-agent-cursor][data-active]")).toHaveCount(0);
    await shoot(join(OUT, "4-stopped.png"));
    const refused = await mcp.call("codara_preview_click", { selector: "#go" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/The user stopped Claude Code from using browser tab .* Do not use this tab again/);
    const trusted = await mcp.call("codara_preview_mouse", { x: 600, y: 300 });
    expect(trusted.isError, "trusted input is refused too").toBe(true);
    const renavigate = await mcp.call("codara_preview_navigate", { url: fixture.url });
    expect(renavigate.isError, "navigate does not take the tab back either").toBe(true);

    // Undo lets the agent back in.
    await banner.getByRole("button", { name: "Undo" }).click();
    expect(await pageValue("document.body.dataset.clicks"), "none of the refused calls reached the page").toBe("1");
    expect((await mcp.call("codara_preview_click", { selector: "#go" })).isError).toBe(false);
    expect(await pageValue("document.body.dataset.clicks")).toBe("2");
    await page.screenshot({ path: testInfo.outputPath("window.png") });
  } finally {
    mcp?.close();
    fixture.server.close();
    await app.close();
  }
});
