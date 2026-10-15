import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Workspace status as agents and the user set it. An agent in a terminal of
// one workspace sets its status and progress note through the codara-studio
// tool server over stdio, while another workspace is on screen: the note
// lands on the agent's own workspace, cleaned to one line, and the server's
// instructions tell it when to post. The user then sets and clears statuses
// from the row's right-click menu, by mouse and by keyboard, in a dark and a
// light theme; the statuses survive a restart, and a deleted workspace takes
// its status with it.

const ROOT = resolve(__dirname, "..", "..");

// An MCP client run inside a pane: it takes the pane's identity from the
// pane's environment, calls each tool in order and writes the initialize
// result and the replies to a file.
const PROBE = `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [serverJs, callsFile, outFile] = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));
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
  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "1" } });
  send({ method: "notifications/initialized" });
  const listed = await call(2, "tools/list", {});
  const out = { instructions: init.result.instructions, tools: listed.result.tools.map((tool) => tool.name), replies: [] };
  let id = 3;
  for (const [name, args] of calls) {
    const reply = await call(id++, "tools/call", { name, arguments: args });
    out.replies.push(reply.result);
  }
  fs.writeFileSync(outFile, JSON.stringify(out));
  child.kill();
  console.log("PROBE-DONE");
})();
`;

type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type ProbeOut = { instructions: string; tools: string[]; replies: ToolReply[] };

function body(reply: ToolReply): Record<string, any> {
  return JSON.parse(reply.content[0]?.text ?? "{}");
}

function row(page: Page, workspaceId: string) {
  return page.locator(`[data-workspace-id="${workspaceId}"]`);
}

async function openStatusPicker(page: Page, workspaceId: string) {
  await row(page, workspaceId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set status…", exact: true }).click();
  const picker = page.getByTestId("workspace-status-picker");
  await expect(picker).toBeVisible();
  return picker;
}

test("agents and the user set a workspace's status and progress note in the rail", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-workspace-status-"));
  const home = join(root, "home");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  await writeFile(join(root, "probe.cjs"), PROBE);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-alpha",
      workspaces: [
        { id: "ws-alpha", name: "Alpha", cwd: alpha, color: "#42D6C7", workers: [] },
        { id: "ws-beta", name: "Beta", cwd: beta, color: "#7FB3FF", workers: [] },
        { id: "ws-gamma", name: "Gamma", cwd: beta, color: "#F0C419", workers: [] },
      ],
    }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SPARK_NO_SHELL_INTEGRATION") env[key] = value;
  }
  const launch = () =>
    electron.launch({
      args: ["."],
      env: {
        ...env,
        SHELL: "/bin/bash",
        CODARA_HOME_DIR: home,
        SPARK_HOME_DIR: home,
        SPARK_USER_DATA_DIR: home,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
      },
    });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const statusFile = join(home, "workspace-status.json");
  const stored = async (): Promise<Record<string, any>> => {
    try {
      return JSON.parse(await readFile(statusFile, "utf8")).workspaces;
    } catch {
      return {};
    }
  };

  let app: ElectronApplication | null = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(row(page, "ws-alpha")).toBeVisible();
    await expect(row(page, "ws-alpha").getByTestId("workspace-status")).toHaveCount(0);

    // The agent's terminal belongs to Alpha; Beta is on screen when it posts.
    const pane = await request("terminal.create", { cwd: alpha, title: "agent" });
    await row(page, "ws-beta").click();
    await expect(row(page, "ws-beta")).toHaveAttribute("data-active", "true");

    const callsFile = join(root, "calls.json");
    const outFile = join(root, "out.json");
    await writeFile(
      callsFile,
      JSON.stringify([
        ["codara_workspace_status", { status: "in_progress", note: "Wiring the store\nand the rail" }],
        ["codara_workspace_status", { note: `\u001b[32mTests pass\u001b[0m\u202e ${"and more ".repeat(30)}` }],
        ["codara_workspace_status", {}],
        ["codara_workspace_status", { status: "shipped" }],
      ]),
    );
    const ran = await request("terminal.run", {
      paneId: pane.paneId,
      command: `node '${join(root, "probe.cjs")}' '${join(ROOT, "resources", "codara-studio-mcp", "server.js")}' '${callsFile}' '${outFile}'`,
      timeoutMs: 60_000,
    });
    expect(String(ran.output), ran.output).toContain("PROBE-DONE");
    const probe = JSON.parse(await readFile(outFile, "utf8")) as ProbeOut;
    expect(probe.tools).toContain("codara_workspace_status");
    expect(probe.instructions).toMatch(/codara_workspace_status.*note at each milestone.*blocked/);
    const [started, progressed, read, refused] = probe.replies;
    expect(started.isError, started.content[0]?.text).toBeFalsy();
    expect(body(started)).toMatchObject({
      workspaceId: "ws-alpha",
      workspace: "Alpha",
      status: "in_progress",
      statusLabel: "In progress",
      note: "Wiring the store and the rail",
      by: "Codex",
      updated: true,
    });
    const cut = body(progressed);
    expect(cut.noteTruncated).toBe(true);
    expect(cut.note.startsWith("Tests pass and more")).toBe(true);
    expect(Array.from(cut.note as string)).toHaveLength(140);
    expect(cut.note).not.toMatch(/[\u001b\u202e]/);
    expect(body(read).checkpoints.map((checkpoint: { status: string }) => checkpoint.status)).toEqual(["in_progress", "in_progress"]);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/status must be one of todo, in_progress, in_review, done, blocked/);

    // The rail shows it on the agent's workspace only.
    const alphaStatus = row(page, "ws-alpha").getByTestId("workspace-status");
    await expect(alphaStatus.getByTestId("workspace-status-chip")).toHaveText("In progress");
    await expect(alphaStatus.getByTestId("workspace-status-note")).toHaveText(cut.note);
    await expect(alphaStatus).toHaveAttribute("title", /^In progress\. Tests pass .*Set by Codex just now\.$/);
    await expect(row(page, "ws-beta").getByTestId("workspace-status")).toHaveCount(0);
    expect(Object.keys(await stored())).toEqual(["ws-alpha"]);

    // By hand, with the mouse: right-click, pick Blocked, write why, save.
    let picker = await openStatusPicker(page, "ws-alpha");
    await expect(picker.getByRole("option", { name: "In progress" })).toHaveAttribute("aria-selected", "true");
    await expect(picker.getByTestId("workspace-status-checkpoints").locator("li")).toHaveCount(2);
    await picker.getByRole("option", { name: "Blocked" }).click();
    await picker.getByRole("textbox", { name: "Progress note" }).fill("Waiting on the API key");
    await picker.getByRole("button", { name: "Save" }).click();
    await expect(picker).toHaveCount(0);
    await expect(alphaStatus.getByTestId("workspace-status-chip")).toHaveText("Blocked");
    await expect(alphaStatus.getByTestId("workspace-status-note")).toHaveText("Waiting on the API key");
    await expect(row(page, "ws-beta")).toHaveAttribute("data-active", "true", { timeout: 1_000 });
    await expect.poll(async () => (await stored())["ws-alpha"]?.by?.label).toBe("You");

    // By keyboard on Beta: the list's tab stop is the first status, the
    // arrows walk it, Enter picks, Tab reaches the note, Enter saves.
    picker = await openStatusPicker(page, "ws-beta");
    await expect(picker.getByRole("option", { name: "To do" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(picker.getByRole("option", { name: "In review" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker.getByRole("option", { name: "In review" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await expect(picker.getByRole("textbox", { name: "Progress note" })).toBeFocused();
    // Home and End edit the text instead of moving focus to the list.
    await page.keyboard.type("PR open");
    await page.keyboard.press("Home");
    await expect(picker.getByRole("textbox", { name: "Progress note" })).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" for review");
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    // Focus goes back to the row's actions button, not to the page body.
    await expect(row(page, "ws-beta").getByRole("button", { name: "Workspace actions" })).toBeFocused();
    const betaStatus = row(page, "ws-beta").getByTestId("workspace-status");
    await expect(betaStatus.getByTestId("workspace-status-chip")).toHaveText("In review");
    await expect(betaStatus.getByTestId("workspace-status-note")).toHaveText("PR open for review");

    // Escape closes without saving.
    picker = await openStatusPicker(page, "ws-gamma");
    await picker.getByRole("option", { name: "Done" }).click();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(row(page, "ws-gamma").getByRole("button", { name: "Workspace actions" })).toBeFocused();
    await expect(row(page, "ws-gamma").getByTestId("workspace-status")).toHaveCount(0);
    await openStatusPicker(page, "ws-gamma");
    await page.getByTestId("workspace-status-picker").getByRole("option", { name: "Done" }).click();
    await page.getByTestId("workspace-status-picker").getByRole("button", { name: "Save" }).click();
    await expect(row(page, "ws-gamma").getByTestId("workspace-status-chip")).toHaveText("Done");

    // Each status keeps its own tone in a dark and a light theme, and the
    // chip stays readable on the rail in both.
    for (const theme of ["dracula", "github-light"] as const) {
      await page.evaluate((name) => window.spark.preferences.set("theme", name), theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      const colors = await page.getByTestId("workspace-status-chip").evaluateAll((chips) =>
        chips.map((chip) => [chip.getAttribute("data-status"), getComputedStyle(chip).color]),
      );
      expect(new Set(colors.map(([, color]) => color)).size, `${theme}: ${JSON.stringify(colors)}`).toBe(3);
    }

    // Clear status from the right-click menu.
    await row(page, "ws-gamma").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Clear status", exact: true }).click();
    await expect(row(page, "ws-gamma").getByTestId("workspace-status")).toHaveCount(0);
    await expect.poll(async () => Object.keys(await stored()).sort()).toEqual(["ws-alpha", "ws-beta"]);

    // An agent posting while the picker is open shows in it, and Save sends
    // only what the user changed, so the agent's newer status stays.
    picker = await openStatusPicker(page, "ws-alpha");
    await expect(picker.getByRole("option", { name: "Blocked" })).toHaveAttribute("aria-selected", "true");
    await request("workspace.status", { callerPaneId: pane.paneId, callerClient: "claude-code", status: "in_review" });
    await expect(picker.getByRole("option", { name: "In review" })).toHaveAttribute("aria-selected", "true");
    await expect(picker.getByTestId("workspace-status-checkpoints").locator("li").first()).toContainText("Claude Code");
    await picker.getByRole("textbox", { name: "Progress note" }).fill("API key added");
    await picker.getByRole("button", { name: "Save" }).click();
    await expect(picker).toHaveCount(0);
    await expect(alphaStatus.getByTestId("workspace-status-chip")).toHaveText("In review");
    await expect(alphaStatus.getByTestId("workspace-status-note")).toHaveText("API key added");

    // A restart keeps them.
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(row(page, "ws-alpha").getByTestId("workspace-status-chip")).toHaveText("In review");
    await expect(row(page, "ws-beta").getByTestId("workspace-status-note")).toHaveText("PR open for review");

    // Deleting a workspace drops its status.
    await row(page, "ws-beta").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(row(page, "ws-beta")).toHaveCount(0);
    await expect.poll(async () => Object.keys(await stored())).toEqual(["ws-alpha"]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
