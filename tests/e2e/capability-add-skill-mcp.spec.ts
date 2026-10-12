import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Adding a skill and an MCP server from the Capability Center writes only to
// Codara's own home: the skill to <home>/skills, the server to
// <home>/mcp-servers.json. HOME is a throwaway folder, so a write to a CLI
// config would show up there, and the server is a real stdio MCP server
// whose tools the Test connection button lists.

function fixtureServerSource(): string {
  const sdkRoot = dirname(dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  return `
const { Server } = require(${JSON.stringify(join(sdkRoot, "server", "index.js"))});
const { StdioServerTransport } = require(${JSON.stringify(join(sdkRoot, "server", "stdio.js"))});
const { ListToolsRequestSchema } = require(${JSON.stringify(join(sdkRoot, "types.js"))});
const server = new Server({ name: "fixture", version: "3" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "lookup_ticket", description: "Find a ticket", inputSchema: { type: "object", properties: {} } },
    { name: "close_ticket", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.connect(new StdioServerTransport());
`;
}

test("a skill and a stdio MCP server added in the Capability Center land in Codara's own lists", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-add-capability-"));
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
      workspaces: [{ id: "ws-a", name: "Capabilities", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const fixture = join(root, "fixture-server.cjs");
  await writeFile(fixture, fixtureServerSource());

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("SPARK_PERSONAL_")) continue;
    if (!["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"].includes(key)) env[key] = value;
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
    await page.getByRole("button", { name: "Tools, skills and memory" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Capability Center" });
    await expect(dialog).toBeVisible();
    const footer = dialog.locator("footer");

    // ── A skill, written in the form ──────────────────────────────────────
    await dialog.getByRole("tab", { name: /^Skills/ }).click();
    await dialog.getByRole("button", { name: "Add skill" }).first().click();
    await dialog.getByLabel("Skill name").fill("ticket-triage");
    await dialog.getByLabel("Skill description").fill("Use when sorting new support tickets by urgency.");
    await dialog.getByLabel("Skill instructions").fill("# Ticket triage\n\n1. Read the ticket.\n2. Label it.");
    await page.screenshot({ path: testInfo.outputPath("add-skill-form.png") });
    await footer.getByRole("button", { name: "Add skill" }).click();
    await expect(dialog.getByRole("switch", { name: "Let Cora and workers use ticket-triage" })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("switch", { name: "Let Cora and workers use ticket-triage" })).toHaveAttribute("aria-checked", "true");
    const skillFile = await readFile(join(home, "skills", "ticket-triage", "SKILL.md"), "utf8");
    expect(skillFile).toContain("name: ticket-triage");
    expect(skillFile).toContain("1. Read the ticket.");

    // ── An MCP server, tested before it is added ──────────────────────────
    await dialog.getByRole("tab", { name: /^MCP servers/ }).click();
    await dialog.getByRole("button", { name: "Add server" }).first().click();
    await dialog.getByPlaceholder("my-server").fill("tickets");
    await dialog.getByPlaceholder("npx").fill(process.execPath);
    await dialog.getByPlaceholder("-y\n@scope/package").fill(fixture);
    await dialog.getByRole("button", { name: "Test connection" }).click();
    await expect(dialog.getByText("lookup_ticket", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("close_ticket", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("add-server-tested.png") });
    await footer.getByRole("button", { name: "Add server" }).click();

    await expect(dialog.getByRole("button", { name: "Test the connection to tickets" })).toBeVisible({ timeout: 20_000 });
    const saved = JSON.parse(await readFile(join(home, "mcp-servers.json"), "utf8"));
    expect(saved.mcpServers.tickets.command).toBe(process.execPath);
    expect(saved.mcpServers.tickets.args).toEqual([fixture]);
    if (process.platform !== "win32") expect((await stat(join(home, "mcp-servers.json"))).mode & 0o777).toBe(0o600);
    // The test from the list starts the saved server and lists its tools too.
    await dialog.getByRole("button", { name: "Test the connection to tickets" }).click();
    await expect(dialog.getByText("lookup_ticket", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("server-added.png") });

    // ── Nothing reached a CLI's config ────────────────────────────────────
    // The app's own boot work may create CLI folders in HOME; none of them
    // may mention the skill or the server.
    const mentions: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.name.includes("ticket")) mentions.push(full);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && /tickets|ticket-triage/.test(await readFile(full, "utf8").catch(() => ""))) mentions.push(full);
      }
    };
    await walk(userHome);
    expect(mentions).toEqual([]);
    await expect(stat(join(userHome, ".claude.json"))).rejects.toThrow();

    // ── The worker models page renders the discovered list ────────────────
    await dialog.getByRole("tab", { name: /^Worker models/ }).click();
    await expect(dialog.getByRole("group", { name: "Cora worker models" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Claude worker models" })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("worker-models.png") });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
