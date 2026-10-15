import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the computer awake, end to end: the title-bar cup follows what main
// holds, the popover's modes work from the keyboard and persist, the lid
// option shows where main offers it, Settings has the same controls, and
// quitting releases every hold for good.
//
// Under the e2e flag main swaps the OS holds for records on
// globalThis.__codaraKeepAwake (src/main/keep-awake/index.ts), so this run
// never keeps the machine it runs on awake. CODARA_E2E_KEEP_AWAKE_LID=1 makes
// main offer the lid option as on a Linux laptop.

interface HoldRecord {
  active: boolean;
  starts: number;
  stops: number;
}

interface ProbeSnapshot {
  blocker: HoldRecord;
  lid: HoldRecord | null;
  holding: boolean | null;
}

type Activity = Partial<{ terminalAgents: number; chats: number; automations: number; workers: number }>;

async function probe(app: ElectronApplication): Promise<ProbeSnapshot> {
  return app.evaluate(() => {
    const keepAwake = (globalThis as Record<string, any>).__codaraKeepAwake;
    return {
      blocker: { ...keepAwake.blocker },
      lid: keepAwake.lid ? { ...keepAwake.lid } : null,
      holding: keepAwake.status()?.holding ?? null,
    };
  });
}

async function simulate(app: ElectronApplication, activity: Activity): Promise<void> {
  await app.evaluate((_electron, next) => {
    (globalThis as Record<string, any>).__codaraKeepAwake.simulate(next);
  }, activity);
}

async function savedPreferences(codaraHome: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(codaraHome, "spark-preferences.json"), "utf8"));
  } catch {
    return {};
  }
}

test("keep awake follows agent work, from the title bar and Settings, and ends with the app", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-keep-awake-"));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await prepareFixture(root);
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // The default is While agents work, and with nothing working nothing is held.
    const cup = page.locator(".keep-awake-button");
    await expect(cup).toBeVisible({ timeout: 15_000 });
    await expect(cup).toHaveAttribute("data-keep-awake-mode", "agents", { timeout: 10_000 });
    await expect(cup).toHaveAttribute("data-keep-awake-state", "idle");
    await expect(cup).toHaveAttribute("aria-label", /^Keep awake: while agents work\./);
    expect((await probe(app)).blocker.active).toBe(false);

    // It sits beside the system meters.
    const [meters, cupBox] = await Promise.all([page.locator(".system-meters-pill").boundingBox(), cup.boundingBox()]);
    expect(meters && cupBox).toBeTruthy();
    expect(cupBox!.x).toBeGreaterThanOrEqual(meters!.x + meters!.width);
    expect(cupBox!.x - (meters!.x + meters!.width)).toBeLessThan(16);

    // A terminal agent mid-turn takes the hold and lights the cup; when it
    // finishes the hold is released.
    await simulate(app, { terminalAgents: 1 });
    await expect(cup).toHaveAttribute("data-keep-awake-state", "holding");
    await expect(cup).toHaveAttribute("aria-label", "Keep awake: on. Keeping this computer awake: 1 terminal agent is working.");
    expect((await probe(app)).blocker).toMatchObject({ active: true, starts: 1 });
    await simulate(app, { chats: 1, workers: 2 });
    await expect(cup).toHaveAttribute("aria-label", /1 Cora chat and 2 workers are working\.$/);
    expect((await probe(app)).blocker.starts, "the hold is kept, not taken again").toBe(1);
    await simulate(app, {});
    await expect(cup).toHaveAttribute("data-keep-awake-state", "idle");
    expect((await probe(app)).blocker).toMatchObject({ active: false, stops: 1 });

    // The popover: focus lands on the checked mode and the arrow keys choose.
    await cup.focus();
    await page.keyboard.press("Enter");
    const popover = page.getByRole("dialog", { name: "Keep the computer awake" });
    await expect(popover).toBeVisible();
    await expect(popover.locator(".keep-awake-popover__chip")).toHaveText("Not holding");
    const modeRadio = (name: string) => popover.getByRole("radio", { name: new RegExp(`^${name}`) });
    await expect(modeRadio("While agents work")).toBeFocused();
    await expect(modeRadio("While agents work")).toHaveAttribute("aria-checked", "true");

    await page.keyboard.press("ArrowDown");
    await expect(modeRadio("Always")).toBeFocused();
    await expect(modeRadio("Always")).toHaveAttribute("aria-checked", "true");
    await expect(cup).toHaveAttribute("data-keep-awake-state", "holding");
    await expect(popover.locator(".keep-awake-popover__chip")).toHaveText("Holding");
    await expect.poll(async () => (await probe(app!)).blocker.active).toBe(true);
    await expect.poll(async () => (await savedPreferences(fixture.codaraHome)).keepAwakeMode).toBe("always");

    await page.keyboard.press("Home");
    await expect(modeRadio("Off")).toHaveAttribute("aria-checked", "true");
    await expect(cup).toHaveAttribute("data-keep-awake-state", "off");
    await expect.poll(async () => (await probe(app!)).blocker.active).toBe(false);
    // Off ignores work.
    await simulate(app, { automations: 1 });
    expect((await probe(app)).blocker.active).toBe(false);
    await simulate(app, {});

    // The lid option, offered here as on a Linux laptop, holds only while
    // the computer is held awake.
    const lidSwitch = popover.getByRole("switch", { name: /Also with the lid closed/ });
    await expect(lidSwitch).toHaveAttribute("aria-checked", "false");
    await lidSwitch.click();
    await expect(lidSwitch).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await savedPreferences(fixture.codaraHome)).keepAwakeLidClosed).toBe(true);
    expect((await probe(app)).lid?.active, "no lid hold while Off").toBe(false);
    await modeRadio("Always").click();
    await expect.poll(async () => (await probe(app!)).lid?.active).toBe(true);

    // Escape closes and gives focus back to the cup.
    await modeRadio("Always").focus();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(cup).toBeFocused();

    // Settings, General, Sleep: the same mode and lid choice.
    await cup.click();
    await popover.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(popover).toHaveCount(0);
    const settings = page.getByRole("dialog", { name: "Settings" });
    const sleep = await settingsSleep(page);
    await expect(settings.locator(".st-topbar__title")).toHaveText("General");
    await expect(sleep.getByRole("button", { name: "Always", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(sleep.locator("[data-keep-awake-settings-status]")).toHaveAttribute(
      "data-keep-awake-settings-status",
      "holding",
    );
    await expect(sleep).toContainText("Keeping this computer awake while Codara is open.");
    const lidRow = settings.getByRole("switch", { name: "Keep awake with the lid closed" });
    await expect(lidRow).toHaveAttribute("aria-checked", "true");
    await sleep.getByRole("button", { name: "While agents work", exact: true }).click();
    await expect(cup).toHaveAttribute("data-keep-awake-mode", "agents");
    await expect(cup).toHaveAttribute("data-keep-awake-state", "idle");
    await expect.poll(async () => (await probe(app!)).blocker.active).toBe(false);
    await expect.poll(async () => (await probe(app!)).lid?.active).toBe(false);
    await lidRow.click();
    await expect(lidRow).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // Quitting releases every hold, and nothing takes one again after.
    await simulate(app, { terminalAgents: 2 });
    expect((await probe(app)).blocker.active).toBe(true);
    const afterQuit = await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("will-quit", { preventDefault() {} });
      const keepAwake = (globalThis as Record<string, any>).__codaraKeepAwake;
      keepAwake.simulate({ terminalAgents: 2, chats: 1 });
      return { blocker: { ...keepAwake.blocker }, holding: keepAwake.status()?.holding ?? null };
    });
    expect(afterQuit.blocker.active).toBe(false);
    expect(afterQuit.holding).toBe(false);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the lid option is hidden where it cannot work", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "codara-keep-awake-nolid-"));
  let app: ElectronApplication | null = null;
  try {
    app = await launch(await prepareFixture(root), { lid: false });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const cup = page.locator(".keep-awake-button");
    await expect(cup).toHaveAttribute("data-keep-awake-mode", "agents", { timeout: 15_000 });
    await cup.click();
    const popover = page.getByRole("dialog", { name: "Keep the computer awake" });
    await expect(popover.getByRole("radio")).toHaveCount(3);
    await expect(popover.getByRole("switch")).toHaveCount(0);
    await popover.getByRole("button", { name: "Settings", exact: true }).click();
    const sleep = await settingsSleep(page);
    await expect(sleep.getByRole("button", { name: "While agents work", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("switch", { name: "Keep awake with the lid closed" })).toHaveCount(0);
    expect((await probe(app)).lid).toBeNull();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function settingsSleep(page: Page) {
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const sleep = settings.locator('[data-setting-anchor="Sleep"]');
  await sleep.scrollIntoViewIfNeeded();
  await expect(sleep).toBeVisible();
  return sleep;
}

interface Fixture {
  userHome: string;
  codaraHome: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

async function prepareFixture(root: string): Promise<Fixture> {
  const fixture: Fixture = {
    userHome: join(root, "home"),
    codaraHome: join(root, "codara-home"),
    claudeConfigDir: join(root, "claude-home"),
    codexHomeDir: join(root, "codex-home"),
    grokHomeDir: join(root, "grok-home"),
  };
  const workspaceDir = join(root, "workspace");
  await Promise.all(
    [...Object.values(fixture), workspaceDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(fixture.userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-awake", name: "awake", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-awake",
      }),
      "utf8",
    ),
  ]);
  return fixture;
}

async function launch(fixture: Fixture, options: { lid?: boolean } = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: fixture.userHome,
      ZDOTDIR: fixture.userHome,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
      GROK_HOME: fixture.grokHomeDir,
      CODARA_E2E_KEEP_AWAKE_LID: options.lid === false ? "0" : "1",
    },
  });
}
