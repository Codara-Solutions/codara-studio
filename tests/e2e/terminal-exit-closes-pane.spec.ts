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
    app = await electron.launch({
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
    const livePtys = () =>
      page.evaluate(async () => (await window.spark.pty.resourceSnapshot()).totals.live);
    await expect.poll(livePtys, { timeout: 15_000 }).toBe(2);
    // The pane renders to a canvas, so there is no prompt text to wait on.
    // Give both shells time to start reading input.
    await page.waitForTimeout(3_000);

    await runInPane(panes.nth(1), "exit 3");
    await expect.poll(livePtys, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(500);
    await expect(panes).toHaveCount(2);

    await runInPane(panes.nth(0), "exit");
    await expect.poll(livePtys, { timeout: 15_000 }).toBe(0);
    await expect(panes).toHaveCount(1, { timeout: 5_000 });
  } finally {
    await app?.close();
  }
});

function modKey(key: string): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;
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
      workspaces: [{ id: "ws-exit", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-exit",
    }, null, 2),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
