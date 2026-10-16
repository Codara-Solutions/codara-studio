import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The jump palette and the workspace shortcuts as the owner uses them, in a
// temp HOME and Codara home: workspace N by rail order, back and forward
// through the workspaces visited, the palette's glass card, fuzzy search,
// Enter landing the keyboard in the chosen editor or terminal pane, Mod+digit
// rows, Escape handing focus back, and "Create worktree" from a typed name.

const IS_MAC = process.platform === "darwin";
const MOD = IS_MAC ? "Meta" : "Control";
const JUMP = IS_MAC ? "Meta+j" : "Control+Shift+J";
const WORKSPACE = (digit: number) => (IS_MAC ? `Control+${digit}` : `Alt+${digit}`);
const BACK = IS_MAC ? "Meta+Alt+ArrowLeft" : "Alt+BracketLeft";
const FORWARD = IS_MAC ? "Meta+Alt+ArrowRight" : "Alt+BracketRight";

async function expectGlassCard(dialog: Locator) {
  await expect(dialog).toBeVisible();
  const material = await dialog.evaluate((element) => {
    const surface = getComputedStyle(element);
    const scrim = getComputedStyle(document.querySelector(".spark-scrim--clear")!);
    const readBackdrop = (style: CSSStyleDeclaration) =>
      style.backdropFilter ||
      (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
      "none";
    return {
      surfaceBackdrop: readBackdrop(surface),
      surfaceImage: surface.backgroundImage,
      scrimBackdrop: readBackdrop(scrim),
    };
  });
  expect(material.surfaceBackdrop).toContain("blur");
  expect(material.surfaceImage).toContain("gradient");
  expect(["", "none"]).toContain(material.scrimBackdrop);
}

async function activeWorkspace(page: Page): Promise<string | null> {
  return page.locator('[data-workspace-id][data-active="true"]').first().getAttribute("data-workspace-id");
}

async function expectActive(page: Page, id: string) {
  await expect(page.locator(`[data-workspace-id="${id}"]`)).toHaveAttribute("data-active", "true");
}

async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press(JUMP);
  const palette = page.getByTestId("jump-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox", { name: "Search workspaces, tabs and agents" })).toBeFocused();
  return palette;
}

test("jump palette and workspace shortcuts move between workspaces, tabs and panes", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-jump-palette-"));
  const userDataDir = join(root, "user-data");
  // The terminals this flow opens start a shell, and the app reads agent
  // homes at boot: none of that may touch the owner's real home.
  const userHome = join(root, "home");
  const claudeConfigDir = join(root, "claude-home");
  const codexHomeDir = join(root, "codex-home");
  const grokHomeDir = join(root, "grok-home");
  const repoDir = join(root, "alpha-repo");
  const notesDir = join(root, "beta-notes");
  const siteDir = join(root, "gamma-site");
  await Promise.all(
    [userDataDir, userHome, claudeConfigDir, codexHomeDir, grokHomeDir, repoDir, notesDir, siteDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(join(repoDir, "README.md"), "# Alpha\n", "utf8"),
    writeFile(join(notesDir, "meeting-notes.md"), "# Notes\n\nfirst line\n", "utf8"),
    writeFile(join(siteDir, "index.html"), "<h1>Gamma</h1>\n", "utf8"),
  ]);
  // The fixture's own git runs in the fake home too, away from the owner's
  // global config (signing, hooks).
  const gitEnv = { ...process.env, HOME: userHome, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[]) => execFileAsync("git", args, { cwd: repoDir, env: gitEnv });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "e2e@example.invalid"]);
  await git(["config", "user.name", "Codara E2E"]);
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);

  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-a", name: "alpha-repo", cwd: repoDir, color: "#34D3C3", workers: [] },
        { id: "ws-b", name: "beta-notes", cwd: notesDir, color: "#78A8FF", workers: [] },
        { id: "ws-c", name: "gamma-site", cwd: siteDir, color: "#E58BD8", workers: [] },
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
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.codarastudio state.
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

    // ── Workspace N by rail order, then back and forward ──────────────────
    await page.keyboard.press(WORKSPACE(2));
    await expectActive(page, "ws-b");
    await page.keyboard.press(WORKSPACE(3));
    await expectActive(page, "ws-c");
    // Past the last row does nothing.
    await page.keyboard.press(WORKSPACE(9));
    await expectActive(page, "ws-c");
    await page.keyboard.press(BACK);
    await expectActive(page, "ws-b");
    await page.keyboard.press(BACK);
    await expectActive(page, "ws-a");
    await page.keyboard.press(FORWARD);
    await expectActive(page, "ws-b");

    // An editor tab in beta-notes to jump back to later.
    await page.keyboard.press(`${MOD}+p`);
    const quickOpen = page.getByPlaceholder("Open file...");
    await expect(quickOpen).toBeFocused();
    await quickOpen.fill("meeting-notes");
    await expect(page.locator(".spark-quick-open__results").first()).toContainText("meeting-notes");
    await quickOpen.press("Enter");
    await expect(page.locator('[data-tab-content] .cm-content:visible').first()).toBeVisible();

    await page.keyboard.press(WORKSPACE(3));
    await expectActive(page, "ws-c");

    // ── The palette: glass card, every workspace, the current one marked ──
    let palette = await openPalette(page);
    await expectGlassCard(palette);
    for (const id of ["ws-a", "ws-b", "ws-c"]) {
      await expect(palette.locator(`[data-jump-id="ws:${id}"]`)).toHaveCount(1);
    }
    await expect(palette.locator('[data-jump-id="ws:ws-c"]')).toContainText("On screen");
    const firstRow = palette.getByRole("option").first();
    await expect(firstRow).toHaveAttribute("aria-selected", "true");
    await expect(firstRow).not.toHaveAttribute("data-jump-id", "ws:ws-c");
    // Tabs of the workspaces visited are listed too.
    await expect(palette.locator('[data-jump-kind="editor"]', { hasText: "meeting-notes.md" })).toHaveCount(1);

    // Page Down and Page Up stop at the last and first rows, never wrap.
    const input = palette.getByRole("combobox");
    const options = palette.getByRole("option");
    const lastIndex = (await options.count()) - 1;
    expect(lastIndex).toBeGreaterThan(0);
    await input.press("PageDown");
    await input.press("PageDown");
    await expect(options.nth(lastIndex)).toHaveAttribute("aria-selected", "true");
    await input.press("PageUp");
    await input.press("PageUp");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    // Fuzzy search, then Enter puts the keyboard in that editor.
    await input.fill("mtgnotes");
    const editorRow = palette.getByRole("option").first();
    await expect(editorRow).toHaveAttribute("data-jump-kind", "editor");
    await expect(editorRow).toContainText("meeting-notes.md");
    await input.press("Enter");
    await expect(palette).toHaveCount(0);
    await expectActive(page, "ws-b");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return Boolean(active?.classList.contains("cm-content") && active.closest("[data-tab-content]"));
        }),
      )
      .toBe(true);

    // A tab closed while the palette is open is not selected: its row was
    // read at opening, and picking it says so instead of blanking the stage.
    palette = await openPalette(page);
    await expect(palette.locator('[data-jump-kind="editor"]', { hasText: "meeting-notes.md" })).toHaveCount(1);
    await page.keyboard.press(`${MOD}+w`);
    await expect(page.locator('[data-tab-content] .cm-content:visible')).toHaveCount(0);
    await palette.getByRole("combobox").fill("mtgnotes");
    await palette.getByRole("combobox").press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.getByText("That tab was closed").first()).toBeVisible();
    await expectActive(page, "ws-b");

    // Initials of a hyphenated name, picked with Mod+1.
    palette = await openPalette(page);
    await palette.getByRole("combobox").fill("gs");
    await expect(palette.getByRole("option").first()).toHaveAttribute("data-jump-id", "ws:ws-c");
    await expect(palette.getByRole("option").first().locator("mark")).toHaveText(["g", "s"]);
    await page.keyboard.press(`${MOD}+1`);
    await expect(palette).toHaveCount(0);
    await expectActive(page, "ws-c");

    // A terminal in another workspace: Enter switches and focuses its pane.
    palette = await openPalette(page);
    // gamma-site is no git repository, so a new name offers no worktree.
    await palette.getByRole("combobox").fill("some-new-branch");
    await expect(palette.getByText("Nothing matches “some-new-branch”")).toBeVisible();
    await expect(palette.locator('[data-jump-kind="create"]')).toHaveCount(0);
    await palette.getByRole("combobox").fill("terminal alpha");
    const terminalRow = palette.locator('[data-jump-kind="terminal"]').first();
    await expect(terminalRow).toBeVisible();
    await terminalRow.click();
    await expect(palette).toHaveCount(0);
    await expectActive(page, "ws-a");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return Boolean(
            active?.classList.contains("xterm-helper-textarea") &&
              active.closest(".codara-terminal-session[data-pane-id]"),
          );
        }),
        { timeout: 15_000 },
      )
      .toBe(true);
    const terminalPaneId = await page.evaluate(
      () => document.activeElement?.closest(".codara-terminal-session")?.getAttribute("data-pane-id") ?? null,
    );
    expect(terminalPaneId).toBeTruthy();

    // Escape closes and gives the keyboard back to that pane; the workspace
    // shortcuts are off while the palette is open.
    palette = await openPalette(page);
    await page.keyboard.press(WORKSPACE(2));
    await expect(palette).toBeVisible();
    expect(await activeWorkspace(page)).toBe("ws-a");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest(".codara-terminal-session")?.getAttribute("data-pane-id") ?? null,
        ),
      )
      .toBe(terminalPaneId);

    // Its own chord closes it the same way.
    palette = await openPalette(page);
    await page.keyboard.press(JUMP);
    await expect(palette).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest(".codara-terminal-session")?.getAttribute("data-pane-id") ?? null,
        ),
      )
      .toBe(terminalPaneId);

    // Enter on the workspace already on screen hands the keyboard back too.
    palette = await openPalette(page);
    await palette.getByRole("combobox").fill("alpha-repo");
    await expect(palette.getByRole("option").first()).toHaveAttribute("data-jump-id", "ws:ws-a");
    await palette.getByRole("combobox").press("Enter");
    await expect(palette).toHaveCount(0);
    await expectActive(page, "ws-a");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest(".codara-terminal-session")?.getAttribute("data-pane-id") ?? null,
        ),
      )
      .toBe(terminalPaneId);

    // ── Create worktree from a typed name ─────────────────────────────────
    palette = await openPalette(page);
    // A name a workspace already goes by is not offered.
    await palette.getByRole("combobox").fill("beta-notes");
    await expect(palette.locator('[data-jump-kind="create"]')).toHaveCount(0);
    await palette.getByRole("combobox").fill("jump e2e branch");
    const createRow = palette.locator('[data-jump-kind="create"]');
    await expect(createRow).toContainText("Create worktree jump-e2e-branch");
    await expect(createRow).toContainText("alpha-repo");
    await createRow.click();
    await expect(palette).toHaveCount(0);
    const newRow = page.locator("[data-workspace-id]", { hasText: "jump-e2e-branch" }).first();
    await expect(newRow).toHaveAttribute("data-active", "true", { timeout: 30_000 });
    const repos = (await readdir(join(userDataDir, "worktrees"))).filter((entry) => !entry.startsWith("."));
    expect(repos).toHaveLength(1);
    const worktree = join(userDataDir, "worktrees", repos[0], "jump-e2e-branch");
    expect(existsSync(worktree)).toBe(true);
    const { stdout: head } = await execFileAsync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], {
      env: gitEnv,
    });
    expect(head.trim()).toBe("jump-e2e-branch");

    // ── The commands are in the cheat sheet with their range chips ────────
    await page.keyboard.press(`${MOD}+Shift+/`);
    const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(shortcuts).toBeVisible();
    for (const label of [
      "Jump to a workspace, tab or agent",
      "Switch to workspace 1 to 9",
      "Back to the previous workspace",
      "Forward to the next workspace",
    ]) {
      await expect(shortcuts.getByText(label, { exact: true })).toBeVisible();
    }
    const rangeRow = shortcuts.locator("li", { hasText: "Switch to workspace 1 to 9" });
    await expect(rangeRow).toContainText(IS_MAC ? "⌃" : "Alt");
    await expect(rangeRow).toContainText("1…9");
    await page.keyboard.press("Escape");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
