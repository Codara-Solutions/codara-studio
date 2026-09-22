import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for hidden terminal panes burning renderer and GPU time.
//
// Workspace terminals keep feeding PTY output into their xterm while hidden
// (writeWhileHidden), and inactive tabs and workspaces are hidden with
// visibility:hidden. xterm pauses its renderer only when an
// IntersectionObserver reports the screen off the viewport, which
// visibility:hidden never does, so every streaming agent in a background tab
// kept redrawing its WebGL canvas at full frame rate. The assertions count
// WebGL draw calls per pane and need no app internals.

// A spinner-like producer: rewrites one line every 20 ms and records its
// counter on disk so the test can prove output kept flowing while the pane
// that shows it was hidden.
const TICKER = String.raw`
const fs = require("node:fs");
const [label, counterFile] = process.argv.slice(2);
let n = 0;
setInterval(() => {
  n += 1;
  process.stdout.write("\r" + label + " " + n + "   ");
  fs.writeFileSync(counterFile, String(n));
}, 20);
`;

const SETTLE_MS = 600;
const WINDOW_MS = 2_000;

test("hidden terminal panes stop drawing until they are shown again", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[role="tab"][aria-selected="true"]').first()).toBeVisible();
    await installDrawCounter(page);

    const chatTabId = await activeTabId(page);
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => {
      (tab as HTMLElement).click();
    });
    await expect(page.locator("[data-terminal-pane-id]:visible .xterm-host")).toBeVisible({
      timeout: 15_000,
    });
    const firstTabId = await activeTabId(page);
    const first = await startTicker(page, fixture, "first");
    await expect
      .poll(() => readCounter(fixture, "first"), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const renderer = await page
      .locator(`[data-terminal-pane-id="${first}"] .xterm-screen canvas`)
      .evaluateAll((canvases) =>
        canvases.some((canvas) => (canvas as HTMLCanvasElement).getContext("webgl2") !== null),
      );
    test.skip(!renderer, "Electron started this run without a WebGL terminal renderer");

    await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
    await page.getByRole("button", { name: "Terminal" }).click();
    await expect
      .poll(() => visiblePaneId(page), { timeout: 15_000 })
      .not.toBe(first);
    const second = await startTicker(page, fixture, "second");
    await expect
      .poll(() => readCounter(fixture, "second"), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The first tab is now hidden while its ticker keeps streaming.
    const firstBefore = await readCounter(fixture, "first");
    const backgroundTab = await drawsDuring(page, [first, second]);
    expect(await readCounter(fixture, "first")).toBeGreaterThan(firstBefore + 20);
    expect(backgroundTab[second], "the visible ticker stopped drawing").toBeGreaterThan(10);
    expect(backgroundTab[first], "a pane in a hidden tab kept drawing").toBe(0);

    // Swap: the returning pane resumes drawing and the other one pauses.
    await page.locator(`[data-tab-id="${firstTabId}"]`).first().evaluate((tab) => {
      (tab as HTMLElement).click();
    });
    await expect.poll(() => visiblePaneId(page)).toBe(first);
    const swapped = await drawsDuring(page, [first, second]);
    expect(swapped[first], "the revealed pane did not resume drawing").toBeGreaterThan(10);
    expect(swapped[second], "a pane in a hidden tab kept drawing").toBe(0);

    // A non-terminal tab in front hides every terminal of the workspace.
    await page.locator(`[data-tab-id="${chatTabId}"]`).first().evaluate((tab) => {
      (tab as HTMLElement).click();
    });
    await expect.poll(() => visiblePaneId(page)).toBeNull();
    const behindChat = await drawsDuring(page, [first, second]);
    expect(behindChat[first], "a terminal behind the chat tab kept drawing").toBe(0);
    expect(behindChat[second], "a terminal behind the chat tab kept drawing").toBe(0);
  } finally {
    await app?.close();
  }
});

async function installDrawCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as { __paneDraws?: Record<string, number> };
    if (host.__paneDraws) return;
    const draws: Record<string, number> = {};
    host.__paneDraws = draws;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
      const original = proto[name];
      proto[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const canvas = this.canvas as HTMLCanvasElement;
        const paneId = canvas.closest("[data-terminal-pane-id]")?.getAttribute("data-terminal-pane-id");
        if (paneId) draws[paneId] = (draws[paneId] ?? 0) + 1;
        return original.apply(this, args);
      };
    }
  });
}

async function drawsDuring(page: Page, paneIds: string[]): Promise<Record<string, number>> {
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => {
    const draws = (window as unknown as { __paneDraws: Record<string, number> }).__paneDraws;
    for (const key of Object.keys(draws)) delete draws[key];
  });
  await page.waitForTimeout(WINDOW_MS);
  const draws = await page.evaluate(
    () => ({ ...(window as unknown as { __paneDraws: Record<string, number> }).__paneDraws }),
  );
  return Object.fromEntries(paneIds.map((id) => [id, draws[id] ?? 0]));
}

async function activeTabId(page: Page): Promise<string> {
  const id = await page.locator('[role="tab"][aria-selected="true"]').first().getAttribute("data-tab-id");
  expect(id, "expected an active tab").toBeTruthy();
  return id!;
}

async function visiblePaneId(page: Page): Promise<string | null> {
  const panes = page.locator("[data-terminal-pane-id]:visible");
  if ((await panes.count()) === 0) return null;
  return panes.first().getAttribute("data-terminal-pane-id");
}

async function startTicker(page: Page, fixture: Fixture, label: string): Promise<string> {
  const paneId = await visiblePaneId(page);
  expect(paneId, "expected a visible terminal pane").toBeTruthy();
  const input = page.locator(`[data-terminal-pane-id="${paneId}"] .xterm-helper-textarea`).first();
  await input.focus();
  await input.pressSequentially(
    `"${process.execPath}" "${fixture.ticker}" ${label} "${counterPath(fixture, label)}"`,
    { delay: 2 },
  );
  await input.press("Enter");
  return paneId!;
}

async function readCounter(fixture: Fixture, label: string): Promise<number> {
  try {
    return Number(await readFile(counterPath(fixture, label), "utf8")) || 0;
  } catch {
    return 0;
  }
}

function counterPath(fixture: Fixture, label: string): string {
  return join(fixture.root, `${label}.count`);
}

interface Fixture {
  root: string;
  userDataDir: string;
  ticker: string;
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "spark-hidden-render-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const ticker = join(root, "ticker.js");
  await writeFile(ticker, TICKER, "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-probe",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-probe",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, ticker };
}
