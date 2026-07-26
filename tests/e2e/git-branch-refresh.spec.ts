import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("branch picker refreshes refs changed outside Codara when opened", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-branch-refresh-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Branch refresh\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceDir });
  await execFileAsync("git", ["config", "user.email", "e2e@example.invalid"], { cwd: workspaceDir });
  await execFileAsync("git", ["config", "user.name", "Codara E2E"], { cwd: workspaceDir });
  await execFileAsync("git", ["add", "README.md"], { cwd: workspaceDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspaceDir });
  await execFileAsync("git", ["branch", "doomed-worktree-branch"], { cwd: workspaceDir });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-branch-refresh",
            name: "branch-refresh",
            cwd: workspaceDir,
            color: "#55C2B8",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-branch-refresh",
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

    // Waiting for the trigger proves BranchMenu has already captured the old
    // two-branch snapshot. Delete through external git, just like a terminal or
    // this coding session would; opening the picker must invalidate that cache.
    const trigger = page.getByTitle(/On branch main/);
    // First boot in a pristine isolated home does one-time work (path
    // enrichment, shell probe) before the git panel settles — allow for it.
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await execFileAsync("git", ["branch", "-D", "doomed-worktree-branch"], {
      cwd: workspaceDir,
    });

    // This test exercises the freshness boundary in the click handler, not
    // Chromium hit-testing. An occluded Electron window can stop producing
    // compositor frames, leaving Playwright's geometry-stability gate waiting
    // forever for an otherwise stationary button.
    await trigger.dispatchEvent("click");
    const filter = page.getByPlaceholder("Filter branches…");
    await expect(filter).toBeVisible();
    const branchPopup = filter.locator("xpath=ancestor::div[contains(@class, 'spark-glass')]");
    await expect(branchPopup.getByText("doomed-worktree-branch", { exact: true })).toHaveCount(0);
    await expect(branchPopup.getByText("main", { exact: true })).toBeVisible();
  } finally {
    await app?.close();
  }
});
