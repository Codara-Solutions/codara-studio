import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Screenshot harness for the notification center (the bell panel). Not an
// assertion suite: it seeds a fake Codara home with a realistic
// notifications.json and photographs the open panel in each state, at two
// window sizes and in a dark and a light theme, so a visual change can be
// judged side by side. Shots land in SHOTS_DIR, and without it the harness is
// skipped: it takes a minute and asserts little (notification-center.spec.ts
// checks the behaviour).
// HOME and the Codara home are throwaway directories, so nothing here reads or
// writes the user's real ~/.codarastudio.

const DASH = "\u2014";
const MINUTE = 60_000;

type Entry = Record<string, unknown> & { id: string; createdAt: string };

const WORKSPACES = [
  { id: "ws-api", name: "api-server", color: "#42D6C7" },
  { id: "ws-web", name: "web-app", color: "#78A8FF" },
  { id: "ws-infra", name: "infra", color: "#F2A65A" },
  { id: "ws-docs", name: "docs-site", color: "#C792EA" },
  { id: "ws-mobile", name: "mobile", color: "#F07178" },
];

const COMMITS = [
  "Retry the token refresh once before failing the request",
  "Keep pagination cursors stable across schema changes",
  "Move rate limits into the gateway config",
  "Stop logging request bodies on 4xx responses",
  "Split the billing worker so retries do not block invoices",
  "Pin the image digest in the deploy manifest",
  "Show the last sync time in the header",
  "Drop the legacy feature flag for search v1",
];

const PR_TITLES = [
  "Add idempotency keys to the payments webhook",
  "Migrate auth middleware to the new session store",
  "Bump Node to 22 in CI and the Dockerfile",
  "Fix flaky upload test on slow runners",
];

const TABS = ["terminals", "terminals 2", "server", "tests", "review"];
const BRANCHES = ["feature/sync", "main", "feature/sync", "memory/review"];

// Runs seeded as blocked on an open question (see seedTargets).
const BLOCKED_RUNS = new Set(["run-ws-web-b1"]);

let seq = 0;
function makeEntry(minutesAgo: number, fields: Record<string, unknown>): Entry {
  seq += 1;
  return {
    soundKind: "done",
    tone: "success",
    read: false,
    ...fields,
    id: `notify-shot-${seq.toString(36).padStart(4, "0")}`,
    createdAt: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
  };
}

function agentDone(minutesAgo: number, ws: (typeof WORKSPACES)[number], pane: number, agent = "Claude Code"): Entry {
  const tab = TABS[pane % TABS.length];
  const took = 1 + ((pane * 7 + Math.floor(minutesAgo)) % 23);
  return makeEntry(minutesAgo, {
    kind: "terminal.agent.done",
    sourceKey: `pane:pane-${ws.id}-${pane}`,
    tone: "success",
    title: `${agent} finished · ${tab}`,
    workspaceName: ws.name,
    body: `Finished its turn. · took ${took}m`,
    soundKind: "done",
    target: { type: "terminal", workspaceId: ws.id, tabId: `term-${ws.id}-${pane}`, paneId: `pane-${ws.id}-${pane}` },
  });
}

function agentNeeds(minutesAgo: number, ws: (typeof WORKSPACES)[number], pane: number, agent = "Codex"): Entry {
  const tab = TABS[pane % TABS.length];
  return makeEntry(minutesAgo, {
    kind: "terminal.agent.needs-input",
    sourceKey: `pane:pane-${ws.id}-${pane}`,
    tone: "warning",
    title: `${agent} needs you · ${tab}`,
    workspaceName: ws.name,
    body: "Allow running `npm run migrate` in this workspace?",
    soundKind: "needs-you",
    target: { type: "terminal", workspaceId: ws.id, tabId: `term-${ws.id}-${pane}`, paneId: `pane-${ws.id}-${pane}` },
  });
}

function agentFailed(minutesAgo: number, ws: (typeof WORKSPACES)[number], pane: number, agent = "Claude Code"): Entry {
  const tab = TABS[pane % TABS.length];
  return makeEntry(minutesAgo, {
    kind: "terminal.agent.failed",
    sourceKey: `pane:pane-${ws.id}-${pane}`,
    tone: "danger",
    title: `${agent} stopped · ${tab}`,
    workspaceName: ws.name,
    body: `${agent} terminal exited with code 1.`,
    soundKind: "needs-you",
    target: { type: "terminal", workspaceId: ws.id, tabId: `term-${ws.id}-${pane}`, paneId: `pane-${ws.id}-${pane}` },
  });
}

function teammatePush(minutesAgo: number, ws: (typeof WORKSPACES)[number], i: number): Entry {
  const commits = 1 + (i % 3);
  return makeEntry(minutesAgo, {
    kind: "git.teammate-push",
    sourceKey: `github-push:acme/${ws.name}`,
    tone: "success",
    silent: true,
    title: `release-bot[bot] pushed to ${ws.name}`,
    workspaceName: ws.name,
    body: `${commits} commit${commits === 1 ? "" : "s"} to ${BRANCHES[i % BRANCHES.length]} ${DASH} ${COMMITS[i % COMMITS.length]}`,
    target: { type: "workspace", workspaceId: ws.id, panel: "git" },
  });
}

function pullRequest(minutesAgo: number, ws: (typeof WORKSPACES)[number], n: number): Entry {
  return makeEntry(minutesAgo, {
    kind: "git.pull-request",
    sourceKey: `github-pr:acme/${ws.name}#${n}`,
    tone: "success",
    title: `sam-lee opened PR #${n} in ${ws.name}`,
    workspaceName: ws.name,
    body: PR_TITLES[n % PR_TITLES.length],
    target: { type: "workspace", workspaceId: ws.id, panel: "git" },
  });
}

function runDone(minutesAgo: number, ws: (typeof WORKSPACES)[number], i: number, failed = false): Entry {
  return makeEntry(minutesAgo, {
    kind: failed ? "run.failed" : "run.complete",
    sourceKey: `run:run-${ws.id}-${i}`,
    tone: failed ? "danger" : "success",
    title: failed ? `Codara Studio ${DASH} failed` : `Codara Studio ${DASH} done`,
    workspaceName: ws.name,
    body: failed
      ? "The test worker hit a timeout while installing dependencies."
      : `Refactored the session middleware and updated 14 tests ${DASH} ran 18m`,
    soundKind: "done",
    target: { type: "run", runId: `run-${ws.id}-${i}`, workspaceId: ws.id },
  });
}

function runBlocked(minutesAgo: number, ws: (typeof WORKSPACES)[number], i: number): Entry {
  return makeEntry(minutesAgo, {
    kind: "run.blocked",
    sourceKey: `run:run-${ws.id}-b${i}`,
    tone: "warning",
    title: `Codara Studio ${DASH} needs you`,
    workspaceName: ws.name,
    body: "Should the migration drop the unused `legacy_sessions` table, or keep it for one more release?",
    soundKind: "needs-you",
    target: { type: "run", runId: `run-${ws.id}-b${i}`, workspaceId: ws.id },
  });
}

function automation(minutesAgo: number, ws: (typeof WORKSPACES)[number], kind: "finished" | "failed" | "blocked" | "step"): Entry {
  const job = `loom-${ws.id}`;
  const title =
    kind === "finished"
      ? `Automation ${DASH} finished`
      : kind === "failed"
        ? `Automation ${DASH} failed`
        : kind === "blocked"
          ? `Automation ${DASH} needs you`
          : "Nightly dependency sweep";
  const body =
    kind === "finished"
      ? "“Nightly dependency sweep” finished after 3 iterations (goal-met)."
      : kind === "failed"
        ? "“Flaky test hunter” stopped after 2 iterations (iteration-failed)."
        : kind === "blocked"
          ? "Two lockfiles disagree on the React version. Which one wins?"
          : "Opened 2 upgrade PRs; 1 package needs a manual bump.";
  return makeEntry(minutesAgo, {
    kind: `automation.${kind}`,
    sourceKey: kind === "blocked" ? `run:run-${job}` : `automation:${job}`,
    tone: kind === "failed" ? "danger" : kind === "blocked" ? "warning" : "success",
    title,
    workspaceName: ws.name,
    body,
    soundKind: kind === "failed" || kind === "blocked" ? "needs-you" : "done",
    target: { type: "automation", jobId: job, runId: `run-${job}`, workspaceId: ws.id },
  });
}

function fewItems(): Entry[] {
  const [api, web, infra] = WORKSPACES;
  return [
    { ...agentDone(2, api, 1), count: 3, firstAt: new Date(Date.now() - 95 * MINUTE).toISOString() },
    runDone(9, web, 1),
    teammatePush(25, infra, 0),
    agentFailed(48, web, 2),
    { ...pullRequest(130, api, 41), read: true },
    { ...agentDone(60 * 20, infra, 3, "Codex"), read: true },
  ];
}

// 150 entries over five days, shaped like a real history: a bot that pushes
// to one repository dominates, agents finish many turns in a few panes, and
// the odd run, automation and pull request sits in between.
function manyItems(): Entry[] {
  const out: Entry[] = [];
  let t = 1;
  for (let i = 0; out.length < 150; i += 1) {
    const ws = WORKSPACES[i % WORKSPACES.length];
    const r = (i * 37) % 20;
    t += 3 + ((i * 13) % 41);
    let e: Entry;
    if (r < 7) e = teammatePush(t, WORKSPACES[0], i);
    else if (r < 12) e = agentDone(t, ws, i % 3, i % 4 === 0 ? "Codex" : "Claude Code");
    else if (r < 13) e = agentNeeds(t, ws, i % 3);
    else if (r < 14) e = agentFailed(t, ws, i % 3);
    else if (r < 16) e = pullRequest(t, ws, 40 + (i % 9));
    else if (r < 17) e = runDone(t, ws, i, i % 3 === 0);
    else if (r < 18) e = runBlocked(t, ws, i);
    else if (r < 19) e = automation(t, ws, i % 2 === 0 ? "finished" : "step");
    else e = automation(t, ws, "failed");
    if (t > 60 * 6) e.read = i % 3 !== 0;
    out.push(e);
  }
  return out;
}

function needsYouItems(): Entry[] {
  const [api, web, infra, docs] = WORKSPACES;
  return [
    agentNeeds(1, api, 1, "Claude Code"),
    runBlocked(4, web, 1),
    automation(11, infra, "blocked"),
    agentNeeds(19, docs, 2, "Codex"),
    agentDone(23, api, 2),
    agentDone(31, web, 0, "Codex"),
    teammatePush(44, api, 3),
    runDone(70, infra, 2, true),
    { ...agentNeeds(150, web, 3, "Claude Code"), read: true, settled: true },
  ];
}

// Targets that no longer resolve: panes of a closed tab, a workspace that was
// deleted (its id is absent from spark-state.json), and a run that is gone.
function closedTargetItems(): Entry[] {
  const [api, web] = WORKSPACES;
  const deleted = { id: "ws-deleted", name: "old-prototype", color: "#888888" };
  return [
    agentDone(3, api, 9),
    agentNeeds(7, web, 8, "Codex"),
    agentFailed(15, deleted, 1),
    agentDone(26, deleted, 2, "Codex"),
    teammatePush(40, deleted, 1),
    runDone(55, api, 99),
    runBlocked(80, deleted, 3),
  ];
}

// Two hundred rows from distinct sources, so nothing folds: the most a
// history can hold, for timing the panel at its largest.
function fullHistory(): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < 200; i += 1) {
    const ws = WORKSPACES[i % WORKSPACES.length];
    const minutes = 2 + i * 9;
    const e = i % 2 === 0 ? pullRequest(minutes, ws, 100 + i) : agentDone(minutes, ws, 10 + i, i % 3 === 0 ? "Codex" : "Claude Code");
    e.read = i > 20 && i % 4 !== 0;
    out.push(e);
  }
  return out;
}

const SCENARIOS: Array<{ name: string; entries: Entry[] | null; seedTargets: boolean }> = [
  { name: "empty", entries: null, seedTargets: true },
  { name: "few", entries: fewItems(), seedTargets: true },
  { name: "many150", entries: manyItems(), seedTargets: true },
  { name: "needs-you", entries: needsYouItems(), seedTargets: true },
  { name: "closed-targets", entries: closedTargetItems(), seedTargets: false },
  { name: "full200", entries: fullHistory(), seedTargets: true },
];

const SIZES = [
  { width: 1400, height: 900 },
  { width: 1000, height: 700 },
];

const THEMES = [
  { label: "dark", id: "codara-classic" },
  { label: "light", id: "codara-daylight" },
];

type Layouts = Record<string, { v: number; tabs: unknown[]; activeId: string }>;

// The runs and terminal panes the entries point at, so a live target renders
// live. Runs are minimal persisted run files; panes are one terminal tab each
// in the workspace's saved layout. The active workspace also gets a plain
// shell tab and opens on it, so no seeded pane is "on screen" and marked read.
async function seedTargets(home: string, entries: Entry[]): Promise<Layouts> {
  const runIds = new Set<string>();
  const panes = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    const target = entry.target as Record<string, string>;
    if (!WORKSPACES.some((ws) => ws.id === target.workspaceId)) continue;
    if (target.runId) runIds.add(target.runId);
    if (target.type === "terminal") {
      let tabs = panes.get(target.workspaceId);
      if (!tabs) panes.set(target.workspaceId, (tabs = new Map()));
      tabs.set(target.tabId, target.paneId);
    }
  }
  for (const runId of runIds) {
    const workspaceId = WORKSPACES.find((ws) => runId.includes(ws.id))?.id ?? "ws-api";
    const runDir = join(home, "runs", runId);
    await mkdir(runDir, { recursive: true });
    const at = new Date(Date.now() - 3 * 60 * MINUTE).toISOString();
    // A blocked run carries the open question its row can answer in place.
    const blocked = BLOCKED_RUNS.has(runId);
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        id: runId,
        workspaceId,
        title: "Session middleware refactor",
        status: blocked ? "blocked" : "complete",
        settingsSnapshot: { workspaceCwd: join(home, "..", "projects") },
        artifactDir: runDir,
        createdAt: at,
        updatedAt: at,
        ...(blocked ? {} : { completedAt: at }),
        conversationEpoch: 0,
        plans: [], steps: [], workerTasks: [], workerAttempts: [], checkpoints: [], assumptions: [],
        sparkCalls: [],
        humanMessages: blocked
          ? [
              {
                id: `question-${runId}`,
                runId,
                author: "spark",
                kind: "question",
                message: "Should the migration drop the unused `legacy_sessions` table, or keep it for one more release?",
                questionOptions: [
                  { id: "drop", label: "Drop it now", description: "Nothing has read the table since March.", answer: "Drop legacy_sessions in this migration.", recommended: true },
                  { id: "keep", label: "Keep one more release", description: "Rename it and drop it next release.", answer: "Keep legacy_sessions for one more release." },
                ],
                createdAt: at,
              },
            ]
          : [],
        chatBackend: "pi", chatMode: "auto",
      }),
      "utf8",
    );
  }
  const layouts: Layouts = {};
  for (const [workspaceId, tabs] of panes) {
    const list: unknown[] = [];
    let index = 0;
    for (const [tabId, paneId] of tabs) {
      list.push({
        id: tabId,
        kind: "terminal",
        title: TABS[index % TABS.length],
        activePaneId: paneId,
        root: { kind: "leaf", paneId, cwd: join(home, "..", "projects") },
      });
      index += 1;
    }
    let activeId = String((list[0] as { id: string }).id);
    if (workspaceId === "ws-api") {
      list.unshift({
        id: "term-ws-api-home",
        kind: "terminal",
        title: "shell",
        activePaneId: "pane-ws-api-home",
        root: { kind: "leaf", paneId: "pane-ws-api-home", cwd: join(home, "..", "projects") },
      });
      activeId = "term-ws-api-home";
    }
    layouts[workspaceId] = { v: 6, tabs: list, activeId };
  }
  return layouts;
}

async function launch(entries: Entry[] | null, withTargets: boolean) {
  const root = await mkdtemp(join(tmpdir(), "codara-ncenter-shots-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  const workspaces = [];
  for (const ws of WORKSPACES) {
    const cwd = join(root, "projects", ws.name);
    await mkdir(cwd, { recursive: true });
    workspaces.push({ ...ws, cwd, workers: [] });
  }
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({ workspaces, activeWorkspaceId: "ws-api" }),
    "utf8",
  );
  const layouts = entries && withTargets ? await seedTargets(home, entries) : {};
  // A terminal prompt cannot outlive the app (its pane's process ends at
  // quit), so the store settles any it loads from disk. Open prompts are
  // handed to the running app instead, as if they had just been raised.
  const isOpenPrompt = (e: Entry) => e.kind === "terminal.agent.needs-input" && !e.settled;
  const live = (entries ?? []).filter(isOpenPrompt);
  if (entries) {
    const onDisk = entries.filter((e) => !isOpenPrompt(e));
    await writeFile(join(home, "notifications.json"), JSON.stringify(onDisk, null, 2), "utf8");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({
    timeout: 30_000,
  });
  if (Object.keys(layouts).length > 0) {
    await page.addInitScript((saved) => {
      for (const [workspaceId, layout] of Object.entries(saved)) {
        localStorage.setItem(`spark.tabs:${workspaceId}`, JSON.stringify(layout));
      }
    }, layouts);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({
      timeout: 30_000,
    });
  }
  if (live.length > 0) {
    await page.evaluate((rows) => window.spark.notifications.restore(rows as never), live);
  }
  // The global runs list arrives after boot; a run is only judged gone once
  // it has.
  await page.waitForTimeout(800);
  return { app, page, root };
}

function bell(page: Page) {
  return page.locator('button[title="Notifications"]');
}

function panel(page: Page) {
  return page.getByRole("dialog", { name: "Notifications" });
}

function rows(page: Page) {
  return panel(page).locator(".nc-row");
}

async function setTheme(page: Page, id: string): Promise<void> {
  await page.evaluate((theme) => window.spark.preferences.set("theme", theme as never), id);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(id);
}

async function openCenter(page: Page): Promise<number> {
  if (await panel(page).isVisible()) return 0;
  const started = Date.now();
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll(".nc-row, .nc-empty").length), { intervals: [10, 20, 50] })
    .toBeGreaterThan(0);
  const elapsed = Date.now() - started;
  // Let fonts and the entrance animation settle before a screenshot.
  await page.waitForTimeout(250);
  return elapsed;
}

async function closeCenter(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
}

async function setFilter(page: Page, label: "All" | "Needs you" | "Unread"): Promise<void> {
  await panel(page).getByRole("tab", { name: new RegExp(`^${label}`) }).click();
}

async function setGrouping(page: Page, by: "day" | "workspace"): Promise<void> {
  await panel(page).getByRole("button", { name: `Group by ${by}` }).click();
}

async function shoot(page: Page, dir: string, scenario: string): Promise<void> {
  for (const theme of THEMES) {
    await setTheme(page, theme.id);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await closeCenter(page);
      const openMs = await openCenter(page);
      const base = `${scenario}-${size.width}x${size.height}-${theme.label}`;
      await page.screenshot({ path: join(dir, `${base}.png`) });
      if (size.width === 1400) {
        await panel(page).screenshot({ path: join(dir, `${base}-panel.png`) });
        await page.screenshot({
          path: join(dir, `${base}-bell.png`),
          clip: { x: size.width - 140, y: 0, width: 140, height: 34 },
        });
      }
      const count = await rows(page).count();
      console.log(`[ncenter-shots] ${base}: ${count} rows, open ${openMs}ms`);
    }
  }
}

async function darkWide(page: Page): Promise<void> {
  await setTheme(page, "codara-classic");
  await page.setViewportSize(SIZES[0]);
  await closeCenter(page);
  await openCenter(page);
}

test.describe.configure({ mode: "serial" });
test.skip(!process.env.SHOTS_DIR, "screenshot harness: set SHOTS_DIR to run it");

for (const scenario of SCENARIOS) {
  test(`notification center shots: ${scenario.name}`, async () => {
    test.setTimeout(240_000);
    const dir = process.env.SHOTS_DIR ?? "";
    await mkdir(dir, { recursive: true });
    const { app, page, root } = await launch(scenario.entries, scenario.seedTargets);
    try {
      if (scenario.name === "full200") {
        await darkWide(page);
        await closeCenter(page);
        const times: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          times.push(await openCenter(page));
          await closeCenter(page);
        }
        console.log(`[ncenter-shots] full200 open times: ${times.join(", ")}ms`);
        await openCenter(page);
        console.log(`[ncenter-shots] full200 rows rendered: ${await rows(page).count()}`);
        await panel(page).screenshot({ path: join(dir, "full200-1400x900-dark-panel.png") });
        return;
      }

      await shoot(page, dir, scenario.name);

      if (scenario.name === "many150") {
        await darkWide(page);
        await panel(page).locator(".nc-list").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await page.waitForTimeout(200);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-dark-scrolled-panel.png") });
        await panel(page).locator(".nc-list").evaluate((el) => {
          el.scrollTop = 0;
        });
        await setGrouping(page, "workspace");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-dark-by-workspace-panel.png") });
        await setTheme(page, "codara-daylight");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-light-by-workspace-panel.png") });
        await setTheme(page, "codara-classic");
        await setGrouping(page, "day");
        await setFilter(page, "Unread");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-dark-unread-panel.png") });
        await setFilter(page, "All");
        // A collapsed stack, then the same stack opened.
        const stack = panel(page).locator(".nc-stack").first();
        await stack.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-dark-stack-panel.png") });
        await stack.locator(".nc-stack-more").click();
        await stack.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-dark-stack-open-panel.png") });
      }

      if (scenario.name === "needs-you" || scenario.name === "few") {
        await darkWide(page);
        await rows(page).nth(1).hover();
        await page.waitForTimeout(200);
        await panel(page).screenshot({ path: join(dir, `${scenario.name}-1400x900-dark-hover-panel.png`) });
        await rows(page).nth(1).getByRole("button", { name: "Mute" }).click();
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, `${scenario.name}-1400x900-dark-mute-menu-panel.png`) });
        await page.keyboard.press("Escape");
        await expect(panel(page)).toBeVisible();
        await page.mouse.move(10, 400);
        await panel(page).locator(".nc-list").focus();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, `${scenario.name}-1400x900-dark-keyboard-panel.png`) });
        // M opens the mute menu with its first item focused.
        await page.keyboard.press("m");
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, `${scenario.name}-1400x900-dark-keyboard-menu-panel.png`) });
        await page.keyboard.press("Escape");
      }

      if (scenario.name === "needs-you") {
        await darkWide(page);
        // The blocked Cora run answers in place.
        await rows(page).filter({ hasText: "Cora needs you" }).first().locator(".nc-reply input").fill("Keep it, but rename it to legacy_sessions_old");
        await page.waitForTimeout(100);
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-dark-answer-panel.png") });
        await rows(page).filter({ hasText: "Cora needs you" }).first().locator(".nc-reply input").fill("");
        await setTheme(page, "codara-daylight");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-light-answer-panel.png") });
        await setTheme(page, "codara-classic");
        await setFilter(page, "Needs you");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-dark-filter-panel.png") });
        await setFilter(page, "All");
        // Mute the first row's workspace for an hour: its row is marked
        // muted, the footer lists the mute, and the badge drops it.
        await rows(page).first().hover();
        await rows(page).first().getByRole("button", { name: "Mute" }).click();
        await panel(page).getByRole("menuitem", { name: /^Everything in/ }).first().click();
        await page.mouse.move(10, 400);
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(dir, "needs-you-1400x900-dark-muted.png") });
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-dark-muted-panel.png") });
        // The agent-level choices in the mute menu of a terminal question.
        const codex = rows(page).filter({ hasText: "Codex needs you" }).first();
        await codex.hover();
        await codex.getByRole("button", { name: "Mute" }).click();
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-dark-agent-menu-panel.png") });
        await page.keyboard.press("Escape");
        // Answer the blocked run in place. The real path resumes the run on a
        // backend this home does not have, so main's handler is stubbed.
        await app.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler("orchestration:answerRunQuestion");
          ipcMain.handle("orchestration:answerRunQuestion", async () => ({}));
        });
        await rows(page).filter({ hasText: "Cora needs you" }).first().getByRole("button", { name: "Drop it now" }).click();
        await page.mouse.move(10, 400);
        await page.waitForTimeout(400);
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-dark-answered-panel.png") });
        await setTheme(page, "codara-daylight");
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, "needs-you-1400x900-light-answered-panel.png") });
      }

      if (scenario.name === "few") {
        await darkWide(page);
        await panel(page).getByRole("button", { name: "Clear all" }).click();
        await page.waitForTimeout(200);
        await panel(page).screenshot({ path: join(dir, "few-1400x900-dark-cleared-undo-panel.png") });
        await panel(page).getByRole("button", { name: "Undo" }).click();
        await expect.poll(() => rows(page).count()).toBeGreaterThan(0);
        await page.waitForTimeout(200);
        await panel(page).screenshot({ path: join(dir, "few-1400x900-dark-after-undo-panel.png") });
        await setTheme(page, "codara-daylight");
        await rows(page).nth(1).hover();
        await page.waitForTimeout(200);
        await panel(page).screenshot({ path: join(dir, "few-1400x900-light-hover-panel.png") });
      }

      if (scenario.name === "closed-targets") {
        // A question whose pane is gone is settled once it stays gone.
        await page.waitForTimeout(2_500);
        await darkWide(page);
        await panel(page).screenshot({ path: join(dir, "closed-targets-1400x900-dark-settled-panel.png") });
        const before = await rows(page).count();
        // A pane that was closed: the click lands on its workspace and says so.
        await rows(page).first().click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, "closed-targets-1400x900-dark-after-click.png") });
        await openCenter(page);
        const after = await rows(page).count();
        await panel(page).screenshot({ path: join(dir, "closed-targets-1400x900-dark-after-click-panel.png") });
        console.log(`[ncenter-shots] closed-targets click on a gone pane: rows ${before} -> ${after}`);

        // A run in a deleted workspace: nothing to open, the panel stays.
        // aria-disabled: there is nothing to open, so force the click through.
        await rows(page).last().click({ force: true });
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, "closed-targets-1400x900-dark-after-deleted-ws-run-click.png") });
        const remaining = await rows(page).count();
        console.log(`[ncenter-shots] closed-targets click on a deleted workspace's run: rows ${after} -> ${remaining}, panel open ${await panel(page).isVisible()}`);
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
