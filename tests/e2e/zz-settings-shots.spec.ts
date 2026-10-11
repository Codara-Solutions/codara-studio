import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A screenshot harness, not a behavior test: it opens Settings over a
// terminal full of text and captures every tab, page by page, at two window
// sizes in a dark and a light theme, so a redesign can be judged on real
// pixels. It only runs when SHOTS_DIR names where the PNGs go:
//
//   SHOTS_DIR=/tmp/settings-shots SPARK_ALLOW_MULTI=1 \
//     npx playwright test tests/e2e/zz-settings-shots.spec.ts
//
// HOME, the Codara home and every CLI home point into a temp root, so the
// shell, the session list and the account inspection only ever see fixtures.
// The account rows come from stubbed account IPC handlers (the pattern of
// account-switch-lifecycle.spec.ts): real managed logins would need real
// tokens, and a fake token in a real store would be refreshed against the
// provider on boot.

const SHOTS_DIR = process.env.SHOTS_DIR?.trim() ?? "";

const TABS = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "api", label: "API and model" },
  { id: "agents", label: "Accounts" },
  { id: "sessions", label: "Sessions" },
  { id: "remote-access", label: "Remote access" },
  { id: "keybindings", label: "Keybindings" },
  { id: "runs", label: "Runs" },
  { id: "about", label: "About" },
] as const;

const SIZES = [
  { width: 1400, height: 900 },
  { width: 1000, height: 700 },
] as const;

// Long tabs are captured a viewport at a time, up to this many pages.
const MAX_PAGES = 10;

const THEMES = [
  { mode: "dark", theme: "codara-classic" },
  { mode: "light", theme: "codara-daylight" },
] as const;

const SESSIONS = [
  { id: "aaaaaaa1-1111-4111-8111-111111111111", title: "Refactor the billing webhook retries" },
  { id: "bbbbbbb2-2222-4222-8222-222222222222", title: "Fix flaky login e2e on Windows" },
  { id: "ccccccc3-3333-4333-8333-333333333333", title: "Draft release notes for 0.42" },
] as const;

for (const { mode, theme } of THEMES) {
  test(`settings screenshots, ${mode} theme`, async () => {
    test.skip(!SHOTS_DIR, "Set SHOTS_DIR to capture settings screenshots.");
    test.setTimeout(420_000);
    await mkdir(SHOTS_DIR, { recursive: true });
    const fixture = await prepareFixture(theme);
    let app: ElectronApplication | null = null;
    try {
      app = await launch(fixture);
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await stubAccounts(app);
      await fillTerminal(page);

      for (const size of SIZES) {
        await resizeWindow(app, page, size.width, size.height);
        const dialog = await openSettings(page);
        for (const [index, tab] of TABS.entries()) {
          await showTab(dialog, tab);
          const prefix = `${mode}-${size.width}x${size.height}-${String(index + 1).padStart(2, "0")}-${tab.id}`;
          await capturePages(page, dialog, prefix);
        }
        const base = `${mode}-${size.width}x${size.height}`;
        await captureExtras(page, dialog, base);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await captureCapabilityCenter(page, base);
      }
    } finally {
      await app?.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

/* ------------------------------------------------------------------- ui */

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function showTab(dialog: Locator, tab: (typeof TABS)[number]): Promise<void> {
  await dialog.locator("nav").getByRole("button", { name: tab.label, exact: true }).click({
    force: true,
  });
  await expect(dialog.locator(`[data-settings-tab="${tab.id}"][aria-busy="false"]`)).toBeVisible();
  if (tab.id === "agents") {
    await expect(dialog.getByText("Main", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  }
  if (tab.id === "sessions") {
    await expect(dialog.getByText(/of \d+ sessions?$/).first()).toBeVisible({ timeout: 20_000 });
  }
  // Lazy panels fetch on mount; let their first read and fade settle.
  await dialog.page().waitForTimeout(900);
}

function contentPane(dialog: Locator): Locator {
  return dialog.locator("nav + div").first();
}

async function capturePages(page: Page, dialog: Locator, prefix: string): Promise<void> {
  const pane = contentPane(dialog);
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  const { scrollHeight, clientHeight } = await pane.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  // Each page overlaps the previous one by a little, so a row cut at one
  // page's edge is whole on the next.
  const step = Math.max(1, clientHeight - 60);
  const overflow = Math.max(0, scrollHeight - clientHeight);
  const pages = Math.min(MAX_PAGES, 1 + Math.ceil(overflow / step));
  for (let index = 0; index < pages; index += 1) {
    if (index > 0) {
      await pane.evaluate((node, top) => {
        node.scrollTop = top;
      }, Math.min(overflow, index * step));
      await page.waitForTimeout(150);
    }
    await page.screenshot({ path: join(SHOTS_DIR, `${prefix}-p${index + 1}.png`) });
  }
}

// The states a page-by-page pass never reaches: a search, an open account
// menu, the switching explainer, the shell picker and a tuned glass row.
async function captureExtras(page: Page, dialog: Locator, base: string): Promise<void> {
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  // Park the pointer off the nav, or the hover tint under it reads as a
  // selected page in the capture.
  await page.mouse.move(4, 4);
  await search.fill("account");
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS_DIR, `${base}-x-search-account.png`) });
  await search.fill("");

  await showTab(dialog, TABS[4]);
  await dialog.getByRole("button", { name: "More actions for Account 1" }).first().click({ force: true });
  await expect(page.getByRole("menu").first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS_DIR, `${base}-x-account-menu.png`) });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "How switching works" }).click({ force: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS_DIR, `${base}-x-how-switching.png`) });
  await dialog.getByRole("button", { name: "How switching works" }).click({ force: true });

  await showTab(dialog, TABS[2]);
  await dialog.getByRole("button", { name: "Default shell" }).click({ force: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS_DIR, `${base}-x-shell-select.png`) });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  await showTab(dialog, TABS[0]);
  const adjust = dialog.getByRole("button", { name: "Adjust" });
  if (await adjust.count()) {
    await adjust.click({ force: true });
    await dialog.getByText("Chromatic fringe", { exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS_DIR, `${base}-x-glass-tuning.png`) });
  }
}

async function captureCapabilityCenter(page: Page, base: string): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-capabilities")));
  const center = page.getByRole("dialog", { name: "Capability Center" });
  await expect(center).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS_DIR, `${base}-x-capability-tools.png`) });
  for (const tab of ["Skills", "Profiles", "Memory", "Worker models", "Behavior"]) {
    await center.getByRole("tab", { name: new RegExp(`^${tab}`) }).click({ force: true });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: join(SHOTS_DIR, `${base}-x-capability-${tab.toLowerCase().replace(/\s+/g, "-")}.png`),
    });
  }
  await page.keyboard.press("Escape");
  await expect(center).toHaveCount(0);
}

async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(400, 300);
    win.setContentSize(size.width, size.height);
  }, { width, height });
  await expect
    .poll(() => page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`))
    .toBe(`${width}x${height}`);
  await page.waitForTimeout(300);
}

// A pane full of build output behind the dialog, so a translucent surface
// shows exactly how much of it bleeds through.
async function fillTerminal(page: Page): Promise<void> {
  const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
  await expect(terminalTab).toBeAttached({ timeout: 30_000 });
  await terminalTab.dispatchEvent("click");
  const pane = page.locator(".spark-terminal-pane:visible").first();
  await expect(pane).toBeVisible();
  await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
  await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(
    "for i in $(seq 1 80); do echo \"[build] step $i/80 compiling src/modules/feature-$i/index.ts ... ok (${i}2ms)\"; done",
  );
  await page.keyboard.press("Enter");
  await expect(pane.locator(".xterm-rows, .xterm-screen").first()).toBeVisible();
  await page.waitForTimeout(1_000);
}

/* -------------------------------------------------------------- accounts */

async function stubAccounts(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const now = new Date().toISOString();
    const windows = (fiveHour: number, sevenDay: number, extra?: number) => [
      { id: "five_hour", label: "5-hour", scope: "general", usedPercent: fiveHour, remainingPercent: 100 - fiveHour, resetsIn: "1h 4m" },
      { id: "seven_day", label: "7-day", scope: "general", usedPercent: sevenDay, remainingPercent: 100 - sevenDay, resetsIn: "3d 2h" },
      ...(extra === undefined
        ? []
        : [{ id: "seven_day_opus", label: "Opus 7-day", scope: "general", usedPercent: extra, remainingPercent: 100 - extra, resetsIn: "3d 2h" }]),
    ];
    const profiles = [
      {
        id: "11111111-1111-4111-8111-111111111111", provider: "anthropic", label: "Account 1",
        email: "personal@example.com", builtIn: true, cliProfileId: "personal",
        isDefault: false, connected: true, expired: true, canRefresh: true, expiresAt: null,
        error: "Session expired. Reconnect this Claude account.",
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
      },
      {
        id: "22222222-2222-4222-8222-222222222222", provider: "anthropic", label: "Main",
        email: "main@example.com", cliProfileId: "33333333-3333-4333-8333-333333333333",
        isDefault: true, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 2 },
      },
      {
        id: "44444444-4444-4444-8444-444444444444", provider: "anthropic", label: "Work",
        email: "work@example.com", cliProfileId: "55555555-5555-4555-8555-555555555555",
        isDefault: false, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
      },
      {
        id: "66666666-6666-4666-8666-666666666666", provider: "openai-codex", label: "Main",
        email: "main@example.com", cliProfileId: "77777777-7777-4777-8777-777777777777",
        isDefault: true, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
      },
      {
        id: "99999999-9999-4999-8999-999999999999", provider: "xai", label: "Main",
        email: "grok@example.com", cliProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        isDefault: true, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
      },
    ];
    const overview = () => ({
      runtimeInstalled: true,
      runtimeVersion: "0.85.1",
      runtimeExpectedVersion: "0.85.1",
      runtimeTestedVersion: "0.85.1",
      runtimeSource: "user",
      connections: [],
      switchSessionCounts: { "openai-codex": 0 },
      profiles,
    });
    const usage = () => ({
      checkedAt: now,
      providers: [],
      profiles: [
        { profileId: profiles[1].id, provider: "anthropic", label: "Main", isDefault: true, status: "ok", plan: "max", windows: windows(34, 94, 11), checkedAt: now, limitReached: false },
        { profileId: profiles[2].id, provider: "anthropic", label: "Work", isDefault: false, status: "ok", plan: "pro", windows: windows(3, 18), checkedAt: now },
        { profileId: profiles[3].id, provider: "openai-codex", label: "Main", isDefault: true, status: "ok", plan: "pro", windows: windows(12, 40), checkedAt: now },
        { profileId: profiles[4].id, provider: "xai", label: "Main", isDefault: true, status: "ok", windows: [], checkedAt: now },
      ],
    });
    const inspection = () => ({
      runtimes: [
        {
          runtime: "claude", defaultProfileId: "33333333-3333-4333-8333-333333333333",
          profiles: [
            { runtime: "claude", id: "personal", label: "Account 1", managed: false, isDefault: false, connected: true, inUse: false, status: "connected", email: "personal@example.com" },
            { runtime: "claude", id: "33333333-3333-4333-8333-333333333333", label: "Main", managed: true, isDefault: true, connected: true, inUse: true, status: "connected", email: "main@example.com" },
            { runtime: "claude", id: "55555555-5555-4555-8555-555555555555", label: "Work", managed: true, isDefault: false, connected: true, inUse: false, status: "connected", email: "work@example.com" },
            { runtime: "claude", id: "88888888-8888-4888-8888-888888888888", label: "Old laptop", managed: true, isDefault: false, connected: true, inUse: false, status: "connected", email: "old@example.com" },
          ],
        },
        {
          runtime: "codex", defaultProfileId: "77777777-7777-4777-8777-777777777777",
          profiles: [
            { runtime: "codex", id: "personal", label: "Account 1", managed: false, isDefault: false, connected: false, inUse: false, status: "sign_in_required" },
            { runtime: "codex", id: "77777777-7777-4777-8777-777777777777", label: "Main", managed: true, isDefault: true, connected: true, inUse: true, status: "connected", email: "main@example.com" },
          ],
        },
        {
          runtime: "grok", defaultProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          profiles: [
            { runtime: "grok", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Main", managed: true, isDefault: true, connected: true, inUse: true, status: "connected", email: "grok@example.com" },
          ],
        },
      ],
    });
    for (const channel of [
      "pi-subscriptions:status",
      "pi-subscriptions:usage",
      "native-cli-accounts:inspect",
      "pi-subscriptions:resume-login",
    ]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle("pi-subscriptions:status", overview);
    ipcMain.handle("pi-subscriptions:usage", usage);
    ipcMain.handle("native-cli-accounts:inspect", inspection);
    ipcMain.handle("pi-subscriptions:resume-login", () => null);
  });
}

/* -------------------------------------------------------------- fixtures */

interface Fixture {
  root: string;
  userHome: string;
  codaraHome: string;
  workspaceDir: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

async function prepareFixture(theme: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-settings-shots-"));
  const userHome = join(root, "home");
  const codaraHome = join(root, "codara-home");
  const workspaceDir = join(root, "workspace");
  const claudeConfigDir = join(root, "claude-home");
  const codexHomeDir = join(root, "codex-home");
  const grokHomeDir = join(root, "grok-home");
  const claudeProjectDir = join(claudeConfigDir, "projects", workspaceDir.replace(/[^a-zA-Z0-9]/g, "-"));
  await Promise.all(
    [userHome, codaraHome, workspaceDir, claudeProjectDir, codexHomeDir, grokHomeDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  // A fake HOME with no rc files would drop zsh into its new-user wizard.
  const rc = "PS1='%~ %# '\nPROMPT='%~ %# '\n";
  await Promise.all([
    writeFile(join(userHome, ".zshrc"), rc, "utf8"),
    writeFile(join(userHome, ".bashrc"), "PS1='\\w $ '\n", "utf8"),
    writeFile(join(workspaceDir, "README.md"), "# Settings screenshots\n", "utf8"),
    writeFile(
      join(codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-shots", name: "codara-web", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-shots",
      }),
      "utf8",
    ),
    writeFile(join(codaraHome, "spark-preferences.json"), JSON.stringify({ theme }), "utf8"),
    writeFile(
      join(claudeConfigDir, "history.jsonl"),
      `${SESSIONS.map((session) =>
        JSON.stringify({ sessionId: session.id, cwd: workspaceDir, display: session.title }),
      ).join("\n")}\n`,
      "utf8",
    ),
  ]);
  const startedAt = new Date().toISOString();
  await Promise.all(
    SESSIONS.map((session) =>
      writeFile(
        join(claudeProjectDir, `${session.id}.jsonl`),
        `${JSON.stringify({
          type: "user",
          cwd: workspaceDir,
          sessionId: session.id,
          timestamp: startedAt,
          message: { role: "user", content: session.title },
        })}\n`,
        "utf8",
      ),
    ),
  );
  return { root, userHome, codaraHome, workspaceDir, claudeConfigDir, codexHomeDir, grokHomeDir };
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
