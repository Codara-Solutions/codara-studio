import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// Pull request triggers, end to end with NO model and NO network: a fake gh
// answers from files, and steps-only automations record what they were given.
//
//   1. Arming seeds silently: what already exists starts nothing.
//   2. A new pull request from a member starts one run, with its number and
//      commit in the step's variables. A stranger's starts nothing.
//   3. A failed check starts the CI automation once for that commit.
//   4. A title written to attack a shell step never reaches it.
//   5. The editor offers the trigger and saves the plain sentence.
//
// Optional: GITHUB_TRIGGER_SHOTS_DIR=<dir> saves screenshots.

const run = promisify(execFile);
const WS_ID = "ws-github-trigger-e2e";
const SHOTS = process.env.GITHUB_TRIGGER_SHOTS_DIR;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

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

async function clickAttached(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLElement).click());
}

function pull(number: number, sha: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Change ${number}`,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    draft: false,
    author_association: "MEMBER",
    head: { sha, ref: `feat/${number}` },
    base: { ref: "main" },
    ...over,
  };
}

interface Fixture {
  root: string;
  home: string;
  repo: string;
  ghDir: string;
  env: Record<string, string>;
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-github-trigger-e2e-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const ghDir = join(root, "gh");
  const repo = join(root, "sample-repo");
  await Promise.all([home, userHome, binDir, ghDir, repo].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(userHome, ".zprofile"), `export PATH='${binDir}':$PATH\n`, "utf8");
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await run("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });

  await writeFile(join(ghDir, "pulls.json"), JSON.stringify([pull(1, SHA_A)]), "utf8");
  await writeFile(join(ghDir, "status.json"), JSON.stringify({ statuses: [] }), "utf8");
  await writeFile(join(ghDir, "runs-default.json"), JSON.stringify({ check_runs: [] }), "utf8");
  const gh = join(binDir, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.102.1 (2026-10-20)"; exit 0 ;;
  auth) echo "github.com: Logged in to github.com account e2e"; exit 0 ;;
  api) ;;
  pr) [ "$2" = "list" ] && { printf '[]'; exit 0; }; exit 1 ;;
  issue) printf '[]'; exit 0 ;;
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
  repos/acme/widgets/pulls\\?*) file='${join(ghDir, "pulls.json")}' ;;
  repos/acme/widgets/commits/*/check-runs*)
    sha="$(printf '%s' "$path" | sed 's|.*/commits/||; s|/.*||')"
    file='${ghDir}'/"runs-$sha.json"
    [ -f "$file" ] || file='${join(ghDir, "runs-default.json")}' ;;
  repos/acme/widgets/commits/*/status*) file='${join(ghDir, "status.json")}' ;;
  *) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; exit 1 ;;
esac
printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'
cat "$file"
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
  await writeFile(
    join(home, "scheduler.json"),
    JSON.stringify({ jobs: [job("job-opened", "Review new pull requests", ["prOpened"], repo), job("job-ci", "Explain CI failures", ["ciFailed"], repo)] }),
    "utf8",
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return {
    root,
    home,
    repo,
    ghDir,
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
}

function job(id: string, name: string, events: string[], cwd: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    name,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    trigger: { kind: "github", events },
    loop: { kind: "once", stop: {} },
    worker: { model: "claude-opus-5", effort: "medium" },
    prompt: { template: "" },
    state: { status: "idle", iteration: 0 },
    history: [],
    input: { workspaceId: WS_ID, workspaceName: "sample-repo", cwd, planTitle: name, initialUserNote: "", chatMode: "execute" },
    graph: {
      version: 1,
      nodes: [
        {
          id: "log",
          kind: "step",
          label: "Log",
          action: { type: "command", command: `echo "${id} pr={{pr_number}} head={{pr_head}} url={{pr_url}}" >> fired.log` },
        },
      ],
      edges: [],
      entryNodeIds: ["log"],
    },
  };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({ args: ["."], env: fixture.env });
}

function chord(): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+A`;
}

async function firedLog(fixture: Fixture): Promise<string> {
  return readFile(join(fixture.repo, "fired.log"), "utf8").catch(() => "");
}

async function schedulerJob(fixture: Fixture, id: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readFile(join(fixture.home, "scheduler.json"), "utf8").catch(() => '{"jobs":[]}');
  try {
    return (JSON.parse(raw) as { jobs: Record<string, unknown>[] }).jobs.find((j) => j.id === id);
  } catch {
    return undefined;
  }
}

test("pull requests and failed CI start runs, for members only", async () => {
  test.setTimeout(150_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(chord());
    await widen(app);

    const opened = page.locator(".automation-row", { hasText: "Review new pull requests" });
    await expect(opened).toContainText("When a pull request is opened");
    await expect(page.locator(".automation-row", { hasText: "Explain CI failures" })).toContainText(
      "When CI fails on a pull request",
    );

    // Arming seeds from what exists and starts nothing.
    await expect.poll(async () => (await schedulerJob(fixture, "job-opened"))?.githubTrigger).toBeTruthy();
    await expect.poll(async () => (await schedulerJob(fixture, "job-ci"))?.githubTrigger).toBeTruthy();
    expect(await firedLog(fixture)).toBe("");

    // A stranger's pull request, one with an attack in its title, and a member's.
    const attack = join(fixture.root, "pwned");
    await writeFile(
      join(fixture.ghDir, "pulls.json"),
      JSON.stringify([
        pull(1, SHA_A),
        pull(2, SHA_B, { author_association: "NONE" }),
        pull(3, SHA_C, { title: `$(touch ${attack})`, head: { sha: SHA_C, ref: `x;touch${attack}` } }),
      ]),
      "utf8",
    );
    await expect.poll(() => firedLog(fixture), { timeout: 30_000 }).toContain(
      `job-opened pr=3 head=${SHA_C} url=https://github.com/acme/widgets/pull/3`,
    );

    // CI goes red on the stranger's pull request and on a member's.
    const failing = {
      check_runs: [
        {
          name: "build",
          status: "completed",
          conclusion: "failure",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          check_suite: { id: 1 },
        },
      ],
    };
    await writeFile(join(fixture.ghDir, `runs-${SHA_B}.json`), JSON.stringify(failing), "utf8");
    await writeFile(join(fixture.ghDir, `runs-${SHA_C}.json`), JSON.stringify(failing), "utf8");
    await expect.poll(() => firedLog(fixture), { timeout: 30_000 }).toContain(`job-ci pr=3 head=${SHA_C}`);

    // Nothing more comes, whatever a few more polls see.
    await page.waitForTimeout(3500);
    const log = await firedLog(fixture);
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);
    expect(log).not.toContain("pr=2");
    expect(existsSync(attack)).toBe(false);

    await clickAttached(opened);
    await expect(page.locator(".automation-head")).toContainText("When a pull request is opened, 1 step runs in sample-repo");
    await shot(page, "github-trigger-ran");
  } finally {
    await app?.close();
  }
});

test("no gh sign-in or GitHub remote says so once, in the history", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare();
  await run("git", ["remote", "set-url", "origin", "https://example.invalid/acme/widgets.git"], { cwd: fixture.repo });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(chord());
    await clickAttached(page.locator(".automation-row", { hasText: "Review new pull requests" }));
    const row = page.locator('[data-testid="history-skip-row"][data-skip-reason="github"]');
    await expect(row).toContainText("no GitHub remote named origin", { timeout: 30_000 });
    await page.waitForTimeout(2500);
    await expect(row).toHaveCount(1);
  } finally {
    await app?.close();
  }
});

test("the editor offers pull requests and saves the plain sentence", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(chord());
    await widen(app);
    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await expect(page.getByRole("button", { name: /A worker reads each new pull request/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Explain a CI failure/ })).toBeVisible();

    await clickAttached(page.getByRole("button", { name: /Explain a CI failure/ }));
    await page.getByPlaceholder("What is this automation for?").fill("Explain red builds");
    await clickAttached(page.locator(".react-flow__node-trigger"));
    await expect(page.getByText("CI fails on a pull request", { exact: true })).toBeVisible();
    await expect(page.getByText(/a stranger cannot start a paid run/)).toBeVisible();
    await page.getByPlaceholder("main").fill("main");
    await shot(page, "github-trigger-editor");
    await clickAttached(page.getByRole("button", { name: "Create automation", exact: true }));
    await expect(page.locator(".automation-row", { hasText: "Explain red builds" })).toContainText(
      "When CI fails on a pull request into main",
    );
    const saved = (await schedulerJobByName(fixture, "Explain red builds")) as { trigger?: unknown } | undefined;
    expect(saved?.trigger).toEqual({ kind: "github", events: ["ciFailed"], branch: "main" });
  } finally {
    await app?.close();
  }
});

async function schedulerJobByName(fixture: Fixture, name: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readFile(join(fixture.home, "scheduler.json"), "utf8");
  return (JSON.parse(raw) as { jobs: Record<string, unknown>[] }).jobs.find((j) => j.name === name);
}
