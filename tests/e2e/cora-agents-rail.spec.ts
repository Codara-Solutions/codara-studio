import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The chat's agents rail (option 2, DESIGN.md): a 32 px strip on the chat's
// left edge with Cora on top and one mark per worker. Workers are the
// scripted stand-in for a Pi session (CODARA_FAKE_PI_WORKERS=1): one
// finishes, one fails, the rest keep running their test until stopped.
// SPARK_AGENTS_RAIL_SHOTS=<dir> also saves screenshots of each state.

test("the agents rail lists a chat's workers, goes inside one and folds", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-agents-rail-"));
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
  const shots = process.env.SPARK_AGENTS_RAIL_SHOTS || testInfo.outputPath("shots");
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

    const seeded = await seedRun(page, workspaceDir);
    const coraTab = page.getByRole("tab", { name: "Cora" }).last();
    await expect(coraTab).toBeAttached();
    await coraTab.dispatchEvent("click");
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    await page.getByRole("option").filter({ hasText: "Fix merged fold count" }).dispatchEvent("click");
    await expect(page.getByTitle(`Copy run id: ${seeded.runId}`)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => attemptStatuses(page, seeded.runId), { timeout: 30_000 })
      .toEqual({ done: 1, failed: 1, running: 2 });

    // The strip: Cora, then one mark per worker whose shape says its state.
    const strip = page.getByRole("toolbar", { name: /^Agents: / });
    await expect(strip).toHaveAttribute("aria-label", "Agents: 2 running · 1 failed · 1 done");
    await expect(page.getByRole("navigation", { name: "Agents" })).toBeVisible();
    const box = await strip.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(32);
    const toast = strip.getByRole("button", { name: /^Watch the toast count: / });
    await expect(toast).toHaveAttribute("data-state", "running");
    await expect(strip.getByRole("button", { name: /^Read how the fold counts: / })).toHaveAttribute("data-state", "done");
    await expect(strip.getByRole("button", { name: /^Check the light theme: / })).toHaveAttribute("data-state", "failed");
    // The count lives on the rail now, not under the composer.
    await expect(page.locator(".composer-toolbar__hint--worker")).toHaveCount(0);

    // Hover: name, model, state, time and the step it is on.
    await toast.hover();
    const tip = page.locator(".cora-agents-tip");
    await expect(tip).toContainText("Watch the toast count");
    await expect(tip).toContainText("running");
    await expect(tip).toContainText("Run command · npm test");
    await shot(page, join(shots, "rail-1-wide-hover.png"));

    // The chevron opens the list over the chat, grouped by step.
    await page.mouse.move(700, 500);
    await strip.getByRole("button", { name: "Open the agents list" }).click();
    const list = page.getByRole("group", { name: "Agents list" });
    await expect(list).toBeVisible();
    await expect(list).toContainText("Step 1 · Fix merged fold");
    await expect(list.locator('[data-rail-row][data-state="failed"]')).toContainText("typecheck, 2 errors");
    await expect(list.locator('[data-rail-row][data-state="running"]').first()).toContainText("Run command · npm test");
    await expect(list.locator('[data-rail-row="main"]')).toBeFocused();
    await shot(page, join(shots, "rail-2-list.png"));
    // Esc folds it and hands focus back to where it was opened from.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(strip.getByRole("button", { name: "Open the agents list" })).toBeFocused();

    // Keyboard: one tab stop, down to a worker, Enter goes inside.
    await expect(strip.locator('[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press("Home");
    await expect(strip.locator('[data-rail-key="main"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(toast).toBeFocused();
    await page.keyboard.press("Enter");
    const bar = page.getByRole("navigation", { name: "Worker" });
    await expect(bar).toContainText("Watch the toast count");
    // Inside, the strip stays and marks the worker you are in, beside the view.
    await expect(toast).toHaveAttribute("aria-current", "true");
    const viewLeft = await page.locator("[data-worker-view]").evaluate((node) => node.getBoundingClientRect().left);
    expect(viewLeft).toBeGreaterThanOrEqual(((await strip.boundingBox())?.x ?? 0) + 32);
    await expect(strip.locator('[data-rail-key="main"]')).not.toHaveAttribute("aria-current", "true");
    await strip.getByRole("button", { name: /^Check the empty list: / }).hover();
    await expect(tip).toContainText("Check the empty list");
    await shot(page, join(shots, "rail-3-inside-worker.png"));
    // Right arrow opens the list from the strip; Esc folds it, and only that:
    // the worker stays open.
    await toast.focus();
    await page.keyboard.press("ArrowRight");
    await expect(list).toBeVisible();
    await expect(list.locator('[data-rail-row][aria-current="true"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(bar).toBeVisible();
    // A row in the list goes inside another worker; Cora's mark comes back to Main.
    await strip.getByRole("button", { name: "Open the agents list" }).click();
    await list.locator('[data-rail-row]').filter({ hasText: "Check the empty list" }).click();
    await expect(bar).toContainText("Check the empty list");
    // Cora's mark by keyboard: back to Main, and focus stays on the rail.
    await strip.locator('[data-rail-key="main"]').focus();
    await page.keyboard.press("Enter");
    await expect(bar).toHaveCount(0);
    await expect(strip.locator('[data-rail-key="main"]')).toHaveAttribute("aria-current", "true");
    await page.waitForTimeout(100);
    await expect(strip.locator('[data-rail-key="main"]')).toBeFocused();

    // A narrow pane: the strip keeps its 32 px and the list floats over the chat.
    await page.getByTestId("cora-panel").evaluate((panel) => {
      (panel as HTMLElement).style.width = "420px";
    });
    await strip.getByRole("button", { name: /^Check the light theme: / }).hover();
    await expect(tip).toContainText("typecheck, 2 errors");
    await shot(page, join(shots, "rail-4-narrow-420.png"));
    await page.mouse.move(700, 500);
    await strip.getByRole("button", { name: "Open the agents list" }).click();
    const conversationWidth = await page.getByTestId("cora-conversation").evaluate((node) => node.getBoundingClientRect().width);
    expect(Math.round((await strip.boundingBox())?.width ?? 0)).toBe(32);
    expect(conversationWidth).toBeGreaterThan(360);
    await shot(page, join(shots, "rail-4b-narrow-420-list.png"));
    await page.keyboard.press("Escape");
    await page.getByTestId("cora-panel").evaluate((panel) => {
      (panel as HTMLElement).style.width = "";
    });

    // Eight and more: running ones first, then "+N", which opens the list.
    await launchMore(page, seeded.runId, seeded.stepId, workspaceDir, 7);
    await expect
      .poll(() => attemptStatuses(page, seeded.runId), { timeout: 30_000 })
      .toEqual({ done: 1, failed: 1, running: 9 });
    await expect(strip.getByRole("button", { name: /^\d+ more workers, open the list$/ })).toHaveText("+3", { timeout: 20_000 });
    const marks = strip.locator("[data-rail-key][data-state]");
    await expect(marks).toHaveCount(8);
    const states = await marks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-state")));
    expect(states.slice(0, 8).every((state) => state === "running")).toBe(true);
    await page.mouse.move(700, 500);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, join(shots, "rail-5-many.png"));
    await strip.getByRole("button", { name: "3 more workers, open the list" }).click();
    await expect(list).toBeVisible();
    await expect(list.locator("[data-rail-row]")).toHaveCount(12);
    await page.keyboard.press("Escape");
  } finally {
    await app?.close().catch(() => undefined);
    if (!process.env.SPARK_AGENTS_RAIL_SHOTS) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function shot(page: Page, path: string): Promise<void> {
  await page.getByTestId("cora-panel").screenshot({ path });
}

async function attemptStatuses(page: Page, runId: string): Promise<Record<string, number>> {
  return page.evaluate(async (id) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.getRun(id);
    const counts: Record<string, number> = {};
    for (const attempt of run.workerAttempts) {
      const key = attempt.status === "succeeded" ? "done" : attempt.status;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, runId);
}

async function launchMore(page: Page, runId: string, stepId: string, cwd: string, count: number): Promise<void> {
  await page.evaluate(
    async ({ id, step, workspaceCwd, n }) => {
      const spark = (window as unknown as { spark: any }).spark;
      for (let index = 1; index <= n; index += 1) {
        const title = `Check case ${index}`;
        const withTask = await spark.orchestration.createWorkerTask({
          runId: id,
          stepId: step,
          title,
          description: `Check case ${index}. FAKE_DELAY_MS=600000`,
          runtimePreference: "claude",
        });
        const task = withTask.workerTasks.find((candidate: any) => candidate.title === title);
        const envelope = await spark.orchestration.prepareWorkerTask({ runId: id, workerTaskId: task.id, cwd: workspaceCwd });
        void spark.orchestration.launchWorkerAttempt({ runId: id, attemptId: envelope.attemptId }).catch(() => undefined);
      }
    },
    { id: runId, step: stepId, workspaceCwd: cwd, n: count },
  );
}

async function seedRun(page: Page, cwd: string): Promise<{ runId: string; stepId: string }> {
  return page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Fix merged fold count",
    });
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
      message: "I split it into four workers: one reads how the count is built, the others check the toast, the empty list and the light theme.",
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
      void spark.orchestration.launchWorkerAttempt({ runId: run.id, attemptId: envelope.attemptId }).catch(() => undefined);
    };
    await launch("Read how the fold counts", "Read how the merged fold is counted. FAKE_DELAY_MS=200");
    await launch("Watch the toast count", "Check the toast count while the fix lands. FAKE_DELAY_MS=600000");
    await launch("Check the empty list", "Check the empty list case. FAKE_DELAY_MS=600000");
    await launch("Check the light theme", "Check the light theme. FAKE_FAIL FAKE_DELAY_MS=400");
    return { runId: run.id as string, stepId: stepId as string };
  }, cwd);
}
