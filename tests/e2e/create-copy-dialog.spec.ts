import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// "Create copy" branch picker: a branch already checked out elsewhere is
// inert, opening a REMOTE branch materializes a worktree on a local tracking
// branch named after it (never an auto-generated name), and "Create new
// branch…" asks for a name and creates exactly that branch.
test("create-copy dialog opens remote branches and creates named branches", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-create-copy-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const originDir = join(root, "origin.git");
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
  await git(["branch", "occupied-branch"]);
  // Fabricate the "already checked out" state before launch.
  await git(["worktree", "add", otherWorktree, "occupied-branch"]);
  // A local bare origin with a remote-only branch — the dialog's Remote group.
  await execFileAsync("git", ["init", "--bare", originDir]);
  await git(["remote", "add", "origin", originDir]);
  await git(["push", "origin", "main"]);
  await git(["push", "origin", "main:origin-only"]);
  await git(["fetch", "origin"]);

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
        // point this instance at the user's real ~/.codarastudio state.
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Managed worktrees are namespaced per repo as
    // "<repo dirname>-<sha256 prefix>" (managedWorktreesRoot,
    // src/main/git-worktrees.ts:53-73). The hash is taken over the CANONICAL
    // path — on macOS this tmpdir resolves through /private — so the directory
    // name is not derivable from workspaceDir here. This throwaway home holds
    // exactly one repo, so read the name rather than recompute the hash; each
    // branch then lands in a subdirectory slugified from its short name
    // (pickCheckoutDirName, :196).
    const managedWorktree = async (branch: string): Promise<string> => {
      const repos = (await readdir(join(userDataDir, "worktrees"))).filter(
        (entry) => !entry.startsWith("."),
      );
      expect(repos).toHaveLength(1);
      return join(userDataDir, "worktrees", repos[0], branch);
    };
    const openDialogForFirstRow = async (): Promise<void> => {
      const menuTrigger = page.getByTitle("Workspace actions").first();
      await expect(menuTrigger).toBeVisible({ timeout: 30_000 });
      await menuTrigger.click();
      // The row menu names this action "Create isolated worktree…" — it is
      // what the copy IS, and the dialog's heading now says the same thing.
      await page.getByRole("menuitem", { name: /^Create isolated worktree/ }).click();
      await expect(page.getByText(/Create isolated worktree for/)).toBeVisible();
    };

    // ── Open a REMOTE branch: local tracking branch named after it ──────────
    await openDialogForFirstRow();
    await expect(
      page.getByTitle(/Already checked out at .*other-wt/),
    ).toBeVisible();
    await page
      .getByTitle(/^Open origin\/origin-only as a new workspace/)
      .click();
    await expect(page.getByText("Opened existing branch")).toBeVisible({ timeout: 15_000 });

    const remoteWorktree = await managedWorktree("origin-only");
    expect(existsSync(remoteWorktree)).toBe(true);
    const { stdout: remoteHead } = await execFileAsync(
      "git",
      ["-C", remoteWorktree, "rev-parse", "--abbrev-ref", "HEAD"],
      {},
    );
    expect(remoteHead.trim()).toBe("origin-only");
    const { stdout: upstream } = await execFileAsync(
      "git",
      ["-C", remoteWorktree, "rev-parse", "--abbrev-ref", "@{upstream}"],
      {},
    );
    expect(upstream.trim()).toBe("origin/origin-only");

    // ── Create a NEW branch: the dialog asks for a name and uses it ─────────
    // Back on the source workspace (first rail row — copies insert below it).
    await page.getByTitle("create-copy").first().click();
    await openDialogForFirstRow();
    await page.getByText("Create new branch…").click();
    const nameInput = page.getByPlaceholder("New branch name (Enter to create)");
    await expect(nameInput).toBeVisible();
    await nameInput.fill("my-feature");
    await nameInput.press("Enter");
    await expect(page.getByText(/on new branch/)).toBeVisible({ timeout: 15_000 });

    const namedWorktree = await managedWorktree("my-feature");
    expect(existsSync(namedWorktree)).toBe(true);
    const { stdout: namedHead } = await execFileAsync(
      "git",
      ["-C", namedWorktree, "rev-parse", "--abbrev-ref", "HEAD"],
      {},
    );
    expect(namedHead.trim()).toBe("my-feature");
  } finally {
    await app?.close();
  }
});
