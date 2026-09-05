import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FixtureState = { count: number; selected: string; requests: boolean[] };
type FixtureGlobal = typeof globalThis & { accountFixture: FixtureState };

for (const remaining of [2, 0]) {
  test(`account refresh hides duplicate personal login and updates switch count to ${remaining}`, async () => {
    test.setTimeout(60_000);
    const root = await mkdtemp(join(tmpdir(), "codara-account-switch-e2e-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "spark-state.json"), JSON.stringify({
      workspaces: [{ id: "accounts", name: "Accounts", cwd: workspace, workers: [] }],
      activeWorkspaceId: "accounts",
    }));
    const app = await electron.launch({ args: ["."], env: {
      ...process.env, SPARK_USER_DATA_DIR: root, CODARA_HOME_DIR: root, SPARK_HOME_DIR: root,
      CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), GROK_HOME: join(root, "grok"),
      SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1",
    } });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await app.evaluate(({ ipcMain }) => {
        const state: FixtureState = (globalThis as FixtureGlobal).accountFixture = { count: 5, selected: "codex-main", requests: [] };
        const profiles = [
          { id: "claude-main", provider: "anthropic", label: "Main", cliProfileId: "managed-claude" },
          { id: "codex-main", provider: "openai-codex", label: "Codex Main", cliProfileId: "managed-codex" },
          { id: "codex-next", provider: "openai-codex", label: "Main 2", cliProfileId: "managed-next" },
        ];
        const overview = () => ({
          runtimeInstalled: true, runtimeVersion: "fixture", runtimeExpectedVersion: "fixture", connections: [],
          switchSessionCounts: { "openai-codex": state.count },
          profiles: profiles.map(p => ({ ...p, connected: true, expired: false, canRefresh: true, expiresAt: null,
            isDefault: p.id === "claude-main" || p.id === state.selected,
            terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
          })),
        });
        for (const channel of ["pi-subscriptions:status", "native-cli-accounts:inspect", "pi-subscriptions:usage", "pi-subscriptions:make-default"]) {
          ipcMain.removeHandler(channel);
        }
        ipcMain.handle("pi-subscriptions:status", overview);
        ipcMain.handle("native-cli-accounts:inspect", () => ({ runtimes: [
          { runtime: "claude", profiles: [
            { id: "personal", label: "Account 1", managed: false, status: "connected" },
            { id: "managed-claude", label: "Main", managed: true, status: "connected" },
          ] },
          { runtime: "codex", profiles: [] },
          { runtime: "grok", profiles: [] },
        ] }));
        ipcMain.handle("pi-subscriptions:usage", () => ({ profiles: [], connections: [] }));
        ipcMain.handle("pi-subscriptions:make-default", (_event, input) => {
          state.requests.push(input.closeSessions === true);
          if (state.count > 0 && !input.closeSessions) {
            throw new Error(`${state.count} terminal sessions are using this account. Close them to switch accounts.`);
          }
          state.selected = input.profileId;
          state.count = 0;
          return overview();
        });
      });
      await page.getByTitle("Settings").click({ force: true });
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.locator("nav").getByRole("button", { name: "Agents", exact: true }).click({ force: true });
      await expect(dialog.getByText("Main", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Account 1", { exact: true })).toHaveCount(0);
      await expect(dialog.getByText(/Cora is linking it now/)).toHaveCount(0);
      await dialog.getByRole("button", { name: "Use this account", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Close 5 sessions and switch" })).toBeVisible();
      await app.evaluate(({ BrowserWindow }, count) => {
        (globalThis as FixtureGlobal).accountFixture.count = count;
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("pi-subscriptions:event", { type: "changed", provider: "openai-codex" });
        }
      }, 3);
      await expect(dialog.getByRole("button", { name: "Close 3 sessions and switch" })).toBeVisible();
      await app.evaluate((_electron, count) => {
        (globalThis as FixtureGlobal).accountFixture.count = count;
      }, remaining);
      const action = dialog.getByRole("button", { name: remaining ? "Close 2 sessions and switch" : "Use this account", exact: true });
      await expect(action).toBeVisible({ timeout: 10_000 });
      await action.click();
      await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).accountFixture.selected)).toBe("codex-next");
      expect(await app.evaluate(() => (globalThis as FixtureGlobal).accountFixture.requests)).toEqual([false, remaining > 0]);
      await expect(dialog.getByText("Account 1", { exact: true })).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
