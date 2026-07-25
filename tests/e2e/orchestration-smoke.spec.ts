import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        // Throwaway user-data dir → no Pi subscription auth → the manager
        // produces no decision, and manual fallback turns that into one
        // deterministic "manual" worker task whose pane is a plain shell:
        // nothing external spawns and nothing completes until the test
        // writes the report.
        SPARK_ENABLE_MANUAL_FALLBACK: "1",
        SPARK_E2E_LEGACY_WORKER_HARNESS: "1",
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
    await clickAttached(page.getByRole("button", { name: "Stop run" }));
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
    // At this 900px compact viewport the right rail starts collapsed and is
    // available as an overlay through the window-chrome toggle.
    const rightSidebarToggle = page.getByTitle("Toggle right sidebar");
    await expect(rightSidebarToggle).toBeAttached();
    await rightSidebarToggle.dispatchEvent("click");
    await expect(page.getByRole("button", { name: "Explorer workspace" })).toBeVisible();
  } finally {
    await app?.close();
  }
});

test("settings dialog saves default terminal, OpenRouter, and inline model settings", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-settings-e2e-");
  const piAuthDir = join(userDataDir, "pi-agent");
  await mkdir(piAuthDir, { recursive: true });
  await writeFile(
    join(piAuthDir, "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "synthetic-anthropic-access-never-cross-ipc",
        refresh: "synthetic-anthropic-refresh-never-cross-ipc",
        expires: Date.now() + 60 * 60 * 1000,
      },
      "openai-codex": {
        type: "oauth",
        access: "synthetic-openai-access-never-cross-ipc",
        refresh: "synthetic-openai-refresh-never-cross-ipc",
        expires: Date.now() + 60 * 60 * 1000,
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
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

    const settingsButton = page.getByRole("button", { name: "Settings" });
    await expect(settingsButton).toBeAttached();
    const settingsOpenLatencyMs = await settingsButton.evaluate((button) => new Promise<number>((resolve) => {
      const startedAt = performance.now();
      const existing = document.querySelector("[data-settings-surface]");
      if (existing) {
        resolve(0);
        return;
      }
      const observer = new MutationObserver(() => {
        if (!document.querySelector("[data-settings-surface]")) return;
        observer.disconnect();
        resolve(performance.now() - startedAt);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }));
    expect(settingsOpenLatencyMs).toBeLessThan(250);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    const settingsGlass = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>("[data-settings-surface]");
      const scrim = document.querySelector<HTMLElement>(".settings-dialog-scrim");
      if (!surface || !scrim) return null;
      return {
        surfaceBackdrop: getComputedStyle(surface).backdropFilter,
        scrimBackdrop: getComputedStyle(scrim).backdropFilter,
      };
    });
    expect(settingsGlass).not.toBeNull();
    expect(settingsGlass!.surfaceBackdrop).not.toContain("url(");
    expect(settingsGlass!.scrimBackdrop).toBe("none");

    await clickAttached(page.getByRole("button", { name: "Agents" }));
    await expect(page.getByText("Cora subscriptions", { exact: true })).toBeVisible();
    await expect(page.getByText("ChatGPT Plus / Pro", { exact: true })).toBeVisible();
    await expect(page.getByText("Claude Pro / Max", { exact: true })).toBeVisible();
    await expect(page.getByText(/one auth store for manager \+ workers/)).toBeVisible();
    await expect(page.getByText(/GPT-5\.6 Sol · Connected/)).toBeVisible();
    await expect(page.getByText(/Fable 5 · Connected/)).toBeVisible();
    const serializedSubscriptionStatus = await page.evaluate(async () => {
      const spark = (window as unknown as { spark: any }).spark;
      return JSON.stringify(await spark.piSubscriptions.status());
    });
    expect(serializedSubscriptionStatus).not.toContain("synthetic-anthropic-access");
    expect(serializedSubscriptionStatus).not.toContain("synthetic-anthropic-refresh");
    expect(serializedSubscriptionStatus).not.toContain("synthetic-openai-access");
    expect(serializedSubscriptionStatus).not.toContain("synthetic-openai-refresh");

    await clickAttached(page.getByRole("button", { name: "Sessions" }));
    const restoreSessions = page.getByRole("switch", {
      name: "Resume running agent sessions when Codara reopens",
    });
    await expect(restoreSessions).toHaveAttribute("aria-checked", "false");
    await clickAttached(restoreSessions);
    await expect(restoreSessions).toHaveAttribute("aria-checked", "true");

    await clickAttached(page.getByRole("button", { name: "Editor" }));
    const inlineModelInput = page.getByRole("textbox", { name: "Inline AI model" });
    await expect(inlineModelInput).toHaveValue("google/gemini-3.5-flash");
    await expect(page.getByRole("button", { name: "Use Gemini 3.5 Flash for Inline AI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await clickAttached(page.getByRole("button", { name: "Use Gemini 3.5 Flash Nitro for Inline AI" }));
    await expect(inlineModelInput).toHaveValue("google/gemini-3.5-flash:nitro");
    await clickAttached(page.getByRole("button", { name: "Use GLM-4.7 Nitro for Inline AI" }));
    await expect(inlineModelInput).toHaveValue("z-ai/glm-4.7:nitro");
    await clickAttached(page.getByRole("button", { name: "Use default Inline AI model" }));
    await expect(inlineModelInput).toHaveValue("google/gemini-3.5-flash");
    const inlineWaitInput = page.getByLabel("Inline AI wait time");
    await expect(inlineWaitInput).toHaveValue("0");
    await clickAttached(page.getByRole("button", { name: /After pause/ }));
    await expect(inlineWaitInput).toHaveValue("1500");

    await clickAttached(page.getByRole("button", { name: "Default terminal" }));
    const terminalButton = page.getByRole("button", { name: /Use .* as default terminal/ }).first();
    await expect(terminalButton).toBeVisible();
    await clickAttached(terminalButton);

    await clickAttached(page.getByRole("button", { name: "API and model" }));
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
        ) as {
          inlineAutocompleteDelayMs?: number;
          inlineAutocompleteModelId?: string;
          restoreAgentSessions?: boolean;
        };
        return `${preferences.inlineAutocompleteModelId}:${preferences.inlineAutocompleteDelayMs}:${preferences.restoreAgentSessions}`;
      })
      .toBe("google/gemini-3.5-flash:1500:true");

    // The Capability Center shares Settings' footprint. Its shell must also
    // paint without the SVG lens/full-screen blur combination that made
    // opening and typing visibly trail the pointer.
    const capabilityOpenLatencyMs = await page.getByTitle("MCP and skills").evaluate((button) => new Promise<number>((resolve) => {
      const startedAt = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector("[data-agent-capabilities-surface]")) return;
        observer.disconnect();
        resolve(performance.now() - startedAt);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }));
    expect(capabilityOpenLatencyMs).toBeLessThan(250);
    await expect(page.getByRole("dialog", { name: "Capability Center" })).toBeVisible();
    // The pinned codara-studio row arrives with the builtin status IPC, so the
    // content-visibility gate below needs a row on screen first.
    await expect(page.locator(".agent-capability-row").first()).toBeVisible();
    const capabilityGlass = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>("[data-agent-capabilities-surface]");
      const scrim = document.querySelector<HTMLElement>(".agent-capabilities-scrim");
      if (!surface || !scrim) return null;
      return {
        surfaceBackdrop: getComputedStyle(surface).backdropFilter,
        scrimBackdrop: getComputedStyle(scrim).backdropFilter,
        scrollContain: getComputedStyle(document.querySelector<HTMLElement>(".agent-capabilities-scroll")!).contain,
        rowVisibility: getComputedStyle(document.querySelector<HTMLElement>(".agent-capability-row")!).contentVisibility,
        width: surface.getBoundingClientRect().width,
        height: surface.getBoundingClientRect().height,
        borderRadius: getComputedStyle(surface).borderRadius,
        expectedWidth: Math.min(880, window.innerWidth - 44),
        expectedHeight: Math.min(760, window.innerHeight - 44),
      };
    });
    expect(capabilityGlass).not.toBeNull();
    // Peer of the Settings panel: one composited blur layer, never the SVG
    // refraction lens that made a viewport-sized surface re-rasterize.
    expect(capabilityGlass!.surfaceBackdrop).not.toContain("url(");
    expect(capabilityGlass!.scrimBackdrop).toBe("none");
    expect(capabilityGlass!.scrollContain).toMatch(/content|paint/);
    expect(capabilityGlass!.rowVisibility).toBe("auto");
    expect(capabilityGlass!.width).toBe(capabilityGlass!.expectedWidth);
    expect(capabilityGlass!.height).toBe(capabilityGlass!.expectedHeight);
    expect(capabilityGlass!.borderRadius).toBe("12px");
    if (process.env.SPARK_CAPABILITY_SCREENSHOT) {
      await page.screenshot({ path: process.env.SPARK_CAPABILITY_SCREENSHOT });
    }
    // Two flat sections, no nav rail: the MCP inventory is the first heading.
    await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();
    const capabilitySearch = page.getByPlaceholder("Filter servers");
    await capabilitySearch.fill("playwright");
    await expect(capabilitySearch).toHaveValue("playwright");
    await page.getByRole("button", { name: "Close", exact: true }).click();
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
    await clickAttached(page.getByRole("button", { name: "Open chat history" }));
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
        SPARK_E2E_LEGACY_WORKER_HARNESS: "1",
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

// REMOVED: "OpenRouter manager can plan Claude and Codex worker tasks".
// That test drove the manager through a fake OpenRouter HTTP server
// (SPARK_OPENROUTER_* env + a strict-structured-output endpoint plus the
// unsupported-model fallback). Cora no longer has an HTTP manager backend , 
// claude / codex / pi are all local CLI/runtime backends with no mockable
// endpoint, so the fixture has nothing left to point at. The equivalent
// end-to-end manager planning contract is covered by
// tests/e2e/pi-manager-live-smoke.spec.ts (opt-in via
// CODARA_E2E_PI_MANAGER_LIVE=1, real subscription auth).

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
  await button.dispatchEvent("click");
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
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
      // No chatBackend override: the run takes Cora's default (Pi). With no
      // subscription auth in the throwaway user-data dir the manager yields
      // no decision, which is what SPARK_ENABLE_MANUAL_FALLBACK turns into the
      // deterministic manual worker task these fixtures drive.
    });
    return run.id as string;
  }, workspaceDir);
}

// Bring a run's chat tab forward so its composer, worker terminals, and node
// graph mount (mirrors handleRunPlan → handleSelectRun). Run-backed chat tabs
// are all labelled with the fixed CHAT_TAB_LABEL ("Cora") in App.tsx.
async function openRunChat(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "Cora" });
  await expect(tab).toBeAttached();
  await tab.dispatchEvent("click");
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
