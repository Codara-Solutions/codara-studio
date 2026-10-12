import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Codara passes the built-in codara-studio server on the command line of the
// sessions it starts, so the per-CLI switch never edits the user's config.
// The entry an earlier build wrote into ~/.claude.json is removed once at
// boot, with a backup that Settings, About points to. HOME points at a fake
// home so all of this happens to a throwaway ~/.claude.json, never the
// user's.

test("the built-in server is per launch: old global entries are cleaned up and the switch writes nothing global", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-builtin-switch-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(userHome);
  await mkdir(cwd);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Switches", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const claudeJson = join(userHome, ".claude.json");
  await writeFile(
    claudeJson,
    JSON.stringify({
      mcpServers: {
        mine: { command: "mine" },
        "codara-studio": {
          type: "stdio",
          command: "/Applications/Codara.app/Contents/MacOS/Codara",
          args: ["/Applications/Codara.app/Contents/Resources/codara-studio-mcp/server.js"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          _sparkManaged: true,
          _sparkVersion: "7",
        },
      },
    }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"].includes(key)) env[key] = value;
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const servers = async () => Object.keys(JSON.parse(await readFile(claudeJson, "utf8")).mcpServers ?? {});
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // The boot pass removes the old managed entry, keeps the user's own, and
    // backs the file up first.
    await expect.poll(servers, { timeout: 20_000 }).toEqual(["mine"]);
    const backupRoot = join(home, "backups", "global-config-cleanup");
    const [stamp] = await readdir(backupRoot);
    const manifest = JSON.parse(await readFile(join(backupRoot, stamp, "manifest.json"), "utf8"));
    expect(JSON.stringify(manifest)).toContain(".claude.json");
    const mcpConfig = JSON.parse(await readFile(join(home, "integrations", "claude", "mcp-studio.json"), "utf8"));
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(["codara-studio"]);

    await page.getByTitle("Settings").click({ force: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.locator("nav").getByRole("button", { name: "About", exact: true }).click({ force: true });
    await expect(settings.getByText(/Removed Codara's old entries from your Claude Code and Codex config\. Backup: /)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await page.getByRole("button", { name: "Tools, skills and memory" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Capability Center" });
    await expect(dialog).toBeVisible();
    const claude = dialog.getByRole("switch", { name: "Codara Studio tools for the Claude CLI" });
    await expect(claude).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("Managed", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("builtin-switch-on.png") });

    await claude.click();
    await expect(claude).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByText(/Codara Studio tools are off for the Claude CLI sessions Codara starts/)).toBeVisible();
    expect(await servers()).toEqual(["mine"]);
    const optOut = JSON.parse(await readFile(join(home, "builtin-mcp.json"), "utf8"));
    expect(optOut.removedFrom).toEqual(["claude"]);
    await page.screenshot({ path: testInfo.outputPath("builtin-switch-off.png") });

    await claude.click();
    await expect(claude).toHaveAttribute("aria-checked", "true");
    expect(await servers()).toEqual(["mine"]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
