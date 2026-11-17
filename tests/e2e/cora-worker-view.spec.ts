import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Going inside a Cora worker (option A, DESIGN.md): a worker row in a step
// card opens the worker's own chat in place of Main's. Workers here are the
// scripted stand-in for a Pi session (CODARA_FAKE_PI_WORKERS=1), so the spec
// needs no subscription: one keeps running until stopped, one finishes.
// SPARK_WORKER_VIEW_SHOTS=<dir> also saves screenshots of each state.

test("Cora goes inside a running and a finished worker and comes back to Main where it was", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-worker-view-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Project\n\nA compact fixture.\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-e2e", name: "workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
      activeWorkspaceId: "ws-e2e",
    }),
    "utf8",
  );
  const shots = process.env.SPARK_WORKER_VIEW_SHOTS || testInfo.outputPath("shots");
  await mkdir(shots, { recursive: true });

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        CODARA_FAKE_PI_WORKERS: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.waitForLoadState("domcontentloaded");

    const seeded = await seedRunWithWorkers(page, workspaceDir);

    const coraTab = page.getByRole("tab", { name: "Cora" }).last();
    await expect(coraTab).toBeAttached();
    await coraTab.dispatchEvent("click");
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    await page.getByRole("option").filter({ hasText: "Fix merged fold count" }).dispatchEvent("click");
    await expect(page.getByTitle(`Copy run id: ${seeded.runId}`)).toBeVisible({ timeout: 15_000 });

    // The finished worker settles first; the running one keeps going.
    await expect
      .poll(() => attemptStatuses(page, seeded.runId), { timeout: 30_000 })
      .toEqual({
        [seeded.finishedAttempt]: "succeeded",
        [seeded.runningAttempt]: "running",
        [seeded.otherAttempt]: "running",
      });

    const runningRow = page.getByRole("button", { name: /^Open Watch the toast count/ });
    const finishedRow = page.getByRole("button", { name: /^Open Read how the fold counts/ });
    await expect(runningRow).toBeVisible({ timeout: 15_000 });
    await expect(finishedRow).toBeVisible();
    await expect(page.getByText("Open terminal")).toHaveCount(0);

    await runningRow.hover();
    await shot(page, join(shots, "1-main-row-hover.png"));

    // Main sits above its bottom, past the distance that still counts as the
    // bottom (where Main keeps following new output), so "where it was" is a
    // real position and not just the end. The row is then opened from the
    // keyboard: a pointer action could scroll Main on its own.
    const scroller = page.locator('[data-testid="cora-conversation"] [data-virtuoso-scroller]');
    await scroller.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 110);
    });
    await page.waitForTimeout(300);
    const before = await scroller.evaluate((el) => el.scrollTop);
    const bottom = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(before).toBeGreaterThan(0);
    expect(bottom - before).toBeGreaterThan(72);

    // Inside the running worker.
    await runningRow.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
    const bar = page.getByRole("navigation", { name: "Worker" });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Watch the toast count");
    await expect(bar).toContainText("running");
    await expect(bar).toContainText("2 of 3");
    const view = page.locator("[data-worker-view]");
    await expect(view.locator("[data-worker-brief]")).toContainText("Brief from Cora");
    await expect(view.locator("[data-worker-brief]")).toContainText("Watch the toast count");
    // Its steps, drawn with the main chat's rows.
    await expect(view.getByText("Checking that the tests pass before changing anything.")).toBeVisible({ timeout: 15_000 });
    await expect(view.locator('[data-execution-kind="tool"]')).toHaveCount(2);
    await expect(page.getByTestId("cora-conversation")).toBeHidden();

    // A message to the worker lands in its chat, and it answers.
    const composer = page.getByRole("textbox", { name: "Message Watch the toast count" });
    await expect(composer).toHaveAttribute("placeholder", "Message Watch the toast count. It reads it before its next step.");
    await expect(view.getByText("Steers this worker only")).toBeVisible();
    await composer.fill("Also cover the empty list.");
    await composer.press("Enter");
    await expect(view.locator('[data-worker-message="user"]')).toContainText("Also cover the empty list.");
    await expect(view.getByText("Noted: Also cover the empty list.")).toBeVisible();
    await expect(composer).toHaveValue("");

    // The menu: its Escape closes the menu, not the view.
    await page.getByRole("button", { name: "More worker actions" }).click();
    const menu = page.getByRole("menu", { name: "Worker actions" });
    await expect(menu.getByRole("menuitem", { name: /Copy brief/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Show in Runs/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Raw terminal output/ })).toContainText("for output the chat can't draw");
    await shot(page, join(shots, "2-running-worker-menu.png"));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(bar).toBeVisible();
    await shot(page, join(shots, "3-running-worker.png"));

    // The arrow steps to the other worker: finished, folded, with its report.
    await page.getByRole("button", { name: /^Previous worker: Read how the fold counts/ }).click();
    await expect(bar).toContainText("Read how the fold counts");
    await expect(bar).toContainText("done");
    await expect(bar).toContainText("1 of 3");
    // The arrow that went disabled handed focus to the other one.
    await expect(page.getByRole("button", { name: /^Next worker: Watch the toast count/ })).toBeFocused();
    await expect(view.getByRole("button", { name: /Worked for/ })).toBeVisible();
    await expect(view.getByText("Done: Read how the fold counts. One file changed and the tests pass.")).toBeVisible();
    const report = view.getByRole("region", { name: "Final report" });
    await expect(report).toContainText("src/example.ts", { timeout: 15_000 });
    await expect(report).toContainText("npm test");
    await expect(page.getByRole("textbox", { name: /^Message Read how/ })).toHaveCount(0);
    await expect(view.getByRole("button", { name: "Ask Cora for a follow-up" })).toBeVisible();
    await shot(page, join(shots, "4-finished-worker.png"));


    // Esc returns to Main, at the scroll position it was left at, with focus
    // back on a worker row.
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId("cora-conversation")).toBeVisible();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(before);
    // Focus is back on the row of the worker you left from (the finished one).
    const finishedRowId = await finishedRow.getAttribute("data-worker-row");
    expect(finishedRowId).toBeTruthy();
    await expect(page.locator(`[data-worker-row="${finishedRowId}"]`)).toBeFocused();

    // Inside the finished worker, another worker ending pings the bar.
    await finishedRow.click();
    await expect(bar).toContainText("Read how the fold counts");
    await page.evaluate(
      ({ runId, attemptId }) =>
        (window as unknown as { spark: any }).spark.orchestration.stopWorkerAttempt(runId, attemptId),
      { runId: seeded.runId, attemptId: seeded.otherAttempt },
    );
    await expect(bar.getByRole("status")).toHaveText("Check the empty list stopped", { timeout: 15_000 });
    await shot(page, join(shots, "5-ping.png"));

    // The running worker: Stop ends it.
    await page.getByRole("button", { name: /^Next worker: Watch the toast count/ }).click();
    await expect(bar).toContainText("Watch the toast count");
    await page.getByRole("button", { name: "Stop worker" }).click();
    await expect
      .poll(async () => (await attemptStatuses(page, seeded.runId))[seeded.runningAttempt], { timeout: 20_000 })
      .toBe("cancelled");
    await expect(bar).toContainText("stopped");
    await page.getByRole("button", { name: "Back to Main" }).click();
    await expect(bar).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    if (!process.env.SPARK_WORKER_VIEW_SHOTS) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// The Cora panel only: the rest of the window is not what this proves.
async function shot(page: Page, path: string): Promise<void> {
  await page.getByTestId("cora-panel").screenshot({ path });
}

async function attemptStatuses(page: Page, runId: string): Promise<Record<string, string>> {
  return page.evaluate(async (id) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.getRun(id);
    return Object.fromEntries(run.workerAttempts.map((attempt: any) => [attempt.id, attempt.status]));
  }, runId);
}

async function seedRunWithWorkers(
  page: Page,
  cwd: string,
): Promise<{ runId: string; finishedAttempt: string; runningAttempt: string; otherAttempt: string }> {
  return page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Fix merged fold count",
    });
    for (let index = 1; index <= 6; index += 1) {
      await spark.orchestration.addRunMessage({ runId: run.id, author: "user", kind: "note", message: `Earlier question ${index}` });
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: "spark",
        kind: "note",
        message: `Earlier answer ${index}. It covers one part of the project in a few sentences so the chat is long enough to scroll.`,
      });
    }
    await spark.orchestration.addRunMessage({
      runId: run.id,
      author: "user",
      kind: "note",
      message: "The rail still counts merged worktrees after a clean up. Find why and fix it.",
    });
    await spark.orchestration.addRunMessage({
      runId: run.id,
      author: "spark",
      kind: "note",
      message: "I split it into two workers: one reads how the count is built, one watches the toast count.",
    });
    const withStep = await spark.orchestration.createStep({
      runId: run.id,
      title: "Fix merged fold",
      goal: "Stop counting the worktree Codara runs from.",
    });
    const stepId = withStep.steps[0].id;
    const launch = async (title: string, description: string) => {
      const withTask = await spark.orchestration.createWorkerTask({
        runId: run.id,
        stepId,
        title,
        description,
        runtimePreference: "claude",
      });
      const task = withTask.workerTasks.find((candidate: any) => candidate.title === title);
      const envelope = await spark.orchestration.prepareWorkerTask({ runId: run.id, workerTaskId: task.id, cwd: workspaceCwd });
      // Settles only when the session ends; main keeps driving it.
      void spark.orchestration.launchWorkerAttempt({ runId: run.id, attemptId: envelope.attemptId }).catch(() => undefined);
      return envelope.attemptId as string;
    };
    const finishedAttempt = await launch("Read how the fold counts", "Read how the merged fold is counted. FAKE_DELAY_MS=200");
    const runningAttempt = await launch("Watch the toast count", "Check the toast count while the fix lands. FAKE_DELAY_MS=600000");
    const otherAttempt = await launch("Check the empty list", "Check the empty list case. FAKE_DELAY_MS=600000");
    return { runId: run.id as string, finishedAttempt, runningAttempt, otherAttempt };
  }, cwd);
}
