import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An automation's spending limits, end to end with NO model. The registry is
// seeded with sample automations:
//
//   1. One that reached its monthly cap and one paused after failed runs both sit
//      on Needs you, and the card says why.
//   2. Run now on the capped one is refused, starts nothing and leaves a row.
//   3. Resuming the paused one takes it off Needs you.
//   4. In the editor the worst case changes as limits are typed, and they are saved.
//
// Optional: COST_GUARD_SHOTS_DIR=<dir> saves screenshots at the key moments.

const WS_ID = "ws-automations-cost-guard-e2e";
const SHOTS = process.env.COST_GUARD_SHOTS_DIR;

async function shot(app: ElectronApplication, page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1680, 1000));
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function seedJobs(cwd: string): unknown[] {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const at = now.toISOString();
  const worker = { model: "claude-opus-5", effort: "medium" };
  const base = (id: string, name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    name,
    trigger: { kind: "cron", expr: "0 2 * * *" },
    enabled: true,
    input: { workspaceId: WS_ID, workspaceName: "sample-repo", cwd, initialUserNote: "", chatMode: "execute" },
    loop: { kind: "once", stop: { budgetUsd: 2 } },
    prompt: { template: "" },
    worker,
    graph: {
      version: 1,
      nodes: [{ id: "w0", kind: "worker", label: "Worker", prompt: "Do the work", worker }],
      edges: [],
      entryNodeIds: ["w0"],
    },
    state: { status: "idle", iteration: 0 },
    history: [],
    createdAt: at,
    scheduleCheckedAt: at,
    ...extra,
  });
  const run = (id: string, status: string, cost: number, summary: string, stopReason: string): Record<string, unknown> => ({
    iteration: 0,
    runId: `run-sample-${id}`,
    startedAt: at,
    finishedAt: at,
    status,
    costUsd: cost,
    summary,
    stopReason,
  });
  return [
    base("job-capped", "Nightly dependency review", {
      guard: { monthlyCapUsd: 20 },
      monthSpend: { month, costUsd: 21.5, measuredCostUsd: 0 },
      history: [run("capped", "complete", 1.5, "Reviewed 3 dependency updates.", "monthly-cap")],
      state: { status: "stopped", iteration: 1, lastStopReason: "monthly-cap" },
    }),
    base("job-paused", "Fix flaky tests", {
      guard: { pauseAfterFailures: 3 },
      failureStreak: 3,
      autoPaused: { at, failures: 3 },
      history: [run("paused", "failed", 0.4, "The test command could not start.", "iteration-failed")],
      state: { status: "paused", iteration: 0, lastStopReason: "iteration-failed" },
    }),
  ];
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

async function savedJob(userDataDir: string, name: string): Promise<Record<string, unknown>> {
  const { jobs } = JSON.parse(await readFile(join(userDataDir, "scheduler.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };
  return jobs.find((j) => j.name === name) ?? {};
}

test("limits hold an automation back, say why, and the editor shows the worst case", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "spark-automations-cost-guard-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "sample-repo");
  const home = join(root, "home");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# sample\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: WS_ID, name: "sample-repo", cwd: workspaceDir, color: "#F0C419", workers: [] }], activeWorkspaceId: WS_ID }),
    "utf8",
  );
  await writeFile(join(userDataDir, "scheduler.json"), JSON.stringify({ jobs: seedJobs(workspaceDir) }), "utf8");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
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
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+A" : "Control+Shift+A");

    // Both are on Needs you, and each card says why.
    await expect(page.locator(".automation-group")).toHaveText(["Needs you2"]);
    const capped = page.locator(".automation-row", { hasText: "Nightly dependency review" });
    await clickAttached(capped);
    const card = page.getByTestId("automation-result");
    await expect(card).toContainText("Monthly cap reached");
    await expect(card).toContainText("$21.50 of its $20.00 cap");
    await expect(page.getByTestId("automation-health")).toContainText("of $20.00 cap");
    await expect(card.getByRole("button", { name: "Fix with Cora" })).toHaveCount(0);
    await expect(page.getByTestId("automation-worst-case")).toContainText("about $20.00 a month");
    await expect(page.getByText("$20.00 a month", { exact: true })).toBeVisible();
    await shot(app, page, "cost-guard-cap");

    // Run now is refused: nothing starts, and the row says why.
    await clickAttached(page.getByRole("button", { name: "Run now", exact: true }));
    await expect(page.getByText(/reached its monthly cap of \$20\.00/).first()).toBeVisible();
    await expect(page.locator('[data-testid="history-skip-row"][data-skip-reason="monthlyCap"]')).toBeVisible();
    await expect(capped).not.toContainText("Running");
    expect((await savedJob(userDataDir, "Nightly dependency review")).history).toHaveLength(1);

    const paused = page.locator(".automation-row", { hasText: "Fix flaky tests" });
    await clickAttached(paused);
    await expect(card).toContainText("Paused after 3 failed runs");
    await shot(app, page, "cost-guard-paused");

    // Resuming takes it off Needs you, and starts nothing by itself.
    await clickAttached(page.getByRole("button", { name: "Resume", exact: true }));
    await expect(page.locator(".automation-group")).toHaveText(["Needs you1", "Failed1"]);
    await expect.poll(async () => (await savedJob(userDataDir, "Fix flaky tests")).autoPaused).toBeUndefined();
    expect((await savedJob(userDataDir, "Fix flaky tests")).history).toHaveLength(1);

    // The editor: the worst case follows what is typed, and the limits are saved.
    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await clickAttached(page.getByRole("button", { name: /Agent decides/ }));
    await page.getByPlaceholder("What is this automation for?").fill("Sample with limits");
    await clickAttached(page.getByRole("button", { name: /^Loop/ }));
    const forecast = page.getByTestId("cost-forecast");
    await page.getByLabel("Budget cap").fill("");
    await expect(forecast).toHaveAttribute("data-open", "true");
    await expect(forecast).toContainText("No ceiling");
    await forecast.scrollIntoViewIfNeeded();
    await shot(app, page, "cost-guard-no-ceiling");
    await page.getByLabel("Budget cap").fill("5");
    await expect(forecast).toHaveAttribute("data-open", "false");
    await expect(forecast).toContainText("about $5.00 each time you run it");
    await page.getByLabel("Monthly cap").fill("20");
    await expect(forecast).toContainText("about $20.00 a month");
    // A typo blocks saving, instead of quietly dropping the limit. "1e" matters:
    // a number input would report it as empty, which means "remove the limit".
    await page.getByLabel("Monthly cap").fill("1e");
    await expect(page.getByRole("button", { name: "Create automation", exact: true })).toBeDisabled();
    await expect(page.getByText(/monthly cap must be a number/)).toBeVisible();
    await page.getByLabel("Monthly cap").fill("20");
    await page.getByLabel("Pause after").fill("0");
    await expect(page.getByRole("button", { name: "Create automation", exact: true })).toBeDisabled();
    await expect(page.getByText(/Pause after must be a whole number/)).toBeVisible();
    await page.getByLabel("Pause after").fill("3");
    await expect(page.getByRole("button", { name: "Create automation", exact: true })).toBeEnabled();
    await forecast.scrollIntoViewIfNeeded();
    await shot(app, page, "cost-guard-forecast");
    await clickAttached(page.getByRole("button", { name: "Create automation", exact: true }));
    await expect.poll(async () => (await savedJob(userDataDir, "Sample with limits")).guard).toEqual({ monthlyCapUsd: 20, pauseAfterFailures: 3 });
  } finally {
    if (app) await app.close();
  }
});
