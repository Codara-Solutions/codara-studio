import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The pull request watcher end to end, with a scripted `gh` on PATH that
// answers GitHub's REST API with ETags and 304s the way the real one does
// (exit 1, headers on stdout), and a Claude Code stand-in in the
// workspace's pane that records what it is sent. The checks of PR #42 run,
// then fail while the agent is mid-turn: the row shows it at once, the line
// for the agent waits until its turn ends and arrives once. Green checks
// turn the row's mark green, unchanged answers cost 304s, and switching the
// repository off from the row menu stops the reads.

const LINE = "CI failed on PR #42: build. Fix it with the fix-ci skill, push, and watch the checks.";

interface Fixture {
  env: Record<string, string>;
  ghDir: string;
  head: string;
  recordFile: string;
  releaseFile: string;
  claude: string;
}

test("a failing check reaches the agent on its branch once it is free, and the row shows it", async () => {
  test.skip(process.platform === "win32", "the fake gh and agent are POSIX scripts");
  test.setTimeout(180_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const mark = page.locator('[data-workspace-id="ws-wt"] [data-testid="workspace-pull-request"]');

    await test.step("the row shows the pull request with its checks running", async () => {
      await expect(mark).toHaveAttribute("data-checks", "pending", { timeout: 15_000 });
      await shot(page, "row-running");
      await expect(mark).toHaveAttribute("data-phase", "open");
      await expect(mark).toContainText("#42");
    });

    const paneId = await test.step("an agent works in the workspace", async () => {
      await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
      const pane = page.locator("[data-terminal-pane-id]:visible").first();
      await expect(pane).toBeVisible({ timeout: 30_000 });
      const id = (await pane.getAttribute("data-terminal-pane-id")) ?? "";
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
      await expect.poll(() => recorded(fixture.recordFile), { timeout: 10_000 }).toContain("go");
      return id;
    });

    await test.step("checks fail while the agent is mid-turn: the row shows it, the agent is not interrupted", async () => {
      await writeChecks(fixture, "failing");
      await expect(mark).toHaveAttribute("data-checks", "failing", { timeout: 15_000 });
      await expect(mark).toHaveAttribute("title", /Checks failing: build/);
      await shot(page, "row-failing");
      // Several watcher passes while the agent works.
      await page.waitForTimeout(5_000);
      expect(await recorded(fixture.recordFile)).not.toContain("CI failed");
    });

    await test.step("its turn ends: the line arrives, once", async () => {
      await writeFile(fixture.releaseFile, "done\n", "utf8");
      // The line also waits out 20 seconds after the user last typed there.
      await expect.poll(() => recorded(fixture.recordFile), { timeout: 60_000 }).toContain(LINE);
      await page.waitForTimeout(6_000);
      const received = await recorded(fixture.recordFile);
      expect(received.split("CI failed").length - 1).toBe(1);
      expect(paneId).toBeTruthy();
    });

    await test.step("green checks turn the mark green; unchanged answers are 304s", async () => {
      await writeChecks(fixture, "passing");
      await expect(mark).toHaveAttribute("data-checks", "passing", { timeout: 15_000 });
      await shot(page, "row-passing");
      await expect.poll(async () => (await calls(fixture)).filter((call) => call.startsWith("304 ")).length, { timeout: 15_000 }).toBeGreaterThan(3);
      const log = await calls(fixture);
      expect(log.some((call) => call.includes("repos/acme/widgets/pulls?head=acme%3Afeat%2Fwidgets"))).toBe(true);
      expect(log.some((call) => call.includes(`repos/acme/widgets/commits/${fixture.head}/check-runs`))).toBe(true);
    });

    await test.step("switched off from the row menu, the repository is not read again", async () => {
      await openRowMenu(page, "ws-wt");
      await page.getByRole("menuitem", { name: "Stop watching pull requests in this repo" }).click();
      await expect(mark).toHaveCount(0, { timeout: 10_000 });
      const before = (await calls(fixture)).length;
      await page.waitForTimeout(4_000);
      expect((await calls(fixture)).length).toBe(before);
      await openRowMenu(page, "ws-wt");
      await expect(page.getByRole("menuitem", { name: "Watch pull requests in this repo" })).toBeVisible();
      await page.keyboard.press("Escape");
    });
  } finally {
    await app?.close();
  }
});

// PR_WATCH_SHOTS=<dir> also saves the rail there.
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.PR_WATCH_SHOTS;
  const path = dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  await page.locator('[data-workspace-id="ws-wt"]').screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

async function openRowMenu(page: Page, workspaceId: string): Promise<void> {
  await page.locator(`[data-workspace-id="${workspaceId}"]`).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Workspace actions" })).toBeVisible({ timeout: 5_000 });
}

async function recorded(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

async function calls(fixture: Fixture): Promise<string[]> {
  return (await readFile(join(fixture.ghDir, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout;
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

// The head commit's check runs: build running, failing or passing; lint passed.
async function writeChecks(fixture: Fixture, build: "running" | "failing" | "passing"): Promise<void> {
  const now = new Date().toISOString();
  const buildRun =
    build === "running"
      ? { name: "build", status: "in_progress", conclusion: null, started_at: now, completed_at: null }
      : { name: "build", status: "completed", conclusion: build === "failing" ? "failure" : "success", started_at: now, completed_at: now };
  await writeFile(
    join(fixture.ghDir, "runs.json"),
    JSON.stringify({
      total_count: 2,
      check_runs: [buildRun, { name: "lint", status: "completed", conclusion: "success", started_at: now, completed_at: now }],
    }),
    "utf8",
  );
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-pr-watch-e2e-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const ghDir = join(root, "gh");
  const repo = join(root, "projects", "widgets");
  await Promise.all([home, userHome, binDir, ghDir, repo].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(userHome, ".zprofile"), `export PATH='${binDir}':$PATH\n`, "utf8");

  // A feature branch tracking origin/feat/widgets on a GitHub remote that is
  // never reached: the refs a push would leave are written by hand.
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "e2e@example.invalid"]);
  await git(repo, ["config", "user.name", "Codara E2E"]);
  await writeFile(join(repo, "app.ts"), "export const name = 'base';\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "initial"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(repo, ["checkout", "-q", "-b", "feat/widgets"]);
  await writeFile(join(repo, "app.ts"), "export const name = 'widgets';\n", "utf8");
  await git(repo, ["commit", "-q", "-am", "Widgets"]);
  await git(repo, ["update-ref", "refs/remotes/origin/feat/widgets", "HEAD"]);
  await git(repo, ["config", "branch.feat/widgets.remote", "origin"]);
  await git(repo, ["config", "branch.feat/widgets.merge", "refs/heads/feat/widgets"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();

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
        head: { sha: head, ref: "feat/widgets" },
      },
    ]),
    "utf8",
  );
  await writeFile(join(ghDir, "status.json"), JSON.stringify({ state: "pending", statuses: [] }), "utf8");
  const calls = join(ghDir, "calls.log");
  // `gh api --include --method GET [--header "If-None-Match: <etag>"] <path>`:
  // the file's checksum is its ETag; a matching If-None-Match gets a 304 and
  // exit 1, as from the real gh.
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
match=""
path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --header) match="$(printf '%s' "$2" | sed -n 's/^If-None-Match: //p')"; shift 2 ;;
    --include|-i) shift ;;
    --method) shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  repos/acme/widgets/pulls\\?*) file='${join(ghDir, "pulls.json")}' ;;
  repos/acme/widgets/commits/*/check-runs*) file='${join(ghDir, "runs.json")}' ;;
  repos/acme/widgets/commits/*/status*) file='${join(ghDir, "status.json")}' ;;
  *) echo "404 $path" >> '${calls}'; printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; exit 1 ;;
esac
etag="\\"$(cksum < "$file" | cut -d' ' -f1)\\""
if [ "$match" = "$etag" ]; then
  echo "304 $path" >> '${calls}'
  printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: %s\\r\\n\\r\\n' "$etag"
  echo "gh: HTTP 304" >&2
  exit 1
fi
echo "200 $path" >> '${calls}'
printf 'HTTP/2.0 200 OK\\r\\nEtag: %s\\r\\nContent-Type: application/json\\r\\n\\r\\n' "$etag"
cat "$file"
`,
  );

  // Claude Code as the agent notifier sees it: a status sequence per state.
  // "go" starts a turn that lasts until the release file appears; any other
  // submitted line is a short turn. Everything it is sent is recorded.
  const recordFile = join(root, "claude-received.txt");
  const releaseFile = join(root, "release");
  const claude = join(binDir, "fake-claude.js");
  await writeFile(
    claude,
    String.raw`
const fs = require("node:fs");
const out = (text) => process.stdout.write(text);
const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
out("Claude Code v2.1.300\r\n> ");
status("state=idle");
process.stdin.setRawMode(true);
process.stdin.resume();
let held = "";
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (text.includes("\x03")) process.exit(0);
  held += text;
  if (!text.includes("\r")) return;
  fs.appendFileSync(${JSON.stringify(recordFile)}, held + "\n");
  const long = held.includes("go");
  held = "";
  status("state=working");
  const end = () => { status("state=idle"); out("\r\n> "); };
  if (!long) return void setTimeout(end, 300);
  const wait = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
    clearInterval(wait);
    end();
  }, 200);
});
setTimeout(() => process.exit(0), 170000);
`,
    "utf8",
  );
  const shell = join(binDir, "bash");
  // Codara reads PATH from a login shell; the fake gh must win there too.
  await writeExecutable(shell, `#!/bin/sh\nexport PATH='${binDir}':"$PATH"\nexec /bin/bash --noprofile --norc "$@"\n`);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-wt", name: "widgets", cwd: repo, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-wt",
    }),
    "utf8",
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false }), "utf8");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const fixture: Fixture = {
    ghDir,
    head,
    recordFile,
    releaseFile,
    claude,
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
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      SPARK_E2E_PR_WATCH_TICK_MS: "1000",
    },
  };
  await writeChecks(fixture, "running");
  return fixture;
}
