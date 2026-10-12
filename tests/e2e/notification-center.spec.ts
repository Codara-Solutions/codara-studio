import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Behaviour of the notification center (the bell panel) against a throwaway
// Codara home: the badge, the Needs you tab and the pinned header count the
// same rows through mutes and closed panes; pinned rows keep their workspace
// when grouped by workspace; Escape peels the mute menu, then the panel, and
// returns focus to the bell; Delete is undoable; closing a pane drops its
// question from the badge. Nothing here reads or writes the real
// ~/.codarastudio.

const MINUTE = 60_000;
const WORKSPACES = [
  { id: "ws-api", name: "api-server", color: "#42D6C7" },
  { id: "ws-web", name: "web-app", color: "#78A8FF" },
];

type Entry = Record<string, unknown> & { id: string };

function entry(id: string, minutesAgo: number, fields: Record<string, unknown>): Entry {
  return {
    id,
    soundKind: "needs-you",
    tone: "warning",
    read: false,
    body: "",
    createdAt: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
    ...fields,
  };
}

function prompt(id: string, minutesAgo: number, workspaceId: string, tabId: string, paneId: string, agent: string): Entry {
  const ws = WORKSPACES.find((w) => w.id === workspaceId)!;
  return entry(id, minutesAgo, {
    kind: "terminal.agent.needs-input",
    sourceKey: `pane:${paneId}`,
    title: `${agent} needs you · ${tabId}`,
    workspaceName: ws.name,
    body: "Allow running `npm run migrate`?",
    target: { type: "terminal", workspaceId, tabId, paneId },
  });
}

// Questions are handed to the running app (as if just raised): the store
// settles terminal prompts it loads from disk, since their panes ended with
// the previous session.
const LIVE_ROWS: Entry[] = [
  prompt("q-api", 2, "ws-api", "term-api-agent", "pane-api-agent", "Claude Code"),
  prompt("q-web", 5, "ws-web", "term-web-agent", "pane-web-agent", "Codex"),
  // Its pane is not in any layout: closed before the panel opened.
  prompt("q-gone", 8, "ws-api", "term-api-old", "pane-api-old", "Codex"),
];

const DISK_ROWS: Entry[] = [
  entry("done-1", 12, {
    kind: "terminal.agent.done",
    sourceKey: "pane:pane-api-agent-2",
    tone: "success",
    soundKind: "done",
    title: "Claude Code finished · server",
    workspaceName: "api-server",
    body: "Refactored the session middleware",
    target: { type: "terminal", workspaceId: "ws-api", tabId: "term-api-agent", paneId: "pane-api-agent" },
  }),
  entry("push-1", 20, {
    kind: "git.teammate-push",
    sourceKey: "github-push:acme/api-server",
    tone: "success",
    soundKind: "done",
    title: "release-bot pushed to api-server",
    workspaceName: "api-server",
    body: "1 commit to main",
    target: { type: "workspace", workspaceId: "ws-api", panel: "git" },
  }),
];

function terminalTab(id: string, title: string, paneId: string, cwd: string) {
  return { id, kind: "terminal", title, activePaneId: paneId, root: { kind: "leaf", paneId, cwd } };
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codara-ncenter-"));
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
  await writeFile(join(home, "spark-state.json"), JSON.stringify({ workspaces, activeWorkspaceId: "ws-api" }), "utf8");
  await writeFile(join(home, "notifications.json"), JSON.stringify(DISK_ROWS), "utf8");
  const cwd = join(root, "projects");
  const layouts = {
    "ws-api": {
      v: 6,
      activeId: "term-api-home",
      tabs: [
        terminalTab("term-api-home", "shell", "pane-api-home", cwd),
        terminalTab("term-api-agent", "agent", "pane-api-agent", cwd),
      ],
    },
    "ws-web": { v: 6, activeId: "term-web-agent", tabs: [terminalTab("term-web-agent", "agent", "pane-web-agent", cwd)] },
  };

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
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
  const ready = () =>
    expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });
  await ready();
  await page.addInitScript((saved) => {
    for (const [workspaceId, layout] of Object.entries(saved)) {
      localStorage.setItem(`spark.tabs:${workspaceId}`, JSON.stringify(layout));
    }
  }, layouts);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await ready();
  await page.evaluate((rows) => window.spark.notifications.restore(rows as never), LIVE_ROWS);
  return { app, page, root };
}

const bell = (page: Page) => page.locator('button[title="Notifications"]');
const badge = (page: Page) => bell(page).locator(".nc-bell-badge");
const panel = (page: Page) => page.getByRole("dialog", { name: "Notifications" });
const row = (page: Page, id: string) => panel(page).locator(`[data-entry-id="${id}"]`);
const needsYouTab = (page: Page) => panel(page).getByRole("tab", { name: /^Needs you/ });
const pinnedCount = (page: Page) =>
  panel(page).locator('section[data-tone="needs-you"] .nc-section-count');

async function openPanel(page: Page): Promise<void> {
  if (await panel(page).isVisible()) return;
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
}

// The badge, the tab and the pinned header must say the same number.
async function expectCounts(page: Page, n: number): Promise<void> {
  if (n === 0) await expect(badge(page)).toHaveCount(0);
  else await expect(badge(page)).toHaveText(String(n));
  await openPanel(page);
  await expect(needsYouTab(page).locator(".nc-filter-count")).toHaveText(n > 0 ? String(n) : "");
  if (n === 0) await expect(pinnedCount(page)).toHaveCount(0);
  else await expect(pinnedCount(page)).toHaveText(String(n));
}

test.describe.configure({ mode: "serial" });

test("notification center counts, keyboard, undo and closed panes", async () => {
  test.setTimeout(180_000);
  const { app, page, root } = await launch();
  try {
    await test.step("a question whose pane is gone never counts", async () => {
      await expectCounts(page, 2);
      await expect(row(page, "q-gone")).toContainText("Pane closed");
      await expect(row(page, "q-gone")).not.toHaveAttribute("data-waiting", /.+/);
    });

    await test.step("pinned rows keep their workspace when grouped by workspace", async () => {
      await panel(page).getByRole("button", { name: "Group by workspace" }).click();
      await expect(row(page, "q-api").locator(".nc-meta-ws")).toHaveText("api-server");
      await expect(row(page, "q-web").locator(".nc-meta-ws")).toHaveText("web-app");
      await panel(page).getByRole("button", { name: "Group by day" }).click();
    });

    await test.step("Escape closes the mute menu, then the panel, then focuses the bell", async () => {
      await row(page, "q-web").focus();
      await page.keyboard.press("m");
      const menu = panel(page).getByRole("menu", { name: "Mute" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(panel(page)).toBeVisible();
      await expect(row(page, "q-web")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeHidden();
      await expect(bell(page)).toBeFocused();
    });

    await test.step("muting a workspace drops its question from every count", async () => {
      await openPanel(page);
      await row(page, "q-web").focus();
      await page.keyboard.press("m");
      await panel(page).getByRole("menuitem", { name: "Everything in web-app" }).first().press("Enter");
      await expect(panel(page).locator(".nc-mute")).toContainText("web-app");
      await expectCounts(page, 1);
      await expect(row(page, "q-web")).toHaveAttribute("data-waiting", "seen");
      await panel(page).locator(".nc-mute").getByRole("button", { name: "Unmute" }).click();
      await expectCounts(page, 2);
    });

    await test.step("Delete dismisses a row and Undo puts it back", async () => {
      await row(page, "done-1").focus();
      await page.keyboard.press("Delete");
      await expect(row(page, "done-1")).toHaveCount(0);
      const undo = panel(page).locator(".nc-undo");
      await expect(undo).toContainText("Dismissed");
      await row(page, "push-1").focus();
      await page.keyboard.press("Delete");
      await expect(undo).toContainText("Dismissed 2 notifications");
      await undo.getByRole("button", { name: "Undo" }).click();
      await expect(row(page, "done-1")).toHaveCount(1);
      await expect(row(page, "push-1")).toHaveCount(1);
    });

    await test.step("Clear all keeps the questions still waiting", async () => {
      await panel(page).getByRole("button", { name: /^Clear all/ }).click();
      await expect(row(page, "done-1")).toHaveCount(0);
      await expect(row(page, "q-api")).toHaveCount(1);
      await expect(row(page, "q-web")).toHaveCount(1);
      await expectCounts(page, 2);
      await panel(page).locator(".nc-undo").getByRole("button", { name: "Undo" }).click();
      await expect(row(page, "done-1")).toHaveCount(1);
    });

    await test.step("closing a question's pane clears it from the badge", async () => {
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeHidden();
      const tab = page.locator(".spark-tab", { hasText: "agent" }).first();
      await tab.hover();
      await tab.getByRole("button", { name: "Close tab" }).click();
      await expect(page.locator(".spark-tab", { hasText: "agent" })).toHaveCount(0);
      await expectCounts(page, 1);
      await expect(row(page, "q-api")).toContainText("Pane closed");
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
