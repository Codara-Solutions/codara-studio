import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Worktrees in the rail (DESIGN.md, "Worktrees in the rail"), against real
// git worktrees of one repository and a scripted `gh` that answers for one
// pull request. The worktrees hang under their project, not in the top-level
// list; each shows its branch with its PR mark, then its agent; the one an
// agent works in comes first and the project's number counts that agent.
// A click anywhere on the row opens the project, the chevron only folds it, and the
// merged worktrees wait in their own fold until Clean up, after a confirm
// that names them, removes them.
// RAIL_WORKTREES_SHOTS=<dir> also saves the rail in dracula and daylight.

interface Fixture {
  root: string;
  env: Record<string, string>;
  repo: string;
  merged: string[];
  claude: string;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

async function prepare(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-rail-worktrees-")));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const ghDir = join(root, "gh");
  const repo = join(root, "projects", "widgets");
  const other = join(root, "projects", "notes");
  const trees = join(root, "trees");
  await Promise.all([home, userHome, binDir, ghDir, repo, other, trees].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(userHome, ".zprofile"), `export PATH='${binDir}':$PATH\n`, "utf8");
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n");
  // playwright.config.ts already dropped what would reach the live app.
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
  const commitIn = async (dir: string, file: string, message: string) => {
    await writeFile(join(dir, file), `${message}\n`);
    git(dir, ["add", file], gitEnv);
    git(dir, ["commit", "-q", "-m", message], gitEnv);
  };
  const addTree = async (name: string, branch: string) => {
    const dir = join(trees, name);
    git(repo, ["worktree", "add", "-q", "-b", branch, dir], gitEnv);
    await commitIn(dir, `${name}.txt`, `${name} work`);
    return dir;
  };
  const prTree = await addTree("pr", "feat/widgets");
  // Pushed, as far as git can tell: the PR watcher looks up its upstream.
  git(repo, ["update-ref", "refs/remotes/origin/feat/widgets", "feat/widgets"], gitEnv);
  git(repo, ["config", "branch.feat/widgets.remote", "origin"], gitEnv);
  git(repo, ["config", "branch.feat/widgets.merge", "refs/heads/feat/widgets"], gitEnv);
  const prHead = git(prTree, ["rev-parse", "HEAD"], gitEnv);
  const agentTree = await addTree("agent", "feat/agent");
  const idleTree = await addTree("idle", "feat/idle");
  const merged = await addTree("merged", "feat/old");
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge feat/old", "feat/old"], gitEnv);
  const mergedToo = await addTree("merged-too", "feat/older");
  git(repo, ["merge", "-q", "--no-ff", "-m", "merge feat/older", "feat/older"], gitEnv);
  git(repo, ["update-ref", "refs/remotes/origin/main", "main"], gitEnv);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], gitEnv);

  const now = new Date().toISOString();
  await writeFile(
    join(ghDir, "pulls.json"),
    JSON.stringify([
      {
        number: 42,
        title: "Add widgets",
        html_url: "https://github.com/acme/widgets/pull/42",
        state: "open",
        draft: false,
        merged_at: null,
        head: { sha: prHead, ref: "feat/widgets" },
      },
    ]),
  );
  await writeFile(join(ghDir, "none.json"), "[]");
  await writeFile(
    join(ghDir, "runs.json"),
    JSON.stringify({
      total_count: 1,
      check_runs: [{ name: "build", status: "completed", conclusion: "failure", started_at: now, completed_at: now }],
    }),
  );
  await writeFile(join(ghDir, "status.json"), JSON.stringify({ state: "pending", statuses: [] }));
  // `gh api --include --method GET <path>` with REST headers on stdout, as
  // the real one prints them. Only feat/widgets has a pull request.
  await writeExecutable(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.102.1 (2026-10-20)"; exit 0 ;;
  auth) echo "github.com: Logged in to github.com account e2e"; exit 0 ;;
  api) ;;
  pr) [ "$2" = "list" ] && { printf '[]'; exit 0; }; echo "no pull requests found" >&2; exit 1 ;;
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
  repos/acme/widgets/pulls\\?*head=acme%3Afeat%2Fwidgets*) file='${join(ghDir, "pulls.json")}' ;;
  repos/acme/widgets/pulls\\?*) file='${join(ghDir, "none.json")}' ;;
  repos/acme/widgets/commits/*/check-runs*) file='${join(ghDir, "runs.json")}' ;;
  repos/acme/widgets/commits/*/status*) file='${join(ghDir, "status.json")}' ;;
  *) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; exit 1 ;;
esac
printf 'HTTP/2.0 200 OK\\r\\nEtag: "%s"\\r\\nContent-Type: application/json\\r\\n\\r\\n' "$(cksum < "$file" | cut -d' ' -f1)"
cat "$file"
`,
  );

  // Claude Code as Codara's agent detector sees it: idle, then working once
  // a line is submitted, with a note through the real agent socket.
  const claude = join(binDir, "fake-claude.js");
  await writeFile(
    claude,
    String.raw`
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const out = (text) => process.stdout.write(text);
const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
out("Claude Code v2.1.300\r\n> ");
status("state=idle");
process.stdin.setRawMode(true);
process.stdin.resume();
function postNote(note) {
  const handshake = JSON.parse(fs.readFileSync(path.join(process.env.SPARK_HOME_DIR, "agent-socket.json"), "utf8"));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "workspace.status",
    params: { status: "in_progress", note, callerPaneId: process.env.SPARK_PANE_ID, callerPid: process.pid, callerClient: "claude-code" },
  });
  const target = new URL(handshake.url + "/rpc");
  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: "Bearer " + handshake.token },
  }, (res) => res.resume());
  req.on("error", () => undefined);
  req.end(body);
}
process.stdin.on("data", (data) => {
  if (data.includes("\x03")) process.exit(0);
  if (!data.includes("\r")) return;
  status("state=working");
  setTimeout(() => postNote("Parser rewrite, tests next"), 500);
});
setTimeout(() => process.exit(0), 170000);
`,
    "utf8",
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
      activeWorkspaceId: "ws-other",
      workspaces: [
        { id: "ws-app", name: "widgets", cwd: repo, color: "#E8B45A", workers: [] },
        copy("wt-pr", prTree, "feat/widgets"),
        copy("wt-merged", merged, "feat/old"),
        copy("wt-merged-too", mergedToo, "feat/older"),
        copy("wt-idle", idleTree, "feat/idle"),
        copy("wt-agent", agentTree, "feat/agent"),
        { id: "ws-other", name: "notes", cwd: other, color: "#78A8FF", workers: [] },
      ],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false, theme: "dracula" }));

  return {
    root,
    repo,
    merged: [merged, mergedToo],
    claude,
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

const row = (page: Page, workspaceId: string) => page.locator(`[data-workspace-id="${workspaceId}"]`);
const children = (page: Page, workspaceId: string) => page.locator(`[data-rail-children-of="${workspaceId}"]`);

async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.RAIL_WORKTREES_SHOTS;
  for (const theme of ["dracula", "codara-daylight"] as const) {
    await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    const path = dir ? join(dir, `${name}-${theme}.png`) : test.info().outputPath(`${name}-${theme}.png`);
    await page.locator('[data-rail-list="top"]').screenshot({ path });
    await test.info().attach(`${name}-${theme}`, { path, contentType: "image/png" });
  }
  await page.evaluate(() => window.spark.preferences.set("theme", "dracula"));
}

test("worktrees hang under their project with their PR and their agent", async () => {
  test.skip(process.platform === "win32", "the fake gh and agent are POSIX scripts");
  test.setTimeout(180_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(row(page, "ws-app")).toBeVisible({ timeout: 30_000 });

    await test.step("worktrees hang under their project, merged ones folded", async () => {
      const topLevel = page.locator('[data-rail-list="top"] > [data-workspace-id]');
      await expect(topLevel).toHaveCount(2);
      expect(await topLevel.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")))).toEqual([
        "ws-app",
        "ws-other",
      ]);
      for (const id of ["wt-pr", "wt-idle", "wt-agent"]) {
        await expect(children(page, "ws-app").locator(`[data-workspace-id="${id}"]`)).toBeVisible();
      }
      await expect(row(page, "wt-pr").getByTestId("workspace-icon-tile")).toHaveCount(0);
      await expect(row(page, "wt-pr").getByTestId("workspace-branch")).toHaveText("feat/widgets");
      await expect(row(page, "wt-idle").getByTestId("worktree-agent-line")).toHaveText("No agent · from main");
      await expect(children(page, "ws-app").getByTestId("workspace-merged-fold")).toContainText("2 merged", { timeout: 30_000 });
      await expect(row(page, "wt-merged")).toHaveCount(0);
    });

    await test.step("the PR mark sits on the branch line", async () => {
      const mark = row(page, "wt-pr").getByTestId("workspace-pull-request");
      await expect(mark).toHaveAttribute("data-checks", "failing", { timeout: 20_000 });
      await expect(mark).toContainText("#42");
      await expect(row(page, "wt-idle").getByTestId("workspace-pull-request")).toHaveCount(0);
    });

    await test.step("an agent shows on the row of the worktree it works in, which comes first", async () => {
      await row(page, "wt-agent").click();
      await expect(row(page, "wt-agent")).toHaveAttribute("data-active", "true");
      await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
      const pane = page.locator("[data-terminal-pane-id]:visible").first();
      await expect(pane).toBeVisible({ timeout: 30_000 });
      const input = pane.locator(".xterm-helper-textarea");
      await expect(async () => {
        await input.focus();
        await expect(input).toBeFocused({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      await input.pressSequentially(`"${process.execPath}" "${fixture.claude}"`, { delay: 2 });
      await input.press("Enter");
      await expect(pane).toContainText(/claude/i, { timeout: 20_000 });
      await input.pressSequentially("go", { delay: 2 });
      await input.press("Enter");

      const line = row(page, "wt-agent").getByTestId("worktree-agent-line");
      await expect(line).toHaveAttribute("data-state", "working", { timeout: 20_000 });
      await expect(line).toContainText("Parser rewrite, tests next", { timeout: 10_000 });
      // The project's number covers its worktrees' agents; its line does not
      // repeat that count (DESIGN.md, "One home for agent counts").
      const count = row(page, "ws-app").getByTestId("workspace-agent-count");
      await expect(count).toHaveText("1/1");
      await expect(count).toHaveAttribute("data-working", "true");
      await expect(count).toHaveAttribute("aria-label", "1 of 1 agent working, 1 in worktree");
      await expect(row(page, "ws-app").getByTestId("workspace-agents-summary")).toHaveCount(0);
      const order = await children(page, "ws-app")
        .locator(":scope > [data-workspace-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")));
      expect(order).toEqual(["wt-agent", "wt-pr", "wt-idle"]);
      await row(page, "ws-other").click();
      await shots(page, "rail-worktrees");
    });

    await test.step("a click anywhere on the row opens the project; the chevron only folds it", async () => {
      await row(page, "ws-app").getByTitle("widgets", { exact: true }).click();
      await expect(row(page, "ws-app")).toHaveAttribute("data-active", "true");
      await row(page, "ws-other").click();
      const toggle = row(page, "ws-app").getByTestId("workspace-children-toggle");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(children(page, "ws-app")).toHaveCount(0);
      await expect(row(page, "ws-other")).toHaveAttribute("data-active", "true");
      // Folded, the project still says what works inside it.
      await expect(row(page, "ws-app").getByTestId("workspace-agent-count")).toHaveText("1/1");
      await expect(row(page, "ws-app").getByTestId("workspace-agent-count")).toHaveAttribute("data-working", "true");
      await expect(row(page, "ws-app")).toHaveAttribute("aria-busy", "true");
      await toggle.click();
      await row(page, "wt-idle").getByTestId("worktree-agent-line").click();
      await expect(row(page, "wt-idle")).toHaveAttribute("data-active", "true");
    });

    await test.step("the merged fold opens faded, and Clean up removes what it holds after naming it", async () => {
      const fold = children(page, "ws-app").getByTestId("workspace-merged-fold");
      await fold.getByTestId("workspace-merged-toggle").click();
      await expect(row(page, "wt-merged")).toBeVisible();
      await expect(row(page, "wt-merged")).toHaveClass(/rail-child-faded/);
      await expect(row(page, "wt-merged").getByTestId("workspace-merged")).toBeVisible();
      await row(page, "ws-other").click();
      await shots(page, "rail-worktrees-merged-open");
      const confirm = page.getByTestId("workspace-merged-clean-up-confirm");
      await fold.getByTestId("workspace-merged-clean-up").click();
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText("Clean up 2 merged worktrees?");
      await expect(confirm.locator("li")).toHaveText(["widgets · feat/old", "widgets · feat/older"]);
      if (process.env.RAIL_WORKTREES_SHOTS) {
        await page.screenshot({ path: join(process.env.RAIL_WORKTREES_SHOTS, "rail-worktrees-clean-up-confirm-dracula.png") });
      }
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);
      for (const dir of fixture.merged) expect(existsSync(dir)).toBe(true);
      await fold.getByTestId("workspace-merged-clean-up").click();
      await confirm.getByRole("button", { name: "Clean up" }).click();
      await expect(row(page, "wt-merged")).toHaveCount(0, { timeout: 30_000 });
      await expect(row(page, "wt-merged-too")).toHaveCount(0, { timeout: 30_000 });
      await expect(fold).toHaveCount(0);
      for (const dir of fixture.merged) expect(existsSync(dir)).toBe(false);
      await expect(row(page, "wt-pr")).toBeVisible();
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
