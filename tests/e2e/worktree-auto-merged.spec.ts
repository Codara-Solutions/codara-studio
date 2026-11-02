import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Merged worktrees leave the rail on their own: one with nothing left in it
// goes, one with an untracked file or an open tab stays in the merged group,
// and goes once that is gone. The setting turns all of it off. Real git, a bare
// remote and sample names; the quiet window and the wait after launch are
// shortened through the e2e overrides, everything else is the shipped path.

const SHOTS = process.env.WORKTREE_AUTO_MERGED_SHOTS;
// The hook re-reads on window focus at most this often.
const FOCUS_GAP_MS = 21_000;

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

interface World {
  root: string;
  home: string;
  userHome: string;
  repo: string;
  trees: string;
  gitEnv: NodeJS.ProcessEnv;
}

async function makeWorld(): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-worktree-auto-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const repo = join(root, "acme-web");
  const origin = join(root, "origin.git");
  const trees = join(root, "trees");
  await Promise.all([mkdir(home), mkdir(userHome), mkdir(repo), mkdir(trees), mkdir(join(root, "gh"))]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(SPARK_|CODARA_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|GROK_HOME$|ZDOTDIR$)/.test(key),
    ),
  );
  const gitEnv = { ...clean, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: join(root, "gh") };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# sample\n");
  git(repo, ["add", "README.md"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);
  git(repo, ["remote", "add", "origin", origin], gitEnv);
  git(repo, ["push", "-q", "-u", "origin", "main"], gitEnv);
  git(repo, ["remote", "set-head", "origin", "main"], gitEnv);
  return { root, home, userHome, repo, trees, gitEnv };
}

// A worktree whose one commit is on the remote's main.
async function mergedWorktree(world: World, name: string, branch: string): Promise<string> {
  const dir = join(world.trees, name);
  git(world.repo, ["worktree", "add", "-q", "-b", branch, dir], world.gitEnv);
  await writeFile(join(dir, `${name}.txt`), `${name}\n`);
  git(dir, ["add", `${name}.txt`], world.gitEnv);
  git(dir, ["commit", "-q", "-m", `${name} work`], world.gitEnv);
  git(world.repo, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch], world.gitEnv);
  git(world.repo, ["push", "-q", "origin", "main"], world.gitEnv);
  return dir;
}

function copyWorkspace(world: World, id: string, name: string, cwd: string, branch: string, createdAt: string) {
  return {
    id,
    name,
    cwd,
    color: "#42D6C7",
    workers: [],
    copyBranch: { repoCwd: world.repo, branch, baseBranch: "main", city: id, mode: "fork", createdAt, createdBy: { kind: "user" } },
  };
}

async function launch(world: World): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["."],
    env: {
      ...world.gitEnv,
      HOME: world.userHome,
      CODARA_HOME_DIR: world.home,
      SPARK_HOME_DIR: world.home,
      SPARK_USER_DATA_DIR: world.home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      SPARK_E2E_BACKGROUND: "1",
      CODARA_CHROME_LINK: "0",
      CODARA_E2E_WORKTREE_AUTO_QUIET_MS: "0",
      CODARA_E2E_WORKTREE_AUTO_UPTIME_MS: "0",
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

const reread = async (page: Page) => {
  await page.waitForTimeout(FOCUS_GAP_MS);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
};

const saveLayout = (page: Page, workspaceId: string, tabs: unknown[]) =>
  page.evaluate(
    ([id, saved]) => {
      window.localStorage.setItem(`spark.tabs:${id}`, JSON.stringify({ v: 7, activeId: null, tabs: saved }));
    },
    [workspaceId, tabs] as const,
  );

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const [theme, id] of [
    ["light", "codara-daylight"],
    ["dark", "codara-classic"],
  ] as const) {
    await page.evaluate(
      ([mode, themeId]) => {
        const root = document.documentElement;
        root.classList.remove("light", "dark", "theme-codara-daylight", "theme-codara-classic");
        root.classList.add(mode, `theme-${themeId}`);
        root.dataset.theme = themeId;
        root.dataset.themeMode = mode;
        root.style.setProperty("color-scheme", mode);
      },
      [theme, id] as const,
    );
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
}

test("a merged worktree with nothing left in it leaves on its own; what holds one back keeps it", async () => {
  test.setTimeout(240_000);
  const world = await makeWorld();
  const before = new Date(Date.now() - 60_000).toISOString();
  const gone = await mergedWorktree(world, "invoice-totals", "fix/invoice-totals");
  const notes = await mergedWorktree(world, "search-filters", "feat/search-filters");
  await writeFile(join(notes, "todo.txt"), "not committed\n");
  const tabbed = await mergedWorktree(world, "checkout-copy", "fix/checkout-copy");
  const cold = join(world.trees, "pricing-table");
  git(world.repo, ["worktree", "add", "-q", "-b", "feat/pricing-table", cold], world.gitEnv);
  await writeFile(join(cold, "pricing.txt"), "sample\n");
  git(cold, ["add", "pricing.txt"], world.gitEnv);
  git(cold, ["commit", "-q", "-m", "pricing work"], world.gitEnv);
  await writeFile(
    join(world.home, "spark-state.json"),
    JSON.stringify({
      // Started on the tabbed one, so it is held while the rest are judged.
      activeWorkspaceId: "ws-tabbed",
      workspaces: [
        { id: "ws-repo", name: "acme-web", cwd: world.repo, color: "#42D6C7", workers: [] },
        copyWorkspace(world, "ws-gone", "Invoice totals", gone, "fix/invoice-totals", before),
        copyWorkspace(world, "ws-notes", "Search filters", notes, "feat/search-filters", before),
        copyWorkspace(world, "ws-tabbed", "Checkout copy", tabbed, "fix/checkout-copy", before),
        copyWorkspace(world, "ws-cold", "Pricing table", cold, "feat/pricing-table", before),
      ],
    }),
  );
  const { app, page } = await launch(world);
  try {
    const row = (id: string) => page.locator(`[data-workspace-id="${id}"]`).first();
    await expect(page.getByRole("button", { name: /^\+ New terminal/ }).first()).toBeVisible({ timeout: 30_000 });

    // Nothing left in it: gone, with its branch, and a toast that says why.
    await expect
      .poll(() => existsSync(gone), { timeout: 60_000, message: "the merged worktree leaves on its own" })
      .toBe(false);
    await expect(page.getByText("Its work is merged and nothing was left in it.")).toBeVisible({ timeout: 15_000 });
    await shoot(page, "merged-left-on-its-own");
    expect(branchExists(world.repo, "fix/invoice-totals", world.gitEnv)).toBe(false);
    expect(git(world.repo, ["for-each-ref", "--format=%(refname)", "refs/codara/removed-worktrees"], world.gitEnv)).toContain("ws-gone");
    await expect(page.locator('[data-workspace-id="ws-gone"]')).toHaveCount(0);

    // An untracked file holds its row in the merged group, one click away.
    expect(existsSync(join(notes, "todo.txt"))).toBe(true);

    // Open a terminal in the workspace on screen, then leave it: its tab holds it.
    await page.getByRole("button", { name: /^\+ New terminal/ }).first().click();
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 30_000 });
    await row("ws-repo").click();
    await expect(page.getByRole("button", { name: /^\+ New terminal/ }).first()).toBeVisible({ timeout: 30_000 });

    // A workspace not opened this session whose saved layout holds an editor
    // tab is held too, though nothing in main can see that. It merges only now,
    // so the layout is in place before it is first judged.
    await saveLayout(page, "ws-cold", [{ id: "t1", kind: "editor", title: "notes.md" }]);
    git(world.repo, ["merge", "-q", "--no-ff", "-m", "merge feat/pricing-table", "feat/pricing-table"], world.gitEnv);
    git(world.repo, ["push", "-q", "origin", "main"], world.gitEnv);

    await reread(page);
    await page.waitForTimeout(3_000);
    expect(existsSync(tabbed), "a tab keeps it").toBe(true);
    expect(existsSync(notes), "an untracked file keeps it").toBe(true);
    expect(existsSync(cold), "a saved editor tab keeps it").toBe(true);
    const fold = page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-merged-fold");
    await expect(fold).toContainText("3 merged", { timeout: 15_000 });
    await fold.getByTestId("workspace-merged-toggle").click();
    await expect(row("ws-notes").getByTestId("workspace-merged")).toBeVisible();
    await expect(row("ws-tabbed").getByTestId("workspace-merged")).toBeVisible();
    await shoot(page, "merged-held-back");

    // Clean up is one click away for what is held back by a file it would not
    // force: it refuses and says why, and the file stays.
    await row("ws-notes").hover();
    await row("ws-notes").getByTestId("workspace-clean-up").click();
    await expect(page.getByText(/uncommitted work/).first()).toBeVisible({ timeout: 15_000 });
    expect(existsSync(join(notes, "todo.txt"))).toBe(true);

    // Close its last tab: with nothing holding it, it goes on its own.
    await row("ws-tabbed").click();
    await page.locator(".xterm").first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+W" : "Control+W");
    await expect(page.getByRole("button", { name: /^\+ New terminal/ }).first()).toBeVisible({ timeout: 15_000 });
    await row("ws-repo").click();
    // A saved layout of nothing but a plain shell holds nothing either.
    await saveLayout(page, "ws-cold", [{ id: "t2", kind: "terminal", title: "shell", root: { kind: "leaf", paneId: "pane-sample" } }]);
    await reread(page);
    await expect.poll(() => existsSync(tabbed), { timeout: 30_000, message: "it goes once its tab is closed" }).toBe(false);
    await expect.poll(() => existsSync(cold), { timeout: 30_000, message: "a plain shell does not hold it" }).toBe(false);
    await expect(page.locator('[data-workspace-id="ws-tabbed"]')).toHaveCount(0);
    expect(existsSync(join(notes, "todo.txt"))).toBe(true);
  } finally {
    await app.close();
    await rm(world.root, { recursive: true, force: true });
  }
});

test("with the setting off a merged worktree stays in the merged group, and turning it on lets it go", async () => {
  test.setTimeout(180_000);
  const world = await makeWorld();
  const before = new Date(Date.now() - 60_000).toISOString();
  const dir = await mergedWorktree(world, "invoice-totals", "fix/invoice-totals");
  await writeFile(join(world.home, "spark-preferences.json"), JSON.stringify({ worktreeAutoRemoveMerged: false }));
  await writeFile(
    join(world.home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [
        { id: "ws-repo", name: "acme-web", cwd: world.repo, color: "#42D6C7", workers: [] },
        copyWorkspace(world, "ws-off", "Invoice totals", dir, "fix/invoice-totals", before),
      ],
    }),
  );
  const { app, page } = await launch(world);
  try {
    const fold = page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-merged-fold");
    await expect(fold).toContainText("1 merged", { timeout: 30_000 });
    await reread(page);
    await page.waitForTimeout(3_000);
    expect(existsSync(dir)).toBe(true);
    expect(branchExists(world.repo, "fix/invoice-totals", world.gitEnv)).toBe(true);

    const prefs = await page.evaluate(() => window.spark.preferences.load());
    expect(prefs.worktreeAutoRemoveMerged).toBe(false);
    await page.evaluate(() => window.spark.preferences.set("worktreeAutoRemoveMerged", true));
    await reread(page);
    await expect.poll(() => existsSync(dir), { timeout: 30_000 }).toBe(false);
    expect(branchExists(world.repo, "fix/invoice-totals", world.gitEnv)).toBe(false);
  } finally {
    await app.close();
    await rm(world.root, { recursive: true, force: true });
  }
});
