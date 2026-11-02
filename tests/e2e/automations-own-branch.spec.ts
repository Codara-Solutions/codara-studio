import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// An automation on its own branch, end to end with NO model: real git against a
// bare origin, a fake gh, and a shell step standing in for a worker.
//
//   1. A run edits a separate copy: the workspace folder stays as it was, the
//      work lands on a pushed branch, and the card links the draft pull request.
//   2. A workspace that is not a repository refuses to run, rather than editing
//      the folder it was told to stay out of.
//   3. The switch in the Loop panel saves, and is off by default.
//
// Optional: OWN_BRANCH_SHOTS_DIR=<dir> saves screenshots.

const run = promisify(execFile);
const WS_ID = "ws-own-branch-e2e";
const SHOTS = process.env.OWN_BRANCH_SHOTS_DIR;

async function clickAttached(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLElement).click());
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function widen(app: ElectronApplication): Promise<void> {
  if (!SHOTS) return;
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1680, 1000);
  });
}

interface Fixture {
  home: string;
  repo: string;
  origin: string;
  ghLog: string;
  env: Record<string, string>;
}

async function prepare(options: { gitRepo: boolean; jobs?: boolean }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-own-branch-e2e-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const repo = join(root, "sample-repo");
  const origin = join(root, "origin.git");
  await Promise.all([home, userHome, binDir, repo].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(userHome, ".zprofile"), `export PATH='${binDir}':$PATH\n`, "utf8");
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  await writeFile(join(repo, "README.md"), "# sample\n", "utf8");
  if (options.gitRepo) {
    const git = (...args: string[]) => run("git", args, { cwd: repo, env: gitEnv });
    await run("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "e2e@example.invalid");
    await git("config", "user.name", "Codara E2E");
    await git("remote", "add", "origin", origin);
    await git("add", "-A");
    await git("commit", "-q", "-m", "first");
    await git("push", "-q", "origin", "main");
    await git("remote", "set-head", "origin", "main");
  }
  const ghLog = join(root, "gh.log");
  const gh = join(binDir, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog}'
case "$1 $2" in
  "pr create") echo "https://github.com/acme/widgets/pull/77"; exit 0 ;;
  "--version "*) echo "gh version 2.102.1 (2026-10-20)"; exit 0 ;;
  "auth "*) echo "github.com: Logged in to github.com account e2e"; exit 0 ;;
esac
exit 1
`,
    "utf8",
  );
  await chmod(gh, 0o755);
  const shell = join(binDir, "bash");
  await writeFile(shell, `#!/bin/sh\nexport PATH='${binDir}':"$PATH"\nexec /bin/bash --noprofile --norc "$@"\n`, "utf8");
  await chmod(shell, 0o755);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: WS_ID, name: "sample-repo", cwd: repo, color: "#F0C419", workers: [] }],
      activeWorkspaceId: WS_ID,
    }),
    "utf8",
  );
  await writeFile(
    join(home, "spark-preferences.json"),
    JSON.stringify({ gitAutoFetchEnabled: false, watchPullRequests: false, notifyCiFailures: false }),
    "utf8",
  );
  const now = new Date().toISOString();
  await writeFile(
    join(home, "scheduler.json"),
    JSON.stringify({
      jobs:
        options.jobs === false
          ? []
          : [
              {
                id: "job-branch",
                name: "Tidy the readme",
                enabled: true,
                createdAt: now,
                updatedAt: now,
                ownBranch: { draftPr: true },
                trigger: { kind: "manual" },
                loop: { kind: "once", stop: {} },
                worker: { model: "claude-opus-5", effort: "medium" },
                prompt: { template: "" },
                state: { status: "idle", iteration: 0 },
                history: [],
                input: { workspaceId: WS_ID, workspaceName: "sample-repo", cwd: repo, planTitle: "x", initialUserNote: "", chatMode: "execute" },
                graph: {
                  version: 1,
                  nodes: [
                    {
                      id: "edit",
                      kind: "step",
                      label: "Edit",
                      action: { type: "command", command: 'echo "tidied" > made.txt; pwd > "$CODARA_E2E_PWD_FILE"; echo Tidied the readme.' },
                    },
                  ],
                  edges: [],
                  entryNodeIds: ["edit"],
                },
              },
            ],
    }),
    "utf8",
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return {
    home,
    repo,
    origin,
    ghLog,
    env: {
      ...env,
      HOME: userHome,
      USERPROFILE: userHome,
      SHELL: shell,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CODEX_HOME: join(userHome, ".codex"),
      GROK_HOME: join(userHome, ".grok"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Codara E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "Codara E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
      CODARA_E2E_PWD_FILE: join(root, "pwd.txt"),
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  };
}

async function open(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ["."], env: fixture.env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("sample-repo").first()).toBeVisible();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+A`);
  await widen(app);
  return { app, page };
}

async function savedJob(fixture: Fixture, match: (job: { name: string }) => boolean): Promise<Record<string, unknown> & { history: Array<{ branchResult?: { branch: string; prUrl?: string } }> }> {
  const raw = await readFile(join(fixture.home, "scheduler.json"), "utf8");
  return (JSON.parse(raw) as { jobs: Array<Record<string, unknown> & { name: string; history: Array<{ branchResult?: { branch: string; prUrl?: string } }> }> }).jobs.find(match)!;
}

test("a run works in a separate copy and ends in a draft pull request", async () => {
  test.setTimeout(120_000);
  const fixture = await prepare({ gitRepo: true });
  let app: ElectronApplication | null = null;
  try {
    const opened = await open(fixture);
    app = opened.app;
    const { page } = opened;
    await expect(page.locator(".automation-head")).toContainText("on its own branch, for a draft pull request");
    await clickAttached(page.getByRole("button", { name: "Run now", exact: true }));
    const card = page.getByTestId("automation-result");
    await expect(card.getByRole("button", { name: "Open draft pull request" })).toBeVisible({ timeout: 30_000 });
    await shot(page, "own-branch-draft-pr");

    // The workspace folder never saw it.
    expect(existsSync(join(fixture.repo, "made.txt"))).toBe(false);
    const status = await run("git", ["status", "--porcelain"], { cwd: fixture.repo, env: fixture.env });
    expect(status.stdout.trim()).toBe("");
    const ranIn = (await readFile(fixture.env.CODARA_E2E_PWD_FILE, "utf8")).trim();
    expect(ranIn).not.toBe(fixture.repo);
    expect(ranIn).toContain(join("worktrees"));

    // The work is on the pushed branch, and the copy is gone.
    const job = await savedJob(fixture, (j) => j.name === "Tidy the readme");
    const result = job.history[job.history.length - 1].branchResult!;
    expect(result.prUrl).toBe("https://github.com/acme/widgets/pull/77");
    expect(result.branch).toMatch(/^codara-automation\/tidy-the-readme-/);
    const pushed = await run("git", ["--git-dir", fixture.origin, "show", `${result.branch}:made.txt`], { env: fixture.env });
    expect(pushed.stdout.trim()).toBe("tidied");
    expect(existsSync(ranIn)).toBe(false);
    const gh = await readFile(fixture.ghLog, "utf8");
    expect(gh).toContain("pr create --draft --base main");
    expect(gh).toContain("Tidied the readme.");
  } finally {
    await app?.close();
  }
});

test("a workspace that is not a repository refuses instead of editing the folder", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare({ gitRepo: false });
  let app: ElectronApplication | null = null;
  try {
    const opened = await open(fixture);
    app = opened.app;
    const { page } = opened;
    await clickAttached(page.getByRole("button", { name: "Run now", exact: true }));
    const row = page.locator('[data-testid="history-skip-row"][data-skip-reason="ownBranch"]');
    await expect(row).toContainText("not a git repository", { timeout: 30_000 });
    expect(existsSync(join(fixture.repo, "made.txt"))).toBe(false);
    expect(await readdir(fixture.repo)).toEqual(["README.md"]);
  } finally {
    await app?.close();
  }
});

test("the switch is off by default and saves from the Loop panel", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare({ gitRepo: true, jobs: false });
  let app: ElectronApplication | null = null;
  try {
    const opened = await open(fixture);
    app = opened.app;
    const { page } = opened;
    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await clickAttached(page.getByRole("button", { name: /Agent decides/ }));
    await page.getByPlaceholder("What is this automation for?").fill("Stays home");
    await clickAttached(page.getByRole("button", { name: "Create automation", exact: true }));
    await expect(page.locator(".automation-row", { hasText: "Stays home" })).toBeVisible();
    const stays = await savedJob(fixture, (j) => j.name === "Stays home");
    expect(stays.ownBranch).toBeUndefined();

    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await clickAttached(page.getByRole("button", { name: /Agent decides/ }));
    await page.getByPlaceholder("What is this automation for?").fill("Goes away");
    await clickAttached(page.getByRole("button", { name: /^Loop/ }));
    await expect(page.getByText("It edits this workspace's folder directly.")).toBeVisible();
    await clickAttached(page.getByText("On its own branch, in a separate copy"));
    await expect(page.getByText("Open a draft pull request when a run goes well")).toBeVisible();
    await shot(page, "own-branch-switch");
    await clickAttached(page.getByRole("button", { name: "Create automation", exact: true }));
    await expect(page.locator(".automation-row", { hasText: "Goes away" })).toBeVisible();
    const goes = await savedJob(fixture, (j) => j.name === "Goes away");
    expect(goes.ownBranch).toEqual({ draftPr: true });
  } finally {
    await app?.close();
  }
});
