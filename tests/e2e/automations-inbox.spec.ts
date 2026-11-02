import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Automations tab as an inbox, end to end with NO model. The registry is
// seeded with sample automations and one fails for real through the engine:
//
//   1. The rail groups them (needs you, failed, scheduled, paused) with plain
//      schedules, the top of the inbox opens first, and search narrows it.
//   2. The page describes an automation in one sentence and shows its recent
//      runs and month so far.
//   3. A real failing run lands on the Failed shelf with a result card, "See
//      what it did" opens its output and "Fix with Cora" leaves a message in a
//      Cora chat's box without sending it.
//   4. Pausing from the row moves it to Paused, and turning it on brings it back.
//
// Optional: INBOX_SHOTS_DIR=<dir> saves screenshots at the key moments.

const WS_ID = "ws-automations-inbox-e2e";
const SHOTS = process.env.INBOX_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  // The same screen on a light theme: tone text has to hold up on both.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "codara-daylight"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}-light.png`) });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
}

// Proof pictures read better on a wider window; the assertions do not care.
async function widen(app: ElectronApplication): Promise<void> {
  if (!SHOTS) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1680, 1000));
}

test("the inbox groups automations and explains the open one in plain words", async () => {
  test.setTimeout(150_000);
  const { root, userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-automations-inbox-e2e-");
  await writeFile(join(userDataDir, "scheduler.json"), JSON.stringify({ jobs: seedJobs(workspaceDir) }, null, 2), "utf8");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(root, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(automationsChord());
    await widen(app);

    // Shelves in order, with counts.
    const groups = page.locator(".automation-group");
    await expect(groups).toHaveText(["Needs you1", "Failed1", "Scheduled2", "Paused1"]);

    // The top of the inbox is open: the one waiting on an answer.
    const needs = page.locator(".automation-row", { hasText: "Review new pull requests" });
    await expect(needs).toHaveAttribute("aria-current", "true");
    await expect(needs).toContainText("Needs you");

    // Plain schedules, never a raw cron for a shape it can read.
    const nightly = page.locator(".automation-row", { hasText: "Fix flaky tests" });
    await expect(nightly).toContainText("Every weekday at 02:00");
    await expect(nightly).toContainText(/Failed/);
    const audit = page.locator(".automation-row", { hasText: "Dependency audit" });
    await expect(audit).toContainText(/Every day at 06:00 · next in/);
    await shot(page, "inbox-needs-you");

    // The open automation's sentence, recent runs and month.
    await clickAttached(nightly);
    const sentence = page.getByTestId("automation-sentence");
    await expect(sentence).toHaveText("Every weekday at 02:00, Opus 5 works in sample-repo, until the tests pass, stopping at $2.00.");
    await expect(sentence.locator("b")).toHaveText(["Opus 5", "sample-repo", "$2.00"]);
    const result = page.getByTestId("automation-result");
    await expect(result).toContainText("Stopped: budget reached");
    await expect(result).toContainText("login.spec.ts still times out");
    await expect(result.getByRole("button", { name: "Fix with Cora" })).toBeVisible();
    const health = page.getByTestId("automation-health");
    await expect(health).toContainText("Last 6 runs, 2 failed, 1 skipped");
    await expect(health).toContainText("5 runs this month");
    await expect(health).toContainText("2 failed");
    await expect(health).toContainText("est. $2.90");
    await shot(page, "inbox-failed");

    await clickAttached(page.locator(".automation-row", { hasText: "Dependency audit" }));
    await expect(sentence).toHaveText("Every day at 06:00, 1 step runs in sample-repo. No AI.");
    await expect(health).toContainText("free");
    await expect(page.getByText("Every day at 06:00 · cron 0 6 * * *").first()).toBeVisible();

    // Search narrows the rail and an empty result says so.
    const search = page.getByRole("searchbox", { name: "Find an automation" });
    await search.fill("audit");
    await expect(groups).toHaveText(["Scheduled1"]);
    await search.fill("opus");
    await expect(groups).toHaveText(["Needs you1", "Failed1", "Scheduled1", "Paused1"]);
    await search.fill("nothing like this");
    await expect(page.getByText("No automation matches.")).toBeVisible();
    await search.press("Escape");
    await expect(groups).toHaveCount(4);

    // The row's quick pause moves it to Paused; turning it on brings it back.
    const notes = page.locator(".automation-row", { hasText: "Weekly release notes" });
    await expect(notes.getByRole("button", { name: "Pause this automation" })).toBeAttached();
    await clickAttached(notes.getByRole("button", { name: "Pause this automation" }));
    await expect(groups).toHaveText(["Needs you1", "Failed1", "Scheduled1", "Paused2"]);
    await expect(notes).toHaveAttribute("data-group", "paused");
    await clickAttached(notes.getByRole("button", { name: "Turn this automation on" }));
    await expect(notes).toHaveAttribute("data-group", "scheduled");
  } finally {
    await app?.close();
  }
});

test("a run that really fails lands on the Failed shelf and hands over to Cora", async () => {
  test.setTimeout(150_000);
  const { root, userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-automations-inbox-fail-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(root, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(automationsChord());

    const id = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: { scheduler: { create: (i: unknown) => Promise<{ id: string }> } } }).spark;
      const job = await spark.scheduler.create({
        name: "Broken build",
        trigger: { kind: "manual" },
        loop: { kind: "once", stop: {} },
        worker: { model: "claude-opus-5", effort: "medium" },
        prompt: { template: "" },
        enabled: true,
        input: { workspaceId: "ws-automations-inbox-e2e", workspaceName: "sample-repo", cwd, initialUserNote: "", chatMode: "execute" },
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "step", label: "Build", action: { type: "command", command: "echo the build broke; exit 7" } }],
          edges: [],
          entryNodeIds: ["build"],
        },
      });
      return job.id;
    }, workspaceDir);

    const row = page.locator(".automation-row", { hasText: "Broken build" });
    await expect(row).toHaveAttribute("data-group", "scheduled");
    await expect(row).toContainText("Only when you run it");
    await expect(page.getByTestId("automation-result")).toContainText("Not run yet");

    await clickAttached(page.getByRole("button", { name: "Run now", exact: true }));
    await expect(row).toHaveAttribute("data-group", "failed", { timeout: 60_000 });
    await expect(row).toContainText(/^.*Failed/);
    const result = page.getByTestId("automation-result");
    await expect(result).toHaveClass(/is-failed/);

    await clickAttached(result.getByRole("button", { name: "See what it did" }));
    await expect(result).toContainText("the build broke");
    await clickAttached(result.getByRole("button", { name: "Hide what it did" }));

    // The history has the run, in the same words.
    const failedBefore = await page.evaluate(async (jobId) => {
      const spark = (window as unknown as { spark: { scheduler: { list: () => Promise<Array<{ id: string; history: Array<{ runId: string }> }>> } } }).spark;
      return (await spark.scheduler.list()).find((j) => j.id === jobId)?.history[0]?.runId;
    }, id);
    expect(failedBefore).toBeTruthy();

    await clickAttached(result.getByRole("button", { name: "Fix with Cora" }));
    const composer = page.locator("textarea:visible").first();
    await expect(composer).toHaveValue(/My automation "Broken build" failed \(run .+\)\. Find out why and fix it\./, { timeout: 10_000 });
    await shot(page, "fix-with-cora");
  } finally {
    await app?.close();
  }
});

function seedJobs(cwd: string): unknown[] {
  const now = Date.now();
  const day = 86_400_000;
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  // Inside this month whatever day the suite runs: spread over the part of the
  // month already gone, newest last.
  const inMonth = (fraction: number): number => monthStart.getTime() + (now - monthStart.getTime()) * fraction;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const worker = { model: "claude-opus-5", effort: "medium" };
  const base = (id: string, name: string, trigger: unknown, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    name,
    trigger,
    enabled: true,
    input: { workspaceId: WS_ID, workspaceName: "sample-repo", cwd, initialUserNote: "", chatMode: "execute" },
    loop: { kind: "once", stop: {} },
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
    createdAt: iso(now - 40 * day),
    scheduleCheckedAt: iso(now),
    ...extra,
  });
  const run = (at: number, minutes: number, cost: number, summary: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    iteration: 0,
    runId: `run-sample-${Math.round(at)}`,
    startedAt: iso(at),
    finishedAt: iso(at + minutes * 60_000),
    status: "complete",
    costUsd: cost,
    measuredCostUsd: 0,
    summary,
    ...extra,
  });
  return [
    base("job-sample-notes", "Weekly release notes", { kind: "cron", expr: "0 9 * * 1" }, {
      history: [run(inMonth(0.4), 5, 0.11, "Drafted notes for 18 merged pull requests.", { stopReason: "once" })],
    }),
    base("job-sample-polish", "Continuous polish", { kind: "continuous" }, {
      enabled: false,
      loop: { kind: "agent", stop: { budgetUsd: 5, maxIterations: 20 } },
      history: [run(inMonth(0.3), 8, 0.27, "Removed an unused helper.", { stopReason: "user-stop", status: "cancelled" })],
    }),
    base("job-sample-audit", "Dependency audit", { kind: "cron", expr: "0 6 * * *" }, {
      graph: {
        version: 1,
        nodes: [{ id: "audit", kind: "step", label: "npm audit", action: { type: "command", command: "npm audit --audit-level=high" } }],
        edges: [],
        entryNodeIds: ["audit"],
      },
      history: [run(inMonth(0.6), 0.1, 0, "No high or critical advisories.", { stopReason: "once", measuredCostUsd: 0 })],
    }),
    base("job-sample-flaky", "Fix flaky tests", { kind: "cron", expr: "0 2 * * 1-5" }, {
      loop: { kind: "until", stop: { untilTestsPass: true, budgetUsd: 2 } },
      history: [
        run(inMonth(0.1), 14, 0.61, "The tests pass: fixed 2 flaky tests.", { stopReason: "tests-pass" }),
        run(inMonth(0.2), 3, 0.09, "The tests pass: nothing to fix.", { stopReason: "tests-pass" }),
        run(inMonth(0.3), 21, 0.1, "A worker crashed.", { status: "failed", stopReason: "iteration-failed" }),
        run(inMonth(0.5), 9, 0.1, "The tests pass: fixed 1 flaky test.", { stopReason: "tests-pass" }),
        run(inMonth(0.9), 38, 2, "Fixed checkout.spec.ts. login.spec.ts still times out on the second retry, and the budget ran out before finding the cause.", { stopReason: "budget" }),
      ],
      skips: [{ id: "skip-sample-1", at: iso(inMonth(0.7)), reason: "missed", detail: "1 scheduled run was missed while the computer was asleep and skipped." }],
    }),
    base("job-sample-review", "Review new pull requests", { kind: "interval", everyMs: 900_000 }, {
      state: { status: "blocked", iteration: 1 },
      history: [run(inMonth(0.8), 6, 0.14, "No problems found in the last pull request.", { stopReason: "once" })],
    }),
  ];
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
  const workspaceDir = join(root, "sample-repo");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# E2E workspace\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [{ id: WS_ID, name: "sample-repo", cwd: workspaceDir, color: "#F0C419", workers: [] }],
        activeWorkspaceId: WS_ID,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, workspaceDir };
}
