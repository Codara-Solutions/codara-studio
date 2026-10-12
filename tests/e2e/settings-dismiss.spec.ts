import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings and the Capability Center are long-lived dialogs: a click that
// lands outside them must never close them. Only Escape, the close button and
// Done (or Cancel on a page with a draft) leave, an Escape that closes a
// menu inside them closes only that menu, and a click elsewhere in them
// closes an open dropdown. This drives the real renderer
// and clicks the real scrim, in a temp HOME and Codara home.

test("a click outside Settings or the Capability Center never closes them", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-settings-dismiss-"));
  let app: ElectronApplication | null = null;
  try {
    app = await launch(await prepareFixture(root));
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const settings = await openSettings(page);
    await clickOutside(page, settings);
    await expect(settings).toBeVisible();
    // A search with text takes the first Escape for itself.
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("theme");
    await settings.getByRole("searchbox", { name: "Search settings" }).press("Escape");
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await openSettings(page);
    await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    await openSettings(page);
    await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    // Escape with an account menu open closes the menu and nothing else.
    await stubOneAccount(app);
    const withMenu = await openSettings(page);
    await withMenu.locator("nav").getByRole("button", { name: "Accounts", exact: true }).click();
    await withMenu.getByRole("button", { name: "More actions for Main" }).click({ timeout: 15_000 });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(withMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(withMenu).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-capabilities")));
    const capabilities = page.getByRole("dialog", { name: "Capability Center" });
    await expect(capabilities).toBeVisible();
    // A dropdown inside the dialog closes on a click elsewhere in it, even
    // though the dialog surface keeps mousedown from bubbling.
    await capabilities.getByRole("tab", { name: /Memory/ }).click();
    const profilePicker = capabilities.getByRole("button", { name: "Show the memory of this profile" });
    await expect(profilePicker).toBeEnabled({ timeout: 15_000 });
    await profilePicker.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await capabilities.getByText("Capability Center", { exact: true }).first().click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(capabilities).toBeVisible();

    // The Memory page also lists what Cora learned; a hand-added memory
    // shows there and can be pinned without leaving the dialog.
    const learned = capabilities.getByTestId("learned-memory");
    await learned.getByRole("textbox", { name: "New memory" }).fill("Answer in Spanish.");
    await learned.getByRole("button", { name: "Remember", exact: true }).click();
    const row = learned.locator("[data-memory-item]").filter({ hasText: "Answer in Spanish." });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Pin", exact: true }).click();
    await expect(row.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    await expect(capabilities).toBeVisible();
    await clickOutside(page, capabilities);
    await expect(capabilities).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(capabilities).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function openSettings(page: Page) {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// One signed-in Anthropic account, so the Accounts page has a row menu to
// open without any real sign-in.
async function stubOneAccount(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const profile = {
      id: "22222222-2222-4222-8222-222222222222", provider: "anthropic", label: "Main",
      email: "main@example.com", cliProfileId: "33333333-3333-4333-8333-333333333333",
      isDefault: true, connected: true, expired: false, canRefresh: true, expiresAt: null,
      terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
    };
    const overview = () => ({
      runtimeInstalled: true,
      runtimeVersion: "0.85.1",
      runtimeExpectedVersion: "0.85.1",
      runtimeTestedVersion: "0.85.1",
      runtimeSource: "user",
      connections: [],
      switchSessionCounts: {},
      profiles: [profile],
    });
    const usage = () => ({ checkedAt: new Date().toISOString(), providers: [], profiles: [] });
    const inspection = () => ({
      runtimes: [
        {
          runtime: "claude", defaultProfileId: profile.cliProfileId,
          profiles: [
            { runtime: "claude", id: profile.cliProfileId, label: "Main", managed: true, isDefault: true, connected: true, inUse: true, status: "connected", email: profile.email },
          ],
        },
        { runtime: "codex", defaultProfileId: "personal", profiles: [] },
        { runtime: "grok", defaultProfileId: "personal", profiles: [] },
      ],
    });
    for (const channel of ["pi-subscriptions:status", "pi-subscriptions:usage", "native-cli-accounts:inspect"]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle("pi-subscriptions:status", overview);
    ipcMain.handle("pi-subscriptions:usage", usage);
    ipcMain.handle("native-cli-accounts:inspect", inspection);
  });
}

// Clicks the scrim beside the dialog, where a backdrop-dismiss would fire.
async function clickOutside(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const x = Math.max(4, Math.floor(box!.x / 2));
  const y = Math.floor(box!.y + box!.height / 2);
  await page.mouse.click(x, y);
  await page.mouse.click(x, Math.max(4, Math.floor(box!.y / 2)));
}

interface Fixture {
  userHome: string;
  codaraHome: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

async function prepareFixture(root: string): Promise<Fixture> {
  const fixture: Fixture = {
    userHome: join(root, "home"),
    codaraHome: join(root, "codara-home"),
    claudeConfigDir: join(root, "claude-home"),
    codexHomeDir: join(root, "codex-home"),
    grokHomeDir: join(root, "grok-home"),
  };
  const workspaceDir = join(root, "workspace");
  await Promise.all(
    [...Object.values(fixture), workspaceDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(fixture.userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(join(workspaceDir, "README.md"), "# Settings dismiss probe\n", "utf8"),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-dismiss", name: "dismiss", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-dismiss",
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
