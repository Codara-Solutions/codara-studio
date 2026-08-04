import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Runs node graph, exercised against a persisted run that was mid-flight
// when the app "closed": a completed step (auto-collapses to its compact
// node, user can unfold it) and a step whose worker died with the app.
// Seeding goes through the app's own createRun/createStep/createWorkerTask
// IPC so the run.json base is always what the current build writes; the
// mid-flight fields (statuses, attempts) are edited into that file between
// launches.
//
// Deliberately NOT asserted here: a live runtimeActivity readout. A running
// attempt cannot exist in a freshly booted app — recoverOrphanedManagedWorker-
// Attempts settles the corpse and pauseManagedRunsAfterRestart claims the
// run, both by design — so this spec asserts the same ConsoleLine pipeline
// through its crash branch (the recovery text on the card), and the live
// branch belongs to the gated pi-worker-live-smoke where a real worker runs.

test("finished steps fold, crashed workers explain, dead terminals say so", async () => {
  test.setTimeout(120_000);
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-agent-runs-readout-e2e-");

  // ── Launch 1: seed the run through the app's own IPC, then let it settle.
  let runId = "";
  {
    const app = await launchApp(userDataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText("Cora", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      runId = await seedRun(page, workspaceDir);
      // The run store persists on a queue; give the final save a beat.
      await page.waitForTimeout(1_200);
    } finally {
      await app.close();
    }
  }

  // ── Between launches: rewrite the persisted run into mid-flight shape.
  const runPath = join(userDataDir, "runs", runId, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  expect(run.steps.length).toBe(2);
  const [doneStep, liveStep] = run.steps;
  const doneTask = run.workerTasks.find((t: { stepId: string }) => t.stepId === doneStep.id);
  const liveTask = run.workerTasks.find((t: { stepId: string }) => t.stepId === liveStep.id);
  expect(doneTask).toBeTruthy();
  expect(liveTask).toBeTruthy();

  const now = Date.now();
  doneStep.status = "complete";
  liveStep.status = "running";
  run.status = "running";
  run.currentStepId = liveStep.id;
  doneTask.status = "accepted";
  liveTask.status = "running";
  run.workerAttempts = [
    {
      id: "attempt-done-1",
      runId,
      workerTaskId: doneTask.id,
      attemptNumber: 1,
      runtime: "codex",
      model: "gpt-5.6-sol",
      command: "Pi harness (codex/gpt-5.6-sol)",
      cwd: workspaceDir,
      status: "succeeded",
      startedAt: new Date(now - 300_000).toISOString(),
      finishedAt: new Date(now - 120_000).toISOString(),
      costUsd: 0.07,
    },
    {
      // Left "running" on disk on purpose: boot recovery must settle this
      // corpse as crashed, and the card must SAY so on its console line.
      id: "attempt-live-1",
      runId,
      workerTaskId: liveTask.id,
      attemptNumber: 1,
      runtime: "codex",
      model: "gpt-5.6-sol",
      command: "Pi harness (codex/gpt-5.6-sol)",
      cwd: workspaceDir,
      status: "running",
      startedAt: new Date(now - 60_000).toISOString(),
      runtimeState: "working",
      runtimeStateUpdatedAt: new Date(now - 5_000).toISOString(),
      runtimeStateSource: "hook",
    },
  ];
  await writeFile(runPath, JSON.stringify(run), "utf8");

  // ── Launch 2: the app boots onto the mid-flight run; assert the graph.
  const app = await launchApp(userDataDir);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: "Cora" }).click({ timeout: 20_000 });
    await page.getByRole("tab", { name: /Runs/ }).click();
    // Fold the inspector so the graph gets the full viewport (selecting a
    // worker card later re-reveals it), then frame the whole graph.
    await page.getByRole("button", { name: "Collapse inspector" }).click();
    await page.getByRole("button", { name: "Fit graph to view" }).click();

    // The completed step auto-collapsed: its compact node offers the unfold
    // chevron, summarizes its work, and its worker card is not mounted.
    const expandToggle = page.getByRole("button", { name: "Expand step" });
    await expect(expandToggle).toBeVisible({ timeout: 15_000 });
    const doneWorkerCard = page.locator(`[data-worker-task-id="${doneTask.id}"]`);
    await expect(doneWorkerCard).toHaveCount(0);

    // The worker that died with the app: boot recovery settled the corpse and
    // the card's console line explains it — same ConsoleLine pipeline that
    // carries the live activity readout, exercised through its danger branch.
    const crashedWorkerCard = page.locator(`[data-worker-task-id="${liveTask.id}"]`);
    await expect(crashedWorkerCard).toBeVisible();
    await expect(crashedWorkerCard).toContainText("the app closed while this worker was running");
    await expect(crashedWorkerCard).toHaveAttribute("data-worker-state", "failed");

    await shoot(page, "runs-graph-folded.png");

    // Unfold the finished step: its full card and worker fan come back, and
    // the worker's footer carries the measured spend.
    await expandToggle.click();
    await expect(doneWorkerCard).toBeVisible();
    await expect(doneWorkerCard).toContainText("$0.07");
    await shoot(page, "runs-graph-expanded.png");

    // Fold it again from the expanded card's own toggle — scoped to the
    // finished step's article, because the crashed step (terminal too)
    // rightly offers its own collapse toggle.
    await page
      .getByRole("article", { name: /Collect current Spain news/ })
      .getByRole("button", { name: "Collapse step" })
      .click();
    await expect(doneWorkerCard).toHaveCount(0);

    // A worker whose terminal genuinely does not exist (nothing spawned in
    // this seeded app) must explain the miss instead of being a dead button.
    await crashedWorkerCard.click();
    const openTerminal = page.getByRole("button", { name: "Open worker terminal" });
    await expect(openTerminal).toBeVisible();
    await openTerminal.click();
    await expect(openTerminal).toContainText("No terminal open");
    await shoot(page, "runs-inspector-terminal-miss.png");
  } finally {
    await app.close();
  }
});

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [".", "--ozone-platform=x11"],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
    },
  });
}

// Optional visual-review captures, written only when the runner names a dir.
async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.CODARA_RUNS_READOUT_SHOTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name) });
}

async function prepareElectronWorkspace(
  prefix: string,
): Promise<{ userDataDir: string; workspaceDir: string }> {
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
        workspaces: [
          {
            id: "ws-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#42D66C",
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

async function seedRun(page: Page, cwd: string): Promise<string> {
  const runId: string = await page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Research Spain news",
    });
    const one = await spark.orchestration.createStep({
      runId: run.id,
      title: "Research Spain news",
      goal: "Collect current Spain news items with sources.",
      plannedAgents: [
        { label: "Researcher", summary: "Search and collect items.", runtimePreference: "codex" },
      ],
      acceptanceCriteria: ["notes/spain-news.md exists"],
      verificationCommands: [],
    });
    await spark.orchestration.createWorkerTask({
      runId: run.id,
      stepId: one.steps[0].id,
      title: "Collect Spain news",
      description: "Search the news and write notes/spain-news.md.",
      runtimePreference: "codex",
      canRunParallel: true,
    });
    const two = await spark.orchestration.createStep({
      runId: run.id,
      title: "Verify Spain news",
      goal: "Independently verify each collected item.",
      plannedAgents: [
        { label: "Verifier", summary: "Check every cited source.", runtimePreference: "codex" },
      ],
      acceptanceCriteria: ["every item verified"],
      verificationCommands: [],
    });
    await spark.orchestration.createWorkerTask({
      runId: run.id,
      stepId: two.steps[1].id,
      title: "Verify Spain news",
      description: "Open each cited source and verify the claims.",
      runtimePreference: "codex",
      canRunParallel: true,
    });
    return run.id;
  }, cwd);
  await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
  return runId;
}
