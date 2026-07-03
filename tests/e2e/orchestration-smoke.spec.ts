import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("autopilot runs from a selected markdown plan", async () => {
  // Manual-fallback plan → pause → notes → resume → the TEST plays the worker
  // by writing final-report.json (the launch driver polls it every 750ms and
  // settles the attempt once it parses) → review + cycle completion. The whole
  // loop crosses several poll boundaries, so give it a generous budget.
  test.setTimeout(120_000);
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-agent-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        // No OpenRouter key + manual fallback → one deterministic "manual"
        // worker task whose pane is a plain shell: nothing external spawns
        // and nothing completes until the test writes the report.
        SPARK_ENABLE_MANUAL_FALLBACK: "1",
        // Worker panes must stay open until the test writes their report;
        // shell-integration injection can crash zsh startup in the Playwright
        // env ("Worker pane closed before final report", exit 1 within ~1s).
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Cora", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("workspace").first()).toBeVisible();

    const runId = await startPlanRun(page, workspaceDir);
    await openRunChat(page);
    // Wait until the worker attempt is actually live so Stop issues a pause
    // signal to it — sendPauseSignals only signals active workers. (Not
    // prompt_ready: the launch path clears final-report.json between
    // prompt_ready and launching, which would swallow the report we write.)
    await expect
      .poll(
        async () => {
          const current = await readOnlyRun(userDataDir);
          return current.workerAttempts.some((attempt) =>
            ["launching", "running"].includes(attempt.status),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // While a worker is live, the composer offers the force-stop control (its
    // click would KILL the pty — forcePauseRun has no graceful ESC path — and
    // a manual-fallback run has no manager to relaunch the task afterwards, so
    // we assert its presence without clicking it).
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();

    // Play the worker: write its final report (partial). The launch driver
    // polls final-report.json every 750ms and settles the attempt once it
    // parses; the manager review then runs and blocks the autopilot on the
    // partial verdict.
    const liveRun = await readOnlyRun(userDataDir);
    const liveAttempt = liveRun.workerAttempts.find((attempt) =>
      ["launching", "running"].includes(attempt.status),
    )!;
    expect(liveAttempt.finalReportPath).toBeTruthy();
    await writeFile(
      liveAttempt.finalReportPath!,
      JSON.stringify(fixtureWorkerReport("partial"), null, 2),
      "utf8",
    );

    await expectRunEvent(page, runId, "worker_report.reviewed", 30_000);
    await expectRunEvent(page, runId, "autopilot.cycle_completed", 30_000);
    // The final report is asserted from disk below. The old "ARTIFACTS" tab and
    // "FINAL REPORT" caption were removed with the run-controls redesign.

    const run = await readOnlyRun(userDataDir);
    const attempt = run.workerAttempts.at(-1)!;
    expect(attempt.status).toBe("succeeded");
    expect(run.workerTasks.some((task) => task.status === "needs_review")).toBe(true);
    expect(run.status).toBe("reviewing");
    expect(run.autopilot?.status).toBe("blocked");
    expect(run.plans[0].sourceFile).toMatch(/PLAN\.md$/);
    expect(run.plans[0].rawContent).toContain("Build the first autonomous manager loop.");

    // With the cycle complete (no live worker left to lose), exercise the stop
    // control: Stop = forcePauseRun → run.force_paused + run.status "paused",
    // which swaps the composer into its note-and-resume form. (A blocked
    // AUTOPILOT with a "reviewing" RUN still shows the normal composer — only
    // run.status paused/blocked does.)
    await page.getByRole("button", { name: "Stop run" }).click();
    await expectRunEvent(page, runId, "run.force_paused", 15_000);

    // Two human notes while paused, then resume.
    const noteComposer = page.getByPlaceholder("Add a note, then resume.");
    await noteComposer.fill("Pause before real workers.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await noteComposer.fill("Keep the user flow simple.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expectRunEvent(page, runId, "human.note");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expectRunEvent(page, runId, "run.resumed", 15_000);

    const resumed = await readOnlyRun(userDataDir);
    expect(resumed.humanMessages.map((message) => message.message)).toContain("Pause before real workers.");
    expect(resumed.humanMessages.map((message) => message.message)).toContain("Keep the user flow simple.");

    expect(attempt.stdoutLogPath && existsSync(attempt.stdoutLogPath)).toBeTruthy();
    expect(attempt.stderrLogPath && existsSync(attempt.stderrLogPath)).toBeTruthy();
    expect(attempt.rawLogPath && existsSync(attempt.rawLogPath)).toBeTruthy();
    const finalReportPath = attempt.finalReportPath;
    expect(finalReportPath && existsSync(finalReportPath)).toBeTruthy();
    if (!finalReportPath) throw new Error("Missing final report path");

    const report = JSON.parse(await readFile(finalReportPath, "utf8")) as { status: string };
    expect(report.status).toBe("partial");
  } finally {
    await app?.close();
  }
});

test("spark chat renders as a workbench tab", async () => {
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
    await page.setViewportSize({ width: 900, height: 747 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Cora", { exact: true }).first()).toBeVisible();

    // A fresh workspace seeds one draft chat tab (titled "New chat" until a run
    // promotes it) plus the terminals tab. The chat entry point is now a
    // renameable chat tab, not the fixed "Cora" label the old layout used.
    await expect(page.getByRole("tab", { name: /New chat/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /terminals/ })).toBeVisible();
    // The rail header button's accessible name is "Explorer <workspace name>";
    // a bare /Explorer/ regex also matches the Refresh/Reveal icon buttons.
    await expect(page.getByRole("button", { name: "Explorer workspace" })).toBeVisible();
  } finally {
    await app?.close();
  }
});

test("settings dialog saves default terminal, OpenRouter, and inline model settings", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-settings-e2e-");
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ inlineAutocompleteModelId: "google/gemini-3.1-flash-lite" }, null, 2),
    "utf8",
  );

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

    await page.getByRole("button", { name: "Editor" }).click();
    const inlineModelInput = page.getByRole("textbox", { name: "Inline AI model" });
    await expect(inlineModelInput).toHaveValue("google/gemini-3.5-flash");
    await expect(page.getByRole("button", { name: "Use Gemini 3.5 Flash for Inline AI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Use Gemini 3.5 Flash Nitro for Inline AI" }).click();
    await expect(inlineModelInput).toHaveValue("google/gemini-3.5-flash:nitro");
    await page.getByRole("button", { name: "Use GLM-4.7 Nitro for Inline AI" }).click();
    await expect(inlineModelInput).toHaveValue("z-ai/glm-4.7:nitro");
    await page.getByRole("button", { name: "Use default Inline AI model" }).click();
    await expect(inlineModelInput).toHaveValue("google/gemini-3.5-flash");
    const inlineWaitInput = page.getByLabel("Inline AI wait time");
    await expect(inlineWaitInput).toHaveValue("0");
    await page.getByRole("button", { name: /After pause/ }).click();
    await expect(inlineWaitInput).toHaveValue("1500");

    await page.getByRole("button", { name: "Default terminal" }).click();
    const terminalButton = page.getByRole("button", { name: /Use .* as default terminal/ }).first();
    await expect(terminalButton).toBeVisible();
    await terminalButton.click();

    await page.getByRole("button", { name: "API and model" }).click();
    await page.getByLabel("OPENROUTER API KEY").fill("test-openrouter-key");
    await page.getByLabel("MODEL").fill("test/settings-model");
    await clickButton(page, "Save");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();

    const settings = JSON.parse(await readFile(join(userDataDir, "spark-settings.json"), "utf8")) as {
      defaultShellId?: string;
      openRouterApiKey?: string;
      openRouterModel?: string;
    };
    expect(settings.defaultShellId).toBeTruthy();
    expect(settings.openRouterApiKey).toBe("test-openrouter-key");
    expect(settings.openRouterModel).toBe("test/settings-model");

    await expect
      .poll(async () => {
        const preferences = JSON.parse(
          await readFile(join(userDataDir, "spark-preferences.json"), "utf8"),
        ) as { inlineAutocompleteDelayMs?: number; inlineAutocompleteModelId?: string };
        return `${preferences.inlineAutocompleteModelId}:${preferences.inlineAutocompleteDelayMs}`;
      })
      .toBe("google/gemini-3.5-flash:1500");
  } finally {
    await app?.close();
  }
});

test("runs can be deleted from the run list inline", async () => {
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-agent-delete-run-e2e-");

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

    // A run only needs to EXIST to be deleted; createRun seeds one without
    // engaging the autopilot (no manager call, no worker spawn).
    await seedChatRun(page, workspaceDir);

    // Runs are now deleted inline from the chat-history popover (header button
    // "Open chat history") with a two-step arm/confirm on each row, replacing
    // the old DELETE RUN / CONFIRM DELETE run-list buttons.
    await page.getByRole("button", { name: "Open chat history" }).click();
    const deleteChat = page.getByRole("button", { name: "Delete chat", exact: true });
    await expect(deleteChat).toBeVisible({ timeout: 10_000 });
    // dispatchEvent, not click(): the popover rows re-render on run-store sync
    // ticks, so a real click's actionability wait ("stable" check) can detach
    // and retry forever. A dispatched click skips the stability wait; React's
    // delegated onClick handles it identically.
    await deleteChat.dispatchEvent("click");
    const confirmDelete = page.getByRole("button", { name: "Confirm delete chat", exact: true });
    await expect(confirmDelete).toBeVisible({ timeout: 10_000 });
    await confirmDelete.dispatchEvent("click");
    await expect(page.getByText("No chats yet")).toBeVisible({ timeout: 10_000 });

    const runsDir = join(userDataDir, "runs");
    await expect
      .poll(async () => (await readdir(runsDir).catch(() => [])).length, { timeout: 10_000 })
      .toBe(0);
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
        SPARK_ENABLE_MANUAL_FALLBACK: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await startPlanRun(page, workspaceDir);
    await waitForRunCount(userDataDir, 1);

    await writeFile(join(workspaceDir, "PLAN.md"), "# Plan\n\nBuild a one file HTML calculator.\n", "utf8");
    // startPlanRun re-reads PLAN.md from disk on each call, exactly as the
    // explorer's "Run plan" flow does, so the second run picks up the rewrite.
    await startPlanRun(page, workspaceDir);
    const latest = await waitForRunWithPlanText(userDataDir, "Build a one file HTML calculator.");

    expect(latest.plans[0].rawContent).toContain("Build a one file HTML calculator.");
    expect(latest.workerTasks[0].description).toContain("Build a one file HTML calculator.");

    const promptPath = latest.workerAttempts[0].promptPath;
    expect(promptPath && existsSync(promptPath)).toBeTruthy();
    if (!promptPath) throw new Error("Missing prompt path");
    const prompt = await readFile(promptPath, "utf8");
    // The worker prompt embeds the plan text under "## TASK" / "## STEP
    // CONTEXT" sections (the old "PROJECT PLAN SNAPSHOT" block is gone).
    expect(prompt).toContain("## TASK");
    expect(prompt).toContain("Build a one file HTML calculator.");
  } finally {
    await app?.close();
  }
});

test("OpenRouter manager can plan Claude and Codex worker tasks", async () => {
  // The manager planning contract runs against a fake OpenRouter server; the
  // workers themselves are played by the test (final-report.json writes, same
  // trick as the autopilot test). Fake `claude`/`codex` CLIs are prepended to
  // PATH so the worker panes never launch a real agent — and if the pane
  // shell's rc re-prepends the real CLI dir, that's still harmless because
  // completion is driven by the report file, not the CLI.
  test.setTimeout(120_000);
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-agent-openrouter-e2e-");
  const server = await startFakeOpenRouterServer();
  const fakeBin = await makeFakeAgentBin(userDataDir);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_OPENROUTER_API_KEY: "test-key",
        SPARK_OPENROUTER_BASE_URL: server.baseUrl,
        SPARK_OPENROUTER_MODEL: "test/unsupported-manager",
        SPARK_OPENROUTER_STRUCTURED_FALLBACK_MODEL: "test/spark-manager",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await startPlanRun(page, workspaceDir);
    await openRunChat(page);

    await waitForOnlyRun(userDataDir, (candidate) =>
      candidate.sparkCalls.some((call) => call.status === "completed") &&
      candidate.workerTasks.length === 2,
    );
    await expect(page.locator(".xterm-host")).toHaveCount(2, { timeout: 20_000 });
    await completeLiveAttempts(userDataDir, 2);
    const run = await waitForOnlyRun(userDataDir, (candidate) =>
      candidate.status === "complete" &&
      candidate.workerAttempts.length === 2 &&
      candidate.workerAttempts.every((attempt) => attempt.status === "succeeded") &&
      candidate.workerTasks.every((task) => task.status === "accepted"),
    );

    // plan_analysis → step_planning → 1+ worker_result_review calls (one per
    // reviewed report batch; whether the two reports land in one review tick
    // or two is scheduler timing).
    const modes = run.sparkCalls.map((call) => call.mode);
    expect(modes.slice(0, 2)).toEqual(["plan_analysis", "step_planning"]);
    expect(modes.length).toBeGreaterThanOrEqual(3);
    expect(modes.slice(2).every((mode) => mode === "worker_result_review")).toBe(true);
    expect(run.sparkCalls.every((call) => call.status === "completed")).toBe(true);
    expect(run.status).toBe("complete");
    expect(run.autopilot?.status).toBe("complete");
    expect(run.workerTasks).toHaveLength(2);
    expect(run.workerTasks.map((task) => task.runtimePreference).sort()).toEqual(["claude", "codex"]);
    expect(run.workerAttempts).toHaveLength(2);
    expect(run.workerAttempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(run.workerTasks.every((task) => task.status === "accepted")).toBe(true);
    // Prompt delivery: each attempt's on-disk prompt carries the structured
    // task section plus the fake manager's task description for its runtime.
    const prompts = await Promise.all(
      run.workerAttempts.map(async (attempt) => readFile(attempt.promptPath!, "utf8")),
    );
    expect(prompts.every((prompt) => prompt.includes("## TASK"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("Use Claude Code to inspect the plan"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("Use Codex to inspect the plan"))).toBe(true);
  } finally {
    await app?.close();
    await server.close();
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

// The old "Selected plan file" chip + "RUN" button were replaced by a
// chat-first flow: runs start either by typing into the composer or by
// right-clicking a plan file in the explorer ("Run plan"). The explorer path
// reads the file and hands it to window.spark.orchestration.startAutopilot
// (see App.handleRunPlan). We drive that same entry point directly so these
// tests exercise the real orchestrator without depending on the removed UI.
async function startPlanRun(page: Page, workspaceDir: string): Promise<string> {
  return page.evaluate(async (cwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const planPath = `${cwd}/PLAN.md`;
    const file = await spark.fs.readText(planPath);
    const run = await spark.orchestration.startAutopilot({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd,
      planPath,
      planTitle: "PLAN.md",
      planText: file.content,
    });
    return run.id as string;
  }, workspaceDir);
}

// Bring a run's chat tab forward so its composer, worker terminals, and node
// graph mount (mirrors handleRunPlan → handleSelectRun). Run-backed chat tabs
// are all labelled with the fixed CHAT_TAB_LABEL ("Cora") in App.tsx.
async function openRunChat(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Cora" }).click();
}

// Orchestration events no longer render inline in the run view; they live in
// the Session inspector overlay (Events log tab), backed by
// orchestration.listEvents. Poll that same source so we assert the manager
// actually emitted an event without depending on the overlay being open.
async function expectRunEvent(
  page: Page,
  runId: string,
  type: string,
  timeout = 5_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ id, eventType }) => {
            const spark = (window as unknown as { spark: any }).spark;
            const events = (await spark.orchestration.listEvents(id)) as Array<{ type: string }>;
            return events.some((event) => event.type === eventType);
          },
          { id: runId, eventType: type },
        ),
      { timeout },
    )
    .toBe(true);
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
        model?: string;
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
      if (parsedBody.model === "test/unsupported-manager") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
            },
          }),
        );
        return;
      }
      const prompt = parsedBody.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      const mode = prompt.match(/MANAGER MODE\n([a-z_]+)/)?.[1];
      const isPlanAnalysis = mode === "plan_analysis";
      const isReview = mode === "worker_result_review";
      // A SINGLE step: the current engine walks every planned step, so a
      // second "review" step would spawn a third worker instead of letting the
      // worker_result_review "complete" verdict end the run.
      const decision = isPlanAnalysis
        ? {
            status: "run_workers",
            summary: "Analyze the fixture plan into a durable step-by-step division.",
            steps: [
              {
                title: "Run local subscription workers",
                goal: "Launch local coding workers through Spark's worker control path.",
                plannedAgents: [
                  {
                    label: "agent 1",
                    summary: "Run Claude Code fixture worker for broad implementation slice.",
                    runtimePreference: "claude",
                    modelHint: "sonnet",
                    effortHint: "low",
                  },
                  {
                    label: "agent 2",
                    summary: "Run Codex fixture worker for validation slice.",
                    runtimePreference: "codex",
                    modelHint: "gpt-5.5",
                    effortHint: "low",
                  },
                ],
                acceptanceCriteria: ["Both worker tasks write final reports."],
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

// The report the test writes when it plays a worker. "complete" reviews to an
// accepted task; "partial" reviews to needs_review + a blocked autopilot.
function fixtureWorkerReport(status: "complete" | "partial"): Record<string, unknown> {
  return {
    status,
    summary: `E2E stand-in worker report (${status}).`,
    files_changed: [],
    commands_run: [{ command: "true", exit_code: 0, summary: "E2E fixture; no real work performed." }],
    tests: [],
    proof: ["The e2e test wrote this report in place of a live agent."],
    risks: [],
    followups: status === "partial" ? ["Continue the plan."] : [],
  };
}

// Fake `claude` / `codex` CLIs: print the TUI markers waitForAgentTui sniffs
// for (see worker-launch.ts), then idle until the report poll kills the pane.
async function makeFakeAgentBin(userDataDir: string): Promise<string> {
  const dir = join(userDataDir, "fake-bin");
  await mkdir(dir, { recursive: true });
  const make = async (name: string, marker: string) =>
    writeFile(join(dir, name), `#!/bin/sh\necho "${marker}"\nexec sleep 600\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
  await make("claude", "Sonnet ready (fake) -- bypass permissions on");
  await make("codex", "Codex GPT-5 ready (fake) /help");
  return dir;
}

// Play the workers: as attempts go live (launching/running — i.e. after the
// launch path has cleared any stale report file), write each one's
// final-report.json. The launch driver polls that file every 750ms and
// settles the attempt once it parses.
async function completeLiveAttempts(userDataDir: string, count: number): Promise<void> {
  const written = new Set<string>();
  await expect
    .poll(
      async () => {
        const run = await readOnlyRun(userDataDir);
        for (const attempt of run.workerAttempts) {
          const reportPath = attempt.finalReportPath;
          if (!reportPath || written.has(reportPath)) continue;
          if (!["launching", "running"].includes(attempt.status)) continue;
          await writeFile(reportPath, JSON.stringify(fixtureWorkerReport("complete"), null, 2), "utf8");
          written.add(reportPath);
        }
        return written.size;
      },
      { timeout: 60_000 },
    )
    .toBe(count);
}

// A run only needs to exist to appear in (and be deleted from) the chat
// history; createRun seeds one without engaging the autopilot.
async function seedChatRun(page: Page, cwd: string): Promise<void> {
  await page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Delete me",
    });
  }, cwd);
  await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
}

async function readOnlyRun(userDataDir: string): Promise<{
  status: string;
  autopilot?: { status: string };
  plans: Array<{ sourceFile?: string; rawContent?: string }>;
  humanMessages: Array<{ message: string }>;
  sparkCalls: Array<{ status: string; mode?: string }>;
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
