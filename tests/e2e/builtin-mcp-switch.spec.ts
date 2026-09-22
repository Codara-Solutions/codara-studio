import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The built-in codara-studio server used to show a bare "Managed" badge in
// each CLI column whenever auto-install was on, so it could not be removed
// from one CLI, and a removal from elsewhere came back at the next launch.
// Each CLI now has a switch. HOME points at a fake home so the switch edits a
// throwaway ~/.claude.json, never the user's.

test("the Capability Center switches the built-in server off for one CLI", async ({}, testInfo) => {
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
          _sparkVersion: "6",
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
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTitle("MCP and skills").first().click();
    const dialog = page.getByRole("dialog", { name: "Capability Center" });
    await expect(dialog).toBeVisible();
    const claude = dialog.getByRole("switch", { name: "Codara Studio tools for the Claude CLI" });
    await expect(claude).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("Managed", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("builtin-switch-on.png") });

    await claude.click();
    await expect(claude).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByText(/Removed Codara Studio tools from the Claude CLI/)).toBeVisible();
    const servers = JSON.parse(await readFile(claudeJson, "utf8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["mine"]);
    const optOut = JSON.parse(await readFile(join(home, "builtin-mcp.json"), "utf8"));
    expect(optOut.removedFrom).toEqual(["claude"]);
    await page.screenshot({ path: testInfo.outputPath("builtin-switch-off.png") });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
