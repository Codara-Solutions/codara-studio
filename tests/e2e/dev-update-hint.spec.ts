import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A dev build says in the status bar when the folder it runs from is behind
// its upstream, and when it was updated after the app started; it hides once
// there is nothing to say. Pointed at a generated checkout
// (CODARA_E2E_DEV_UPDATE_DIR) instead of the app's own folder.

test("the status bar says when a dev build is behind its upstream", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-dev-update-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  await Promise.all([mkdir(home), mkdir(userHome)]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(SPARK_|CODARA_|CLAUDE_CONFIG_DIR$|CODEX_HOME$|GROK_HOME$|ZDOTDIR$)/.test(key),
    ),
  );
  const gitEnv = { ...clean, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const studio = join(root, "studio");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", seed], { env: gitEnv });
  const commit = async (subject: string) => {
    await writeFile(join(seed, "notes.txt"), `${subject}\n`);
    git(seed, "add", "notes.txt");
    git(seed, "commit", "-q", "-m", subject);
  };
  await commit("first");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, studio], { env: gitEnv });
  const started = git(studio, "rev-parse", "HEAD");
  for (const subject of ["fix(rail): Clean up takes every merged worktree", "fix(toast): one toast per pass", "feat(status): dev update line"]) {
    await commit(subject);
  }
  git(seed, "push", "-q", "origin", "main");
  // Fetched already, as the background fetch would have.
  git(studio, "fetch", "-q", "origin");

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-studio",
      workspaces: [{ id: "ws-studio", name: "Studio", cwd: studio, color: "#42D6C7", workers: [] }],
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
      CODARA_E2E_DEV_UPDATE_DIR: studio,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const hint = page.getByTestId("dev-update-hint");
    const refocus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(hint).toHaveText("Studio is 3 changes behind main · restart to update", { timeout: 30_000 });
    await expect(hint).toHaveAttribute("title", new RegExp(`git -C ${studio.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} pull --ff-only`));
    await expect(hint).toHaveAttribute("title", /• feat\(status\): dev update line/);
    await hint.locator("..").screenshot({ path: testInfo.outputPath("status-bar-behind.png") });

    // Pulled while the app runs: the code on disk is not the code running.
    git(studio, "pull", "-q", "--ff-only");
    await expect.poll(async () => (await refocus(), hint.textContent()), { timeout: 15_000 }).toBe("Restart to load the update");
    await hint.locator("..").screenshot({ path: testInfo.outputPath("status-bar-restart.png") });

    // Back where it started, with nothing upstream it lacks: nothing to say.
    git(studio, "reset", "-q", "--hard", started);
    git(studio, "update-ref", "refs/remotes/origin/main", started);
    await expect.poll(async () => (await refocus(), hint.count()), { timeout: 15_000 }).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
