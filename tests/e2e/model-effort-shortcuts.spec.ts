import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The keyboard chords that steer a chat's model and reasoning effort. Only the
// CHAT surface is exercised here: the terminal branch needs a live Claude/Codex
// CLI in a pane, which these fixtures can't produce on every platform, and its
// routing rules are covered as pure logic by
// scripts/test-model-effort-shortcuts.cjs.
test("Ctrl+M and Ctrl+N steer the chat's model and thinking effort, and the shifted chords open their pickers", async () => {
  // Cold Electron boot plus a full cycle through the model list.
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.codarastudio state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await selectCoraTab(page);

    const modelLabel = page.locator(".composer-model .composer-pill-label").first();
    const thinkingLabel = page.locator(".composer-thinking-label").first();
    await expect(modelLabel).toBeVisible({ timeout: 60_000 });
    // The draft default resolves asynchronously (agents.runtimes → first
    // visible model); settle before treating the label as a baseline.
    await expect(thinkingLabel).toBeVisible();
    await page.waitForTimeout(500);

    // ── Cycling the model ──────────────────────────────────────────────────
    const firstModel = (await modelLabel.textContent())?.trim() ?? "";
    expect(firstModel.length).toBeGreaterThan(0);
    await page.keyboard.press(modKey("m"));
    await expect(modelLabel).not.toHaveText(firstModel, { timeout: 15_000 });
    // The change is confirmed by a renderer-local toast — the notify pipeline
    // would have suppressed this one for targeting the surface in view.
    await expect(page.getByText("Model changed").first()).toBeVisible();

    // Keep pressing: the list wraps, so the original label comes back rather
    // than the cycle dead-ending on the last row.
    let wrapped = false;
    for (let i = 0; i < 12 && !wrapped; i += 1) {
      await page.keyboard.press(modKey("m"));
      await page.waitForTimeout(250);
      wrapped = ((await modelLabel.textContent())?.trim() ?? "") === firstModel;
    }
    expect(wrapped).toBe(true);

    // ── Cycling the effort ─────────────────────────────────────────────────
    const firstEffort = (await thinkingLabel.textContent())?.trim() ?? "";
    expect(firstEffort.length).toBeGreaterThan(0);
    await page.keyboard.press(modKey("n"));
    await expect(thinkingLabel).not.toHaveText(firstEffort, { timeout: 15_000 });
    await expect(page.getByText("Thinking effort changed").first()).toBeVisible();
    // Whatever it lands on must be a level this model actually offers, i.e. one
    // of the rows its own picker lists.
    await page.keyboard.press(modKey("n", { shift: true }));
    const effortMenu = page.locator(".composer-model-thinking-menu");
    await expect(effortMenu).toBeVisible({ timeout: 10_000 });
    await expect(effortMenu.getByText("Choose thinking depth")).toBeVisible();
    const offered = (await effortMenu.getByRole("option").allTextContents()).map((text) =>
      text.trim(),
    );
    const currentEffort = (await thinkingLabel.textContent())?.trim() ?? "";
    expect(offered.some((option) => option.startsWith(currentEffort))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(effortMenu).toBeHidden();

    // ── Opening the model picker and choosing with the arrows ──────────────
    await page.keyboard.press(modKey("m", { shift: true }));
    const modelMenu = page.locator(".composer-model-thinking-menu");
    await expect(modelMenu).toBeVisible({ timeout: 10_000 });
    await expect(modelMenu.getByText("Choose model")).toBeVisible();
    // Focus lands inside the listbox, so the arrows have somewhere to start.
    await expect(modelMenu.getByRole("option").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(modelMenu.getByText("Choose thinking depth")).toBeVisible();
    await expect(modelMenu.getByRole("option", { selected: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(modelMenu).toBeHidden();

    // ── The cheat sheet advertises the new group and the relocated chord ───
    // (chat.new had to vacate the bare Ctrl+N; asserting on tab count would
    // prove nothing, since addDraftChatTab deliberately reuses an open draft.)
    await page.keyboard.press(modKey("/", { shift: true }));
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByRole("heading", { name: "Agent" })).toBeVisible();
    // chordToDisplay orders modifiers ⌃ ⌥ ⇧ ⌘ on macOS and Ctrl Alt Shift
    // elsewhere, so the Alt-bearing row differs in shape per platform.
    const isMac = process.platform === "darwin";
    const modGlyph = isMac ? "⌘" : "Ctrl";
    const modAlt = isMac ? ["⌥", "⌘"] : ["Ctrl", "Alt"];
    for (const [label, keys] of [
      ["Cycle model", [modGlyph, "M"]],
      ["Cycle thinking effort", [modGlyph, "N"]],
      ["New chat", [...modAlt, "N"]],
    ] as const) {
      const row = sheet.locator("li").filter({ hasText: label }).first();
      await expect(row).toBeVisible();
      const chips = (await row.locator("kbd").allTextContents()).map((chip) => chip.trim());
      expect(chips).toEqual([...keys]);
    }
  } finally {
    await app?.close();
  }
});

// The seeded pane id, asserted against the injection the chord produces.
const LIVE_PANE_ID = "pane-live-agent";

// The terminal branch: a pane whose CLI agent is live gets the matching slash
// command typed at it, opening the CLI's own picker. Rather than boot a real
// CLI, this seeds the persisted tab layout with a pane already carrying a live
// agentSession, which is exactly the state the runtime detector produces.
test("over a live agent pane Ctrl+M types /model and Ctrl+N types /effort", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  // Restoring a persisted agentSession is gated on this preference; without it
  // the layout is re-saved with the session stripped and the pane reads as a
  // plain shell.
  await writeFile(
    join(fixture.userDataDir, "spark-preferences.json"),
    JSON.stringify({ restoreAgentSessions: true }, null, 2),
    "utf8",
  );
  // Restoring also relaunches `claude --resume`, so shadow the CLI with an
  // inert stand-in rather than spawning the real one from a test.
  const binDir = join(fixture.userDataDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "claude.cmd"),
    ["@echo off", ":loop", "timeout /t 5 >nul", "goto loop", ""].join(String.fromCharCode(13, 10)),
    "utf8",
  );

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
        PATH: `${binDir};${process.env.PATH ?? ""}`,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Seed the layout BEFORE any app script runs: written afterwards it loses
    // to the app's own persistence, which has already minted a fresh terminal.
    await page.addInitScript(
      ({ payload }) => {
        window.localStorage.setItem("spark.tabs:ws-model-chords", payload);
      },
      {
        payload: JSON.stringify({
          v: 7,
          activeId: "tab-live-agent",
          tabs: [
            {
              kind: "terminal",
              id: "tab-live-agent",
              title: "agent",
              activePaneId: LIVE_PANE_ID,
              root: {
                kind: "leaf",
                paneId: LIVE_PANE_ID,
                cwd: fixture.workspaceDir,
                // Exactly the shape the runtime detector writes when it sees a
                // CLI agent take over a pane.
                agentSession: {
                  runtime: "claude",
                  sessionId: "11111111-2222-4333-8444-555555555555",
                  cwd: fixture.workspaceDir,
                  capturedAt: new Date().toISOString(),
                  active: true,
                },
              },
            },
          ],
        }),
      },
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Watch the IPC boundary from the MAIN process. xterm paints to a canvas,
    // so what was typed at the CLI is unreadable from the DOM, and the
    // renderer's `spark` bridge is frozen by contextBridge so it cannot be
    // wrapped from the page either. NOTE: `_invokeHandlers` is an Electron
    // internal — if an upgrade renames it, replace the hook rather than
    // dropping the assertion; this is the only view of the injection.
    const hooked = await app.evaluate(({ ipcMain }) => {
      const anyIpc = ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const original = anyIpc._invokeHandlers.get("pty:inject");
      if (!original) return false;
      (globalThis as unknown as { __injections: unknown[] }).__injections = [];
      anyIpc._invokeHandlers.set("pty:inject", (...args: unknown[]) => {
        (globalThis as unknown as { __injections: unknown[] }).__injections.push(args[1]);
        return original(...args);
      });
      return true;
    });
    expect(hooked, "the pty:inject handler must be observable").toBe(true);
    const injections = async () =>
      app!.evaluate(() => (globalThis as unknown as { __injections: unknown[] }).__injections);

    await expect(page.locator(".spark-terminal-pane:visible").first()).toBeVisible({
      timeout: 60_000,
    });

    // Both chords type the CLI's own slash command at it, as if the user had.
    // Claude Code takes `/effort` mid-session ("Set effort level for model
    // usage"), so the pane needs no respawn to change reasoning depth. Both
    // stash the draft first (Claude Code's own Ctrl+S) so a half-typed message
    // is not submitted with the command glued onto its end.
    await page.keyboard.press(modKey("m"));
    await expect
      .poll(injections, { timeout: 15_000 })
      .toEqual([{ id: LIVE_PANE_ID, text: "/model", submit: true, stashDraft: true }]);

    await page.keyboard.press(modKey("n"));
    await expect
      .poll(injections, { timeout: 15_000 })
      .toEqual([
        { id: LIVE_PANE_ID, text: "/model", submit: true, stashDraft: true },
        { id: LIVE_PANE_ID, text: "/effort", submit: true, stashDraft: true },
      ]);
  } finally {
    await app?.close();
  }
});

function modKey(key: string, modifiers: { shift?: boolean; alt?: boolean } = {}): string {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return `${mod}+${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}${key}`;
}

async function selectCoraTab(page: Page): Promise<void> {
  // A fresh workspace has no chat tab yet — the ✦ Cora button in the tab strip
  // mints the draft (the same action chat.new performs).
  const newChat = page.getByRole("button", { name: "New Cora chat" }).last();
  await expect(newChat).toBeAttached({ timeout: 60_000 });
  // dispatchEvent rather than click(): a fully occluded Electron test window
  // can pause rAF, which stalls Playwright's actionability gate.
  await newChat.dispatchEvent("click");
  const tab = page.getByRole("tab", { name: /Cora|New chat/ }).last();
  await expect(tab).toBeAttached({ timeout: 15_000 });
  await expect(tab).toHaveClass(/spark-tab--active/);
}

async function prepareFixture(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codara-model-effort-shortcuts-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Model chord probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-model-chords",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-model-chords",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
