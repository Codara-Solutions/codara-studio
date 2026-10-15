import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rail's Agents view against a throwaway Codara home and a fake user
// home (no real ~/.claude, shell startup file or account is read or
// written). A fake Claude Code drives its pane through OSC 7501 program
// status: it lands under Needs you in another workspace, is answered from its
// card, moves to Done with its last message, and opening the card brings
// its pane back. A seeded blocked Cora chat is answered with one of its
// options; the switch works from the keyboard and is remembered on reload.

const MINUTE = 60_000;
const RUN_ID = "run-agents-view";
const QUESTION_ID = "msg-agents-question";

interface Fixture {
  root: string;
  home: string;
  env: Record<string, string>;
  fakeClaude: string;
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
  // through OSC 7501, and finishes once the answer arrives (typed or pasted).
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
    env: {
      ...env,
      HOME: userHome,
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
      await input.pressSequentially(`"${process.execPath}" "${fixture.fakeClaude}"`, { delay: 2 });
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
      await expect(agent).toContainText("Claude Code");
      await expect(page.getByRole("button", { name: "Needs you, 1", exact: true })).toHaveAttribute("aria-expanded", "true");
    });

    await test.step("a reply from the card reaches the pane", async () => {
      const reply = agent.getByRole("textbox", { name: "Reply to Claude Code in alpha" });
      await reply.fill("yes, ship it");
      await reply.press("Enter");
      // The agent picks it up and leaves Needs you.
      await expect(agent).not.toHaveAttribute("data-agent-bucket", "needs-you", { timeout: 15_000 });
      // The box went with it; the keyboard stays on the card.
      await expect(agent.locator("[data-agent-card-open]")).toBeFocused();
    });

    await test.step("the finished agent moves to Done with its last message", async () => {
      await expect(agent).toHaveAttribute("data-agent-bucket", "done", { timeout: 15_000 });
      await expect(agent).toContainText("Shipped after you said yes, ship it.");
      await expect(agent).toContainText("Finished");
      await expect(viewTab(page, "Agents")).toHaveAccessibleName("Agents");
    });

    await test.step("opening the card switches workspace and focuses the pane", async () => {
      await agent.locator("[data-agent-card-open]").click();
      await expect(agent.locator("[data-agent-card-open]")).toHaveAttribute("aria-current", "true");
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
    await app.evaluate(({ ipcMain }) => {
      const calls: unknown[] = [];
      (globalThis as { __answerCalls?: unknown[] }).__answerCalls = calls;
      ipcMain.removeHandler("orchestration:answerRunQuestion");
      ipcMain.handle("orchestration:answerRunQuestion", async (_e, input: unknown) => {
        calls.push(input);
        return {};
      });
    });
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
      await expect(chat).toContainText("Cora");
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
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
