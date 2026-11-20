import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Google's Antigravity CLI in a Studio tab, end to end with a fake `agy` on
// PATH (no network, no Google sign-in, a fixture HOME). The new-tab menu
// first says agy is missing and shows its install command; once agy is
// there the row starts it in a new tab named Antigravity, in the workspace
// folder, with the Startup flags from Settings; the chip follows it working
// and then ready; and after a restart the tab comes back with
// `agy --continue`. SPARK_ANTIGRAVITY_SHOTS=<dir> keeps the screenshots.

// The fake paints agy's real signed-out greeting line, then a busy frame and
// an idle prompt, and records every start (folder and arguments).
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.AGY_FAKE_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
const out = (text) => process.stdout.write(text);
out("\\x1b[?1049h\\x1b[H\\x1b[2J\\n Welcome to the Antigravity CLI.\\r\\n\\n > \\r\\n");
setTimeout(() => out("\\r\\n  Thinking  (esc to interrupt)\\r\\n"), 1500);
setTimeout(() => out("\\x1b[H\\x1b[2J > \\r\\n ? for shortcuts\\r\\n"), 2500);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let typed = "";
process.stdin.on("data", (data) => {
  typed = (typed + data.toString()).slice(-16);
  if (data.includes(3) || data.includes(4) || typed.includes("/quit")) {
    fs.appendFileSync(process.env.AGY_FAKE_LOG, JSON.stringify({ exit: true }) + "\\n");
    out("\\x1b[?1049l");
    process.exit(0);
  }
});
`;

interface Fixture {
  root: string;
  homeDir: string;
  userDataDir: string;
  workspaceDir: string;
  binDir: string;
  logFile: string;
  shots: string;
}

test("Antigravity opens in its own tab, shows its state, and comes back after a restart", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const fixture = await prepareFixture(testInfo.outputPath("shots"));
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForLoadState("domcontentloaded");

    // agy is not installed yet: the row says so, with the install command.
    let row = await openPickerRow(page);
    await expect(row).toHaveAttribute("data-installed", "false", { timeout: 20_000 });
    await expect(row.getByText("Not installed")).toBeVisible();
    await expect(row.getByRole("note")).toContainText("curl -fsSL https://antigravity.google/cli/install.sh | bash");
    await page.screenshot({ path: join(fixture.shots, "antigravity-1-not-installed.png") });
    // A click copies the command and starts nothing.
    await row.getByRole("button", { name: /Antigravity worker/ }).click();
    await expect(row.getByText("Copied")).toBeVisible();
    expect(await readStarts(fixture)).toEqual([]);
    await page.keyboard.press("Escape");
    await page.mouse.click(640, 600);

    // Installed meanwhile: the menu keeps a miss for 30 s, but a click on
    // the row asks again and starts agy.
    await writeFile(join(fixture.binDir, "agy"), FAKE_AGY, { mode: 0o755 });
    row = await openPickerRow(page);
    await row.getByRole("button", { name: /Antigravity worker/ }).click();

    const tab = page.locator("[data-tab-id]").filter({ hasText: "Antigravity" });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => readStarts(fixture), { timeout: 30_000 }).toHaveLength(1);
    const [start] = await readStarts(fixture);
    expect(start.cwd).toBe(fixture.workspaceDir);
    expect(start.args).toEqual(["--mode=plan"]);

    const chip = page.getByRole("status", { name: /^ANTIGRAVITY / });
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(tab.locator('[data-agent-runtime="antigravity"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("status", { name: "ANTIGRAVITY ready" })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: join(fixture.shots, "antigravity-3-tab.png") });
    // Once found, the menu shows it installed.
    row = await openPickerRow(page);
    await expect(row).toHaveAttribute("data-installed", "true", { timeout: 20_000 });
    await expect(row.getByText("Not installed")).toHaveCount(0);
    await page.screenshot({ path: join(fixture.shots, "antigravity-2-menu.png") });
    await page.keyboard.press("Escape");
    await page.mouse.click(640, 600);

    // A plain shell that only prints agy's command marker runs no agy, so it
    // must not come back as an Antigravity pane after the restart.
    await page.getByRole("tab", { name: /terminals/i }).evaluate((node) => (node as HTMLElement).click());
    const shell = page.locator(".xterm-helper-textarea:visible").first();
    await shell.focus();
    await shell.pressSequentially(String.raw`printf '\033]633;E;agy\007'`, { delay: 2 });
    await shell.press("Enter");
    await page.waitForTimeout(3_000);
    await tab.evaluate((node) => (node as HTMLElement).click());

    // Quit with agy running, then open again: the tab resumes agy's latest
    // conversation in the same folder.
    await app.close();
    app = null;
    app = await launch(fixture);
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForLoadState("domcontentloaded");
    await expect.poll(() => readStarts(fixture), { timeout: 45_000 }).toHaveLength(2);
    const resumed = (await readStarts(fixture))[1];
    expect(resumed.cwd).toBe(fixture.workspaceDir);
    expect(resumed.args).toEqual(["--mode=plan", "--continue"]);
    await expect(page.getByRole("status", { name: /^ANTIGRAVITY / }).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(8_000);
    expect(await readStarts(fixture), "the shell that only printed the marker started agy").toHaveLength(2);

    // agy quit before Codara did: nothing comes back after the next restart.
    await expect(page.getByRole("status", { name: "ANTIGRAVITY ready" })).toBeVisible({ timeout: 30_000 });
    const agyInput = page.locator(".xterm-helper-textarea:visible").first();
    await agyInput.focus();
    await agyInput.pressSequentially("/quit", { delay: 5 });
    await expect.poll(() => readExits(fixture), { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(5_000);
    await app.close();
    app = null;
    app = await launch(fixture);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("[data-tab-id]").filter({ hasText: "Antigravity" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(10_000);
    expect(await readStarts(fixture), "agy came back although it had quit before Codara").toHaveLength(2);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("with resume after a restart off, agy does not come back", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture(testInfo.outputPath("shots"), false);
  await writeFile(join(fixture.binDir, "agy"), FAKE_AGY, { mode: 0o755 });
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const row = await openPickerRow(page);
    await expect(row).toHaveAttribute("data-installed", "true", { timeout: 20_000 });
    await row.getByRole("button", { name: /Antigravity worker/ }).click();
    await expect.poll(() => readStarts(fixture), { timeout: 30_000 }).toHaveLength(1);
    await expect(page.getByRole("status", { name: "ANTIGRAVITY ready" })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    await app.close();
    app = null;
    app = await launch(fixture);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(10_000);
    expect(await readStarts(fixture), "agy came back with resume after a restart off").toHaveLength(1);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    ELECTRON_RENDERER_URL: _electronRendererUrl,
    ...electronEnv
  } = process.env;
  // The machine's own agy (often in ~/.local/bin) must not be found.
  const path = [fixture.binDir, ...(process.env.PATH ?? "").split(delimiter).filter((dir) => !dir.includes(".local/bin"))]
    .join(delimiter);
  return electron.launch({
    args: ["."],
    env: {
      ...electronEnv,
      HOME: fixture.homeDir,
      CLAUDE_CONFIG_DIR: join(fixture.homeDir, ".claude"),
      CODEX_HOME: join(fixture.homeDir, ".codex"),
      GROK_HOME: join(fixture.homeDir, ".grok"),
      PATH: path,
      AGY_FAKE_LOG: fixture.logFile,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
    },
  });
}

async function openPickerRow(page: Page) {
  await page.getByRole("button", { name: "New tab", exact: true }).first().click();
  const row = page.getByTestId("antigravity-worker-row");
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

async function readLog(fixture: Fixture): Promise<Array<{ cwd?: string; args?: string[]; exit?: true }>> {
  const text = await readFile(fixture.logFile, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd?: string; args?: string[]; exit?: true });
}

async function readStarts(fixture: Fixture): Promise<Array<{ cwd: string; args: string[] }>> {
  return (await readLog(fixture)).filter((entry) => entry.args) as Array<{ cwd: string; args: string[] }>;
}

async function readExits(fixture: Fixture): Promise<number> {
  return (await readLog(fixture)).filter((entry) => entry.exit).length;
}

async function prepareFixture(defaultShots: string, restoreAgentSessions = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-antigravity-tab-"));
  const homeDir = join(root, "home");
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const binDir = join(root, "bin");
  const shots = process.env.SPARK_ANTIGRAVITY_SHOTS || defaultShots;
  await Promise.all(
    [homeDir, userDataDir, workspaceDir, binDir, shots].map((dir) => mkdir(dir, { recursive: true })),
  );
  // A login shell rebuilds PATH from the profile, so the fake stays first.
  const profile = `export PATH='${binDir}':$PATH\n`;
  await writeFile(join(homeDir, ".zprofile"), profile, "utf8");
  await writeFile(join(homeDir, ".bash_profile"), profile, "utf8");
  await writeFile(join(workspaceDir, "README.md"), "# antigravity fixture\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-antigravity", name: "workspace", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-antigravity",
    }),
    "utf8",
  );
  // Restoring agent sessions after a restart is the user's choice.
  await writeFile(join(userDataDir, "spark-preferences.json"), JSON.stringify({ restoreAgentSessions }), "utf8");
  await writeFile(
    join(userDataDir, "agent-launch-args.json"),
    JSON.stringify({ version: 1, args: { antigravity: "--mode=plan" }, claudeChrome: false }),
    "utf8",
  );
  return { root, homeDir, userDataDir, workspaceDir, binDir, logFile: join(root, "agy-starts.jsonl"), shots };
}
