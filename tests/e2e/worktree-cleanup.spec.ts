import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// The worktree cleanup screen, opened from a workspace's row menu, lists the
// repository's worktrees with their git state and sizes, filters them, keeps
// the main checkout and a worktree with an open terminal out of reach, asks
// for a confirmation per worktree that holds work, and removes the picked
// ones: a merged branch goes, an unmerged one stays and is listed for review,
// and the rail row of a removed worktree leaves.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

function refExists(cwd: string, ref: string, env: NodeJS.ProcessEnv): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", ref], env);
    return true;
  } catch {
    return false;
  }
}

test("the cleanup screen removes only what it may, and what was confirmed", async () => {
  test.setTimeout(150_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-worktree-cleanup-")));
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

  const dirty = join(trees, "dirty");
  git(repo, ["worktree", "add", "-q", "-b", "feature/dirty", dirty], gitEnv);
  await writeFile(join(dirty, "notes.txt"), "work in progress\n");

  const unmerged = join(trees, "unmerged");
  git(repo, ["worktree", "add", "-q", "-b", "feature/unmerged", unmerged], gitEnv);
  await writeFile(join(unmerged, "idea.txt"), "idea\n");
  git(unmerged, ["add", "idea.txt"], gitEnv);
  git(unmerged, ["commit", "-q", "-m", "an idea"], gitEnv);

  const busy = join(trees, "busy");
  git(repo, ["worktree", "add", "-q", "-b", "feature/busy", busy], gitEnv);

  const moved = join(trees, "moved");
  git(repo, ["worktree", "add", "-q", "-b", "feature/moved", moved], gitEnv);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] },
        {
          id: "ws-merged",
          name: "Merged copy",
          cwd: merged,
          color: "#42D6C7",
          workers: [],
          copyBranch: {
            repoCwd: repo,
            branch: "feature/merged",
            baseBranch: "main",
            city: "merged",
            mode: "fork",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        },
      ],
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
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const repoRow = page.locator('[data-workspace-id="ws-repo"]');
    await expect(repoRow).toBeVisible({ timeout: 30_000 });
    // Merged worktrees fold under their project until opened.
    await page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-merged-toggle").click({ timeout: 30_000 });
    await expect(page.locator('[data-workspace-id="ws-merged"]')).toBeVisible();

    // A terminal open in a worktree keeps it out of reach.
    await request("terminal.create", { cwd: busy, title: "busy" });
    // So does one opened in the main checkout whose shell moved into a
    // worktree without telling the pane (no OSC 7 from a plain sh): only
    // the process's own folder shows it.
    const elsewhere = await request("terminal.create", { cwd: repo, title: "elsewhere" });
    await request("terminal.write", {
      paneId: elsewhere.paneId,
      text: `exec sh -c 'cd "${moved}" && echo moved-in-$((40 + 2)) && exec sleep 600'`,
    });
    await expect
      .poll(async () => (await request("terminal.read", { paneId: elsewhere.paneId })).text, { timeout: 15_000 })
      .toContain("moved-in-42");

    await repoRow.getByTitle("Workspace actions").click();
    await page.getByRole("menuitem", { name: /^Clean up worktrees/ }).click();
    const dialog = page.getByRole("dialog", { name: "Clean up worktrees" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox", { name: "Search worktrees" })).toBeFocused();

    const rows = dialog.locator("[data-worktree-path]");
    await expect(rows).toHaveCount(6, { timeout: 30_000 });
    const row = (path: string) => dialog.locator(`[data-worktree-path="${path}"]`);

    await expect(row(repo).getByText("Main checkout")).toBeVisible();
    await expect(row(repo).getByRole("checkbox")).toBeDisabled();
    await expect(row(busy).getByText("In use", { exact: true })).toBeVisible();
    await expect(row(busy).getByRole("checkbox")).toBeDisabled();
    await expect(row(busy).getByText("In use: 1 open terminal.", { exact: true })).toBeVisible();
    if (process.platform !== "win32") {
      await expect(row(moved).getByRole("checkbox")).toBeDisabled();
      await expect(row(moved).getByText("In use: 1 running process.", { exact: true })).toBeVisible();
    }
    await expect(row(merged).getByText("Merged", { exact: true })).toBeVisible();
    await expect(row(merged).getByText("Workspace Merged copy")).toBeVisible();
    await expect(row(unmerged).getByText("1 commit not merged")).toBeVisible();
    await expect(row(dirty).getByText("1 uncommitted change")).toBeVisible();
    // Sizes land in the background.
    await expect(row(merged).locator(".wtc-cell-num").last()).toHaveText(/^\d+(\.\d)? (B|KB|MB)$/, { timeout: 30_000 });

    // Filters and search.
    // A branch with no commits of its own is merged by definition.
    await dialog.getByRole("button", { name: "Merged", exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(row(unmerged)).toHaveCount(0);
    await expect(row(repo)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Merged", exact: true }).click();
    await dialog.getByRole("searchbox", { name: "Search worktrees" }).fill("unmerged");
    await expect(rows).toHaveCount(1);
    await dialog.getByRole("searchbox", { name: "Search worktrees" }).fill("");
    await expect(rows).toHaveCount(6);

    // Focus stays inside the screen.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

    // Pick three, one from the keyboard, and review them.
    await dialog.getByRole("checkbox", { name: "Select feature/merged" }).focus();
    await page.keyboard.press("Space");
    await expect(dialog.getByRole("checkbox", { name: "Select feature/merged" })).toBeChecked();
    // A click on the branch name picks the row once, and so does a click
    // anywhere else on it.
    await row(dirty).locator("label", { hasText: "feature/dirty" }).click();
    await expect(dialog.getByRole("checkbox", { name: "Select feature/dirty" })).toBeChecked();
    await row(unmerged).locator(".wtc-row-path").click();
    await expect(dialog.getByRole("checkbox", { name: "Select feature/unmerged" })).toBeChecked();
    await dialog.getByRole("button", { name: "Review removal of 3" }).click();
    const review = page.getByRole("dialog", { name: "Review removal" });
    await expect(review).toBeVisible();
    const item = (path: string) => review.locator(`li[data-worktree-path="${path}"]`);
    await expect(item(merged).getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(item(merged).getByText("Branch feature/merged is merged and will be deleted.")).toBeVisible();
    await expect(item(dirty).getByText("Needs your confirmation")).toBeVisible();
    await expect(item(unmerged).getByText("Needs your confirmation")).toBeVisible();
    await expect(item(unmerged).getByText("an idea")).toBeVisible();
    await expect(review.getByRole("button", { name: "Remove 1 worktree" })).toBeEnabled();
    await expect(review.getByText("2 worktrees wait for your confirmation. Only the ready ones are removed.")).toBeVisible();

    // Escape steps back to the list with the pick intact; nothing was removed.
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("button", { name: "Review removal of 3" })).toBeVisible();
    expect(existsSync(merged)).toBe(true);
    await dialog.getByRole("button", { name: "Review removal of 3" }).click();
    await expect(item(merged).getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });

    await item(dirty).getByRole("checkbox", { name: "Delete its uncommitted work" }).check();
    await item(unmerged).getByRole("checkbox", { name: "Remove it although its commits are not merged" }).check();
    await review.getByRole("button", { name: "Remove 3 worktrees" }).click();

    const done = page.getByRole("dialog", { name: "Removal done" });
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done.getByText(/^Removed 3 worktrees/)).toBeVisible();
    const kept = done.getByRole("region", { name: "Branches kept for review" });
    await expect(kept.getByText("feature/unmerged")).toBeVisible();
    await expect(done.locator(`li[data-worktree-path="${merged}"]`).getByText("Branch feature/merged deleted.")).toBeVisible();
    await expect(done.locator(`li[data-worktree-path="${dirty}"]`).getByText("Uncommitted work saved as")).toBeVisible();

    for (const path of [merged, dirty, unmerged]) expect(existsSync(path)).toBe(false);
    expect(existsSync(busy)).toBe(true);
    expect(existsSync(moved)).toBe(true);
    expect(refExists(repo, "refs/heads/feature/merged", gitEnv)).toBe(false);
    expect(refExists(repo, "refs/heads/feature/dirty", gitEnv)).toBe(false);
    expect(refExists(repo, "refs/heads/feature/unmerged", gitEnv)).toBe(true);
    const saved = git(repo, ["for-each-ref", "--format=%(refname)", "refs/codara/removed-worktrees/"], gitEnv)
      .split("\n")
      .filter(Boolean);
    const changes = saved.find((ref) => ref.endsWith("-changes"));
    expect(changes, saved.join("\n")).toBeTruthy();
    expect(git(repo, ["show", `${changes}:notes.txt`], gitEnv)).toBe("work in progress");
    await expect(page.locator('[data-workspace-id="ws-merged"]')).toHaveCount(0, { timeout: 15_000 });

    // Back on the list, only what is left shows; Escape closes the screen.
    await done.getByRole("button", { name: "Back to the list" }).click();
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
