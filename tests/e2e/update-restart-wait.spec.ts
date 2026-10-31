import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// "Restart and install" while a terminal agent is in the middle of a turn
// waits for it instead of cutting it off (src/main/quit-guard.ts).
//
// A fake Codex repaints its working footer like the real one until it is
// sent "d". The update itself is faked by sending the downloaded event to the
// chip; in a dev build the install step only records why it would restart
// (globalThis.__codaraUpdateRestarts in main), so nothing quits.

const FAKE_CODEX = String.raw`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.154.0"); process.exit(0); }
let working = true;
let seconds = 1;
const paint = () => process.stdout.write(
  "\x1b[2J\x1b[HOpenAI Codex (v0.154.0)\r\n\r\n" +
  (working ? "• Working (" + seconds + "s • esc to interrupt)\r\n" : "• Wrote 3 files.\r\n") +
  "\r\n› Ask Codex to do anything\r\ngpt-6-astra high · ~/workspace");
paint();
setInterval(() => { if (working) { seconds += 1; paint(); } }, 500);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (data.includes(100)) { working = false; paint(); }
});
`;

test("an update restart waits for a working terminal agent", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(120_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially("codex", { delay: 2 });
    await input.press("Enter");
    await expect(page.locator('[data-workspace-id="ws-wait"]').getByTestId("workspace-agent-count"))
      .toHaveAttribute("data-working", "true", { timeout: 20_000 });
    // The rail counts an agent from the moment it starts; the restart gate
    // only sees it once main has read its working footer. Keep awake reports
    // main's view, so waiting for it closes that gap.
    await expect(page.getByRole("button", { name: /1 terminal agent is working/ })).toBeVisible({ timeout: 20_000 });

    await offerUpdate(app, page, "9.9.9");
    const chip = page.getByRole("button", { name: /Update v9\.9\.9 is ready/ });
    await chip.click();
    const wait = page.getByTestId("update-restart-wait");
    await expect(wait).toBeVisible({ timeout: 5_000 });
    await expect(wait.getByRole("list", { name: "Still working" })).toContainText("Codex in Wait");
    await expect(page.getByRole("button", { name: /restarts when agents finish/ })).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(await restarts(app)).toEqual([]);

    // Keyboard: the wait's buttons are reachable and Escape closes it.
    await wait.getByRole("button", { name: "Don't restart yet" }).focus();
    await page.keyboard.press("Enter");
    await expect(wait).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Update v9\.9\.9 is ready/ })).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(await restarts(app)).toEqual([]);

    // Restart now does not wait.
    await page.getByRole("button", { name: /Update v9\.9\.9 is ready/ }).click();
    await expect(wait).toBeVisible({ timeout: 5_000 });
    await wait.getByRole("button", { name: "Restart now" }).click();
    await expect.poll(() => restarts(app!), { timeout: 5_000 }).toEqual(["forced"]);
    await expect(page.getByRole("button", { name: /Restarting into v9\.9\.9/ })).toBeVisible();

    // A fresh offer, then the agent finishes: the restart starts by itself.
    await offerUpdate(app, page, "9.9.10");
    await page.getByRole("button", { name: /Update v9\.9\.10 is ready/ }).click();
    await expect(wait).toBeVisible({ timeout: 5_000 });
    await page.locator(".xterm-helper-textarea:visible").first().press("d");
    await expect.poll(() => restarts(app!), { timeout: 30_000 }).toEqual(["forced", "idle"]);
  } finally {
    await app?.close();
  }
});

test("an update restart with nothing working starts at once", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(60_000);
  const fixture = await prepare();
  const app = await electron.launch({ args: ["."], env: fixture.env });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await offerUpdate(app, page, "9.9.9");
    await page.getByRole("button", { name: /Update v9\.9\.9 is ready/ }).click();
    await expect.poll(() => restarts(app), { timeout: 5_000 }).toEqual(["idle"]);
    await expect(page.getByTestId("update-restart-wait")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// The chip subscribes once the status bar mounts, so an event sent earlier is
// lost: send it until the chip shows the version.
async function offerUpdate(app: ElectronApplication, page: Page, version: string): Promise<void> {
  const chip = page.getByRole("button", { name: `Update v${version} is ready. Click to restart into it.` });
  await expect(async () => {
    await app.evaluate(({ BrowserWindow }, v) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("updater:event", { kind: "update-downloaded", payload: { version: v } });
      }
    }, version);
    await expect(chip).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

function restarts(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [...((globalThis as { __codaraUpdateRestarts?: string[] }).__codaraUpdateRestarts ?? [])]);
}

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "codara-update-wait-e2e-"));
  const userData = join(root, "app");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  await Promise.all([userData, workspace, bin].map((dir) => mkdir(dir, { recursive: true })));
  const script = join(bin, "codex.js");
  await writeFile(script, FAKE_CODEX);
  const wrapper = join(bin, "codex");
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  await chmod(wrapper, 0o755);
  // No personal shell profile can put a real codex ahead of the fake.
  const shell = join(bin, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  await writeFile(join(userData, "spark-state.json"), JSON.stringify({
    workspaces: [{ id: "ws-wait", name: "Wait", cwd: workspace, color: "#34D3C3", workers: [] }],
    activeWorkspaceId: "ws-wait",
  }));
  return {
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      SHELL: shell,
      // A fake home: nothing the app or the shell does reaches the real one.
      HOME: root,
      SPARK_USER_DATA_DIR: userData,
      CODARA_HOME_DIR: userData,
      SPARK_HOME_DIR: userData,
      CODEX_HOME: join(root, "codex-home"),
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      GROK_HOME: join(root, "grok-home"),
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  };
}
