import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A coordinator in one workspace starts a terminal inside a new worktree of
// another workspace's repository in one terminal.create call, the socket
// method codara_terminal_create calls. The user is asked once, with the
// cross-workspace terminal card; Allow once makes the worktree, its rail row
// and the terminal in it, and the command runs in the worktree's folder. The
// coordinator lists and can remove it from its own folder. A worktree
// refusal opens nothing, and after Deny no worktree is made.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

test("a coordinator starts a terminal in a new worktree of another workspace in one call", async () => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-terminal-worktree-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const notes = join(root, "notes");
  await Promise.all([mkdir(home), mkdir(repo), mkdir(notes)]);
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
    rpcRaw({ home }, method, params, { timeoutMs: 60_000 }) as Promise<{ result?: any; error?: { message: string } }>;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await call(method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-notes"]')).toBeVisible({ timeout: 30_000 });
    const coordinator = await request("terminal.create", { cwd: notes, title: "coordinator" });
    const card = page.getByRole("dialog", { name: "Allow terminals in another workspace" });
    const ask = (branch: string) =>
      call("terminal.create", {
        callerPaneId: coordinator.paneId,
        workspace: "ws-repo",
        worktree: { branch, purpose: "Fix the parser" },
        title: "worker",
        command: "echo started-in-$(basename \"$PWD\")",
      });

    await test.step("one card, then the worktree, its row and the terminal in it", async () => {
      const pending = ask("agent/parser");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("Allow Notes to open terminals in Repo?");
      await card.getByRole("button", { name: "Allow once", exact: true }).click();
      const response = await pending;
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      const opened = response.result;
      expect(opened.worktree.branch).toBe("agent/parser");
      expect(opened.worktree.created).toBe(true);
      expect(opened.workspaceId).toBe(opened.worktree.workspaceId);
      expect(opened.cwd).toBe(opened.worktree.path);
      expect(existsSync(join(opened.worktree.path, "README.md"))).toBe(true);
      expect(git(repo, ["worktree", "list"], gitEnv)).toContain("[agent/parser]");

      const row = page.locator(`[data-workspace-id="${opened.worktree.workspaceId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.getByTestId("workspace-agent-worktree")).toHaveAttribute("title", /Fix the parser/);
      await expect
        .poll(async () => (await request("terminal.read", { paneId: opened.paneId })).text, { timeout: 15_000 })
        .toContain(`started-in-${basename(opened.worktree.path)}`);
      await row.click();
      await page.getByRole("tab", { name: /worker/ }).evaluate((tab) => (tab as HTMLElement).click());
      await expect(page.locator(`[data-terminal-pane-id="${opened.paneId}"]:visible`)).toBeVisible({ timeout: 15_000 });
    });

    await test.step("its maker finds it again from its own folder", async () => {
      const caller = { callerRole: "studio", callerClient: "claude-code", callerPaneId: coordinator.paneId };
      const listed = await request("worktree.list", caller);
      expect(listed.elsewhere.map((item: { branch: string }) => item.branch)).toEqual(["agent/parser"]);
      const removable = await request("worktree.remove", { ...caller, workspaceId: listed.elsewhere[0].workspaceId, dryRun: true });
      expect(removable.ok, JSON.stringify(removable)).toBe(true);
    });

    await test.step("a worktree refusal opens no terminal", async () => {
      const before = (await request("terminal.list", {})).panes?.length;
      const pending = ask("main");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Allow once", exact: true }).click();
      const response = await pending;
      expect(response.error?.message).toMatch(/^WORKTREE_RESERVED_BRANCH: /);
      const after = (await request("terminal.list", {})).panes?.length;
      expect(after).toBe(before);
    });

    await test.step("after Deny nothing is made", async () => {
      const pending = ask("agent/denied");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Deny", exact: true }).click();
      const response = await pending;
      expect(response.error).toBeTruthy();
      expect(git(repo, ["branch", "--list", "agent/denied"], gitEnv)).toBe("");
      expect(git(repo, ["worktree", "list"], gitEnv)).not.toContain("agent/denied");
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
