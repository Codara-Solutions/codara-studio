import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const DEFAULT_USER_WORKSPACE = "C:\\Users\\Etienne\\Documents\\workspace\\test";
const USER_FLOW_PLAN = "plan.md";

test("user flow launches real manager-selected worker terminals from the test workspace", async () => {
  test.setTimeout(180_000);
  test.skip(process.env.SPARK_E2E_USER_FLOW !== "1", "Run this with npm run test:user-flow.");

  const workspaceDir = process.env.SPARK_E2E_WORKSPACE || DEFAULT_USER_WORKSPACE;
  await assertReadableDirectory(workspaceDir);
  await ensureUserFlowPlan(workspaceDir);

  const { userDataDir } = await prepareUserFlowUserData(workspaceDir);
  const launchEnv = realUserFlowEnv(userDataDir);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: launchEnv,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Cora", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("test").first()).toBeVisible();

    await selectPlanByName(page, USER_FLOW_PLAN);
    await clickButton(page, "RUN");

    await expectEvent(page, "spark_call.started", 20_000);
    await expectEvent(page, "spark_call.completed", 90_000);

    const questionEvent = page.locator("button").filter({ hasText: "human.question" }).first();
    if (await questionEvent.isVisible().catch(() => false)) {
      await page
        .getByPlaceholder("Plan, instruction, correction, or answer...")
        .fill(
          "This is an existing workspace. Use the selected Markdown plan exactly as written. Decide the worker count and runtime yourself. Do not run demo tasks.",
        );
      await clickButton(page, "SEND");
      await clickButton(page, "RESUME");
      await expectEvent(page, "run.resumed", 20_000);
      await expect.poll(async () => page.locator("button").filter({ hasText: "spark_call.completed" }).count(), {
        timeout: 90_000,
      }).toBeGreaterThanOrEqual(2);
    }

    await expectEvent(page, "spark_manager.decision_applied", 90_000);

    const plannedRun = await waitForLatestRun(userDataDir, (run) => run.workerAttempts.length > 0);
    await expect
      .poll(async () => page.locator(".xterm-host").count(), { timeout: 90_000 })
      .toBeGreaterThanOrEqual(plannedRun.workerAttempts.length);
    await expect(page.getByText("WORKERS").first()).toBeVisible();
    await expect(page.getByText(/PowerShell|Command Prompt|pwsh|cmd/i).first()).toBeVisible();
    await expect(page.getByText("Cora decision", { exact: true }).first()).toBeVisible();

    await page.getByPlaceholder("Plan, instruction, correction, or answer...").fill("Stop after launch verification.");
    await clickButton(page, "STOP");
    await expectEvent(page, "worker_attempt.pause_signal_sent", 20_000);

    const run = await readLatestRun(userDataDir);
    expect(run.plans[0].sourceFile).toMatch(/plan\.md$/i);
    expect(run.sparkCalls.some((call) => call.status === "completed")).toBe(true);
    expect(run.workerAttempts.length).toBeGreaterThanOrEqual(1);
    expect(run.workerTasks.map((task) => task.runtimePreference)).toEqual(
      expect.arrayContaining([expect.stringMatching(/claude|codex/)]),
    );
    const firstPromptPath = run.workerAttempts[0].promptPath;
    expect(firstPromptPath).toBeTruthy();
    const prompt = await readFile(firstPromptPath!, "utf8");
    expect(prompt).toContain("PROJECT PLAN SNAPSHOT");
    expect(prompt).toContain(run.plans[0].rawContent!.trim());
  } finally {
    await app?.close();
  }
});

async function assertReadableDirectory(path: string): Promise<void> {
  await access(path, constants.R_OK);
}

async function ensureUserFlowPlan(workspaceDir: string): Promise<void> {
  const planPath = join(workspaceDir, USER_FLOW_PLAN);
  try {
    await access(planPath, constants.R_OK);
    return;
  } catch {
    await writeFile(
      planPath,
      [
        "# Spark Agent Demo Plan",
        "",
        "Use the selected plan exactly as written and let Spark choose the worker runtime.",
        "Do not modify project files during this smoke test.",
        "Each worker should only inspect the assignment and write the required final-report.json artifact.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

async function prepareUserFlowUserData(workspaceDir: string): Promise<{ userDataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spark-agent-user-flow-"));
  const userDataDir = join(root, "user-data");
  await mkdir(userDataDir, { recursive: true });

  await copyRealSettings(userDataDir);
  await copyRealPiAuth(userDataDir);

  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-user-flow",
            name: "test",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-user-flow",
      },
      null,
      2,
    ),
    "utf8",
  );

  return { userDataDir };
}

async function copyRealSettings(userDataDir: string): Promise<string> {
  const source = join(defaultSparkUserDataDir(), "spark-settings.json");
  const target = join(userDataDir, "spark-settings.json");
  try {
    await copyFile(source, target);
  } catch {
    await writeFile(
      target,
      JSON.stringify(
        {
          defaultShellId: null,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  return target;
}

// Cora's manager runs on the local Pi runtime against the user's connected
// subscriptions, there is no manager API key in settings any more, so the
// throwaway user-data dir needs a copy of the real OAuth store. Pi resolves it
// from <SPARK_USER_DATA_DIR>/pi-agent/auth.json (see codaraPiPaths).
async function copyRealPiAuth(userDataDir: string): Promise<void> {
  const source = join(homedir(), ".Codara", "pi-agent", "auth.json");
  try {
    await access(source, constants.R_OK);
  } catch {
    test.skip(true, "Connected Cora subscriptions (~/.Codara/pi-agent/auth.json) are required for the user flow.");
    return;
  }
  const configDir = join(userDataDir, "pi-agent");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const target = join(configDir, "auth.json");
  await copyFile(source, target);
  await chmod(target, 0o600);
}

function defaultSparkUserDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming"), "Spark Agent");
  }
  if (process.platform === "darwin") {
    return join(process.env.HOME || "", "Library", "Application Support", "Spark Agent");
  }
  return join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"), "Spark Agent");
}

function realUserFlowEnv(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    // Pin every home override the app honors: a shell inside the dev app
    // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
    // point this instance at the user's real ~/.Codara state.
    SPARK_USER_DATA_DIR: userDataDir,
    CODARA_HOME_DIR: userDataDir,
    SPARK_HOME_DIR: userDataDir,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
  };
  delete env.SPARK_ENABLE_MANUAL_FALLBACK;
  delete env.SPARK_MANUAL_WORKER_DELAY_MS;
  delete env.SPARK_CLAUDE_WORKER_COMMAND;
  delete env.SPARK_CLAUDE_WORKER_ARGS;
  delete env.SPARK_CODEX_WORKER_COMMAND;
  delete env.SPARK_CODEX_WORKER_ARGS;
  return env;
}

async function selectPlanByName(page: Page, fileName: string): Promise<void> {
  await page.getByRole("button", { name: "Selected plan file" }).click();
  const option = page.getByRole("option", { name: fileName, exact: true });
  await expect(option, `Expected ${fileName} to be available in the workspace plan selector`).toBeVisible();
  await option.click();
}

async function clickButton(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
}

async function expectEvent(page: Page, type: string, timeout = 5_000): Promise<void> {
  await expect(page.locator("button").filter({ hasText: type }).first()).toBeVisible({ timeout });
}

async function readLatestRun(userDataDir: string): Promise<{
  plans: Array<{ sourceFile?: string; rawContent?: string }>;
  sparkCalls: Array<{ status: string }>;
  workerTasks: Array<{ runtimePreference: string }>;
  workerAttempts: Array<{ status: string; promptPath?: string }>;
}> {
  const runsDir = join(userDataDir, "runs");
  const entries = await readdir(runsDir);
  expect(entries.length).toBeGreaterThan(0);
  const latest = entries.sort().at(-1)!;
  const raw = await readFile(join(runsDir, latest, "run.json"), "utf8");
  return JSON.parse(raw);
}

async function waitForLatestRun(
  userDataDir: string,
  predicate: (run: Awaited<ReturnType<typeof readLatestRun>>) => boolean,
): Promise<Awaited<ReturnType<typeof readLatestRun>>> {
  await expect
    .poll(async () => {
      try {
        return predicate(await readLatestRun(userDataDir));
      } catch {
        return false;
      }
    }, { timeout: 90_000 })
    .toBe(true);
  return readLatestRun(userDataDir);
}
