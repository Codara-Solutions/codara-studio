import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Automation precheck and missed-run catch-up, end to end with NO model:
//
//   1. The trigger panel shows "Before each run" and "If a run was missed"
//      for a cron trigger (and neither for a manual one). "Test check" runs
//      the command in the workspace and says whether the pass would run, and
//      both settings are saved with the automation.
//   2. A per-second cron with a precheck: every fire is skipped (no pass,
//      a "skipped" history row with the command's output) until the file the
//      check looks for exists; then the next fire runs the pass.
//   3. Catch-up at start: two hourly automations whose last check was hours
//      ago. "Run once when back" runs ONE pass marked "caught up"; the default
//      records one skipped row instead.
//
// The app gets a throwaway HOME and SHELL=/bin/sh: a precheck runs in a login
// shell, which must not read the developer's own startup files.

const WS_ID = "ws-automations-e2e";

test("trigger panel: precheck and missed-run settings, Test check, and save", async () => {
  test.setTimeout(120_000);
  const { root, userDataDir } = await prepareElectronWorkspace("spark-automation-precheck-ui-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(root, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    await page.keyboard.press(automationsChord());
    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await expect(page.getByText("Start from a proven workflow", { exact: true })).toBeVisible();
    await page.getByPlaceholder("What is this automation for?").fill("Gated nightly");

    // A steps-only loom (no model): drop the default worker, add one shell step.
    await clickAttached(page.getByRole("button", { name: /Start blank/ }));
    await clickAttached(page.locator(".react-flow__node-worker"));
    await clickAttached(page.getByRole("button", { name: "Delete node", exact: true }));
    await clickAttached(page.locator('button[title="Add first step"]').first());
    const palette = page.getByRole("dialog", { name: "Add node" });
    await palette.getByRole("textbox", { name: "Search nodes" }).fill("shell");
    await page.keyboard.press("Enter");
    await page.getByTestId("step-command").fill("echo nightly");

    // The trigger panel: a manual trigger has neither gate.
    await clickAttached(page.locator(".react-flow__node-trigger"));
    await expect(page.getByText("When to start", { exact: true })).toBeVisible();
    await expect(page.getByTestId("precheck-section")).toHaveCount(0);
    await expect(page.getByTestId("missed-section")).toHaveCount(0);

    // A cadence loop's later passes are checked, so a manual trigger with one
    // shows the precheck (but no missed-run choice: nothing is scheduled).
    await clickAttached(page.getByTitle("Loop & stops: how the whole graph repeats"));
    await clickAttached(page.getByRole("button", { name: "Cadence", exact: true }));
    await clickAttached(page.locator(".react-flow__node-trigger"));
    await expect(page.getByTestId("precheck-section")).toBeVisible();
    await expect(page.getByTestId("precheck-section")).toContainText("before each pass the cadence loop starts");
    await expect(page.getByTestId("missed-section")).toHaveCount(0);
    await clickAttached(page.getByTitle("Loop & stops: how the whole graph repeats"));
    await clickAttached(page.getByRole("button", { name: "Once", exact: true }));
    await clickAttached(page.locator(".react-flow__node-trigger"));
    await expect(page.getByTestId("precheck-section")).toHaveCount(0);

    // A cron trigger has both.
    await clickAttached(page.getByRole("button", { name: "Cron", exact: true }));
    await page.getByPlaceholder("0 2 * * *").fill("0 3 * * *");
    await expect(page.getByTestId("precheck-section")).toBeVisible();
    await expect(page.getByTestId("missed-section")).toBeVisible();
    await expect(page.getByText("Before each run", { exact: true })).toBeVisible();
    await expect(page.getByText("If a run was missed", { exact: true })).toBeVisible();

    // Test check with a command that says no, then one that says yes.
    const command = page.getByTestId("precheck-command");
    await command.fill("echo nothing new; exit 3");
    await clickAttached(page.getByTestId("precheck-test"));
    await expect(page.getByTestId("precheck-result")).toContainText("Would skip");
    await expect(page.getByTestId("precheck-result")).toContainText("code 3");
    await expect(page.getByTestId("precheck-output")).toContainText("nothing new");
    await command.fill("test -f README.md");
    await expect(page.getByTestId("precheck-result")).toHaveCount(0); // a stale verdict is cleared
    await clickAttached(page.getByTestId("precheck-test"));
    await expect(page.getByTestId("precheck-result")).toContainText("Passed (exit 0");
    await page.getByTestId("precheck-timeout").fill("20");

    // Missed runs: run once when back, within a day.
    await expect(page.getByTestId("missed-grace")).toHaveCount(0);
    await clickAttached(page.getByRole("button", { name: "Run once when back", exact: true }));
    await page.getByTestId("missed-grace").selectOption("1440");

    await clickAttached(page.getByRole("button", { name: "Create automation", exact: true }));
    await expect(page.getByText("Gated nightly").first()).toBeVisible();

    const saved = await page.evaluate(async () => {
      const spark = (window as unknown as { spark: { scheduler: { list: () => Promise<Array<Record<string, unknown>>> } } }).spark;
      const job = (await spark.scheduler.list()).find((j) => j.name === "Gated nightly");
      return job ? { trigger: job.trigger, precheck: job.precheck, missedRuns: job.missedRuns } : null;
    });
    expect(saved).toEqual({
      trigger: { kind: "cron", expr: "0 3 * * *" },
      precheck: { command: "test -f README.md", timeoutSeconds: 20 },
      missedRuns: { policy: "runOnce", graceMinutes: 1440 },
    });
    // The hub's configuration lists both.
    await expect(page.getByText("test -f README.md (timeout 20s)").first()).toBeVisible();
    await expect(page.getByText("run once when back, if missed less than 1 day ago").first()).toBeVisible();
  } finally {
    await app?.close();
  }
});

test("a cron fire whose precheck fails is skipped until the check passes", async () => {
  test.setTimeout(120_000);
  const { root, userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-automation-precheck-engine-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(root, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();
    await page.keyboard.press(automationsChord());

    const id = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: { scheduler: { create: (i: unknown) => Promise<{ id: string }> } } }).spark;
      const job = await spark.scheduler.create({
        name: "Wait for go",
        trigger: { kind: "cron", expr: "* * * * * *" },
        loop: { kind: "once", stop: {} },
        worker: { model: "claude-opus-5", effort: "medium" },
        prompt: { template: "" },
        enabled: true,
        input: { workspaceId: "ws-automations-e2e", workspaceName: "workspace", cwd, initialUserNote: "", chatMode: "execute" },
        precheck: { command: 'if [ -f go.txt ]; then exit 0; fi; echo "waiting for go.txt"; exit 1', timeoutSeconds: 10 },
        graph: {
          version: 1,
          nodes: [{ id: "say", kind: "step", label: "Say", action: { type: "command", command: "echo went" } }],
          edges: [],
          entryNodeIds: ["say"],
        },
      });
      return job.id;
    }, workspaceDir);

    // Fires are skipped: skip records, no pass. The same skip again counts on
    // one row instead of adding a row per fire.
    await expect.poll(() => jobState(page, id).then((j) => j?.skips ?? 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    expect((await jobState(page, id))?.history).toBe(0);
    expect((await jobState(page, id))?.skipRows).toBe(1);

    // The hub shows them as a skipped row with the check's output.
    await clickAttached(page.getByRole("button", { name: /Wait for go/ }).first());
    const skipRow = page.locator('[data-testid="history-skip-row"][data-skip-reason="precheck"]').first();
    await expect(skipRow).toBeVisible();
    await expect(skipRow).toContainText("Skipped: the precheck exited with code 1.");
    await expect(skipRow.getByTestId("history-skip-badge")).toHaveText(/^skipped \d+ times$/);
    await clickAttached(skipRow.getByRole("button").first());
    await expect(skipRow.getByTestId("history-skip-output")).toContainText("waiting for go.txt");

    // Once the check passes, the next fire runs the pass.
    await writeFile(join(workspaceDir, "go.txt"), "go\n", "utf8");
    await expect
      .poll(() => jobState(page, id).then((j) => j?.lastStatus ?? null), { timeout: 30_000 })
      .toBe("complete");
    await page.evaluate(async (jobId) => {
      const spark = (window as unknown as { spark: { scheduler: { setEnabled: (id: string, on: boolean) => Promise<unknown> } } }).spark;
      await spark.scheduler.setEnabled(jobId, false);
    }, id);
  } finally {
    await app?.close();
  }
});

test("at start, a missed hourly run is caught up once or recorded as skipped", async () => {
  test.setTimeout(120_000);
  const { root, userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-automation-catchup-e2e-");

  // Seed two hourly automations last checked three and a half hours ago, as if
  // Codara had been closed since.
  const now = Date.now();
  const seed = (id: string, name: string, extra: Record<string, unknown>) => ({
    id,
    name,
    trigger: { kind: "cron", expr: "0 * * * *" },
    enabled: true,
    input: { workspaceId: WS_ID, workspaceName: "workspace", cwd: workspaceDir, initialUserNote: "", chatMode: "execute" },
    loop: { kind: "once", stop: {} },
    prompt: { template: "" },
    worker: { model: "claude-opus-5", effort: "medium" },
    graph: {
      version: 1,
      nodes: [{ id: "say", kind: "step", label: "Say", action: { type: "command", command: `echo ${name}` } }],
      edges: [],
      entryNodeIds: ["say"],
    },
    state: { status: "idle", iteration: 0 },
    history: [],
    createdAt: new Date(now - 2 * 24 * 3_600_000).toISOString(),
    scheduleCheckedAt: new Date(now - 3.5 * 3_600_000).toISOString(),
    ...extra,
  });
  await writeFile(
    join(userDataDir, "scheduler.json"),
    JSON.stringify(
      {
        jobs: [
          seed("job-catchup-e2e", "Catch up hourly", { missedRuns: { policy: "runOnce", graceMinutes: 720 } }),
          seed("job-skip-e2e", "Skip hourly", {}),
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(root, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();
    await page.keyboard.press(automationsChord());

    // runOnce: exactly one pass, marked as a catch-up for the 3 or 4 missed times.
    await expect
      .poll(() => jobState(page, "job-catchup-e2e").then((j) => j?.lastStatus ?? null), { timeout: 30_000 })
      .toBe("complete");
    const caught = await jobState(page, "job-catchup-e2e");
    expect(caught?.catchUps).toBe(1);
    expect(caught?.missedCount).toBeGreaterThanOrEqual(3);
    expect(caught?.skips).toBe(0);

    // skip (the default): no pass, one skipped row.
    const skipped = await jobState(page, "job-skip-e2e");
    expect(skipped?.history).toBe(0);
    expect(skipped?.skips).toBe(1);
    expect(skipped?.firstSkip).toMatch(/^\d+ scheduled runs were missed while Codara was closed and skipped\.$/);

    await clickAttached(page.getByRole("button", { name: /Catch up hourly/ }).first());
    await expect(page.getByText("caught up", { exact: true }).first()).toBeVisible();
    await clickAttached(page.getByRole("button", { name: /Skip hourly/ }).first());
    const row = page.locator('[data-testid="history-skip-row"][data-skip-reason="missed"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("missed while Codara was closed and skipped");
  } finally {
    await app?.close();
  }
});

async function jobState(
  page: Page,
  id: string,
): Promise<{
  history: number;
  /** Skipped passes, a repeated row counted as many times as it repeated. */
  skips: number;
  skipRows: number;
  lastStatus?: string;
  catchUps: number;
  missedCount?: number;
  firstSkip?: string;
} | null> {
  return page.evaluate(async (jobId) => {
    type Rec = { status: string; catchUp?: { missedCount: number } };
    type Job = { id: string; history: Rec[]; skips?: Array<{ detail: string; repeats?: number }> };
    const spark = (window as unknown as { spark: { scheduler: { list: () => Promise<Job[]> } } }).spark;
    const job = (await spark.scheduler.list()).find((j) => j.id === jobId);
    if (!job) return null;
    const last = job.history[job.history.length - 1];
    const caught = job.history.filter((r) => r.catchUp);
    return {
      history: job.history.length,
      skips: (job.skips ?? []).reduce((n, skip) => n + (skip.repeats ?? 1), 0),
      skipRows: job.skips?.length ?? 0,
      lastStatus: last?.status,
      catchUps: caught.length,
      missedCount: caught[0]?.catchUp?.missedCount,
      firstSkip: job.skips?.[0]?.detail,
    };
  }, id);
}

async function launchApp(root: string, userDataDir: string): Promise<ElectronApplication> {
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/sh",
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

function automationsChord(): string {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return `${mod}+Shift+A`;
}

async function prepareElectronWorkspace(
  prefix: string,
): Promise<{ root: string; userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# E2E workspace\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [{ id: WS_ID, name: "workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
        activeWorkspaceId: WS_ID,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, workspaceDir };
}
