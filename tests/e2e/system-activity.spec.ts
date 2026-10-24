import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The System activity popover: pressing a title-bar meter shows what uses
// that resource, one row per Codara pane with everything running under it,
// then Codara itself and other apps. A busy script runs in a terminal pane;
// its pane's row must carry the script's memory and CPU, list the script
// when expanded, and take the keyboard to the pane when clicked.
//
// CODARA_SHOTS_DIR=<dir> also saves the open popover in the dark and light
// themes, for reviewing the design.

const SHOTS = process.env.CODARA_SHOTS_DIR ?? "";
// Screenshots wait for the title bar to gather most of a minute of history,
// so the charts are drawn as a user who opens the popover later sees them.
const SHOT_HISTORY_MS = 45_000;

// Holds ~200 MB and keeps one core busy, under a name the popover can show.
const BURNER = String.raw`
const hold = Buffer.alloc(200 * 1024 * 1024, 1);
setInterval(() => {
  const until = Date.now() + 80;
  let x = 0;
  while (Date.now() < until) x += hold[x % hold.length];
}, 100);
`;

interface Fixture {
  root: string;
  userDataDir: string;
  burner: string;
}

async function prepareFixture(theme: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "spark-system-activity-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const burner = join(root, "lint-burner.js");
  await writeFile(burner, BURNER, "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-probe", name: "probe-workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
      activeWorkspaceId: "ws-probe",
    }),
    "utf8",
  );
  await writeFile(join(userDataDir, "spark-preferences.json"), JSON.stringify({ theme, glassEffects: true }), "utf8");
  return { root, userDataDir, burner };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function startBurner(page: Page, fixture: Fixture): Promise<string> {
  await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
  const pane = page.locator("[data-terminal-pane-id]:visible").first();
  await expect(pane.locator(".xterm-host")).toBeVisible({ timeout: 15_000 });
  const paneId = await pane.getAttribute("data-terminal-pane-id");
  expect(paneId, "expected a visible terminal pane").toBeTruthy();
  const input = pane.locator(".xterm-helper-textarea").first();
  await input.focus();
  await input.pressSequentially(`"${process.execPath}" "${fixture.burner}"`, { delay: 2 });
  await input.press("Enter");
  return paneId!;
}

const meter = (page: Page, metric: "cpu" | "gpu" | "ram" | "swap") =>
  page.locator(`.system-meter-mini[data-metric="${metric}"]`);

async function openPopover(page: Page, metric: "cpu" | "gpu" | "ram" | "swap") {
  await meter(page, metric).click();
  const popover = page.getByRole("dialog", { name: "System activity" });
  await expect(popover).toBeVisible();
  return popover;
}

/** "225 MB" or "1.2 GB" in bytes; "80%" as 80. */
function figure(text: string | null): number {
  const match = /([\d.]+)\s*(%|B|KB|MB|GB|TB)/.exec(text ?? "");
  if (!match) return NaN;
  const scale = { "%": 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2]] ?? NaN;
  return Number(match[1]) * scale;
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const popover = page.getByRole("dialog", { name: "System activity" });
  const box = await popover.boundingBox();
  if (!box) return;
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    clip: { x: Math.max(0, box.x - 24), y: 0, width: Math.min(box.width + 36, 1600), height: box.y + box.height + 14 },
  });
}

test("pressing a meter lists what each pane uses and jumps there", async () => {
  test.setTimeout(SHOTS ? 180_000 : 120_000);
  const fixture = await prepareFixture("codara-classic");
  const app = await launch(fixture);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    await expect(meter(page, "ram")).toBeVisible({ timeout: 15_000 });
    const paneId = await startBurner(page, fixture);
    if (SHOTS) await page.waitForTimeout(SHOT_HISTORY_MS);

    // RAM: the burner's pane holds its ~200 MB, summed with its shell.
    const popover = await openPopover(page, "ram");
    await expect(popover.getByRole("tab", { name: /RAM/ })).toHaveAttribute("aria-selected", "true");
    await expect(meter(page, "ram")).toHaveAttribute("aria-expanded", "true");
    const row = popover.locator('.sa-row[data-owner="pane"]', { hasText: "probe-workspace" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".sa-row__name")).toHaveText("terminals");
    await expect.poll(async () => figure(await row.locator(".sa-row__value").textContent()), { timeout: 10_000 }).toBeGreaterThan(190 * 1024 ** 2);
    await expect(popover.locator('.sa-row[data-owner="codara"]')).toBeVisible();
    await expect(popover.locator('.sa-row[data-owner="outside"] .sa-row__name')).toHaveText("Other apps");

    // Expanding the row lists what runs in it; nothing else opens.
    await row.getByRole("button", { name: /Show what runs in/ }).click();
    await expect(row.locator(".sa-row__detail")).toContainText("lint-burner");

    // Live: the total's chart takes a new reading every second.
    const line = popover.locator(".sa-chart svg path").nth(1);
    const first = await line.getAttribute("d");
    await expect.poll(() => line.getAttribute("d"), { timeout: 6_000 }).not.toBe(first);
    await page.waitForTimeout(SHOTS ? 2_500 : 0);
    await shoot(page, "dark");

    // CPU, as top counts it: the burner keeps most of one core busy.
    await popover.getByRole("tab", { name: /CPU/ }).click();
    await expect(popover.getByRole("tab", { name: /CPU/ })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => figure(await row.locator(".sa-row__value").textContent()), { timeout: 10_000 }).toBeGreaterThan(40);
    await shoot(page, "dark-cpu");

    // Another meter switches the breakdown in place.
    await meter(page, "gpu").click();
    await expect(popover.getByRole("tab", { name: /GPU/ })).toHaveAttribute("aria-selected", "true");

    // Clicking the row closes the popover and puts the keyboard in the pane.
    await popover.getByRole("tab", { name: /RAM/ }).click();
    await row.getByRole("button", { name: /^Go to terminals in probe-workspace/ }).click();
    await expect(popover).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest("[data-terminal-pane-id]")?.getAttribute("data-terminal-pane-id") ?? null),
      )
      .toBe(paneId);

    // Escape closes it too, and focus returns to the meter that opened it.
    await openPopover(page, "cpu");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "System activity" })).toBeHidden();
    await expect(meter(page, "cpu")).toBeFocused();

    // Memory running out (this machine was once OOM-killed by a 25 GB lint
    // run) turns the RAM meter red and the popover says so. Main's figures
    // are real; only the level and what is left are forced. NOTE:
    // `_invokeHandlers` is an Electron internal, as in
    // model-effort-shortcuts.spec.ts.
    const hooked = await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get("system:resourceSnapshot");
      if (!original) return false;
      handlers.set("system:resourceSnapshot", async (...args: unknown[]) => {
        const snapshot = (await original(...args)) as Record<string, number | string>;
        return {
          ...snapshot,
          memoryLevel: "critical",
          ramAvailableBytes: Math.round(Number(snapshot.ramTotalBytes) * 0.03),
          swapOutBytesPerSecond: 48 * 1024 * 1024,
        };
      });
      return true;
    });
    expect(hooked, "the system:resourceSnapshot handler must be replaceable").toBe(true);
    await expect(page.locator('.system-meters-pill[data-memory-level="critical"]')).toBeVisible({ timeout: 6_000 });
    const warned = await openPopover(page, "cpu");
    const warning = warned.getByRole("status").filter({ hasText: "Memory almost full" });
    await expect(warning).toBeVisible({ timeout: 6_000 });
    await expect(warning).toContainText("available, swapping 48.0 MB/s");
    await warning.getByRole("button", { name: "Show RAM" }).click();
    await expect(warned.getByRole("tab", { name: /RAM/ })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(SHOTS ? 1_500 : 0);
    await shoot(page, "warning-dark");
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("light theme screenshot", async () => {
  test.skip(!SHOTS, "set CODARA_SHOTS_DIR to capture the light theme");
  test.setTimeout(150_000);
  const fixture = await prepareFixture("codara-daylight");
  const app = await launch(fixture);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    await expect(meter(page, "cpu")).toBeVisible({ timeout: 15_000 });
    await startBurner(page, fixture);
    await page.waitForTimeout(SHOT_HISTORY_MS);
    const popover = await openPopover(page, "cpu");
    const row = popover.locator('.sa-row[data-owner="pane"]', { hasText: "probe-workspace" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: /Show what runs in/ }).click();
    await page.waitForTimeout(3_000);
    await shoot(page, "light");
  } finally {
    await app.close();
  }
});
