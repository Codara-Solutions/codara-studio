import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("autopilot runs from a selected markdown plan", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_MANUAL_WORKER_DELAY_MS: "15000",
        SPARK_ENABLE_MANUAL_FALLBACK: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("SPARK AGENT")).toBeVisible();
    await expect(page.getByText("workspace").first()).toBeVisible();

    await expect(page.locator("select")).toHaveValue(/PLAN\.md$/);
    await clickButton(page, "RUN");
    await expect(page.locator(".xterm-host")).toHaveCount(1, { timeout: 10_000 });

    await page.getByPlaceholder("Plan, instruction, correction, or answer...").fill("Pause before real workers.");
    await clickButton(page, "STOP");
    await expectEvent(page, "worker_attempt.pause_signal_sent");
    await expectEvent(page, "run.paused");

    await page.getByPlaceholder("Plan, instruction, correction, or answer...").fill("Keep the user flow simple.");
    await clickButton(page, "SEND");
    await expectEvent(page, "human.note");

    await clickButton(page, "RESUME");
    await expectEvent(page, "worker_attempt.resume_signal_sent");
    await expectEvent(page, "run.resumed");
    await expectEvent(page, "worker_report.reviewed", 25_000);
    await expectEvent(page, "autopilot.cycle_completed", 25_000);
    await page.getByRole("button", { name: "ARTIFACTS" }).click();
    await expect(page.getByText("FINAL REPORT")).toBeVisible();

    const run = await readOnlyRun(userDataDir);
    expect(run.workerAttempts).toHaveLength(1);
    expect(run.workerAttempts[0].status).toBe("succeeded");
    expect(run.workerTasks[0].status).toBe("needs_review");
    expect(run.status).toBe("reviewing");
    expect(run.autopilot?.status).toBe("blocked");
    expect(run.plans[0].sourceFile).toMatch(/PLAN\.md$/);
    expect(run.plans[0].rawContent).toContain("Build the first autonomous manager loop.");
    expect(run.humanMessages.map((message) => message.message)).toContain("Pause before real workers.");
    expect(run.humanMessages.map((message) => message.message)).toContain("Keep the user flow simple.");

    const attempt = run.workerAttempts[0];
    expect(attempt.stdoutLogPath && existsSync(attempt.stdoutLogPath)).toBeTruthy();
    expect(attempt.stderrLogPath && existsSync(attempt.stderrLogPath)).toBeTruthy();
    expect(attempt.rawLogPath && existsSync(attempt.rawLogPath)).toBeTruthy();
    expect(attempt.finalReportPath && existsSync(attempt.finalReportPath)).toBeTruthy();

    const report = JSON.parse(await readFile(attempt.finalReportPath, "utf8")) as { status: string };
    expect(report.status).toBe("partial");
  } finally {
    await app?.close();
  }
});

test("right sidebar sections stay ordered in a compact window", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-layout-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 357, height: 747 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("SPARK AGENT")).toBeVisible();

    const inspector = await page.getByText("DEV INSPECTOR").boundingBox();
    const explorer = await page.getByText("EXPLORER").boundingBox();

    expect(inspector).not.toBeNull();
    expect(explorer).not.toBeNull();
    expect(inspector!.y).toBeLessThan(explorer!.y);
  } finally {
    await app?.close();
  }
});

test("settings dialog saves default terminal and OpenRouter model settings", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-settings-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();

    const terminalButton = page.getByRole("button", { name: /Use .* as default terminal/ }).first();
    await expect(terminalButton).toBeVisible();
    await terminalButton.click();

    await page.getByRole("button", { name: "API + MODEL" }).click();
    await page.getByLabel("OPENROUTER API KEY").fill("test-openrouter-key");
    await page.getByLabel("MODEL").fill("test/settings-model");
    await clickButton(page, "SAVE");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();

    const settings = JSON.parse(await readFile(join(userDataDir, "spark-settings.json"), "utf8")) as {
      defaultShellId?: string;
      openRouterApiKey?: string;
      openRouterModel?: string;
    };
    expect(settings.defaultShellId).toBeTruthy();
    expect(settings.openRouterApiKey).toBe("test-openrouter-key");
    expect(settings.openRouterModel).toBe("test/settings-model");
  } finally {
    await app?.close();
  }
});

test("runs can be deleted from the run list inline", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-delete-run-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("select")).toHaveValue(/PLAN\.md$/);
    await clickButton(page, "RUN");
    await expect(page.getByRole("button", { name: "DELETE RUN", exact: true })).toBeEnabled({ timeout: 10_000 });

    await clickButton(page, "DELETE RUN");
    await clickButton(page, "CONFIRM DELETE");
    await expect(page.getByText("No runs yet.")).toBeVisible({ timeout: 10_000 });

    const runsDir = join(userDataDir, "runs");
    const entries = await readdir(runsDir).catch(() => []);
    expect(entries).toHaveLength(0);
  } finally {
    await app?.close();
  }
});

test("run uses the latest selected plan text instead of reusing old worker tasks", async () => {
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-agent-plan-refresh-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_MANUAL_WORKER_DELAY_MS: "100",
        SPARK_ENABLE_MANUAL_FALLBACK: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("select")).toHaveValue(/PLAN\.md$/);
    await clickButton(page, "RUN");
    await waitForRunCount(userDataDir, 1);

    await writeFile(join(workspaceDir, "PLAN.md"), "# Plan\n\nBuild a one file HTML calculator.\n", "utf8");
    await clickButton(page, "RUN");
    const latest = await waitForRunWithPlanText(userDataDir, "Build a one file HTML calculator.");

    expect(latest.plans[0].rawContent).toContain("Build a one file HTML calculator.");
    expect(latest.workerTasks[0].description).toContain("Build a one file HTML calculator.");

    const promptPath = latest.workerAttempts[0].promptPath;
    expect(promptPath && existsSync(promptPath)).toBeTruthy();
    const prompt = await readFile(promptPath, "utf8");
    expect(prompt).toContain("PROJECT PLAN SNAPSHOT");
    expect(prompt).toContain("Build a one file HTML calculator.");
  } finally {
    await app?.close();
  }
});

test("OpenRouter manager can plan Claude and Codex worker tasks", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-openrouter-e2e-");
  const server = await startFakeOpenRouterServer();
  const langSmith = await startFakeLangSmithServer();
  const workerArgs = JSON.stringify(["-e", fakeWorkerScript()]);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_OPENROUTER_API_KEY: "test-key",
        SPARK_OPENROUTER_BASE_URL: server.baseUrl,
        SPARK_OPENROUTER_MODEL: "test/spark-manager",
        LANGSMITH_API_KEY: "test-langsmith-key",
        LANGSMITH_ENDPOINT: langSmith.baseUrl,
        LANGSMITH_PROJECT: "spark-agent-e2e",
        LANGSMITH_TRACING: "true",
        LANGCHAIN_TRACING_V2: "true",
        SPARK_CLAUDE_WORKER_COMMAND: process.execPath,
        SPARK_CLAUDE_WORKER_ARGS: workerArgs,
        SPARK_CODEX_WORKER_COMMAND: process.execPath,
        SPARK_CODEX_WORKER_ARGS: workerArgs,
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("select")).toHaveValue(/PLAN\.md$/);
    await clickButton(page, "RUN");

    await waitForOnlyRun(userDataDir, (candidate) =>
      candidate.sparkCalls.some((call) => call.status === "completed") &&
      candidate.workerTasks.length === 2,
    );
    await expect(page.locator(".xterm-host")).toHaveCount(2, { timeout: 10_000 });
    const run = await waitForOnlyRun(userDataDir, (candidate) =>
      candidate.status === "complete" &&
      candidate.workerAttempts.length === 2 &&
      candidate.workerAttempts.every((attempt) => attempt.status === "succeeded") &&
      candidate.workerTasks.every((task) => task.status === "accepted"),
    );

    expect(run.sparkCalls).toHaveLength(3);
    expect(run.sparkCalls.every((call) => call.status === "completed")).toBe(true);
    expect(run.status).toBe("complete");
    expect(run.autopilot?.status).toBe("complete");
    expect(run.workerTasks).toHaveLength(2);
    expect(run.workerTasks.map((task) => task.runtimePreference).sort()).toEqual(["claude", "codex"]);
    expect(run.workerAttempts).toHaveLength(2);
    expect(run.workerAttempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(run.workerTasks.every((task) => task.status === "accepted")).toBe(true);
    const reports = await Promise.all(
      run.workerAttempts.map(async (attempt) =>
        JSON.parse(await readFile(attempt.finalReportPath!, "utf8")) as { proof?: string[] },
      ),
    );
    expect(reports.every((report) => report.proof?.some((item) => item.includes("STEP-BY-STEP DIVISION")))).toBe(
      true,
    );
    expect(reports.every((report) => report.proof?.some((item) => item.includes("YOUR TASK")))).toBe(true);
    expect(langSmith.posts).toHaveLength(3);
    expect(langSmith.patches).toHaveLength(3);
    expect(langSmith.posts.every((post) => post.session_name === "spark-agent-e2e")).toBe(true);
    expect(langSmith.posts.every((post) => post.inputs?.provider === "openrouter")).toBe(true);
  } finally {
    await app?.close();
    await server.close();
    await langSmith.close();
  }
});

async function prepareElectronWorkspace(prefix: string): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# E2E workspace\n", "utf8");
  await writeFile(join(workspaceDir, "PLAN.md"), "# Plan\n\nBuild the first autonomous manager loop.\n", "utf8");
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
  return { userDataDir, workspaceDir };
}

async function clickButton(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
}

async function expectEvent(page: Page, type: string, timeout = 5_000): Promise<void> {
  await expect(page.locator("button").filter({ hasText: type }).first()).toBeVisible({ timeout });
}

async function startFakeOpenRouterServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsedBody = JSON.parse(body) as {
        messages?: Array<{ content?: string }>;
        provider?: { require_parameters?: boolean };
        response_format?: {
          type?: string;
          json_schema?: { strict?: boolean; schema?: { required?: string[] } };
        };
      };
      if (
        parsedBody.provider?.require_parameters !== true ||
        parsedBody.response_format?.type !== "json_schema" ||
        parsedBody.response_format.json_schema?.strict !== true ||
        !parsedBody.response_format.json_schema.schema?.required?.includes("tasks")
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Expected strict OpenRouter structured output request." } }));
        return;
      }
      const prompt = parsedBody.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      const mode = prompt.match(/MANAGER MODE\n([a-z_]+)/)?.[1];
      const isPlanAnalysis = mode === "plan_analysis";
      const isReview = mode === "worker_result_review";
      const decision = isPlanAnalysis
        ? {
            status: "run_workers",
            summary: "Analyze the fixture plan into a durable step-by-step division.",
            steps: [
              {
                title: "Run local subscription workers",
                goal: "Launch local coding workers through Spark's worker control path.",
                acceptanceCriteria: ["Both worker tasks write final reports."],
                verificationCommands: ["npm run typecheck"],
                riskLevel: "low",
              },
              {
                title: "Review worker evidence",
                goal: "Compare final reports against the project plan and decide whether work is complete.",
                acceptanceCriteria: ["Spark accepts evidence or creates the next focused follow-up."],
                verificationCommands: ["npm run typecheck"],
                riskLevel: "low",
              },
            ],
            tasks: [],
          }
        : isReview
        ? {
            status: "complete",
            summary: "Both local subscription worker fixture reports are accepted, so the run is complete.",
            steps: [],
            tasks: [],
          }
        : {
            status: "run_workers",
            summary: "Create first-step worker prompts from the existing step division.",
            steps: [],
            tasks: [
              {
                stepIndex: 0,
                title: "Claude fixture task",
                description: "Use Claude Code to inspect the plan and report the first implementation slice.",
                runtimePreference: "claude",
                expectedOutputs: ["final-report.json"],
                verificationCommands: ["npm run typecheck"],
                canRunParallel: true,
              },
              {
                stepIndex: 0,
                title: "Codex fixture task",
                description: "Use Codex to inspect the plan and report risks or missing pieces.",
                runtimePreference: "codex",
                expectedOutputs: ["final-report.json"],
                verificationCommands: ["npm run typecheck"],
                canRunParallel: true,
              },
            ],
          };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(decision),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function startFakeLangSmithServer(): Promise<{
  baseUrl: string;
  posts: Array<{ session_name?: string; inputs?: { provider?: string } }>;
  patches: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const posts: Array<{ session_name?: string; inputs?: { provider?: string } }> = [];
  const patches: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const isPostRun = req.method === "POST" && req.url === "/runs";
    const isPatchRun = req.method === "PATCH" && Boolean(req.url?.startsWith("/runs/"));
    if (!isPostRun && !isPatchRun) {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (isPostRun) {
        posts.push(parsed as { session_name?: string; inputs?: { provider?: string } });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: parsed.id }));
        return;
      }
      patches.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    posts,
    patches,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function fakeWorkerScript(): string {
  return `
const fs = require("node:fs");
const reportPath = process.env.SPARK_FINAL_REPORT_PATH;
const title = process.env.SPARK_TASK_TITLE || "fake worker";
if (!reportPath) process.exit(1);
let input = "";
let finished = false;
console.log("fake worker ready:", title);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.includes("\\r")) finish();
});
setTimeout(() => finish(), 8000);
process.stdin.resume();

function finish() {
  if (finished) return;
  finished = true;
  const hasStructuredPrompt = input.includes("STEP-BY-STEP DIVISION") && input.includes("YOUR TASK");
  fs.writeFileSync(reportPath, JSON.stringify({
    status: hasStructuredPrompt ? "complete" : "failed",
    summary: title + " received " + (hasStructuredPrompt ? "the structured Spark prompt." : "an incomplete Spark prompt."),
    files_changed: [],
    commands_run: [{ command: "fake-worker", exit_code: hasStructuredPrompt ? 0 : 1, summary: "Captured terminal input and wrote final-report.json." }],
    tests: [],
    proof: [input.includes("STEP-BY-STEP DIVISION") ? "Received STEP-BY-STEP DIVISION." : "Missing STEP-BY-STEP DIVISION.", input.includes("YOUR TASK") ? "Received YOUR TASK." : "Missing YOUR TASK."],
    risks: hasStructuredPrompt ? [] : ["Worker did not receive the full structured prompt in terminal input."],
    followups: []
  }, null, 2), "utf8");
  console.log("fake worker complete:", title);
  process.exit(hasStructuredPrompt ? 0 : 1);
}
`;
}

async function readOnlyRun(userDataDir: string): Promise<{
  status: string;
  autopilot?: { status: string };
  plans: Array<{ sourceFile?: string; rawContent?: string }>;
  humanMessages: Array<{ message: string }>;
  sparkCalls: Array<{ status: string }>;
  steps: unknown[];
  workerTasks: Array<{ status: string; runtimePreference: string }>;
  workerAttempts: Array<{
    status: string;
    promptPath?: string;
    stdoutLogPath?: string;
    stderrLogPath?: string;
    rawLogPath?: string;
    finalReportPath?: string;
  }>;
}> {
  const runsDir = join(userDataDir, "runs");
  const entries = await readdir(runsDir);
  expect(entries).toHaveLength(1);
  const raw = await readFile(join(runsDir, entries[0], "run.json"), "utf8");
  return JSON.parse(raw);
}

async function waitForOnlyRun(
  userDataDir: string,
  predicate: (run: Awaited<ReturnType<typeof readOnlyRun>>) => boolean,
): Promise<Awaited<ReturnType<typeof readOnlyRun>>> {
  await expect
    .poll(async () => {
      try {
        return predicate(await readOnlyRun(userDataDir));
      } catch {
        return false;
      }
    }, { timeout: 20_000 })
    .toBe(true);
  return readOnlyRun(userDataDir);
}

async function waitForRunCount(
  userDataDir: string,
  count: number,
): Promise<Array<{
  createdAt: string;
  plans: Array<{ rawContent?: string }>;
  workerTasks: Array<{ description: string }>;
  workerAttempts: Array<{ promptPath?: string }>;
}>> {
  await expect
    .poll(async () => {
      const runs = await readRuns(userDataDir);
      const latest = runs.at(-1);
      return runs.length === count && latest?.workerAttempts?.[0]?.promptPath ? count : runs.length;
    }, { timeout: 10_000 })
    .toBe(count);
  return readRuns(userDataDir);
}

async function readRuns(userDataDir: string): Promise<Array<{
  createdAt: string;
  plans: Array<{ rawContent?: string }>;
  workerTasks: Array<{ description: string }>;
  workerAttempts: Array<{ promptPath?: string }>;
}>> {
  const runsDir = join(userDataDir, "runs");
  const entries = await readdir(runsDir).catch(() => []);
  const runs = (
    await Promise.all(
      entries.map(async (entry) => {
        try {
          return JSON.parse(await readFile(join(runsDir, entry, "run.json"), "utf8"));
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function waitForRunWithPlanText(
  userDataDir: string,
  text: string,
): Promise<{
  createdAt: string;
  plans: Array<{ rawContent?: string }>;
  workerTasks: Array<{ description: string }>;
  workerAttempts: Array<{ promptPath?: string }>;
}> {
  await expect
    .poll(async () => {
      const run = (await readRuns(userDataDir)).find((item) => item.plans[0]?.rawContent?.includes(text));
      const promptPath = run?.workerAttempts[0]?.promptPath;
      const prompt = promptPath && existsSync(promptPath) ? await readFile(promptPath, "utf8") : "";
      return Boolean(run?.workerTasks[0]?.description?.includes(text) && prompt.includes(text));
    }, { timeout: 10_000 })
    .toBe(true);
  return (await readRuns(userDataDir)).find((item) => item.plans[0]?.rawContent?.includes(text))!;
}
