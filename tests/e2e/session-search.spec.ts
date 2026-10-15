import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Agent session search in a temp HOME holding small fake Claude and Codex
// transcripts: the rail's Sessions view lists and searches them, with
// highlights, scopes and the agent filter; a click resumes one in a new
// terminal tab of its workspace (a folder no workspace has becomes one); a
// session whose folder is gone opens read only; the jump palette searches
// sessions too; the one-time intro dialog shows the build and stays closed.

const JUMP = process.platform === "darwin" ? "Meta+j" : "Control+Shift+J";

const IDS = {
  pelican: "aaaaaaaa-1111-4111-8111-111111111111",
  codexPelican: "bbbbbbbb-2222-4222-8222-222222222222",
  heron: "cccccccc-3333-4333-8333-333333333333",
  albatross: "dddddddd-4444-4444-8444-444444444444",
};

interface Fixture {
  root: string;
  homeDir: string;
  userDataDir: string;
  workspaceDir: string;
  otherDir: string;
  binDir: string;
  launchLog: string;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function claudeTranscript(cwd: string, title: string, turns: [string, string][], minutesAgo: number): string {
  const lines: unknown[] = [];
  turns.forEach(([user, reply], index) => {
    lines.push({ type: "user", cwd, timestamp: at(minutesAgo - index), message: { role: "user", content: user } });
    lines.push({
      type: "assistant",
      timestamp: at(minutesAgo - index),
      message: { role: "assistant", model: "claude-fixture", content: [{ type: "text", text: reply }] },
    });
  });
  lines.push({ type: "ai-title", aiTitle: title });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

async function writeClaudeSession(homeDir: string, cwd: string, id: string, title: string, turns: [string, string][], minutesAgo: number) {
  const dir = join(homeDir, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), claudeTranscript(cwd, title, turns, minutesAgo), "utf8");
}

async function writeCodexSession(homeDir: string, cwd: string, id: string, user: string, reply: string) {
  const dir = join(homeDir, ".codex", "sessions", "2026", "08", "03");
  await mkdir(dir, { recursive: true });
  const lines = [
    { timestamp: at(30), type: "session_meta", payload: { id, cwd, source: "cli", originator: "codex_cli_rs" } },
    { timestamp: at(30), type: "turn_context", payload: { cwd, model: "gpt-fixture" } },
    { timestamp: at(30), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } },
    { timestamp: at(29), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] } },
  ];
  await writeFile(
    join(dir, `rollout-2026-08-03T12-00-00-${id}.jsonl`),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    "utf8",
  );
}

// A stand-in agent CLI: records the folder it started in and its arguments,
// then waits like an interactive session.
async function writeFakeCli(path: string, launchLog: string) {
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s|%s %s\\n' "$PWD" "$(basename "$0")" "$*" >> '${launchLog}'\nprintf 'fake agent ready\\r\\n'\nexec sleep 600\n`,
    "utf8",
  );
  await chmod(path, 0o755);
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-session-search-"));
  const fixture: Fixture = {
    root,
    homeDir: join(root, "home"),
    userDataDir: join(root, "user-data"),
    workspaceDir: join(root, "workspace"),
    otherDir: join(root, "other"),
    binDir: join(root, "bin"),
    launchLog: join(root, "launches.log"),
  };
  await Promise.all(
    [fixture.homeDir, fixture.userDataDir, fixture.workspaceDir, fixture.otherDir, fixture.binDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await writeFile(join(fixture.homeDir, ".zprofile"), `export PATH='${fixture.binDir}':$PATH\n`, "utf8");
  await writeFile(fixture.launchLog, "", "utf8");
  await writeFakeCli(join(fixture.binDir, "claude"), fixture.launchLog);
  await writeFakeCli(join(fixture.binDir, "codex"), fixture.launchLog);

  await writeClaudeSession(fixture.homeDir, fixture.workspaceDir, IDS.pelican, "Pelican migration", [
    ["How do we migrate the pelican service?", "Move the pelican queue first, then the workers."],
    ["And the database?", "Copy it during the quiet hour."],
  ], 10);
  await writeCodexSession(fixture.homeDir, fixture.workspaceDir, IDS.codexPelican, "Pick pelican dashboard colors", "Use the brand teal.");
  await writeClaudeSession(fixture.homeDir, fixture.otherDir, IDS.heron, "Heron inventory", [["Count the heron nests", "There are twelve."]], 60);
  // Its folder was never created: the session can only be read.
  await writeClaudeSession(fixture.homeDir, join(root, "gone"), IDS.albatross, "Albatross notes", [["Keep the albatross notes", "Saved."]], 120);

  await writeFile(
    join(fixture.userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-sessions", name: "workspace", cwd: fixture.workspaceDir, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-sessions",
    }),
    "utf8",
  );
  return fixture;
}

async function launch(fixture: Fixture, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    ELECTRON_RENDERER_URL: _electronRendererUrl,
    ...electronEnv
  } = process.env;
  const app = await electron.launch({
    args: ["."],
    env: {
      ...electronEnv,
      HOME: fixture.homeDir,
      CLAUDE_CONFIG_DIR: join(fixture.homeDir, ".claude"),
      CODEX_HOME: join(fixture.homeDir, ".codex"),
      GROK_HOME: join(fixture.homeDir, ".grok"),
      PI_CODING_AGENT_DIR: join(fixture.homeDir, ".pi", "agent"),
      PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function openSessionsView(page: Page) {
  await page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: /^Sessions/ }).click();
  const view = page.getByTestId("session-search");
  await expect(view).toBeVisible();
  return view;
}

async function launches(fixture: Fixture): Promise<string[]> {
  return (await readFile(fixture.launchLog, "utf8")).split("\n").filter(Boolean);
}

/** True once the fake Claude started in `cwd` resuming `sessionId` (Codara adds its own flags first). */
async function resumed(fixture: Fixture, cwd: string, sessionId: string): Promise<boolean> {
  return (await launches(fixture)).some(
    (line) => line.startsWith(`${cwd}|claude `) && line.endsWith(` --resume ${sessionId}`),
  );
}

test("the Sessions view finds past agent sessions and resumes them in new tabs", async () => {
  test.setTimeout(150_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    // e2e runs never see the first-run dialog unless a spec asks for it.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("session-search-intro")).toHaveCount(0);

    const view = await openSessionsView(page);
    const rows = view.locator("[data-session-row]");
    const search = view.getByRole("searchbox", { name: "Search agent sessions" });
    const scopes = view.getByRole("tablist", { name: "Sessions from" });

    // Opening the view builds the index; an empty box lists this project's recent sessions.
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(view.getByRole("status")).toHaveText("4 sessions · 10 messages searchable", { timeout: 15_000 });
    await expect(rows.first()).toContainText("Pelican migration");
    await expect(rows.first()).toContainText("4 messages");
    await expect(rows.first()).toHaveAttribute("data-session-agent", "claude");
    await scopes.getByRole("tab", { name: "All" }).click();
    await expect(rows).toHaveCount(4);

    // Search: matching sessions only, the words highlighted.
    await search.fill("pelican");
    await expect(rows).toHaveCount(2);
    const pelican = view.locator(`[data-session-row="claude:${IDS.pelican}"]`);
    await expect(pelican.locator(".ss-hl").first()).toHaveText(/pelican/i);
    await expect(pelican.locator(".ss-row__snippet")).toContainText("pelican");

    // The agent filter.
    await view.getByRole("button", { name: "All agents" }).click();
    await page.getByRole("menu", { name: "Agents to show" }).getByRole("menuitemcheckbox", { name: "Codex" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-session-agent", "codex");
    await page.keyboard.press("Escape");
    await view.getByRole("button", { name: "Codex" }).click();
    await page.getByRole("menu", { name: "Agents to show" }).getByRole("menuitemradio", { name: "All agents" }).click();
    await expect(rows).toHaveCount(2);

    // Row actions: copy the session id.
    await pelican.hover();
    await view.getByRole("button", { name: "More for Pelican migration" }).click();
    await page.getByRole("menu", { name: "Session actions" }).getByRole("menuitem", { name: "Copy session id" }).click();
    await expect(view.getByRole("status")).toHaveText("Session id copied");
    expect(await page.evaluate(() => window.spark.clipboard.readText())).toBe(IDS.pelican);

    // A session whose folder is gone opens read only, and says why.
    await search.fill("albatross");
    const albatross = view.locator(`[data-session-row="claude:${IDS.albatross}"]`);
    await expect(albatross).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(albatross).toContainText("folder gone");
    await albatross.click();
    const transcript = page.getByRole("dialog", { name: "Session transcript" });
    await expect(transcript).toBeVisible();
    await expect(transcript.getByRole("status")).toContainText("is no longer on this computer");
    await expect(transcript).toContainText("Keep the albatross notes");
    await transcript.getByRole("button", { name: "Close" }).click();
    await expect(transcript).toHaveCount(0);
    expect(await launches(fixture)).toEqual([]);

    // A click resumes the session in a new terminal tab of its workspace, with no picker.
    await search.fill("pelican queue");
    await expect(rows).toHaveCount(1);
    await expect(pelican).toBeVisible();
    await pelican.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => resumed(fixture, fixture.workspaceDir, IDS.pelican), { timeout: 20_000 }).toBe(true);

    // The jump palette hands any text to the Sessions view, searching everything.
    await page.keyboard.press(JUMP);
    const palette = page.getByTestId("jump-palette");
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox", { name: "Search workspaces, tabs and agents" })).toBeFocused();
    await page.keyboard.type("heron");
    const sessionsRow = palette.locator('[data-jump-kind="sessions"]');
    await expect(sessionsRow).toContainText("Search agent sessions for “heron”");
    await sessionsRow.click();
    await expect(palette).toHaveCount(0);
    await expect(search).toHaveValue("heron");
    await expect(search).toBeFocused();
    await expect(scopes.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    await expect(view.locator(`[data-session-row="claude:${IDS.heron}"]`)).toContainText("Heron inventory");
    await expect(rows).toHaveCount(1);

    // A folder no workspace has becomes a workspace, and the session resumes there.
    await search.press("Enter");
    await expect.poll(() => resumed(fixture, fixture.otherDir, IDS.heron), { timeout: 20_000 }).toBe(true);
    await page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: "Workspaces" }).click();
    await expect(page.locator("[data-workspace-id]", { hasText: "other" }).first()).toBeVisible();

    // The index lives under the Codara home, readable by its owner only.
    const { stat } = await import("node:fs/promises");
    const index = await stat(join(fixture.userDataDir, "session-index", "sessions.sqlite"));
    if (process.platform !== "win32") expect(index.mode & 0o777).toBe(0o600);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the first-run dialog shows the build once and continues it in the background", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture, { CODARA_E2E_SESSION_SEARCH_INTRO: "1" });
    app = launched.app;
    const { page } = launched;
    const intro = page.getByTestId("session-search-intro");
    await expect(intro).toBeVisible({ timeout: 20_000 });
    await expect(intro.getByRole("heading", { name: "Indexing your agent sessions" })).toBeVisible();
    await expect(intro).toContainText("Change or turn it off anytime in Settings → Agent session search.");
    await expect(intro.getByRole("status")).toHaveText(/4 sessions · 10 messages searchable/, { timeout: 20_000 });
    await intro.getByRole("button", { name: /Continue in background|Done/ }).click();
    await expect(intro).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("session-search-intro")).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
