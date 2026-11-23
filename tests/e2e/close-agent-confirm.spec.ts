import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ctrl+W on a terminal tab whose agent is working asks first; Escape keeps the
// tab and the agent's process, Close stops both; a tab whose agent sits idle
// closes at once (DESIGN.md, "Closing a working agent"). The agent is a
// Claude Code stand-in that reports its state the way the real CLI does.
// CLOSE_CONFIRM_SHOTS=<dir> saves the dialog in dark and light there.

const FAKE_CLAUDE = String.raw`
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[2], String(process.pid));
  const status = (fields) => process.stdout.write("\x1b]7501;app=claude:" + fields + "\x07");
  process.stdout.write("\x1b[2J\x1b[HClaude Code v2.1.300\r\n> ");
  status("state=idle");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  setTimeout(() => process.exit(0), 170000);
  process.stdin.on("data", (data) => {
    if (data.includes("\x03")) process.exit(0);
    if (!data.includes("\r")) return;
    status("state=working");
    process.stdout.write("\r\n✻ Working on it… (2s · ↓ 10 tokens)");
  });
`;

const modKey = (key: string) => `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file: string): Promise<number> {
  let pid = 0;
  await expect.poll(async () => {
    pid = Number(await readFile(file, "utf8").catch(() => "0"));
    return pid;
  }, { timeout: 20_000 }).toBeGreaterThan(0);
  return pid;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.CLOSE_CONFIRM_SHOTS;
  const path = dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test("closing a working agent asks first; an idle one closes at once", async () => {
  test.skip(process.platform === "win32", "the fake agent is started from a POSIX shell");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-close-confirm-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const cwd = join(root, "project");
  await Promise.all([home, userHome, binDir, cwd].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: "ws-a", name: "project", cwd, workers: [] }], activeWorkspaceId: "ws-a" }),
    "utf8",
  );
  const script = join(binDir, "fake-claude.js");
  await writeFile(script, FAKE_CLAUDE, "utf8");
  const shell = join(binDir, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', "utf8");
  await chmod(shell, 0o755);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      USERPROFILE: userHome,
      SHELL: shell,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CODEX_HOME: join(userHome, ".codex"),
      GROK_HOME: join(userHome, ".grok"),
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  });
  const page = await app.firstWindow();
  try {
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1180, height: 760 });
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible({ timeout: 30_000 });
    const tabs = page.locator('[role="tab"][data-tab-id]');
    const dialog = page.getByRole("alertdialog");
    const input = page.locator(".spark-terminal-pane:visible .xterm-helper-textarea");

    // Opens a terminal tab and starts the stand-in in it.
    const startAgent = async (pidFile: string) => {
      const before = await tabs.count();
      await page.keyboard.press(modKey("t"));
      await expect(tabs).toHaveCount(before + 1, { timeout: 10_000 });
      await expect(async () => {
        await input.focus();
        await expect(input).toBeFocused({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await input.pressSequentially(`"${process.execPath}" "${script}" "${pidFile}"`, { delay: 2 });
      await input.press("Enter");
      await expect(page.locator(".spark-terminal-pane:visible").getByRole("status", { name: /^CLAUDE / })).toBeVisible({ timeout: 20_000 });
      return readPid(pidFile);
    };

    const idlePid = await startAgent(join(root, "idle.pid"));
    const workingPid = await startAgent(join(root, "working.pid"));
    await input.pressSequentially("go", { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: "CLAUDE working" })).toBeVisible({ timeout: 20_000 });

    // Ctrl+W asks, naming the agent and the tab, with Cancel focused.
    await page.keyboard.press(modKey("w"));
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/^Close Claude in .+\?$/);
    await expect(dialog).toContainText("It is still working and its work will stop.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shot(page, "close-confirm-dark");
    await page.evaluate(() => window.spark.preferences.set("theme", "codara-daylight"));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("codara-daylight");
    await shot(page, "close-confirm-light");
    await page.evaluate(() => window.spark.preferences.set("theme", "codara-classic"));

    // Escape keeps the tab and the agent.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(tabs).toHaveCount(2);
    await page.waitForTimeout(500);
    expect(alive(workingPid), "the working agent survives a cancelled close").toBe(true);
    await expect(page.getByRole("status", { name: "CLAUDE working" })).toBeVisible();

    // The tab's own close button asks the same; Cancel keeps it.
    await page.locator('[role="tab"][data-tab-id][aria-selected="true"]').getByRole("button", { name: "Close tab" }).click();
    await expect(dialog).toHaveAccessibleName(/^Close Claude in .+\?$/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tabs).toHaveCount(2);

    // Enter on the focused Close button closes the tab and stops the agent.
    await page.keyboard.press(modKey("w"));
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(tabs).toHaveCount(1);
    await expect.poll(() => alive(workingPid), { timeout: 15_000 }).toBe(false);

    // The idle agent's tab closes at once.
    expect(alive(idlePid)).toBe(true);
    await page.keyboard.press(modKey("w"));
    await expect(tabs).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => alive(idlePid), { timeout: 15_000 }).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
