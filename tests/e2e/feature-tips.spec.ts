import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_CATALOG } from "../../src/shared/feature-tips";

// Feature tips as a person meets them. Under the e2e runner tips never show
// on their own; these specs opt in with CODARA_E2E_FEATURE_TIPS=1, which also
// shortens the waits (a second to settle, 1.2 s without a key press).
//
// - without the opt-in, usage is still tracked and no tip ever appears
// - a tip waits while you type or move the pointer and until its control is
//   on screen, steps aside for a dialog, and its tour points at the real
//   control, which then works as usual and ends the tour
// - a tip never covers the composer; Escape closes it; Settings brings shown
//   tips back and turns tips on again after "Don't show tips"

interface Fixture {
  root: string;
  home: string;
  codaraHome: string;
}

const TIP = ".onboarding-coach.feature-tip";
const TOUR = ".onboarding-coach.feature-tour";

test("tips never appear in a test run that did not ask, and usage is still tracked", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture, false);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });

    const boot = await page.evaluate(() => (window as any).spark.featureTips.load());
    expect(boot.autoTips).toBe(false);

    // Every catalog selector parses in the real DOM.
    const selectors = FEATURE_CATALOG.flatMap((entry) => [
      ...(entry.signals.clicks ?? []),
      ...(entry.signals.visible ?? []),
      ...(entry.tip?.when ? [entry.tip.when] : []),
      ...(entry.tip?.tour ?? []).map((step) => step.target),
    ]);
    const invalid = await page.evaluate((list) => {
      return list.filter((selector) => {
        try {
          document.querySelector(selector);
          return false;
        } catch {
          return true;
        }
      });
    }, selectors);
    expect(invalid).toEqual([]);

    // A click on the bell counts as using the notification center.
    await page.locator("button.nc-bell").click();
    await expect(page.locator(".nc-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await readState(fixture))?.used?.["notification-center"]).toBeGreaterThan(0);

    await openTerminalTab(page);
    await page.waitForTimeout(3_000);
    await expect(page.locator(TIP)).toHaveCount(0);
    await expect(page.locator(TOUR)).toHaveCount(0);

    // Before any tip, the row a Settings search lands on is there, greyed out.
    const settings = await openSettings(page);
    await expect(settings.getByRole("button", { name: "Show them again" })).toBeDisabled();
    await expect(settings.getByRole("switch", { name: "Feature tips" })).toHaveAttribute("aria-checked", "true");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a tip waits for a calm moment and its tour points at the real control", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture({ unusedOnly: "split-panes" });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture, true);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1360, height: 860 });
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });
    const isMac = await page.evaluate(() => /^Mac/i.test(navigator.platform));
    const tip = page.locator(TIP);

    // The split control is not on screen in the chat view: no tip.
    await page.waitForTimeout(2_500);
    await expect(tip).toHaveCount(0);

    // Typing in a terminal holds the tip back; it comes once typing stops.
    await openTerminalTab(page);
    const pane = page.locator(".spark-terminal-pane:visible").first();
    await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.type("x");
      await page.waitForTimeout(110);
    }
    await expect(tip).toHaveCount(0);
    // A pointer on the move holds it back as well, long after the last key.
    const paneBox = (await pane.boundingBox())!;
    for (let i = 0; i < 24; i += 1) {
      await page.mouse.move(paneBox.x + 40 + (i % 2) * 30, paneBox.y + paneBox.height / 2);
      await page.waitForTimeout(110);
    }
    await expect(tip).toHaveCount(0);
    await expect(tip).toBeVisible({ timeout: 6_000 });
    await expect(tip).toContainText("Run things side by side");
    await expect(tip).toContainText(isMac ? "⌘D" : "Ctrl+D");
    await expect(tip).toHaveAttribute("aria-label", "Tip: Run things side by side");
    await expectInsideWindow(page, tip);
    await expect.poll(async () => (await readState(fixture))?.tips?.["split-panes"]?.outcome).toBe("shown");

    // A dialog takes the tip off screen until it closes.
    await page.getByTitle("Settings").first().click({ force: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(tip).toBeHidden();
    await expect(settings.getByRole("switch", { name: "Feature tips" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(tip).toBeVisible();

    // Show me: the coach stands beside the real split button, which stays in
    // view while the tour lasts.
    await tip.getByRole("button", { name: "Show me" }).click();
    await expect(tip).toHaveCount(0);
    const tour = page.locator(TOUR);
    await expect(tour).toBeVisible();
    await expect(tour).toHaveAttribute("aria-label", "Split terminal panes tour");
    await expect(tour.getByRole("heading", { name: "Split a pane" })).toBeVisible();
    await expect(tour.getByRole("button", { name: "Done" })).toBeFocused();
    const target = page.locator('.spark-terminal-pane:visible button[title^="Split right"]').first();
    await expect(target).toHaveAttribute("data-feature-tour-target", "");
    await expect
      .poll(() => target.evaluate((element) => getComputedStyle(element.closest(".spark-pane-toolbar")!).opacity))
      .toBe("1");
    await expect(page.locator(".feature-tour__ring")).toBeVisible();
    const [coachBox, targetBox] = await Promise.all([tour.boundingBox(), target.boundingBox()]);
    expect(overlaps(coachBox!, targetBox!)).toBe(false);
    await expect.poll(async () => (await readState(fixture))?.tips?.["split-panes"]?.outcome).toBe("toured");

    // The control does what it always does, and the tour ends.
    const panes = page.locator(".spark-terminal-pane:visible");
    await expect(panes).toHaveCount(1);
    await target.click();
    await expect(panes).toHaveCount(2);
    await expect(tour).toHaveCount(0);
    await expect(page.locator("[data-feature-tour-target]")).toHaveCount(0);
    await expect.poll(async () => (await readState(fixture))?.used?.["split-panes"]).toBeGreaterThan(0);

    // One tip per session: nothing else follows.
    await page.waitForTimeout(2_500);
    await expect(tip).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a tip stays clear of the composer, and Settings controls whether tips show", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture({ unusedOnly: "usage-panel" });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture, true);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Narrow, with the right sidebar closed: the composer spans the bottom
    // of the window, where a tip would otherwise go.
    await page.setViewportSize({ width: 900, height: 700 });
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });
    await page.getByTitle("Toggle right sidebar").click();
    const composer = page.locator(".composer-shell:visible").first();
    await expect(composer).toBeVisible();
    const tip = page.locator(TIP);

    await expect(tip).toBeVisible({ timeout: 8_000 });
    await expect(tip).toContainText("See how much of your plan is left");
    await expectInsideWindow(page, tip);
    const [tipBox, composerBox] = await Promise.all([tip.boundingBox(), composer.boundingBox()]);
    expect(overlaps(tipBox!, composerBox!)).toBe(false);

    // Escape inside the tip closes it for good.
    await tip.getByRole("button", { name: "Got it" }).focus();
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await expect.poll(async () => (await readState(fixture))?.tips?.["usage-panel"]?.outcome).toBe("dismissed");

    // Settings lets shown tips come back.
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Show them again" }).click();
    await expect.poll(async () => Object.keys((await readState(fixture))?.tips ?? { x: 1 }).length).toBe(0);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // A new session offers it again; Don't show tips turns tips off.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".spark-tabbar")).toBeVisible({ timeout: 30_000 });
    await expect(tip).toBeVisible({ timeout: 8_000 });
    await tip.getByRole("button", { name: "Don't show tips" }).click();
    await expect(tip).toHaveCount(0);
    await expect(page.getByText("Tips are off", { exact: true })).toBeVisible();
    await expect.poll(async () => (await readState(fixture))?.enabled).toBe(false);

    const again = await openSettings(page);
    const toggle = again.getByRole("switch", { name: "Feature tips" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await readState(fixture))?.enabled).toBe(true);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function expectInsideWindow(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
}

async function openTerminalTab(page: Page): Promise<void> {
  const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
  await expect(terminalTab).toBeAttached();
  await terminalTab.click();
  await expect(terminalTab).toHaveClass(/spark-tab--active/);
  await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function readState(fixture: Fixture): Promise<any> {
  try {
    return JSON.parse(await readFile(join(fixture.codaraHome, "feature-tips.json"), "utf8"));
  } catch {
    return null;
  }
}

async function prepareFixture(options: { unusedOnly?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-feature-tips-"));
  const fixture: Fixture = { root, home: join(root, "home"), codaraHome: join(root, "codara-home") };
  const workspace = join(root, "workspace");
  await Promise.all([fixture.home, fixture.codaraHome, workspace].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(fixture.home, ".zshrc"), "PS1='%~ %# '\n", "utf8");
  await writeFile(
    join(fixture.codaraHome, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-tips", name: "tips", cwd: workspace, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-tips",
    }),
    "utf8",
  );
  if (options.unusedOnly) {
    // Every feature but one is already used, so exactly one tip can come.
    const used = Object.fromEntries(
      FEATURE_CATALOG.filter((entry) => entry.id !== options.unusedOnly).map((entry) => [entry.id, 1]),
    );
    await writeFile(
      join(fixture.codaraHome, "feature-tips.json"),
      JSON.stringify({ version: 1, enabled: true, used, tips: {}, lastTipAt: null }),
      "utf8",
    );
  }
  return fixture;
}

async function launch(fixture: Fixture, tips: boolean): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    ZDOTDIR: fixture.home,
    SPARK_USER_DATA_DIR: fixture.codaraHome,
    CODARA_HOME_DIR: fixture.codaraHome,
    SPARK_HOME_DIR: fixture.codaraHome,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
    CODARA_DISABLE_KEYCHAIN: "1",
  };
  if (tips) env.CODARA_E2E_FEATURE_TIPS = "1";
  else delete env.CODARA_E2E_FEATURE_TIPS;
  return electron.launch({ args: ["."], env });
}
