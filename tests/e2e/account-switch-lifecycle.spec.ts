import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FixtureProfile = {
  id: string;
  provider: string;
  label: string;
  cliProfileId: string;
  email?: string;
  builtIn?: true;
  coraHalf?: string;
};
type FixtureState = {
  profiles: FixtureProfile[];
  defaults: Record<string, string | undefined>;
  offer: boolean;
  requests: Array<{ channel: string; input: unknown }>;
};
type FixtureGlobal = typeof globalThis & { accountFixture: FixtureState };

// Accounts spec 5 and 13 against a stubbed main: a switch is one click and
// closes nothing, the System login is offered as one line and becomes a row
// only when the user adds it, Remove asks once with the spec's sentence and
// stays removed, and the way back to the System login is an explicit choice.
test("accounts switch in one click, offer the System login, and remove for good", async ({}, testInfo) => {
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
      const state: FixtureState = (globalThis as FixtureGlobal).accountFixture = {
        profiles: [
          { id: "claude-main", provider: "anthropic", label: "Main", cliProfileId: "managed-claude", email: "main@example.com" },
          { id: "codex-main", provider: "openai-codex", label: "Codex Main", cliProfileId: "managed-codex", email: "codex@example.com" },
          { id: "codex-next", provider: "openai-codex", label: "Main 2", cliProfileId: "managed-next", email: "next@example.com" },
        ],
        defaults: { anthropic: "claude-main", "openai-codex": "codex-main" },
        offer: true,
        requests: [],
      };
      const overview = () => ({
        runtimeInstalled: true, runtimeVersion: "fixture", runtimeExpectedVersion: "fixture", connections: [],
        ...(state.offer ? { systemOffers: { anthropic: { email: "me@example.com" } } } : {}),
        profiles: state.profiles.map((p) => {
          const coraHeld = p.coraHalf !== "none";
          return {
            ...p,
            connected: coraHeld, expired: false, canRefresh: coraHeld, expiresAt: null,
            isDefault: state.defaults[p.provider] === p.id,
            terminal: { connected: true, expired: false, canRefresh: true },
          };
        }),
      });
      const channels = [
        "pi-subscriptions:status", "native-cli-accounts:inspect", "pi-subscriptions:usage",
        "pi-subscriptions:make-default", "pi-subscriptions:delete-account",
        "pi-subscriptions:add-system-account", "pi-subscriptions:use-system-login",
        "pi-subscriptions:dismiss-system-offer",
      ];
      for (const channel of channels) ipcMain.removeHandler(channel);
      const record = (channel: string, input: unknown) => state.requests.push({ channel, input });
      ipcMain.handle("pi-subscriptions:status", overview);
      // A removed account's managed home goes with it, so its terminal half
      // never comes back as a card of its own.
      const managed = (provider: string) => state.profiles
        .filter((p) => p.provider === provider && !p.builtIn)
        .map((p) => ({ id: p.cliProfileId, label: p.label, managed: true, status: "connected" }));
      ipcMain.handle("native-cli-accounts:inspect", () => ({ runtimes: [
        { runtime: "claude", profiles: managed("anthropic") },
        { runtime: "codex", profiles: managed("openai-codex") },
        { runtime: "grok", profiles: [] },
      ] }));
      ipcMain.handle("pi-subscriptions:usage", () => ({ profiles: [], connections: [] }));
      ipcMain.handle("pi-subscriptions:make-default", (_event, input) => {
        record("make-default", input);
        state.defaults[input.provider] = input.profileId;
        return overview();
      });
      ipcMain.handle("pi-subscriptions:delete-account", (_event, input) => {
        record("delete-account", input);
        const gone = state.profiles.find((p) => p.id === input.profileId);
        state.profiles = state.profiles.filter((p) => p.id !== input.profileId);
        if (gone && state.defaults[gone.provider] === gone.id) delete state.defaults[gone.provider];
        _event.sender.send("native-cli-accounts:changed");
        return overview();
      });
      ipcMain.handle("pi-subscriptions:add-system-account", (_event, input) => {
        record("add-system-account", input);
        state.offer = false;
        state.profiles.push({
          id: "claude-system", provider: "anthropic", label: "me@example.com", cliProfileId: "personal",
          email: "me@example.com", builtIn: true, coraHalf: "none",
        });
        return overview();
      });
      ipcMain.handle("pi-subscriptions:use-system-login", (_event, input) => {
        record("use-system-login", input);
        delete state.defaults[input.provider];
        return overview();
      });
      ipcMain.handle("pi-subscriptions:dismiss-system-offer", (_event, input) => {
        record("dismiss-system-offer", input);
        state.offer = false;
        return overview();
      });
    });
    const requests = () => app.evaluate(() => (globalThis as FixtureGlobal).accountFixture.requests);
    await page.getByTitle("Settings").click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const row = (text: string) => dialog.locator(".st-acct", { hasText: text });
    await dialog.locator("nav").getByRole("button", { name: "Accounts", exact: true }).click({ force: true });
    await expect(dialog.getByText("Main", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Account 1", { exact: true })).toHaveCount(0);
    // The switching rules live under the disclosure, not on the rows.
    await dialog.getByRole("button", { name: "How switching works" }).click();
    await expect(dialog.getByText(/Running Claude Code sessions switch on their next request\./)).toBeVisible();
    await expect(dialog.getByText(/New Codex sessions use the new account\. Running ones keep theirs\./)).toBeVisible();
    await expect(row("main@example.com").getByText("Signed in", { exact: true })).toBeVisible();
    await expect(dialog.getByText("MCP servers that need a sign-in must be connected once in each Codara account.")).toBeVisible();
    await expect(dialog.getByText(/by claude in other terminals while "Use the Active Claude account in other terminals" is on/)).toBeVisible();

    // A plain `claude` in other terminals follows the Active account: on by
    // default. Only an installed app sets it up, so this test build says so
    // and writes nothing outside its own folder when the switch moves.
    const follow = dialog.getByRole("switch", { name: "Use the Active Claude account in other terminals" });
    await expect(follow).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText(/This copy of Codara can't set it up; the installed app does\./)).toBeVisible();
    await follow.click();
    await expect(follow).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByText(/This copy of Codara can't set it up/)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { spark: { claudeFollow: { status(): Promise<{ enabled: boolean; available: boolean; files: string[] }> } } }).spark.claudeFollow.status())).toEqual(
      expect.objectContaining({ enabled: false, available: false, files: [] }),
    );
    await follow.click();
    await expect(follow).toHaveAttribute("aria-checked", "true");

    // One click switches; nothing asks to close sessions.
    await row("next@example.com").getByRole("button", { name: "Switch to this account", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).accountFixture.defaults["openai-codex"])).toBe("codex-next");
    await expect(dialog.getByRole("button", { name: /Close \d+ sessions?/ })).toHaveCount(0);
    expect((await requests())[0]).toEqual({ channel: "make-default", input: { provider: "openai-codex", profileId: "codex-next" } });

    // The System login is one line until the user adds it.
    const offer = dialog.getByRole("group", { name: "Claude Code login on this computer" });
    await expect(offer.getByText("Claude Code on this computer is signed in as me@example.com.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("accounts-offer.png") });
    await offer.getByRole("button", { name: "Use in Codara", exact: true }).click();
    const system = row("Your Claude Code login");
    await expect(system.getByText("Signed in", { exact: true })).toBeVisible();
    await expect(system.getByText("Cora isn't connected.")).toBeVisible();
    await expect(system.getByRole("button", { name: "Connect Cora", exact: true })).toBeVisible();
    await expect(offer).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("accounts-system-row.png") });
    await system.getByRole("button", { name: "Switch to this account", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).accountFixture.defaults.anthropic)).toBe("claude-system");

    // Remove asks once with the spec's sentence, then the row stays gone.
    // The menu closes when the pane scrolls, so the row is brought into view first.
    const moreActions = dialog.getByRole("button", { name: "More actions for Codex Main" });
    await moreActions.scrollIntoViewIfNeeded();
    await expect(moreActions).toBeInViewport();
    await moreActions.click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    const confirm = row("codex@example.com").getByRole("alertdialog");
    await expect(confirm).toContainText("Remove \"Codex Main\"? Codara deletes this sign-in from its own folder. Your Codex login outside Codara is not affected. This can't be undone; to use it again, add it again.");
    await page.screenshot({ path: testInfo.outputPath("accounts-remove-confirm.png") });
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog.getByText("Codex Main", { exact: true })).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("pi-subscriptions:event", { type: "changed", provider: "openai-codex" });
      }
    });
    await expect(dialog.getByText("Main 2", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Codex Main", { exact: true })).toHaveCount(0);
    expect((await requests()).find((entry) => entry.channel === "delete-account")).toEqual({
      channel: "delete-account", input: { profileId: "codex-main" },
    });

    // Going back to the CLI's own login is an explicit choice.
    await dialog.getByRole("button", { name: "Use your Codex login", exact: true }).click();
    await expect(dialog.getByText("No account is Active. New sessions use your own Codex login.")).toBeVisible();
    expect((await requests()).find((entry) => entry.channel === "use-system-login")).toEqual({
      channel: "use-system-login", input: { provider: "openai-codex" },
    });
  } finally {
    await app.close();
  }
});
