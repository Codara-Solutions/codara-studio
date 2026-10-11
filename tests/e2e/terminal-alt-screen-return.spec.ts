import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for a full-screen agent pane coming back blank after a few
// workspace switches.
//
// Claude Code draws its whole UI in the alternate screen, sends only changed
// cells, repaints on SIGWINCH only when the size it reads has changed, and
// repaints in full on SIGCONT. The fake TUI below copies exactly that, and
// stalls its event loop like a busy agent. Two things used to blank it:
// a workspace left two switches ago was unloaded unless an agent badge kept
// it, and the text snapshot that rebuilt it held only the normal screen; and
// the only repaint request on reattach was a 100 ms resize pulse that a busy
// TUI handled after the size was already back, so it never repainted. Its
// mouse mode was lost as well, so the wheel scrolled xterm's own history.

const FAKE_TUI = String.raw`
const fs = require("node:fs");
const [statsFile, mode] = process.argv.slice(2);
const stats = { winch: 0, sizeChanges: 0, repaints: 0, conts: 0, mouseReports: 0 };
const save = () => fs.writeFileSync(statsFile, JSON.stringify(stats));
const size = () => process.stdout.getWindowSize().join("x");
let drawn = "";
let frame = 0;
const enter = () => process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l");
const paint = () => {
  const [cols, rows] = process.stdout.getWindowSize();
  drawn = cols + "x" + rows;
  frame += 1;
  let out = "\x1b[H\x1b[2J";
  for (let row = 1; row <= rows; row += 1) {
    out += "\x1b[" + row + ";1H" + ("ALTROW " + row + " frame " + frame + " " + "#".repeat(cols)).slice(0, cols);
  }
  process.stdout.write(out);
  stats.repaints += 1;
  save();
};
process.on("SIGWINCH", () => {
  stats.winch += 1;
  if (size() !== drawn) {
    stats.sizeChanges += 1;
    paint();
  } else {
    save();
  }
});
process.on("SIGCONT", () => {
  stats.conts += 1;
  enter();
  paint();
});
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (data.includes("\x1b[<")) {
    stats.mouseReports += 1;
    save();
  }
});
enter();
paint();
if (mode === "busy") {
  setInterval(() => {
    const until = Date.now() + 400;
    while (Date.now() < until) {}
  }, 450);
}
`;

interface TuiStats {
  winch: number;
  sizeChanges: number;
  repaints: number;
  conts: number;
  mouseReports: number;
}

test("a full-screen TUI keeps its workspace loaded and painted across workspace switches", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const paneId = await startTui(page, fixture, "busy");
    const painted = await paneInk(app, page, paneId);
    expect(painted, "the TUI's frame should fill the pane").toBeGreaterThan(0.05);
    await keepXtermNode(page, paneId);

    // A -> B -> C -> A. B is the one warm workspace the app keeps besides the
    // active one, so A survives only because its pane is in the alternate
    // screen; the fake TUI raises no agent badge.
    for (const workspace of ["ws-b", "ws-c", "ws-a"]) {
      await selectWorkspace(page, workspace);
      await page.waitForTimeout(700);
    }

    expect(await sameXtermNode(page, paneId), "the alternate-screen pane was unloaded").toBe(true);
    await expect
      .poll(() => paneInk(app!, page, paneId), { timeout: 3_000 })
      .toBeGreaterThan(painted * 0.8);
    await expectWheelReachesTui(page, fixture, paneId);
  } finally {
    await app?.close();
  }
});

test("a busy full-screen TUI repaints into the alternate screen when its xterm is rebuilt", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const paneId = await startTui(page, fixture, "busy");
    const painted = await paneInk(app, page, paneId);
    expect(painted, "the TUI's frame should fill the pane").toBeGreaterThan(0.05);
    const before = await readStats(fixture);

    // A renderer reload (the app's own hang and crash recovery does the same)
    // rebuilds every xterm from scratch while the PTY and the TUI keep
    // running, which is the reattach path a workspace that was unloaded takes.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
    await expect(page.locator(`[data-terminal-pane-id="${paneId}"] .xterm-host`)).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(async () => (await readStats(fixture)).repaints, { timeout: 5_000 })
      .toBeGreaterThan(before.repaints);
    await expect
      .poll(() => paneInk(app!, page, paneId), { timeout: 5_000 })
      .toBeGreaterThan(painted * 0.8);
    await expectWheelReachesTui(page, fixture, paneId);
  } finally {
    await app?.close();
  }
});

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODEX_HOME: join(fixture.userDataDir, "codex-home"),
      GROK_HOME: join(fixture.userDataDir, "grok-home"),
      CLAUDE_CONFIG_DIR: join(fixture.userDataDir, "claude-home"),
      // Pin every home override the app honors: a shell inside the dev app
      // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR.
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function startTui(page: Page, fixture: Fixture, mode: "busy" | "idle"): Promise<string> {
  await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
  const pane = page.locator("[data-terminal-pane-id]:visible").first();
  await expect(pane.locator(".xterm-host")).toBeVisible({ timeout: 15_000 });
  const paneId = await pane.getAttribute("data-terminal-pane-id");
  expect(paneId).toBeTruthy();
  const input = pane.locator(".xterm-helper-textarea").first();
  await input.focus();
  await input.pressSequentially(`"${process.execPath}" "${fixture.tui}" "${fixture.statsFile}" ${mode}`, {
    delay: 2,
  });
  await input.press("Enter");
  await expect.poll(async () => (await readStats(fixture)).repaints, { timeout: 15_000 }).toBeGreaterThan(0);
  // Let the frame reach xterm and the renderer.
  await page.waitForTimeout(1_000);
  return paneId!;
}

async function selectWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.locator(`[data-workspace-id="${workspaceId}"]`).evaluate((row) => (row as HTMLElement).click());
}

async function keepXtermNode(page: Page, paneId: string): Promise<void> {
  await page.locator(`[data-terminal-pane-id="${paneId}"] .xterm`).first().evaluate((node) => {
    (window as unknown as { __altScreenXterm?: Element }).__altScreenXterm = node;
  });
}

async function sameXtermNode(page: Page, paneId: string): Promise<boolean> {
  const node = page.locator(`[data-terminal-pane-id="${paneId}"] .xterm`).first();
  if ((await node.count()) === 0) return false;
  return node.evaluate(
    (current) => (window as unknown as { __altScreenXterm?: Element }).__altScreenXterm === current,
  );
}

// Share of the pane's pixels that differ from its dominant (background)
// color. Read from a capture of the composited window, so it holds for the
// WebGL and the DOM renderer alike.
async function paneInk(app: ElectronApplication, page: Page, paneId: string): Promise<number> {
  const rect = await page
    .locator(`[data-terminal-pane-id="${paneId}"] .xterm-screen`)
    .first()
    .evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: Math.ceil(box.x), y: Math.ceil(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };
    });
  if (rect.width < 10 || rect.height < 10) return 0;
  return app.evaluate(async ({ BrowserWindow }, area) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage(area);
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const counts = new Map<number, number>();
    const pixels = width * height;
    for (let i = 0; i < pixels; i += 1) {
      const o = i * 4;
      const key = ((bitmap[o] >> 4) << 8) | ((bitmap[o + 1] >> 4) << 4) | (bitmap[o + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let background = 0;
    for (const count of counts.values()) background = Math.max(background, count);
    return pixels > 0 ? (pixels - background) / pixels : 0;
  }, rect);
}

async function expectWheelReachesTui(page: Page, fixture: Fixture, paneId: string): Promise<void> {
  const before = (await readStats(fixture)).mouseReports;
  const screen = page.locator(`[data-terminal-pane-id="${paneId}"] .xterm-screen`).first();
  await screen.evaluate((node) => {
    const box = node.getBoundingClientRect();
    node.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        clientX: box.x + 20,
        clientY: box.y + 20,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(async () => (await readStats(fixture)).mouseReports, {
      timeout: 5_000,
      message: "the wheel no longer reaches the TUI as a mouse report",
    })
    .toBeGreaterThan(before);
}

async function readStats(fixture: Fixture): Promise<TuiStats> {
  try {
    return JSON.parse(await readFile(fixture.statsFile, "utf8")) as TuiStats;
  } catch {
    return { winch: 0, sizeChanges: 0, repaints: 0, conts: 0, mouseReports: 0 };
  }
}

interface Fixture {
  userDataDir: string;
  tui: string;
  statsFile: string;
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-alt-screen-return-"));
  const userDataDir = join(root, "user-data");
  const workspaces = ["a", "b", "c"].map((name) => join(root, `workspace-${name}`));
  await Promise.all([userDataDir, ...workspaces].map((dir) => mkdir(dir, { recursive: true })));
  const tui = join(root, "fake-tui.js");
  await writeFile(tui, FAKE_TUI, "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: workspaces.map((cwd, index) => ({
          id: `ws-${"abc"[index]}`,
          name: `workspace-${"abc"[index]}`,
          cwd,
          color: ["#34D3C3", "#78A8FF", "#F0C419"][index],
          workers: [],
        })),
        activeWorkspaceId: "ws-a",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, tui, statsFile: join(root, "tui-stats.json") };
}
