import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A workspace's status line and its agent lines in the rail, against a
// throwaway Codara home and a fake user home. Three Claude Code stand-ins
// share one workspace: two work (one posts a note through the real agent
// socket, as codara_workspace_status does), one waits on a permission. The
// row counts them in its number and names the waiting one in its line, its chevron lists each agent under it with its
// own state and note, clicking the waiting one opens its pane, and clicking
// the summary opens the row like any other click on it. The number at the
// row's right edge is the one count of agents ("2/3"); the line under the
// name says only what needs the user (DESIGN.md, "One home for agent counts").
// AGENT_STATUS_SHOTS=<dir> also saves the row collapsed and expanded there.

interface Fixture {
  root: string;
  env: Record<string, string>;
  workingClaude: string;
  notingClaude: string;
  askingClaude: string;
}

const STATUS_HEADER = String.raw`
  const out = (text) => process.stdout.write(text);
  const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  out("Claude Code v2.1.300\r\n> ");
  status("state=idle");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  setTimeout(() => process.exit(0), 180000);
`;

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-agent-status-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const cwdA = join(root, "projects", "codara-studio");
  const cwdB = join(root, "projects", "playground");
  await Promise.all([home, userHome, binDir, cwdA, cwdB].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-a", name: "codara-studio", cwd: cwdA, color: "#34D3C3", workers: [] },
        { id: "ws-b", name: "playground", cwd: cwdB, color: "#78A8FF", workers: [] },
      ],
      activeWorkspaceId: "ws-a",
    }),
    "utf8",
  );

  const workingClaude = join(binDir, "working-claude.js");
  await writeFile(
    workingClaude,
    STATUS_HEADER +
      String.raw`
      process.stdin.on("data", (data) => {
        if (data.includes("\x03")) process.exit(0);
        if (data.includes("\r")) status("state=working");
      });
    `,
    "utf8",
  );
  // Works, and posts its note the way the codara-studio MCP server does:
  // workspace.status on the agent socket, from its own pane.
  const notingClaude = join(binDir, "noting-claude.js");
  await writeFile(
    notingClaude,
    STATUS_HEADER +
      String.raw`
      const fs = require("node:fs");
      const http = require("node:http");
      const path = require("node:path");
      function postNote(note) {
        const handshake = JSON.parse(fs.readFileSync(path.join(process.env.SPARK_HOME_DIR, "agent-socket.json"), "utf8"));
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "workspace.status",
          params: { status: "in_progress", note, callerPaneId: process.env.SPARK_PANE_ID, callerPid: process.pid, callerClient: "claude-code" },
        });
        const target = new URL(handshake.url + "/rpc");
        const req = http.request({
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: "Bearer " + handshake.token },
        }, (res) => res.resume());
        req.on("error", () => undefined);
        req.end(body);
      }
      process.stdin.on("data", (data) => {
        if (data.includes("\x03")) process.exit(0);
        if (!data.includes("\r")) return;
        status("state=working");
        setTimeout(() => postNote("Wiring the rail summary line"), 500);
      });
    `,
    "utf8",
  );
  const askingClaude = join(binDir, "asking-claude.js");
  await writeFile(
    askingClaude,
    STATUS_HEADER +
      String.raw`
      process.stdin.on("data", (data) => {
        if (data.includes("\x03")) process.exit(0);
        if (!data.includes("\r")) return;
        status("state=working");
        setTimeout(() => status("state=blocked:kind=permission:msg=" + b64("Allow npm test?")), 800);
      });
    `,
    "utf8",
  );
  const shell = join(binDir, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', "utf8");
  await chmod(shell, 0o755);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    root,
    workingClaude,
    notingClaude,
    askingClaude,
    env: {
      ...env,
      HOME: userHome,
      USERPROFILE: userHome,
      SHELL: shell,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CODEX_HOME: join(userHome, ".codex"),
      GROK_HOME: join(userHome, ".grok"),
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  };
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ["."], env: fixture.env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });
  return { app, page };
}

const row = (page: Page, workspaceId: string) => page.locator(`[data-workspace-id="${workspaceId}"]`);
const children = (page: Page, workspaceId: string) => page.locator(`[data-rail-children-of="${workspaceId}"]`);

async function startAgent(page: Page, paneId: string, script: string): Promise<string> {
  const pane = page.locator(`[data-terminal-pane-id="${paneId}"]:visible`);
  const input = pane.locator(".xterm-helper-textarea");
  // Typed keys go to whichever pane has focus: wait for the focus to land,
  // so a busy machine cannot send them to the pane focused before.
  await expect(async () => {
    await input.focus();
    await expect(input).toBeFocused({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await input.pressSequentially(`"${process.execPath}" "${script}"`, { delay: 2 });
  await input.press("Enter");
  // The pane's own agent chip says Codara recognized the agent there.
  await expect(pane).toContainText(/claude/i, { timeout: 20_000 });
  return paneId;
}

async function prompt(page: Page, paneId: string, text: string): Promise<void> {
  const input = page.locator(`[data-terminal-pane-id="${paneId}"]:visible .xterm-helper-textarea`).first();
  await input.focus();
  await input.pressSequentially(text, { delay: 2 });
  await input.press("Enter");
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.AGENT_STATUS_SHOTS;
  const path = dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  const rail = page.locator("aside").first();
  await rail.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test("a workspace counts its agents in its number, says what needs you in one line and lists each agent's own state and note", async () => {
  test.skip(process.platform === "win32", "the fake agents are started from a POSIX shell");
  test.setTimeout(150_000);
  const fixture = await prepare();
  const { app, page } = await launch(fixture);
  try {
    const panes: string[] = [];
    await test.step("start three agents in one workspace", async () => {
      await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
      await expect(page.locator("[data-terminal-pane-id]:visible")).toHaveCount(1);
      const visiblePanes = page.locator("[data-terminal-pane-id]:visible");
      const scripts = [fixture.notingClaude, fixture.workingClaude, fixture.askingClaude];
      for (let i = 0; i < scripts.length; i += 1) {
        if (i > 0) {
          // A new pane takes the focus once its terminal starts, so each
          // agent starts in its own pane before the next split, never while
          // one is still opening. A terminal still starting can miss the
          // shortcut; press again only while the pane has not appeared.
          await expect(async () => {
            if ((await visiblePanes.count()) <= i) {
              await page.locator(`[data-terminal-pane-id="${panes[i - 1]}"]:visible .xterm-helper-textarea`).focus();
              await page.keyboard.press("Control+Alt+d");
            }
            await expect(visiblePanes).toHaveCount(i + 1, { timeout: 2_000 });
          }).toPass({ timeout: 20_000 });
        }
        const ids = await visiblePanes.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-terminal-pane-id") ?? ""));
        const fresh = ids.find((id) => id && !panes.includes(id));
        expect(fresh).toBeTruthy();
        panes.push(await startAgent(page, fresh!, scripts[i]));
      }
      await expect(row(page, "ws-a").getByTestId("workspace-agent-count")).toHaveText("3", { timeout: 20_000 });
      for (const paneId of panes) await prompt(page, paneId, "go");
    });

    const summary = row(page, "ws-a").getByTestId("workspace-agents-summary");
    await test.step("the row says it in one line", async () => {
      // Look elsewhere, as you would while they work.
      await row(page, "ws-b").evaluate((element) => (element as HTMLElement).click());
      await expect(row(page, "ws-b")).toHaveAttribute("data-active", "true");
      const count = row(page, "ws-a").getByTestId("workspace-agent-count");
      await expect(count).toHaveText("2/3", { timeout: 20_000 });
      await expect(count).toHaveAttribute("aria-label", "2 of 3 agents working");
      await expect(summary).toHaveText("1 needs you", { timeout: 20_000 });
      await expect(summary.locator('[data-part="needs-you"]')).toHaveText("1 needs you");
      await expect(summary).toHaveAttribute("data-needs-you", "true");
      // The full account stays on hover.
      await expect(summary).toHaveAttribute("title", /3 agents: 1 needs you, 2 working\./);
      await expect(children(page, "ws-a")).toHaveCount(0);
      await shot(page, "rail-collapsed");
    });

    await test.step("the chevron lists each agent on its own line, without opening the row", async () => {
      const toggle = row(page, "ws-a").getByTestId("workspace-children-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(row(page, "ws-b")).toHaveAttribute("data-active", "true");
      const lines = children(page, "ws-a").getByTestId("workspace-agent-line");
      await expect(lines).toHaveCount(3);
      await expect(lines.nth(0)).toHaveAttribute("data-state", "needs-you");
      await expect(lines.nth(0)).toContainText("Allow npm test?");
      await expect(children(page, "ws-a").locator('[data-state="working"]')).toHaveCount(2);
      await expect(children(page, "ws-a").locator('[data-state="working"]').filter({ hasText: "Wiring the rail summary line" })).toHaveCount(
        1,
        { timeout: 10_000 },
      );
      await shot(page, "rail-expanded");
    });

    await test.step("clicking the waiting agent opens its pane", async () => {
      await children(page, "ws-a").locator('[data-testid="workspace-agent-line"][data-state="needs-you"]').click();
      await expect(row(page, "ws-a")).toHaveAttribute("data-active", "true");
      await expect(page.locator(`[data-terminal-pane-id="${panes[2]}"]:visible`)).toBeVisible();
    });

    await test.step("clicking the summary opens the row", async () => {
      await row(page, "ws-b").evaluate((element) => (element as HTMLElement).click());
      await expect(row(page, "ws-b")).toHaveAttribute("data-active", "true");
      await summary.click();
      await expect(row(page, "ws-a")).toHaveAttribute("data-active", "true");
      await expect(children(page, "ws-a").getByTestId("workspace-agent-line")).toHaveCount(3);
    });
  } finally {
    await app.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
