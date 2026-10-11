import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Screenshot harness for the notification center (the bell panel). Not an
// assertion suite: it seeds a fake Codara home with a realistic
// notifications.json and photographs the open panel in each state, at two
// window sizes and in a dark and a light theme, so a visual change can be
// judged side by side. Shots land in SHOTS_DIR (or the test output folder).
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
    body: `${commits} commit${commits === 1 ? "" : "s"} to feature/sync ${DASH} ${COMMITS[i % COMMITS.length]}`,
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
    agentDone(2, api, 1),
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

const SCENARIOS: Array<{ name: string; entries: Entry[] | null }> = [
  { name: "empty", entries: null },
  { name: "few", entries: fewItems() },
  { name: "many150", entries: manyItems() },
  { name: "needs-you", entries: needsYouItems() },
  { name: "closed-targets", entries: closedTargetItems() },
];

const SIZES = [
  { width: 1400, height: 900 },
  { width: 1000, height: 700 },
];

const THEMES = [
  { label: "dark", id: "codara-classic" },
  { label: "light", id: "codara-daylight" },
];

async function launch(entries: Entry[] | null) {
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
  if (entries) {
    await writeFile(join(home, "notifications.json"), JSON.stringify(entries, null, 2), "utf8");
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
  return { app, page, root };
}

function bell(page: Page) {
  return page.locator('button[title="Notifications"]');
}

function panel(page: Page) {
  return page.getByRole("dialog", { name: "Notifications" });
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
  // The list arrives over IPC after the panel mounts.
  await page.waitForTimeout(400);
  return Date.now() - started;
}

async function closeCenter(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
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
      }
      const rows = await panel(page).locator('[role="button"]').count();
      console.log(`[ncenter-shots] ${base}: ${rows} rows, open ${openMs}ms`);
    }
  }
}

test.describe.configure({ mode: "serial" });

for (const scenario of SCENARIOS) {
  test(`notification center shots: ${scenario.name}`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const dir = process.env.SHOTS_DIR || testInfo.outputPath("shots");
    await mkdir(dir, { recursive: true });
    const { app, page, root } = await launch(scenario.entries);
    try {
      await shoot(page, dir, scenario.name);

      if (scenario.name === "many150") {
        // The bottom of a long history: older days, read rows.
        await setTheme(page, "codara-classic");
        await page.setViewportSize(SIZES[0]);
        await closeCenter(page);
        await openCenter(page);
        await panel(page)
          .locator("div")
          .filter({ has: page.locator('[role="button"]') })
          .first()
          .evaluate((el) => {
            let node: HTMLElement | null = el as HTMLElement;
            while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
            if (node) node.scrollTop = node.scrollHeight;
          });
        await page.waitForTimeout(200);
        await panel(page).screenshot({ path: join(dir, "many150-1400x900-dark-scrolled-panel.png") });
      }

      if (scenario.name === "needs-you" || scenario.name === "few") {
        // A hovered row shows what actions it offers.
        await setTheme(page, "codara-classic");
        await page.setViewportSize(SIZES[0]);
        await closeCenter(page);
        await openCenter(page);
        await panel(page).locator('[role="button"]').first().hover();
        await page.waitForTimeout(150);
        await panel(page).screenshot({ path: join(dir, `${scenario.name}-1400x900-dark-hover-panel.png`) });
      }

      if (scenario.name === "closed-targets") {
        // Clicking an entry whose pane is gone: record what the user is left
        // with (the row disappears and nothing opens).
        await setTheme(page, "codara-classic");
        await page.setViewportSize(SIZES[0]);
        await closeCenter(page);
        await openCenter(page);
        const before = await panel(page).locator('[role="button"]').count();
        await panel(page).locator('[role="button"]').first().click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, "closed-targets-1400x900-dark-after-click.png") });
        await openCenter(page);
        const after = await panel(page).locator('[role="button"]').count();
        await panel(page).screenshot({ path: join(dir, "closed-targets-1400x900-dark-after-click-panel.png") });
        console.log(`[ncenter-shots] closed-targets click on a gone pane: rows ${before} -> ${after}`);

        // A run that lived in a deleted workspace.
        await panel(page).locator('[role="button"]').last().click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(dir, "closed-targets-1400x900-dark-after-deleted-ws-run-click.png") });
        await openCenter(page);
        const remaining = await panel(page).locator('[role="button"]').count();
        console.log(`[ncenter-shots] closed-targets click on a deleted workspace's run: rows ${after} -> ${remaining}`);
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
