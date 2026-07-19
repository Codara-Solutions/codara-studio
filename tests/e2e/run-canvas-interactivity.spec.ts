import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("run graph can be dragged and zoomed from the node surface", async () => {
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-agent-run-canvas-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 780 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Cora", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    await seedWorkbenchRun(page, workspaceDir);
    // Run-backed chat tabs all render with the fixed CHAT_TAB_LABEL ("Cora").
    // Selecting the run's chat tab sets it active; because the seeded run has a
    // step + worker task (runHasWorkbench), App auto-opens its "Runs" node-graph
    // tab, which we then bring forward.
    await page.getByRole("tab", { name: "Cora" }).click();
    await page.getByRole("tab", { name: /Runs/ }).click();
    // The inspector overlay covers the right half of the canvas and would eat
    // pointer events aimed at nodes underneath it; fold it away, then fit the
    // graph so the step node is guaranteed inside the visible viewport.
    await page.getByRole("button", { name: "Collapse inspector" }).click();
    await page.getByRole("button", { name: "Fit graph to view" }).click();
    // Scope to the pan viewport (the only element with the grab cursor) — the
    // header strip above the canvas also renders the step title text.
    const canvas = page.locator('div[style*="cursor: grab"]');
    const nodeCard = canvas.getByText("Drag node surface", { exact: true });
    await expect(nodeCard).toBeVisible();

    const beforeDrag = await graphTransform(page);
    const stepBox = await nodeCard.boundingBox();
    expect(stepBox).toBeTruthy();
    await page.mouse.move(stepBox!.x + stepBox!.width / 2, stepBox!.y + stepBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(stepBox!.x + stepBox!.width / 2 + 90, stepBox!.y + stepBox!.height / 2 + 40, {
      steps: 6,
    });
    await page.mouse.up();
    await expect.poll(() => graphTransform(page)).not.toBe(beforeDrag);

    const beforeZoom = await zoomLabel(page);
    await page.mouse.wheel(0, -420);
    await expect.poll(() => zoomLabel(page)).not.toBe(beforeZoom);
  } finally {
    await app?.close();
  }
});

async function prepareElectronWorkspace(prefix: string): Promise<{ userDataDir: string; workspaceDir: string }> {
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

async function seedWorkbenchRun(page: Page, cwd: string): Promise<void> {
  await page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Canvas repro",
    });
    const withStep = await spark.orchestration.createStep({
      runId: run.id,
      title: "Drag node surface",
      goal: "The node card should still start a canvas drag.",
      plannedAgents: [
        {
          label: "Claude",
          summary: "Verify node pointer routing.",
          runtimePreference: "claude",
        },
      ],
      acceptanceCriteria: ["Dragging from a node pans the graph."],
      verificationCommands: ["npm run typecheck"],
    });
    const step = withStep.steps[0];
    await spark.orchestration.createWorkerTask({
      runId: run.id,
      stepId: step.id,
      title: "Worker card",
      description: "Worker cards should also remain clickable without blocking canvas gestures.",
      runtimePreference: "claude",
      canRunParallel: true,
    });
  }, cwd);
  // The run store sync adds a top-strip chat tab for the seeded run; wait for it
  // before interacting so the click in the test body has a target.
  await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
}

async function graphTransform(page: Page): Promise<string> {
  return page.evaluate(() => {
    const viewport = Array.from(document.querySelectorAll("div")).find(
      (el) => getComputedStyle(el).cursor === "grab" || getComputedStyle(el).cursor === "grabbing",
    ) as HTMLElement | undefined;
    const pan = viewport?.firstElementChild as HTMLElement | null | undefined;
    return pan?.style.transform ?? "";
  });
}

async function zoomLabel(page: Page): Promise<string> {
  return page
    .locator("span")
    .filter({ hasText: /^\d+%$/ })
    .first()
    .textContent()
    .then((text) => text ?? "");
}
