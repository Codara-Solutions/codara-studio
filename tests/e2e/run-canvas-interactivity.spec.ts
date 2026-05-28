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
        SPARK_USER_DATA_DIR: userDataDir,
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 780 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Spark App")).toBeVisible({ timeout: 20_000 });

    await seedWorkbenchRun(page, workspaceDir);
    await page.getByRole("button", { name: /New chat|Chat -/ }).click();
    await page.getByRole("button", { name: "Canvas repro" }).click();
    await page.getByRole("tab", { name: /Runs/ }).click();
    await expect(page.getByText("Drag node surface")).toBeVisible();

    const beforeDrag = await graphTransform(page);
    const stepBox = await page.getByText("Drag node surface").boundingBox();
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
  await expect(page.getByRole("button", { name: /New chat|Chat -/ })).toBeVisible();
  await expect(page.getByText("Canvas repro")).toBeVisible({ timeout: 10_000 });
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
