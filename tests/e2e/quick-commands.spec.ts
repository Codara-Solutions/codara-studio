import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Quick commands as the owner uses them: a saved shell command runs in the
// focused terminal from the tab bar with {branch} filled in, the palette
// (Mod+Shift+P) runs one in a new terminal, a prompt for the focused agent is
// refused over a plain shell, a prompt for a new Claude Code reaches it once
// it is ready, a command with Press Enter off never runs over an agent,
// Shift+right-click opens the terminal menu, Settings adds, reorders, edits,
// deletes and restores commands and swaps the right-click, and the edit
// dialog hands focus back and asks before it deletes.
// Runs the real renderer in a temp HOME and Codara home, with a fake claude.

const BRANCH = "feat/quick";

interface Fixture {
  root: string;
  userHome: string;
  codaraHome: string;
  workspaceDir: string;
  binDir: string;
  capture: string;
}

test("quick commands run from the tab bar, the palette and the terminal menu", async () => {
  test.setTimeout(180_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const isMac = await page.evaluate(() => /^Mac/i.test(navigator.platform));
    const mod = isMac ? "Meta" : "Control";

    const pane = await focusTerminal(page);

    // The tab bar button lists this repository's commands first, never
    // another repository's, and runs one in the focused terminal.
    await page.getByRole("button", { name: "Quick commands", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Quick commands" });
    await expect(menu).toBeVisible();
    await expect(menu.getByText("This repository · workspace", { exact: true })).toBeVisible();
    await expect(menu.getByText("All workspaces", { exact: true })).toBeVisible();
    await expect(menu.locator('[data-quick-command="qc-repo"]')).toBeVisible();
    await expect(menu.locator('[data-quick-command="qc-elsewhere"]')).toHaveCount(0);
    await expect(menu.locator("[data-quick-command]").first()).toHaveAttribute("data-quick-command", "qc-repo");
    await menu.locator('[data-quick-command="qc-focused"]').click();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => readText(join(fixture.workspaceDir, "qc-focused.txt")), { timeout: 20_000 }).toBe(`${BRANCH}\n`);

    // Shift+right-click opens the terminal's menu; a plain one stays quick edit.
    await pane.locator(".xterm-host").click({ button: "right", modifiers: ["Shift"] });
    const terminalMenu = page.getByTestId("terminal-quick-menu");
    await expect(terminalMenu).toBeVisible();
    await expect(terminalMenu.getByRole("menuitem", { name: "Copy" })).toHaveAttribute("aria-disabled", "true");
    await expect(terminalMenu.getByRole("menuitem", { name: "Paste" })).toBeVisible();
    await expect(terminalMenu.locator('[data-quick-command="qc-focused"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(terminalMenu).toHaveCount(0);
    await pane.locator(".xterm-host").click({ button: "right" });
    await page.waitForTimeout(300);
    await expect(terminalMenu).toHaveCount(0);

    // The palette filters by typing and runs the pick in a new terminal.
    await focusTerminal(page);
    const palette = page.getByRole("dialog", { name: "Run a quick command" });
    const openPalette = async () => {
      await page.keyboard.press(`${mod}+Shift+P`);
      await expect(palette).toBeVisible();
      await expect(palette.getByRole("textbox", { name: "Search quick commands" })).toBeFocused();
    };
    await openPalette();
    await page.keyboard.type("new term");
    await expect(palette.getByRole("option").first()).toHaveAttribute("data-quick-command", "qc-new");
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect.poll(() => readText(join(fixture.workspaceDir, "qc-new.txt")), { timeout: 20_000 }).toMatch(/\/workspace\n$/);

    // A prompt for the focused agent is never typed into a plain shell.
    await openPalette();
    await page.keyboard.type("ask focused");
    await page.keyboard.press("Enter");
    await expect(page.locator(".spark-toast", { hasText: "No agent in the focused terminal" })).toBeVisible({ timeout: 10_000 });

    // A prompt for a new Claude Code waits for it to be ready, then sends.
    await openPalette();
    await page.keyboard.type("ask claude");
    await page.keyboard.press("Enter");
    await expect.poll(() => readText(fixture.capture), { timeout: 45_000 }).toContain(`Summarize ${BRANCH}`);

    // Press Enter off, and the focused terminal (that new Claude Code) runs
    // an agent: nothing is typed, and no new terminal runs it either.
    await openPalette();
    await page.keyboard.type("draft marker");
    await page.keyboard.press("Enter");
    await expect(page.locator(".spark-toast", { hasText: '"Draft marker" was not typed' })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2_500);
    expect(await readText(join(fixture.workspaceDir, "qc-draft.txt"))).toBe("");
    expect(await readText(fixture.capture)).not.toContain("qc-draft");

    // Add from the tab bar menu: the dialog saves with Mod+Enter.
    await page.getByRole("button", { name: "Quick commands", exact: true }).click();
    await menu.getByRole("menuitem", { name: "Add quick command" }).click();
    const dialog = page.getByRole("dialog", { name: "Add quick command" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
    await page.keyboard.type("Dialog added");
    await dialog.getByLabel("Command", { exact: true }).fill("true");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await savedCommands(fixture)).map((c) => c.label)).toContain("Dialog added");

    // Settings: add, reorder, edit, delete and undo, and the right-click choice.
    await page.getByRole("button", { name: "Quick commands", exact: true }).click();
    await menu.getByRole("menuitem", { name: /Manage quick commands/ }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.locator(".st-topbar__title")).toHaveText("Quick commands");
    await settings.getByRole("button", { name: "Add quick command" }).click();
    const form = settings.getByRole("form", { name: "New quick command" });
    await form.getByLabel("Name", { exact: true }).fill("Lint");
    await form.getByLabel("Command", { exact: true }).fill("npm run lint");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(async () => (await savedCommands(fixture)).at(-1)?.label).toBe("Lint");
    // Every action that removes or moves the focused control hands the
    // keyboard to the row it acted on (or Undo), never to the page body.
    await expect(settings.getByRole("button", { name: "Edit Lint" })).toBeFocused();

    const lastTwo = async () => (await savedCommands(fixture)).map((c) => c.label).slice(-2);
    await settings.getByRole("button", { name: "Move Lint up" }).click();
    await expect.poll(lastTwo).toEqual(["Lint", "Dialog added"]);
    await expect(settings.getByRole("button", { name: "Move Lint up" })).toBeFocused();
    // Moving down re-inserts the row, and at the end Move down turns disabled.
    await settings.getByRole("button", { name: "Move Lint down" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(lastTwo).toEqual(["Dialog added", "Lint"]);
    await expect(settings.getByRole("button", { name: "Move Lint up" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(lastTwo).toEqual(["Lint", "Dialog added"]);

    await settings.getByRole("button", { name: "Edit Lint" }).click();
    const edit = settings.getByRole("form", { name: "Edit Lint" });
    await edit.getByLabel("Name", { exact: true }).fill("Lint all");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await savedCommands(fixture)).map((c) => c.label)).toContain("Lint all");
    await expect(settings.getByRole("button", { name: "Edit Lint all" })).toBeFocused();

    await settings.getByRole("button", { name: "Delete Lint all" }).click();
    await expect.poll(async () => (await savedCommands(fixture)).map((c) => c.label)).not.toContain("Lint all");
    await expect(settings.getByRole("button", { name: "Undo" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(lastTwo).toEqual(["Lint all", "Dialog added"]);
    await expect(settings.getByRole("button", { name: "Edit Lint all" })).toBeFocused();

    await settings.getByRole("group", { name: "Right-click in a terminal" }).getByRole("button", { name: "Open menu" }).click();
    await expect.poll(async () => (await preferences(fixture)).terminalRightClick).toBe("menu");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // Now a plain right-click opens the menu.
    const shellPane = await focusTerminal(page);
    await shellPane.locator(".xterm-host").click({ button: "right" });
    await expect(terminalMenu).toBeVisible();
    await expect(terminalMenu.locator('[data-quick-command="qc-repo"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(terminalMenu).toHaveCount(0);

    // The edit dialog opened from the palette gives the keyboard back to
    // the terminal the palette was opened from.
    const backPane = await focusTerminal(page);
    await openPalette();
    await page.keyboard.type("write marker");
    await page.keyboard.press("Shift+Enter");
    const editDialog = page.getByRole("dialog", { name: "Edit quick command" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Name", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editDialog).toHaveCount(0);
    await expect(backPane.locator(".xterm-helper-textarea")).toBeFocused();

    // The dialog has no Undo, so Delete asks for a second press.
    await openPalette();
    await page.keyboard.type("dialog added");
    await page.keyboard.press("Shift+Enter");
    await expect(editDialog).toBeVisible();
    await editDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(editDialog.getByRole("button", { name: "Delete for good" })).toBeVisible();
    expect((await savedCommands(fixture)).map((c) => c.label)).toContain("Dialog added");
    await editDialog.getByRole("button", { name: "Delete for good" }).click();
    await expect(editDialog).toHaveCount(0);
    await expect.poll(async () => (await savedCommands(fixture)).map((c) => c.label)).not.toContain("Dialog added");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function focusTerminal(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: /terminals/i }).first().dispatchEvent("click");
  const pane = page.locator(".spark-terminal-pane:visible").first();
  await expect(pane).toBeVisible({ timeout: 20_000 });
  await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
  await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
  return pane;
}

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

async function preferences(fixture: Fixture): Promise<{ quickCommands?: Array<{ label: string }>; terminalRightClick?: string }> {
  return JSON.parse((await readText(join(fixture.codaraHome, "spark-preferences.json"))) || "{}");
}

async function savedCommands(fixture: Fixture): Promise<Array<{ label: string }>> {
  return (await preferences(fixture)).quickCommands ?? [];
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-quick-commands-"));
  const fixture: Fixture = {
    root,
    userHome: join(root, "home"),
    codaraHome: join(root, "codara-home"),
    workspaceDir: join(root, "workspace"),
    binDir: join(root, "bin"),
    capture: join(root, "claude-input.txt"),
  };
  await Promise.all(
    [fixture.userHome, fixture.codaraHome, fixture.workspaceDir, fixture.binDir, join(root, "claude-home"), join(root, "codex-home"), join(root, "grok-home")].map(
      (dir) => mkdir(dir, { recursive: true }),
    ),
  );

  // A repository on a branch, with one commit so the branch has a name.
  await writeFile(join(fixture.workspaceDir, "README.md"), "# Quick commands probe\n", "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: fixture.workspaceDir,
      env: { ...process.env, HOME: fixture.userHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "ignore",
    });
  git("init", "-q", "-b", BRANCH);
  git("add", "README.md");
  git("commit", "-q", "-m", "probe");

  // A fake claude: draws the ready frame, then writes every line it reads.
  const claude = join(fixture.binDir, "claude");
  await writeFile(
    claude,
    [
      "#!/bin/sh",
      "printf '\\033[?1049h'",
      "sleep 0.1",
      "printf '╭───Claude Code v2.1.220───╮\\r\\n❯ Try a task\\r\\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\\r\\n'",
      "trap 'exit 0' INT TERM",
      `while IFS= read -r line; do printf '%s\\n' "$line" >> '${fixture.capture}'; done`,
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(claude, 0o755);

  const shell = (id: string, label: string, command: string, extra: Record<string, unknown> = {}) => ({
    id, label, kind: "shell", command, target: "focused", submit: true, scope: { type: "global" }, ...extra,
  });
  const prompt = (id: string, label: string, text: string, extra: Record<string, unknown> = {}) => ({
    id, label, kind: "prompt", prompt: text, target: "focused", agent: "claude", submit: true, scope: { type: "global" }, ...extra,
  });
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(fixture.userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(join(fixture.userHome, ".zprofile"), `export PATH='${fixture.binDir}':$PATH\n`, "utf8"),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-quick", name: "quick", cwd: fixture.workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-quick",
      }),
      "utf8",
    ),
    writeFile(
      join(fixture.codaraHome, "spark-preferences.json"),
      JSON.stringify({
        quickCommands: [
          shell("qc-focused", "Write marker", 'echo "{branch}" > qc-focused.txt'),
          shell("qc-draft", "Draft marker", "echo draft > qc-draft.txt", { submit: false }),
          shell("qc-new", "New terminal marker", "pwd > qc-new.txt", { target: "new" }),
          prompt("qc-ask-focused", "Ask focused agent", "Explain {branch}"),
          prompt("qc-ask-claude", "Ask Claude", "Summarize {branch}", { target: "new" }),
          shell("qc-repo", "Repo only", "true", { scope: { type: "repo", repo: fixture.workspaceDir } }),
          shell("qc-elsewhere", "Other repo", "true", { scope: { type: "repo", repo: join(root, "other") } }),
        ],
      }),
      "utf8",
    ),
  ]);
  return fixture;
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ELECTRON_RENDERER_URL: _rendererUrl, ...env } = process.env;
  return electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: fixture.userHome,
      ZDOTDIR: fixture.userHome,
      PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: join(fixture.root, "claude-home"),
      CODEX_HOME: join(fixture.root, "codex-home"),
      GROK_HOME: join(fixture.root, "grok-home"),
    },
  });
}
