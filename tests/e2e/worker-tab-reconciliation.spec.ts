import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("a live worker pane returns after the renderer misses its preparation event", async () => {
  test.setTimeout(60_000);
  const { userDataDir, workspaceDir } = await prepareWorkspace();
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const seeded = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({
        workspaceId: "ws-worker-reconcile",
        workspaceName: "workspace",
        cwd,
        title: "Worker reconciliation",
      });
      const withStep = await spark.orchestration.createStep({
        runId: run.id,
        title: "Keep worker visible",
        goal: "Keep a live worker attached across renderer reload.",
      });
      const withTask = await spark.orchestration.createWorkerTask({
        runId: run.id,
        stepId: withStep.steps[0].id,
        title: "Manual worker",
        description: "A deterministic shell-only worker for renderer coverage.",
        runtimePreference: "manual",
      });
      const task = withTask.workerTasks[0];
      const envelope = await spark.orchestration.prepareWorkerTask({
        runId: run.id,
        workerTaskId: task.id,
        cwd,
      });
      return { runId: run.id, attemptId: envelope.attemptId };
    }, workspaceDir);

    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Cora" }).click();
    await expect(page.getByRole("tab", { name: "Workers" })).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        page.evaluate(
          (attemptId) =>
            (window as unknown as { spark: any }).spark.pty.exists(attemptId),
          seeded.attemptId,
        ),
      )
      .toBe(true);

    // An explicit user "Open in Preview" action owns a fresh top-level tab.
    // It must not recycle the run's background preview surface, which would
    // strand the browser under the inner strip without a normal + control.
    await page.evaluate(
      (url) => (window as unknown as { spark: any }).spark.openInNewPreview(url),
      pathToFileURL(join(workspaceDir, "preview-target.html")).href,
    );
    await expect(
      page.locator(".spark-tabbar").getByRole("tab", { name: /preview-target\.html/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New tab" })).toBeVisible();
    await page.getByRole("tab", { name: "Cora" }).click();

    // Runs is the second inner destination, before Workers.
    const innerTabOrder = await Promise.all(
      ["Chat", "Runs", "Workers"].map(async (name) => {
        const box = await page.getByRole("tab", { name, exact: true }).boundingBox();
        return box?.x ?? Number.POSITIVE_INFINITY;
      }),
    );
    expect(innerTabOrder[0]).toBeLessThan(innerTabOrder[1]);
    expect(innerTabOrder[1]).toBeLessThan(innerTabOrder[2]);

    // A single click inspects the worker without leaving the graph. Opening
    // its exact run-owned terminal is deliberately a double-click gesture.
    await page.getByRole("tab", { name: "Runs" }).click();
    const workerCard = page
      .locator('div[style*="cursor: grab"]')
      .getByRole("button", { name: /Manual worker/ });
    await workerCard.click();
    await expect(page.getByRole("tab", { name: "Runs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("Manual worker", { exact: true }).last()).toBeVisible();

    await workerCard.dblclick();
    await expect(page.getByRole("tab", { name: "Workers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Reload destroys the renderer subscription and cold hydration strips
    // run-owned worker tabs. The PTY remains main-process-owned. The durable
    // run/PTY reconciliation must recreate the subtab without launching a
    // second worker.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Cora" }).click();
    await expect(page.getByRole("tab", { name: "Workers" })).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        page.evaluate(
          (attemptId) =>
            (window as unknown as { spark: any }).spark.pty.exists(attemptId),
          seeded.attemptId,
        ),
      )
      .toBe(true);
  } finally {
    await app?.close();
  }
});

async function prepareWorkspace(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spark-worker-reconcile-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "preview-target.html"), "<!doctype html><title>Preview target</title>", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-worker-reconcile",
            name: "workspace",
            cwd: workspaceDir,
            color: "#42D6C7",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-worker-reconcile",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
