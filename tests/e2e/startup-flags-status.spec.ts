import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Startup flags set in Settings reach an agent CLI typed in a Codara pane,
// after Codara's own, and nothing is written into the CLI's home. Stand-in
// CLIs on PATH print the argv they got, so no real agent runs. Then an MCP
// client started from that pane says hello and opens a browser tab, and the
// status view shows the session as connected, with its tab, for any client
// name rather than only the runtimes Codara knows.

const ROOT = resolve(__dirname, "..", "..");

const PROBE = `const { spawn } = require("node:child_process");
const [serverJs, url] = process.argv.slice(2);
const child = spawn(process.execPath, [serverJs], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (waiting.has(message.id)) waiting.get(message.id)(message);
  }
});
const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const call = (id, method, params) => new Promise((done) => { waiting.set(id, done); send({ id, method, params }); });
(async () => {
  await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-probe", version: "1" } });
  send({ method: "notifications/initialized" });
  const opened = await call(2, "tools/call", { name: "codara_preview_navigate", arguments: { url } });
  console.log(opened.result && !opened.result.isError ? "PROBE-NAVIGATED" : "PROBE-FAILED " + JSON.stringify(opened));
  setTimeout(() => { child.kill(); process.exit(0); }, 120000);
})();
`;

async function openAccountsSettings(page: Page) {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.locator("nav").getByRole("button", { name: "Accounts", exact: true }).click({ force: true });
  return dialog;
}

test("startup flags reach a typed agent CLI and the status view shows a connected session with its tab", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-startup-flags-"));
  const userHome = join(root, "home");
  const home = join(root, "codara-home");
  const claudeHome = join(root, "claude-home");
  const grokHome = join(root, "grok-home");
  const bin = join(root, "bin");
  const cwd = join(root, "workspace");
  await Promise.all([userHome, home, claudeHome, grokHome, bin, cwd].map((dir) => mkdir(dir, { recursive: true })));
  for (const cli of ["claude", "grok"]) {
    const file = join(bin, cli);
    await writeFile(file, `#!/bin/sh\nprintf '${cli.toUpperCase()}-ARGV'\nfor a in "$@"; do printf ' [%s]' "$a"; done\necho\n`);
    await chmod(file, 0o755);
  }
  await writeFile(join(cwd, "probe.cjs"), PROBE);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-flags",
      workspaces: [{ id: "ws-flags", name: "Flags", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const fixture: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Probe page</title><h1>Probe page</h1>");
  });
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", () => done()));
  const address = fixture.address();
  const pageUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SPARK_NO_SHELL_INTEGRATION") env[key] = value;
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      SHELL: "/bin/bash",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: claudeHome,
      GROK_HOME: grokHome,
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-flags"]')).toBeVisible();

    const settings = await openAccountsSettings(page);
    const chrome = settings.getByRole("switch", { name: "Connect to Chrome" });
    await chrome.click();
    await expect(chrome).toHaveAttribute("aria-checked", "true");
    const claudeFlags = settings.getByRole("textbox", { name: "Claude Code flags" });
    await claudeFlags.fill(`--model opus --append-system-prompt "be brief"`);
    await claudeFlags.press("Enter");
    const grokFlags = settings.getByRole("textbox", { name: "Grok flags" });
    await grokFlags.fill("--verbose; rm -rf /");
    await expect(settings.getByRole("alert")).toContainText("shell syntax");
    await grokFlags.fill("--disable-web-search");
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await grokFlags.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.spark.servers.launchArgs.get()))
      .toEqual({ args: { claude: `--model opus --append-system-prompt "be brief"`, grok: "--disable-web-search" }, claudeChrome: true });
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    // A CLI typed in a pane gets Codara's flags, then the ones from Settings, then the user's.
    const pane = await request("terminal.create", { cwd, title: "agent" });
    const claude = await request("terminal.run", { paneId: pane.paneId, command: "claude --resume abc", timeoutMs: 30_000 });
    const claudeLine = String(claude.output).split("\n").find((line) => line.includes("CLAUDE-ARGV")) ?? "";
    expect(claudeLine, claude.output).toMatch(/\[--mcp-config=[^\]]+\].*\[--model\] \[opus\] \[--append-system-prompt\] \[be brief\] \[--chrome\] \[--resume\] \[abc\]$/);
    const grok = await request("terminal.run", { paneId: pane.paneId, command: "grok hello", timeoutMs: 30_000 });
    expect(String(grok.output), grok.output).toContain("GROK-ARGV [--disable-web-search] [hello]");
    const grokHelp = await request("terminal.run", { paneId: pane.paneId, command: "grok models", timeoutMs: 30_000 });
    expect(String(grokHelp.output), grokHelp.output).toContain("GROK-ARGV [models]");
    // Per launch only: the CLIs' own homes stay empty.
    expect(await readdir(claudeHome)).toEqual([]);
    expect(await readdir(grokHome)).toEqual([]);

    // An MCP client from this pane, under a name Codara does not know.
    await request("terminal.write", {
      paneId: pane.paneId,
      text: `node probe.cjs '${join(ROOT, "resources", "codara-studio-mcp", "server.js")}' '${pageUrl}'`,
    });
    await expect
      .poll(
        async () => {
          const snapshot = await page.evaluate(() => window.spark.servers.status("ws-flags"));
          return snapshot.agents.map((agent) => `${agent.paneId}:${agent.client}:${agent.toolsConnected}`);
        },
        { timeout: 45_000 },
      )
      .toEqual([`${pane.paneId}:e2e-probe:true`]);

    await page.getByRole("button", { name: /^Status:/ }).click();
    const popover = page.getByRole("dialog", { name: "Status of Flags" });
    await expect(popover).toBeVisible();
    const agent = popover.locator(`[data-agent-pane="${pane.paneId}"]`);
    await expect(agent).toContainText("Codara tools connected");
    await expect(agent).toContainText("1 browser tab", { timeout: 30_000 });
    await expect(agent.locator(".status-pop__tabs")).toContainText("Probe page");
    await expect(agent.getByRole("button", { name: /^Copy tab id: / })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  } finally {
    await app.close();
    await new Promise((done) => fixture.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
