import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rail's Agents view against a throwaway Codara home and a fake user
// home (no real ~/.claude, shell startup file or account is read or
// written). A fake Claude Code drives its pane through OSC 7501 program
// status: it lands in the inbox as Input in another workspace with its
// question in the row's tooltip, the row opens its pane where it is
// answered; then it stops with an error (Failed), finishes with its last
// message, and opening the row brings its pane back. A seeded blocked Cora
// chat waits as Input with Cora's mark; the switch works from the keyboard
// and is remembered on reload. agent-inbox.spec.ts covers the shelves,
// settle, snooze, undo and merge.

const MINUTE = 60_000;
const RUN_ID = "run-agents-view";
const QUESTION_ID = "msg-agents-question";

interface Fixture {
  root: string;
  home: string;
  env: Record<string, string>;
  fakeClaude: string;
  /** A Claude Code stand-in that starts working on its first prompt and stays there. */
  busyClaude: string;
  /**
   * A Claude Code stand-in whose first turn ends with a background agent
   * still running; the next prompt lets that agent finish.
   */
  backgroundClaude: string;
}

async function prepare(opts: { blockedRun?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-agent-board-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const cwdA = join(root, "projects", "alpha");
  const cwdB = join(root, "projects", "beta");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(cwdA, { recursive: true }),
    mkdir(cwdB, { recursive: true }),
  ]);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-a", name: "alpha", cwd: cwdA, color: "#34D3C3", workers: [] },
        { id: "ws-b", name: "beta", cwd: cwdB, color: "#78A8FF", workers: [] },
      ],
      activeWorkspaceId: "ws-a",
    }),
    "utf8",
  );
  if (opts.blockedRun) await seedBlockedRun(home, cwdB);

  // A Claude Code stand-in: waits for a prompt, works, asks a question
  // through OSC 7501, stops with an error once it is answered, and finishes
  // on the next prompt (typed or pasted).
  const fakeClaude = join(binDir, "claude.js");
  await writeFile(
    fakeClaude,
    String.raw`
      const out = (text) => process.stdout.write(text);
      const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
      const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
      out("Claude Code v2.1.300\r\n> ");
      status("state=idle");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let buffer = "";
      let phase = "prompt";
      process.stdin.on("data", (data) => {
        const text = data.toString("utf8");
        if (text.includes("\x03")) process.exit(0);
        buffer += text;
        if (!buffer.includes("\r")) return;
        const line = buffer.replace(/\x1b\[20[01]~/g, "").split("\r")[0].trim();
        buffer = "";
        if (phase === "prompt") {
          phase = "question";
          out("\r\nprompt: " + line + "\r\n");
          status("state=working");
          setTimeout(() => status("state=blocked:kind=question:msg=" + b64("Deploy to production?")), 1500);
        } else if (phase === "question") {
          phase = "error";
          out("\r\nanswer: " + line + "\r\n");
          status("state=working");
          setTimeout(() => {
            out("Rate limited.\r\n> ");
            status("state=error:msg=" + b64("Rate limited, try again."));
          }, 1500);
        } else if (phase === "error") {
          phase = "done";
          out("\r\ngot: " + line + "\r\n");
          status("state=working");
          setTimeout(() => {
            out("Shipped.\r\n> ");
            status("state=done:msg=" + b64("Shipped after you said " + line + "."));
          }, 1500);
        }
      });
      setTimeout(() => process.exit(0), 120000);
    `,
    "utf8",
  );
  const busyClaude = join(binDir, "busy-claude.js");
  await writeFile(
    busyClaude,
    String.raw`
      const status = (fields) => process.stdout.write("\x1b]7501;app=claude:" + fields + "\x07");
      process.stdout.write("Claude Code v2.1.300\r\n> ");
      status("state=idle");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (data) => {
        const text = data.toString("utf8");
        if (text.includes("\x03")) process.exit(0);
        if (text.includes("\r")) status("state=working");
      });
      setTimeout(() => process.exit(0), 120000);
    `,
    "utf8",
  );
  const backgroundClaude = join(binDir, "background-claude.js");
  await writeFile(
    backgroundClaude,
    String.raw`
      const out = (text) => process.stdout.write(text);
      const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
      const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
      out("Claude Code v2.1.301\r\n> ");
      status("state=idle");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let buffer = "";
      let phase = "prompt";
      process.stdin.on("data", (data) => {
        const text = data.toString("utf8");
        if (text.includes("\x03")) process.exit(0);
        buffer += text;
        if (!buffer.includes("\r")) return;
        buffer = "";
        if (phase === "prompt") {
          phase = "background";
          status("state=working");
          setTimeout(() => {
            status("state=working:id=a1b2c3:title=" + b64("Review the parser"));
            out("A reviewer is on it.\r\n> ");
            status("state=done:msg=" + b64("A reviewer is on it."));
          }, 1000);
        } else if (phase === "background") {
          phase = "over";
          status("state=working");
          setTimeout(() => {
            status("state=clear:id=a1b2c3");
            out("The review found nothing.\r\n> ");
            status("state=done:msg=" + b64("The review found nothing."));
          }, 1000);
        }
      });
      setTimeout(() => process.exit(0), 120000);
    `,
    "utf8",
  );
  // Keep the pane's shell away from any startup file.
  const shell = join(binDir, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', "utf8");
  await chmod(shell, 0o755);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    root,
    home,
    fakeClaude,
    busyClaude,
    backgroundClaude,
    env: {
      ...env,
      HOME: userHome,
      // Windows reads the home folder from here, not HOME.
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

async function seedBlockedRun(home: string, cwd: string): Promise<void> {
  const runDir = join(home, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  const at = new Date(Date.now() - 10 * MINUTE).toISOString();
  const run = {
    id: RUN_ID,
    workspaceId: "ws-b",
    title: "Pick a database",
    status: "blocked",
    settingsSnapshot: { workspaceCwd: cwd },
    artifactDir: runDir,
    createdAt: at,
    updatedAt: at,
    conversationEpoch: 0,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    checkpoints: [],
    assumptions: [],
    sparkCalls: [],
    humanMessages: [
      {
        id: QUESTION_ID,
        runId: RUN_ID,
        author: "spark",
        kind: "question",
        message: "Postgres or SQLite for the session store?",
        questionOptions: [
          { id: "pg", label: "Postgres", answer: "Use Postgres.", recommended: true },
          { id: "lite", label: "SQLite", answer: "Use SQLite." },
        ],
        createdAt: at,
      },
    ],
    chatBackend: "pi",
    chatMode: "auto",
  };
  await writeFile(join(runDir, "run.json"), JSON.stringify(run), "utf8");
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ["."], env: fixture.env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await ready(page);
  return { app, page };
}

const ready = (page: Page) =>
  expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });

const viewTab = (page: Page, name: "Workspaces" | "Agents") =>
  page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: new RegExp(`^${name}`) });

const card = (page: Page, key: string) => page.locator(`[data-agent-card="${key}"]`);

test("a terminal agent in another workspace is answered from the Agents view", async () => {
  test.setTimeout(120_000);
  const fixture = await prepare();
  const { app, page } = await launch(fixture);
  try {
    await expect(viewTab(page, "Workspaces")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();

    let paneId = "";
    await test.step("start the agent in alpha, then leave for beta", async () => {
      await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
      const input = page.locator(".xterm-helper-textarea:visible").first();
      await input.focus();
      // PowerShell, Codara's shell on Windows, runs a quoted path only with &.
      const call = process.platform === "win32" ? "& " : "";
      await input.pressSequentially(`${call}"${process.execPath}" "${fixture.fakeClaude}"`, { delay: 2 });
      await input.press("Enter");
      // Main has identified the agent once the workspace counts it.
      await expect(page.locator('[data-workspace-id="ws-a"]').getByTestId("workspace-agent-count")).toHaveText("1", {
        timeout: 15_000,
      });
      paneId = (await page.locator("[data-terminal-pane-id]:visible").first().getAttribute("data-terminal-pane-id")) ?? "";
      expect(paneId).toBeTruthy();
      await input.pressSequentially("ship the release", { delay: 2 });
      await input.press("Enter");
      await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
      await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
    });

    await test.step("the switch counts the agent waiting on you", async () => {
      await expect(viewTab(page, "Agents")).toHaveAccessibleName("Agents, 1 needs you", { timeout: 15_000 });
    });

    const agent = card(page, `pane:${paneId}`);
    const open = agent.locator("[data-agent-card-open]");
    await test.step("the Agents view puts it in the inbox as Input with its question", async () => {
      await viewTab(page, "Agents").click();
      await expect(viewTab(page, "Agents")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-workspace-id="ws-a"]')).toHaveCount(0);
      await expect(agent).toHaveAttribute("data-agent-bucket", "needs-you");
      await expect(agent).toHaveAttribute("data-agent-shelf", "inbox");
      await expect(agent).toHaveAttribute("data-agent-workspace", "ws-a");
      await expect(agent.locator(".agent-inbox-row__status")).toHaveText("Input");
      await expect(open).toHaveAttribute("title", "Deploy to production?");
      await expect(agent).toContainText("alpha");
      // Claude Code is the default agent: no mark, and its name is not
      // repeated as text; a screen reader still hears it.
      await expect(agent.locator("[data-agent-runtime]")).toHaveCount(0);
      await expect(agent).not.toContainText("Claude Code");
      await expect(open).toHaveAccessibleName(/Claude Code in alpha/);
    });

    await test.step("a question in a terminal is answered in its pane, never pasted into", async () => {
      // No text box on the row: pasted text and Enter would pick a real
      // menu's highlighted answer without the user choosing it.
      await expect(agent.getByRole("textbox")).toHaveCount(0);
      await open.click();
      await expect(open).toHaveAttribute("aria-current", "true");
      const input = page.locator(`[data-terminal-pane-id="${paneId}"]:visible .xterm-helper-textarea`).first();
      await input.focus();
      await input.pressSequentially("yes", { delay: 2 });
      await input.press("Enter");
      await expect(agent).not.toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
    });

    await test.step("an agent stopped by an error reads Failed and is answered in its pane", async () => {
      await expect(agent).toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      await expect(agent.locator(".agent-inbox-row__status")).toHaveText("Failed");
      await expect(open).toHaveAttribute("title", "Rate limited, try again.");
      const input = page.locator(`[data-terminal-pane-id="${paneId}"]:visible .xterm-helper-textarea`).first();
      await input.focus();
      await input.pressSequentially("try again", { delay: 2 });
      await input.press("Enter");
      await expect(agent).not.toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
    });

    await test.step("the finished agent stays in the inbox with its last message", async () => {
      await expect(agent).toHaveAttribute("data-agent-bucket", "done", { timeout: 15_000 });
      await expect(agent).toHaveAttribute("data-agent-shelf", "inbox");
      await expect(open).toHaveAttribute("title", "Shipped after you said try again.");
      await expect(agent.locator(".agent-inbox-row__line.is-meta")).toContainText("Shipped after you said try again.");
      await expect(viewTab(page, "Agents")).toHaveAccessibleName("Agents");
    });

    await test.step("opening the card switches workspace and focuses the pane", async () => {
      await viewTab(page, "Workspaces").click();
      await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
      await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
      await viewTab(page, "Agents").click();
      await expect(open).not.toHaveAttribute("aria-current", "true");
      await open.click();
      await expect(open).toHaveAttribute("aria-current", "true");
      // The switch says where you landed, as a switch from the rail does.
      await expect(page.getByTestId("workspace-switch-hud")).toContainText("alpha");
      const pane = page.locator(`[data-terminal-pane-id="${paneId}"]:visible`);
      await expect(pane).toBeVisible();
      await viewTab(page, "Workspaces").click();
      await expect(page.locator('[data-workspace-id="ws-a"]')).toHaveAttribute("data-active", "true");
    });
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a waiting Cora chat opens from its row, by keyboard, and the view is remembered", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare({ blockedRun: true });
  const { app, page } = await launch(fixture);
  try {
    const chat = card(page, `run:${RUN_ID}`);

    await test.step("the switch works from the keyboard", async () => {
      await viewTab(page, "Workspaces").focus();
      await page.keyboard.press("ArrowRight");
      await expect(viewTab(page, "Agents")).toHaveAttribute("aria-selected", "true");
      await expect(viewTab(page, "Agents")).toBeFocused();
    });

    await test.step("the blocked chat waits in the inbox as Input, with Cora's mark", async () => {
      await expect(chat).toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      await expect(chat.locator(".agent-inbox-row__status")).toHaveText("Input");
      await expect(chat.locator("[data-agent-card-open]")).toHaveAttribute("title", "Postgres or SQLite for the session store?");
      await expect(chat).toContainText("Pick a database");
      // Cora is not the default agent, so its row carries its mark.
      await expect(chat.locator('[data-agent-runtime="cora"]')).toHaveAttribute("aria-label", "Cora");
      await expect(chat).toContainText("beta");
    });

    await test.step("Tab reaches the row and Enter opens its chat in its workspace", async () => {
      await viewTab(page, "Agents").focus();
      await page.keyboard.press("Tab");
      await expect(chat.locator("[data-agent-card-open]")).toBeFocused();
      await page.keyboard.press("Enter");
      await viewTab(page, "Workspaces").click();
      await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true", { timeout: 10_000 });
    });

    await test.step("the chosen view survives a reload", async () => {
      await viewTab(page, "Agents").click();
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await ready(page);
      await expect(viewTab(page, "Agents")).toHaveAttribute("aria-selected", "true");
      await expect(chat).toBeVisible({ timeout: 15_000 });
      await viewTab(page, "Workspaces").click();
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await ready(page);
      await expect(viewTab(page, "Workspaces")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();
    });

    await test.step("a new folder from the Agents view shows the list to name it in", async () => {
      await viewTab(page, "Agents").click();
      await page.getByTitle("New…").click({ force: true });
      await page.getByRole("menuitem", { name: "New folder", exact: true }).click({ force: true });
      await expect(viewTab(page, "Workspaces")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("Workspace folder name")).toBeFocused();
    });

    await test.step("a new workspace from the Agents view shows the list to name it in", async () => {
      const gamma = join(fixture.root, "projects", "gamma");
      await mkdir(gamma, { recursive: true });
      // The folder picker is a native dialog; it answers with the fixture folder.
      await expect(async () => {
        await app.evaluate(({ ipcMain }, folder) => {
          ipcMain.removeHandler("dialog:openDirectory");
          ipcMain.handle("dialog:openDirectory", async () => folder);
        }, gamma);
      }).toPass({ timeout: 20_000 });
      await viewTab(page, "Agents").click();
      await expect(viewTab(page, "Agents")).toHaveAttribute("aria-selected", "true");
      await page.getByTitle("New…").click({ force: true });
      await page.getByRole("menuitem", { name: "New workspace…", exact: true }).click({ force: true });
      await expect(viewTab(page, "Workspaces")).toHaveAttribute("aria-selected", "true");
      // The new row's name box is open and focused, not hidden behind the view.
      const name = page.locator("[data-workspace-id]").getByRole("textbox");
      await expect(name).toHaveValue("gamma");
      await expect(name).toBeFocused();
    });
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("opening a row from another workspace goes there and says where you are", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare({ blockedRun: true });
  const { app, page } = await launch(fixture);
  try {
    // Restoring the last workspace on start is not a switch.
    await expect(page.locator('[data-workspace-id="ws-a"]')).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("workspace-switch-hud")).toHaveCount(0);

    await test.step("an agent works in alpha while a Cora chat waits in beta", async () => {
      await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
      const input = page.locator(".xterm-helper-textarea:visible").first();
      await input.focus();
      const call = process.platform === "win32" ? "& " : "";
      await input.pressSequentially(`${call}"${process.execPath}" "${fixture.busyClaude}"`, { delay: 2 });
      await input.press("Enter");
      await expect(page.locator('[data-workspace-id="ws-a"]').getByTestId("workspace-agent-count")).toHaveText("1", {
        timeout: 15_000,
      });
      await input.pressSequentially("keep going", { delay: 2 });
      await input.press("Enter");
      await viewTab(page, "Agents").click();
      await expect(page.locator('[data-agent-shelf="working"][data-agent-workspace="ws-a"]')).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(card(page, `run:${RUN_ID}`)).toHaveAttribute("data-agent-shelf", "inbox", { timeout: 15_000 });
    });

    await test.step("Working shows a live timer and a waiting chat reads Input", async () => {
      const working = page.locator('[data-agent-shelf="working"] .agent-inbox-row__status');
      await expect(working).toHaveText(/^Working(now|\d+m)$/);
      await expect(card(page, `run:${RUN_ID}`).locator(".agent-inbox-row__status")).toHaveText("Input");
    });

    await test.step("project tiles are monochrome: no workspace colour on any row", async () => {
      const tiles = await page
        .locator(".agent-inbox-row__tile")
        .evaluateAll((nodes) => nodes.map((node) => `${getComputedStyle(node).color} ${getComputedStyle(node).backgroundColor}`));
      expect(tiles.length).toBeGreaterThanOrEqual(2);
      expect(new Set(tiles).size).toBe(1);
    });

    await test.step("opening the beta row switches workspace and names it", async () => {
      await card(page, `run:${RUN_ID}`).locator("[data-agent-card-open]").click();
      await expect(page.getByTestId("workspace-switch-hud")).toContainText("beta");
    });
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("an agent whose turn ended with background work still running is not ready", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare();
  const { app, page } = await launch(fixture);
  try {
    const count = page.locator('[data-workspace-id="ws-a"]').getByTestId("workspace-agent-count");
    const input = page.locator(".xterm-helper-textarea:visible").first();
    let paneId = "";
    await test.step("its turn ends while a background agent it started still runs", async () => {
      await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
      await input.focus();
      const call = process.platform === "win32" ? "& " : "";
      await input.pressSequentially(`${call}"${process.execPath}" "${fixture.backgroundClaude}"`, { delay: 2 });
      await input.press("Enter");
      await expect(count).toHaveText("1", { timeout: 15_000 });
      paneId = (await page.locator("[data-terminal-pane-id]:visible").first().getAttribute("data-terminal-pane-id")) ?? "";
      expect(paneId).toBeTruthy();
      await input.pressSequentially("review the parser in the background", { delay: 2 });
      await input.press("Enter");
    });

    await test.step("the pane, the rail and the Agents view say it works in the background", async () => {
      await expect(page.getByRole("status", { name: "CLAUDE working in background" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("status", { name: "CLAUDE ready" })).toHaveCount(0);
      await expect(count).toHaveAttribute("data-working", "true");
      await viewTab(page, "Agents").click();
      const agent = card(page, `pane:${paneId}`);
      await expect(agent).toHaveAttribute("data-agent-bucket", "working", { timeout: 15_000 });
      await expect(agent).toHaveAttribute("data-agent-shelf", "working");
      await expect(agent.locator(".agent-inbox-row__status")).toHaveText(/^Working(now|\d+m)$/);
      await expect(agent.locator(".agent-inbox-row__line.is-meta")).toContainText("1 agent running");
      await viewTab(page, "Workspaces").click();
    });

    await test.step("once the background agent is done, the agent is ready", async () => {
      await input.focus();
      await input.pressSequentially("wrap it up", { delay: 2 });
      await input.press("Enter");
      await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 15_000 });
      await expect(count).toHaveAttribute("data-working", "false");
      await viewTab(page, "Agents").click();
      await expect(card(page, `pane:${paneId}`)).toHaveAttribute("data-agent-bucket", "done", { timeout: 15_000 });
      await expect(card(page, `pane:${paneId}`)).toHaveAttribute("data-agent-shelf", "inbox");
      await expect(card(page, `pane:${paneId}`)).toContainText("The review found nothing.");
    });
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
