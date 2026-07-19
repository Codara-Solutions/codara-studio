import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// "Create copy" branch picker: the dialog lists the repo's branches, a branch
// already checked out elsewhere is only forkable (git forbids a second
// checkout), and opening a free branch materializes a worktree on that EXACT
// branch — no parody-named fork — and names the new workspace after it.
test("create-copy dialog opens an existing branch as a worktree workspace", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-create-copy-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const otherWorktree = join(root, "other-wt");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Create copy\n", "utf8");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: workspaceDir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "e2e@example.invalid"]);
  await git(["config", "user.name", "Codara E2E"]);
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);
  await git(["branch", "free-branch"]);
  await git(["branch", "occupied-branch"]);
  // Fabricate the "already checked out" state before launch.
  await git(["worktree", "add", otherWorktree, "occupied-branch"]);

  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-create-copy",
            name: "create-copy",
            cwd: workspaceDir,
            color: "#55C2B8",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-create-copy",
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

    // Row "…" menu → Create copy opens the picker instead of instantly forking.
    const menuTrigger = page.getByTitle("Workspace actions").first();
    await expect(menuTrigger).toBeVisible({ timeout: 30_000 });
    await menuTrigger.click();
    await page.getByText("Create copy", { exact: true }).click();
    await expect(page.getByText(/Create copy of/)).toBeVisible();

    // Both branches list; the one checked out in the sibling worktree is
    // marked unavailable for opening (its row title names the occupying path).
    const freeRow = page.getByTitle(/^Open free-branch as a new workspace/);
    await expect(freeRow).toBeVisible();
    await expect(
      page.getByTitle(/Already checked out at .*other-wt — fork a copy instead/),
    ).toBeVisible();

    // Open the free branch: workspace named after the branch, checkout-mode
    // welcome banner, and a real worktree on that exact branch (no new branch).
    await freeRow.click();
    await expect(page.getByText("Opened existing branch")).toBeVisible({ timeout: 15_000 });

    const worktreePath = join(userDataDir, "worktrees", basename(workspaceDir), "free-branch");
    expect(existsSync(worktreePath)).toBe(true);
    const { stdout: head } = await execFileAsync(
      "git",
      ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
      {},
    );
    expect(head.trim()).toBe("free-branch");
  } finally {
    await app?.close();
  }
});
