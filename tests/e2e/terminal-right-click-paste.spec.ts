import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A right-click in a terminal with text on the clipboard pastes it once:
// in a plain shell, and under a program that behaves like Claude Code's
// full-screen mode. Every write to the PTY is recorded in main, so a second
// paste from any path (the terminal's quick edit, xterm's own textarea
// paste, the browser's native paste) shows up as a second write.
//
// The program asks the terminal who it is (XTVERSION), turns on mouse
// reporting, and on a right-click pastes the clipboard itself unless the
// terminal said it is xterm.js, as Claude Code does on Linux and Windows.
// Codara did not answer, so one right-click pasted twice.

const MARK = "RIGHT-CLICK-PASTE-7313";

const TUI = String.raw`
const fs = require("node:fs");
const [statsFile, clipboardText] = process.argv.slice(2);
const stats = { identity: null, ready: false, selfPastes: 0, received: 0 };
const save = () => fs.writeFileSync(statsFile, JSON.stringify(stats));
let input = "";
let probing = true;
const finishProbe = () => {
  if (!probing) return;
  probing = false;
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
  stats.ready = true;
  save();
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  input += data.toString("utf8");
  const version = /\x1bP>\|([^\x1b]*)\x1b\\/.exec(input);
  if (version && stats.identity === null) stats.identity = version[1];
  // The primary device attributes reply comes after any XTVERSION reply.
  if (probing && /\x1b\[\?[\d;]*c/.test(input)) finishProbe();
  let release;
  const releases = /\x1b\[<2;\d+;\d+m/g;
  while ((release = releases.exec(input))) {
    if (!(stats.identity ?? "").startsWith("xterm.js")) stats.selfPastes += 1;
  }
  input = input.replace(releases, "");
  stats.received = input.split(clipboardText).length - 1;
  save();
});
process.stdout.write("\x1b[>q\x1b[c");
setTimeout(finishProbe, 2000);
save();
`;

interface Recorded {
  writes: string[];
}

test("a right-click pastes the clipboard into the terminal exactly once", async () => {
  // The steps type a POSIX command line (Ctrl+U, a quoted program path);
  // PowerShell, Windows' default shell, reads neither that way.
  test.skip(process.platform === "win32", "drives a POSIX shell");
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        CODEX_HOME: join(fixture.root, "codex-home"),
        GROK_HOME: join(fixture.root, "grok-home"),
        CLAUDE_CONFIG_DIR: join(fixture.root, "claude-home"),
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Main registers its handlers before it opens the window.
    await recordPtyWrites(app);
    await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
    const pane = page.locator("[data-terminal-pane-id]:visible").first();
    await expect(pane.locator(".xterm-host")).toBeVisible({ timeout: 15_000 });
    // Let the shell draw its prompt before anything is pasted into it.
    await page.waitForTimeout(1_500);

    await test.step("a plain shell", async () => {
      await rightClickPaste(app!, page, pane);
    });

    await test.step("a program that pastes on a right-click unless the terminal is xterm.js", async () => {
      const input = pane.locator(".xterm-helper-textarea").first();
      await input.focus();
      // Clear what the first step pasted onto the command line.
      await input.press("Control+u");
      await input.pressSequentially(`"${process.execPath}" "${fixture.program}" "${fixture.statsFile}" ${MARK}`, {
        delay: 2,
      });
      await input.press("Enter");
      await expect.poll(async () => (await readStats(fixture))?.ready, { timeout: 15_000 }).toBe(true);
      await rightClickPaste(app!, page, pane);
      await expect.poll(async () => (await readStats(fixture))?.received, { timeout: 10_000 }).toBe(1);
      // What reached the program from Codara, plus what it pasted itself.
      const stats = (await readStats(fixture))!;
      expect(stats.received + stats.selfPastes, `pastes the user sees: ${JSON.stringify(stats)}`).toBe(1);
      expect(stats.identity ?? "", "the terminal says it is xterm.js").toMatch(/^xterm\.js\(/);
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function rightClickPaste(app: ElectronApplication, page: Page, pane: Locator): Promise<void> {
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), MARK);
  await clearWrites(app);
  const box = await pane.locator(".xterm-screen").first().boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await expect.poll(async () => pastes(await writes(app)), { timeout: 10_000 }).toBeGreaterThan(0);
  // A second paste would land within a few hundred milliseconds.
  await page.waitForTimeout(1_500);
  const recorded = await writes(app);
  expect(pastes(recorded), `PTY writes: ${JSON.stringify(recorded)}`).toBe(1);
}

function pastes(recorded: string[]): number {
  return recorded.reduce((count, data) => count + data.split(MARK).length - 1, 0);
}

async function recordPtyWrites(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { __rightClickPaste?: Recorded };
    const recorded: Recorded = { writes: [] };
    state.__rightClickPaste = recorded;
    // The real handler stays in place; a listener on the same channel
    // cannot see invoke calls, so wrap the registered one.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })
      ._invokeHandlers;
    const original = handlers?.get("pty:write");
    ipcMain.removeHandler("pty:write");
    ipcMain.handle("pty:write", (event, args: { id: string; data: string }) => {
      recorded.writes.push(args.data);
      return original?.(event, args);
    });
  });
}

async function clearWrites(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __rightClickPaste?: Recorded };
    if (state.__rightClickPaste) state.__rightClickPaste.writes = [];
  });
}

async function writes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __rightClickPaste?: Recorded };
    return state.__rightClickPaste?.writes ?? [];
  });
}

interface Fixture {
  root: string;
  userDataDir: string;
  program: string;
  statsFile: string;
}

interface Stats {
  identity: string | null;
  ready: boolean;
  selfPastes: number;
  received: number;
}

async function readStats(fixture: Fixture): Promise<Stats | null> {
  try {
    return JSON.parse(await readFile(fixture.statsFile, "utf8")) as Stats;
  } catch {
    return null;
  }
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-right-click-paste-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-paste", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-paste",
    }),
    "utf8",
  );
  const program = join(root, "tui.cjs");
  await writeFile(program, TUI, "utf8");
  return { root, userDataDir, program, statsFile: join(root, "stats.json") };
}
