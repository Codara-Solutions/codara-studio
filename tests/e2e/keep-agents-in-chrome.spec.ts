import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "Keep agents in your Chrome" as the owner meets it: a fresh Codara finds
// the chrome-devtools-mcp plugin and a Playwright server in the user's own
// Claude Code and Codex configs, names them in Settings, and turns them off
// in the `--settings` file and the `codex` args Codara passes to new
// sessions. Switching it off takes them out again; the user's configs are
// never written. Everything lives in a temp HOME and temp config dirs.

test("Keep agents in your Chrome names the tools it turns off and follows its switch", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-keep-in-chrome-"));
  const home = join(root, "home");
  const codaraHome = join(root, "codara-home");
  const claudeDir = join(root, "claude-home");
  const codexDir = join(root, "codex-home");
  const workspaceDir = join(root, "workspace");
  await Promise.all([home, codaraHome, claudeDir, codexDir, workspaceDir].map((dir) => mkdir(dir, { recursive: true })));
  const userSettings = JSON.stringify({ enabledPlugins: { "chrome-devtools-mcp@claude-plugins-official": true } });
  const userClaudeJson = JSON.stringify({ mcpServers: { "my-chrome": { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } } });
  const userCodex = '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n';
  await Promise.all([
    writeFile(join(home, ".zshrc"), "PS1='%~ %# '\n"),
    writeFile(join(claudeDir, "settings.json"), userSettings),
    writeFile(join(claudeDir, ".claude.json"), userClaudeJson),
    writeFile(join(codexDir, "config.toml"), userCodex),
    writeFile(
      join(codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-keep", name: "keep", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-keep",
      }),
    ),
  ]);
  const settingsFile = join(codaraHome, "integrations", "claude", "settings.json");
  const codexArgs = join(codaraHome, "integrations", "codex", "args.txt");
  const readSettings = (): Promise<Record<string, unknown>> =>
    readFile(settingsFile, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => ({}));

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        SPARK_USER_DATA_DIR: codaraHome,
        CODARA_HOME_DIR: codaraHome,
        SPARK_HOME_DIR: codaraHome,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
        CODARA_DISABLE_KEYCHAIN: "1",
        CODARA_CHROME_LINK: "0",
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: codexDir,
        GROK_HOME: join(root, "grok-home"),
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // On by default: new sessions get the plugin and both servers off.
    await expect.poll(async () => (await readSettings()).enabledPlugins, { timeout: 30_000 }).toMatchObject({
      "chrome-devtools-mcp@claude-plugins-official": false,
    });
    expect((await readSettings()).deniedMcpServers).toEqual([{ serverName: "my-chrome" }]);
    await expect.poll(() => readFile(codexArgs, "utf8").catch(() => "")).toContain("mcp_servers.playwright={command='npx',enabled=false}");

    await page.getByTitle("Settings").first().click({ force: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // The row sits in the Chrome extension section of the Browser page.
    await settings.getByRole("combobox", { name: "Search settings" }).fill("keep agents in your chrome");
    await expect(settings.locator("[data-search-result]").first()).toHaveAttribute("data-search-result", "Keep agents in your Chrome");
    await page.keyboard.press("Enter");
    await expect(settings.locator(".st-topbar__title")).toHaveText("Browser");
    const row = settings.locator('[data-setting-anchor="Keep agents in your Chrome"]');
    await row.scrollIntoViewIfNeeded();
    const toggle = row.getByRole("switch", { name: "Keep agents in your Chrome" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(row).toContainText("Browser tools that open a separate Chrome window are turned off in Codara.");
    const list = row.locator(".chrome-off-tools");
    await expect(list).toContainText("Off in Codara:");
    await expect(list).toContainText("chrome-devtools-mcp@claude-plugins-official (Claude Code plugin)");
    await expect(list).toContainText("my-chrome (Claude Code MCP server)");
    await expect(list).toContainText("playwright (Codex MCP server)");
    await expect(row).not.toContainText(/[\u2013\u2014]/);

    // Off: the next session keeps the user's tools; the hooks file stays Codara's.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await readSettings()).enabledPlugins ?? null).toBeNull();
    await expect.poll(() => readFile(codexArgs, "utf8").catch(() => "")).not.toContain("enabled=false");
    await expect(list).toContainText("Turning this on turns off:");

    // And on again.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await readSettings()).enabledPlugins ?? null).toMatchObject({
      "chrome-devtools-mcp@claude-plugins-official": false,
    });

    // The user's own configs were only read.
    expect(await readFile(join(claudeDir, "settings.json"), "utf8")).toBe(userSettings);
    expect(await readFile(join(claudeDir, ".claude.json"), "utf8")).toBe(userClaudeJson);
    expect(await readFile(join(codexDir, "config.toml"), "utf8")).toBe(userCodex);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
