import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// CI (ci-linux.yml) runs the tests tagged @ci: the quick ones that cover the
// idle clock, unsent text and the memory a sleep gives back.
//
// Agent hibernation end to end: an idle Claude pane is stopped after the idle
// time, shows a card, and comes back with `--resume` only when the user asks
// (Resume on its card, Enter in the pane); opening its workspace alone
// launches nothing. A pane asleep when Codara quits comes back asleep. The
// pane with the keyboard, a pane pinned "Keep running", a pane whose agent
// runs a command and a workspace set to Never are never stopped.
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

// plain: prints its prompt once and stays quiet. dev-server: also runs a long
// command the way Claude Code's shell tool does. repaint: repaints a status
// line every second the way Claude Code's statusLine refreshInterval does,
// takes typed text into its box, and turns a submit into a short turn.
// working: starts a turn at launch and never ends it, painting its spinner.
// memory: holds a fixed buffer and starts an MCP-like child holding another.
type Mode = "plain" | "dev-server" | "repaint" | "working" | "memory";

// What the memory fake and its child hold, filled so every page is resident.
const AGENT_HOLD_MB = 160;
const CHILD_HOLD_MB = 64;

interface FixtureOptions {
  activeWorkspaceId?: string;
  // A split in ws-a: the agent pane and a plain shell that has the keyboard.
  withShellPane?: boolean;
  prefs?: Record<string, unknown>;
  // The title Claude Code gave the session, as its transcript records it.
  aiTitle?: string;
  // The fake reports its turns through Claude Code's hooks, as codara-hook.py
  // drops them in <codara home>/hooks.
  hooks?: boolean;
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
  // The pane's shell, which ran the fake.
  ppid?: number;
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
  const fixture = await prepareFixture("plain", { aiTitle: "Fix the zebra parser" });
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
    await expect(sleepingCard(page).getByTestId("pane-sleeping-title"), logs.join("\n")).toHaveText("Fix the zebra parser");
    // The line is the user's content: it never reaches the log.
    expect(logs.some((line) => line.includes("zebra"))).toBe(false);
    // What the pane's processes held, when it could be read in time (the
    // memory test and the unit tests pin the figure itself): the card says
    // what the log says, and nothing when the log has no figure.
    const sleptLine = logs.find((line) => line.includes(`pane=${PANE_ID} claude is sleeping`)) ?? "";
    if (/freed \d+ MB/.test(sleptLine)) await expect(sleepingCard(page)).toContainText(/freed \d+ MB/);
    else await expect(sleepingCard(page)).not.toContainText(/freed \d+ MB/);
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
    // Off the centred pill: the scrim lets the click reach the terminal.
    await pane(page).locator(".xterm").first().click({ position: { x: 24, y: 24 } });
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
    // The layout Codara itself saved, with no session pointer in it now:
    // the reload must not get the seeded one back.
    await page.evaluate(() => sessionStorage.setItem("codara-e2e-keep-layout", "1"));
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

test("a workspace set to Never keeps its agents running", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("plain", { prefs: { agentHibernationWorkspaces: { "ws-a": 0 } } });
  const { app, page, logs } = await launch(fixture);
  try {
    await expect(page.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 30_000 });
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await page.waitForTimeout(IDLE_MS * 3 + TICK_MS * 4);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(logs.some((line) => line.includes("is sleeping")), logs.join("\n")).toBe(false);
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

test("an idle Claude with hooks sleeps although its status line repaints every second", { tag: "@ci" }, async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("repaint", { hooks: true });
  const { app, page, logs } = await launch(fixture);
  try {
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await expectAsleep(page, logs, first);
    // It slept on the clock of its state, not of its screen.
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} stays awake: not-idle-long-enough (pty output`)), logs.join("\n")).toBe(false);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("without hooks or program status, a repainting screen keeps the agent awake", async () => {
  test.setTimeout(TEST_TIMEOUT);
  // Screen-only evidence: a repaint cannot be told from a working frame the
  // notifier missed, so every byte stays on the clock.
  const fixture = await prepareFixture("repaint");
  const { app, page, logs } = await launch(fixture);
  try {
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    await page.waitForTimeout(IDLE_MS * 3 + TICK_MS * 4);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(logs.some((line) => /stays awake: not-idle-long-enough \((pty|agent) output/.test(line)), logs.join("\n")).toBe(true);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a working Claude that paints its spinner never sleeps", { tag: "@ci" }, async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("working", { hooks: true });
  const { app, page, logs } = await launch(fixture);
  try {
    const [first] = await waitForLaunches(fixture, 1);
    await page.locator('[data-workspace-id="ws-b"]').evaluate((row) => (row as HTMLElement).click());
    // Its working chip keeps the renderer from asking; main would refuse it
    // as agent-busy anyway (scripts/test-agent-hibernation-main.cjs).
    await page.waitForTimeout(IDLE_MS * 3 + TICK_MS * 4);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(logs.some((line) => line.includes("is sleeping")), logs.join("\n")).toBe(false);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("unsent text keeps a repainting Claude awake until Ctrl+C empties its box", { tag: "@ci" }, async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("repaint", { hooks: true, withShellPane: true });
  const { app, page, logs } = await launch(fixture);
  try {
    const [first] = await waitForLaunches(fixture, 1);
    // Type into the agent's box without sending it, then give the keyboard
    // back to the shell pane beside it.
    await pane(page).locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect(pane(page).locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.type("half a thought");
    await pane(page, SHELL_PANE_ID).locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect
      .poll(() => logs.some((line) => line.includes(`pane=${PANE_ID} stays awake: unsent-input`)) || logs.join("\n"), {
        timeout: SLEEP_TIMEOUT,
      })
      .toBe(true);
    await page.waitForTimeout(IDLE_MS + TICK_MS * 2);
    await expect(page.getByTestId("pane-sleeping-chip")).toHaveCount(0);
    expect(isAlive(first.pid)).toBe(true);

    // Ctrl+C empties the box: nothing is unsent any more, so it sleeps.
    await pane(page).locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect(pane(page).locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Control+C");
    await pane(page, SHELL_PANE_ID).locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expectAsleep(page, logs, first);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("Sleep now says why it leaves an agent running, then puts it to sleep at once and keeps the pin", async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("repaint", { hooks: true });
  // An idle time the test never reaches: only the button can put it to sleep,
  // and the pane keeps the keyboard throughout.
  const { app, page, logs } = await launch(fixture, { env: { CODARA_E2E_HIBERNATION_IDLE_MS: String(60 * 60_000) } });
  const shots = process.env.CODARA_E2E_SLEEP_NOW_SHOTS;
  try {
    const [first] = await waitForLaunches(fixture, 1);
    const sleepNow = pane(page).getByRole("button", { name: "Sleep now" });
    await expect(sleepNow).toHaveAttribute("title", "Sleep now: stops this agent and frees its memory. Resume brings it back.", {
      timeout: 30_000,
    });
    const pin = pane(page).getByRole("button", { name: "Keep running" });
    await pin.evaluate((button) => (button as HTMLElement).click());
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    if (shots) {
      await pane(page).hover();
      await shootBothThemes(page, shots, "sleep-now-button");
    }

    // Unsent text in the agent's box: refused, and said in words. The real
    // button, revealed by hovering the pane.
    const typeIntoAgent = async () => {
      await pane(page).locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
      await expect(pane(page).locator(".xterm-helper-textarea")).toBeFocused();
    };
    await typeIntoAgent();
    await page.keyboard.type("half a thought");
    await page.waitForTimeout(300);
    await pane(page).hover();
    await sleepNow.click();
    const said = "Its box may hold text you did not send. Send it, or clear it with Ctrl+C, then try again.";
    const notice = pane(page).getByTestId("pane-sleep-now-notice");
    await expect(notice, logs.join("\n")).toHaveText(said, { timeout: 15_000 });
    // Screen readers hear it from a region that was there all along.
    await expect(pane(page).getByTestId("pane-sleep-now-status")).toHaveText(said);
    await expect(sleepNow).toHaveAttribute("title", `Sleep now: ${said}`);
    if (shots) {
      await pane(page).hover();
      await shootBothThemes(page, shots, "sleep-now-refused");
    }
    expect(isAlive(first.pid)).toBe(true);
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} Sleep now refused: unsent-input`)), logs.join("\n")).toBe(true);

    // Ctrl+C empties the box; Sleep now, from the keyboard this time, then
    // stops it at once although the idle time is an hour away.
    await typeIntoAgent();
    await page.keyboard.press("Control+C");
    await page.waitForTimeout(300);
    await sleepNow.focus();
    await page.keyboard.down("Enter");
    await expectAsleep(page, logs, first);
    await expect(sleepingCard(page)).toBeVisible();
    await expect(sleepNow).toHaveCount(0);
    // The keyboard stays in the pane, on Resume; the Enter still held from
    // the press (a key repeat) does not wake the agent.
    const resume = sleepingCard(page).getByTestId("pane-resume");
    await expect(resume).toBeFocused();
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expectNoLaunchFor(fixture, 1, 1_500);
    await expect(sleepingCard(page)).toBeVisible();
    expect(logs.some((line) => line.includes(`pane=${PANE_ID} claude is sleeping (visible, Sleep now,`)), logs.join("\n")).toBe(true);
    if (shots) await shootBothThemes(page, shots, "sleep-now-asleep");

    // The pin was kept: resumed, the agent is pinned Keep running again.
    await resume.click();
    await waitForLaunches(fixture, 2);
    await expect(sleepingCard(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(pin).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a sleeping pane shows the moon and one pill centred at any size, and Shift+click resumes and keeps it running", { tag: "@ci" }, async () => {
  test.setTimeout(TEST_TIMEOUT);
  const fixture = await prepareFixture("repaint", { hooks: true, withShellPane: true });
  const { app, page, logs } = await launch(fixture, { env: { CODARA_E2E_HIBERNATION_IDLE_MS: String(60 * 60_000) } });
  const shots = process.env.CODARA_E2E_SLEEP_NOW_SHOTS;
  try {
    const [first] = await waitForLaunches(fixture, 1);
    const sleepNow = pane(page).getByRole("button", { name: "Sleep now" });
    await expect(sleepNow).toBeAttached({ timeout: 30_000 });
    // Until its first hook arrives the agent is known from its screen alone,
    // and Sleep now leaves it running while it repaints: press again, as a
    // user would, until it sleeps.
    await expect(async () => {
      if ((await sleepingChip(page).count()) === 0) await sleepNow.evaluate((button) => (button as HTMLElement).click());
      await expect(sleepingChip(page)).toHaveAttribute("aria-label", "CLAUDE sleeping", { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    expect(
      logs.filter((line) => line.includes(`pane=${PANE_ID} Sleep now refused:`)).every((line) => /agent-busy \(output \d+s ago\)|in-flight/.test(line)),
      logs.join("\n"),
    ).toBe(true);
    await expectAsleep(page, logs, first);
    await expect(sleepingCard(page)).toBeVisible();

    // The output stays under a scrim that lets the wheel through.
    const scrim = pane(page).getByTestId("pane-sleeping-scrim");
    await expect(scrim).toHaveCSS("pointer-events", "none");

    const offCentre = async () => {
      const box = await pane(page).boundingBox();
      const card = await sleepingCard(page).boundingBox();
      const pill = await pane(page).getByTestId("pane-sleeping-pill").boundingBox();
      if (!box || !card || !pill) throw new Error("no boxes");
      return {
        width: box.width,
        x: Math.abs(card.x + card.width / 2 - (box.x + box.width / 2)),
        y: Math.abs(card.y + card.height / 2 - (box.y + box.height / 2)),
        pillX: Math.abs(pill.x + pill.width / 2 - (box.x + box.width / 2)),
      };
    };
    const atFirst = await offCentre();
    expect(Math.max(atFirst.x, atFirst.y, atFirst.pillX), JSON.stringify(atFirst)).toBeLessThanOrEqual(2);
    if (shots) await shootBothThemes(page, shots, "pill-split");

    // Another size: the window changes, the pane with it, the pill follows.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 760));
    await expect
      .poll(async () => Math.abs((await offCentre()).width - atFirst.width), { timeout: 10_000 })
      .toBeGreaterThan(50);
    await page.waitForTimeout(300);
    const atSecond = await offCentre();
    expect(Math.max(atSecond.x, atSecond.y, atSecond.pillX), JSON.stringify(atSecond)).toBeLessThanOrEqual(2);
    if (shots) await shootBothThemes(page, shots, "pill-split-larger");

    // Shift+click on Resume: resumes and pins Keep running.
    const resume = sleepingCard(page).getByTestId("pane-resume");
    await expect(resume).toHaveAttribute("title", "Resume. Shift+click: resume and never let it sleep again");
    await resume.click({ modifiers: ["Shift"] });
    await waitForLaunches(fixture, 2);
    await expect(sleepingCard(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(pane(page).getByRole("button", { name: "Keep running" })).toHaveAttribute("aria-pressed", "true", {
      timeout: 15_000,
    });
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

test("a sleeping agent's whole process tree is gone and the memory it held is reported", { tag: "@ci" }, async () => {
  test.setTimeout(TEST_TIMEOUT);
  // The agent pane sits beside a shell that has the keyboard, so it sleeps
  // in place: no workspace switch muddies Studio's own figures. The idle
  // time is long enough to measure Studio's drift without a sleep first.
  const fixture = await prepareFixture("memory", { withShellPane: true });
  // Main's garbage collector runs before each reading, so only what Studio
  // keeps counts (the census's read buffers are pinned by a unit check in
  // test-owned-process-tree-descendants.cjs).
  const { app, page, logs } = await launch(fixture, {
    env: { CODARA_E2E_HIBERNATION_IDLE_MS: "20000" },
    args: ["--js-flags=--expose-gc"],
  });
  try {
    const [first] = await waitForLaunches(fixture, 1);
    const childPid = await waitForChildPid(fixture);
    const tree = [first.pid, childPid, ...(WINDOWS || !first.ppid ? [] : [first.ppid])];
    for (const pid of tree) expect(isAlive(pid)).toBe(true);
    await page.waitForTimeout(3_000);
    const start = await studioMemory(app);
    await page.waitForTimeout(6_000);
    const before = await studioMemory(app);
    expect(isAlive(first.pid), "slept before the baseline was taken").toBe(true);

    await expect(sleepingChip(page), logs.join("\n")).toHaveAttribute("aria-label", "CLAUDE sleeping", { timeout: 40_000 });
    // No leftover: the agent, its MCP-like child and the pane's shell.
    for (const pid of tree) await expect.poll(() => isAlive(pid), { timeout: 15_000 }).toBe(false);
    const line = logs.find((entry) => entry.includes(`pane=${PANE_ID} claude is sleeping`)) ?? "";
    const freedMb = Number(/freed (\d+) MB/.exec(line)?.[1] ?? 0);
    expect(freedMb, line).toBeGreaterThanOrEqual(AGENT_HOLD_MB + CHILD_HOLD_MB);
    // The pane is a half split: the pill may leave the figure out, its
    // tooltip never does.
    const pill = pane(page).getByTestId("pane-sleeping-pill");
    await expect
      .poll(async () => `${await pill.textContent()} ${(await pill.getAttribute("title")) ?? ""}`)
      .toContain(`freed ${freedMb} MB`);

    // What Studio itself keeps for the sleeping pane: main does not grow by
    // more than noise (the census once left ~150 MB of buffers there).
    await page.waitForTimeout(3_000);
    const after = await studioMemory(app);
    console.log(
      `[memory] agent tree freed ${freedMb} MB; Studio (MB) start ${JSON.stringify(start)} before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
    );
    expect(after.mainHeap - before.mainHeap, JSON.stringify({ start, before, after })).toBeLessThan(30);
  } finally {
    await app.close();
    await cleanup(fixture);
  }
});

// Proof screenshots for a look change (CODARA_E2E_SLEEP_NOW_SHOTS=<folder>),
// in the dark and the light theme.
async function shootBothThemes(page: Page, folder: string, name: string): Promise<void> {
  for (const [mode, themeId] of [
    ["dark", "codara-classic"],
    ["light", "codara-daylight"],
  ] as const) {
    await page.evaluate(
      ([mode, themeId]) => {
        const root = document.documentElement;
        root.classList.remove("light", "dark", "theme-codara-daylight", "theme-codara-classic");
        root.classList.add(mode, `theme-${themeId}`);
        root.dataset.theme = themeId;
        root.dataset.themeMode = mode;
        root.style.setProperty("color-scheme", mode);
      },
      [mode, themeId] as const,
    );
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(folder, `${name}-${mode}.png`) });
  }
}

// Studio's own processes, in MB: main's resident set, and the working set of
// every Electron process (main, renderer, GPU, utility) together. mainHeap is
// main's JS heap plus the native memory its objects hold (its buffers), read
// right after a forced collection, so only what Studio keeps counts.
async function studioMemory(
  app: ElectronApplication,
): Promise<{ main: number; mainHeap: number; renderer: number; all: number; heapUsed: number; external: number; arrayBuffers: number }> {
  return app.evaluate(({ app: electronApp }) => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) throw new Error("main runs without --expose-gc: its heap figures would depend on when it last collected");
    gc();
    const metrics = electronApp.getAppMetrics();
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
    const usage = process.memoryUsage();
    const renderer = metrics.filter((entry) => entry.type === "Tab").reduce((sum, entry) => sum + entry.memory.workingSetSize, 0);
    return {
      main: mb(usage.rss),
      mainHeap: mb(usage.heapUsed + usage.external),
      heapUsed: mb(usage.heapUsed),
      external: mb(usage.external),
      arrayBuffers: mb(usage.arrayBuffers),
      renderer: mb(renderer * 1024),
      all: mb(metrics.reduce((sum, entry) => sum + entry.memory.workingSetSize, 0) * 1024),
    };
  });
}

async function launch(
  fixture: Fixture,
  { seed = true, env = {}, args = [] }: { seed?: boolean; env?: Record<string, string>; args?: string[] } = {},
): Promise<{ app: ElectronApplication; page: Page; logs: string[] }> {
  const fixtureShell = join(fixture.binDir, "bash");
  if (!WINDOWS) {
    await writeFile(fixtureShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
    await chmod(fixtureShell, 0o755);
  }
  const app = await electron.launch({
    args: [...args, "."],
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
      if (sessionStorage.getItem("codara-e2e-keep-layout")) return;
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
  const hooksDir = join(userDataDir, "hooks");
  const hook = options.hooks
    ? `const hook = (hookName, payload) => {
  const file = require("node:path").join(${JSON.stringify(hooksDir)}, require("node:crypto").randomUUID() + ".json");
  const body = JSON.stringify({ hookName, timestamp: new Date().toISOString(), paneId: process.env.SPARK_PANE_ID || "", payload: { session_id: ${JSON.stringify(SESSION_ID)}, ...payload } });
  fs.mkdirSync(${JSON.stringify(hooksDir)}, { recursive: true });
  fs.writeFileSync(file + ".tmp", body);
  fs.renameSync(file + ".tmp", file);
};
setTimeout(() => hook("SessionStart", { source: "resume" }), 300);
`
    : "const hook = () => {};\n";
  const behaviour =
    mode === "repaint"
      ? `
let ticks = 0;
setInterval(() => process.stdout.write("\\x1b7\\x1b[20;1H\\x1b[2K  ctx 41% | " + new Date().toISOString().slice(11, 19) + " | " + ++ticks + "\\x1b8"), 1000);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const text = data.toString();
  // Ctrl+C with text in the box empties it, as Claude Code does.
  if (text === "\\x03") return void process.stdout.write("\\r\\x1b[2K\\u276f ");
  if (text.includes("\\r")) {
    hook("UserPromptSubmit", { prompt: "done" });
    process.stdout.write("\\r\\n");
    return void setTimeout(() => {
      process.stdout.write("Done.\\r\\n\\u276f ");
      hook("Stop", { last_assistant_message: "Done." });
    }, 300);
  }
  process.stdout.write(text);
});
`
      : mode === "working"
        ? `
setTimeout(() => hook("UserPromptSubmit", { prompt: "build it" }), 600);
let seconds = 0;
setTimeout(() => setInterval(() => process.stdout.write("\\r\\x1b[2K\\u273b Working\\u2026 (" + ++seconds + "s \\u00b7 esc to interrupt)"), 1000), 800);
`
        : mode === "memory"
          ? `
const hold = Buffer.alloc(${AGENT_HOLD_MB} * 1024 * 1024, 1);
const mcp = require("node:child_process").spawn(process.execPath, ["-e", "const held = Buffer.alloc(${CHILD_HOLD_MB} * 1024 * 1024, 1); setInterval(() => { held[0] += 1; }, 1 << 30);"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(mcp.pid));
setInterval(() => { hold[0] += 1; }, 1 << 30);
`
          : "";
  const body = `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, args: process.argv.slice(2) }) + "\\n");
${hook}
${devServer}
process.stdout.write("Claude Code v2.1.261\\r\\n\\u276f \\r\\n? for shortcuts\\r\\n");
${behaviour}
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

  const transcript = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    ...(options.aiTitle ? [JSON.stringify({ type: "ai-title", aiTitle: options.aiTitle, sessionId: SESSION_ID })] : []),
  ].join("\n");
  await writeFile(join(claudeProjectDir, `${SESSION_ID}.jsonl`), `${transcript}\n`, "utf8");
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ restoreAgentSessions: true, agentHibernationMinutes: 15, ...(options.prefs ?? {}) }),
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
