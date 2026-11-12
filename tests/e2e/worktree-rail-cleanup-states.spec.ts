import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// The project's "N merged · Clean up" line counts exactly what its button
// takes, and one press takes all of it: merged worktrees in each state real
// ones are left in (an installed node_modules with Electron's .asar, husky's
// generated hooks and build output; a squash merge; an agent's worktree whose
// tab is gone; a folder already deleted; an ignored .env, asked about first).
// The worktree Codara itself runs from is never counted, since no press can
// take it, and every press leaves a line in the audit log.

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

function copyWorkspace(id: string, name: string, cwd: string, repo: string, branch: string, createdAt: string) {
  return {
    id,
    name,
    cwd,
    color: "#42D6C7",
    workers: [],
    copyBranch: { repoCwd: repo, branch, baseBranch: "main", city: id, mode: "fork", createdAt },
  };
}

// A minimal .asar archive (a size pickle, a header pickle holding the JSON
// index, then the bytes): inside Electron, fs reads it as a folder.
async function writeAsar(file: string): Promise<void> {
  const body = Buffer.from("1;\n");
  const json = Buffer.from(JSON.stringify({ files: { "main.js": { size: body.length, offset: "0" } } }));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([size, header, body]));
}

interface AuditRow {
  outcome: string;
  code: string | null;
  workspaceId: string | null;
  caller: { client: string | null };
}

function railAudit(home: string): AuditRow[] {
  const file = join(home, "logs", "worktree-audit.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRow)
    .filter((row) => row.caller?.client === "workspace-rail");
}

test("Clean up on the merged fold takes every worktree it counts", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-rail-states-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const repo = join(root, "repo");
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
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await writeFile(join(repo, ".gitignore"), "node_modules/\nout/\n*.tsbuildinfo\n.env\n");
  await mkdir(join(repo, ".husky"));
  await writeFile(join(repo, ".husky", "pre-commit"), "npm test\n");
  git(repo, ["add", ".gitignore", ".husky/pre-commit"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);

  const commitIn = async (dir: string, file: string) => {
    await writeFile(join(dir, file), `${file}\n`);
    git(dir, ["add", file], gitEnv);
    git(dir, ["commit", "-q", "-m", file], gitEnv);
  };
  const before = new Date(Date.now() - 60_000).toISOString();
  const mergedTree = async (name: string, branch: string, how: "merge" | "squash" = "merge") => {
    const dir = join(trees, name);
    git(repo, ["worktree", "add", "-q", "-b", branch, dir], gitEnv);
    await commitIn(dir, `${name}.txt`);
    if (how === "merge") git(repo, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch], gitEnv);
    else {
      git(repo, ["merge", "-q", "--squash", branch], gitEnv);
      git(repo, ["commit", "-q", "-m", `${branch} (squashed)`], gitEnv);
    }
    return dir;
  };

  // What the real merged worktrees of an Electron app hold once their tests ran.
  const deps = await mergedTree("deps", "feat/deps");
  for (let n = 0; n < 50; n += 1) {
    await mkdir(join(deps, "node_modules", `pkg-${n}`), { recursive: true });
    await writeFile(join(deps, "node_modules", `pkg-${n}`, "index.js"), `module.exports = ${n};\n`);
  }
  await writeAsar(join(deps, "node_modules", "electron", "dist", "resources", "default_app.asar"));
  await mkdir(join(deps, ".husky", "_"));
  await writeFile(join(deps, ".husky", "_", ".gitignore"), "*\n");
  await writeFile(join(deps, ".husky", "_", "pre-commit"), "#!/bin/sh\n");
  await mkdir(join(deps, "out", "main"), { recursive: true });
  await writeFile(join(deps, "out", "main", "index.js"), "1;\n");
  await writeFile(join(deps, "tsconfig.node.tsbuildinfo"), "{}\n");
  // Squash-merged: its branch is not an ancestor of main.
  const squash = await mergedTree("squash", "feat/squash", "squash");
  const secrets = await mergedTree("secrets", "feat/secrets");
  await writeFile(join(secrets, ".env"), "LOCAL_ONLY=1\n");
  // Already deleted by hand; git still lists it.
  const gone = await mergedTree("gone", "feat/gone");
  await rm(gone, { recursive: true, force: true });
  // The checkout this Codara runs from (its working directory).
  const appHome = await mergedTree("app-home", "feat/app-home");

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-repo",
      workspaces: [
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] },
        copyWorkspace("ws-deps", "Deps copy", deps, repo, "feat/deps", before),
        copyWorkspace("ws-squash", "Squash copy", squash, repo, "feat/squash", before),
        copyWorkspace("ws-secrets", "Secrets copy", secrets, repo, "feat/secrets", before),
        copyWorkspace("ws-gone", "Gone copy", gone, repo, "feat/gone", before),
        copyWorkspace("ws-app-home", "App home", appHome, repo, "feat/app-home", before),
      ],
    }),
  );
  const app = await electron.launch({
    args: [process.cwd()],
    cwd: appHome,
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
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 60_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const row = (id: string) => page.locator(`[data-workspace-id="${id}"]`).first();
    const fold = page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-merged-fold");
    const notice = page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-merged-notice");
    const list = page.locator(".spark-workspace-list").first();
    await expect(row("ws-repo")).toBeVisible({ timeout: 30_000 });

    // An agent's worktree, merged, whose tab was closed since.
    const pane = await request("terminal.create", { cwd: repo, title: "maker" });
    const made = await request("worktree.create", {
      callerRole: "studio",
      callerClient: "claude-code",
      callerPaneId: pane.paneId,
      branch: "feat/agent",
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    await commitIn(made.path, "agent.txt");
    git(repo, ["merge", "-q", "--no-ff", "-m", "merge feat/agent", "feat/agent"], gitEnv);
    await request("terminal.close", { paneId: pane.paneId });

    // The deleted folder leaves on its own; the rest wait for the press.
    await expect(page.locator('[data-workspace-id="ws-gone"]')).toHaveCount(0, { timeout: 60_000 });
    expect(branchExists(repo, "feat/gone", gitEnv)).toBe(false);
    // The rail reads merges on focus, at most every 20 s, and every 3 min.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          return page.locator(`[data-workspace-id="${made.workspaceId}"]`).count();
        },
        { timeout: 90_000, intervals: [5_000] },
      )
      .toBe(0);
    await expect(fold).toHaveText(/^4 merged/);
    // The checkout Codara runs from stays in play and says why.
    await expect(row("ws-app-home")).toBeVisible();
    await expect(row("ws-app-home").getByTestId("workspace-merged")).toHaveCount(0);
    await expect(row("ws-app-home").getByTestId("worktree-agent-line")).toContainText("Codara runs from here");
    await list.screenshot({ path: testInfo.outputPath("rail-states-before.png") });

    await fold.getByTestId("workspace-merged-clean-up").click();
    const confirm = page.getByTestId("workspace-merged-clean-up-confirm");
    await expect(confirm).toContainText("Clean up 4 merged worktrees?");
    await confirm.getByRole("button", { name: "Clean up" }).click();
    // Only the .env is asked about; the rest are gone by then.
    await expect(confirm).toContainText("Secrets copy holds .env", { timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath("rail-states-ask.png") });
    for (const dir of [deps, squash, made.path]) expect(existsSync(dir), dir).toBe(false);
    for (const branch of ["feat/deps", "feat/squash", "feat/agent"]) expect(branchExists(repo, branch, gitEnv), branch).toBe(false);
    await confirm.getByRole("button", { name: "Remove anyway" }).click();

    await expect(fold).toHaveCount(0, { timeout: 60_000 });
    await expect(notice).toHaveCount(0);
    expect(existsSync(secrets)).toBe(false);
    expect(existsSync(appHome)).toBe(true);
    await expect(row("ws-app-home")).toBeVisible();
    await list.screenshot({ path: testInfo.outputPath("rail-states-after.png") });

    // Every press is in the audit log, the question about the .env included.
    await expect
      .poll(() => railAudit(home).map((entry) => `${entry.workspaceId}:${entry.outcome}:${entry.code ?? ""}`).sort(), {
        timeout: 15_000,
      })
      .toEqual(
        [
          "ws-deps:removed:",
          "ws-squash:removed:",
          `${made.workspaceId}:removed:`,
          "ws-secrets:refused:CONFIRM_IGNORED",
          "ws-secrets:removed:",
        ].sort(),
      );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
