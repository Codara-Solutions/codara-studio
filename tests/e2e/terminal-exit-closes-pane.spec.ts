import { expect, test, type ElectronApplication, type Locator } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a clean `exit` closes its pane while a failing exit keeps it", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture.userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
    await expect(terminalTab).toBeAttached();
    await terminalTab.dispatchEvent("click");
    const panes = page.locator(".spark-terminal-pane:visible");
    await expect(panes).toHaveCount(1);
    await focusTerminal(panes.first());

    await page.keyboard.press(modKey("d"));
    await expect(panes).toHaveCount(2);
    await expect.poll(() => livePtys(app!), { timeout: 15_000 }).toBe(2);
    // The pane renders to a canvas, so there is no prompt text to wait on.
    // Give both shells time to start reading input.
    await page.waitForTimeout(3_000);

    await runInPane(panes.nth(1), "exit 3");
    await expect.poll(() => livePtys(app!), { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(500);
    await expect(panes).toHaveCount(2);

    await runInPane(panes.nth(0), "exit");
    await expect.poll(() => livePtys(app!), { timeout: 15_000 }).toBe(0);
    await expect(panes).toHaveCount(1, { timeout: 5_000 });
  } finally {
    await app?.close();
  }
});

test("exiting a tab's final pane closes the tab and seeds no new shell", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture.userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
    await expect(terminalTab).toBeAttached();
    await terminalTab.dispatchEvent("click");
    const panes = page.locator(".spark-terminal-pane:visible");
    await expect(panes).toHaveCount(1);
    await expect.poll(() => livePtys(app!), { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(3_000);
    // With a chat tab left, closing the terminal tab proves nothing about the
    // reseed: that only happens to a workspace's very last tab.
    await page.getByRole("tab", { name: /new chat/i }).first().getByRole("button", { name: "Close chat" }).dispatchEvent("click");
    await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);

    await runInPane(panes.first(), "exit");
    await expect(page.getByText("Nothing open here")).toBeVisible({ timeout: 15_000 });
    await expect(panes).toHaveCount(0);
    await expect.poll(() => livePtys(app!), { timeout: 5_000 }).toBe(0);
  } finally {
    await app?.close();
  }
});

test("a clean exit in a hidden workspace closes its pane, and a failing one stays", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture.userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-exit"]')).toBeVisible({ timeout: 30_000 });
    const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
    await expect(terminalTab).toBeAttached();
    await terminalTab.dispatchEvent("click");
    const panes = page.locator(".spark-terminal-pane:visible");
    await expect(panes).toHaveCount(1);
    await focusTerminal(panes.first());
    await page.keyboard.press(modKey("d"));
    await expect(panes).toHaveCount(2);
    await page.keyboard.press(modKey("d"));
    await expect(panes).toHaveCount(3);
    await expect.poll(() => livePtys(app!), { timeout: 15_000 }).toBe(3);
    await page.waitForTimeout(3_000);

    await runInPane(panes.nth(2), "sleep 4; exit 3");
    await runInPane(panes.nth(1), "sleep 4; exit");
    await page.locator('[data-workspace-id="ws-other"]').dispatchEvent("click");
    await expect(page.locator('[data-workspace-id="ws-other"]')).toHaveAttribute("data-active", "true");
    // Both shells end while their workspace is hidden.
    await page.waitForTimeout(7_000);

    await page.locator('[data-workspace-id="ws-exit"]').dispatchEvent("click");
    await expect(page.locator('[data-workspace-id="ws-exit"]')).toHaveAttribute("data-active", "true");
    await expect(panes).toHaveCount(2, { timeout: 5_000 });
  } finally {
    await app?.close();
  }
});

function modKey(key: string): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;
}

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function livePtys(app: ElectronApplication): Promise<number> {
  return app.firstWindow().then((page) =>
    page.evaluate(async () => (await window.spark.pty.resourceSnapshot()).totals.live),
  );
}

async function focusTerminal(pane: Locator): Promise<void> {
  await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
  await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
}

async function runInPane(pane: Locator, command: string): Promise<void> {
  await focusTerminal(pane);
  await pane.page().keyboard.type(command);
  await pane.page().keyboard.press("Enter");
}

async function prepareFixture(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-exit-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-exit", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] },
        { id: "ws-other", name: "other", cwd: workspaceDir, color: "#42D6C7", workers: [] },
      ],
      activeWorkspaceId: "ws-exit",
    }, null, 2),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
