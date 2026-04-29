import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("autopilot runs from a selected markdown plan", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_MANUAL_WORKER_DELAY_MS: "5000",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("SPARK AGENT")).toBeVisible();
    await expect(page.getByText("workspace").first()).toBeVisible();

    await expect(page.locator("select")).toHaveValue(/PLAN\.md$/);
    await clickButton(page, "RUN");
    await expectEvent(page, "worker_attempt.running", 10_000);

    await page.getByPlaceholder("Plan, instruction, correction, or answer...").fill("Pause before real workers.");
    await clickButton(page, "STOP");
    await expectEvent(page, "worker_attempt.pause_signal_sent");
    await expectEvent(page, "run.paused");

    await page.getByPlaceholder("Plan, instruction, correction, or answer...").fill("Keep the user flow simple.");
    await clickButton(page, "SEND");
    await expectEvent(page, "human.note");

    await clickButton(page, "RESUME");
    await expectEvent(page, "worker_attempt.resume_signal_sent");
    await expectEvent(page, "run.resumed");
    await expectEvent(page, "autopilot.cycle_completed", 10_000);
    await expect(page.getByText("FINAL REPORT")).toBeVisible();

    const run = await readOnlyRun(userDataDir);
    expect(run.workerAttempts).toHaveLength(1);
    expect(run.workerAttempts[0].status).toBe("succeeded");
    expect(run.workerTasks[0].status).toBe("needs_review");
    expect(run.status).toBe("reviewing");
    expect(run.autopilot?.status).toBe("blocked");
    expect(run.plans[0].sourceFile).toMatch(/PLAN\.md$/);
    expect(run.plans[0].rawContent).toContain("Build the first autonomous manager loop.");
    expect(run.humanMessages.map((message) => message.message)).toContain("Pause before real workers.");
    expect(run.humanMessages.map((message) => message.message)).toContain("Keep the user flow simple.");

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

test("right sidebar sections stay ordered in a compact window", async () => {
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-layout-e2e-");

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
    await page.setViewportSize({ width: 357, height: 747 });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("SPARK AGENT")).toBeVisible();

    const inspector = await page.getByText("DEV INSPECTOR").boundingBox();
    const explorer = await page.getByText("EXPLORER").boundingBox();

    expect(inspector).not.toBeNull();
    expect(explorer).not.toBeNull();
    expect(inspector!.y).toBeLessThan(explorer!.y);
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
  await writeFile(join(workspaceDir, "PLAN.md"), "# Plan\n\nBuild the first autonomous manager loop.\n", "utf8");
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
  return { userDataDir, workspaceDir };
}

async function clickButton(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name });
  await expect(button).toBeEnabled();
  await button.click();
}

async function expectEvent(page: Page, type: string, timeout = 5_000): Promise<void> {
  await expect(page.locator("button").filter({ hasText: type }).first()).toBeVisible({ timeout });
}

async function readOnlyRun(userDataDir: string): Promise<{
  status: string;
  autopilot?: { status: string };
  plans: Array<{ sourceFile?: string; rawContent?: string }>;
  humanMessages: Array<{ message: string }>;
  steps: unknown[];
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
