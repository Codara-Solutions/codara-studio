import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// codara_session_* against the real app and a real shell: a coordinator in
// one workspace starts a session in another, with a stand-in for Claude Code
// on PATH that records what it was given and reports its turns the way the
// real one does (OSC 7501). The session opens in the target workspace's rail
// and its row opens its tab, the caller gets its final message back, follows
// up, and a session needing the user stops the wait. It survives its caller
// closing and a Codara restart, and a later agent in the workspace finds it
// but cannot write to it. A background agent's row explains where the work is
// instead of showing an empty pane.
//
// CODARA_PROOF_DIR=<dir> saves the screenshots there.

// "permission" in a brief or message makes it ask; "slow" keeps it working.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = (text) => process.stdout.write(text);
const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const brief = process.argv[process.argv.length - 1];
fs.appendFileSync(path.join(process.env.FAKE_LOG_DIR, "briefs.jsonl"), JSON.stringify({ brief, argv: process.argv.slice(2), cwd: process.cwd() }) + "\n");
out("Claude Code v2.1.300\r\n> ");
status("state=idle");
process.stdin.setRawMode(true);
process.stdin.resume();
let count = 0;
function turn(text) {
  count += 1;
  const n = count;
  status("state=working");
  if (/permission/.test(text)) {
    setTimeout(() => status("state=blocked:kind=permission:msg=" + b64("Allow npm test?")), 300);
    return;
  }
  const delay = /slow/.test(text) ? 4000 : 800;
  setTimeout(() => status("state=done:msg=" + b64("Answer " + n + " to: " + text.slice(0, 40).replace(/\s+/g, " "))), delay);
}
setTimeout(() => turn(brief), 600);
let line = "";
process.stdin.on("data", (data) => {
  const text = data.toString();
  if (text.includes("\x03")) process.exit(0);
  line += text.replace(/\x1b\[20[01]~/g, "");
  if (line.includes("\r")) {
    // Injecting into Claude Code parks any draft with a control key first.
    const sent = line.replace(/[\x00-\x1f\x7f]/g, "");
    line = "";
    turn(sent);
  }
});
setTimeout(() => process.exit(0), 170000);
`;

async function launch(env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-workspace-id="ws-notes"]')).toBeVisible({ timeout: 30_000 });
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.CODARA_PROOF_DIR;
  if (dir) await page.screenshot({ path: join(dir, name) });
}

// Two workspaces, a shell with no rc files, and a yes already given for Notes to
// open terminals in Repo (the card itself is covered by terminal-worktree.spec.ts).
async function workspaces(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const repo = join(root, "repo");
  const notes = join(root, "notes");
  const bin = join(root, "bin");
  const logs = join(root, "logs");
  await Promise.all([home, userHome, repo, notes, bin, logs].map((dir) => mkdir(dir)));
  await writeFile(join(bin, "claude"), FAKE_CLAUDE);
  await chmod(join(bin, "claude"), 0o755);
  const shell = join(bin, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(SPARK|CODARA)_/.test(key)) env[key] = value;
  }
  for (const key of ["SPARK_E2E_BACKGROUND", "CODARA_CHROME_LINK", "CODARA_DISABLE_KEYCHAIN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: userHome,
    USERPROFILE: userHome,
    SHELL: shell,
    FAKE_LOG_DIR: logs,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
  });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  await writeFile(join(repo, "README.md"), "# repo\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-notes",
      workspaces: [
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", workers: [] },
        { id: "ws-notes", name: "Notes", cwd: notes, color: "#78A8FF", workers: [] },
      ],
    }),
  );
  await writeFile(
    join(home, "cross-workspace-grants.json"),
    JSON.stringify({
      version: 1,
      grants: [
        {
          callerWorkspaceId: "ws-notes",
          callerName: "Notes",
          targetWorkspaceId: "ws-repo",
          targetName: "Repo",
          grantedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  return { root, home, repo, notes, logs, env };
}

test("an agent starts a session in another workspace, gets its answer back, and the session outlives it", async () => {
  test.skip(process.platform === "win32", "the stand-in agent is started from a POSIX shell");
  test.setTimeout(240_000);
  const { root, home, repo, notes, logs, env } = await workspaces("codara-agent-sessions-");

  const call = (method: string, params: Record<string, unknown> = {}) =>
    rpcRaw({ home }, method, params, { timeoutMs: 120_000 }) as Promise<{ result?: any; error?: { message: string } }>;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await call(method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const briefs = async () =>
    (await readFile(join(logs, "briefs.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { brief: string; argv: string[]; cwd: string });

  let running = await launch(env);
  try {
    const { page } = running;
    // Two agents are two processes, each in its own pane, as with real MCP servers.
    const agentIn = async (title: string) => {
      const pidFile = join(root, `${title.replace(/\W/g, "-")}.pid`);
      const pane = await request("terminal.create", { cwd: notes, title, command: `sh -c 'echo $$ > "${pidFile}"; exec sleep 600'` });
      await expect.poll(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim(), { timeout: 20_000 }).not.toBe("");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      return { pane, params: { callerRole: "studio", callerClient: "claude-code", callerPid: pid } };
    };
    const { pane: coordinator, params: caller } = await agentIn("coordinator");
    const { params: later } = await agentIn("another agent");
    const hostile = `Line one\nit's "quoted" \`touch ${join(root, "pwned")}\` $(touch ${join(root, "pwned")}) ; rm -rf ~\n${"long ".repeat(4_000)}`;
    let started: any;

    await test.step("a long, hostile brief arrives whole and nothing in it runs", async () => {
      started = await request("session.start", {
        ...caller,
        workspace: "ws-repo",
        brief: hostile,
        runtime: "claude",
        model: "stand-in-model",
        effort: "high",
        title: "Fix the docs",
      });
      expect(started.id).toMatch(/^as-/);
      expect(started.workspaceId).toBe("ws-repo");
      expect(["starting", "working"]).toContain(started.status);
      await expect.poll(async () => (await briefs()).length, { timeout: 20_000 }).toBe(1);
      const [first] = await briefs();
      expect(first!.brief).toBe(hostile);
      expect(first!.argv).toContain("stand-in-model");
      expect(first!.cwd).toBe(repo);
      await expect.poll(async () => (await readdir(root)).includes("pwned")).toBe(false);
    });

    await test.step("the result comes back by itself, with the final message", async () => {
      const done = await request("session.wait", { ...caller, ids: [started.id], timeoutSeconds: 30 });
      expect(done.reason).toBe("any_settled");
      expect(done.sessions[0].status).toBe("finished");
      expect(done.sessions[0].finalMessage).toContain("Answer 1 to: Line one");
      await expect
        .poll(async () => (await readdir(join(home, "agent-session-briefs")).catch(() => [])).length)
        .toBe(0);
    });

    await test.step("its row in the target workspace's rail opens its real tab", async () => {
      const line = page.locator('[data-rail-children-of="ws-repo"]').getByTestId("workspace-agent-line");
      await page.locator('[data-workspace-id="ws-repo"]').click();
      await expect(page.locator(`[data-terminal-pane-id="${started.paneId}"]:visible`)).toBeVisible({ timeout: 20_000 });
      await shot(page, "session-in-target-workspace.png");
      await page.locator('[data-workspace-id="ws-notes"]').click();
      await expect(page.locator(`[data-terminal-pane-id="${coordinator.paneId}"]:visible`)).toBeVisible();
      const toggle = page.locator('[data-workspace-id="ws-repo"]').getByTestId("workspace-children-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      await expect(line).toHaveCount(1, { timeout: 20_000 });
      await line.click();
      await expect(page.locator(`[data-terminal-pane-id="${started.paneId}"]:visible`)).toBeVisible({ timeout: 10_000 });
    });

    await test.step("a follow-up starts a new turn, and the wait is for that turn", async () => {
      const sent = await request("session.message", { ...caller, id: started.id, text: "slow follow up" });
      expect(sent.finalMessage).toBeNull();
      const short = await request("session.wait", { ...caller, ids: [started.id], timeoutSeconds: 1 });
      expect(short.reason).toBe("timeout");
      expect(short.sessions[0].status).toBe("working");
      const refused = await call("session.message", { ...caller, id: started.id, text: "again" });
      expect(refused.error?.message).toMatch(/working/);
      const done = await request("session.wait", { ...caller, ids: [started.id], timeoutSeconds: 30 });
      expect(done.sessions[0].finalMessage).toContain("Answer 2 to: slow follow up");
    });

    await test.step("a later agent finds it but cannot write to it", async () => {
      const listed = await request("session.status", later);
      expect(listed.sessions.map((session: { id: string }) => session.id)).toContain(started.id);
      const refused = await call("session.message", { ...later, id: started.id, text: "not yours" });
      expect(refused.error?.message).toMatch(/only the agent that started/);
    });

    let asking: any;
    await test.step("a session in a new worktree that needs the user stops the wait", async () => {
      asking = await request("session.start", {
        ...caller,
        workspace: "ws-repo",
        brief: "Run the tests, permission needed",
        runtime: "claude",
        worktree: { branch: "agent/session-e2e", purpose: "session e2e" },
      });
      expect(asking.branch).toBe("agent/session-e2e");
      expect(asking.workspaceId).not.toBe("ws-repo");
      const stopped = await request("session.wait", { ...caller, ids: [asking.id], timeoutSeconds: 30 });
      expect(stopped.sessions[0].status).toBe("needs_you");
      expect(stopped.sessions[0].detail).toContain("Allow npm test?");
      const refused = await call("session.message", { ...caller, id: asking.id, text: "yes" });
      expect(refused.error?.message).toMatch(/waiting for the user/);
      await expect.poll(async () => (await briefs()).at(-1)?.cwd).toBe(asking.cwd);
    });

    await test.step("requests that must not launch anything are refused", async () => {
      const flag = await call("session.start", { ...caller, brief: "x", runtime: "claude", model: "--dangerously-skip-permissions" });
      expect(flag.error?.message).toMatch(/plain model name/);
      const worker = await call("session.start", { ...caller, callerRole: "worker", brief: "x", runtime: "claude" });
      expect(worker.error?.message).toMatch(/can start sessions/);
      const unknown = await call("session.status", { ...caller, id: "as-nope" });
      expect(unknown.error?.message).toMatch(/no session/);
    });

    await test.step("it keeps running when its caller closes, and after a restart its record is still there", async () => {
      const slow = await request("session.start", { ...caller, workspace: "ws-repo", brief: "slow work", runtime: "claude" });
      await request("terminal.close", { paneId: coordinator.paneId }).catch(() => undefined);
      await running.app.evaluate(() => undefined);
      const seen = await request("session.wait", { ...later, ids: [slow.id], timeoutSeconds: 30 });
      expect(seen.sessions[0].status).toBe("finished");
      expect(seen.sessions[0].finalMessage).toContain("Answer 1 to: slow work");

      const before = (await briefs()).length;
      await running.app.close();
      running = await launch(env);
      await running.page.locator('[data-workspace-id="ws-notes"]').click();
      const { params: nextSession } = await agentIn("next session");
      const relaunched = await request("session.status", { ...nextSession, id: slow.id });
      expect(relaunched.finalMessage).toContain("Answer 1 to: slow work");
      await running.page.waitForTimeout(2_000);
      expect((await briefs()).length).toBe(before);
    });
  } finally {
    await running.app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a background agent's row says where the work is and opens that session", async () => {
  test.skip(process.platform === "win32", "the stand-in agent is started from a POSIX shell");
  test.setTimeout(120_000);
  const { root, home, notes, logs, env } = await workspaces("codara-background-row-");
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 90_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const { app, page } = await launch(env);
  try {
    // The session a background subagent lives in: an agent on the board.
    const coordinator = await request("terminal.create", { cwd: notes, title: "coordinator", command: "claude hello" });
    await expect.poll(async () => (await readFile(join(logs, "briefs.jsonl"), "utf8").catch(() => "")).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const made = await request("worktree.create", {
      callerRole: "studio",
      callerClient: "claude-code",
      callerPaneId: coordinator.paneId,
      workspace: "ws-repo",
      branch: "agent/background-row",
      purpose: "background row",
      fetch: false,
    });
    await request("workspace.status", {
      callerClient: "claude-code",
      callerPaneId: coordinator.paneId,
      worktree: made.path,
      status: "in_progress",
      note: "Working on the docs",
    });
    const row = page.locator(`[data-workspace-id="${made.workspaceId}"]`);
    await expect(row).toBeAttached({ timeout: 20_000 });
    await row.click();
    // The worktree's workspace shows an idle chat of its own, so this line is
    // the only thing that says the work is elsewhere.
    const notice = page.getByTestId("background-agent-notice");
    await expect(notice).toContainText("A background agent works in this folder, from the session in Notes.", { timeout: 20_000 });
    await shot(page, "background-agent-notice.png");
    await page.getByTestId("background-agent-open-origin").click();
    await expect(page.locator(`[data-terminal-pane-id="${coordinator.paneId}"]:visible`)).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveCount(0);

    await row.click();
    await expect(notice).toBeVisible({ timeout: 10_000 });
    // Its row in the Agents view goes to the session too, not to this worktree.
    await page.getByRole("tab", { name: /^Agents/ }).click();
    await page.locator(".agent-inbox-row", { hasText: "background row" }).first().click();
    await expect(page.locator(`[data-terminal-pane-id="${coordinator.paneId}"]:visible`)).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
