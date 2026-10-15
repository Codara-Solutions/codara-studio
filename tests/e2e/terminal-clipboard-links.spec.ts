import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Terminal fixes, end to end in a real pane:
// - emoji take two cells, measured by the cursor position xterm reports back
//   to the program (the same answer a TUI lays itself out by)
// - an OSC 52 copy reaches the clipboard, a clipboard read is never answered,
//   and the Terminal setting turns copies off
// - a plain click on a link opens the link menu, Ctrl or Cmd+click opens it
//   directly, and the General setting turns the menu off
// - "Copy terminal context" copies the recent output and working directory
//
// The clipboard and both browser routes are stubbed in main, so nothing here
// touches the real clipboard or opens a browser.

const LINK = "https://example.test/codara-link";
const MARKER = "CONTEXT-MARKER-4821";

const PROGRAM = String.raw`
const fs = require("node:fs");
const [statsFile, mode, payload] = process.argv.slice(2);
const stats = { mode, cpr: null, answered: false, cols: process.stdout.columns, rows: process.stdout.rows };
const save = () => fs.writeFileSync(statsFile, JSON.stringify(stats));
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
let input = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  input += data.toString("latin1");
  const cpr = /\x1b\[(\d+);(\d+)R/.exec(input);
  if (cpr && stats.cpr === null) stats.cpr = Number(cpr[2]);
  if (input.includes("]52;")) stats.answered = true;
  save();
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  if (mode === "full") {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("\u{1F600}X\x1b[6n");
    await wait(400);
    process.stdout.write("\r\n\r\n" + "${LINK}" + "\r\n${MARKER}\r\n");
  }
  process.stdout.write("\x1b]52;c;?\x07");
  process.stdout.write("\x1b]52;c;" + b64(payload) + "\x07");
  await wait(600);
  save();
  process.exit(0);
})();
`;

interface Stats {
  mode: string;
  cpr: number | null;
  answered: boolean;
  cols: number;
  rows: number;
}

interface Calls {
  clipboard: string[];
  system: string[];
  links: string[];
}

test("emoji widths, OSC 52 copies, the link menu and terminal context", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        CODEX_HOME: join(fixture.userDataDir, "codex-home"),
        GROK_HOME: join(fixture.userDataDir, "grok-home"),
        CLAUDE_CONFIG_DIR: join(fixture.userDataDir, "claude-home"),
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Main registers its handlers before it opens the window; replacing them
    // any earlier would collide with that registration.
    await stubClipboardAndBrowsers(app);
    await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
    const pane = page.locator("[data-terminal-pane-id]:visible").first();
    await expect(pane.locator(".xterm-host")).toBeVisible({ timeout: 15_000 });

    // Widths and OSC 52.
    await runProgram(pane, fixture, "full", "copied over OSC 52");
    const stats = await waitForStats(fixture, "full");
    expect(stats.cpr, "the cursor sits after a two-cell emoji and one letter").toBe(4);
    await expect.poll(async () => (await calls(app!)).clipboard).toContain("copied over OSC 52");
    expect((await readStats(fixture))!.answered, "a clipboard read is never answered").toBe(false);

    // A plain click opens the menu.
    const link = await cellCenter(pane, stats, 2, 2);
    const menu = page.locator("[data-terminal-link-menu]");
    await clickAt(page, link);
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Open in Codara browser",
      "Open in default browser",
      "Copy link",
    ]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await expect(menu).toContainText(LINK);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => (await calls(app!)).clipboard).toContain(LINK);
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();

    await clickAt(page, link);
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Open in default browser" }).click();
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => (await calls(app!)).system).toEqual([LINK]);

    await clickAt(page, link);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();

    // Ctrl or Cmd+click opens the link where links open, with no menu.
    await clickAt(page, link, process.platform === "darwin" ? "Meta" : "Control");
    await expect.poll(async () => (await calls(app!)).links).toEqual([LINK]);
    await expect(menu).toHaveCount(0);

    // Copy terminal context.
    await page.getByRole("button", { name: "Copy terminal context" }).first().dispatchEvent("click");
    await expect.poll(async () => (await calls(app!)).clipboard.some((text) => text.includes(MARKER))).toBe(true);
    const copied = (await calls(app!)).clipboard.find((text) => text.includes(MARKER))!;
    expect(copied).toMatch(/^Terminal context\n/);
    expect(copied).toContain(`Working directory: ${fixture.workspaceDir}\n`);
    expect(copied).toContain(LINK);
    expect(copied).toMatch(/\n```text\n[\s\S]*\n```\n$/);
    await expect(page.getByText("Terminal context copied").first()).toBeVisible();

    // The link menu setting off: a plain click opens the link.
    await page.evaluate(() => window.spark.preferences.set("terminalLinkMenu", false));
    await clickAt(page, link);
    await expect.poll(async () => (await calls(app!)).links).toEqual([LINK, LINK]);
    await expect(menu).toHaveCount(0);
    await page.evaluate(() => window.spark.preferences.set("terminalLinkMenu", true));

    // The OSC 52 setting off, saved from the Terminal page.
    await page.getByTitle("Settings").first().click({ force: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Terminal", exact: true })
      .click();
    const toggle = settings.locator('[data-setting-anchor="Let programs copy to the clipboard"]').getByRole("switch");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toHaveCount(0);
    await runProgram(pane, fixture, "osc52", "blocked copy");
    await waitForStats(fixture, "osc52");
    await expect(page.getByText("Terminal copy blocked").first()).toBeVisible();
    expect((await calls(app!)).clipboard).not.toContain("blocked copy");
  } finally {
    await app?.close();
  }
});

async function stubClipboardAndBrowsers(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { __terminalFixCalls?: Calls };
    const recorded: Calls = { clipboard: [], system: [], links: [] };
    state.__terminalFixCalls = recorded;
    ipcMain.removeHandler("clipboard:writeText");
    ipcMain.handle("clipboard:writeText", (_event, text: string) => {
      recorded.clipboard.push(text);
    });
    ipcMain.removeHandler("app:openExternal");
    ipcMain.handle("app:openExternal", (_event, url: string) => {
      recorded.system.push(url);
    });
    ipcMain.removeHandler("app:openLink");
    ipcMain.handle("app:openLink", (_event, url: string) => {
      recorded.links.push(url);
    });
  });
}

async function calls(app: ElectronApplication): Promise<Calls> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __terminalFixCalls?: Calls };
    return state.__terminalFixCalls ?? { clipboard: [], system: [], links: [] };
  });
}

async function runProgram(pane: Locator, fixture: Fixture, mode: string, payload: string): Promise<void> {
  const input = pane.locator(".xterm-helper-textarea").first();
  await input.focus();
  await input.pressSequentially(
    `"${process.execPath}" "${fixture.program}" "${fixture.statsFile}" ${mode} "${payload}"`,
    { delay: 2 },
  );
  await input.press("Enter");
}

async function readStats(fixture: Fixture): Promise<Stats | null> {
  try {
    return JSON.parse(await readFile(fixture.statsFile, "utf8")) as Stats;
  } catch {
    return null;
  }
}

async function waitForStats(fixture: Fixture, mode: string): Promise<Stats> {
  await expect
    .poll(async () => (await readStats(fixture))?.mode, { timeout: 20_000 })
    .toBe(mode);
  // The program saves once more right before it exits.
  await new Promise((resolve) => setTimeout(resolve, 900));
  return (await readStats(fixture))!;
}

// The center of a cell, from the screen's size and the grid the program saw.
async function cellCenter(pane: Locator, stats: Stats, row: number, col: number): Promise<{ x: number; y: number }> {
  const box = await pane.locator(".xterm-screen").first().boundingBox();
  expect(box).toBeTruthy();
  const cellWidth = box!.width / stats.cols;
  const cellHeight = box!.height / stats.rows;
  return { x: box!.x + (col + 0.5) * cellWidth, y: box!.y + (row + 0.5) * cellHeight };
}

async function clickAt(page: Page, point: { x: number; y: number }, modifier?: "Control" | "Meta"): Promise<void> {
  // xterm finds the link under the pointer on mouse move, then activates it
  // when the button goes down and up on it.
  await page.mouse.move(point.x - 3, point.y);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(150);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.down();
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

interface Fixture {
  userDataDir: string;
  workspaceDir: string;
  program: string;
  statsFile: string;
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-fixes-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const program = join(root, "program.cjs");
  await writeFile(program, PROGRAM, "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [{ id: "ws-term", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-term",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir, program, statsFile: join(root, "stats.json") };
}
