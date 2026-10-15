import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A repository that keeps its worktree setup in .worktreeinclude and
// .codara/worktree.json: the create dialog says what a new worktree gets, a
// worktree made there arrives with its .env copied, node_modules linked and
// the setup command run; a failing command shows in the setup tray with its
// log; and an agent's worktree waits for setup and reports it.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

test("worktree setup prepares new worktrees from the repository's files", async () => {
  test.skip(process.platform === "win32", "the setup commands here are POSIX shell");
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-worktree-setup-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await Promise.all([mkdir(home), mkdir(repo)]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# repo\n");
  await writeFile(join(repo, ".gitignore"), ".env\nnode_modules/\nsetup.txt\nterminal.txt\n");
  await writeFile(join(repo, ".worktreeinclude"), ".env\n");
  await mkdir(join(repo, ".codara"));
  const setupFile = join(repo, ".codara", "worktree.json");
  await writeFile(
    setupFile,
    JSON.stringify(
      {
        link: ["node_modules"],
        setup: 'echo "root=$CODARA_ROOT_PATH" > setup.txt',
        terminals: [{ name: "setup-shell", command: "echo opened > terminal.txt" }],
      },
      null,
      2,
    ),
  );
  git(repo, ["add", "-A"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);
  // What git does not track: the secrets file and the installed packages.
  await writeFile(join(repo, ".env"), "API_KEY=local\n");
  await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [{ id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] }],
    }),
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
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
      const response = await rpcRaw({ home }, method, params, { timeoutMs: 120_000 });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    };
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-repo"]')).toBeVisible({ timeout: 30_000 });

    const managedWorktree = (branch: string): string => {
      const repos = readdirSync(join(home, "worktrees")).filter((entry) => !entry.startsWith("."));
      expect(repos).toHaveLength(1);
      return join(home, "worktrees", repos[0], branch);
    };
    const openCreateDialog = async (): Promise<void> => {
      await page.locator('[data-workspace-id="ws-repo"]').click();
      const menuTrigger = page.getByTitle("Workspace actions").first();
      await expect(menuTrigger).toBeVisible({ timeout: 30_000 });
      await menuTrigger.click();
      await page.getByRole("menuitem", { name: /^Create isolated worktree/ }).click();
      await expect(page.getByText(/Create isolated worktree for/)).toBeVisible();
    };
    const createBranch = async (name: string): Promise<void> => {
      await page.getByText("Create new branch…").click();
      const nameInput = page.getByPlaceholder("New branch name (Enter to create)");
      await nameInput.fill(name);
      await nameInput.press("Enter");
    };

    // ── The dialog says what a new worktree gets ───────────────────────────
    await openCreateDialog();
    const summary = page.getByTestId("worktree-setup-summary");
    await expect(summary).toContainText("Copies 1 ignored file or folder from this checkout", { timeout: 15_000 });
    await expect(summary).toContainText("Links node_modules");
    await expect(summary).toContainText('echo "root=$CODARA_ROOT_PATH" > setup.txt');
    // The terminal's command shows too: creating the worktree runs it.
    await expect(summary).toContainText("Opens 1 terminal: setup-shell (echo opened > terminal.txt)");
    await expect(summary.getByRole("checkbox", { name: /Run setup commands and open its terminals/ })).toBeChecked();

    // The setup file dialog opens over it, and Escape closes only that one.
    await summary.getByRole("button", { name: "Edit setup…" }).click();
    const fileDialog = page.getByTestId("worktree-setup-file-dialog");
    await expect(fileDialog).toBeVisible();
    await expect(fileDialog.getByLabel("Files to copy from this checkout")).toHaveValue(".env", { timeout: 15_000 });
    await expect(fileDialog.getByRole("button", { name: "node_modules", pressed: true })).toBeVisible();
    // Installing into the linked node_modules is called out while editing.
    await expect(fileDialog.getByTestId("worktree-setup-install-conflict")).toHaveCount(0);
    await fileDialog.getByLabel("Setup command", { exact: true }).fill("npm ci");
    await expect(fileDialog.getByTestId("worktree-setup-install-conflict")).toContainText("installs into node_modules");
    await page.keyboard.press("Escape");
    await expect(fileDialog).toHaveCount(0);
    await expect(page.getByText(/Create isolated worktree for/)).toBeVisible();

    // ── A worktree made there arrives ready ────────────────────────────────
    await createBranch("setup-feature");
    await expect(page.getByText(/on new branch/)).toBeVisible({ timeout: 15_000 });
    const worktree = managedWorktree("setup-feature");
    await expect.poll(() => existsSync(join(worktree, "setup.txt")), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("API_KEY=local\n");
    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(readFileSync(join(worktree, "setup.txt"), "utf8").trim()).toBe(`root=${repo}`);
    // The link never shows up as a change in the new worktree.
    expect(git(worktree, ["status", "--porcelain"], gitEnv)).toBe("");
    // The file's terminal opened in the new worktree and ran its command.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]")).some((el) =>
              (el.textContent ?? "").includes("setup-shell"),
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect.poll(() => existsSync(join(worktree, "terminal.txt")), { timeout: 30_000 }).toBe(true);

    // ── A failing command stays in the tray, with its log ──────────────────
    await writeFile(setupFile, JSON.stringify({ setup: ["echo checking the toolchain", "exit 7"] }, null, 2));
    await openCreateDialog();
    await expect(page.getByTestId("worktree-setup-summary")).toContainText("exit 7", { timeout: 15_000 });
    await createBranch("setup-broken");
    await expect(page.getByText(/on new branch/).last()).toBeVisible({ timeout: 15_000 });
    const tray = page.getByTestId("worktree-setup-tray");
    const failedRow = tray.locator('[data-state="failed"]', { hasText: "setup-broken" });
    await expect(failedRow).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".spark-toast", { hasText: "Worktree setup failed" })).toBeVisible({ timeout: 10_000 });

    await failedRow.getByRole("button", { name: "Log" }).click();
    const log = page.getByTestId("worktree-setup-log");
    await expect(log).toBeVisible();
    await expect(log.getByTestId("worktree-setup-log-text")).toContainText("checking the toolchain", { timeout: 10_000 });
    await expect(log).toContainText("Failed, code 7");
    await page.keyboard.press("Escape");
    await expect(log).toHaveCount(0);
    await failedRow.getByRole("button", { name: /^Dismiss setup of setup-broken/ }).click();
    await expect(failedRow).toHaveCount(0);

    // ── An agent's worktree waits for setup and reports it ─────────────────
    await writeFile(
      setupFile,
      JSON.stringify({ link: ["node_modules"], setup: "sleep 1 && echo agent > setup.txt", waitForSetup: true }, null, 2),
    );
    const pane = await request("terminal.create", { cwd: repo, title: "agent" });
    const caller = { callerRole: "studio", callerClient: "claude-code", callerPaneId: pane.paneId };
    const created = await request("worktree.create", { ...caller, purpose: "Check setup" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.setup?.state, JSON.stringify(created.setup)).toBe("succeeded");
    expect(created.setupCommand).toBeNull();
    expect(readFileSync(join(created.path, "setup.txt"), "utf8").trim()).toBe("agent");
    expect(existsSync(join(created.path, ".env"))).toBe(true);

    const status = await request("worktree.setup", { ...caller, workspaceId: created.workspaceId });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    expect(status.setup.state).toBe("succeeded");
    expect(status.setup.commands[0]).toMatchObject({ kind: "repo", state: "succeeded", exitCode: 0 });
    expect(status.setup.linked).toEqual(["node_modules"]);
  } finally {
    await app?.close();
  }
});
