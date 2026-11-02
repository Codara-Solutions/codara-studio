import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The warning that two running lanes would clash if both merged, on real git
// worktrees: both lanes say it, a lane whose work merges cleanly does not, and
// it clears once the clash is gone. SOURCE_LANES_SHOTS=<dir> saves the picture.

async function prepare() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-source-collisions-")));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const repo = join(root, "projects", "widgets");
  const trees = join(root, "trees");
  await Promise.all([home, userHome, repo, trees].map((dir) => mkdir(dir, { recursive: true })));
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n");
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_RENDERER_URL;
  const env: Record<string, string> = {
    ...base,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: userHome,
    USERPROFILE: userHome,
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    CODEX_HOME: join(userHome, ".codex"),
    GROK_HOME: join(userHome, ".grok"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
    CODARA_CHROME_LINK: "0",
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  await writeFile(join(repo, "session.ts"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "other.ts"), "alpha\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
  const addTree = async (name: string, file: string, text: string) => {
    const dir = join(trees, name);
    git(repo, "worktree", "add", "-q", "-b", `feat/${name}`, dir);
    await writeFile(join(dir, file), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", name);
    return dir;
  };
  const login = await addTree("login", "session.ts", "one\nlogin\nthree\n");
  const charts = await addTree("charts", "session.ts", "one\ncharts\nthree\n");
  const docs = await addTree("docs", "other.ts", "alpha\nbeta\n");
  git(repo, "update-ref", "refs/remotes/origin/main", "main");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const copy = (id: string, cwd: string, branch: string) => ({
    id,
    name: `widgets · ${branch}`,
    cwd,
    color: "#E8B45A",
    workers: [],
    copyBranch: { repoCwd: repo, branch, baseBranch: "main", city: id, mode: "fork", createdAt },
  });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-app",
      workspaces: [
        { id: "ws-app", name: "widgets", cwd: repo, color: "#E8B45A", workers: [] },
        copy("wt-login", login, "feat/login"),
        copy("wt-charts", charts, "feat/charts"),
        copy("wt-docs", docs, "feat/docs"),
      ],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false, theme: "dracula" }));
  return { root, charts, env, git };
}

const lane = (page: Page, branch: string) => page.locator(`[data-testid="source-lane"][data-lane-branch="${branch}"]`);

test("two lanes that would clash both say so, and the warning clears with the clash", async () => {
  test.setTimeout(120_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("source-lanes")).toBeVisible({ timeout: 45_000 });

    const warning = (branch: string) => lane(page, branch).getByTestId("source-lane-collision");
    await expect(warning("feat/login")).toHaveText("session.ts clashes with feat/charts if both merge.", { timeout: 30_000 });
    await expect(warning("feat/charts")).toHaveText("session.ts clashes with feat/login if both merge.");
    await expect(lane(page, "feat/docs")).toContainText("+1", { timeout: 15_000 });
    await expect(warning("feat/docs")).toHaveCount(0);
    await expect(warning("main")).toHaveCount(0);

    const dir = process.env.SOURCE_LANES_SHOTS;
    if (dir) {
      for (const theme of ["dracula", "codara-daylight"] as const) {
        await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        await page.waitForTimeout(400);
        await page.getByTestId("source-lanes").screenshot({ path: join(dir, `collision-${theme}.png`) });
      }
      await page.evaluate(() => window.spark.preferences.set("theme", "dracula"));
    }

    await writeFile(join(fixture.charts, "session.ts"), "one\ntwo\nthree\n");
    fixture.git(fixture.charts, "add", "-A");
    fixture.git(fixture.charts, "commit", "-q", "-m", "back out");
    await writeFile(join(fixture.charts, "extra.ts"), "more\n");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(warning("feat/login")).toHaveCount(0, { timeout: 45_000 });
    await expect(warning("feat/charts")).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
