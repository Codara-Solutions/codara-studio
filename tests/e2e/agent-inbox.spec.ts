import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Agents tab as an inbox (after T3 Code) against a throwaway Codara
// home. Main's per-pane activity, the pull request watcher and GitHub are
// stood in for from the main process, so the rows are a fixed, realistic day
// with no real agent, account or network: what needs you and what finished
// on top, the Working, Snoozed and Settled shelves, hover actions, the menu,
// snooze, settle with undo, one-click merge into a non-main base, the
// confirmation for main, and a merged pull request that settles itself.
//
// AGENT_INBOX_SHOTS=<dir> saves the screenshots the pull request shows.

const MIN = 60_000;
const SHOTS = process.env.AGENT_INBOX_SHOTS;

const WORKSPACES = [
  { id: "ws-cos", name: "Company OS", branch: "main", icon: "layers" },
  { id: "ws-sub", name: "Subcloud", branch: "fix/coherence-index-model", icon: "cloud" },
  { id: "ws-studio", name: "Codara Studio", branch: "usage-panel-hairlines", icon: "code" },
  { id: "ws-trading", name: "Trading", branch: "funding-rate-backtest", icon: "package" },
  { id: "ws-cora", name: "Codara Studio", branch: "Cora", icon: "code" },
  { id: "ws-aici", name: "AI Continous Improvment", branch: "main", icon: "brain" },
  { id: "ws-ctrlt", name: "Codara Studio", branch: "fix-ctrl-t", icon: "code" },
  { id: "ws-planner", name: "Company OS", branch: "planner-sync", icon: "layers" },
];

interface Fixture {
  root: string;
  env: Record<string, string>;
  cwd: Record<string, string>;
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-agent-inbox-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(userHome, { recursive: true })]);
  const cwd: Record<string, string> = {};
  for (const workspace of WORKSPACES) {
    const dir = join(root, "projects", workspace.id);
    await mkdir(dir, { recursive: true });
    // A real branch for the row's third line; no remote, so no GitHub.
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", workspace.branch);
    git("commit", "-q", "--allow-empty", "-m", "start");
    cwd[workspace.id] = dir;
  }
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      workspaces: WORKSPACES.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        cwd: cwd[workspace.id],
        color: "#34D3C3",
        icon: workspace.icon,
        workers: [],
      })),
      activeWorkspaceId: "ws-cora",
    }),
    "utf8",
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    root,
    cwd,
    env: {
      ...env,
      HOME: userHome,
      USERPROFILE: userHome,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CODEX_HOME: join(userHome, ".codex"),
      GROK_HOME: join(userHome, ".grok"),
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      // Nothing seeds a terminal here: the agents are stand-ins from main.
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  };
}

function activity(now: number) {
  const pane = (
    paneId: string,
    workspaceId: string,
    state: string,
    prompt: string,
    since: number,
    extra: Record<string, unknown> = {},
  ) => ({
    paneId,
    workspaceId,
    tabId: `tab-${paneId}`,
    tabTitle: prompt,
    runtime: "claude",
    state,
    stateSince: since,
    workingSince: state === "working" ? since : undefined,
    sessionSince: since - 30 * MIN,
    turnStartedAt: state === "working" ? since : null,
    tool: null,
    prompt,
    message: null,
    question: null,
    accountProfileId: null,
    ...extra,
  });
  return [
    pane("p-invoice", "ws-cos", "blocked", "Book the Hetzner invoice", now - 2 * MIN, {
      question: "Book the Hetzner October invoice to Codara Cloud, or split it 70/30 with Studio?",
    }),
    pane("p-pr30", "ws-sub", "error", "PR #30 coherence-index", now - 12 * MIN, {
      message: "FCB coherence-index sends no model, so the request is refused.",
    }),
    pane("p-usage", "ws-studio", "done", "Usage panel (hairlines)", now - 6 * MIN, {
      message: "PR #61 open, checks passed. Ready for you to merge.",
    }),
    pane("p-forge", "ws-trading", "done", "Forge funding-rate backtest", now - 3 * 60 * MIN - 5 * MIN, {
      runtime: "codex",
      message: "Sharpe 1.4 on 2024 to 2026.",
    }),
    pane("p-e2e", "ws-cora", "working", "Full e2e on Cora", now - 18 * MIN, { tool: "npx playwright test" }),
    pane("p-retro", "ws-aici", "working", "Kitchen retro → backlog", now - 4 * MIN, { tool: "Edit backlog.md" }),
    pane("p-ctrlt", "ws-ctrlt", "done", "Ctrl+T new tab fix", now - 41 * MIN, { message: "PR #59 merged." }),
    pane("p-planner", "ws-planner", "done", "Planner sync", now - 20 * MIN, { message: "Synced 14 projects." }),
  ];
}

function watch(workspaceId: string, number: number, phase: string, checks: string, title: string) {
  return {
    workspaceId,
    entry: {
      workspaceId,
      repository: "acme/studio",
      watching: true,
      pullRequest: {
        workspaceId,
        repository: "acme/studio",
        number,
        url: `https://github.com/acme/studio/pull/${number}`,
        title,
        phase,
        checks,
        failed: checks === "failing" ? ["unit"] : [],
        headOid: `head${number}`,
      },
    },
  };
}

// Stands in for main's activity, the watcher and GitHub. Right after boot the
// main-process evaluate can fail ("Resulting promise was garbage
// collected"), so it repeats until it lands; installing twice is harmless.
async function standIns(app: ElectronApplication, fixture: Fixture): Promise<void> {
  const now = Date.now();
  const panes = activity(now);
  const statusFor: Record<string, { number: number; base: string; title: string; head: string }> = {
    [fixture.cwd["ws-studio"]]: { number: 61, base: "Cora", title: "Usage panel (hairlines)", head: "usage-panel-hairlines" },
    [fixture.cwd["ws-cora"]]: { number: 64, base: "main", title: "Release Cora", head: "Cora" },
  };
  await expect(async () => {
    await app.evaluate(
      ({ ipcMain }, { panes, statusFor }) => {
        const g = globalThis as { __merges?: unknown[] };
        g.__merges = [];
        ipcMain.removeHandler("agentBoard:activity");
        ipcMain.handle("agentBoard:activity", async () => panes);
        ipcMain.removeHandler("github:pullRequestDetails");
        ipcMain.handle("github:pullRequestDetails", async (_e, request: { pullRequestNumber: number }) => ({
          pullRequest: { number: request.pullRequestNumber },
          body: "",
          bodyTruncated: false,
          additions: 412,
          deletions: 88,
          changedFiles: 6,
          labels: [],
          files: [],
          filesTruncated: false,
        }));
        const summary = (entry: { number: number; base: string; title: string; head: string }) => ({
          number: entry.number,
          title: entry.title,
          url: `https://github.com/acme/studio/pull/${entry.number}`,
          state: "OPEN",
          isDraft: false,
          baseBranch: entry.base,
          headBranch: entry.head,
          headCommitOid: `head${entry.number}`,
          checks: { total: 3, successful: 3, failed: 0, pending: 0 },
        });
        ipcMain.removeHandler("github:status");
        ipcMain.handle("github:status", async (_e, request: { cwd: string }) => {
          const entry = statusFor[request.cwd];
          if (!entry) return { kind: "not-repository", message: "Not a repository." };
          return {
            kind: "ready",
            repository: { owner: "acme", name: "studio", nameWithOwner: "acme/studio", url: "https://github.com/acme/studio", hostname: "github.com", defaultBranch: "main" },
            pullRequest: summary(entry),
            issues: [],
          };
        });
        ipcMain.removeHandler("github:merge");
        ipcMain.handle("github:merge", async (_e, request: { cwd: string; input: { pullRequestNumber: number; strategy: string } }) => {
          g.__merges?.push(request.input);
          const entry = statusFor[request.cwd];
          return { ok: true, outcome: "merged", strategy: request.input.strategy, pullRequest: summary(entry), receipts: [] };
        });
      },
      { panes, statusFor },
    );
  }).toPass({ timeout: 20_000 });
}

async function sendWatch(app: ElectronApplication, change: ReturnType<typeof watch>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("pullRequestWatch:changed", payload);
  }, change);
}

async function boardChanged(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("agent-board:changed");
  });
}

const ready = (page: Page) =>
  expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });

const viewTab = (page: Page, name: "Workspaces" | "Agents") =>
  page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: new RegExp(`^${name}`) });

const row = (page: Page, paneId: string) => page.locator(`[data-agent-card="pane:${paneId}"]`);
const shelf = (page: Page, name: string) => page.locator(".agent-inbox__shelf-btn", { hasText: name });

async function railShot(page: Page, name: string, extra?: { height?: number }): Promise<void> {
  if (!SHOTS) return;
  const box = await page.locator(".agent-inbox").boundingBox();
  if (!box) return;
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(SHOTS, name),
    clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 44), width: box.width + 16, height: (extra?.height ?? box.height) + 52 },
  });
}

test("the Agents tab is an inbox with shelves, settle, snooze, undo and merge", async () => {
  test.setTimeout(150_000);
  const fixture = await prepare();
  const app = await electron.launch({ args: ["."], env: fixture.env });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await ready(page);
    await standIns(app, fixture);
    // The Usage panel finished while the user was away: unread.
    await page.evaluate(() => {
      window.localStorage.setItem(
        "codara.rail.agents.inbox",
        JSON.stringify({ unread: { "pane:p-usage": Date.now() } }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await ready(page);
    await standIns(app, fixture);
    await sendWatch(app, watch("ws-studio", 61, "open", "passing", "Usage panel (hairlines)"));
    await sendWatch(app, watch("ws-sub", 30, "open", "failing", "coherence-index sends a model"));
    await sendWatch(app, watch("ws-cora", 64, "open", "passing", "Release Cora"));
    await sendWatch(app, watch("ws-ctrlt", 59, "merged", "passing", "Ctrl+T opens a new tab"));
    await boardChanged(app);

    // More of the rail for the list: fold Source Control under it.
    const sourceControl = page.getByTitle(/^Collapse source control$/i);
    if (await sourceControl.count()) await sourceControl.first().click();

    await test.step("the switch counts what waits on you", async () => {
      await expect(viewTab(page, "Agents")).toHaveAccessibleName("Agents, 2 need you", { timeout: 15_000 });
      await viewTab(page, "Agents").click();
    });

    await test.step("needs you and finished on top, three lines, a status word or the age", async () => {
      const inbox = page.locator('[data-agent-shelf="inbox"]');
      await expect(inbox).toHaveCount(5, { timeout: 15_000 });
      await expect(row(page, "p-invoice")).toHaveAttribute("data-agent-status", "input");
      await expect(row(page, "p-invoice").locator(".agent-inbox-row__status")).toHaveText("Input");
      await expect(row(page, "p-pr30").locator(".agent-inbox-row__status")).toHaveText("Failed");
      await expect(row(page, "p-usage").locator(".agent-inbox-row__status")).toHaveText("Done");
      await expect(row(page, "p-forge").locator(".agent-inbox-row__age")).toHaveText("3h");
      await expect(row(page, "p-forge")).toHaveClass(/is-read/);
      await expect(row(page, "p-usage")).not.toHaveClass(/is-read/);
      // Branch and pull request on the third line; +/- only on a finished PR.
      await expect(row(page, "p-usage")).toContainText("usage-panel-hairlines", { timeout: 15_000 });
      await expect(row(page, "p-usage").getByTestId("agent-inbox-pr")).toHaveText("#61✓");
      await expect(row(page, "p-usage").locator(".agent-inbox-row__diff")).toHaveText("+412 −88");
      await expect(row(page, "p-pr30").getByTestId("agent-inbox-pr")).toHaveAttribute("data-checks", "failing");
      await expect(row(page, "p-pr30").locator(".agent-inbox-row__diff")).toHaveCount(0);
      // The agent mark only where it is not the default agent.
      await expect(row(page, "p-usage").locator("[data-agent-runtime]")).toHaveCount(0);
      await expect(row(page, "p-forge").locator('[data-agent-runtime="codex"]')).toHaveAttribute("title", "Codex");
      // The question stays one hover away.
      await expect(row(page, "p-invoice").locator("[data-agent-card-open]")).toHaveAttribute("title", /Hetzner October invoice/);
    });

    await test.step("working agents sit on the Working shelf with a live timer", async () => {
      await expect(shelf(page, "Working")).toHaveAccessibleName("Working, 2");
      await expect(row(page, "p-e2e")).toHaveAttribute("data-agent-shelf", "working");
      await expect(row(page, "p-e2e").locator(".agent-inbox-row__status")).toHaveText("Working18m");
      await expect(row(page, "p-retro").locator(".agent-inbox-row__status")).toHaveText("Working4m");
    });

    await test.step("a merged pull request settled its agent, with a quiet undo", async () => {
      // The shelf is folded until opened.
      await expect(shelf(page, "Settled")).toHaveAccessibleName("Settled, 1");
      await expect(shelf(page, "Settled")).toHaveAttribute("aria-expanded", "false");
      await expect(row(page, "p-ctrlt")).toHaveCount(0);
      await expect(page.locator(".agent-inbox__notice")).toHaveText(/^Settled, #59 merged, (Ctrl\+Z|⌘Z) to undo$/);
    });

    await test.step("snooze one for an hour from the menu", async () => {
      await row(page, "p-planner").locator("[data-agent-card-open]").click({ button: "right" });
      const menu = page.getByRole("menu", { name: "Actions for Planner sync" });
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: /^Snooze/ }).click();
      await expect(menu.getByRole("menuitem", { name: /^1 hour/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Tomorrow\s*09:00$/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Next week\s*Mon$/ })).toBeVisible();
      await menu.getByRole("menuitem", { name: /^1 hour/ }).click();
      await expect(row(page, "p-planner")).toHaveCount(0);
      await expect(shelf(page, "Snoozed")).toHaveAccessibleName("Snoozed, 1");
      await expect(page.locator(".agent-inbox__notice")).toHaveText(/^Snoozed until \d\d:\d\d, /);
    });

    await page.mouse.move(900, 600);
    await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await railShot(page, "agents-list.png");

    await test.step("hover turns the status into Snooze and Settle", async () => {
      await row(page, "p-usage").hover();
      const settle = row(page, "p-usage").getByRole("button", { name: "Settle Usage panel (hairlines)" });
      await expect(settle).toBeVisible();
      await expect(row(page, "p-usage").getByRole("button", { name: "Snooze Usage panel (hairlines)" })).toBeVisible();
      await expect(row(page, "p-usage").locator(".agent-inbox-row__status")).toBeHidden();
      await railShot(page, "agents-hover.png", { height: 260 });
    });

    await test.step("the menu offers Merge only for a ready pull request", async () => {
      await row(page, "p-pr30").locator("[data-agent-card-open]").click({ button: "right" });
      let menu = page.getByRole("menu", { name: "Actions for PR #30 coherence-index" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /^Merge PR/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await row(page, "p-usage").locator("[data-agent-card-open]").click({ button: "right" });
      menu = page.getByRole("menu", { name: "Actions for Usage panel (hairlines)" });
      await expect(menu).toBeVisible();
      const items = await menu.locator(".agent-inbox-menu__label").allTextContents();
      expect(items).toEqual([
        "Open",
        "Merge PR #61",
        "Settle",
        "Snooze",
        "Pin",
        "Rename",
        "Mark read",
        "Copy link",
        "Delete",
      ]);
      if (SHOTS) {
        const rail = await page.locator(".agent-inbox").boundingBox();
        const box = await menu.boundingBox();
        if (rail && box) {
          await page.screenshot({
            path: join(SHOTS, "agents-menu.png"),
            clip: { x: Math.max(0, rail.x - 8), y: Math.max(0, rail.y - 44), width: Math.max(rail.width, box.x + box.width - rail.x) + 24, height: Math.max(rail.height, box.y + box.height - rail.y) + 60 },
          });
        }
      }
    });

    await test.step("Merge into a non-main base merges at once and settles the row", async () => {
      await page.getByRole("menu", { name: "Actions for Usage panel (hairlines)" }).getByRole("menuitem", { name: "Merge PR #61" }).click();
      await expect(row(page, "p-usage")).toHaveCount(0, { timeout: 10_000 });
      await expect(shelf(page, "Settled")).toHaveAccessibleName("Settled, 2");
      const merges = (await app.evaluate(() => (globalThis as { __merges?: unknown[] }).__merges ?? [])) as Array<Record<string, unknown>>;
      expect(merges).toEqual([
        { repository: "acme/studio", pullRequestNumber: 61, baseBranch: "Cora", headBranch: "usage-panel-hairlines", expectedHeadCommitOid: "head61", strategy: "squash" },
      ]);
      await expect(page.locator(".agent-inbox__notice")).toHaveText(/^Settled, #61 merged, /);
    });

    await test.step("Merge into main asks first", async () => {
      // Cora's release PR: the row is working, the menu still offers Merge.
      await row(page, "p-e2e").locator("[data-agent-card-open]").click({ button: "right" });
      await page.getByRole("menu", { name: "Actions for Full e2e on Cora" }).getByRole("menuitem", { name: "Merge PR #64" }).click();
      const dialog = page.getByRole("dialog", { name: "Merge pull request 64" });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText("into main");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      const merges = (await app.evaluate(() => (globalThis as { __merges?: unknown[] }).__merges ?? [])) as unknown[];
      expect(merges).toHaveLength(1);
    });

    await test.step("settle from the hover, then Ctrl+Z brings it back", async () => {
      await row(page, "p-forge").hover();
      await row(page, "p-forge").getByRole("button", { name: "Settle Forge funding-rate backtest" }).click();
      await expect(row(page, "p-forge")).toHaveCount(0);
      await expect(shelf(page, "Settled")).toHaveAccessibleName("Settled, 3");
      await expect(page.locator(".agent-inbox__notice")).toHaveText(/^Settled, (Ctrl\+Z|⌘Z) to undo$/);
      await page.locator(".agent-inbox [data-agent-card-open]").first().focus();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
      await expect(row(page, "p-forge")).toHaveAttribute("data-agent-shelf", "inbox");
      await expect(page.locator(".agent-inbox__notice")).toHaveCount(0);
    });

    await test.step("E settles the focused row", async () => {
      await row(page, "p-forge").locator("[data-agent-card-open]").focus();
      await page.keyboard.press("e");
      await expect(row(page, "p-forge")).toHaveCount(0);
      await expect(shelf(page, "Settled")).toHaveAccessibleName("Settled, 3");
    });

    await test.step("the Settled shelf opens to one greyed line per agent", async () => {
      await shelf(page, "Settled").click();
      await expect(shelf(page, "Settled")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator('[data-agent-shelf="settled"]')).toHaveCount(3);
      await expect(row(page, "p-ctrlt").getByTestId("agent-inbox-pr")).toHaveText("#59merged");
      await page.mouse.move(0, 0);
      await railShot(page, "agents-settled.png");
    });

    await test.step("undoing an auto-settle keeps the agent out of the shelf", async () => {
      await row(page, "p-ctrlt").locator("[data-agent-card-open]").click({ button: "right" });
      await page.getByRole("menu", { name: "Actions for Ctrl+T new tab fix" }).getByRole("menuitem", { name: /^Un-settle/ }).click();
      await expect(row(page, "p-ctrlt")).toHaveAttribute("data-agent-shelf", "inbox");
      await sendWatch(app, watch("ws-ctrlt", 59, "merged", "passing", "Ctrl+T opens a new tab"));
      await boardChanged(app);
      await page.waitForTimeout(500);
      await expect(row(page, "p-ctrlt")).toHaveAttribute("data-agent-shelf", "inbox");
    });

    await test.step("rename and pin from the menu", async () => {
      await row(page, "p-forge").locator("[data-agent-card-open]").click({ button: "right" });
      await page.getByRole("menu", { name: "Actions for Forge funding-rate backtest" }).getByRole("menuitem", { name: /^Un-settle/ }).click();
      await row(page, "p-forge").locator("[data-agent-card-open]").click({ button: "right" });
      await page.getByRole("menu", { name: "Actions for Forge funding-rate backtest" }).getByRole("menuitem", { name: "Rename" }).click();
      const field = page.getByRole("textbox", { name: "Name for Forge funding-rate backtest" });
      await expect(field).toBeFocused();
      await field.fill("Forge backtest");
      await field.press("Enter");
      await expect(row(page, "p-forge").locator(".agent-inbox-row__title")).toHaveText("Forge backtest");
      await row(page, "p-forge").locator("[data-agent-card-open]").click({ button: "right" });
      await page.getByRole("menu", { name: "Actions for Forge backtest" }).getByRole("menuitem", { name: "Pin" }).click();
      await expect(page.locator('[data-agent-shelf="inbox"]').first()).toHaveAttribute("data-agent-card", "pane:p-forge");
    });

    await test.step("what the user decided survives a reload", async () => {
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await ready(page);
      await standIns(app, fixture);
      await boardChanged(app);
      await expect(row(page, "p-forge").locator(".agent-inbox-row__title")).toHaveText("Forge backtest", { timeout: 15_000 });
      await expect(shelf(page, "Snoozed")).toHaveAccessibleName("Snoozed, 1");
      await expect(row(page, "p-usage")).toHaveAttribute("data-agent-shelf", "settled");
    });
  } finally {
    await app.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
