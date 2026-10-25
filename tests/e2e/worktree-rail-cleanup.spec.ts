import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Merged and missing copy-branch workspaces in the rail: a merged worktree
// folds under its project, is marked "merged" and goes in one click with its
// branch; a worktree with no commits of its own yet is not called merged; a
// missing folder whose branch is merged leaves on its own; a missing folder
// with unmerged work stays, struck through, until Remove from rail drops the
// row and keeps the branch.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

function branchExists(cwd: string, name: string, env: NodeJS.ProcessEnv): boolean {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], env);
    return true;
  } catch {
    return false;
  }
}

function copyWorkspace(id: string, name: string, cwd: string, repo: string, branch: string, createdAt: string) {
  return {
    id,
    name,
    cwd,
    color: "#42D6C7",
    workers: [],
    copyBranch: { repoCwd: repo, branch, baseBranch: "main", city: id, mode: "fork", createdAt },
  };
}

test("merged and missing worktrees leave the rail cleanly", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-worktree-rail-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const repo = join(root, "repo");
  const trees = join(root, "trees");
  await Promise.all([mkdir(home), mkdir(userHome), mkdir(repo), mkdir(trees), mkdir(join(root, "gh"))]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  // Nothing of the live app reaches the test app: no pane variables, no
  // Codara home, no CLI account homes, no zsh integration dir.
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(SPARK_|CODARA_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|GROK_HOME$|ZDOTDIR$)/.test(key),
    ),
  );
  const gitEnv = {
    ...clean,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    // The GitHub CLI finds no login here, so no pull request is looked up.
    GH_CONFIG_DIR: join(root, "gh"),
  };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "README.md"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);

  const commitIn = async (dir: string, file: string, message: string) => {
    await writeFile(join(dir, file), `${message}\n`);
    git(dir, ["add", file], gitEnv);
    git(dir, ["commit", "-q", "-m", message], gitEnv);
  };
  const before = new Date(Date.now() - 60_000).toISOString();

  const merged = join(trees, "merged");
  git(repo, ["worktree", "add", "-q", "-b", "feature/merged", merged], gitEnv);
  await commitIn(merged, "merged.txt", "merged work");
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge feature/merged", "feature/merged"], gitEnv);

  const autoGone = join(trees, "auto-gone");
  git(repo, ["worktree", "add", "-q", "-b", "fix/alert-email-digest", autoGone], gitEnv);
  await commitIn(autoGone, "digest.txt", "digest fix");
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge fix/alert-email-digest", "fix/alert-email-digest"], gitEnv);
  // An agent's own cleanup: the worktree and its branch are gone already.
  git(repo, ["worktree", "remove", autoGone], gitEnv);
  git(repo, ["branch", "-d", "fix/alert-email-digest"], gitEnv);

  const missing = join(trees, "missing");
  git(repo, ["worktree", "add", "-q", "-b", "feature/missing", missing], gitEnv);
  await commitIn(missing, "idea.txt", "an unmerged idea");
  await rm(missing, { recursive: true, force: true });

  const fresh = join(trees, "fresh");
  git(repo, ["worktree", "add", "-q", "-b", "feature/fresh", fresh], gitEnv);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] },
        copyWorkspace("ws-merged", "Merged copy", merged, repo, "feature/merged", before),
        copyWorkspace("ws-auto", "Alert digest", autoGone, repo, "fix/alert-email-digest", before),
        copyWorkspace("ws-missing", "Moved idea", missing, repo, "feature/missing", before),
        copyWorkspace("ws-fresh", "Fresh copy", fresh, repo, "feature/fresh", new Date(Date.now() + 5_000).toISOString()),
      ],
    }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...gitEnv,
      HOME: userHome,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      SPARK_E2E_BACKGROUND: "1",
      CODARA_CHROME_LINK: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const row = (id: string) => page.locator(`[data-workspace-id="${id}"]`).first();
    await expect(row("ws-repo")).toBeVisible({ timeout: 30_000 });

    // Folder, registration and branch all gone: the row leaves on its own.
    await expect(page.locator('[data-workspace-id="ws-auto"]')).toHaveCount(0, { timeout: 30_000 });

    // Merged worktrees fold under their project: one line says how many.
    const fold = page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-merged-fold");
    await expect(fold).toContainText("1 merged", { timeout: 30_000 });
    await expect(page.locator('[data-workspace-id="ws-merged"]')).toHaveCount(0);
    await fold.getByTestId("workspace-merged-toggle").click();
    await expect(row("ws-merged").getByTestId("workspace-merged")).toBeVisible({ timeout: 30_000 });
    await expect(row("ws-fresh").getByTestId("workspace-merged")).toHaveCount(0);
    await expect(row("ws-missing").getByTestId("workspace-missing")).toHaveText("Folder gone");
    await expect(row("ws-missing").getByTestId("workspace-merged")).toHaveCount(0);

    const list = page.locator(".spark-workspace-list").first();
    await row("ws-merged").hover();
    await expect(row("ws-merged").getByTestId("workspace-clean-up")).toBeVisible();
    await list.screenshot({ path: testInfo.outputPath("rail-merged-hover.png") });
    await row("ws-missing").hover();
    await expect(row("ws-missing").getByTestId("workspace-remove-from-rail")).toBeVisible();
    await list.screenshot({ path: testInfo.outputPath("rail-missing-hover.png") });

    // One click: the worktree, its merged branch and the row.
    await row("ws-merged").hover();
    await row("ws-merged").getByTestId("workspace-clean-up").click();
    await expect(page.locator('[data-workspace-id="ws-merged"]')).toHaveCount(0, { timeout: 30_000 });
    expect(existsSync(merged)).toBe(false);
    expect(branchExists(repo, "feature/merged", gitEnv)).toBe(false);

    // Remove from rail drops the row; the unmerged branch stays.
    await row("ws-missing").hover();
    await row("ws-missing").getByTestId("workspace-remove-from-rail").click();
    await expect(page.locator('[data-workspace-id="ws-missing"]')).toHaveCount(0, { timeout: 30_000 });
    expect(branchExists(repo, "feature/missing", gitEnv)).toBe(true);
    await expect(page.getByText("Branch feature/missing kept: it has unmerged commits.")).toBeVisible();

    expect(existsSync(fresh)).toBe(true);
    await expect(row("ws-fresh")).toBeVisible();
    await list.screenshot({ path: testInfo.outputPath("rail-after.png") });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
