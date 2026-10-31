import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Terminal stepping as the owner uses it, in a temp HOME and Codara home:
// from the chat Ctrl+Tab lands in the workspace's terminal, then moves left to
// right across a split and wraps, Shift+Tab alone stays with the terminal (it
// is Claude Code's mode switch), Ctrl+Shift+Tab carries on into the next
// workspace and back, tab cycling answers Ctrl+PageDown / Ctrl+PageUp, and a
// pane hidden by its tab's zoom comes on screen before it takes the keyboard.

const IS_MAC = process.platform === "darwin";
const MOD = IS_MAC ? "Meta" : "Control";
const WORKSPACE = (digit: number) => (IS_MAC ? `Control+${digit}` : `Alt+${digit}`);

async function focusedPane(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active?.classList.contains("xterm-helper-textarea")) return null;
    return active.closest(".codara-terminal-session")?.getAttribute("data-pane-id") ?? null;
  });
}

async function expectFocusedPane(page: Page, paneId: string) {
  await expect.poll(() => focusedPane(page), { timeout: 15_000 }).toBe(paneId);
}

// A new pane can mount long before its shell is up and miss the initial
// focus, so it is found by id and clicked into if needed.
async function newPane(page: Page, chord: string, known: readonly string[]): Promise<string> {
  await page.keyboard.press(chord);
  let paneId: string | null = null;
  await expect
    .poll(
      async () => {
        paneId = await page.evaluate((skip) => {
          for (const session of Array.from(
            document.querySelectorAll<HTMLElement>(".codara-terminal-session[data-pane-id]"),
          )) {
            const id = session.getAttribute("data-pane-id");
            if (id && !skip.includes(id) && session.checkVisibility({ visibilityProperty: true })) return id;
          }
          return null;
        }, known as string[]);
        return paneId !== null;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const id = paneId as unknown as string;
  try {
    await expect.poll(() => focusedPane(page), { timeout: 5_000 }).toBe(id);
  } catch {
    await page.locator(`.codara-terminal-session[data-pane-id="${id}"]`).click();
    await expectFocusedPane(page, id);
  }
  return id;
}

async function expectPaneShown(page: Page, paneId: string, shown: boolean) {
  const pane = page.locator(`.codara-terminal-session[data-pane-id="${paneId}"]`);
  if (shown) await expect(pane).toBeVisible();
  else await expect(pane).toBeHidden();
}

async function awaitAnyFocusedPane(page: Page): Promise<string> {
  await expect.poll(() => focusedPane(page), { timeout: 15_000 }).not.toBeNull();
  return (await focusedPane(page)) as string;
}

async function expectActive(page: Page, id: string) {
  await expect(page.locator(`[data-workspace-id="${id}"]`)).toHaveAttribute("data-active", "true");
}

// A workspace switch settles on its pane a few frames after the keyboard
// arrives, so a press sent the moment it lands would step from the pane that
// was active there before.
async function expectLanded(page: Page, workspaceId: string, paneId: string) {
  await expectActive(page, workspaceId);
  await expectFocusedPane(page, paneId);
  await page.waitForTimeout(300);
}

test("Ctrl+Tab steps through terminal panes left to right, Ctrl+Shift+Tab across workspaces", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-switch-"));
  const userDataDir = join(root, "user-data");
  const userHome = join(root, "home");
  const claudeConfigDir = join(root, "claude-home");
  const codexHomeDir = join(root, "codex-home");
  const grokHomeDir = join(root, "grok-home");
  const alphaDir = join(root, "alpha");
  const betaDir = join(root, "beta");
  await Promise.all(
    [userDataDir, userHome, claudeConfigDir, codexHomeDir, grokHomeDir, alphaDir, betaDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  // A fake HOME with no rc files would drop zsh into its new-user wizard.
  await writeFile(join(userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-a", name: "alpha", cwd: alphaDir, color: "#34D3C3", workers: [] },
        { id: "ws-b", name: "beta", cwd: betaDir, color: "#78A8FF", workers: [] },
      ],
      activeWorkspaceId: "ws-a",
    }),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: userHome,
        ZDOTDIR: userHome,
        // Pin every home override the app honors, so a shell inside the dev
        // app cannot point this instance at the user's real state.
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
        CODARA_DISABLE_KEYCHAIN: "1",
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CODEX_HOME: codexHomeDir,
        GROK_HOME: grokHomeDir,
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached();
    await expectActive(page, "ws-a");

    // The workspace opens on its chat; Ctrl+Tab goes to the terminal tab to
    // its right. Splitting it gives the screenshot's layout: left | right.
    await page.keyboard.press("Control+Tab");
    const left = await awaitAnyFocusedPane(page);
    const right = await newPane(page, `${MOD}+d`, [left]);

    await page.keyboard.press("Control+Tab");
    await expectFocusedPane(page, left);
    await page.keyboard.press("Control+Tab");
    await expectFocusedPane(page, right);

    // Shift+Tab without Ctrl is the terminal's own (Claude Code's mode switch).
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(300);
    expect(await focusedPane(page)).toBe(right);

    // Beta's terminal, reached the same way from its chat.
    await page.keyboard.press(WORKSPACE(2));
    await expectActive(page, "ws-b");
    await page.keyboard.press("Control+Tab");
    await expect
      .poll(async () => [left, right, null].includes(await focusedPane(page)), { timeout: 15_000 })
      .toBe(false);
    const beta = (await focusedPane(page)) as string;
    // Alone in its workspace, Ctrl+Tab has nowhere to go.
    await page.keyboard.press("Control+Tab");
    await page.waitForTimeout(300);
    expect(await focusedPane(page)).toBe(beta);

    // Ctrl+Shift+Tab walks on: past beta's last pane back to alpha's first,
    // then right, then into beta again.
    await page.keyboard.press("Control+Shift+Tab");
    await expectLanded(page, "ws-a", left);
    await page.keyboard.press("Control+Shift+Tab");
    await expectFocusedPane(page, right);
    await page.keyboard.press("Control+Shift+Tab");
    await expectLanded(page, "ws-b", beta);

    // Tab cycling: Ctrl+PageUp back to the chat, Ctrl+PageDown to the terminal.
    await page.keyboard.press("Control+PageUp");
    await expectPaneShown(page, beta, false);
    await page.keyboard.press("Control+PageDown");
    await expectPaneShown(page, beta, true);

    // A zoom hides the tab's other panes, and the keyboard must never land in
    // one of those: stepping within the tab moves the zoom along.
    await page.locator(`.codara-terminal-session[data-pane-id="${beta}"]`).click();
    await expectFocusedPane(page, beta);
    await page.keyboard.press("Control+Shift+Tab");
    await expectLanded(page, "ws-a", left);
    await page.locator('button[title^="Zoom pane"]:visible').first().click();
    await expectPaneShown(page, right, false);
    await page.keyboard.press("Control+Tab");
    await expectFocusedPane(page, right);
    await expectPaneShown(page, right, true);
    await expectPaneShown(page, left, false);
    await page.keyboard.press("Control+Tab");
    await expectFocusedPane(page, left);
    await expectPaneShown(page, left, true);
    await expectPaneShown(page, right, false);

    // Likewise stepping into the tab from elsewhere: the walk leaves alpha
    // zoomed on its right pane and comes back in at its hidden left one.
    await page.keyboard.press("Control+Shift+Tab");
    await expectFocusedPane(page, right);
    await page.keyboard.press("Control+Shift+Tab");
    await expectLanded(page, "ws-b", beta);
    await page.keyboard.press("Control+Shift+Tab");
    await expectLanded(page, "ws-a", left);
    await expectPaneShown(page, left, true);
    await expectPaneShown(page, right, false);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
