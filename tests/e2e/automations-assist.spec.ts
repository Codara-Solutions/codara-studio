import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke for the Automations Hub's guided empty state: both creation paths are
// visible, "Design with Cora" mounts the automation architect (locked composer — no
// mode-cycle pill), and "Done" returns to the launchpad. No message is ever
// sent, so no backend/CLI is required.

test("automations hub mounts the Create-with-Cora assist chat", async () => {
  test.setTimeout(90_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-assist-e2e-");

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
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Open the Automations tab from the top strip's "+" picker.
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByText("New automations", { exact: true }).click();

    // Empty-state launchpad: both creation paths are explicit.
    const assistButton = page.getByRole("button", { name: /Design with Cora/ });
    await expect(assistButton).toBeVisible();
    await expect(page.getByRole("button", { name: /Build a flow/ })).toBeVisible();

    // Enter the assist view: architect chat panel + session controls mount,
    // the composer is pinned to automation mode (placeholder proves the
    // lockedMode draft path; the mode-cycle pill must be absent).
    await assistButton.click();
    await expect(page.getByText("Cora · Automation architect", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
    await expect(
      page.getByPlaceholder("Describe the loom you want — trigger, loop, and worker."),
    ).toBeVisible();
    await expect(page.locator(".composer-mode-cycle")).toHaveCount(0);
    await expect(page.getByText("Describe the outcome, not the plumbing", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Keep tests green/ }).click();
    await expect(
      page.getByPlaceholder("Describe the loom you want — trigger, loop, and worker."),
    ).toHaveValue(/runs the project's tests/);

    // "Done" returns to the launchpad (assist button reappears).
    await page.getByRole("button", { name: /^Done — back to the looms view$/ }).click();
    await expect(page.getByRole("button", { name: /Design with Cora/ })).toBeVisible();

    // The manual path opens a real, descriptive template gallery instead of
    // dropping the user into an unexplained blank graph.
    await page.getByRole("button", { name: /Build a flow/ }).click();
    await expect(page.getByRole("button", { name: /Fix until tests pass/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fan-out review/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start blank/ })).toBeVisible();

    // Prompt variables explain their runtime value immediately on hover (and
    // through aria-describedby for keyboard/screen-reader users).
    await page.locator(".react-flow__node-worker").click();
    const iterationVariable = page.getByRole("button", { name: "{{iteration}}", exact: true });
    await iterationVariable.hover();
    const iterationTooltip = page.getByRole("tooltip").filter({ hasText: "current loop pass number" });
    await expect(iterationTooltip).toBeVisible();
    await expect(iterationTooltip).toContainText("Click to insert");
  } finally {
    await app?.close();
  }
});

test("automation architect restores its exact session after a workspace switch", async () => {
  test.setTimeout(90_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-assist-restore-e2e-");

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
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByText("New automations", { exact: true }).click();
    await page.getByRole("button", { name: /Design with Cora/ }).click();

    // Select a real persisted architect run, rather than merely proving that
    // the empty draft surface survives. This is the session users previously
    // had to rediscover manually in History after every workspace round-trip.
    await page.getByRole("button", { name: "Session history", exact: true }).click();
    await page.getByRole("option", { name: /Restore me/ }).click();
    await expect(page.getByText("#restore", { exact: true })).toBeVisible();

    await page.locator('[data-workspace-id="ws-assist-other"]').click();
    await expect(page.locator(".cora-welcome__project-name")).toHaveText("other workspace");
    await page.locator('[data-workspace-id="ws-assist-e2e"]').click();

    await expect(page.getByText("Cora · Automation architect", { exact: true })).toBeVisible();
    await expect(page.getByText("#restore", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();

    // An explicit Done remains authoritative: workspace restoration must not
    // reopen a surface the user intentionally closed.
    await page.getByRole("button", { name: /^Done — back to the looms view$/ }).click();
    await page.locator('[data-workspace-id="ws-assist-other"]').click();
    await page.locator('[data-workspace-id="ws-assist-e2e"]').click();
    await expect(page.getByRole("button", { name: /Design with Cora/ })).toBeVisible();
  } finally {
    await app?.close();
  }
});

async function prepareElectronWorkspace(
  prefix: string,
): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const otherWorkspaceDir = join(root, "other-workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(otherWorkspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# E2E workspace\n", "utf8");
  await writeFile(join(otherWorkspaceDir, "README.md"), "# Other E2E workspace\n", "utf8");
  const now = new Date().toISOString();
  const assistRunId = "run-assist-e2e-restore";
  const assistRunDir = join(userDataDir, "runs", assistRunId);
  await mkdir(assistRunDir, { recursive: true });
  await writeFile(
    join(assistRunDir, "run.json"),
    JSON.stringify(
      {
        id: assistRunId,
        workspaceId: "ws-assist-e2e",
        title: "Restore me",
        status: "paused",
        artifactDir: assistRunDir,
        createdAt: now,
        updatedAt: now,
        plans: [],
        steps: [],
        workerTasks: [],
        workerAttempts: [],
        sparkCalls: [],
        humanMessages: [],
        chatMode: "automation",
        chatBackend: "claude",
        autopilot: { status: "paused", updatedAt: now },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-assist-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
          {
            id: "ws-assist-other",
            name: "other workspace",
            cwd: otherWorkspaceDir,
            color: "#55C2B8",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-assist-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
