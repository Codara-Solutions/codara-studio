import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The System activity popover: pressing a title-bar meter shows what uses
// that resource in one list, heaviest first. A script holding memory runs in a
// terminal pane; its pane's row must carry that memory, list the script when
// expanded, and take the keyboard to the pane when clicked. CPU is never burned
// to test this: the CPU list runs on fake process data through the real
// handler, and the left-behind case on a real, sleeping orphan.
//
// CODARA_SHOTS_DIR=<dir> also saves the open popover in the dark and light
// themes, for reviewing the design.

const SHOTS = process.env.CODARA_SHOTS_DIR ?? "";
// Screenshots wait for the title bar to gather most of a minute of history,
// so the charts are drawn as a user who opens the popover later sees them.
const SHOT_HISTORY_MS = 45_000;
const SHOT_CPU_HISTORY_MS = 12_000;

// Holds ~200 MB and sleeps, under a name the popover can show.
const HOLDER = String.raw`
const hold = Buffer.alloc(200 * 1024 * 1024, 1);
setInterval(() => hold[0]++, 60_000);
`;

interface Fixture {
  root: string;
  userDataDir: string;
  workspaceDir: string;
  holder: string;
}

async function prepareFixture(theme: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "spark-system-activity-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const holder = join(root, "lint-holder.js");
  await writeFile(holder, HOLDER, "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-probe", name: "probe-workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
      activeWorkspaceId: "ws-probe",
    }),
    "utf8",
  );
  await writeFile(join(userDataDir, "spark-preferences.json"), JSON.stringify({ theme, glassEffects: true }), "utf8");
  return { root, userDataDir, workspaceDir, holder };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function openTerminal(page: Page) {
  await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
  const pane = page.locator("[data-terminal-pane-id]:visible").first();
  await expect(pane.locator(".xterm-host")).toBeVisible({ timeout: 15_000 });
  const paneId = await pane.getAttribute("data-terminal-pane-id");
  expect(paneId, "expected a visible terminal pane").toBeTruthy();
  return { pane, paneId: paneId!, input: pane.locator(".xterm-helper-textarea").first() };
}

async function startHolder(page: Page, fixture: Fixture): Promise<string> {
  const { paneId, input } = await openTerminal(page);
  await input.focus();
  await input.pressSequentially(`"${process.execPath}" "${fixture.holder}"`, { delay: 2 });
  await input.press("Enter");
  return paneId;
}

const group = (fields: Record<string, unknown>) => ({
  owner: "pane",
  paneId: null,
  workspaceId: null,
  tabId: null,
  serverId: null,
  runtime: null,
  task: null,
  cwd: null,
  cpuPercent: 0,
  memoryBytes: 64 * 1024 ** 2,
  gpuMemoryBytes: null,
  swapBytes: null,
  processCount: 1,
  processes: [],
  apps: [],
  ...fields,
});
const app = (name: string, cpuPercent: number, processCount = 1) => ({
  name,
  processCount,
  cpuPercent,
  memoryBytes: 32 * 1024 ** 2,
  gpuMemoryBytes: null,
  swapBytes: null,
});
const IDLE_PROMPTS = ["perfect", "resume", "is it live?", "go", "wtf", "yes go ahead", "whatever you think", "what is next?"];
const idlePanes = IDLE_PROMPTS.map((task, index) =>
  group({ paneId: `pane-idle-${index}`, workspaceId: "ws-probe", runtime: index % 3 === 2 ? "codex" : "claude", task }),
);
const busyPanes = (cpu: number) => [
  group({
    paneId: "pane-a",
    workspaceId: "ws-probe",
    runtime: "claude",
    task: "no no something sh was using like 2000%",
    cpuPercent: cpu,
    apps: [app("next-server", cpu * 0.7), app("chrome-headless", cpu * 0.2, 3), app("claude", cpu * 0.1)],
  }),
];
const SHARED = [
  group({ owner: "codara", cpuPercent: 138, processCount: 14 }),
  group({ owner: "outside", cpuPercent: 96, processCount: 790, apps: [app("chrome", 41, 18), app("cosmic-comp", 19), app("rclone", 9)] }),
];
const normalMoment = { cpuPercent: 19, groups: [...SHARED, ...busyPanes(91), ...idlePanes] };
const runawayMoment = (fixture: Fixture) => ({
  cpuPercent: 91,
  groups: [
    ...SHARED,
    ...busyPanes(38),
    ...idlePanes,
    group({
      owner: "left-running",
      paneId: "pane-closed",
      runtime: "claude",
      cwd: join(fixture.workspaceDir, "src"),
      cpuPercent: 1968,
      processCount: 24,
      apps: [app("sh", 1968, 24)],
      processes: [
        {
          pid: 8123,
          name: "sh",
          command: "sh -c while :; do git status --short; done",
          cpuPercent: 82,
          memoryBytes: 2 * 1024 ** 2,
          gpuMemoryBytes: null,
          swapBytes: null,
        },
      ],
    }),
  ],
});

/**
 * Main's figures stay real; the machine's load and what uses it are replaced,
 * so nothing has to load the machine. NOTE: `_invokeHandlers` is an Electron
 * internal, as in model-effort-shortcuts.spec.ts.
 */
async function fakeProcesses(electronApp: ElectronApplication, moment: { cpuPercent: number; groups: unknown[] }): Promise<void> {
  // Right after boot a main-process evaluate can fail ("Resulting promise was
  // garbage collected") although its body ran. Repeating this one is harmless:
  // it always wraps the first handler.
  await expect(async () => {
    const hooked = await electronApp.evaluate(({ ipcMain }, fake) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const holder = globalThis as unknown as { __saOriginal?: (...args: unknown[]) => unknown };
      holder.__saOriginal ??= handlers.get("system:resourceSnapshot");
      const original = holder.__saOriginal;
      if (!original) return false;
      handlers.set("system:resourceSnapshot", async (...args: unknown[]) => {
        const snapshot = (await original(...args)) as { processes: Record<string, unknown> | null };
        return {
          ...snapshot,
          cpuPercent: fake.cpuPercent,
          cpuLogicalCores: 24,
          processes: snapshot.processes ? { ...snapshot.processes, cpuMeasured: true, groups: fake.groups } : null,
        };
      });
      return true;
    }, moment);
    expect(hooked, "the system:resourceSnapshot handler must be replaceable").toBe(true);
  }).toPass({ timeout: 10_000 });
}

async function widen(electronApp: ElectronApplication): Promise<void> {
  await expect(async () => {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
  }).toPass({ timeout: 10_000 });
}

const meter = (page: Page, metric: "cpu" | "gpu" | "ram" | "swap") =>
  page.locator(`.system-meter-mini[data-metric="${metric}"]`);

async function openPopover(page: Page, metric: "cpu" | "gpu" | "ram" | "swap") {
  await meter(page, metric).click();
  const popover = page.getByRole("dialog", { name: "System activity" });
  await expect(popover).toBeVisible();
  return popover;
}

/** "225 MB" or "1.2 GB" in bytes; "80%" as 80. */
function figure(text: string | null): number {
  const match = /([\d.]+)\s*(%|B|KB|MB|GB|TB)/.exec(text ?? "");
  if (!match) return NaN;
  const scale = { "%": 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2]] ?? NaN;
  return Number(match[1]) * scale;
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const popover = page.getByRole("dialog", { name: "System activity" });
  const box = await popover.boundingBox();
  if (!box) return;
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    clip: { x: Math.max(0, box.x - 24), y: 0, width: Math.min(box.width + 36, 1600), height: box.y + box.height + 14 },
  });
}

test("pressing a meter lists what each pane uses and jumps there", async () => {
  test.setTimeout(SHOTS ? 180_000 : 120_000);
  const fixture = await prepareFixture("codara-classic");
  const app = await launch(fixture);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    await expect(meter(page, "ram")).toBeVisible({ timeout: 15_000 });
    const paneId = await startHolder(page, fixture);
    if (SHOTS) await page.waitForTimeout(SHOT_HISTORY_MS);

    // RAM: the holder's pane has its ~200 MB, summed with its shell.
    const popover = await openPopover(page, "ram");
    await expect(popover.getByRole("tab", { name: /RAM/ })).toHaveAttribute("aria-selected", "true");
    await expect(meter(page, "ram")).toHaveAttribute("aria-expanded", "true");
    const row = popover.locator('.sa-row[data-owner="pane"]', { hasText: "probe-workspace" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".sa-row__name")).toHaveText("Terminal · probe-workspace");
    await expect(row.locator(".sa-row__where")).toContainText("lint-holder");
    await expect.poll(async () => figure(await row.locator(".sa-row__value").textContent()), { timeout: 10_000 }).toBeGreaterThan(190 * 1024 ** 2);
    await expect(popover.locator('.sa-row[data-owner="codara"]')).toBeVisible();
    await expect(popover.locator('.sa-row[data-owner="outside"] .sa-row__name')).toHaveText("Other apps");

    // Expanding the row lists what runs in it; nothing else opens.
    await row.getByRole("button", { name: /Show what runs in/ }).click();
    await expect(row.locator(".sa-row__detail")).toContainText("lint-holder");

    // Live: the total's chart takes a new reading every second.
    const line = popover.locator(".sa-chart svg path").nth(1);
    const first = await line.getAttribute("d");
    await expect.poll(() => line.getAttribute("d"), { timeout: 6_000 }).not.toBe(first);
    await page.waitForTimeout(SHOTS ? 2_500 : 0);
    await shoot(page, "dark");

    await popover.getByRole("tab", { name: /CPU/ }).click();
    await expect(popover.getByRole("tab", { name: /CPU/ })).toHaveAttribute("aria-selected", "true");
    await expect(popover.locator(".sa-note--fine")).toHaveText("Share of the whole machine");

    // Another meter switches the breakdown in place.
    await meter(page, "gpu").click();
    await expect(popover.getByRole("tab", { name: /GPU/ })).toHaveAttribute("aria-selected", "true");

    // Clicking the row closes the popover and puts the keyboard in the pane.
    await popover.getByRole("tab", { name: /RAM/ }).click();
    await row.getByRole("button", { name: /^Go to Terminal · probe-workspace/ }).click();
    await expect(popover).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest("[data-terminal-pane-id]")?.getAttribute("data-terminal-pane-id") ?? null),
      )
      .toBe(paneId);

    // Escape closes it too, and focus returns to the meter that opened it.
    await openPopover(page, "cpu");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "System activity" })).toBeHidden();
    await expect(meter(page, "cpu")).toBeFocused();

    // Memory running out (this machine was once OOM-killed by a 25 GB lint
    // run) turns the RAM meter red and the popover says so. Main's figures
    // are real; only the level and what is left are forced. NOTE:
    // `_invokeHandlers` is an Electron internal, as in
    // model-effort-shortcuts.spec.ts.
    const hooked = await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get("system:resourceSnapshot");
      if (!original) return false;
      handlers.set("system:resourceSnapshot", async (...args: unknown[]) => {
        const snapshot = (await original(...args)) as Record<string, number | string>;
        return {
          ...snapshot,
          memoryLevel: "critical",
          ramAvailableBytes: Math.round(Number(snapshot.ramTotalBytes) * 0.03),
          swapOutBytesPerSecond: 48 * 1024 * 1024,
        };
      });
      return true;
    });
    expect(hooked, "the system:resourceSnapshot handler must be replaceable").toBe(true);
    await expect(page.locator('.system-meters-pill[data-memory-level="critical"]')).toBeVisible({ timeout: 6_000 });
    const warned = await openPopover(page, "cpu");
    const warning = warned.getByRole("status").filter({ hasText: "Memory almost full" });
    await expect(warning).toBeVisible({ timeout: 6_000 });
    await expect(warning).toContainText("available, swapping 48.0 MB/s");
    await warning.getByRole("button", { name: "Show RAM" }).click();
    await expect(warned.getByRole("tab", { name: /RAM/ })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(SHOTS ? 1_500 : 0);
    await shoot(page, "warning-dark");
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

async function cpuList(page: Page, theme: string, fixture: Fixture, electronApp: ElectronApplication): Promise<void> {
  await expect(meter(page, "cpu")).toBeVisible({ timeout: 15_000 });
  await fakeProcesses(electronApp, normalMoment);
  await expect.poll(() => meter(page, "cpu").getAttribute("aria-label"), { timeout: 8_000 }).toContain("19");
  if (SHOTS) await page.waitForTimeout(SHOT_CPU_HISTORY_MS);
  const popover = await openPopover(page, "cpu");
  const rows = popover.locator(".sa-rows .sa-row");
  await expect(rows.first().locator(".sa-row__name")).toHaveText("Codara", { timeout: 8_000 });

  // The whole list, heaviest first, in the headline's scale, on one line each.
  await expect
    .poll(() => rows.locator(".sa-row__value").allTextContents())
    .toEqual(["5.8%", "4.0%", "3.8%"]);
  await expect(rows.locator(".sa-row__name")).toHaveText(["Codara", "Other apps", "Claude Code · probe-workspace"]);
  await expect(rows.nth(2).locator(".sa-row__where")).toHaveText("next-server, chrome-headless ×3, claude");
  await expect(popover.getByText("no no something sh")).toHaveCount(0);

  // The agent's words moved to the row's detail.
  await rows.nth(2).getByRole("button", { name: /Show what runs in/ }).click();
  await expect(popover.getByText("Last prompt: no no something sh was using like 2000%")).toBeVisible();
  await rows.nth(2).getByRole("button", { name: /Hide what runs in/ }).click();

  // Idle panes are one line until asked for.
  const idle = popover.locator(".sa-idle");
  await expect(idle).toHaveText("8 idle panes");
  await shoot(page, `normal-${theme}`);
  await idle.click();
  await expect(rows).toHaveCount(11);
  await idle.click();
  await expect(rows).toHaveCount(3);

  // The runaway leads, says what it is and whose it is, and shows what it runs.
  await fakeProcesses(electronApp, runawayMoment(fixture));
  const runaway = popover.locator('.sa-row[data-owner="left-running"]');
  await expect(runaway).toBeVisible({ timeout: 8_000 });
  await expect(rows.first()).toHaveAttribute("data-owner", "left-running");
  await expect(runaway).toHaveAttribute("data-alarm", "true");
  await expect(runaway.locator(".sa-row__name")).toHaveText("sh ×24 left running");
  await expect(runaway.locator(".sa-row__where")).toHaveText("Claude Code · probe-workspace · no open terminal");
  await expect(runaway.locator(".sa-row__value")).toHaveText("82%");
  await expect(runaway.locator(".sa-row__command")).toHaveText("sh -c while :; do git status --short; done");
  await expect(runaway.getByRole("button", { name: /^Go to/ })).toHaveCount(0);
  for (const line of await runaway.locator(".sa-row__note, .sa-row__where-text, .sa-row__name").all()) {
    const clipped = await line.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(clipped, `${await line.textContent()} fits on its line`).toBe(false);
  }
  await page.waitForTimeout(SHOTS ? 1_500 : 0);
  await shoot(page, `runaway-${theme}`);

  // It opened by itself, and closes like any row.
  await runaway.getByRole("button", { name: /Hide what runs in/ }).click();
  await expect(runaway.locator(".sa-row__command")).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test("the CPU list ranks everything and a runaway leads with its owner", async () => {
  test.setTimeout(SHOTS ? 120_000 : 90_000);
  const fixture = await prepareFixture("codara-classic");
  const app = await launch(fixture);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await widen(app);
    await cpuList(page, "dark", fixture, app);
  } finally {
    await app.close();
  }
});

test("a process that outlives its closed pane is traced back, not lost in Other apps", async () => {
  test.skip(process.platform !== "linux", "only Linux reads a process's inherited environment");
  test.setTimeout(90_000);
  const fixture = await prepareFixture("codara-classic");
  const app = await launch(fixture);
  const pidFile = join(fixture.root, "holder.pid");
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(meter(page, "ram")).toBeVisible({ timeout: 15_000 });
    const { paneId, input } = await openTerminal(page);
    await input.focus();
    // setsid in a subshell that exits: a new session, and init as its parent.
    await input.pressSequentially(
      `cd "${fixture.workspaceDir}" && (setsid "${process.execPath}" "${fixture.holder}" </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}")`,
      { delay: 2 },
    );
    await input.press("Enter");
    await expect.poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 10_000 }).toMatch(/\d+/);

    // With its pane open, it is that pane's.
    const popover = await openPopover(page, "ram");
    const row = popover.locator(`.sa-row[data-owner="pane"]`, { hasText: "lint-holder" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // The pane closes when its shell exits; the holder stays.
    await input.focus();
    await input.pressSequentially("exit", { delay: 2 });
    await input.press("Enter");
    await expect(page.locator(`[data-terminal-pane-id="${paneId}"]`)).toHaveCount(0, { timeout: 10_000 });
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(() => process.kill(pid, 0), "the holder outlived its pane").not.toThrow();

    const again = await openPopover(page, "ram");
    const left = again.locator('.sa-row[data-owner="left-running"]', { hasText: "lint-holder" });
    await expect(left).toBeVisible({ timeout: 15_000 });
    await expect(left.locator(".sa-row__name")).toHaveText("lint-holder left running");
    await expect(left.locator(".sa-row__where")).toHaveText("probe-workspace · no open terminal");
    await expect.poll(async () => figure(await left.locator(".sa-row__value").textContent()), { timeout: 10_000 }).toBeGreaterThan(190 * 1024 ** 2);
    await expect(again.locator('.sa-row[data-owner="outside"]', { hasText: "lint-holder" })).toHaveCount(0);
  } finally {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await app.close();
  }
});

test("light theme screenshot", async () => {
  test.skip(!SHOTS, "set CODARA_SHOTS_DIR to capture the light theme");
  test.setTimeout(120_000);
  const fixture = await prepareFixture("codara-daylight");
  const app = await launch(fixture);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await widen(app);
    await cpuList(page, "light", fixture, app);
  } finally {
    await app.close();
  }
});
