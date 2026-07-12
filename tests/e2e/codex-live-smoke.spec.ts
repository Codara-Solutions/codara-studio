import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

test("live GPT-5.6 Sol Cora turn streams, completes, and preserves the terminal", async () => {
  test.setTimeout(180_000);
  test.skip(
    process.env.SPARK_E2E_CODEX_LIVE !== "1",
    "Set SPARK_E2E_CODEX_LIVE=1 to use the installed authenticated Codex CLI.",
  );

  const workspaceDir = process.env.SPARK_E2E_WORKSPACE || process.cwd();
  const root = await mkdtemp(join(tmpdir(), "codara-live-codex-"));
  const userDataDir = join(root, "user-data");
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-live-codex",
            name: basename(workspaceDir),
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-live-codex",
      },
      null,
      2,
    ),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForLoadState("domcontentloaded");
    const marker = "CORA_GPT56_SMOKE_OK";
    const runId = await page.evaluate(
      async ({ cwd, expected }) => {
        const spark = (window as unknown as { spark: any }).spark;
        const run = await spark.orchestration.startAutopilot({
          workspaceId: "ws-live-codex",
          workspaceName: "spark-agent",
          cwd,
          initialUserNote: [
            "This is a connectivity smoke test.",
            `Reply with exactly ${expected} and nothing else.`,
            "Do not inspect files, call tools, create workers, or change the workspace.",
          ].join(" "),
          chatBackend: "codex",
          chatModel: "gpt-5.6-sol",
          chatMode: "auto",
          chatEffort: "medium",
        });
        return run.id as string;
      },
      { cwd: workspaceDir, expected: marker },
    );

    await expect
      .poll(async () => (await readRun(userDataDir, runId)).status, { timeout: 120_000 })
      .toBe("complete");
    const run = await readRun(userDataDir, runId);
    expect(run.sparkCalls).toHaveLength(1);
    expect(run.sparkCalls[0].status).toBe("completed");
    expect(run.sparkCalls[0].model).toBe("gpt-5.6-sol");
    expect(run.humanMessages.some((message) => message.author === "spark" && message.message.includes(marker))).toBe(true);

    const events = (await page.evaluate(async (id) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.listEvents(id);
    }, runId)) as Array<{ type: string; payload?: Record<string, unknown>; message?: string }>;
    expect(events.some((event) => event.type === "chat.error")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("CLI session JSONL not found");
    const usage = events.filter((event) => event.type === "chat.usage");
    expect(usage.length).toBeGreaterThan(0);
    expect(
      usage.every((event) => {
        const context = event.payload?.contextTokens;
        const window = event.payload?.contextWindowTokens;
        return (
          typeof context !== "number" ||
          typeof window !== "number" ||
          (context >= 0 && context <= window)
        );
      }),
    ).toBe(true);

    await page.getByRole("tab", { name: "Cora" }).last().click();
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /terminals/ }).click();
    // A managed Codex backend keeps its own hidden terminal host mounted for
    // continuity; select the workbench terminal that is actually visible.
    await expect(page.locator(".xterm-host:visible").first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "Cora" }).last().click();
    await expect(page.getByText(marker, { exact: true })).toBeVisible();

    if (process.env.SPARK_CODEX_LIVE_SCREENSHOT) {
      await page.screenshot({ path: process.env.SPARK_CODEX_LIVE_SCREENSHOT, fullPage: true });
    }
  } finally {
    await app?.close();
  }
});

test("live GPT-5.6 Sol opens one persistent tab with two Claude panes", async () => {
  test.setTimeout(180_000);
  test.skip(
    process.env.SPARK_E2E_CODEX_LIVE !== "1",
    "Set SPARK_E2E_CODEX_LIVE=1 to use the installed authenticated Codex CLI.",
  );

  const workspaceDir = process.env.SPARK_E2E_WORKSPACE || process.cwd();
  const root = await mkdtemp(join(tmpdir(), "codara-live-agent-terminals-"));
  const userDataDir = join(root, "user-data");
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-live-terminals",
            name: basename(workspaceDir),
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-live-terminals",
      },
      null,
      2,
    ),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForLoadState("domcontentloaded");
    const initialTerminalTabs = await page.getByRole("tab", { name: /terminals/ }).count();

    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.startAutopilot({
        workspaceId: "ws-live-terminals",
        workspaceName: "spark-agent",
        cwd,
        initialUserNote:
          "Open one new terminal tab with exactly two persistent Claude Code panes. I will drive both sessions myself. Do not create Cora workers.",
        chatBackend: "codex",
        chatModel: "gpt-5.6-sol",
        chatMode: "auto",
        chatEffort: "medium",
      });
      return run.id as string;
    }, workspaceDir);

    await expect
      .poll(async () => (await readRun(userDataDir, runId)).status, { timeout: 120_000 })
      .toBe("complete");
    const run = await readRun(userDataDir, runId);
    expect(run.workerTasks ?? []).toHaveLength(0);
    expect(run.autopilot?.spawnedTerminals).toBe(2);

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const raw = localStorage.getItem("spark.tabs:ws-live-terminals");
            if (!raw) return null;
            const state = JSON.parse(raw) as {
              tabs: Array<{ id: string; kind: string; root?: unknown }>;
            };
            const leaves = (node: any): any[] =>
              !node
                ? []
                : node.kind === "leaf"
                  ? [node]
                  : [...leaves(node.a), ...leaves(node.b)];
            for (const tab of state.tabs) {
              if (tab.kind !== "terminal") continue;
              const panes = leaves(tab.root);
              if (panes.length === 2) {
                return {
                  tabId: tab.id,
                  paneIds: panes.map((pane) => pane.paneId as string),
                };
              }
            }
            return null;
          }),
        { timeout: 30_000 },
      )
      .not.toBeNull();
    const persistedGrid = await page.evaluate(() => {
      const raw = localStorage.getItem("spark.tabs:ws-live-terminals");
      if (!raw) return null;
      const state = JSON.parse(raw) as { tabs: Array<{ id: string; kind: string; root?: any }> };
      const leaves = (node: any): any[] =>
        !node ? [] : node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
      for (const tab of state.tabs) {
        const panes = tab.kind === "terminal" ? leaves(tab.root) : [];
        if (panes.length === 2) {
          return { paneIds: panes.map((pane) => pane.paneId as string) };
        }
      }
      return null;
    });
    expect(persistedGrid?.paneIds).toHaveLength(2);
    await expect(page.getByRole("tab", { name: /terminals/ })).toHaveCount(
      initialTerminalTabs + 1,
    );
    const panesAlive = await page.evaluate(async (paneIds) => {
      const spark = (window as unknown as { spark: any }).spark;
      return Promise.all(paneIds.map((paneId) => spark.pty.exists(paneId)));
    }, persistedGrid?.paneIds ?? []);
    expect(panesAlive).toEqual([true, true]);

    const events = (await page.evaluate(async (id) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.listEvents(id);
    }, runId)) as Array<{ type: string; payload?: { terminals?: Array<{ command?: string }> } }>;
    expect(events.some((event: { type: string }) => event.type === "spark.spawn_terminals")).toBe(
      true,
    );
    expect(events.some((event: { type: string }) => event.type === "worker_task.created")).toBe(
      false,
    );
    const spawnEvent = events.find((event) => event.type === "spark.spawn_terminals");
    expect(spawnEvent?.payload?.terminals).toHaveLength(2);
    expect(
      spawnEvent?.payload?.terminals?.every((terminal) =>
        terminal.command?.startsWith("claude --dangerously-skip-permissions"),
      ),
    ).toBe(true);
  } finally {
    await app?.close();
  }
});

async function readRun(
  userDataDir: string,
  runId: string,
): Promise<{
  status: string;
  sparkCalls: Array<{ status: string; model: string }>;
  humanMessages: Array<{ author: string; message: string }>;
  workerTasks?: unknown[];
  autopilot?: { spawnedTerminals?: number };
}> {
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
