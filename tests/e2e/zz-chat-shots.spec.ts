import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Screenshot harness for the Cora chat's visual states. It asserts only that
// each state rendered, then writes <state>-<size>.png into SHOTS_DIR so a
// design pass can compare before and after. Every state comes from run files
// seeded on disk into a throwaway home; nothing in the app is stubbed.
//
//   SHOTS_DIR=/tmp/shots SPARK_ALLOW_MULTI=1 npx playwright test tests/e2e/zz-chat-shots.spec.ts

const SHOTS_DIR =
  process.env.SHOTS_DIR ??
  "/tmp/claude-1000/-home-etienne--codarastudio-worktrees-codara-studio-06c856953fa0-Cora/2fd61fbf-61c2-4f02-92b2-f7fd48e0ed97/scratchpad/chat-design/shots";

const WORKSPACE_ID = "ws-shots";
const SIZES = [
  // The owner's complaint was a ~680px chat panel; the window is grown or
  // shrunk until the panel itself lands near this width.
  { name: "narrow", panelWidth: 700, height: 860 },
  { name: "wide", windowWidth: 1400, height: 900 },
] as const;

const RUN_MARKDOWN = "run-shots-markdown-conversation";
const RUN_PAUSED = "run-shots-paused-auth";
const RUN_RUNNING = "run-shots-running-workers";
const RUN_LONG = "run-shots-long-conversation";
const RUN_SENTINEL = "run-shots-boot-sentinel";

test("capture the Cora chat in each visual state at narrow and wide sizes", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-chat-shots-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const cwd = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(SHOTS_DIR, { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Autopilot\n\nA fixture project.\n", "utf8");
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: WORKSPACE_ID,
      workspaces: [{ id: WORKSPACE_ID, name: "autopilot", cwd, color: "#F0C419", workers: [] }],
    }),
  );
  await seedRun(home, markdownRun(home, cwd), markdownEvents());
  await seedRun(home, pausedAuthRun(home, cwd));
  await seedRun(home, longRun(home, cwd));
  // Boot recovery fails every non-terminal worker attempt and pauses every
  // working run it finds, because their processes died with the last app. The
  // live-workers state is therefore written only after recovery finished,
  // which this sentinel reports by being paused.
  await seedRun(home, sentinelRun(home, cwd));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"].includes(key)) env[key] = value;
  }
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      // No --ozone-platform here: under SPARK_E2E_BACKGROUND (playwright.config.ts)
      // the app runs headless and muted, and forcing x11 would put the window
      // on the desktop of whoever is using the machine.
      args: ["."],
      env: {
        ...env,
        TZ: "UTC",
        HOME: userHome,
        CODARA_HOME_DIR: home,
        SPARK_HOME_DIR: home,
        SPARK_USER_DATA_DIR: home,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await expect
      .poll(
        () =>
          page.evaluate(async (runId) => {
            const spark = (window as unknown as { spark: any }).spark;
            return (await spark.orchestration.getRun(runId))?.status ?? null;
          }, RUN_SENTINEL),
        { timeout: 30_000 },
      )
      .toBe("paused");
    await page.evaluate(async (runId) => {
      await (window as unknown as { spark: any }).spark.orchestration.deleteRun(runId);
    }, RUN_SENTINEL);
    await seedRun(home, runningRun(home, cwd), runningEvents());
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const live = await page.evaluate(async (runId) => {
      const run = await (window as unknown as { spark: any }).spark.orchestration.getRun(runId);
      return {
        status: run?.status,
        attempts: run?.workerAttempts?.map((attempt: any) => attempt.status),
      };
    }, RUN_RUNNING);
    expect(live).toEqual({ status: "running", attempts: ["succeeded", "running", "running", "failed"] });

    await selectCoraTab(page);

    for (const size of SIZES) {
      await applySize(page, size);

      await openNewChat(page);
      await expect(page.getByText("Work with Cora on this project", { exact: true }).locator("visible=true")).toBeVisible();
      await shoot(page, "empty", size.name);

      await openChat(page, "Manager loop design");
      await expect(page.locator('[data-message-author="cora"]').last()).toContainText("Rollout plan", {
        timeout: 15_000,
      });
      await scrollConversation(page, "top");
      await shoot(page, "markdown", size.name);
      await scrollConversation(page, "bottom");
      await shoot(page, "markdown-end", size.name);

      await openChat(page, "Autopilot manager loop");
      await expect(page.locator('[data-message-author="user"]').last()).toContainText(
        "Build the first autonomous manager loop.",
        { timeout: 15_000 },
      );
      await expect(page.getByRole("button", { name: "Unqueue message" }).first()).toBeVisible();
      await shoot(page, "paused-auth", size.name);

      await openChat(page, "Ship the run-store refactor");
      await expect(page.getByText("Split run-store persistence").first()).toBeVisible({ timeout: 15_000 });
      await scrollConversation(page, "bottom");
      await shoot(page, "running", size.name);

      await openChat(page, "Long design review");
      await expect(page.locator('[data-message-author="cora"]').last()).toContainText("Final answer 18", {
        timeout: 15_000,
      });
      await scrollConversation(page, "bottom");
      await expect(page.getByRole("textbox", { name: "Message Cora" }).last()).toBeVisible();
      await shoot(page, "long", size.name);
      // Hover-only meta (time, copy) must float in the turn gap, not shove
      // the next turn down or sit on its text.
      await page.locator('[data-message-author="user"]').locator("visible=true").last().hover();
      await shoot(page, "long-hover-user", size.name);
      await page.locator('[data-message-author="cora"]').locator("visible=true").nth(-2).hover();
      await shoot(page, "long-hover-cora", size.name);
    }

    // The complaint's window was short as well as narrow: the composer must
    // stay whole when the panel loses height.
    await applySize(page, { name: "short", panelWidth: 680, height: 600 });
    await openChat(page, "Autopilot manager loop");
    await expect(page.locator('[data-message-author="user"]').last()).toBeVisible({ timeout: 15_000 });
    const composer = await page.getByRole("textbox", { name: "Message Cora" }).locator("visible=true").last().boundingBox();
    const viewport = page.viewportSize();
    expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) - 8);
    await shoot(page, "paused-auth", "short");

    // Through the real preference, so the theme provider and the workspace
    // accent's contrast pass both run, exactly as for a user switching themes.
    await page.evaluate(async () => {
      await (window as unknown as { spark: any }).spark.preferences.set("theme", "codara-daylight");
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeMode)).toBe("light");
    await applySize(page, SIZES[1]);
    await shoot(page, "paused-auth", "wide-light");
    await openChat(page, "Manager loop design");
    await expect(page.locator('[data-message-author="cora"]').last()).toContainText("Rollout plan", {
      timeout: 15_000,
    });
    await scrollConversation(page, "top");
    await shoot(page, "markdown", "wide-light");
    await openChat(page, "Ship the run-store refactor");
    await scrollConversation(page, "bottom");
    await shoot(page, "running", "wide-light");
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

type Size = { name: string; height: number } & ({ panelWidth: number } | { windowWidth: number });

async function applySize(page: Page, size: Size): Promise<void> {
  if ("windowWidth" in size) {
    await page.setViewportSize({ width: size.windowWidth, height: size.height });
    await page.waitForTimeout(300);
    return;
  }
  // The panel's share of the window changes as rails collapse at breakpoints,
  // so converge on the target panel width instead of guessing a window width.
  let width = size.panelWidth + 260;
  for (let i = 0; i < 6; i += 1) {
    await page.setViewportSize({ width, height: size.height });
    await page.waitForTimeout(300);
    const box = await chatPanel(page).boundingBox();
    const measured = box?.width ?? 0;
    if (Math.abs(measured - size.panelWidth) <= 12) return;
    width = Math.max(480, Math.round(width + (size.panelWidth - measured)));
  }
}

function chatPanel(page: Page): Locator {
  // ChatPanel's root is the nearest full-height column above its history
  // button that paints the panel surface (the header paints it too, so the
  // column and height terms matter); it holds header, conversation, composer.
  return page
    .getByRole("button", { name: "Open chat history" })
    .locator("visible=true")
    .last()
    .locator("xpath=ancestor::div[contains(@style, 'var(--panel)') and contains(@style, 'flex-direction: column') and contains(@style, 'height: 100%')][1]");
}

async function shoot(page: Page, state: string, size: string): Promise<void> {
  // Let entry transitions and the debounced runs refresh settle.
  await page.waitForTimeout(600);
  await chatPanel(page).screenshot({ path: join(SHOTS_DIR, `${state}-${size}.png`), animations: "disabled" });
}

async function selectCoraTab(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "Cora" }).last();
  await expect(tab).toBeAttached({ timeout: 15_000 });
  await tab.dispatchEvent("click");
  await expect(tab).toHaveClass(/spark-tab--active/);
}

async function openNewChat(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "New Cora chat" }).first();
  await expect(button).toBeAttached({ timeout: 10_000 });
  await button.dispatchEvent("click");
}

async function openChat(page: Page, title: string): Promise<void> {
  const history = page.getByRole("button", { name: "Open chat history" }).locator("visible=true").last();
  await expect(history).toBeAttached({ timeout: 10_000 });
  await history.dispatchEvent("click");
  const option = page.getByRole("option").filter({ hasText: title });
  await expect(option).toBeAttached({ timeout: 10_000 });
  await option.dispatchEvent("click");
  await expect(page.getByRole("option")).toHaveCount(0);
}

async function scrollConversation(page: Page, where: "top" | "bottom"): Promise<void> {
  // The list is virtualized: rows are measured as they mount, so one jump
  // lands short. Repeat until the scroller stops moving.
  let previous = -1;
  for (let i = 0; i < 8; i += 1) {
    const position = await page.evaluate((target) => {
      const panes: HTMLElement[] = Array.from(document.querySelectorAll('[data-testid="cora-conversation"]'));
      for (const pane of panes) {
        if (pane.offsetParent === null || getComputedStyle(pane).visibility === "hidden") continue;
        const scroller: HTMLElement = pane.querySelector('[data-testid="virtuoso-scroller"]') ?? pane;
        scroller.scrollTop = target === "top" ? 0 : scroller.scrollHeight;
        return scroller.scrollTop;
      }
      return -1;
    }, where);
    await page.waitForTimeout(200);
    if (position === previous) break;
    previous = position;
  }
}

// Seeding ------------------------------------------------------------------

type Json = Record<string, unknown>;

async function seedRun(home: string, run: Json, events: string[] = []): Promise<void> {
  const runDir = join(home, "runs", String(run.id));
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");
  if (events.length > 0) await writeFile(join(runDir, "events.jsonl"), events.join("\n") + "\n", "utf8");
}

function baseRun(home: string, cwd: string, id: string, title: string, createdAt: string): Json {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title,
    settingsSnapshot: { workspaceCwd: cwd },
    artifactDir: join(home, "runs", id),
    createdAt,
    updatedAt: createdAt,
    seen: true,
    conversationEpoch: 0,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    humanMessages: [],
    checkpoints: [],
    assumptions: [],
    chatBackend: "pi",
    chatMode: "auto",
    chatModel: "gpt-5.6-sol",
    chatEffort: "medium",
  };
}

function message(runId: string, fields: Json): Json {
  return {
    runId,
    kind: "note",
    deliveryState: "acknowledged",
    conversationEpoch: 0,
    attachments: [],
    ...fields,
  };
}

function eventLine(runId: string, sparkCallId: string, sequence: number, at: string, type: string, payload: Json): string {
  return JSON.stringify({
    id: `evt-${runId}-${sequence}`,
    timestamp: at,
    eventVersion: 1,
    sequence,
    workspaceId: WORKSPACE_ID,
    runId,
    sparkCallId,
    type,
    payload: { conversationEpoch: 0, ...payload },
  });
}

const USER_MARKDOWN = [
  "# Manager loop",
  "",
  "Design the **first autonomous manager loop** for Cora. Constraints:",
  "",
  "- keep `run-store.ts` the only writer of `run.json`",
  "- workers must survive an app restart",
  "- no new IPC channels",
  "",
  "```ts",
  "startAutopilot({ runId, mode: \"auto\" });",
  "```",
].join("\n");

const ASSISTANT_MARKDOWN = [
  "## Summary",
  "",
  "The loop fits in three stages, and each one already has a home in the codebase. Nothing below needs a new IPC channel.",
  "",
  "### Stages",
  "",
  "1. **Plan**: `plan_analysis` turns the request into steps.",
  "2. **Delegate**: each step spawns workers through `spawnWorkerTask`.",
  "3. **Review**: `worker_result_review` accepts or retries each report.",
  "",
  "| Stage | Owner | Survives restart |",
  "| --- | --- | --- |",
  "| Plan | `pi-backend.ts` | yes, parked turn |",
  "| Delegate | `run-store.ts` | yes, recovered attempt |",
  "| Review | `pi-backend.ts` | yes |",
  "",
  "### Rollout plan",
  "",
  "- Land the stage machine behind `chatMode: \"auto\"`.",
  "- Keep the existing *execute* path untouched.",
  "  - Add a unit suite under `scripts/test-manager-loop.cjs`.",
  "",
  "```ts",
  "export async function runManagerLoop(runId: string): Promise<void> {",
  "  const run = await requireRun(runId);",
  "  for (const step of pendingSteps(run)) {",
  "    await delegate(step);",
  "    await review(step);",
  "  }",
  "}",
  "```",
  "",
  "> Start with the review stage: it is the one that decides when the loop may stop.",
].join("\n");

function markdownRun(home: string, cwd: string): Json {
  const id = RUN_MARKDOWN;
  return {
    ...baseRun(home, cwd, id, "Manager loop design", "2026-07-13T09:00:00.000Z"),
    status: "complete",
    completedAt: "2026-07-13T09:00:42.000Z",
    updatedAt: "2026-07-13T09:00:42.000Z",
    sparkCalls: [
      {
        id: "spark-md",
        runId: id,
        mode: "chat",
        model: "gpt-5.6-sol",
        status: "completed",
        inputMessageIds: ["msg-md-user"],
        conversationEpoch: 0,
        createdAt: "2026-07-13T09:00:01.000Z",
        completedAt: "2026-07-13T09:00:41.000Z",
        durationMs: 40_000,
      },
    ],
    humanMessages: [
      message(id, { id: "msg-md-user", author: "user", intent: "turn", backendTurnId: "spark-md", message: USER_MARKDOWN, createdAt: "2026-07-13T09:00:00.500Z" }),
      message(id, { id: "msg-md-answer", author: "spark", intent: "answer", backendTurnId: "spark-md", message: ASSISTANT_MARKDOWN, createdAt: "2026-07-13T09:00:40.900Z" }),
    ],
    autopilot: { status: "complete", updatedAt: "2026-07-13T09:00:42.000Z" },
  };
}

function markdownEvents(): string[] {
  const e = (sequence: number, second: number, type: string, payload: Json) =>
    eventLine(RUN_MARKDOWN, "spark-md", sequence, `2026-07-13T09:00:${String(second).padStart(2, "0")}.000Z`, type, payload);
  return [
    e(1, 2, "chat.assistant_block", { kind: "assistant_block", messageId: "p-1", text: "I'll read the run store and the Pi backend first." }),
    e(2, 3, "chat.tool_use", { kind: "tool_use", toolUseId: "t-1", toolName: "Read", input: { file_path: "src/main/orchestration/run-store.ts" } }),
    e(3, 5, "chat.tool_result", { kind: "tool_result", toolUseId: "t-1", output: "export async function startAutopilot(...)" }),
    e(4, 6, "chat.tool_use", { kind: "tool_use", toolUseId: "t-2", toolName: "Grep", input: { pattern: "worker_result_review", path: "src/main" } }),
    e(5, 8, "chat.tool_result", { kind: "tool_result", toolUseId: "t-2", output: "src/main/orchestration/pi-backend.ts:412" }),
    e(6, 9, "chat.tool_use", { kind: "tool_use", toolUseId: "t-3", toolName: "Bash", input: { command: "npm test -- step-lifecycle" } }),
    e(7, 21, "chat.tool_result", { kind: "tool_result", toolUseId: "t-3", output: "14 passing" }),
    e(8, 22, "chat.assistant_block", { kind: "assistant_block", messageId: "p-2", text: "The stage owners are clear; drafting the plan now." }),
    e(9, 40, "chat.assistant_block", { kind: "assistant_block", messageId: "p-final", text: ASSISTANT_MARKDOWN }),
  ];
}

const AUTH_ERROR =
  "Cora is not authenticated with a ChatGPT account (openai-codex). Connect one in Settings > Agents, or pick a model from an account you have connected.";
const AUTH_PARK_REASON =
  "Cora's provider account is not connected, or its sign-in expired. Connect it in Settings > Agents, then retry the saved turn.";

function pausedAuthRun(home: string, cwd: string): Json {
  const id = RUN_PAUSED;
  return {
    ...baseRun(home, cwd, id, "Autopilot manager loop", "2026-07-13T19:52:00.000Z"),
    status: "paused",
    updatedAt: "2026-07-13T19:52:09.000Z",
    sparkCalls: [
      {
        id: "spark-plan",
        runId: id,
        mode: "plan_analysis",
        model: "gpt-5.6-sol",
        status: "failed",
        inputMessageIds: ["msg-plan"],
        conversationEpoch: 0,
        error: AUTH_ERROR,
        createdAt: "2026-07-13T19:52:02.000Z",
        completedAt: "2026-07-13T19:52:08.000Z",
        durationMs: 6_000,
      },
    ],
    humanMessages: [
      message(id, {
        id: "msg-plan",
        author: "user",
        intent: "turn",
        deliveryState: "queued",
        deliveryAttempts: 1,
        message: "# Plan\n\nBuild the first autonomous manager loop.",
        createdAt: "2026-07-13T19:52:01.000Z",
      }),
    ],
    managerTurnRecovery: {
      id: "recovery-auth",
      state: "parked",
      failureKind: "auth",
      backend: "pi",
      managerMode: "plan_analysis",
      conversationEpoch: 0,
      failedSparkCallId: "spark-plan",
      parkedAt: "2026-07-13T19:52:09.000Z",
    },
    autopilot: {
      status: "paused",
      lastAction: "manager_turn_parked",
      stopReason: AUTH_PARK_REASON,
      pausedAt: "2026-07-13T19:52:09.000Z",
      updatedAt: "2026-07-13T19:52:09.000Z",
    },
  };
}

function longRun(home: string, cwd: string): Json {
  const id = RUN_LONG;
  const messages: Json[] = [];
  const calls: Json[] = [];
  const start = Date.parse("2026-07-12T14:00:00.000Z");
  for (let index = 1; index <= 18; index += 1) {
    const at = (offset: number) => new Date(start + index * 120_000 + offset).toISOString();
    const callId = `spark-long-${index}`;
    calls.push({
      id: callId,
      runId: id,
      mode: "chat",
      model: "gpt-5.6-sol",
      status: "completed",
      inputMessageIds: [`msg-long-user-${index}`],
      conversationEpoch: 0,
      createdAt: at(500),
      completedAt: at(9_000),
      durationMs: 8_500,
    });
    messages.push(
      message(id, {
        id: `msg-long-user-${index}`,
        author: "user",
        intent: "turn",
        backendTurnId: callId,
        message: index % 3 === 0
          ? `Question ${index}: walk me through how the composer decides between **Queue** and **Send now** while a worker is running, and what happens to an image attachment.`
          : `Question ${index}: what changed in step ${index}?`,
        createdAt: at(0),
      }),
      message(id, {
        id: `msg-long-answer-${index}`,
        author: "spark",
        intent: "answer",
        backendTurnId: callId,
        message: index === 18
          ? "Final answer 18: the review is complete.\n\n- Header and status are consistent.\n- The composer stays pinned to the bottom.\n- `npm run typecheck` passes."
          : `Answer ${index}: step ${index} moved \`describeRunStatus\` next to the composer strip so both read the same state. The run header and the composer can no longer disagree about whether a worker is live.`,
        createdAt: at(8_900),
      }),
    );
  }
  return {
    ...baseRun(home, cwd, id, "Long design review", "2026-07-12T14:00:00.000Z"),
    status: "complete",
    completedAt: "2026-07-12T14:40:00.000Z",
    updatedAt: "2026-07-12T14:40:00.000Z",
    sparkCalls: calls,
    humanMessages: messages,
    autopilot: { status: "complete", updatedAt: "2026-07-12T14:40:00.000Z" },
  };
}

function sentinelRun(home: string, cwd: string): Json {
  const id = RUN_SENTINEL;
  return {
    ...baseRun(home, cwd, id, "Boot sentinel", "2026-07-01T00:00:00.000Z"),
    status: "running",
    humanMessages: [
      message(id, { id: "msg-sentinel", author: "user", intent: "turn", message: "sentinel", createdAt: "2026-07-01T00:00:01.000Z" }),
    ],
    autopilot: { status: "running", updatedAt: "2026-07-01T00:00:01.000Z" },
  };
}

// The live state is stamped relative to now so durations and "working" chips
// read like a run in progress rather than one frozen weeks ago.
function runningRun(home: string, cwd: string): Json {
  const id = RUN_RUNNING;
  const now = Date.now();
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const task = (taskId: string, stepId: string, title: string, runtime: string, status: string, createdAt: string): Json => ({
    id: taskId,
    runId: id,
    stepId,
    title,
    description: title,
    runtimePreference: runtime,
    status,
    allowedPaths: ["src/main/orchestration/"],
    forbiddenPaths: [],
    expectedOutputs: [],
    verificationCommands: ["npm run typecheck"],
    canRunParallel: true,
    conflictsWith: [],
    createdBy: "spark",
    createdAt,
    updatedAt: createdAt,
  });
  const attempt = (attemptId: string, taskId: string, runtime: string, model: string, fields: Json): Json => ({
    id: attemptId,
    runId: id,
    workerTaskId: taskId,
    attemptNumber: 1,
    runtime,
    model,
    cwd,
    ...fields,
  });
  const step = (stepId: string, index: number, title: string, goal: string, status: string, taskIds: string[], createdAt: string): Json => ({
    id: stepId,
    runId: id,
    index,
    title,
    goal,
    kind: "worker_batch",
    status,
    acceptanceCriteria: [goal],
    verificationCommands: ["npm run typecheck"],
    workerTaskIds: taskIds,
    createdAt,
    updatedAt: createdAt,
  });
  return {
    ...baseRun(home, cwd, id, "Ship the run-store refactor", ago(420)),
    status: "running",
    currentStepId: "step-2",
    updatedAt: ago(5),
    steps: [
      step("step-1", 0, "Map run-store persistence", "List every writer of run.json.", "complete", ["task-map"], ago(390)),
      step("step-2", 1, "Split run-store persistence", "Move disk IO into run-persistence.ts without behavior change.", "running", ["task-split", "task-tests", "task-cache"], ago(240)),
      step("step-3", 2, "Verify and land", "Typecheck, unit suites, and a review pass.", "queued", [], ago(239)),
    ],
    workerTasks: [
      task("task-map", "step-1", "Map run.json writers", "codex", "accepted", ago(385)),
      task("task-split", "step-2", "Split run-store persistence", "codex", "running", ago(235)),
      task("task-tests", "step-2", "Port the persistence unit suite", "claude", "running", ago(234)),
      task("task-cache", "step-2", "Move the cache invalidation", "codex", "failed", ago(233)),
    ],
    workerAttempts: [
      attempt("attempt-map", "task-map", "codex", "gpt-5.6-sol", {
        status: "succeeded",
        startedAt: ago(380),
        finishedAt: ago(260),
        runtimeState: "done",
        runtimeStateUpdatedAt: ago(260),
        diffSummary: { fileCount: 1, additions: 12, deletions: 0, files: [{ path: "docs/run-store-writers.md", additions: 12, deletions: 0 }] },
      }),
      attempt("attempt-split", "task-split", "codex", "gpt-5.6-sol", {
        status: "running",
        startedAt: ago(230),
        runtimeState: "working",
        runtimeStateUpdatedAt: ago(3),
        runtimeActivity: "Editing src/main/orchestration/run-persistence.ts",
        runtimeActivityAt: ago(3),
      }),
      attempt("attempt-tests", "task-tests", "claude", "claude-sonnet-5", {
        status: "running",
        startedAt: ago(228),
        runtimeState: "working",
        runtimeStateUpdatedAt: ago(6),
        runtimeActivity: "Running npm test -- run-store",
        runtimeActivityAt: ago(6),
      }),
      // A failed worker, so the failure line under a worker row is shot too.
      attempt("attempt-cache", "task-cache", "codex", "gpt-5.6-sol", {
        status: "failed",
        startedAt: ago(226),
        finishedAt: ago(150),
        exitCode: 2,
        error:
          "npm run typecheck failed: src/main/orchestration/run-persistence.ts(42,7): error TS2339: Property 'cacheKey' does not exist on type 'RunState'.",
      }),
    ],
    sparkCalls: [
      {
        id: "spark-run-1",
        runId: id,
        mode: "chat",
        model: "gpt-5.6-sol",
        status: "completed",
        inputMessageIds: ["msg-run-user"],
        conversationEpoch: 0,
        createdAt: ago(415),
        completedAt: ago(395),
        durationMs: 20_000,
      },
      {
        id: "spark-run-2",
        runId: id,
        mode: "worker_result_review",
        stepId: "step-1",
        model: "gpt-5.6-sol",
        status: "completed",
        conversationEpoch: 0,
        createdAt: ago(258),
        completedAt: ago(245),
        durationMs: 13_000,
      },
    ],
    humanMessages: [
      message(id, {
        id: "msg-run-user",
        author: "user",
        intent: "turn",
        backendTurnId: "spark-run-1",
        message: "Split run-store.ts so persistence lives in its own module. No behavior change, keep every test green.",
        createdAt: ago(418),
      }),
      message(id, {
        id: "msg-run-answer",
        author: "spark",
        intent: "answer",
        backendTurnId: "spark-run-1",
        message: "On it. I'll map every writer of `run.json` first, then split persistence out with two workers in parallel and verify before landing.",
        createdAt: ago(396),
      }),
      message(id, {
        id: "msg-run-steer",
        author: "user",
        intent: "steer",
        deliveryState: "queued",
        message: "Also keep the cache invalidation in run-store.ts, not the new module.",
        createdAt: ago(40),
      }),
    ],
    autopilot: { status: "running", startedAt: ago(415), updatedAt: ago(5) },
  };
}

function runningEvents(): string[] {
  const now = Date.now();
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const e = (sequence: number, seconds: number, type: string, payload: Json) =>
    eventLine(RUN_RUNNING, "spark-run-1", sequence, ago(seconds), type, payload);
  return [
    e(1, 414, "chat.assistant_block", { kind: "assistant_block", messageId: "r-1", text: "Reading the run store before planning." }),
    e(2, 413, "chat.tool_use", { kind: "tool_use", toolUseId: "rt-1", toolName: "Grep", input: { pattern: "writeRunFile|saveRun", path: "src/main/orchestration" } }),
    e(3, 410, "chat.tool_result", { kind: "tool_result", toolUseId: "rt-1", output: "run-store.ts: 14 matches" }),
    e(4, 409, "chat.tool_use", { kind: "tool_use", toolUseId: "rt-2", toolName: "Read", input: { file_path: "src/main/orchestration/run-store.ts" } }),
    e(5, 405, "chat.tool_result", { kind: "tool_result", toolUseId: "rt-2", output: "..." }),
  ];
}
