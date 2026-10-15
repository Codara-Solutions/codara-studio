import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A terminal pane shows the output it had before Codara quit, above what its
// new shell prints, and closing the pane deletes what was kept
// (src/main/terminal-scrollback.ts, persistedScrollback.ts).
//
// What the restored pane holds is read from the buffer snapshot the renderer
// writes on a checkpoint (the same one it writes on quit), which captures the
// xterm buffer as the user sees it.

const WORKSPACE_ID = "ws-scroll";
const RESTORED_LINE = "[Restored from before Codara restarted]";

test("a terminal pane keeps its output across a restart, and closing it deletes the output", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix shell wrapper.");
  test.setTimeout(120_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openTerminals(page);
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially("printf 'BEFORE-%s\\n' RESTART-MARK", { delay: 2 });
    await input.press("Enter");
    const paneId = await page.locator("[data-terminal-pane-id]:visible").first().getAttribute("data-terminal-pane-id");
    expect(paneId).toBeTruthy();
    const file = join(fixture.userData, "terminal-scrollback", `${createHash("sha256").update(paneId!).digest("hex").slice(0, 40)}.bin`);
    await expect.poll(() => readFile(file, "latin1").catch(() => ""), { timeout: 20_000 }).toContain("BEFORE-RESTART-MARK");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(fixture.userData, "terminal-scrollback"))).mode & 0o777).toBe(0o700);

    await app.close();
    app = null;

    app = await electron.launch({ args: ["."], env: fixture.env });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openTerminals(page);
    const pane = page.locator(`[data-terminal-pane-id="${paneId}"]`);
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const restoredInput = pane.locator(".xterm-helper-textarea");
    await restoredInput.focus();
    await restoredInput.pressSequentially("printf 'AFTER-%s\\n' RESTART-MARK", { delay: 2 });
    await restoredInput.press("Enter");
    await expect.poll(() => paneBuffer(app!, page, paneId!), { timeout: 15_000 }).toContain("AFTER-RESTART-MARK");
    const text = await paneBuffer(app, page, paneId!);
    const before = text.indexOf("BEFORE-RESTART-MARK");
    const marker = text.indexOf(RESTORED_LINE);
    const after = text.indexOf("AFTER-RESTART-MARK");
    expect(before, text).toBeGreaterThanOrEqual(0);
    expect(marker, text).toBeGreaterThan(before);
    expect(after, text).toBeGreaterThan(marker);
    expect(text.split(RESTORED_LINE).length, "the replay happens once").toBe(2);

    // Closing the pane is the user saying they are done with it.
    await page.getByRole("button", { name: "Close tab" }).first().evaluate((button) => (button as HTMLElement).click());
    await expect.poll(() => stat(file).then(() => true, () => false), { timeout: 10_000 }).toBe(false);
  } finally {
    await app?.close();
  }
});

test("with the setting off nothing is kept", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix shell wrapper.");
  test.setTimeout(60_000);
  const fixture = await prepare({ restoreTerminalOutput: false });
  const app = await electron.launch({ args: ["."], env: fixture.env });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openTerminals(page);
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially("printf 'OFF-%s\\n' NOT-KEPT", { delay: 2 });
    await input.press("Enter");
    await page.waitForTimeout(4_000);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("app:checkpoint");
    });
    await page.waitForTimeout(500);
    const dir = join(fixture.userData, "terminal-scrollback");
    const names = await readdir(dir).catch(() => [] as string[]);
    expect(names.filter((name) => name.endsWith(".bin"))).toEqual([]);
  } finally {
    await app.close();
  }
});

async function openTerminals(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
}

// The pane's buffer as the renderer snapshots it for persistence.
async function paneBuffer(app: ElectronApplication, page: Page, paneId: string): Promise<string> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("app:checkpoint");
  });
  return page.evaluate(({ key, id }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return "";
    type Node = { kind: string; paneId?: string; scrollback?: string; a?: Node; b?: Node };
    const find = (node: Node | undefined): string | null => {
      if (!node) return null;
      if (node.kind === "leaf") return node.paneId === id ? node.scrollback ?? "" : null;
      return find(node.a) ?? find(node.b);
    };
    for (const tab of (JSON.parse(raw) as { tabs?: Array<{ root?: Node }> }).tabs ?? []) {
      const found = find(tab.root);
      if (found !== null) return found;
    }
    return "";
  }, { key: `spark.tabs:${WORKSPACE_ID}`, id: paneId });
}

async function prepare(preferences: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "codara-scrollback-e2e-"));
  const userData = join(root, "app");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  await Promise.all([userData, workspace, bin].map((dir) => mkdir(dir, { recursive: true })));
  // No personal shell profile, so the prompt and output are only the test's.
  const shell = join(bin, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  // restoreAgentSessions keeps each pane's buffer snapshot in the layout,
  // which is how this spec reads what the restored pane shows.
  await writeFile(join(userData, "spark-preferences.json"), JSON.stringify({ restoreAgentSessions: true, ...preferences }));
  await writeFile(join(userData, "spark-state.json"), JSON.stringify({
    workspaces: [{ id: WORKSPACE_ID, name: "Scroll", cwd: workspace, color: "#34D3C3", workers: [] }],
    activeWorkspaceId: WORKSPACE_ID,
  }));
  return {
    userData,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      SHELL: shell,
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
