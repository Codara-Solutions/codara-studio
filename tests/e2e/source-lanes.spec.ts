import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Source Control's agent lanes (DESIGN.md, "Source Control"), against real git
// worktrees of one repository and a scripted `gh` with one failing and one
// ready pull request. Every checkout is a lane with what it changed, the
// active one is last and holds today's detail, a lane's row unfolds it without
// switching workspace, its next step is one click, and the commit box stays
// docked under the list. The journey no longer ticks failed checks.
// SOURCE_LANES_SHOTS=<dir> also saves the panel in dracula and daylight.

interface Fixture {
  root: string;
  env: Record<string, string>;
  repo: string;
  idleTree: string;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

function pullRequest(number: number, title: string, branch: string, head: string, conclusion: "FAILURE" | "SUCCESS"): string {
  return JSON.stringify({
    number,
    title,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: branch,
    isCrossRepository: false,
    updatedAt: "2026-10-01T10:00:00Z",
    reviewDecision: "APPROVED",
    mergeStateStatus: conclusion === "SUCCESS" ? "CLEAN" : "BLOCKED",
    mergeable: "MERGEABLE",
    headRefOid: head,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion, detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${number}` },
    ],
  });
}

async function prepare(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-source-lanes-")));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const ghDir = join(root, "gh");
  const repo = join(root, "projects", "widgets");
  const trees = join(root, "trees");
  await Promise.all([home, userHome, binDir, ghDir, repo, trees].map((dir) => mkdir(dir, { recursive: true })));
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n");
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_RENDERER_URL;
  const gitEnv = { ...base, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };

  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, "README.md"), "# widgets\n");
  git(repo, ["add", "-A"], gitEnv);
  git(repo, ["commit", "-q", "-m", "initial"], gitEnv);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"], gitEnv);
  const addTree = async (name: string, branch: string, lines: string) => {
    const dir = join(trees, name);
    git(repo, ["worktree", "add", "-q", "-b", branch, dir], gitEnv);
    await writeFile(join(dir, `${name}.ts`), lines);
    git(dir, ["add", "-A"], gitEnv);
    git(dir, ["commit", "-q", "-m", `${name} work`], gitEnv);
    return dir;
  };
  const pushed = (dir: string, branch: string) => {
    git(repo, ["update-ref", `refs/remotes/origin/${branch}`, branch], gitEnv);
    git(repo, ["config", `branch.${branch}.remote`, "origin"], gitEnv);
    git(repo, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`], gitEnv);
    return git(dir, ["rev-parse", "HEAD"], gitEnv);
  };
  const failingTree = await addTree("failing", "feat/failing", "one\ntwo\nthree\n");
  const failingHead = pushed(failingTree, "feat/failing");
  const readyTree = await addTree("ready", "feat/ready", "one\n");
  const readyHead = pushed(readyTree, "feat/ready");
  const idleTree = await addTree("idle", "feat/idle", "a\nb\n");
  await writeFile(join(idleTree, "draft.ts"), "uncommitted\n");
  const mergedTree = await addTree("merged", "feat/old", "old\n");
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge feat/old", "feat/old"], gitEnv);
  git(repo, ["update-ref", "refs/remotes/origin/main", "main"], gitEnv);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], gitEnv);
  await writeFile(join(repo, "notes.md"), "my own work\n");

  const now = new Date().toISOString();
  const rest = (number: number, title: string, branch: string, head: string) =>
    JSON.stringify([
      { number, title, html_url: `https://github.com/acme/widgets/pull/${number}`, state: "open", draft: false, merged_at: null, head: { sha: head, ref: branch } },
    ]);
  const runs = (conclusion: string) =>
    JSON.stringify({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion, started_at: now, completed_at: now }] });
  await writeFile(join(ghDir, "pulls-failing.json"), rest(42, "Add failing widgets", "feat/failing", failingHead));
  await writeFile(join(ghDir, "pulls-ready.json"), rest(43, "Add ready widgets", "feat/ready", readyHead));
  await writeFile(join(ghDir, "none.json"), "[]");
  await writeFile(join(ghDir, "runs-failing.json"), runs("failure"));
  await writeFile(join(ghDir, "runs-ready.json"), runs("success"));
  await writeFile(join(ghDir, "status.json"), JSON.stringify({ state: "pending", statuses: [] }));
  await writeFile(join(ghDir, "view-failing.json"), pullRequest(42, "Add failing widgets", "feat/failing", failingHead, "FAILURE"));
  await writeFile(join(ghDir, "view-ready.json"), pullRequest(43, "Add ready widgets", "feat/ready", readyHead, "SUCCESS"));
  await writeExecutable(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.102.1 (2026-10-20)"; exit 0 ;;
  auth) echo "github.com: Logged in to github.com account e2e"; exit 0 ;;
  api) ;;
  pr)
    if [ "$2" = "view" ]; then
      case "$(git branch --show-current)" in
        feat/failing) cat '${join(ghDir, "view-failing.json")}'; exit 0 ;;
        feat/ready) cat '${join(ghDir, "view-ready.json")}'; exit 0 ;;
      esac
      echo "no pull requests found" >&2; exit 1
    fi
    [ "$2" = "list" ] && { printf '[]'; exit 0; }
    echo "no pull requests found" >&2; exit 1 ;;
  issue) printf '[]'; exit 0 ;;
  repo) printf '%s' '{"nameWithOwner":"acme/widgets","url":"https://github.com/acme/widgets","defaultBranchRef":{"name":"main"}}'; exit 0 ;;
  *) echo "unknown command: $*" >&2; exit 1 ;;
esac
shift
path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --header|--jq|--method) shift 2 ;;
    --include|-i) shift ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  repos/acme/widgets/pulls\\?*head=acme%3Afeat%2Ffailing*) file='${join(ghDir, "pulls-failing.json")}' ;;
  repos/acme/widgets/pulls\\?*head=acme%3Afeat%2Fready*) file='${join(ghDir, "pulls-ready.json")}' ;;
  repos/acme/widgets/pulls\\?*) file='${join(ghDir, "none.json")}' ;;
  repos/acme/widgets/commits/${failingHead}/check-runs*) file='${join(ghDir, "runs-failing.json")}' ;;
  repos/acme/widgets/commits/${readyHead}/check-runs*) file='${join(ghDir, "runs-ready.json")}' ;;
  repos/acme/widgets/commits/*/status*) file='${join(ghDir, "status.json")}' ;;
  *) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; exit 1 ;;
esac
printf 'HTTP/2.0 200 OK\\r\\nEtag: "%s"\\r\\nContent-Type: application/json\\r\\n\\r\\n' "$(cksum < "$file" | cut -d' ' -f1)"
cat "$file"
`,
  );
  const shell = join(binDir, "bash");
  // Codara reads PATH from a login shell; the fake gh must win there too.
  await writeExecutable(shell, `#!/bin/sh\nexport PATH='${binDir}':"$PATH"\nexec /bin/bash --noprofile --norc "$@"\n`);

  const before = new Date(Date.now() - 60_000).toISOString();
  const copy = (id: string, cwd: string, branch: string) => ({
    id,
    name: `widgets · ${branch}`,
    cwd,
    color: "#E8B45A",
    workers: [],
    copyBranch: { repoCwd: repo, branch, baseBranch: "main", city: id, mode: "fork", createdAt: before },
  });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-app",
      workspaces: [
        { id: "ws-app", name: "widgets", cwd: repo, color: "#E8B45A", workers: [] },
        copy("wt-idle", idleTree, "feat/idle"),
        copy("wt-ready", readyTree, "feat/ready"),
        copy("wt-failing", failingTree, "feat/failing"),
        copy("wt-merged", mergedTree, "feat/old"),
      ],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false, theme: "dracula" }));

  return {
    root,
    repo,
    idleTree,
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
      SPARK_E2E_PR_WATCH_TICK_MS: "1000",
      CODARA_CHROME_LINK: "0",
    },
  };
}

const lane = (page: Page, branch: string) => page.locator(`[data-testid="source-lane"][data-lane-branch="${branch}"]`);
const laneOrder = (page: Page) =>
  page.getByTestId("source-lanes").getByTestId("source-lane").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-lane-branch")));

async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.SOURCE_LANES_SHOTS;
  if (!dir) return;
  const panel = page.getByTestId("commit-dock").locator("..");
  for (const theme of ["dracula", "codara-daylight"] as const) {
    await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await panel.screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => window.spark.preferences.set("theme", "dracula"));
}

test("every checkout is a lane with its changes, its PR and its next step", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script");
  test.setTimeout(180_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("source-lanes")).toBeVisible({ timeout: 45_000 });

    await test.step("lanes are ordered by what needs the user, the active checkout last", async () => {
      await expect(lane(page, "feat/failing").getByTestId("workspace-pull-request")).toHaveAttribute("data-checks", "failing", { timeout: 30_000 });
      await expect(lane(page, "feat/ready").getByTestId("workspace-pull-request")).toHaveAttribute("data-checks", "passing", { timeout: 30_000 });
      await expect.poll(() => laneOrder(page)).toEqual(["feat/failing", "feat/ready", "feat/idle", "main"]);
      await expect(lane(page, "main")).toHaveAttribute("data-own", "true");
      await expect(lane(page, "main")).toContainText("this checkout");
      await expect(lane(page, "feat/idle")).toContainText("+3", { timeout: 20_000 });
      await expect(lane(page, "feat/idle")).toContainText("no PR");
    });

    await test.step("today's detail lives in the active lane, merged lanes in their fold", async () => {
      await expect(lane(page, "main").getByText("notes.md")).toBeVisible({ timeout: 15_000 });
      await expect(lane(page, "main").getByRole("button", { name: "Pull", exact: true })).toBeVisible();
      await expect(lane(page, "main").getByText("History", { exact: true })).toBeVisible();
      await expect(page.getByRole("tablist", { name: "GitHub rooms" })).toHaveCount(0);
      await expect(page.getByTestId("source-lanes").getByTestId("workspace-merged-fold")).toContainText("1 merged", { timeout: 30_000 });
      await expect(lane(page, "feat/old")).toHaveCount(0);
    });

    await test.step("the row unfolds a lane and stays in this workspace", async () => {
      await lane(page, "feat/idle").getByRole("button", { expanded: false }).click();
      await expect(lane(page, "feat/idle").getByTestId("source-lane-file")).toHaveCount(2);
      await expect(lane(page, "feat/idle").getByTestId("source-lane-file").first()).toContainText("idle.ts");
      await expect(page.locator('[data-workspace-id="ws-app"]')).toHaveAttribute("data-active", "true");
    });

    await test.step("each lane offers its next step", async () => {
      await lane(page, "feat/failing").getByRole("button", { expanded: false }).click();
      const fix = lane(page, "feat/failing").locator('[data-git-fix="checks"]');
      await expect(fix).toHaveText("Fix checks");
      await lane(page, "feat/ready").getByRole("button", { expanded: false }).click();
      await shots(page, "lanes");
      await lane(page, "feat/ready").getByTestId("source-lane-merge").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("#43", { timeout: 20_000 });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });

    await test.step("the commit box stays docked and commits this checkout", async () => {
      const dock = page.getByTestId("commit-dock");
      const message = dock.getByPlaceholder("Message  (Ctrl+Enter to commit)");
      await expect(message).toBeVisible();
      const list = page.getByTestId("source-lanes");
      expect((await dock.boundingBox())!.y).toBeGreaterThanOrEqual((await list.boundingBox())!.y);
      await dock.getByRole("button", { name: "More commit options" }).click();
      await expect(page.getByRole("menuitem", { name: "Split into commits" })).toBeVisible();
      // A click needs the item on screen: the dock scrolls and must not clip the menu.
      await page.getByRole("menuitemcheckbox", { name: "Amend last commit" }).click();
      await message.fill("x");
      await expect(dock.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
      await dock.getByRole("button", { name: "More commit options" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Amend last commit" }).click();
      await expect(dock.getByRole("button", { name: /^Commit/ })).toBeVisible();
      await message.fill("Add my notes");
      await message.press("Control+Enter");
      await expect.poll(() => git(fixture.repo, ["log", "-1", "--format=%s"], fixture.env), { timeout: 15_000 }).toBe("Add my notes");
    });

    await test.step("Review opens that lane's workspace on what it changed since its base", async () => {
      await lane(page, "feat/idle").getByTestId("source-lane-review").click();
      await expect(page.locator('[data-workspace-id="wt-idle"]')).toHaveAttribute("data-active", "true", { timeout: 15_000 });
      // idle.ts is committed, so only the view since the base lists it.
      await expect(page.locator('[data-testid="review-file"][data-path="idle.ts"]')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => laneOrder(page)).toContain("main");
      await expect(lane(page, "feat/idle")).toHaveAttribute("data-own", "true");
    });

    await test.step("the journey marks failed checks as failed, with no green tick", async () => {
      await page.locator('[data-workspace-id="wt-failing"]').click();
      await expect(lane(page, "feat/failing")).toHaveAttribute("data-own", "true", { timeout: 15_000 });
      const journey = page.getByRole("list", { name: "Review journey" });
      const failed = journey.locator('[role="listitem"][data-state="failed"]');
      await expect(failed).toContainText("Checks found problems", { timeout: 30_000 });
      await expect(failed).toContainText("✕");
      await expect(failed).not.toContainText("✓");
      await journey.scrollIntoViewIfNeeded();
      await shots(page, "own-lane-failed");
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
