import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rail's Agents view against a throwaway Codara home and a fake user
// home (no real ~/.claude, shell startup file or account is read or
// written). A fake Claude Code drives its pane through OSC 7501 program
// status: it lands under Needs you in another workspace with a question,
// which the card never pastes into (a real one is a menu) but opens the pane
// for; then it stops with an error and is answered from its card's reply
// box, moves to Done with its last message, and opening the card brings its
// pane back. A seeded blocked Cora chat is answered with one of its options;
// the switch works from the keyboard and is remembered on reload.

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
    await test.step("the Agents view puts it under Needs you with its question", async () => {
      await viewTab(page, "Agents").click();
      await expect(viewTab(page, "Agents")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-workspace-id="ws-a"]')).toHaveCount(0);
      await expect(agent).toHaveAttribute("data-agent-bucket", "needs-you");
      await expect(agent).toHaveAttribute("data-agent-workspace", "ws-a");
      await expect(agent).toContainText("Deploy to production?");
      await expect(agent).toContainText("alpha");
      // The harness is its mark, named in the tooltip, not repeated as text.
      await expect(agent.locator('[data-agent-runtime="claude"]')).toHaveAttribute("title", "Claude Code");
      await expect(agent).not.toContainText("Claude Code");
      await expect(page.getByRole("button", { name: "Needs you, 1", exact: true })).toHaveAttribute("aria-expanded", "true");
    });

    await test.step("a question in a terminal is answered in its pane, never pasted into", async () => {
      // No text box: pasted text and Enter would pick a real menu's
      // highlighted answer without the user choosing it.
      await expect(agent.getByRole("textbox")).toHaveCount(0);
      const answer = agent.getByRole("button", { name: "Answer Claude Code in its terminal in alpha" });
      await expect(answer).toHaveText("Answer in terminal");
      await answer.click();
      await expect(agent.locator("[data-agent-card-open]")).toHaveAttribute("aria-current", "true");
      const input = page.locator(`[data-terminal-pane-id="${paneId}"]:visible .xterm-helper-textarea`).first();
      await input.focus();
      await input.pressSequentially("yes", { delay: 2 });
      await input.press("Enter");
      await expect(agent).not.toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
    });

    await test.step("an agent stopped by an error takes a reply from its card", async () => {
      await expect(agent).toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      await expect(agent).toContainText("Stopped");
      await expect(agent).toContainText("Rate limited, try again.");
      const reply = agent.getByRole("textbox", { name: "Reply to Claude Code in alpha" });
      await reply.fill("try again");
      await reply.press("Enter");
      // The agent picks it up and leaves Needs you.
      await expect(agent).not.toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      // The box went with it; the keyboard stays on the card.
      await expect(agent.locator("[data-agent-card-open]")).toBeFocused();
    });

    await test.step("the finished agent moves to Done with its last message", async () => {
      await expect(agent).toHaveAttribute("data-agent-bucket", "done", { timeout: 15_000 });
      await expect(agent).toContainText("Shipped after you said try again.");
      await expect(agent).toContainText("Finished");
      await expect(viewTab(page, "Agents")).toHaveAccessibleName("Agents");
    });

    await test.step("opening the card switches workspace and focuses the pane", async () => {
      await viewTab(page, "Workspaces").click();
      await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
      await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
      await viewTab(page, "Agents").click();
      await expect(agent.locator("[data-agent-card-open]")).not.toHaveAttribute("aria-current", "true");
      await agent.locator("[data-agent-card-open]").click();
      await expect(agent.locator("[data-agent-card-open]")).toHaveAttribute("aria-current", "true");
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

test("a Cora question is answered from its card, by keyboard, and the view is remembered", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare({ blockedRun: true });
  const { app, page } = await launch(fixture);
  try {
    // Right after boot the main-process evaluate can fail ("Resulting promise
    // was garbage collected"), so it repeats until it lands. Installing the
    // stand-in twice is harmless: nothing has answered yet.
    await expect(async () => {
      await app.evaluate(({ ipcMain }) => {
        const calls: unknown[] = [];
        (globalThis as { __answerCalls?: unknown[] }).__answerCalls = calls;
        ipcMain.removeHandler("orchestration:answerRunQuestion");
        ipcMain.handle("orchestration:answerRunQuestion", async (_e, input: unknown) => {
          calls.push(input);
          return {};
        });
      });
    }).toPass({ timeout: 20_000 });
    const chat = card(page, `run:${RUN_ID}`);

    await test.step("the switch works from the keyboard", async () => {
      await viewTab(page, "Workspaces").focus();
      await page.keyboard.press("ArrowRight");
      await expect(viewTab(page, "Agents")).toHaveAttribute("aria-selected", "true");
      await expect(viewTab(page, "Agents")).toBeFocused();
    });

    await test.step("the blocked chat waits under Needs you with its answers", async () => {
      await expect(chat).toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      await expect(chat).toContainText("Postgres or SQLite for the session store?");
      await expect(chat).toContainText("Pick a database");
      await expect(chat.locator('[data-agent-runtime="cora"]')).toHaveAttribute("aria-label", "Cora");
      await expect(chat).toContainText("beta");
      await expect(chat.getByRole("button", { name: "Postgres", exact: true })).toBeVisible();
      await expect(chat.getByRole("textbox", { name: "Reply to Cora in beta" })).toBeVisible();
    });

    await test.step("an option answers the question it was asked for", async () => {
      await chat.getByRole("button", { name: "Postgres", exact: true }).click();
      await expect(chat.getByRole("status")).toHaveText("Sent");
      const calls = (await app.evaluate(
        () => (globalThis as { __answerCalls?: unknown[] }).__answerCalls ?? [],
      )) as Array<Record<string, unknown>>;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ runId: RUN_ID, questionMessageId: QUESTION_ID, message: "Use Postgres." });
      expect(typeof calls[0].clientMessageId).toBe("string");
    });

    await test.step("Tab reaches the card and Enter opens its chat in its workspace", async () => {
      await viewTab(page, "Agents").focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Needs you, 1", exact: true })).toBeFocused();
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

// What each card is painted with: its workspace edge, the status word, the
// harness mark and, unless it is the workspace you are in, its tile.
async function cardColours(page: Page): Promise<Record<string, Record<string, string>>> {
  return page.locator("[data-agent-card]").evaluateAll((cards) =>
    Object.fromEntries(
      cards.map((card) => {
        const pick = (selector: string, prop: "color" | "backgroundColor") => {
          const node = card.querySelector(selector);
          return node ? getComputedStyle(node)[prop] : "";
        };
        const colours: Record<string, string> = {
          edge: getComputedStyle(card, "::before").backgroundColor,
          status: pick(".agent-card__status", "color"),
          mark: pick(".agent-card__mark", "color"),
        };
        if (!card.classList.contains("is-here")) colours.tile = pick(".agent-card__ws-tile", "backgroundColor");
        return [card.getAttribute("data-agent-card") ?? "", colours];
      }),
    ),
  );
}

test("a switch from a card keeps every card's colours and says where you are", async () => {
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
      await expect(page.locator('[data-agent-bucket="working"][data-agent-workspace="ws-a"]')).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(card(page, `run:${RUN_ID}`)).toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      await expect(page.locator('[data-agent-workspace="ws-a"]')).toHaveClass(/is-here/);
      await expect(card(page, `run:${RUN_ID}`)).not.toHaveClass(/is-here/);
    });

    await test.step("each card says how long it has worked or waited", async () => {
      // The seeded question was asked ten minutes ago.
      await expect(card(page, `run:${RUN_ID}`).locator(".agent-card__elapsed")).toHaveText(/^Waiting 1\dm$/);
      await expect(card(page, `run:${RUN_ID}`).locator(".agent-card__elapsed")).toHaveAttribute("title", /^Waiting since \d\d:\d\d$/);
      const working = page.locator('[data-agent-bucket="working"] .agent-card__elapsed');
      await expect(working).toHaveText(/^Working for (<1m|\d+m)$/);
      await expect(working).toHaveAttribute("title", /^Started \d\d:\d\d$/);
      const dark = await page.evaluate(() => document.documentElement.dataset.themeMode !== "light");
      if (dark && process.env.AGENT_TIMES_SHOT) {
        await page.locator(".agent-board").first().screenshot({ path: process.env.AGENT_TIMES_SHOT });
      }
    });

    const before = await cardColours(page);
    await test.step("opening the beta card switches workspace and names it", async () => {
      await card(page, `run:${RUN_ID}`).locator("[data-agent-card-open]").click();
      await expect(page.getByTestId("workspace-switch-hud")).toContainText("beta");
      await expect(card(page, `run:${RUN_ID}`)).toHaveClass(/is-here/);
      await expect(page.locator('[data-agent-workspace="ws-a"]')).not.toHaveClass(/is-here/);
    });

    await test.step("no card changed colour, only the you-are-here tile moved", async () => {
      // Let any colour transition settle before reading.
      await page.waitForTimeout(400);
      const after = await cardColours(page);
      const working = Object.keys(after).find((key) => key.startsWith("pane:")) ?? "";
      expect(working).toBeTruthy();
      expect(after[working].edge).not.toBe(after[`run:${RUN_ID}`].edge);
      for (const [key, colours] of Object.entries(after)) {
        for (const [part, value] of Object.entries(colours)) {
          if (part === "tile" && before[key]?.tile === undefined) continue;
          expect(`${key} ${part} ${value}`).toBe(`${key} ${part} ${before[key]?.[part]}`);
        }
      }
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
      await expect(agent).toContainText("In background");
      await expect(agent.locator(".agent-card__elapsed")).toHaveText(/^In background for (<1m|\d+m)$/);
      await expect(agent).toContainText("1 agent running");
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
      await expect(card(page, `pane:${paneId}`)).toContainText("The review found nothing.");
      await expect(card(page, `pane:${paneId}`).locator(".agent-card__elapsed")).toHaveText("Done just now");
    });
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
