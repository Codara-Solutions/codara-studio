import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("orchestration flow prepares and executes a worker attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-agent-e2e-"));
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
            color: "#F0C419",
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
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("SPARK AGENT")).toBeVisible();
    await expect(page.getByText("workspace").first()).toBeVisible();

    await clickButton(page, "CREATE");
    await expectEvent(page, "run.created");

    await clickButton(page, "STEP");
    await expectEvent(page, "step.created");

    await clickButton(page, "TASK");
    await expectEvent(page, "worker_task.created");

    await clickButton(page, "PREP");
    await expectEvent(page, "worker_task.envelope_prepared");

    await clickButton(page, "EXEC");
    await expectEvent(page, "worker_attempt.finished", 10_000);
    await expect(page.getByText("FINAL REPORT")).toBeVisible();

    const run = await readOnlyRun(userDataDir);
    expect(run.workerAttempts).toHaveLength(1);
    expect(run.workerAttempts[0].status).toBe("succeeded");
    expect(run.workerTasks[0].status).toBe("needs_review");

    const attempt = run.workerAttempts[0];
    expect(attempt.stdoutLogPath && existsSync(attempt.stdoutLogPath)).toBeTruthy();
    expect(attempt.stderrLogPath && existsSync(attempt.stderrLogPath)).toBeTruthy();
    expect(attempt.rawLogPath && existsSync(attempt.rawLogPath)).toBeTruthy();
    expect(attempt.finalReportPath && existsSync(attempt.finalReportPath)).toBeTruthy();

    const report = JSON.parse(await readFile(attempt.finalReportPath, "utf8")) as { status: string };
    expect(report.status).toBe("partial");
  } finally {
    await app?.close();
  }
});

async function clickButton(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name });
  await expect(button).toBeEnabled();
  await button.click();
}

async function expectEvent(page: Page, type: string, timeout = 5_000): Promise<void> {
  await expect(page.locator("button").filter({ hasText: type }).first()).toBeVisible({ timeout });
}

async function readOnlyRun(userDataDir: string): Promise<{
  workerTasks: Array<{ status: string }>;
  workerAttempts: Array<{
    status: string;
    stdoutLogPath?: string;
    stderrLogPath?: string;
    rawLogPath?: string;
    finalReportPath?: string;
  }>;
}> {
  const runsDir = join(userDataDir, "runs");
  const entries = await readdir(runsDir);
  expect(entries).toHaveLength(1);
  const raw = await readFile(join(runsDir, entries[0], "run.json"), "utf8");
  return JSON.parse(raw);
}
