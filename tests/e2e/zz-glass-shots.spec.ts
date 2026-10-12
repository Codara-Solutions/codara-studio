import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// A screenshot harness, not a behavior test: it walks every surface the
// liquid glass material can reach (window chrome, rail, tab strip, chat,
// menus, toasts, the notification center, dialogs, palettes, the board,
// automations and runs) at two window sizes, in a dark and a light theme,
// with glass on and off, so the material can be judged on real pixels. Each
// on/off pair is shot from the same state by flipping html[data-glass] in
// place, so the two frames differ only by the material. It only runs when
// SHOTS_DIR names where the PNGs go:
//
//   SHOTS_DIR=/tmp/glass-shots SPARK_ALLOW_MULTI=1 \
//     npx playwright test tests/e2e/zz-glass-shots.spec.ts
//
// SHOTS_ONLY=<regex> narrows the run to matching surface names (and
// SHOTS_THEME=dark|light, SHOTS_WIDTH=1400|1000, SHOTS_GLASS=on|off to one
// theme, size or glass state, for quick iterations), and SHOTS_PERF=1 also
// records terminal typing and chat scrolling frame times
// with glass on and off into SHOTS_DIR/perf-<theme>.json.
//
// HOME, the Codara home and every CLI home point into a temp root, so the
// shell, the chats and the accounts only ever see fixtures. Account rows come
// from stubbed account IPC handlers: real managed logins would need real
// tokens, and a fake token in a real store would be refreshed on boot.

const SHOTS_DIR = process.env.SHOTS_DIR?.trim() ?? "";
const ONLY = process.env.SHOTS_ONLY?.trim() ? new RegExp(process.env.SHOTS_ONLY.trim()) : null;
const PERF = process.env.SHOTS_PERF === "1";
const ONLY_THEME = process.env.SHOTS_THEME?.trim() || null;
const ONLY_WIDTH = Number(process.env.SHOTS_WIDTH) || null;
const ONLY_GLASS = process.env.SHOTS_GLASS?.trim() || null;
const execFileAsync = promisify(execFile);

const SIZES = [
  { width: 1400, height: 900 },
  { width: 1000, height: 700 },
] as const;

const THEMES = [
  { mode: "dark", theme: "codara-classic" },
  { mode: "light", theme: "codara-daylight" },
] as const;

const WORKSPACES = [
  { id: "ws-web", name: "codara-web", color: "#34D3C3" },
  { id: "ws-api", name: "api-server", color: "#78A8FF" },
  { id: "ws-docs", name: "docs-site", color: "#F0A050" },
  { id: "ws-ml", name: "ml-pipeline", color: "#C78BFF" },
] as const;

const MINUTE = 60_000;

interface Surface {
  name: string;
  run: (ctx: ShotContext) => Promise<void>;
}

interface ShotContext {
  app: ElectronApplication;
  page: Page;
  fixture: Fixture;
  shoot: (name: string, options?: { keepPointer?: boolean }) => Promise<void>;
}

const SURFACES: Surface[] = [
  {
    name: "workbench-terminals",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await shoot("workbench-terminals");
    },
  },
  {
    name: "tab-new-menu",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await page.getByRole("button", { name: "New tab", exact: true }).first().click({ force: true });
      await expect(page.locator(".spark-tabbar-picker").first()).toBeVisible();
      await shoot("tab-new-menu");
      await closeAll(page);
    },
  },
  {
    name: "rail-workspace-menu",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      const opened = await revealLeftRail(page);
      if (opened) await shoot("rail-overlay");
      await page.getByTitle("Workspace actions").first().click({ force: true });
      await expect(page.getByRole("menu").first()).toBeVisible();
      await shoot("rail-workspace-menu");
      await closeAll(page);
      if (opened) await page.getByTitle("Toggle workspaces").first().click({ force: true });
    },
  },
  {
    name: "file-context-menu",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      const row = page.getByText("README.md", { exact: true }).first();
      // A compact window hides the right rail; open it as its overlay.
      let opened = false;
      if (!(await row.isVisible().catch(() => false))) {
        const explorer = page.getByRole("button", { name: /^Explorer/ }).first();
        if (await explorer.isVisible().catch(() => false)) {
          await explorer.click({ force: true });
        } else {
          await page.getByTitle("Toggle right sidebar").first().click({ force: true });
          opened = true;
        }
      }
      await expect(row).toBeVisible({ timeout: 8_000 });
      if (opened) await shoot("rail-overlay-right");
      await row.click({ button: "right" });
      await expect(page.locator(".spark-glass").filter({ hasText: "Rename" }).first()).toBeVisible();
      // Parking the pointer over the workbench closes a menu opened in an
      // overlay rail, so this shot keeps it where the right click left it.
      await shoot("file-context-menu", { keepPointer: true });
      await closeAll(page);
      if (opened && (await page.locator('[data-responsive-panel="right"]').count())) {
        await page.getByTitle("Toggle right sidebar").first().click({ force: true });
      }
    },
  },
  {
    name: "chat",
    run: async ({ page, shoot }) => {
      await showChat(page);
      await shoot("chat");
    },
  },
  {
    name: "chat-scrolled",
    run: async ({ page, shoot }) => {
      await showChat(page);
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
        // Far enough up that the last turns sit under the floating composer.
        if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 150);
      });
      await page.waitForTimeout(400);
      await shoot("chat-scrolled");
    },
  },
  {
    name: "chat-minimap-tooltip",
    run: async ({ page, shoot }) => {
      await showChat(page);
      const mark = page.locator(".cora-timeline-minimap__mark").nth(3);
      if (!(await mark.count())) return;
      await mark.hover({ force: true });
      await expect(page.locator(".cora-timeline-minimap__preview").first()).toBeVisible();
      await page.waitForTimeout(200);
      await shoot("chat-minimap-tooltip", { keepPointer: true });
      await page.mouse.move(2, 450);
    },
  },
  {
    name: "chat-model-menu",
    run: async ({ page, shoot }) => {
      await showChat(page);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-model-picker")));
      await page.waitForTimeout(400);
      await shoot("chat-model-menu");
      await closeAll(page);
    },
  },
  {
    name: "chat-runs",
    run: async ({ page, shoot }) => {
      await showChat(page);
      const runs = page.getByRole("tab", { name: "Runs", exact: true }).first();
      await runs.click({ force: true });
      await page.waitForTimeout(500);
      await shoot("chat-runs");
      const chat = page.getByRole("tab", { name: "Chat", exact: true }).first();
      if (await chat.count()) await chat.click({ force: true });
    },
  },
  {
    name: "board",
    run: async ({ page, shoot }) => {
      await showChat(page);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-cora-board")));
      await expect(page.getByText("Redesign the Cora Board kanban view").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shoot("board");
      const chat = page.getByRole("tab", { name: "Chat", exact: true }).first();
      if (await chat.count()) await chat.click({ force: true });
    },
  },
  {
    name: "toast",
    run: async ({ app, page, shoot }) => {
      await showTerminals(page);
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send("notification:in-app", {
          id: `shots-toast-${Date.now()}`,
          kind: "run.complete",
          tone: "success",
          title: "Codara Studio: done",
          body: "Refactored the billing webhook retries and added 12 tests.",
          target: { type: "run", runId: "r1", workspaceId: "ws-web" },
          timestamp: new Date().toISOString(),
          sourceKey: `shots-toast-${Date.now()}`,
        });
      });
      await expect(page.locator(".spark-toast").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shoot("toast");
      await page.evaluate(() => {
        document
          .querySelectorAll<HTMLButtonElement>(".spark-toast button[aria-label^='Dismiss']")
          .forEach((button) => button.click());
      });
    },
  },
  {
    name: "notification-center",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await page.locator('button[title="Notifications"]').first().click({ force: true });
      await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
      await page.waitForTimeout(300);
      await shoot("notification-center");
      await closeAll(page);
    },
  },
  {
    name: "run-switcher",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(500);
      await shoot("run-switcher");
      await closeAll(page);
    },
  },
  {
    name: "quick-open",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await page.keyboard.press("Control+p");
      await page.waitForTimeout(500);
      await page.waitForTimeout(400);
      await shoot("quick-open-list");
      await page.keyboard.type("read");
      await page.waitForTimeout(500);
      await shoot("quick-open");
      await closeAll(page);
    },
  },
  {
    name: "shortcuts",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await page.keyboard.press("Control+Shift+?");
      await page.waitForTimeout(500);
      await shoot("shortcuts");
      await closeAll(page);
    },
  },
  {
    name: "settings",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      const dialog = await openSettings(page);
      await showSettingsTab(dialog, "General");
      await page.mouse.move(4, 4);
      await shoot("settings-general");
      const appearance = dialog.getByText("Liquid glass", { exact: false }).first();
      if (await appearance.count()) {
        await appearance.scrollIntoViewIfNeeded();
        const adjust = dialog.getByRole("button", { name: "Adjust" });
        if (await adjust.count()) await adjust.click({ force: true });
        // The fine-tune rows open under the switch; bring the last one into
        // view so the shot holds every slider.
        await dialog.locator('input[type="range"]').last().evaluate((node) => {
          node.scrollIntoView({ block: "end" });
        }).catch(() => undefined);
        await page.mouse.move(4, 4);
        await page.waitForTimeout(250);
        await shoot("settings-appearance");
      }
      await showSettingsTab(dialog, "Accounts");
      await expect(dialog.getByText("work@example.com").first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await shoot("settings-accounts");
      await dialog.locator("nav + div").first().evaluate((node) => {
        const cards = node.querySelectorAll(".st-acct");
        const anthropic = cards.item(cards.length - 1);
        anthropic?.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(200);
      await shoot("settings-accounts-2");
      await dialog
        .getByRole("button", { name: /^More actions for/ })
        .first()
        .click({ force: true });
      await expect(page.getByRole("menu").first()).toBeVisible();
      await shoot("settings-account-menu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    },
  },
  {
    name: "capabilities",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-capabilities")));
      const center = page.getByRole("dialog", { name: "Capability Center" });
      await expect(center).toBeVisible();
      await page.waitForTimeout(700);
      await shoot("capabilities");
      await closeAll(page);
    },
  },
  {
    name: "create-copy",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      const opened = await revealLeftRail(page);
      await page.getByTitle("Workspace actions").first().click({ force: true });
      await page.getByRole("menuitem", { name: /^Create isolated worktree/ }).click({ force: true });
      await expect(page.getByText(/Create isolated worktree for/)).toBeVisible();
      await page.waitForTimeout(400);
      await shoot("create-copy");
      await closeAll(page);
      if (opened && (await page.locator('[data-responsive-panel="left"]').count())) {
        await page.getByTitle("Toggle workspaces").first().click({ force: true });
      }
    },
  },
  {
    name: "pairing",
    run: async ({ page, shoot }) => {
      await showTerminals(page);
      const dialog = await openSettings(page);
      await showSettingsTab(dialog, "Remote access");
      const toggle = dialog.getByRole("switch", { name: "Remote access" });
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click({ force: true });
      await dialog.getByRole("button", { name: "Pair a device" }).click({ force: true, timeout: 20_000 });
      const modal = page.getByRole("dialog", { name: "Pair a device" });
      await expect(modal).toBeVisible();
      await page.waitForTimeout(600);
      await shoot("pairing");
      await modal.getByRole("button", { name: "Cancel" }).click({ force: true });
      await toggle.click({ force: true });
      await page.keyboard.press("Escape");
      await closeAll(page);
    },
  },
  {
    name: "whiteboard",
    run: async ({ page, shoot }) => {
      await showChat(page);
      await page.getByRole("tab", { name: "Whiteboard", exact: true }).first().click({ force: true });
      await expect(page.getByText("Retry worker", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await shoot("whiteboard");
      const chat = page.getByRole("tab", { name: "Chat", exact: true }).first();
      if (await chat.count()) await chat.click({ force: true });
    },
  },
  {
    name: "automations",
    run: async ({ page, shoot }) => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-automations-tab")));
      await page.waitForTimeout(900);
      await shoot("automations");
    },
  },
];

for (const { mode, theme } of THEMES) {
  test(`glass screenshots, ${mode} theme`, async () => {
    test.skip(!SHOTS_DIR, "Set SHOTS_DIR to capture glass screenshots.");
    test.skip(Boolean(ONLY_THEME) && ONLY_THEME !== mode, "Another theme was asked for.");
    test.setTimeout(1_200_000);
    await mkdir(SHOTS_DIR, { recursive: true });
    const fixture = await prepareFixture(theme);
    let app: ElectronApplication | null = null;
    const failures: string[] = [];
    try {
      app = await launch(fixture);
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({
        timeout: 30_000,
      });
      await stubAccounts(app);
      await page.evaluate((rows) => window.spark.notifications.restore(rows as never), LIVE_ROWS);
      await seedChat(page, fixture.workspaceDir);
      await fillTerminal(page);

      if (PERF) await measurePerf(page, mode);

      for (const size of SIZES) {
        if (ONLY_WIDTH && ONLY_WIDTH !== size.width) continue;
        await resizeWindow(app, page, size.width, size.height);
        for (const surface of SURFACES) {
          if (ONLY && !ONLY.test(surface.name)) continue;
          const ctx: ShotContext = {
            app,
            page,
            fixture,
            shoot: async (name, options) => {
              if (!options?.keepPointer) await page.mouse.move(2, 450);
              for (const glass of ["on", "off"] as const) {
                if (ONLY_GLASS && ONLY_GLASS !== glass) continue;
                await flipGlass(page, glass === "on");
                await page.screenshot({
                  path: join(SHOTS_DIR, `${mode}-${size.width}x${size.height}-glass-${glass}-${name}.png`),
                });
              }
              await flipGlass(page, true);
            },
          };
          try {
            await surface.run(ctx);
          } catch (error) {
            failures.push(`${mode} ${size.width}x${size.height} ${surface.name}: ${String(error).split("\n")[0]}`);
            await closeAll(page).catch(() => undefined);
          }
        }
      }
    } finally {
      if (failures.length) {
        await writeFile(join(SHOTS_DIR, `failures-${mode}.txt`), `${failures.join("\n")}\n`, "utf8");
      }
      await app?.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

/* ------------------------------------------------------------------- ui */

async function closeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
  }
}

// Flips the material in place, without a preference write, so nothing else
// on screen re-renders between the two frames of a pair. Two animation
// frames let the restyle reach the compositor before the screenshot.
async function flipGlass(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.dataset.glass = value ? "on" : "off";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, on);
  await page.waitForTimeout(120);
}

async function setGlass(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => window.spark.preferences.set("glassEffects", value), on);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.glass))
    .toBe(on ? "on" : "off");
  await page.waitForTimeout(200);
}

async function showTerminals(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: /terminals/i }).first();
  await expect(tab).toBeAttached({ timeout: 15_000 });
  await tab.dispatchEvent("click");
  await page.waitForTimeout(250);
}

// A compact window hides the rails; open the left one as its overlay.
async function revealLeftRail(page: Page): Promise<boolean> {
  if (await page.getByTitle("Workspace actions").first().isVisible().catch(() => false)) return false;
  await page.getByTitle("Toggle workspaces").first().click({ force: true });
  await expect(page.locator('[data-responsive-panel="left"]')).toBeVisible();
  await page.waitForTimeout(300);
  return true;
}

async function showChat(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "Cora" }).last();
  await expect(tab).toBeAttached();
  await tab.dispatchEvent("click");
  await expect(tab).toHaveClass(/spark-tab--active/);
  const assistant = page.locator('[data-message-author="cora"]').last();
  if (!(await assistant.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    await page.getByRole("option").filter({ hasText: "Billing webhook retries" }).first().dispatchEvent("click");
    await expect(assistant).toBeVisible({ timeout: 15_000 });
  }
  await page.waitForTimeout(300);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function showSettingsTab(dialog: Locator, label: string): Promise<void> {
  await dialog.locator("nav").getByRole("button", { name: label, exact: true }).click({ force: true });
  await dialog.page().waitForTimeout(700);
}

async function resizeWindow(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(400, 300);
    win.setContentSize(size.width, size.height);
  }, { width, height });
  await expect
    .poll(() => page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`))
    .toBe(`${width}x${height}`);
  await page.waitForTimeout(300);
}

async function fillTerminal(page: Page): Promise<void> {
  await showTerminals(page);
  const pane = page.locator(".spark-terminal-pane:visible").first();
  await expect(pane).toBeVisible();
  await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
  await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(
    "for i in $(seq 1 80); do echo \"[build] step $i/80 compiling src/modules/feature-$i/index.ts ... ok (${i}2ms)\"; done",
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  // A second pane, so glass over the workbench has two live terminals behind it.
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(800);
  await page.keyboard.type("git log --oneline -n 3 && ls -la src | head -n 30");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}

async function seedChat(page: Page, cwd: string): Promise<void> {
  await page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-web",
      workspaceName: "codara-web",
      cwd: workspaceCwd,
      title: "Billing webhook retries",
    });
    const say = (author: string, message: string) =>
      spark.orchestration.addRunMessage({ runId: run.id, author, kind: "note", message });
    for (let index = 1; index <= 6; index += 1) {
      await say("user", `Earlier question ${index}: what does the retry queue do when Stripe times out?`);
      await say(
        "spark",
        `Earlier answer ${index}. The queue backs off exponentially, caps at five attempts, and parks the event in the dead letter table with the last error so it can be replayed from the admin page.`,
      );
    }
    await say(
      "user",
      "Refactor the billing webhook retries so a slow Stripe response never blocks the queue, and add tests for the dead letter path.",
    );
    await say(
      "spark",
      [
        "Done. The retry worker now runs each delivery under its own timeout.",
        "",
        "- **Queue**: deliveries are leased for 30 s, so a hung request releases its slot.",
        "- **Backoff**: jittered exponential, capped at five attempts.",
        "- **Dead letters**: the last error and response body are stored for replay.",
        "",
        "```ts",
        "await deliver(event, { timeoutMs: 10_000, attempt });",
        "```",
        "",
        "All 48 billing tests pass, including 12 new ones for the dead letter path.",
      ].join("\n"),
    );

    // Content for the board and the whiteboard, so their floating toolbars
    // and minimaps sit over cards and not over an empty canvas.
    const now = new Date().toISOString();
    const board = await spark.board.get(run.id);
    const card = (id: string, title: string, status: string, order = 1, extra: Record<string, unknown> = {}) => ({
      id, title, status, order, createdAt: now, updatedAt: now, ...extra,
    });
    await spark.board.update({
      runId: run.id,
      baseRevision: board.revision,
      workspaceCwd,
      cards: [
        card("c-idea-1", "Replay dead letters from the admin page", "idea"),
        card("c-idea-2", "Alert when the dead letter table grows", "idea", 2),
        card("c-queued-1", "Lease deliveries for 30 s", "queued"),
        card("c-running-1", "Redesign the Cora Board kanban view", "running"),
        card("c-blocked-1", "Pick the backoff cap", "blocked", 1, {
          error: "Five attempts or seven? Stripe retries for three days.",
        }),
        card("c-review-1", "Jittered exponential backoff", "review"),
        card("c-done-1", "Per-delivery timeout", "done"),
        card("c-done-2", "Tests for the dead letter path", "done", 2),
      ],
    });
    await spark.orchestration.updateWhiteboard({
      runId: run.id,
      action: "replace",
      title: "Webhook retry flow",
      summary: "How a slow Stripe response stops blocking the queue.",
      nodes: [
        { id: "stripe", kind: "topic", title: "Stripe webhook", body: "Arrives at /billing/webhook.", x: 60, y: 80 },
        { id: "queue", kind: "flow", title: "Retry queue", body: "Leases each delivery for 30 s.", x: 380, y: 80 },
        { id: "worker", kind: "flow", title: "Retry worker", body: "Runs each delivery under its own timeout.", x: 700, y: 80 },
        { id: "dead", kind: "flow", title: "Dead letters", body: "Last error and body, replayable.", x: 380, y: 320 },
      ],
      edges: [
        { id: "e1", from: "stripe", to: "queue", label: "enqueue", tone: "accent" },
        { id: "e2", from: "queue", to: "worker", label: "lease" },
        { id: "e3", from: "worker", to: "dead", label: "after 5 attempts" },
      ],
    });
  }, cwd);
}

/* ------------------------------------------------------------------ perf */

// Frame and main-thread cost while the terminal receives typed input, while
// it streams output, and while the chat scrolls, with glass on and off
// (alternated twice so drift does not favor one side). Per activity it keeps
// the requestAnimationFrame intervals, the Event Timing durations of the key
// presses (input to next paint, the INP measure), and the CDP task, layout
// and style-recalc time spent during the activity.
type Activity = "typing" | "streaming" | "scrolling";
interface Sample {
  frames: number[];
  events: number[];
  cdp: Record<string, number>;
}

async function measurePerf(page: Page, mode: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  await cdp?.send("Performance.enable").catch(() => undefined);
  const metrics = async (): Promise<Record<string, number>> => {
    if (!cdp) return {};
    const out: Record<string, number> = {};
    const res = (await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))) as {
      metrics: Array<{ name: string; value: number }>;
    };
    for (const m of res.metrics) out[m.name] = m.value;
    return out;
  };
  const measure = async (activity: () => Promise<void>): Promise<Sample> => {
    const before = await metrics();
    await startFrames(page);
    await activity();
    const { frames, events } = await stopFrames(page);
    const after = await metrics();
    const delta: Record<string, number> = {};
    for (const key of ["TaskDuration", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration"]) {
      delta[key] = Number((((after[key] ?? 0) - (before[key] ?? 0)) * 1000).toFixed(1));
    }
    return { frames, events, cdp: delta };
  };

  const results: Record<string, Record<Activity, Sample[]>> = {};
  for (const glass of ["on", "off", "on", "off"] as const) {
    await setGlass(page, glass === "on");
    const bucket = (results[`glass-${glass}`] ??= { typing: [], streaming: [], scrolling: [] });

    await showTerminals(page);
    const pane = page.locator(".spark-terminal-pane:visible").first();
    await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await page.waitForTimeout(300);
    bucket.typing.push(
      await measure(async () => {
        await page.keyboard.type("echo the quick brown fox jumps over the lazy dog 0123456789 abcdefghij", {
          delay: 14,
        });
      }),
    );
    for (let i = 0; i < 70; i += 1) await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    bucket.streaming.push(
      await measure(async () => {
        await page.keyboard.type(
          "for i in $(seq 1 300); do echo \"stream $i ................................................\"; sleep 0.004; done",
        );
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2_000);
      }),
    );

    await showChat(page);
    const scroller = page.locator('[data-testid="cora-conversation"]').first();
    const box = await scroller.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    bucket.scrolling.push(
      await measure(async () => {
        for (let i = 0; i < 40; i += 1) {
          await page.mouse.wheel(0, i < 20 ? -100 : 100);
          await page.waitForTimeout(16);
        }
      }),
    );
  }
  const summary: Record<string, unknown> = {};
  for (const [key, byActivity] of Object.entries(results)) {
    const out: Record<string, unknown> = {};
    for (const [activity, samples] of Object.entries(byActivity)) {
      const cdpSum: Record<string, number> = {};
      for (const sample of samples) {
        for (const [name, value] of Object.entries(sample.cdp)) cdpSum[name] = (cdpSum[name] ?? 0) + value;
      }
      out[activity] = {
        frames: stats(samples.flatMap((s) => s.frames)),
        inputToPaint: stats(samples.flatMap((s) => s.events)),
        mainThreadMs: cdpSum,
      };
    }
    summary[key] = out;
  }
  await writeFile(join(SHOTS_DIR, `perf-${mode}.json`), JSON.stringify(summary, null, 2), "utf8");
  await cdp?.detach().catch(() => undefined);
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  return {
    n: sorted.length,
    meanMs: Number(mean.toFixed(2)),
    p50Ms: Number(pick(0.5).toFixed(2)),
    p95Ms: Number(pick(0.95).toFixed(2)),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    over20Ms: sorted.filter((x) => x > 20).length,
  };
}

async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __frames?: number[];
      __events?: number[];
      __frameStop?: boolean;
      __eventObserver?: PerformanceObserver;
    };
    w.__frames = [];
    w.__events = [];
    w.__frameStop = false;
    w.__eventObserver?.disconnect();
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === "keydown" || entry.name === "keypress") w.__events!.push(entry.duration);
        }
      });
      observer.observe({ type: "event", durationThreshold: 0, buffered: false } as PerformanceObserverInit);
      w.__eventObserver = observer;
    } catch {
      /* Event Timing unavailable */
    }
    let last = performance.now();
    const tick = (now: number) => {
      if (w.__frameStop) return;
      w.__frames!.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame((now) => {
      last = now;
      requestAnimationFrame(tick);
    });
  });
}

async function stopFrames(page: Page): Promise<{ frames: number[]; events: number[] }> {
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const w = window as unknown as {
      __frames?: number[];
      __events?: number[];
      __frameStop?: boolean;
      __eventObserver?: PerformanceObserver;
    };
    w.__frameStop = true;
    w.__eventObserver?.disconnect();
    return { frames: w.__frames ?? [], events: w.__events ?? [] };
  });
}

/* -------------------------------------------------------------- accounts */

// The main process can collect an evaluate's promise while it is still
// booting; a retry after a short pause lands once boot settles.
async function stubAccounts(app: ElectronApplication): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await installAccountStubs(app);
      return;
    } catch (error) {
      if (attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

async function installAccountStubs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const now = new Date().toISOString();
    const windows = (fiveHour: number, sevenDay: number, extra?: number) => [
      { id: "five_hour", label: "5-hour", scope: "general", usedPercent: fiveHour, remainingPercent: 100 - fiveHour, resetsIn: "4h 28m" },
      { id: "seven_day", label: "7-day", scope: "general", usedPercent: sevenDay, remainingPercent: 100 - sevenDay, resetsIn: "3d 10h" },
      ...(extra === undefined
        ? []
        : [{ id: "seven_day_opus", label: "Opus 7-day", scope: "general", usedPercent: extra, remainingPercent: 100 - extra, resetsIn: "3d 10h" }]),
    ];
    const profiles = [
      {
        id: "11111111-1111-4111-8111-111111111111", provider: "anthropic", label: "Codara",
        email: "personal@example.com", builtIn: true, cliProfileId: "personal",
        isDefault: true, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 1 },
      },
      {
        id: "44444444-4444-4444-8444-444444444444", provider: "anthropic", label: "Work",
        email: "work@example.com", cliProfileId: "55555555-5555-4555-8555-555555555555",
        isDefault: false, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
      },
      {
        id: "66666666-6666-4666-8666-666666666666", provider: "openai-codex", label: "Main",
        email: "main@example.com", cliProfileId: "77777777-7777-4777-8777-777777777777",
        isDefault: true, connected: true, expired: false, canRefresh: true, expiresAt: null,
        terminal: { connected: true, expired: false, canRefresh: true, liveSessions: 0 },
      },
    ];
    const overview = () => ({
      runtimeInstalled: true,
      runtimeVersion: "0.85.1",
      runtimeExpectedVersion: "0.85.1",
      runtimeTestedVersion: "0.85.1",
      runtimeSource: "user",
      connections: [],
      switchSessionCounts: { "openai-codex": 0 },
      profiles,
    });
    const usage = () => ({
      checkedAt: now,
      providers: [],
      profiles: [
        { profileId: profiles[0].id, provider: "anthropic", label: "Codara", isDefault: true, status: "ok", plan: "max", windows: windows(0, 18, 2), checkedAt: now },
        { profileId: profiles[1].id, provider: "anthropic", label: "Work", isDefault: false, status: "ok", plan: "max", windows: windows(0, 99, 11), checkedAt: now },
        { profileId: profiles[2].id, provider: "openai-codex", label: "Main", isDefault: true, status: "ok", plan: "pro", windows: windows(12, 40), checkedAt: now },
      ],
    });
    const inspection = () => ({
      runtimes: [
        {
          runtime: "claude", defaultProfileId: "personal",
          profiles: [
            { runtime: "claude", id: "personal", label: "Codara", managed: false, isDefault: true, connected: true, inUse: true, status: "connected", email: "personal@example.com" },
            { runtime: "claude", id: "55555555-5555-4555-8555-555555555555", label: "Work", managed: true, isDefault: false, connected: true, inUse: false, status: "connected", email: "work@example.com" },
          ],
        },
        {
          runtime: "codex", defaultProfileId: "77777777-7777-4777-8777-777777777777",
          profiles: [
            { runtime: "codex", id: "77777777-7777-4777-8777-777777777777", label: "Main", managed: true, isDefault: true, connected: true, inUse: true, status: "connected", email: "main@example.com" },
          ],
        },
      ],
    });
    for (const channel of [
      "pi-subscriptions:status",
      "pi-subscriptions:usage",
      "native-cli-accounts:inspect",
      "pi-subscriptions:resume-login",
    ]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle("pi-subscriptions:status", overview);
    ipcMain.handle("pi-subscriptions:usage", usage);
    ipcMain.handle("native-cli-accounts:inspect", inspection);
    ipcMain.handle("pi-subscriptions:resume-login", () => null);
  });
}

/* --------------------------------------------------------- notifications */

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

const LIVE_ROWS: Entry[] = [
  entry("q-web", 2, {
    kind: "terminal.agent.needs-input",
    sourceKey: "pane:pane-web-agent",
    title: "Claude Code needs you · agent",
    workspaceName: "codara-web",
    body: "Allow running `npm run migrate`?",
    target: { type: "terminal", workspaceId: "ws-web", tabId: "term-web-agent", paneId: "pane-web-agent" },
  }),
];

const DISK_ROWS: Entry[] = [
  entry("done-1", 12, {
    kind: "terminal.agent.done",
    sourceKey: "pane:pane-web-2",
    tone: "success",
    soundKind: "done",
    title: "Claude Code finished · server",
    workspaceName: "codara-web",
    body: "Refactored the session middleware",
    target: { type: "terminal", workspaceId: "ws-web", tabId: "term-web-home", paneId: "pane-web-home" },
  }),
  entry("push-1", 40, {
    kind: "git.teammate-push",
    sourceKey: "github-push:acme/api-server",
    tone: "success",
    soundKind: "done",
    title: "release-bot pushed to api-server",
    workspaceName: "api-server",
    body: "1 commit to main",
    target: { type: "workspace", workspaceId: "ws-api", panel: "git" },
  }),
  entry("fail-1", 90, {
    kind: "run.failed",
    sourceKey: "run:r-failed",
    tone: "danger",
    soundKind: "error",
    title: "Codara Studio: failed",
    workspaceName: "ml-pipeline",
    body: "The training step ran out of memory after 41 minutes.",
    target: { type: "run", runId: "r-failed", workspaceId: "ws-ml" },
  }),
];

/* -------------------------------------------------------------- fixtures */

interface Fixture {
  root: string;
  userHome: string;
  codaraHome: string;
  workspaceDir: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

async function prepareFixture(theme: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-glass-shots-"));
  const userHome = join(root, "home");
  const codaraHome = join(root, "codara-home");
  const projects = join(root, "projects");
  const claudeConfigDir = join(root, "claude-home");
  const codexHomeDir = join(root, "codex-home");
  const grokHomeDir = join(root, "grok-home");
  await Promise.all(
    [userHome, codaraHome, projects, claudeConfigDir, codexHomeDir, grokHomeDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const workspaces = [];
  for (const ws of WORKSPACES) {
    const cwd = join(projects, ws.name);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "README.md"), `# ${ws.name}\n`, "utf8");
    await writeFile(join(cwd, "package.json"), `{"name":"${ws.name}"}\n`, "utf8");
    await writeFile(join(cwd, "src", "index.ts"), "export {};\n", "utf8");
    // Enough files that Quick Open shows a long list.
    for (const name of ["billing", "webhooks", "retry-queue", "dead-letters", "stripe-client", "admin", "auth", "config", "logger", "metrics", "db", "server"]) {
      await writeFile(join(cwd, "src", `${name}.ts`), "export {};\n", "utf8");
    }
    workspaces.push({ ...ws, cwd, workers: [] });
  }
  const workspaceDir = workspaces[0].cwd;
  const git = (args: string[]) => execFileAsync("git", args, { cwd: workspaceDir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "e2e@example.invalid"]);
  await git(["config", "user.name", "Codara E2E"]);
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);

  const rc = "PS1='%~ %# '\nPROMPT='%~ %# '\n";
  await Promise.all([
    writeFile(join(userHome, ".zshrc"), rc, "utf8"),
    writeFile(join(userHome, ".bashrc"), "PS1='\\w $ '\n", "utf8"),
    writeFile(
      join(codaraHome, "spark-state.json"),
      JSON.stringify({ workspaces, activeWorkspaceId: "ws-web" }),
      "utf8",
    ),
    writeFile(
      join(codaraHome, "spark-preferences.json"),
      JSON.stringify({ theme, glassEffects: true }),
      "utf8",
    ),
    writeFile(join(codaraHome, "notifications.json"), JSON.stringify(DISK_ROWS), "utf8"),
  ]);
  return { root, userHome, codaraHome, workspaceDir, claudeConfigDir, codexHomeDir, grokHomeDir };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: fixture.userHome,
      ZDOTDIR: fixture.userHome,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
      GROK_HOME: fixture.grokHomeDir,
    },
  });
}
