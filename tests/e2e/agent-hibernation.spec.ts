import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Agent hibernation end to end: a finished Claude pane in a background
// workspace is stopped after the idle time and resumed with `--resume` when
// the user opens its workspace again, or on the next launch when Codara quit
// while it slept. A pane pinned "Keep awake" and a pane whose agent runs a
// command (a dev server) are never stopped.
//
// The fake `claude` is a Node script so the process census sees it the way
// it sees the real CLI ("node …/claude --resume <id>"). It records every
// launch (argv and pid) so the test can prove the stop and the resume. The
// idle time and the timer are shortened through the e2e-only overrides
// (honored only with SPARK_E2E_BACKGROUND=1, which playwright.config sets).

test.skip(process.platform === "win32", "The fake agent is a POSIX script; the Windows census is covered by unit tests");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PANE_ID = "restored-pane";
const IDLE_MS = 3_000;
const TICK_MS = 1_000;

type Mode = "plain" | "dev-server";

interface Fixture {
  root: string;
  userDataDir: string;
  binDir: string;
  workspaceA: string;
  claudeConfigDir: string;
  launchLog: string;
  childPidFile: string;
}

interface Launch {
  pid: number;
  args: string[];
}

test("an idle Claude pane in a background workspace sleeps and resumes when opened", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture("plain");
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
    const first = await waitForLaunches(fixture, 1);
    expect(first[0].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    expect(isAlive(first[0].pid)).toBe(true);

    const workspaceA = page.locator('[data-workspace-id="ws-a"]');
    // The pane's xterm (and the output in it) must be the same object after
    // the sleep and the wake: the pane is kept, only its processes stop.
    const terminalNode = page.locator(`[data-terminal-pane-id="${PANE_ID}"] .xterm`).first();
    await terminalNode.evaluate((node) => {
      (window as unknown as { __codaraKeptTerminalNode?: Element }).__codaraKeptTerminalNode = node;
    });
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());

    const sleepingChip = page.locator(`[data-terminal-pane-id="${PANE_ID}"] [data-testid="pane-sleeping-chip"]`);
    await expect(sleepingChip, logs.join("\n")).toHaveAttribute("aria-label", "CLAUDE sleeping", {
      timeout: 25_000,
    });
    // Stopped for real, and the workspace still counts it, as asleep.
    await expect.poll(() => isAlive(first[0].pid), { timeout: 10_000 }).toBe(false);
    const count = workspaceA.getByTestId("workspace-agent-count");
    await expect(count).toHaveAttribute("aria-label", /1 sleeping$/);
    await expect(count).toHaveAttribute("data-sleeping", "1");
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} claude is sleeping`))).toBe(true);

    // Opening the workspace resumes the same session in the same pane.
    await workspaceA.evaluate((row) => (row as HTMLElement).click());
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    expect(launches[1].pid).not.toBe(first[0].pid);
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    await expect(count).not.toHaveAttribute("data-sleeping", /.+/);
    expect(
      await terminalNode.evaluate(
        (node) => (window as unknown as { __codaraKeptTerminalNode?: Element }).__codaraKeptTerminalNode === node,
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a pane still asleep when Codara quits resumes its session on the next launch", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture("plain");
  let { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    const sleepingChip = page.locator(`[data-terminal-pane-id="${PANE_ID}"] [data-testid="pane-sleeping-chip"]`);
    await expect(sleepingChip, logs.join("\n")).toHaveAttribute("aria-label", "CLAUDE sleeping", {
      timeout: 25_000,
    });
    await expect.poll(() => isAlive(first.pid), { timeout: 10_000 }).toBe(false);

    // Quit with the agent asleep: no agent process runs in the pane, yet it
    // must count as a running session for the relaunch restore.
    await app.close();
    ({ app, page, logs } = await launch(fixture, { seed: false }));
    await page.locator('[data-workspace-id="ws-a"]').evaluate((row) => (row as HTMLElement).click());
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("Keep awake stops a pane from sleeping", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture("plain");
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
    const [first] = await waitForLaunches(fixture, 1);
    const pin = page.locator(`[data-terminal-pane-id="${PANE_ID}"]`).getByRole("button", { name: "Keep awake" });
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.evaluate((button) => (button as HTMLElement).click());
    await expect(pin).toHaveAttribute("aria-pressed", "true");

    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    // Several idle periods and ticks: long enough for the first test's pane
    // to have slept many times over.
    await page.waitForTimeout(IDLE_MS * 3 + TICK_MS * 4);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(logs.some((line) => line.includes("is sleeping"))).toBe(false);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a pane whose agent runs a dev server stays awake", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture("dev-server");
  const { app, page, logs } = await launch(fixture);
  let childPid = 0;
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 20_000 });
    const [first] = await waitForLaunches(fixture, 1);
    childPid = await waitForChildPid(fixture);
    expect(isAlive(childPid)).toBe(true);

    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await expect
      .poll(() => logs.some((line) => line.includes(`pane=${PANE_ID} stays awake: other-processes`)), {
        timeout: 25_000,
      })
      .toBe(true);
    await page.waitForTimeout(TICK_MS * 3);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
  } finally {
    await app.close();
    if (childPid > 0 && isAlive(childPid)) process.kill(childPid, "SIGKILL");
    await cleanup(fixture);
  }
});

async function launch(
  fixture: Fixture,
  { seed = true }: { seed?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page; logs: string[] }> {
  const fixtureShell = join(fixture.binDir, "bash");
  await writeFile(fixtureShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(fixtureShell, 0o755);
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODEX_HOME: join(fixture.userDataDir, "codex-home"),
      GROK_HOME: join(fixture.userDataDir, "grok-home"),
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
      SHELL: fixtureShell,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      CODARA_E2E_HIBERNATION_IDLE_MS: String(IDLE_MS),
      CODARA_E2E_HIBERNATION_TICK_MS: String(TICK_MS),
    },
  });
  const logs: string[] = [];
  app.process().stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.includes("[agent-hibernation]")) logs.push(line.trim());
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // A relaunch keeps whatever the previous run persisted at quit.
  if (!seed) return { app, page, logs };
  // A restored Claude pane, the shape a relaunch with session restore on
  // gives: bootResume runs `claude --resume <id>` in it. Installed on the new
  // document before Codara hydrates (see terminal-hidden-workspace-state).
  await page.addInitScript(
    ({ workspaceA, sessionId, paneId }) => {
      localStorage.setItem(
        "spark.tabs:ws-a",
        JSON.stringify({
          v: 6,
          tabs: [
            {
              id: "restored-terminal",
              kind: "terminal",
              title: "terminals",
              activePaneId: paneId,
              root: {
                kind: "leaf",
                paneId,
                cwd: workspaceA,
                agentSession: {
                  runtime: "claude",
                  sessionId,
                  cwd: workspaceA,
                  capturedAt: "2026-07-18T00:00:00.000Z",
                  active: true,
                },
              },
            },
          ],
          activeId: "restored-terminal",
        }),
      );
    },
    { workspaceA: fixture.workspaceA, sessionId: SESSION_ID, paneId: PANE_ID },
  );
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs };
}

async function readLaunches(fixture: Fixture): Promise<Launch[]> {
  const text = await readFile(fixture.launchLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Launch);
}

async function waitForLaunches(fixture: Fixture, count: number): Promise<Launch[]> {
  await expect.poll(async () => (await readLaunches(fixture)).length, { timeout: 20_000 }).toBe(count);
  return readLaunches(fixture);
}

async function waitForChildPid(fixture: Fixture): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        pid = Number((await readFile(fixture.childPidFile, "utf8").catch(() => "")).trim());
        return pid > 0;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
}

async function prepareFixture(mode: Mode): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-agent-hibernation-e2e-"));
  const userDataDir = join(root, "user-data");
  const binDir = join(root, "bin");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const claudeConfigDir = join(root, "claude-config");
  const launchLog = join(root, "claude-launches.jsonl");
  const childPidFile = join(root, "dev-server.pid");
  const claudeProjectDir = join(claudeConfigDir, "projects", workspaceA.replace(/[^a-zA-Z0-9]/g, "-"));
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
    mkdir(claudeProjectDir, { recursive: true }),
  ]);
  await mkdir(join(claudeConfigDir, "shell-snapshots"), { recursive: true });
  await Promise.all([
    // Claude Code's Bash tool sources a snapshot of the user's shell first.
    writeFile(join(claudeConfigDir, "shell-snapshots", "snapshot-sh-1.sh"), ": snapshot\n", "utf8"),
    writeFile(join(workspaceA, "README.md"), "# workspace-a\n", "utf8"),
    writeFile(join(workspaceB, "README.md"), "# workspace-b\n", "utf8"),
  ]);

  // In dev-server mode the agent runs a long command the way Claude Code's
  // Bash tool does: a shell sourcing its snapshot, with the server under it.
  const devServer =
    mode === "dev-server"
      ? `
const { spawn } = require("node:child_process");
const tool = spawn("/bin/sh", ["-c", ". " + ${JSON.stringify(join(claudeConfigDir, "shell-snapshots", "snapshot-sh-1.sh"))} + " 2>/dev/null; sleep 600"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(tool.pid));
`
      : "";
  const fakeClaude = join(binDir, "claude");
  await writeFile(
    fakeClaude,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
${devServer}
process.stdout.write("Claude Code v2.1.261\\r\\n\\u276f \\r\\n? for shortcuts\\r\\n");
setInterval(() => {}, 1 << 30);
`,
    "utf8",
  );
  await chmod(fakeClaude, 0o755);

  await writeFile(
    join(claudeProjectDir, `${SESSION_ID}.jsonl`),
    '{"type":"user","message":{"role":"user","content":"hello"}}\n',
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ restoreAgentSessions: true, agentHibernationMinutes: 15 }),
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          { id: "ws-a", name: "workspace-a", cwd: workspaceA, color: "#34D3C3", workers: [] },
          { id: "ws-b", name: "workspace-b", cwd: workspaceB, color: "#78A8FF", workers: [] },
        ],
        activeWorkspaceId: "ws-a",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, binDir, workspaceA, claudeConfigDir, launchLog, childPidFile };
}
