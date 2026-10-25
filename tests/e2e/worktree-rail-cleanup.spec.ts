import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

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

// Clean up on the merged fold never does nothing: test and build output a
// fresh checkout regenerates does not hold a merged worktree back, an ignored
// file that would be lost is named and asked about first, and a worktree an
// open tab still owns says which tab to close.
test("Clean up on the merged fold always says what it did", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-worktree-rail-holds-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const repo = join(root, "repo");
  const other = join(root, "other");
  const trees = join(root, "trees");
  await Promise.all([mkdir(home), mkdir(userHome), mkdir(repo), mkdir(other), mkdir(trees), mkdir(join(root, "gh"))]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(SPARK_|CODARA_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|GROK_HOME$|ZDOTDIR$)/.test(key),
    ),
  );
  const gitEnv = { ...clean, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: join(root, "gh") };
  for (const dir of [repo, other]) {
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
    await writeFile(join(dir, ".gitignore"), "test-results/\nplaywright-report/\n.env\n");
    git(dir, ["add", ".gitignore"], gitEnv);
    git(dir, ["commit", "-q", "-m", "init"], gitEnv);
  }
  const commitIn = async (dir: string, file: string) => {
    await writeFile(join(dir, file), `${file}\n`);
    git(dir, ["add", file], gitEnv);
    git(dir, ["commit", "-q", "-m", file], gitEnv);
  };
  const before = new Date(Date.now() - 60_000).toISOString();
  const mergedTree = async (base: string, name: string, branch: string) => {
    const dir = join(trees, name);
    git(base, ["worktree", "add", "-q", "-b", branch, dir], gitEnv);
    await commitIn(dir, `${name}.txt`);
    git(base, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch], gitEnv);
    return dir;
  };
  // What feat/usage-forecast held when its Clean up did nothing: Playwright output.
  const output = await mergedTree(repo, "output", "feat/usage-forecast");
  await mkdir(join(output, "test-results", "run-1"), { recursive: true });
  await writeFile(join(output, "test-results", "run-1", "trace.zip"), "trace");
  await mkdir(join(output, "playwright-report"));
  await writeFile(join(output, "playwright-report", "index.html"), "<html></html>");
  const secrets = await mergedTree(other, "secrets", "feat/secrets");
  await writeFile(join(secrets, ".env"), "LOCAL_ONLY=1\n");

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] },
        { id: "ws-other", name: "Other", cwd: other, color: "#B48EAD", workers: [] },
        copyWorkspace("ws-output", "Usage forecast", output, repo, "feat/usage-forecast", before),
        copyWorkspace("ws-secrets", "Secrets copy", secrets, other, "feat/secrets", before),
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
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const row = (id: string) => page.locator(`[data-workspace-id="${id}"]`).first();
    const fold = (id: string) => page.locator(`[data-rail-children-of="${id}"]`).getByTestId("workspace-merged-fold");
    const notice = (id: string) => page.locator(`[data-rail-children-of="${id}"]`).getByTestId("workspace-merged-notice");
    const list = page.locator(".spark-workspace-list").first();
    await expect(row("ws-repo")).toBeVisible({ timeout: 30_000 });
    await expect(fold("ws-repo")).toContainText("1 merged", { timeout: 30_000 });
    await expect(fold("ws-other")).toContainText("1 merged", { timeout: 30_000 });
    await list.screenshot({ path: testInfo.outputPath("rail-clean-up-before.png") });

    await test.step("test output alone does not hold a merged worktree back", async () => {
      await fold("ws-repo").getByTestId("workspace-merged-clean-up").click();
      // The fold goes with its only worktree; its row was folded away.
      await expect(fold("ws-repo")).toHaveCount(0, { timeout: 30_000 });
      await expect(notice("ws-repo")).toHaveCount(0);
      expect(existsSync(output)).toBe(false);
      expect(branchExists(repo, "feat/usage-forecast", gitEnv)).toBe(false);
      await expect(page.getByText("Cleaned up Usage forecast")).toBeVisible();
    });

    // An agent's worktree in Repo, merged while the agent's tab stays open.
    const pane = await request("terminal.create", { cwd: repo, title: "usage agent" });
    const caller = { callerRole: "studio", callerClient: "claude-code", callerPaneId: pane.paneId };
    const held = await request("worktree.create", { ...caller, branch: "feat/held" });
    expect(held.ok, JSON.stringify(held)).toBe(true);
    await commitIn(held.path, "held.txt");
    git(repo, ["merge", "-q", "--no-ff", "-m", "merge feat/held", "feat/held"], gitEnv);

    await test.step("an ignored .env is named and asked about before anything is removed", async () => {
      await fold("ws-other").getByTestId("workspace-merged-clean-up").click();
      const confirm = page.getByTestId("workspace-merged-clean-up-confirm");
      await expect(confirm).toBeVisible({ timeout: 30_000 });
      await expect(confirm).toContainText("Secrets copy");
      await expect(confirm).toContainText(".env");
      await page.screenshot({ path: testInfo.outputPath("rail-clean-up-confirm.png") });
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);
      expect(existsSync(join(secrets, ".env"))).toBe(true);

      // A file that appears while the question is open is not what was
      // confirmed: the question comes back and says so.
      await fold("ws-other").getByTestId("workspace-merged-clean-up").click();
      await expect(confirm).toBeVisible({ timeout: 30_000 });
      await writeFile(join(other, ".git", "info", "exclude"), ".env.extra\n");
      await writeFile(join(secrets, ".env.extra"), "LOCAL_ONLY=2\n");
      await confirm.getByRole("button", { name: "Remove anyway" }).click();
      await expect(page.getByTestId("workspace-merged-clean-up-confirm-note")).toHaveText(
        "It changed since you were asked. Check the list again.",
        { timeout: 30_000 },
      );
      await expect(confirm).toContainText(".env.extra");
      expect(existsSync(join(secrets, ".env"))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("rail-clean-up-changed.png") });
      await confirm.getByRole("button", { name: "Remove anyway" }).click();
      await expect(fold("ws-other")).toHaveCount(0, { timeout: 30_000 });
      expect(existsSync(secrets)).toBe(false);
      expect(branchExists(other, "feat/secrets", gitEnv)).toBe(false);
    });

    await test.step("a worktree an open tab owns names that tab", async () => {
      await expect(fold("ws-repo")).toContainText("1 merged", { timeout: 30_000 });
      await fold("ws-repo").getByTestId("workspace-merged-clean-up").click();
      await expect(notice("ws-repo")).toContainText("Close the tab “usage agent” in Repo first", { timeout: 30_000 });
      await list.screenshot({ path: testInfo.outputPath("rail-clean-up-held.png") });
      expect(existsSync(held.path)).toBe(true);

      await request("terminal.close", { paneId: pane.paneId });
      await fold("ws-repo").getByTestId("workspace-merged-clean-up").click();
      await expect(fold("ws-repo")).toHaveCount(0, { timeout: 30_000 });
      expect(existsSync(held.path)).toBe(false);
      await expect(notice("ws-repo")).toHaveCount(0);
      await list.screenshot({ path: testInfo.outputPath("rail-clean-up-after.png") });
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
