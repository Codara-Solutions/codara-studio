import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agent CLI updates in the UI: the worker picker's mark and Update button,
// Settings › Accounts › Agent tools, the automatic-update switch and Pi's
// pinned version. The service is the real one on scripted tools
// (CODARA_FAKE_AGENT_CLI_UPDATES=1, src/main/agent-cli-updates/fake.ts): no
// network and no real CLI. SPARK_AGENT_CLI_SHOTS=<dir> saves each state at
// the minimum and the default width, in a light and a dark theme.

type FakeControls = {
  tools: Record<string, { version: string | null; realPath: string }>;
  latest: Record<string, string>;
  live: Record<string, number>;
  failNext: string[];
  hold: boolean;
  release: () => void;
};

const WIDTHS = [720, 1280] as const;

for (const theme of ["codara-daylight", "codara-classic"] as const) {
  test(`agent tools show updates, update, roll back and keep Pi pinned (${theme})`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "codara-agent-cli-updates-"));
    const userDataDir = join(root, "user-data");
    const workspaceDir = join(root, "workspace");
    await mkdir(userDataDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(userDataDir, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-e2e", name: "workspace", cwd: workspaceDir, color: "#2AA298", workers: [] }],
        activeWorkspaceId: "ws-e2e",
      }),
      "utf8",
    );
    // The switch starts off so each state holds still for its picture.
    await writeFile(join(userDataDir, "spark-preferences.json"), JSON.stringify({ theme, agentCliAutoUpdate: false }), "utf8");
    const shots = process.env.SPARK_AGENT_CLI_SHOTS || testInfo.outputPath("shots");
    await mkdir(shots, { recursive: true });

    let app: ElectronApplication | null = null;
    try {
      app = await electron.launch({
        args: ["."],
        env: {
          ...process.env,
          SPARK_USER_DATA_DIR: userDataDir,
          CODARA_HOME_DIR: userDataDir,
          SPARK_HOME_DIR: userDataDir,
          SPARK_SKIP_LEGACY_MIGRATION: "1",
          SPARK_NO_SHELL_INTEGRATION: "1",
          CODARA_FAKE_AGENT_CLI_UPDATES: "1",
        },
      });
      const electronApp = app;
      const fake = <T,>(fn: (controls: FakeControls) => T) =>
        electronApp.evaluate((_electron, source) => {
          const controls = (globalThis as unknown as { __codaraAgentCliFake: FakeControls }).__codaraAgentCliFake;
          return new Function("controls", `return (${source})(controls)`)(controls) as T;
        }, fn.toString());
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.waitForLoadState("domcontentloaded");
      await expect.poll(() => fake((c) => Boolean(c)), { timeout: 20_000 }).toBe(true);

      await page.getByTitle("Settings").first().click({ force: true });
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      await dialog.locator("nav").getByRole("button", { name: "Accounts", exact: true }).click();
      const section = dialog.locator('section[data-setting-anchor="Agent tools"]');
      await section.scrollIntoViewIfNeeded();
      const row = (label: string) => section.locator(`[data-setting-anchor="${label}"]`);

      // 1. Up to date, Pi pinned.
      await expect(row("Claude Code")).toContainText("v2.1.327 · native installer");
      await expect(row("Claude Code")).toContainText("Up to date.");
      await expect(row("Pi")).toContainText("v1.5.2 · pinned to 1.5.2");
      await expect(row("Pi")).toContainText("never updates it");
      await expect(row("Pi").getByRole("button")).toHaveCount(0);
      await expect(section.getByRole("switch", { name: "Update automatically" })).not.toBeChecked();
      await capture(page, section, shots, theme, "1-up-to-date");

      // 2. Newer versions: Claude can be updated here, Grok (Homebrew) shows its command.
      await fake((c) => {
        c.latest.claude = "2.1.328";
        c.tools.grok = { version: "1.0.46", realPath: "/home/linuxbrew/.linuxbrew/Cellar/grok/1.0.46/bin/grok" };
      });
      await section.getByRole("button", { name: "Check now" }).click();
      await expect(row("Claude Code")).toContainText("Version 2.1.328 is out.");
      await expect(row("Claude Code").getByText("Update available")).toBeVisible();
      await expect(row("Grok")).toContainText("Installed with Homebrew; update it with:");
      await expect(row("Grok")).toContainText("brew upgrade grok");
      await expect(row("Grok").getByRole("button")).toHaveCount(0);
      await capture(page, section, shots, theme, "2-update-available");
      await capturePicker(page, shots, theme, "2-update-available");

      // 3. Updating: the update is held mid-way.
      await fake((c) => {
        c.hold = true;
        c.failNext = ["claude"];
      });
      await row("Claude Code").getByRole("button", { name: "Update" }).click();
      await expect(row("Claude Code")).toContainText("Updating…");
      await expect(row("Claude Code")).toContainText("Updating to 2.1.328");
      await capture(page, section, shots, theme, "3-updating");
      await capturePicker(page, shots, theme, "3-updating");

      // 4. The new build fails its version check: 2.1.327 is put back.
      await fake((c) => {
        c.hold = false;
        c.release();
      });
      await expect(row("Claude Code")).toContainText("Claude Code 2.1.328 failed its version check, so Codara put 2.1.327 back.");
      await expect(row("Claude Code")).toContainText("v2.1.327");
      await expect(row("Claude Code").getByRole("button", { name: "Try again" })).toBeVisible();
      expect(await fake((c) => c.tools.claude.version)).toBe("2.1.327");
      await capture(page, section, shots, theme, "4-rolled-back");
      await capturePicker(page, shots, theme, "4-rolled-back");

      // 5. The switch on, a Codex session running: Codex waits, Grok is never run.
      await fake((c) => {
        c.latest.codex = "0.171.0";
        c.live.codex = 2;
      });
      await section.getByRole("button", { name: "Check now" }).click();
      await expect(row("Codex")).toContainText("Version 0.171.0 is out.");
      await section.getByRole("switch", { name: "Update automatically" }).click();
      await expect(row("Codex")).toContainText("Waiting: 2 Codex sessions are running. It updates once they end.");
      await expect(row("Codex").getByRole("button", { name: "Cancel" })).toBeVisible();
      expect(await fake((c) => c.tools.grok.version)).toBe("1.0.46");
      await capture(page, section, shots, theme, "5-waiting");
    } finally {
      await app?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

async function capture(page: Page, section: ReturnType<Page["locator"]>, dir: string, theme: string, name: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 860 });
    // Top of the section at the top of the page, clear of the sticky header.
    await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await section.screenshot({ path: join(dir, `${name}-settings-${width}-${theme}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}

// The new-tab picker's Workers list, with its marks. Settings closes first so
// the picker is reachable, then reopens on the same page.
async function capturePicker(page: Page, dir: string, theme: string, name: string) {
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 860 });
    await page.getByRole("button", { name: "New tab" }).first().click();
    const picker = page.locator(".spark-tabbar-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByTestId("agent-cli-mark-pi")).toHaveText("Pinned 1.5.2");
    await picker.screenshot({ path: join(dir, `${name}-picker-${width}-${theme}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "New tab" }).first().click();
    await expect(picker).toBeHidden();
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByTitle("Settings").first().click({ force: true });
  await expect(dialog).toBeVisible();
  await dialog.locator("nav").getByRole("button", { name: "Accounts", exact: true }).click();
  await dialog.locator('section[data-setting-anchor="Agent tools"]').scrollIntoViewIfNeeded();
}
