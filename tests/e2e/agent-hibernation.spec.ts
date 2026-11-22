import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Agent hibernation end to end: an idle Claude pane is stopped after the idle
// time, shows a card, and comes back with `--resume` only when the user asks
// (Resume on its card, Enter in the pane); opening its workspace alone
// launches nothing. A pane asleep when Codara quits comes back asleep. The
// pane with the keyboard, a pane pinned "Keep running" and a pane whose agent
// runs a command are never stopped.
//
// The fake `claude` is a Node script, so the process census sees it the way it
// sees the real CLI: on POSIX "node …/claude --resume <id>", on Windows
// "node.exe …\@anthropic-ai\claude-code\cli.js" under a `claude.cmd` shim. It
// records every launch (argv and pid) so the test can prove the stop and the
// resume. The idle time, the timer and the binary are set through the e2e-only
// overrides (honored only with SPARK_E2E_BACKGROUND=1, which playwright.config
// sets); the binary override keeps a developer's own `claude.exe` out of it.

const WINDOWS = process.platform === "win32";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PANE_ID = "restored-pane";
const SHELL_PANE_ID = "shell-pane";
const IDLE_MS = 3_000;
const TICK_MS = 1_000;
// Every tick on Windows lists processes through PowerShell (a CIM query).
const SLEEP_TIMEOUT = WINDOWS ? 60_000 : 25_000;
const TEST_TIMEOUT = WINDOWS ? 180_000 : 90_000;
const RELAUNCH_TEST_TIMEOUT = WINDOWS ? 240_000 : 120_000;

type Mode = "plain" | "dev-server";

interface FixtureOptions {
  activeWorkspaceId?: string;
  // A split in ws-a: the agent pane and a plain shell that has the keyboard.
  withShellPane?: boolean;
}

interface Fixture {
  root: string;
  userDataDir: string;
  binDir: string;
  fakeClaude: string;
  workspaceA: string;
  claudeConfigDir: string;
  launchLog: string;
  childPidFile: string;
  options: FixtureOptions;
}

interface Launch {
  pid: number;
  args: string[];
}

const pane = (page: Page, paneId = PANE_ID) => page.locator(`[data-terminal-pane-id="${paneId}"]`);
const sleepingChip = (page: Page) => pane(page).locator('[data-testid="pane-sleeping-chip"]');
const sleepingCard = (page: Page) => pane(page).getByTestId("pane-sleeping-card");

async function expectAsleep(page: Page, logs: string[], first: Launch): Promise<void> {
  await expect(sleepingChip(page), logs.join("\n")).toHaveAttribute("aria-label", "CLAUDE sleeping", {
    timeout: SLEEP_TIMEOUT,
  });
  // Stopped for real.
  await expect.poll(() => isAlive(first.pid), { timeout: 15_000 }).toBe(false);
}

async function expectNoLaunchFor(fixture: Fixture, count: number, ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect((await readLaunches(fixture)).length).toBe(count);
}

test("an idle Claude pane in a background workspace sleeps, shows its card, and resumes only on Resume", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("plain");
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const first = await waitForLaunches(fixture, 1);
    expect(first[0].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    expect(isAlive(first[0].pid)).toBe(true);

    const workspaceA = page.locator('[data-workspace-id="ws-a"]');
    // The pane's xterm (and the output in it) must be the same object after
    // the sleep and the wake: the pane is kept, only its processes stop.
    const terminalNode = pane(page).locator(".xterm").first();
    await terminalNode.evaluate((node) => {
      (window as unknown as { __codaraKeptTerminalNode?: Element }).__codaraKeptTerminalNode = node;
    });
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());

    await expectAsleep(page, logs, first[0]);
    // The workspace still counts it, as asleep.
    await expect(workspaceA).toHaveAttribute("data-agent-sleeping", "1");
    await expect(workspaceA.getByTestId("workspace-tab-count")).toHaveAttribute("aria-label", /, 1 agent sleeping$/);
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} claude is sleeping (background-workspace`))).toBe(true);
    const mainLog = await readFile(join(fixture.userDataDir, "logs", "main.log"), "utf8");
    expect(mainLog).toContain(`pane=${PANE_ID} claude is sleeping (background-workspace`);

    // Opening the workspace shows the card and launches nothing.
    await workspaceA.evaluate((row) => (row as HTMLElement).click());
    await expect(sleepingCard(page)).toBeVisible();
    await expect(sleepingCard(page).getByTestId("pane-sleeping-title")).toHaveText("Claude Code session");
    await expectNoLaunchFor(fixture, 1, TICK_MS * 3);

    // Resume brings the same session back in the same pane.
    await sleepingCard(page).getByTestId("pane-resume").click();
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    expect(launches[1].pid).not.toBe(first[0].pid);
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    await expect(page.getByTestId("pane-sleeping-card")).toHaveCount(0);
    await expect(workspaceA).not.toHaveAttribute("data-agent-sleeping");
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

test("a pane still asleep when Codara quits comes back asleep and resumes on Resume", async () => {
  test.setTimeout(RELAUNCH_TEST_TIMEOUT);
  const fixture = await prepareFixture("plain");
  let { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await expectAsleep(page, logs, first);

    // Quit with the agent asleep: the relaunch must keep its session but
    // launch nothing for it. The pane comes back asleep, with its card.
    await app.close();
    ({ app, page, logs } = await launch(fixture, { seed: false }));
    await page.locator('[data-workspace-id="ws-a"]').evaluate((row) => (row as HTMLElement).click());
    await expect(sleepingCard(page), logs.join("\n")).toBeVisible({ timeout: 30_000 });
    await expectNoLaunchFor(fixture, 1, TICK_MS * 4);
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} claude restored asleep`)), logs.join("\n")).toBe(true);

    await sleepingCard(page).getByTestId("pane-resume").click();
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("an agent restored into a background workspace at launch can sleep too", async () => {
  test.setTimeout(TEST_TIMEOUT);
  // Codara reopens on workspace B; A's agent is restored behind it, so A's
  // pane mounts hidden and its one-shot restore marker is never consumed.
  const fixture = await prepareFixture("plain", { activeWorkspaceId: "ws-b" });
  const { app, page, logs } = await launch(fixture);
  try {
    const [first] = await waitForLaunches(fixture, 1);
    expect(first.args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    await expectAsleep(page, logs, first);

    // Shown, it stays asleep; Enter in the pane is the user asking for it.
    await page.locator('[data-workspace-id="ws-a"]').evaluate((row) => (row as HTMLElement).click());
    await expect(sleepingCard(page)).toBeVisible();
    await expectNoLaunchFor(fixture, 1, TICK_MS * 2);
    await pane(page).locator(".xterm").first().click();
    await page.keyboard.press("Shift");
    await expectNoLaunchFor(fixture, 1, 500);
    await page.keyboard.press("Enter");
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    // Woken once, never resumed a second time by the restore marker.
    await page.waitForTimeout(TICK_MS * 2);
    expect((await readLaunches(fixture)).length).toBe(2);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a pane asleep when the window reloads stays asleep and resumes on Resume", async () => {
  test.setTimeout(RELAUNCH_TEST_TIMEOUT);
  const fixture = await prepareFixture("plain");
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await expectAsleep(page, logs, first);

    // With session restore off, nothing but main's sleeping record can bring
    // the agent back after the reload; the pane's own mark and its xterm are
    // gone with it, so main also hands the fresh view the pane's output.
    await page.evaluate(() =>
      (window as unknown as {
        spark: { preferences: { set: (key: string, value: boolean) => Promise<unknown> } };
      }).spark.preferences.set("restoreAgentSessions", false),
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('[data-workspace-id="ws-a"]').evaluate((row) => (row as HTMLElement).click());
    await expect(sleepingCard(page), logs.join("\n")).toBeVisible({ timeout: 30_000 });
    await expectNoLaunchFor(fixture, 1, TICK_MS * 2);
    await sleepingCard(page).getByTestId("pane-resume").click();
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const mounted = logs.find((line) => line.includes(`pane=${PANE_ID} mounts asleep`)) ?? "";
    expect(Number(/\((\d+) bytes of output kept\)/.exec(mounted)?.[1] ?? 0), logs.join("\n")).toBeGreaterThan(0);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a visible pane without the keyboard sleeps, Enter in it resumes, and the focused pane never sleeps", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("plain", { withShellPane: true });
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    // Workspace A stays on screen: the agent pane is visible, the shell pane
    // beside it has the keyboard.
    await expectAsleep(page, logs, first);
    await expect(sleepingCard(page)).toBeVisible();
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} claude is sleeping (visible`)), logs.join("\n")).toBe(true);
    await expectNoLaunchFor(fixture, 1, TICK_MS * 3);

    // Enter in the sleeping pane is the user asking for it back.
    await pane(page).locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect(pane(page).locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Shift");
    await expectNoLaunchFor(fixture, 1, 500);
    await page.keyboard.press("Enter");
    const launches = await waitForLaunches(fixture, 2);
    expect(launches[1].args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });

    // Now the agent pane has the keyboard: it never sleeps.
    await page.waitForTimeout(IDLE_MS * 3 + TICK_MS * 4);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(launches[1].pid)).toBe(true);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("Keep running stops a pane from sleeping", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("plain");
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    const pin = pane(page).getByRole("button", { name: "Keep running" });
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

test("critical memory lets an idle agent sleep sooner than the setting", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("plain");
  // The setting's idle time never elapses in this test; only the pressure
  // floor can let the pane sleep.
  const { app, page, logs } = await launch(fixture, {
    env: {
      CODARA_E2E_HIBERNATION_IDLE_MS: String(10 * 60_000),
      CODARA_E2E_HIBERNATION_PRESSURE_IDLE_MS: String(IDLE_MS),
      CODARA_E2E_MEMORY_LEVEL: "critical",
    },
  });
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await expectAsleep(page, logs, first);
    expect(
      logs.some((line) => line.includes("is sleeping") && line.includes("memory critical")),
      logs.join("\n"),
    ).toBe(true);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a pane whose agent runs a command stays awake", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("dev-server");
  const { app, page, logs } = await launch(fixture);
  let childPid = 0;
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    childPid = await waitForChildPid(fixture);
    expect(isAlive(childPid)).toBe(true);

    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await expect
      .poll(
        () =>
          logs.some((line) => line.includes(`pane=${PANE_ID} stays awake: other-processes (tool shell`)) ||
          logs.join("\n"),
        { timeout: SLEEP_TIMEOUT },
      )
      .toBe(true);
    await page.waitForTimeout(TICK_MS * 3);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
  } finally {
    // The command first: left running, it holds the pane's console open.
    if (childPid > 0 && isAlive(childPid)) killTree(childPid);
    await app.close();
    await cleanup(fixture);
  }
});

async function launch(
  fixture: Fixture,
  { seed = true, env = {} }: { seed?: boolean; env?: Record<string, string> } = {},
): Promise<{ app: ElectronApplication; page: Page; logs: string[] }> {
  const fixtureShell = join(fixture.binDir, "bash");
  if (!WINDOWS) {
    await writeFile(fixtureShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
    await chmod(fixtureShell, 0o755);
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODEX_HOME: join(fixture.userDataDir, "codex-home"),
      GROK_HOME: join(fixture.userDataDir, "grok-home"),
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
      // Windows picks PowerShell for the pane itself.
      ...(WINDOWS ? {} : { SHELL: fixtureShell }),
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      CODARA_E2E_BIN_CLAUDE: fixture.fakeClaude,
      CODARA_E2E_HIBERNATION_IDLE_MS: String(IDLE_MS),
      CODARA_E2E_HIBERNATION_TICK_MS: String(TICK_MS),
      ...env,
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
  const restored = {
    kind: "leaf",
    paneId: PANE_ID,
    cwd: fixture.workspaceA,
    agentSession: {
      runtime: "claude",
      sessionId: SESSION_ID,
      cwd: fixture.workspaceA,
      capturedAt: "2026-07-18T00:00:00.000Z",
      active: true,
    },
  };
  const root = fixture.options.withShellPane
    ? { kind: "split", direction: "horizontal", ratio: 0.5, a: restored, b: { kind: "leaf", paneId: SHELL_PANE_ID, cwd: fixture.workspaceA } }
    : restored;
  await page.addInitScript(
    ({ root, activePaneId }) => {
      localStorage.setItem(
        "spark.tabs:ws-a",
        JSON.stringify({
          v: 6,
          tabs: [{ id: "restored-terminal", kind: "terminal", title: "terminals", activePaneId, root }],
          activeId: "restored-terminal",
        }),
      );
    },
    { root, activePaneId: fixture.options.withShellPane ? SHELL_PANE_ID : PANE_ID },
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
  await expect.poll(async () => (await readLaunches(fixture)).length, { timeout: 30_000 }).toBe(count);
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
      { timeout: 15_000 },
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

function killTree(pid: number): void {
  if (WINDOWS) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  // A fake agent or its child left running holds the fixture folder open on
  // Windows; end every one the run recorded before removing it.
  for (const launch of await readLaunches(fixture)) {
    if (isAlive(launch.pid)) killTree(launch.pid);
  }
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => undefined);
}

async function prepareFixture(mode: Mode, options: FixtureOptions = {}): Promise<Fixture> {
  // The real path: Claude's project folder is named after the cwd the app
  // sees, so a short (8.3) or differently cased temp path would not match.
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-agent-hibernation-e2e-")));
  const userDataDir = join(root, "user-data");
  const binDir = join(root, "bin");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const claudeConfigDir = join(root, "claude-config");
  const launchLog = join(root, "claude-launches.jsonl");
  const childPidFile = join(root, "dev-server.pid");
  const claudeProjectDir = join(claudeConfigDir, "projects", workspaceA.replace(/[^a-zA-Z0-9]/g, "-"));
  const packageDir = join(root, "pkg", "node_modules", "@anthropic-ai", "claude-code");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
    mkdir(claudeProjectDir, { recursive: true }),
    mkdir(packageDir, { recursive: true }),
  ]);
  await mkdir(join(claudeConfigDir, "shell-snapshots"), { recursive: true });
  await Promise.all([
    // Claude Code's Bash tool sources a snapshot of the user's shell first.
    writeFile(join(claudeConfigDir, "shell-snapshots", "snapshot-sh-1.sh"), ": snapshot\n", "utf8"),
    writeFile(join(workspaceA, "README.md"), "# workspace-a\n", "utf8"),
    writeFile(join(workspaceB, "README.md"), "# workspace-b\n", "utf8"),
  ]);

  // In dev-server mode the agent runs a long command the way Claude Code's
  // shell tool does: a shell sourcing its snapshot on POSIX, the code page
  // switch and PowerShell on Windows, with the command under it.
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const devServer =
    mode !== "dev-server"
      ? ""
      : WINDOWS
        ? `
const { spawn } = require("node:child_process");
const tool = spawn("cmd.exe", ["/d", "/s", "/c", ${JSON.stringify(`""C:\\WINDOWS\\System32\\chcp.com" 65001 >nul & "${powershell}" -NoProfile -Command "Start-Sleep 600""`)}], { stdio: "ignore", windowsVerbatimArguments: true, windowsHide: true });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(tool.pid));
`
        : `
const { spawn } = require("node:child_process");
const tool = spawn("/bin/sh", ["-c", ". " + ${JSON.stringify(join(claudeConfigDir, "shell-snapshots", "snapshot-sh-1.sh"))} + " 2>/dev/null; sleep 600"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(tool.pid));
`;
  const body = `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
${devServer}
process.stdout.write("Claude Code v2.1.261\\r\\n\\u276f \\r\\n? for shortcuts\\r\\n");
setInterval(() => {}, 1 << 30);
`;
  let fakeClaude: string;
  if (WINDOWS) {
    const cli = join(packageDir, "cli.js");
    await writeFile(cli, body, "utf8");
    fakeClaude = join(binDir, "claude.cmd");
    await writeFile(fakeClaude, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`, "utf8");
  } else {
    fakeClaude = join(binDir, "claude");
    await writeFile(fakeClaude, `#!${process.execPath}\n${body}`, "utf8");
    await chmod(fakeClaude, 0o755);
  }

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
        activeWorkspaceId: options.activeWorkspaceId ?? "ws-a",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, binDir, fakeClaude, workspaceA, claudeConfigDir, launchLog, childPidFile, options };
}
