import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Clicking a system notification lands on what it is about. Each alert is
// raised through main's real pipeline (the app.notify dev tool, then the
// policy, the center and the native channel), and main fires the click of the
// very Notification it built, after a full garbage collection: a notification
// main stopped holding would be gone by then, as it was before, when every
// click went nowhere. The window sits on another workspace each time, and each
// target lives in a workspace not opened since launch.
//
// The e2e flag keeps every notification off the desktop: main builds and
// wires it but never shows it (the seam in src/main/notify/deliver.ts).
// Nothing here reads or writes the real ~/.codarastudio.

const WORKSPACES = [
  { id: "ws-home", name: "home", color: "#42D6C7" },
  { id: "ws-term", name: "agents", color: "#78A8FF" },
  { id: "ws-chat", name: "chat", color: "#F2B84B" },
  { id: "ws-auto", name: "nightly", color: "#B48CFF" },
  { id: "ws-loom", name: "docs", color: "#E0A3FF" },
  { id: "ws-git", name: "api-server", color: "#5BD38A" },
  { id: "ws-tree", name: "feature-tree", color: "#FF7A90" },
];

const CHAT_RUN = "run-chat-native";

type NavTarget = Record<string, unknown> & { type: string };

interface Launched {
  app: ElectronApplication;
  page: Page;
  root: string;
  home: string;
  cwdOf: (workspaceId: string) => string;
}

function leaf(paneId: string, cwd: string) {
  return { kind: "leaf", paneId, cwd };
}

async function seedChatRun(home: string, cwd: string): Promise<void> {
  const runDir = join(home, "runs", CHAT_RUN);
  await mkdir(runDir, { recursive: true });
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      id: CHAT_RUN,
      workspaceId: "ws-chat",
      title: "Session store migration",
      status: "complete",
      settingsSnapshot: { workspaceCwd: cwd },
      artifactDir: runDir,
      createdAt: at,
      updatedAt: at,
      conversationEpoch: 0,
      plans: [],
      steps: [],
      workerTasks: [],
      workerAttempts: [],
      checkpoints: [],
      assumptions: [],
      sparkCalls: [],
      humanMessages: [],
      chatBackend: "pi",
      chatMode: "auto",
    }),
    "utf8",
  );
}

async function launch(): Promise<Launched> {
  const root = await mkdtemp(join(tmpdir(), "codara-native-click-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  const cwdOf = (workspaceId: string) =>
    join(root, "projects", WORKSPACES.find((w) => w.id === workspaceId)!.name);
  const workspaces = [];
  for (const ws of WORKSPACES) {
    await mkdir(cwdOf(ws.id), { recursive: true });
    workspaces.push({ ...ws, cwd: cwdOf(ws.id), workers: [] });
  }
  await writeFile(join(home, "spark-state.json"), JSON.stringify({ workspaces, activeWorkspaceId: "ws-home" }), "utf8");
  await seedChatRun(home, cwdOf("ws-chat"));

  const termCwd = cwdOf("ws-term");
  const layouts = {
    "ws-home": {
      v: 6,
      activeId: "term-home",
      tabs: [{ id: "term-home", kind: "terminal", title: "shell", activePaneId: "pane-home", root: leaf("pane-home", cwdOf("ws-home")) }],
    },
    "ws-chat": {
      v: 6,
      activeId: "term-chat",
      tabs: [{ id: "term-chat", kind: "terminal", title: "shell", activePaneId: "pane-chat", root: leaf("pane-chat", cwdOf("ws-chat")) }],
    },
    // The pane to land on is the unselected half of a split in an unselected
    // tab.
    "ws-term": {
      v: 6,
      activeId: "term-shell",
      tabs: [
        { id: "term-shell", kind: "terminal", title: "shell", activePaneId: "pane-shell", root: leaf("pane-shell", termCwd) },
        {
          id: "term-agents",
          kind: "terminal",
          title: "agents",
          activePaneId: "pane-left",
          root: { kind: "split", direction: "horizontal", ratio: 0.5, a: leaf("pane-left", termCwd), b: leaf("pane-right", termCwd) },
        },
      ],
    },
  };

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const app = await electron.launch({
    // Lets the spec collect garbage in main before it clicks.
    args: ["--js-flags=--expose-gc", "."],
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
  await page.setViewportSize({ width: 1400, height: 900 });
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
  return { app, page, root, home, cwdOf };
}

// app.notify on the agent socket: the same publish() every producer calls.
async function raise(home: string, params: Record<string, string>): Promise<void> {
  const handshakeFile = join(home, "agent-socket.json");
  await expect
    .poll(async () => (await readFile(handshakeFile, "utf8").catch(() => "")).length > 0, { timeout: 20_000 })
    .toBe(true);
  const { url, token } = JSON.parse(await readFile(handshakeFile, "utf8")) as { url: string; token: string };
  const response = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.notify", params }),
  });
  const reply = (await response.json()) as { result?: { published?: boolean }; error?: { message: string } };
  expect(reply.error?.message, "app.notify").toBeUndefined();
  expect(reply.result?.published).toBe(true);
}

// The native notification main built for `title`, by its center row id.
async function nativeNotification(app: ElectronApplication, title: string): Promise<{ id: string; target: NavTarget }> {
  let found: { id: string; target: NavTarget } | null = null;
  await expect
    .poll(
      async () => {
        found = await app.evaluate((_electron, wanted) => {
          const list = (globalThis as { __codaraNativeNotifications?: Array<{ id: string; title: string; target: unknown }> })
            .__codaraNativeNotifications;
          const hit = list?.find((n) => n.title.startsWith(wanted));
          return hit ? { id: hit.id, target: hit.target as { type: string } } : null;
        }, title);
        return found !== null;
      },
      { timeout: 15_000, message: `a native notification titled "${title}"` },
    )
    .toBe(true);
  return found!;
}

// Collect garbage in main over a few turns, then fire the click of the
// notification main built, as the OS does when the user clicks it.
async function clickAfterCollection(app: ElectronApplication, id: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const collected = await app.evaluate(() => {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (!gc) return false;
      gc();
      return true;
    });
    expect(collected, "main exposes gc (--js-flags=--expose-gc)").toBe(true);
  }
  const outcome = await app.evaluate((_electron, wanted) => {
    const list = (globalThis as {
      __codaraNativeNotifications?: Array<{ id: string; notification: WeakRef<{ emit(event: string): boolean }> }>;
    }).__codaraNativeNotifications;
    const notification = list?.find((n) => n.id === wanted)?.notification.deref();
    if (!notification) return "collected";
    notification.emit("click");
    return "clicked";
  }, id);
  expect(outcome, "the notification is still alive when the user clicks it").toBe("clicked");
}

const railItem = (page: Page, workspaceId: string) => page.locator(`[data-workspace-id="${workspaceId}"]`).first();

async function expectActiveWorkspace(page: Page, workspaceId: string): Promise<void> {
  await expect(railItem(page, workspaceId)).toHaveAttribute("data-active", "true", { timeout: 15_000 });
}

async function goHome(page: Page): Promise<void> {
  await railItem(page, "ws-home").dispatchEvent("click");
  await expectActiveWorkspace(page, "ws-home");
  await expect(page.locator('[data-tab-id="term-home"]')).toHaveAttribute("aria-selected", "true");
}

async function expectRead(page: Page, entryId: string): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(async (id) => (await window.spark.notifications.list()).find((e) => e.id === id)?.read ?? null, entryId),
    )
    .toBe(true);
}

test("clicking a system notification lands on its target for every target type", async () => {
  test.setTimeout(240_000);
  const { app, page, root, home } = await launch();
  try {
    // Only the native channel, so the alert is a system notification however
    // the test display reports window focus.
    await page.evaluate(() =>
      window.spark.preferences.set("notificationChannels", { inApp: false, native: true, sound: false, osCues: false }),
    );
    // Two automations per workspace: the hub selects the first on its own,
    // so landing on the second proves the click chose it.
    const automationIn = (workspaceId: string, workspaceName: string, names: [string, string]) =>
      page.evaluate(
        async ({ workspaceId, workspaceName, cwd, names }) => {
          const make = (name: string) =>
            window.spark.scheduler.create({
              name,
              trigger: { kind: "manual" },
              input: { workspaceId, workspaceName, cwd },
              enabled: false,
            });
          await make(names[0]);
          return (await make(names[1])).id;
        },
        { workspaceId, workspaceName, cwd: join(root, "projects", workspaceName), names },
      );
    const nightlyTriage = await automationIn("ws-auto", "nightly", ["Dependency bumps", "Nightly triage"]);
    const releaseNotes = await automationIn("ws-loom", "docs", ["Docs sync", "Release notes"]);
    await goHome(page);

    await test.step("an agent pane: its workspace, its tab, its split", async () => {
      await raise(home, {
        kind: "terminal.agent.needs-input",
        title: "Codex needs you",
        body: "Allow running `npm run migrate`?",
        workspaceId: "ws-term",
        tabId: "term-agents",
        paneId: "pane-right",
      });
      const native = await nativeNotification(app, "Codex needs you");
      expect(native.target).toEqual({ type: "terminal", workspaceId: "ws-term", tabId: "term-agents", paneId: "pane-right" });
      await clickAfterCollection(app, native.id);
      await expectActiveWorkspace(page, "ws-term");
      await expect(page.locator('[data-tab-id="term-agents"]')).toHaveAttribute("aria-selected", "true");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const layout = JSON.parse(localStorage.getItem("spark.tabs:ws-term") ?? "{}") as {
              activeId?: string;
              tabs?: Array<{ id: string; activePaneId?: string }>;
            };
            return `${layout.activeId}/${layout.tabs?.find((t) => t.id === "term-agents")?.activePaneId}`;
          }),
        )
        .toBe("term-agents/pane-right");
      await expectRead(page, native.id);
      await goHome(page);
    });

    await test.step("a Cora chat run: its workspace and its chat", async () => {
      await raise(home, {
        kind: "run.complete",
        title: "Codara Studio done",
        body: "Session store migration finished.",
        runId: CHAT_RUN,
        workspaceId: "ws-chat",
      });
      const native = await nativeNotification(app, "Codara Studio done");
      await clickAfterCollection(app, native.id);
      await expectActiveWorkspace(page, "ws-chat");
      await expect(page.locator(`[data-tab-id="${CHAT_RUN}"]`)).toHaveAttribute("aria-selected", "true", {
        timeout: 15_000,
      });
      await expectRead(page, native.id);
      await goHome(page);
    });

    const expectAutomation = async (workspaceId: string, name: string) => {
      await expectActiveWorkspace(page, workspaceId);
      await expect(page.locator('[role="tab"][aria-selected="true"]', { hasText: "Automations" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator(".automation-row[aria-current='true']")).toContainText(name, { timeout: 15_000 });
    };

    // automation.finished names the pass that ended it, which the retention
    // sweep may have deleted by the time the user clicks.
    await test.step("an automation whose run is gone: its workspace, its hub, the automation", async () => {
      await raise(home, {
        kind: "automation.finished",
        title: "Automation finished",
        body: "“Nightly triage” finished after 3 iterations (done).",
        jobId: nightlyTriage,
        runId: "run-swept-by-retention",
        workspaceId: "ws-auto",
      });
      const native = await nativeNotification(app, "Automation finished");
      expect(native.target).toEqual({
        type: "automation",
        jobId: nightlyTriage,
        runId: "run-swept-by-retention",
        workspaceId: "ws-auto",
      });
      await clickAfterCollection(app, native.id);
      await expectAutomation("ws-auto", "Nightly triage");
      await expect(page.getByText("That run is no longer available")).toHaveCount(0);
      await expectRead(page, native.id);
      await goHome(page);
    });

    await test.step("an automation's Notify step: its workspace, its hub, the automation", async () => {
      await raise(home, {
        kind: "automation.step",
        title: "Release notes drafted",
        body: "Draft is in docs/releases/next.md",
        jobId: releaseNotes,
        workspaceId: "ws-loom",
      });
      const native = await nativeNotification(app, "Release notes drafted");
      expect(native.target).toEqual({ type: "automation", jobId: releaseNotes, workspaceId: "ws-loom" });
      await clickAfterCollection(app, native.id);
      await expectAutomation("ws-loom", "Release notes");
      await expectRead(page, native.id);
      await goHome(page);
    });

    await test.step("a pull request: its workspace with Source Control on screen", async () => {
      const sourceControl = page.getByRole("button", { name: "Source Control", exact: true }).first();
      if ((await sourceControl.getAttribute("aria-expanded")) === "true") {
        await sourceControl.click();
        await expect(sourceControl).toHaveAttribute("aria-expanded", "false");
      }
      await raise(home, {
        kind: "git.pull-request",
        title: "New pull request in api-server",
        body: "#42 Add rate limiting, by octocat",
        workspaceId: "ws-git",
        panel: "git",
      });
      const native = await nativeNotification(app, "New pull request in api-server");
      expect(native.target).toEqual({ type: "workspace", workspaceId: "ws-git", panel: "git" });
      await clickAfterCollection(app, native.id);
      await expectActiveWorkspace(page, "ws-git");
      await expect(sourceControl).toHaveAttribute("aria-expanded", "true");
      await expect(sourceControl).toBeVisible();
      await expectRead(page, native.id);
      await goHome(page);
    });

    // What a new worktree's alert opens. No producer raises a bare workspace
    // natively yet, so the kind here only picks the glyph.
    await test.step("a bare workspace target: that workspace", async () => {
      await raise(home, {
        kind: "app.update-ready",
        title: "Claude Code created a worktree",
        body: "feature-tree",
        workspaceId: "ws-tree",
      });
      const native = await nativeNotification(app, "Claude Code created a worktree");
      expect(native.target).toEqual({ type: "workspace", workspaceId: "ws-tree" });
      await clickAfterCollection(app, native.id);
      await expectActiveWorkspace(page, "ws-tree");
      await expectRead(page, native.id);
    });

    await test.step("the notification center's own rows take the same route", async () => {
      await goHome(page);
      await page.locator('button[title="Notifications"]').click();
      const panel = page.getByRole("dialog", { name: "Notifications" });
      await expect(panel).toBeVisible();
      await panel.locator(".nc-row", { hasText: "Codex needs you" }).locator(".nc-open").click();
      await expect(panel).toBeHidden();
      await expectActiveWorkspace(page, "ws-term");
      await expect(page.locator('[data-tab-id="term-agents"]')).toHaveAttribute("aria-selected", "true");
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
