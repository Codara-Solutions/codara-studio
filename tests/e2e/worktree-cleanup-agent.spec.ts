import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// An agent asks to remove worktrees through codara_worktree_cleanup: the scan
// recommends, and the removal opens Codara's approval dialog naming the agent.
// Only the safe worktree starts ticked, the one with unsaved changes cannot be
// ticked, an unticked one stays, and closing the dialog declines. Nothing is
// removed before the user presses Remove.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

test("an agent's cleanup request removes only what the user approves", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-worktree-cleanup-agent-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const trees = join(root, "trees");
  await Promise.all([mkdir(home), mkdir(repo), mkdir(trees), mkdir(join(root, "gh"))]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    // The GitHub CLI finds no login here, so no pull request is looked up.
    GH_CONFIG_DIR: join(root, "gh"),
  };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "README.md"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);

  const merged = join(trees, "merged");
  git(repo, ["worktree", "add", "-q", "-b", "feature/merged", merged], gitEnv);
  await writeFile(join(merged, "merged.txt"), "merged\n");
  git(merged, ["add", "merged.txt"], gitEnv);
  git(merged, ["commit", "-q", "-m", "merged work"], gitEnv);
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge feature/merged", "feature/merged"], gitEnv);

  const done = join(trees, "done");
  git(repo, ["worktree", "add", "-q", "-b", "feature/done", done], gitEnv);

  const dirty = join(trees, "dirty");
  git(repo, ["worktree", "add", "-q", "-b", "feature/dirty", dirty], gitEnv);
  await writeFile(join(dirty, "notes.txt"), "work in progress\n");

  const idea = join(trees, "idea");
  git(repo, ["worktree", "add", "-q", "-b", "feature/idea", idea], gitEnv);
  await writeFile(join(idea, "idea.txt"), "idea\n");
  git(idea, ["add", "idea.txt"], gitEnv);
  git(idea, ["commit", "-q", "-m", "an idea"], gitEnv);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [{ id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] }],
    }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...gitEnv,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 150_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-repo"]')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.spark.preferences.set("theme", "dracula"));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dracula");

    // The scan reads only and recommends.
    const scan = await request("worktree.cleanup", { action: "scan", callerClient: "claude-code" });
    const byPath = new Map<string, { recommendation: string; reason: string }>(
      scan.worktrees.map((entry: { path: string; recommendation: string; reason: string }) => [entry.path, entry]),
    );
    expect(byPath.size).toBe(4);
    expect(byPath.get(merged)?.recommendation).toBe("safe to remove");
    expect(byPath.get(done)?.recommendation).toBe("safe to remove");
    expect(byPath.get(dirty)?.recommendation).toBe("keep");
    expect(byPath.get(dirty)?.reason).toMatch(/Unsaved changes/);
    expect(scan.totals.safeToRemove).toBe(2);
    for (const path of [merged, done, dirty, idea]) expect(existsSync(path)).toBe(true);

    // Removal waits for the user.
    const removal = request("worktree.cleanup", {
      action: "remove",
      paths: [merged, done, dirty, idea],
      callerClient: "claude-code",
    });
    const dialog = page.getByRole("dialog", { name: "Remove worktrees?" });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText("claude-code asks to remove 4 worktrees")).toBeVisible();
    const item = (path: string) => dialog.locator(`li[data-worktree-path="${path}"]`);
    await expect(item(merged).getByRole("checkbox", { name: "Remove feature/merged" })).toBeChecked();
    await expect(item(done).getByRole("checkbox", { name: "Remove feature/done" })).toBeChecked();
    await expect(item(dirty).getByRole("checkbox", { name: "Remove feature/dirty" })).toBeDisabled();
    await expect(item(dirty).getByText(/unsaved changes/)).toBeVisible();
    await expect(item(idea).getByRole("checkbox", { name: "Remove feature/idea" })).not.toBeChecked();
    await expect(item(merged).getByText("safe to remove", { exact: true })).toBeVisible();
    await expect(item(merged).getByText(/The remote branch stays\. The repository has no remote\./)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Remove 2 worktrees" })).toBeEnabled();
    expect(existsSync(merged)).toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: process.env.CODARA_WT_CLEANUP_SHOT ?? testInfo.outputPath("approval-dialog.png") });

    // The user leaves one of the safe ones out.
    await item(done).getByRole("checkbox", { name: "Remove feature/done" }).uncheck();
    await dialog.getByRole("button", { name: "Remove 1 worktree" }).click();
    const result = await removal;
    expect(result.status).toBe("done");
    expect(result.removed.map((entry: { path: string }) => entry.path)).toEqual([merged]);
    const reasons = new Map(result.skipped.map((entry: { path: string; reason: string }) => [entry.path, entry.reason]));
    expect(reasons.get(done)).toBe("The user left it unticked.");
    expect(reasons.get(dirty)).toMatch(/unsaved changes/);
    expect(existsSync(merged)).toBe(false);
    for (const path of [done, dirty, idea]) expect(existsSync(path)).toBe(true);
    const finished = page.getByRole("dialog", { name: "Removal done" });
    await expect(finished.getByText(/^Removed 1 worktree/)).toBeVisible({ timeout: 30_000 });
    await finished.getByRole("button", { name: "Done" }).click();
    await expect(finished).toHaveCount(0);

    // Escape declines; nothing goes.
    const second = request("worktree.cleanup", { action: "remove", paths: [done], callerClient: "codex" });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText("codex asks to remove 1 worktree")).toBeVisible();
    await page.keyboard.press("Escape");
    const declined = await second;
    expect(declined.status).toBe("declined");
    await expect(dialog).toHaveCount(0);
    expect(existsSync(done)).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
