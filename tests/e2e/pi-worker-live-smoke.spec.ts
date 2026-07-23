import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

test("a real Cora Codex worker executes through Pi and completes the normal attempt lifecycle", async () => {
  test.setTimeout(240_000);
  test.skip(
    process.env.CODARA_E2E_PI_WORKER_LIVE !== "1",
    "Set CODARA_E2E_PI_WORKER_LIVE=1 to use the isolated Codex OAuth subscription.",
  );

  const root = await mkdtemp(join(tmpdir(), "codara-live-pi-worker-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const piConfigDir = join(userDataDir, "pi-agent");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(piConfigDir, { recursive: true, mode: 0o700 }),
  ]);
  // Copy, never print, the isolated subscription record into this disposable
  // Codara home. The Pi launch policy still strips every API-key environment
  // variable and validates that the selected provider record is OAuth.
  await copyFile(join(homedir(), ".Codara", "pi-agent", "auth.json"), join(piConfigDir, "auth.json"));
  await chmod(join(piConfigDir, "auth.json"), 0o600);
  await writeFile(join(workspaceDir, "README.md"), "# Pi worker live fixture\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{
        id: "ws-live-pi-worker",
        name: "pi-worker-fixture",
        cwd: workspaceDir,
        color: "#42D6C7",
        workers: [],
      }],
      activeWorkspaceId: "ws-live-pi-worker",
    }, null, 2),
    "utf8",
  );

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
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForLoadState("domcontentloaded");

    const launched = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      let run = await spark.orchestration.createRun({
        workspaceId: "ws-live-pi-worker",
        workspaceName: "pi-worker-fixture",
        cwd,
        title: "Pi worker lifecycle",
        chatBackend: "pi",
        chatMode: "execute",
        chatModel: "gpt-5.6-sol",
        chatEffort: "high",
      });
      run = await spark.orchestration.createStep({
        runId: run.id,
        title: "Prove Pi worker execution",
        goal: "Create and verify one deterministic fixture artifact.",
        acceptanceCriteria: ["pi-worker-e2e.txt contains exactly CORA_PI_APP_WORKER_OK followed by a newline."],
      });
      run = await spark.orchestration.createWorkerTask({
        runId: run.id,
        stepId: run.steps[0].id,
        title: "Create deterministic Pi artifact",
        description: [
          "Create pi-worker-e2e.txt in the workspace.",
          "Its complete contents must be exactly CORA_PI_APP_WORKER_OK followed by one newline.",
          "Read the file back and verify its exact bytes before reporting completion.",
        ].join(" "),
        runtimePreference: "codex",
        modelHint: "gpt-5.6-sol",
        effortHint: "high",
        allowedPaths: ["pi-worker-e2e.txt"],
        expectedOutputs: ["pi-worker-e2e.txt", "final-report.json"],
        verificationCommands: [
          "node -e \"const fs=require('fs');if(fs.readFileSync('pi-worker-e2e.txt','utf8')!=='CORA_PI_APP_WORKER_OK\\n')process.exit(1)\"",
        ],
      });
      const task = run.workerTasks[0];
      const envelope = await spark.orchestration.prepareWorkerTask({
        runId: run.id,
        workerTaskId: task.id,
        cwd,
      });
      const finished = await spark.orchestration.launchWorkerAttempt({
        runId: run.id,
        attemptId: envelope.attemptId,
      });
      return { runId: run.id, attemptId: envelope.attemptId, finished };
    }, workspaceDir);

    expect(await readFile(join(workspaceDir, "pi-worker-e2e.txt"), "utf8")).toBe("CORA_PI_APP_WORKER_OK\n");
    const attempt = launched.finished.workerAttempts.find((item: any) => item.id === launched.attemptId);
    expect(attempt?.status).toBe("succeeded");
    expect(attempt?.command).toContain("Pi harness (codex/gpt-5.6-sol, high)");
    const report = JSON.parse(await readFile(attempt.finalReportPath, "utf8"));
    expect(report.status).toBe("complete");

    const events = await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.listEvents(runId);
    }, launched.runId) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const running = events.find((event) => event.type === "worker_attempt.running");
    expect(running?.payload?.harness).toBe("pi");
    expect(running?.payload?.provider).toBe("openai-codex");
    expect(running?.payload?.model).toBe("gpt-5.6-sol");

    await page.getByRole("tab", { name: "Cora" }).click();
    await page.getByRole("tab", { name: "Runs" }).click();
    await expect(page.getByRole("tab", { name: "Workers" })).toHaveCount(0);
    const workerCard = page.locator(`[data-worker-task-id="${launched.finished.workerTasks[0].id}"]`);
    await expect(workerCard).toContainText("Create deterministic Pi artifact");
    await expect(workerCard).toContainText("Codex · Pi");
    // This direct fixture is reviewed synchronously after the report; require
    // the renderer to reconcile all the way from working to accepted.
    await expect(workerCard).toHaveAttribute("data-worker-state", "accepted", { timeout: 15_000 });
    if (process.env.CODARA_PI_WORKER_SCREENSHOT) {
      await page.screenshot({ path: process.env.CODARA_PI_WORKER_SCREENSHOT });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
