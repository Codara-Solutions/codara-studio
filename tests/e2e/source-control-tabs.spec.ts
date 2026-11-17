import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Source Control's tabs (DESIGN.md, "Source Control"): Changes is the working
// view, and the GitHub issue list, the pull request journey and the stashes
// each sit on their own tab, with nothing lost on the way. Runs against a
// real repository and a scripted `gh` with two open issues and no pull request.
// SOURCE_CONTROL_SHOTS=<dir> also saves the panel in a dark and a light theme.

interface Fixture {
  root: string;
  repo: string;
  env: Record<string, string>;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

async function prepare(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-source-tabs-")));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const repo = join(root, "projects", "widgets");
  await Promise.all([home, userHome, binDir, repo].map((dir) => mkdir(dir, { recursive: true })));
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n");
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_RENDERER_URL;
  const gitEnv = { ...base, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };

  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await mkdir(join(repo, "src", "panel"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# widgets\n");
  await writeFile(join(repo, "src", "panel", "list.ts"), "export const list = 1;\n");
  await writeFile(join(repo, "src", "panel", "row.ts"), "export const row = 1;\n");
  await writeFile(join(repo, "src", "theme.ts"), "export const theme = 1;\n");
  git(repo, ["add", "-A"], gitEnv);
  git(repo, ["commit", "-q", "-m", "feat: first widgets"], gitEnv);
  await writeFile(join(repo, "src", "theme.ts"), "export const theme = 2;\n");
  git(repo, ["commit", "-q", "-am", "fix(theme): calmer colours"], gitEnv);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"], gitEnv);
  git(repo, ["update-ref", "refs/remotes/origin/main", "main"], gitEnv);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], gitEnv);
  git(repo, ["config", "branch.main.remote", "origin"], gitEnv);
  git(repo, ["config", "branch.main.merge", "refs/heads/main"], gitEnv);

  const issues = JSON.stringify([
    { number: 7, title: "Rows jump when a file is staged", url: "https://github.com/acme/widgets/issues/7", labels: [], updatedAt: "2026-11-15T10:00:00Z" },
    { number: 5, title: "Explain what U means in the change list", url: "https://github.com/acme/widgets/issues/5", labels: [], updatedAt: "2026-11-12T10:00:00Z" },
  ]);
  await writeFile(join(root, "issues.json"), issues);
  await writeExecutable(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.102.1 (2026-10-20)"; exit 0 ;;
  auth) echo "github.com: Logged in to github.com account e2e"; exit 0 ;;
  repo) printf '%s' '{"nameWithOwner":"acme/widgets","url":"https://github.com/acme/widgets","defaultBranchRef":{"name":"main"}}'; exit 0 ;;
  issue) [ "$2" = "list" ] && { cat '${join(root, "issues.json")}'; exit 0; }; echo "not found" >&2; exit 1 ;;
  pr) [ "$2" = "list" ] && { printf '[]'; exit 0; }; echo "no pull requests found" >&2; exit 1 ;;
  api) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; exit 1 ;;
  *) echo "unknown command: $*" >&2; exit 1 ;;
esac
`,
  );
  const shell = join(binDir, "bash");
  // Codara reads PATH from a login shell; the fake gh must win there too.
  await writeExecutable(shell, `#!/bin/sh\nexport PATH='${binDir}':"$PATH"\nexec /bin/bash --noprofile --norc "$@"\n`);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-widgets",
      workspaces: [{ id: "ws-widgets", name: "widgets", cwd: repo, color: "#E8B45A", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false, theme: "dracula" }));

  return {
    root,
    repo,
    env: {
      ...gitEnv,
      HOME: userHome,
      USERPROFILE: userHome,
      SHELL: shell,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
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
    },
  };
}

const tab = (page: Page, name: string) =>
  page.getByRole("tablist", { name: "Source Control views" }).getByRole("tab", { name: new RegExp(`^${name}(,|$)`) });

async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.SOURCE_CONTROL_SHOTS;
  if (!dir) return;
  const panel = page.getByRole("tablist", { name: "Source Control views" }).locator("..");
  for (const theme of ["dracula", "codara-daylight"] as const) {
    await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await panel.screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => window.spark.preferences.set("theme", "dracula"));
}

test("Source Control keeps issues, the pull request steps and stashes on their own tabs", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script");
  test.setTimeout(180_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    await writeFile(join(fixture.repo, "README.md"), "# widgets\n\nNotes.\n");
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const tabs = page.getByRole("tablist", { name: "Source Control views" });
    await expect(tabs).toBeVisible({ timeout: 45_000 });

    await test.step("Changes is the first tab and holds the files and the commit box", async () => {
      await expect(tab(page, "Changes")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Changes")).toHaveAccessibleName("Changes, 1", { timeout: 15_000 });
      await expect(page.getByTitle(/README\.md/).first()).toBeVisible();
      await expect(page.getByTestId("commit-box")).toBeVisible();
      await expect(page.getByTestId("git-sync-note")).toHaveText(/in sync/);
      await shots(page, "changes");
      await expect(page.getByRole("list", { name: "Review journey" })).toBeHidden();
    });

    await test.step("Issues lists the repository's open issues, counted on its tab", async () => {
      await expect(tab(page, "Issues")).toHaveAccessibleName("Issues, 2", { timeout: 30_000 });
      await tab(page, "Issues").click();
      await expect(tab(page, "Issues")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("Rows jump when a file is staged")).toBeVisible();
      await expect(page.getByText("Explain what U means in the change list")).toBeVisible();
      await expect(page.getByTestId("commit-box")).toBeHidden();
      await shots(page, "issues");
    });

    await test.step("Pull request holds the four steps to main", async () => {
      await tab(page, "Pull request").click();
      const journey = page.getByRole("list", { name: "Review journey" });
      await expect(journey).toBeVisible({ timeout: 30_000 });
      await expect(journey.getByRole("listitem")).toHaveCount(4);
      await expect(page.getByText("Rows jump when a file is staged")).toBeHidden();
      await shots(page, "pull-request");
    });

    await test.step("Stashes saves and lists a stash", async () => {
      await tab(page, "Stashes").click();
      await expect(page.getByText(/^No stashes\./)).toBeVisible();
      await page.getByTitle("Stash all changes (including untracked)").click();
      await page.getByPlaceholder("Stash message (optional), Enter to stash").fill("parked notes");
      await page.getByPlaceholder("Stash message (optional), Enter to stash").press("Enter");
      await expect(page.getByText("parked notes")).toBeVisible({ timeout: 15_000 });
      await expect(tab(page, "Stashes")).toHaveAccessibleName("Stashes, 1");
      expect(git(fixture.repo, ["status", "--porcelain"], fixture.env)).toBe("");
    });

    await test.step("arrow keys move between tabs and Changes comes back as it was", async () => {
      await tab(page, "Stashes").focus();
      await page.keyboard.press("Home");
      await expect(tab(page, "Changes")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Changes")).toBeFocused();
      await expect(page.getByText("No changes, working tree clean.")).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("ArrowLeft");
      await expect(tab(page, "Stashes")).toHaveAttribute("aria-selected", "true");
    });

    await test.step("a chosen amend survives a trip to another tab", async () => {
      await tab(page, "Changes").click();
      const box = page.getByTestId("commit-box");
      await box.getByRole("button", { name: "More commit options" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Amend last commit" }).click();
      await expect(box.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
      await tab(page, "Issues").click();
      await tab(page, "Changes").click();
      await expect(box.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
    });

    await test.step("folding the active lane moves the commit box to the top, amend and all", async () => {
      const ownLane = page.locator('[data-testid="source-lane"][data-own="true"]');
      await ownLane.getByRole("button", { expanded: true }).first().click();
      const box = page.getByTestId("commit-box");
      await expect(box).toBeVisible();
      await expect(ownLane.getByTestId("commit-box")).toHaveCount(0);
      await expect(box.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
      await ownLane.getByRole("button", { expanded: false }).first().click();
      await expect(ownLane.getByTestId("commit-box")).toBeVisible();
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
