import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A pane whose restore pointer names a Claude account other than the one its
// live shell runs on (the pointer predates an account switch, or the restore
// landed on the Active account) used to fail its next re-attach with
// "failed to spawn: ... already pinned to another native Claude account",
// leaving a dead pane over a running shell. A renderer reload is such a
// re-attach: the shell survives it and the reloaded pane binds to it again.
// The pane must attach and take the live account onto its pointer.

const STALE = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const PANE = "pane-acct-reattach";
const WS = "ws-acct";

test("a pane re-attaches to its shell when its pointer names another Claude account", async () => {
  test.skip(process.platform === "win32", "The fixture shell is POSIX.");
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-account-reattach-"));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await prepareFixture(root);
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.addInitScript(
      ({ ws, pane, stale, session, cwd }) => {
        localStorage.setItem(`spark.tabs:${ws}`, JSON.stringify({
          v: 6,
          tabs: [{
            id: "acct-tab", kind: "terminal", title: "terminals", activePaneId: pane,
            root: {
              kind: "leaf", paneId: pane, cwd,
              agentSession: {
                runtime: "claude", sessionId: session, cwd, nativeClaudeProfileId: stale,
                active: false, capturedAt: "2026-10-01T00:00:00Z",
              },
            },
          }],
          activeId: "acct-tab",
        }));
      },
      { ws: WS, pane: PANE, stale: STALE, session: SESSION, cwd: fixture.workspace },
    );

    // First load of the seeded layout: a fresh shell on the account the
    // restore resolves to, which is not the stale one.
    await page.reload();
    await expect(page.locator(`[data-terminal-pane-id="${PANE}"]`)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => pointerAccount(page), { timeout: 20_000 }).not.toBe(STALE);
    const liveAccount = await pointerAccount(page);
    expect(liveAccount).toBeTruthy();

    // The reload re-seeds the stale pointer, so the re-attach carries it.
    await page.reload();
    await expect(page.locator(`[data-terminal-pane-id="${PANE}"]`)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => pointerAccount(page), { timeout: 20_000 }).toBe(liveAccount);

    // The same attach straight through the IPC the pane uses.
    const attach = await page.evaluate(
      async ({ pane, stale, cwd }) => {
        const shell = await window.spark.shells.default();
        if (!shell) throw new Error("no default shell");
        return window.spark.pty.spawn({
          id: pane, shell, cwd, cols: 80, rows: 24, nativeClaudeProfileId: stale,
          startupCommand: "claude",
        });
      },
      { pane: PANE, stale: STALE, cwd: fixture.workspace },
    );
    expect(attach.attached).toBe(true);
    expect(attach.startupCommandHandled).toBe(false);
    expect(attach.nativeClaudeProfileId).toBe(liveAccount);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function pointerAccount(page: Page): Promise<string | null> {
  return page.evaluate(({ ws }) => {
    try {
      const layout = JSON.parse(localStorage.getItem(`spark.tabs:${ws}`) ?? "null");
      return layout?.tabs?.[0]?.root?.agentSession?.nativeClaudeProfileId ?? null;
    } catch {
      return null;
    }
  }, { ws: WS });
}

interface Fixture {
  userHome: string;
  codaraHome: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
  workspace: string;
}

async function prepareFixture(root: string): Promise<Fixture> {
  const fixture: Fixture = {
    userHome: join(root, "home"),
    codaraHome: join(root, "codara-home"),
    claudeConfigDir: join(root, "claude-home"),
    codexHomeDir: join(root, "codex-home"),
    grokHomeDir: join(root, "grok-home"),
    workspace: join(root, "workspace"),
  };
  await Promise.all(Object.values(fixture).map((dir) => mkdir(dir, { recursive: true })));
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(fixture.userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    // Without it the layout drops agent pointers when it saves.
    writeFile(join(fixture.codaraHome, "spark-preferences.json"), JSON.stringify({ restoreAgentSessions: true })),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: WS, name: "accounts", cwd: fixture.workspace, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: WS,
      }),
      "utf8",
    ),
  ]);
  return fixture;
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: fixture.userHome,
      ZDOTDIR: fixture.userHome,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
      GROK_HOME: fixture.grokHomeDir,
    },
  });
}
