import { expect, test, type ElectronApplication, type Locator } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("terminal defaults split in the expected direction and Cmd/Ctrl+W closes only the active pane", async () => {
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
    await expect(terminalTab).toBeAttached();
    await terminalTab.dispatchEvent("click");
    await expect(terminalTab).toHaveClass(/spark-tab--active/);
    const panes = page.locator(".spark-terminal-pane:visible");
    await expect(panes).toHaveCount(1);
    await focusTerminal(panes.first());

    await page.keyboard.press(modKey("d"));
    await expect(panes).toHaveCount(2);
    const rightBoxes = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()]);
    expect(rightBoxes.every(Boolean)).toBe(true);
    expect(Math.abs(rightBoxes[0]!.y - rightBoxes[1]!.y)).toBeLessThan(10);
    expect(Math.abs(rightBoxes[0]!.x - rightBoxes[1]!.x)).toBeGreaterThan(100);

    await focusTerminal(panes.nth(1));
    await page.keyboard.press(modKey("w"));
    await expect(panes).toHaveCount(1);
    await expect(terminalTab).toHaveClass(/spark-tab--active/);

    await focusTerminal(panes.first());
    await page.keyboard.press(modKey("d", true));
    await expect(panes).toHaveCount(2);
    const downBoxes = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()]);
    expect(downBoxes.every(Boolean)).toBe(true);
    expect(Math.abs(downBoxes[0]!.x - downBoxes[1]!.x)).toBeLessThan(10);
    expect(Math.abs(downBoxes[0]!.y - downBoxes[1]!.y)).toBeGreaterThan(100);

    // Search semantics follow the desktop/editor conventions:
    //   Mod+F       local Find in the active pane
    //   Mod+P       Quick Open by file name/path
    //   Mod+Shift+F project-wide content search
    await focusTerminal(panes.nth(1));
    await page.keyboard.press(modKey("f"));
    await expect(panes.nth(1).getByPlaceholder("Find")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panes.nth(1).getByPlaceholder("Find")).toBeHidden();

    await page.keyboard.press(modKey("p"));
    const openFileDialog = page.getByRole("dialog", { name: "Open file" });
    await expect(openFileDialog).toBeVisible();
    // The dialog moves focus on a zero-delay effect. Wait for that user-facing
    // ready state before sending Escape; otherwise the key can still land in
    // xterm during the same event-loop turn that opened the overlay.
    await expect(openFileDialog.getByPlaceholder("Open file...")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(openFileDialog).toHaveCount(0);

    await page.keyboard.press(modKey("f", true));
    const searchDialog = page.getByRole("dialog", { name: "Search in files" });
    await expect(searchDialog).toBeVisible();
    await expect(searchDialog.getByPlaceholder("Search in files…")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(searchDialog).toHaveCount(0);

    // The custom worker shortcut must launch the exact public command. In
    // particular, interactive panes must not acquire a generated --session-id.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { __coraInjects?: unknown[] };
      state.__coraInjects = [];
      ipcMain.removeHandler("pty:inject");
      ipcMain.handle("pty:inject", (_event, args) => {
        state.__coraInjects?.push(args);
      });
    });
    await focusTerminal(panes.nth(1));
    await page.keyboard.press("Control+Alt+g");
    const claudeSessions = page.getByRole("dialog", { name: "Claude Code sessions" });
    await expect(claudeSessions).toBeVisible();
    await claudeSessions.getByRole("button", { name: "New session" }).dispatchEvent("click");
    await expect.poll(
      async () => app!.evaluate(() => {
        const state = globalThis as typeof globalThis & { __coraInjects?: unknown[] };
        return state.__coraInjects ?? [];
      }),
      { timeout: 15_000 },
    ).toEqual([{
      id: expect.any(String),
      text: "claude --dangerously-skip-permissions",
      submit: true,
    }]);
  } finally {
    await app?.close();
  }
});

function modKey(key: string, shift = false): string {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return `${mod}+${shift ? "Shift+" : ""}${key}`;
}

function terminalInput(pane: Locator): Locator {
  return pane.locator(".xterm-helper-textarea");
}

async function focusTerminal(pane: Locator): Promise<void> {
  // The helper textarea is intentionally a zero-sized xterm accessibility
  // input. Dispatch the same mousedown TerminalPane handles rather than
  // waiting on Playwright's compositor-frame stability gate: fully occluded
  // Electron test windows can pause rAF even while the DOM is responsive.
  await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
  await expect(terminalInput(pane)).toBeFocused();
}

async function prepareFixture(): Promise<{
  userDataDir: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-shortcuts-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Terminal shortcut probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-shortcuts", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-shortcuts",
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ keybindings: { "worker.newClaude": "ctrl+alt+g" } }, null, 2),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
