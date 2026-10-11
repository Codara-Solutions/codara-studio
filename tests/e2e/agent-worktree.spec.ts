import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// An agent in a Codara terminal creates a worktree through the worktree.*
// socket methods the codara_worktree_* MCP tools call. The new workspace
// appears nested under its repository with the agent glyph, a toast names the
// agent and opens the worktree when clicked, and a merged worktree the agent
// removes leaves the rail without the user touching it.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

test("an agent's worktree shows up in the rail and leaves it once merged", async () => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-agent-worktree-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await Promise.all([mkdir(home), mkdir(repo)]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "README.md"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);

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
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-repo"]')).toBeVisible();

    // The agent's own pane, in the repository's workspace.
    const pane = await request("terminal.create", { cwd: repo, title: "agent" });
    const caller = { callerRole: "studio", callerClient: "claude-code", callerPaneId: pane.paneId };

    const first = await request("worktree.create", { ...caller, purpose: "Try the new parser" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.created).toBe(true);
    expect(existsSync(join(first.path, "README.md"))).toBe(true);
    const firstRow = page.locator(`[data-workspace-id="${first.workspaceId}"]`);
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    await expect(firstRow.getByTestId("workspace-agent-worktree")).toBeVisible({ timeout: 15_000 });
    await expect(firstRow.getByTestId("workspace-agent-worktree")).toHaveAttribute(
      "title",
      /^Created by Claude Code · Try the new parser · from main · /,
    );
    await expect(page.locator('[data-workspace-id="ws-repo"]')).toHaveAttribute("data-active", "true");

    const toast = page.locator(".spark-toast", { hasText: "Claude Code created a worktree" });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await toast.click();
    await expect(firstRow).toHaveAttribute("data-active", "true");
    await page.locator('[data-workspace-id="ws-repo"]').click();

    // A second worktree with nothing new on its branch is merged by
    // definition, so the agent may remove it; the row goes without a reload.
    const second = await request("worktree.create", { ...caller, branch: "agent/e2e-merged" });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const secondRow = page.locator(`[data-workspace-id="${second.workspaceId}"]`);
    await expect(secondRow).toBeVisible({ timeout: 15_000 });
    // Tabs the renderer saved for it must go with it.
    const secondTabsKey = `spark.tabs:${second.workspaceId}`;
    await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ tabs: [] })), secondTabsKey);

    const listed = await request("worktree.list", caller);
    expect(listed.ok).toBe(true);
    const listedSecond = listed.worktrees.find((item: { workspaceId: string }) => item.workspaceId === second.workspaceId);
    expect(listedSecond.createdBy.kind).toBe("agent");

    // A worker never gets to remove anything.
    const forbidden = await request("worktree.remove", { callerRole: "worker", workspaceId: second.workspaceId });
    expect(forbidden.code).toBe("WORKTREE_FORBIDDEN");

    const removed = await request("worktree.remove", { ...caller, workspaceId: second.workspaceId });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(removed.removed).toBe(true);
    expect(removed.proof).toBe("ancestor");
    expect(removed.branchDeleted).toBe(true);
    await expect(secondRow).toHaveCount(0, { timeout: 15_000 });
    expect(existsSync(second.path)).toBe(false);
    await expect(page.locator(".spark-toast", { hasText: "Claude Code removed a merged worktree" })).toBeVisible({
      timeout: 10_000,
    });
    expect(git(repo, ["rev-parse", removed.recoveryRef], gitEnv)).toBe(removed.verifiedCommit);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), secondTabsKey)).toBeNull();

    // Unmerged work stays, with the reason the agent has to act on.
    await writeFile(join(first.path, "parser.ts"), "export {};\n");
    git(first.path, ["add", "parser.ts"], gitEnv);
    git(first.path, ["commit", "-q", "-m", "parser"], gitEnv);
    const refused = await request("worktree.remove", { ...caller, workspaceId: first.workspaceId });
    expect(refused.ok).toBe(false);
    expect(refused.blockers).toContain("WORKTREE_NOT_MERGED");
    await expect(firstRow).toBeVisible();

    // Squash-merged now, but an uncommitted file still blocks, and nothing
    // moves. Opening the worktree from the toast started a shell in it, and
    // the user's own terminal blocks removal too.
    git(repo, ["merge", "-q", "--squash", first.branch], gitEnv);
    git(repo, ["commit", "-q", "-m", "squash parser"], gitEnv);
    await writeFile(join(first.path, "notes.txt"), "wip\n");
    const dirty = await request("worktree.remove", { ...caller, workspaceId: first.workspaceId });
    expect(dirty.code, JSON.stringify(dirty)).toBe("WORKTREE_DIRTY");
    expect(dirty.blockers).toContain("WORKTREE_RUNNING_PANES");
    expect(dirty.blockers).not.toContain("WORKTREE_NOT_MERGED");
    await expect(firstRow).toBeVisible();
    expect(existsSync(join(first.path, "notes.txt"))).toBe(true);
    await rm(join(first.path, "notes.txt"));
    const busy = await request("worktree.remove", { ...caller, workspaceId: first.workspaceId });
    expect(busy.code, JSON.stringify(busy)).toBe("WORKTREE_RUNNING_PANES");
    expect(busy.running.paneIds.length).toBe(1);

    // Once the user closes that terminal, the agent removes the worktree.
    await firstRow.click();
    await expect(firstRow).toHaveAttribute("data-active", "true");
    await page.getByRole("button", { name: "Close tab" }).first().click();
    await page.locator('[data-workspace-id="ws-repo"]').click();
    await expect
      .poll(async () => (await request("worktree.list", caller)).worktrees[0]?.running?.paneIds?.length ?? 0, {
        timeout: 15_000,
      })
      .toBe(0);
    const squashed = await request("worktree.remove", { ...caller, workspaceId: first.workspaceId });
    expect(squashed.ok, JSON.stringify(squashed)).toBe(true);
    expect(squashed.proof).toBe("content-in-target");
    await expect(firstRow).toHaveCount(0, { timeout: 15_000 });
    expect(existsSync(first.path)).toBe(false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
