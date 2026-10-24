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
// the setup command run (the dialog showed it, so creating there approves
// it); a failing command shows in the setup tray with its log; and an
// agent's worktree never runs a command nobody approved: it waits in the
// tray until the user allows it, then reports it; and a worktree made from
// the jump palette, which shows no commands, asks first and opens the file's
// terminals as plain shells.

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
    await expect(summary).toContainText("Opens 1 terminal: setup-shell");
    // Creating approves the terminal's command too, so the dialog shows it.
    await expect(summary).toContainText("Terminal setup-shell runs echo opened > terminal.txt");
    await expect(summary.getByRole("checkbox", { name: /Run setup commands and open its terminals/ })).toBeChecked();
    await expect(summary.getByTestId("worktree-setup-approves")).toBeVisible();

    // The setup file dialog opens over it, and Escape closes only that one.
    await summary.getByRole("button", { name: "Edit setup…" }).click();
    const fileDialog = page.getByTestId("worktree-setup-file-dialog");
    await expect(fileDialog).toBeVisible();
    await expect(fileDialog.getByLabel("Files to copy from this checkout")).toHaveValue(".env", { timeout: 15_000 });
    await expect(fileDialog.getByRole("button", { name: "node_modules", pressed: true })).toBeVisible();
    // A link the setup command installs into is refused, and the editor
    // says so: through it the install would change the main checkout.
    await expect(fileDialog.getByTestId("worktree-setup-install-conflict")).toHaveCount(0);
    await fileDialog.getByLabel("Setup command", { exact: true }).fill("npm ci");
    await expect(fileDialog.getByTestId("worktree-setup-install-conflict")).toContainText(
      "node_modules is not linked because the setup command installs into it",
    );
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
    // Creating from the dialog approved the commands it showed, the
    // terminal's too, in Codara's home and never in the repository.
    const approvals = JSON.parse(readFileSync(join(home, "worktree-setup-approvals.json"), "utf8"));
    expect(approvals.repositories[join(repo, ".git")]).toMatchObject({
      name: "repo",
      commands: [{ command: 'echo "root=$CODARA_ROOT_PATH" > setup.txt\nterminal setup-shell: echo opened > terminal.txt' }],
    });
    expect(git(repo, ["status", "--porcelain"], gitEnv)).toBe("");
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

    // ── An agent's worktree never runs a command nobody approved ──────────
    await writeFile(
      setupFile,
      JSON.stringify({ link: ["node_modules"], setup: "sleep 1 && echo agent > setup.txt", waitForSetup: true }, null, 2),
    );
    const pane = await request("terminal.create", { cwd: repo, title: "agent" });
    const caller = { callerRole: "studio", callerClient: "claude-code", callerPaneId: pane.paneId };
    const created = await request("worktree.create", { ...caller, purpose: "Check setup" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.setup?.state, JSON.stringify(created.setup)).toBe("awaiting-approval");
    expect(created.setupCommand).toBeNull();
    expect(created.next).toContain("do not run it, or the setup file's terminal commands, yourself");
    expect(created.setup.hint).toContain("Do not run that command");
    // Copies and links are done; the command is not.
    expect(existsSync(join(created.path, ".env"))).toBe(true);
    expect(lstatSync(join(created.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(created.path, "setup.txt"))).toBe(false);

    // The tray shows the exact command and asks; the agent waits meanwhile.
    const approval = tray.getByTestId("worktree-setup-approval");
    await expect(approval).toBeVisible({ timeout: 15_000 });
    await expect(approval.getByLabel("Setup command")).toHaveText("sleep 1 && echo agent > setup.txt");
    const waited = request("worktree.setup", { ...caller, workspaceId: created.workspaceId, wait: true, timeoutSeconds: 60 });
    await page.waitForTimeout(500);
    expect(existsSync(join(created.path, "setup.txt")), "nothing runs until the user says so").toBe(false);
    await approval.getByRole("button", { name: "Always allow this command for repo" }).click();
    await expect(approval).toHaveCount(0, { timeout: 15_000 });

    const status = await waited;
    expect(status.ok, JSON.stringify(status)).toBe(true);
    expect(status.setup.state).toBe("succeeded");
    expect(status.setup.commands[0]).toMatchObject({ kind: "repo", state: "succeeded", exitCode: 0 });
    expect(status.setup.linked).toEqual(["node_modules"]);
    expect(status.setup.linkedNote).toContain("main checkout");
    expect(readFileSync(join(created.path, "setup.txt"), "utf8").trim()).toBe("agent");

    // Allowed for the repository, the next agent worktree runs it at once.
    const otherPane = await request("terminal.create", { cwd: repo, title: "agent 2" });
    const again = await request("worktree.create", {
      callerRole: "studio",
      callerClient: "claude-code",
      callerPaneId: otherPane.paneId,
      purpose: "Check setup again",
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.created).toBe(true);
    expect(again.setup?.state, JSON.stringify(again.setup)).toBe("succeeded");
    expect(readFileSync(join(again.path, "setup.txt"), "utf8").trim()).toBe("agent");

    // ── The jump palette shows no commands, so it asks first ───────────────
    await writeFile(
      setupFile,
      JSON.stringify(
        {
          setup: "echo palette > palette-setup.txt",
          terminals: [{ name: "palette-shell", command: "echo palette > palette-terminal.txt" }],
        },
        null,
        2,
      ),
    );
    await page.locator('[data-workspace-id="ws-repo"]').click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+Shift+J");
    const palette = page.getByTestId("jump-palette");
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("palette check");
    const createRow = palette.locator('[data-jump-kind="create"]');
    await expect(createRow).toContainText("Create worktree palette-check");
    await createRow.click();
    const paletteApproval = tray.getByTestId("worktree-setup-approval");
    await expect(paletteApproval).toBeVisible({ timeout: 30_000 });
    // The prompt lists the terminal's command with the setup command.
    await expect(paletteApproval.getByLabel("Setup command")).toHaveText("echo palette > palette-setup.txt");
    await expect(paletteApproval.getByLabel("Command of terminal palette-shell")).toHaveText(
      "echo palette > palette-terminal.txt",
    );
    await expect(paletteApproval).toContainText("Its terminals then open as plain shells, without their commands.");
    const paletteWorktree = managedWorktree("palette-check");
    const paletteTabOpen = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]")).some((el) =>
          (el.textContent ?? "").includes("palette-shell"),
        ),
      );
    expect(await paletteTabOpen(), "no terminal before the user decides").toBe(false);
    expect(existsSync(join(paletteWorktree, "palette-setup.txt"))).toBe(false);
    await paletteApproval.getByRole("button", { name: "Run setup", exact: true }).click();
    await expect.poll(() => existsSync(join(paletteWorktree, "palette-setup.txt")), { timeout: 30_000 }).toBe(true);
    await expect.poll(paletteTabOpen, { timeout: 15_000 }).toBe(true);
    // A plain shell: its command never ran, though the first worktree's
    // terminal ran its own within moments.
    await page.waitForTimeout(5_000);
    expect(existsSync(join(paletteWorktree, "palette-terminal.txt"))).toBe(false);
  } finally {
    await app?.close();
  }
});
