import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Live end-to-end coverage for the restoreAgentSessions toggle:
//   1. The Settings switch round-trips into spark-preferences.json.
//   2. With the toggle on, a real Claude conversation started in a pane
//      survives quit → relaunch (the resumed CLI still knows the marker).
// The conversation test drives the installed authenticated `claude` CLI, so
// it is opt-in like the Codex live smoke.

const WS_ID = "ws-resume-e2e";
const MARKER = "SPARK_E2E_MARKER_42";

// Mirror of encodeCwdForClaudeProjects (src/main/orchestration/claude-paths.ts):
// where the real Claude CLI writes this cwd's transcripts.
function claudeProjectsDirFor(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

async function prepareWorkspace(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codara-resume-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Resume probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          { id: WS_ID, name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] },
        ],
        activeWorkspaceId: WS_ID,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}

function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
    },
  });
}

async function openTerminalsTab(page: Page): Promise<Locator> {
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("workspace").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: /terminals/i }).first().click();
  const input = page.locator(".xterm-helper-textarea:visible").first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  return input;
}

// Every assistant transcript line in this cwd's project bucket that contains
// `needle` and was written at/after `sinceMs`. On-disk evidence beats buffer
// scraping: it proves the real CLI answered, not just that pixels moved.
async function assistantHits(dir: string, needle: string, sinceMs: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let hits = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"') || !line.includes(needle)) continue;
      const ts = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      if (ts && Date.parse(ts[1]) >= sinceMs) hits += 1;
    }
  }
  return hits;
}

async function typeIntoTerminal(input: Locator, text: string): Promise<void> {
  await input.click();
  await input.pressSequentially(text, { delay: 8 });
  await input.press("Enter");
}

test("settings switch persists restoreAgentSessions to disk", async () => {
  test.setTimeout(60_000);
  const { userDataDir } = await prepareWorkspace();
  const prefsPath = join(userDataDir, "spark-preferences.json");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTitle("Settings").first().click();

    const toggle = page.getByRole("switch", { name: "Resume agent sessions on relaunch" });
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await expect
      .poll(
        async () => {
          const raw = await readFile(prefsPath, "utf8").catch(() => null);
          return raw ? (JSON.parse(raw) as { restoreAgentSessions?: boolean }).restoreAgentSessions : null;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await toggle.click();
    await expect
      .poll(
        async () => {
          const raw = await readFile(prefsPath, "utf8").catch(() => null);
          return raw ? (JSON.parse(raw) as { restoreAgentSessions?: boolean }).restoreAgentSessions : null;
        },
        { timeout: 10_000 },
      )
      .toBe(false);
  } finally {
    await app?.close();
  }
});

test("claude conversation resumes after relaunch", async () => {
  test.setTimeout(420_000);
  test.skip(
    process.env.SPARK_E2E_CLAUDE_LIVE !== "1",
    "Set SPARK_E2E_CLAUDE_LIVE=1 to use the installed authenticated Claude CLI.",
  );

  const { userDataDir, workspaceDir } = await prepareWorkspace();
  const projectsDir = claudeProjectsDirFor(workspaceDir);
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ restoreAgentSessions: true }, null, 2),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    // ---- session 1: real conversation, pointer capture, quit ----
    app = await launchApp(userDataDir);
    let page = await app.firstWindow();
    await openTerminalsTab(page);

    await page.getByTitle("Add pane…").first().click();
    await page.getByRole("menuitem", { name: /Claude worker/i }).click();
    const inputs = page.locator(".xterm-helper-textarea:visible");
    await expect(inputs).toHaveCount(2, { timeout: 15_000 });
    const claudePane = inputs.last();

    // Give the TUI time to boot; a lone Enter accepts a folder-trust prompt's
    // default if one appears and is a no-op on the empty composer otherwise.
    await page.waitForTimeout(9_000);
    await claudePane.click();
    await claudePane.press("Enter");
    await page.waitForTimeout(1_500);
    const askStarted = Date.now();
    await typeIntoTerminal(claudePane, `Reply with exactly ${MARKER} and nothing else.`);

    await expect
      .poll(() => assistantHits(projectsDir, MARKER, askStarted), { timeout: 120_000 })
      .toBeGreaterThan(0);

    // The pane's resume pointer must be captured + persisted before quitting.
    await expect
      .poll(
        () =>
          page.evaluate(
            (key) => window.localStorage.getItem(key) ?? "",
            `spark.tabs:${WS_ID}`,
          ),
        { timeout: 60_000 },
      )
      .toContain('"agentSession"');
    await page.waitForTimeout(1_500);
    await app.close();
    app = null;

    // ---- session 2: relaunch → boot-resume → the CLI still knows the marker ----
    const relaunchAt = Date.now();
    app = await launchApp(userDataDir);
    page = await app.firstWindow();
    await openTerminalsTab(page);
    const restoredInputs = page.locator(".xterm-helper-textarea:visible");
    await expect(restoredInputs).toHaveCount(2, { timeout: 20_000 });

    // Let the auto-typed `claude --resume` land and the TUI finish booting.
    await page.waitForTimeout(20_000);
    const resumedPane = restoredInputs.last();
    await typeIntoTerminal(
      resumedPane,
      "Repeat the exact marker string I asked you for earlier, nothing else.",
    );
    await expect
      .poll(() => assistantHits(projectsDir, MARKER, relaunchAt), { timeout: 120_000 })
      .toBeGreaterThan(0);

  } finally {
    await app?.close();
    // The workspace cwd is a mkdtemp dir, so its transcript bucket is test
    // debris in the real ~/.claude/projects — remove it, guarded by the
    // fixture prefix so this can never touch a genuine project bucket.
    if (projectsDir.includes("codara-resume-e2e-")) {
      await rm(projectsDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});
