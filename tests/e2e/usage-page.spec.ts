import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Usage tab, driven through the real renderer, preload bridge and scan
// worker. All three transcript roots point into a temp home, so the page shows
// exactly the one seeded Claude Code session and nothing of this machine's.
//
// What this proves:
//  - A window with no usage says so and offers the last year, instead of a
//    page of zeros, and the button switches the window.
//  - The figures are the ones the transcript implies: cache hits count cache
//    writes as prompt tokens (80.0%, not 88.9%), and cache savings are net of
//    the cache-write premium ($6.95, not $7.20).
//  - A one-year window names both years in its header and on its days.
//  - In a narrow pane no table cell wraps and the page itself never scrolls
//    sideways; a wide table scrolls inside its own card.

const SESSION_ID = "eeeeeee5-5555-4555-8555-555555555555";

// Two turns of claude-opus-5 ($5 in, $0.50 cache read, $6.25 cache write, $25
// out per million). Per turn: 100K new input, 800K cache read, 100K cache
// write, 50K output = $2.775, so the session costs $5.55 over 2.1M tokens.
const TURN_USAGE = {
  input_tokens: 100_000,
  cache_read_input_tokens: 800_000,
  cache_creation_input_tokens: 100_000,
  output_tokens: 50_000,
};

// Far enough back that the default 30-day and the 90-day windows are empty,
// well inside the one-year window.
const DAYS_AGO = 100;

interface Fixture {
  root: string;
  userDataDir: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

test("the usage page explains an empty window and reports a year's figures", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await openUsage(page);

    // 1. The default 30-day window has nothing in it.
    const empty = page.locator("[data-usage-empty]");
    await expect(empty).toBeVisible({ timeout: 30_000 });
    await expect(empty).toContainText("No usage between");
    await expect(page.locator("[data-usage-stats]")).toHaveCount(0);
    // The transcript was found; its session simply falls outside the window.
    await expect(page.getByText("1 file · 0 sessions", { exact: true })).toBeVisible();

    // 2. One click away from the year that has the session.
    await empty.getByRole("button", { name: "Show the last year", exact: true }).click();
    const windowGroup = page.getByRole("group", { name: "Usage window" });
    await expect(windowGroup.getByRole("button", { name: "1y" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("[data-usage-stats]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-usage-range]")).toHaveText(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4} to [A-Z][a-z]{2} \d{1,2}, \d{4} · scanned /,
    );

    // 3. The figures the transcript implies.
    const stat = (label: string) => page.locator(`[data-usage-stat="${label}"]`);
    await expect(stat("Est. cost")).toContainText("$5.55*");
    await expect(stat("Total tokens")).toContainText("2.10M");
    await expect(stat("Sessions")).toContainText("1");
    await expect(stat("Active days")).toContainText("1 / 365");
    await expect(stat("Per active day")).toContainText("2.10M");
    await expect(stat("Cache hits")).toContainText("80.0%");
    await expect(stat("Cache saved")).toContainText("$6.95");
    await expect(stat("Output tokens")).toContainText("100K");

    // 4. A year's days carry their year.
    await page
      .getByRole("group", { name: "Breakdown grouping" })
      .getByRole("button", { name: "Day" })
      .click();
    const seededDay = new Date(Date.now() - DAYS_AGO * 86_400_000);
    await expect(
      page.locator("[data-usage-table] td").filter({ hasText: `, ${seededDay.getFullYear()}` }).first(),
    ).toBeVisible();
    await expect(page.locator("[data-usage-axis]")).toContainText(
      String(new Date().getFullYear()),
    );

    // 5. A narrow pane: cells stay on one line and only the tables scroll.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(720, 900);
    });
    await page
      .getByRole("group", { name: "Breakdown grouping" })
      .getByRole("button", { name: "Model" })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(720);
    const layout = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-usage-page]");
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-usage-table] td"));
      return {
        pageOverflow: root ? root.scrollWidth - root.clientWidth : -1,
        cells: cells.length,
        tallestCell: Math.max(...cells.map((cell) => cell.getBoundingClientRect().height)),
      };
    });
    expect(layout.pageOverflow).toBe(0);
    expect(layout.cells).toBeGreaterThan(0);
    // One line of 12px text plus padding is ~31px; a wrapped cell is ~46px.
    expect(layout.tallestCell).toBeLessThan(40);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function openUsage(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+U");
  const opened = await page
    .locator("[data-usage-page]")
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) await page.getByRole("button", { name: "Usage analytics" }).first().click();
  await expect(page.locator("[data-usage-page]")).toBeVisible();
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-usage-page-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const claudeConfigDir = join(root, "claude-home");
  const codexHomeDir = join(root, "codex-home");
  const grokHomeDir = join(root, "grok-home");
  const claudeProjectDir = join(
    claudeConfigDir,
    "projects",
    workspaceDir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(claudeProjectDir, { recursive: true }),
    mkdir(codexHomeDir, { recursive: true }),
    mkdir(grokHomeDir, { recursive: true }),
  ]);
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-usage-page",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-usage-page",
      },
      null,
      2,
    ),
    "utf8",
  );

  // Local noon, so the turn lands on the same calendar day in any zone the
  // page resolves it in.
  const when = new Date();
  when.setDate(when.getDate() - DAYS_AGO);
  when.setHours(12, 0, 0, 0);
  const lines = [0, 1].map((turn) =>
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(when.getTime() + turn * 60_000).toISOString(),
      sessionId: SESSION_ID,
      cwd: workspaceDir,
      requestId: `req_usage_${turn}`,
      message: {
        id: `msg_usage_${turn}`,
        model: "claude-opus-5",
        role: "assistant",
        usage: TURN_USAGE,
      },
    }),
  );
  await writeFile(join(claudeProjectDir, `${SESSION_ID}.jsonl`), `${lines.join("\n")}\n`, "utf8");

  return { root, userDataDir, claudeConfigDir, codexHomeDir, grokHomeDir };
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
      // The scan reads all three of these; anything else would put this
      // machine's own sessions on the page.
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
      GROK_HOME: fixture.grokHomeDir,
    },
  });
}
