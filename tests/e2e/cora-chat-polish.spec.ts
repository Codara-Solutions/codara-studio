import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, readdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("Cora messages keep a readable measure and the terminal remains healthy behind chat", async () => {
  const fixture = await prepareFixture("codara-chat-polish-");
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("domcontentloaded");

    await seedConversation(page, fixture.workspaceDir);
    await page.getByRole("tab", { name: "Cora" }).last().click();

    const column = page.getByTestId("cora-conversation");
    const user = page.locator('[data-message-author="user"]').last();
    const assistant = page.locator('[data-message-author="cora"]').last();
    await expect(column).toBeVisible();
    await expect(user).toContainText("Map this project for me");
    await expect(assistant).toContainText("I mapped the project into three layers");
    await expect(assistant.locator("li")).toHaveCount(3);

    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
      };
      return {
        column: box('[data-testid="cora-conversation"]'),
        user: box('[data-message-author="user"]'),
        assistant: box('[data-message-author="cora"]'),
        viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geometry.column?.width).toBeLessThanOrEqual(981);
    expect(geometry.user?.width).toBeLessThanOrEqual(721);
    expect(geometry.assistant?.width).toBeLessThanOrEqual(841);
    expect(geometry.overflow).toBeLessThanOrEqual(1);

    const screenshotPath = process.env.SPARK_CHAT_SCREENSHOT;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

    // The chat is one workbench tab layered over the same live terminal stack.
    // Switch away and back to prove the visual changes did not unmount or
    // collapse the terminal renderer behind it.
    await page.getByRole("tab", { name: /terminals/ }).click();
    await expect(page.locator(".xterm-host").first()).toBeVisible({ timeout: 15_000 });
    const terminalBox = await page.locator(".xterm-host").first().boundingBox();
    expect(terminalBox?.width ?? 0).toBeGreaterThan(300);
    expect(terminalBox?.height ?? 0).toBeGreaterThan(200);
    await page.getByRole("tab", { name: "Cora" }).last().click();
    await expect(assistant).toBeVisible();
  } finally {
    await app?.close();
  }
});

test("a rejected Codex launch fails once, stays failed, and never adopts a foreign rollout", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture("codara-codex-failure-");
  const fakeHome = join(fixture.root, "home");
  const fakeBin = join(fixture.root, "bin");
  const argsCapture = join(fixture.root, "codex-args.log");
  await mkdir(join(fakeHome, ".codex"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, "codex"),
    [
      "#!/bin/sh",
      'line="CALL"',
      'for arg in "$@"; do line="$line|$arg"; done',
      `printf "%s\\n" "$line" >> "${argsCapture}"`,
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: fakeHome,
        SHELL: "/bin/false",
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.startAutopilot({
        workspaceId: "ws-e2e",
        workspaceName: "workspace",
        cwd,
        initialUserNote: "Reply with a short project map.",
        chatBackend: "codex",
        chatModel: "gpt-5.6-sol",
        chatMode: "auto",
        chatEffort: "medium",
      });
      return run.id as string;
    }, fixture.workspaceDir);

    await expect
      .poll(async () => (await readRun(fixture.userDataDir, runId)).status, { timeout: 15_000 })
      .toBe("failed");
    const failed = await readRun(fixture.userDataDir, runId);
    expect(failed.autopilot?.status).toBe("failed");
    expect(failed.sparkCalls).toHaveLength(1);
    expect(failed.sparkCalls[0].status).toBe("failed");

    // Create a plausible same-workspace rollout after the failed child exits.
    // The old background discovery loop attached to this and replayed it.
    const marker = "FOREIGN_TRANSCRIPT_MUST_NOT_APPEAR";
    const now = new Date();
    const rolloutDir = join(
      fakeHome,
      ".codex",
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(
      rolloutDir,
      "rollout-foreign-00000000-0000-4000-8000-000000000099.jsonl",
    );
    const timestamp = new Date().toISOString();
    await writeFile(
      rolloutPath,
      `${JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: { timestamp, cwd: fixture.workspaceDir, source: "cli" },
      })}\n${JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "agent_message", message: marker },
      })}\n`,
      "utf8",
    );
    const future = new Date(Date.now() + 2_000);
    await utimes(rolloutPath, future, future);
    await page.waitForTimeout(1_200);

    const events = await page.evaluate(async (id) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.listEvents(id);
    }, runId);
    const eventText = JSON.stringify(events);
    expect(eventText).not.toContain(marker);
    expect(eventText).not.toContain("CLI session JSONL not found");
    const stillFailed = await readRun(fixture.userDataDir, runId);
    expect(stillFailed.status).toBe("failed");
    expect(stillFailed.autopilot?.status).toBe("failed");

    const calls = (await readFile(argsCapture, "utf8")).split("\n");
    const managerCall = calls.find((call) => call.includes("gpt-5.6-sol")) ?? "";
    expect(managerCall).toContain("mcp_servers.codara-studio.env.SPARK_MCP_MODE=\"execute\"");
    expect(managerCall).not.toContain('mcp_servers."codara-studio"');
    expect(managerCall).toContain("--yolo");
    expect(managerCall).not.toContain("read-only");

    await page.getByRole("tab", { name: "Cora" }).last().click();
    await expect(page.getByText("Cora couldn’t start this turn")).toBeVisible();
    if (process.env.SPARK_CHAT_FAILURE_SCREENSHOT) {
      await page.screenshot({ path: process.env.SPARK_CHAT_FAILURE_SCREENSHOT, fullPage: true });
    }
  } finally {
    await app?.close();
  }
});

async function prepareFixture(prefix: string): Promise<{
  root: string;
  userDataDir: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Project\n\nA compact fixture.\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, workspaceDir };
}

async function seedConversation(page: Page, cwd: string): Promise<void> {
  await page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Project map",
    });
    await spark.orchestration.addRunMessage({
      runId: run.id,
      author: "user",
      kind: "note",
      message:
        "Map this project for me. Explain its architecture, main entry points, important workflows, and the highest-leverage place to start working.",
    });
    await spark.orchestration.addRunMessage({
      runId: run.id,
      author: "spark",
      kind: "note",
      message: [
        "I mapped the project into three layers.",
        "",
        "- **Desktop shell** — Electron owns windows, IPC, and persistence.",
        "- **Orchestration** — Cora turns chat outcomes into managed worker runs.",
        "- **Workbench UI** — React presents chat, terminals, files, and run state together.",
        "",
        "Start at `src/main/orchestration/run-store.ts`; it is the junction between a Cora decision and everything the user sees next.",
      ].join("\n"),
    });
  }, cwd);
}

async function readRun(
  userDataDir: string,
  runId: string,
): Promise<{
  status: string;
  autopilot?: { status: string };
  sparkCalls: Array<{ status: string; error?: string }>;
}> {
  // Run folders are keyed by run id, but keep a defensive directory scan for
  // older fixtures that may prefix/sanitize their folder names.
  const direct = join(userDataDir, "runs", runId, "run.json");
  try {
    return JSON.parse(await readFile(direct, "utf8"));
  } catch {
    const entries = await readdir(join(userDataDir, "runs"));
    for (const entry of entries) {
      const parsed = JSON.parse(await readFile(join(userDataDir, "runs", entry, "run.json"), "utf8"));
      if (parsed.id === runId) return parsed;
    }
    throw new Error(`Run ${runId} not found`);
  }
}
