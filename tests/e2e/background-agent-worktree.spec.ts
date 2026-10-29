import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A coordinator in one workspace (Notes) hands another workspace's
// repository (Repo) to a background subagent, which runs in the
// coordinator's own process: it makes its worktree with worktree.create and
// `workspace` (codara_worktree_create), the user allows it once with the
// cross-workspace card, and it reports with workspace.status and `worktree`
// (codara_workspace_status). Repo's rail then shows the worktree's row with
// "Background agent · from Notes", its state and the note, the Agents tab
// lists it under Repo, and a worktree made with plain `git worktree add`
// is listed too, as an external one.
//
// CODARA_PROOF_DIR=<dir> saves the screenshots there.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

async function shot(page: Page, name: string, top: string, bottom: string): Promise<void> {
  const dir = process.env.CODARA_PROOF_DIR;
  if (!dir) return;
  const a = await page.locator(top).first().boundingBox();
  const b = await page.locator(bottom).first().boundingBox();
  if (!a || !b) return;
  await page.waitForTimeout(300);
  const x = Math.max(0, Math.min(a.x, b.x) - 8);
  const y = Math.max(0, a.y - 8);
  await page.screenshot({
    path: join(dir, name),
    clip: { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x + 8, height: b.y + b.height - y + 8 },
  });
}

test("a background agent working in another workspace's repository shows on that workspace's rail", async () => {
  test.setTimeout(150_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-background-agent-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const notes = join(root, "notes");
  const outside = join(root, "outside-checkout");
  await Promise.all([mkdir(home), mkdir(repo), mkdir(notes)]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "README.md"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);
  // Made by hand, outside Codara.
  git(repo, ["worktree", "add", "-q", outside, "-b", "feat/by-hand"], gitEnv);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-notes",
      workspaces: [
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] },
        { id: "ws-notes", name: "Notes", cwd: notes, color: "#78A8FF", workers: [] },
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
  const call = (method: string, params: Record<string, unknown> = {}) =>
    rpcRaw({ home }, method, params, { timeoutMs: 90_000 }) as Promise<{ result?: any; error?: { message: string } }>;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await call(method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-notes"]')).toBeVisible({ timeout: 30_000 });
    // The coordinator's pane, in Notes. Its background subagent calls from
    // the same process, so Codara sees the same pane.
    const coordinator = await request("terminal.create", { cwd: notes, title: "coordinator" });
    const caller = { callerRole: "studio", callerClient: "claude-code", callerPaneId: coordinator.paneId };
    let made: { workspaceId: string; path: string; branch: string };

    await test.step("the external worktree is listed under its project, not hidden", async () => {
      const external = page.locator(`[data-rail-children-of="ws-repo"] [data-testid="workspace-external-worktree"]`);
      await expect(external).toHaveCount(1, { timeout: 30_000 });
      await expect(external).toHaveAttribute("data-path", outside);
      await expect(external).toContainText("feat/by-hand");
      await expect(external.getByTestId("external-worktree-line")).toContainText("External worktree");
    });

    await test.step("codara_worktree_create with workspace asks once, then makes the worktree in Repo", async () => {
      const card = page.getByRole("dialog", { name: "Allow a worktree in another workspace" });
      const pending = call("worktree.create", {
        ...caller,
        workspace: "ws-repo",
        branch: "agent/fix-parser",
        purpose: "Fix the parser",
      });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("Allow Notes to work in Repo?");
      await expect(card).toContainText("make a worktree of Repo");
      await card.getByRole("button", { name: "Allow once", exact: true }).click();
      const response = await pending;
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      made = response.result;
      expect(response.result.ok, JSON.stringify(response.result)).toBe(true);
      expect(response.result.sourceWorkspaceId).toBe("ws-repo");
      expect(existsSync(join(made.path, "README.md"))).toBe(true);
      expect(git(repo, ["worktree", "list"], gitEnv)).toContain("[agent/fix-parser]");
    });

    await test.step("the subagent's note lands on the worktree's row, named as a background agent from Notes", async () => {
      const status = await request("workspace.status", { ...caller, worktree: made.path, note: "Tests pass, opening the PR" });
      expect(status.updated, JSON.stringify(status)).toBe(true);
      expect(status.workspaceId).toBe(made.workspaceId);
      const row = page.locator(`[data-workspace-id="${made.workspaceId}"]`);
      await expect(page.locator(`[data-rail-children-of="ws-repo"] [data-workspace-id="${made.workspaceId}"]`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(row.getByTestId("worktree-background-agent")).toHaveText("Background agent · from Notes", { timeout: 15_000 });
      const line = row.getByTestId("worktree-agent-line");
      await expect(line).toHaveAttribute("data-state", "working");
      await expect(line).toContainText("working");
      await expect(line).toContainText("Tests pass, opening the PR");
      // Notes' own row does not carry it: the coordinator's terminal is there, the work is in Repo.
      await expect(page.locator('[data-workspace-id="ws-notes"]')).not.toContainText("Tests pass");
      await shot(page, "rail-background-agent.png", '[data-workspace-id="ws-repo"]', '[data-rail-children-of="ws-repo"]');
    });

    await test.step("a note on another repository's worktree the caller did not make is refused", async () => {
      const refused = await request("workspace.status", { ...caller, worktree: outside, note: "not mine" });
      expect(refused.updated).toBe(false);
      expect(refused.reason).toBe("worktree_not_yours");
      expect(refused.hint).toMatch(/codara_worktree_create/);
    });

    await test.step("in review, it reads done; the Agents tab lists it under Repo", async () => {
      await request("workspace.status", { ...caller, worktree: made.path, status: "in_review", note: "PR #1 is up" });
      const row = page.locator(`[data-workspace-id="${made.workspaceId}"]`);
      await expect(row.getByTestId("worktree-agent-line")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
      await page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: /^Agents/ }).click();
      const card = page.locator(`[data-agent-card="worktree:${made.workspaceId}"]`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("Repo");
      await expect(card).toContainText("Fix the parser");
      await expect(card.locator(".agent-inbox-row__status")).toHaveText("Done");
      await shot(page, "agents-tab-background-agent.png", ".agent-inbox", ".agent-inbox");
      await page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: /^Workspaces/ }).click();
    });

    await test.step("clicking the external worktree opens it in the rail as a worktree of Repo", async () => {
      const external = page.locator(`[data-rail-children-of="ws-repo"] [data-testid="workspace-external-worktree"]`);
      await external.click();
      await expect(external).toHaveCount(0, { timeout: 30_000 });
      const adopted = page.locator(`[data-rail-children-of="ws-repo"] [data-copy-branch="true"]`, { hasText: "feat/by-hand" });
      await expect(adopted).toBeVisible({ timeout: 15_000 });
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
