import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
// Lives only in a continuation segment in another day folder, the shape a
// long Codex conversation takes on disk.
const THIRD = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";

test("a sanctioned exit does not auto-resume a running Codex conversation", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(60_000);
  const fixture = await prepare();
  const app = await electron.launch({ args: ["."], env: fixture.env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: /terminals/i }).evaluate(tab => (tab as HTMLElement).click());
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially(`"${process.execPath}" "${fixture.script}"`, { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible({ timeout: 15_000 });
    const paneId = await page.locator("[data-terminal-pane-id]:visible").first().getAttribute("data-terminal-pane-id");
    await expect.poll(async () => (await fixture.records()).find(rec => rec.paneId === paneId)?.sessionId,
      { timeout: 20_000 }).toBe(FIRST);
    const before = await fixture.launches();
    await app.evaluate(({ BrowserWindow }, id) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(`pty:exit:${id}`, { exitCode: 0, sanctioned: true });
      }
    }, paneId);
    await page.waitForTimeout(3_000);
    expect(await fixture.launches()).toEqual(before);
  } finally {
    await app.close();
  }
});

test("Codex captures a delayed transcript, follows a session switch, and resumes it after restart", async () => {
  test.skip(process.platform === "win32", "Process file tracking uses lsof on Unix.");
  test.setTimeout(90_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially(`"${process.execPath}" "${fixture.script}" delayed`, { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible({ timeout: 15_000 });
    const paneId = await page.locator("[data-terminal-pane-id]:visible").first().getAttribute("data-terminal-pane-id");
    await expect.poll(async () => (await fixture.records()).find((rec) => rec.paneId === paneId)?.sessionId,
      { timeout: 30_000 }).toBe(FIRST);
    await input.press("s");
    await expect.poll(async () => (await fixture.records()).find((rec) => rec.paneId === paneId)?.sessionId,
      { timeout: 10_000 }).toBe(SECOND);
    await app.close();
    app = null;
    expect((await fixture.records()).find((rec) => rec.paneId === paneId)?.active).toBe(true);
    app = await electron.launch({ args: ["."], env: fixture.env });
    await expect.poll(async () => (await fixture.launches()).filter((entry) => entry[0] === "resume").at(-1)?.[1],
      { timeout: 20_000 }).toBe(SECOND);
    const restoredPage = await app.firstWindow();
    await expect(restoredPage.locator('[data-workspace-id="ws-restore"]'))
      .toHaveAttribute("data-agent-count", "1", { timeout: 15_000 });
  } finally {
    await app?.close();
  }
});

test("cold app startup counts every restored agent before visiting another workspace", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(90_000);
  const fixture = await prepare();
  await writeFile(join(fixture.userData, "spark-state.json"), JSON.stringify({
    workspaces: [
      { id: "ws-restore", name: "Restore", cwd: fixture.workspace, workers: [] },
      { id: "ws-other", name: "Other", cwd: join(fixture.workspace, "old"), workers: [] },
    ], activeWorkspaceId: "ws-restore",
  }));
  await writeFile(join(fixture.userData, "agent-session-starts.json"), JSON.stringify({ version: 1,
    entries: [FIRST, SECOND].map((id, index) => ({
      paneId: `boot-pane-${index}`, runtime: "codex", sessionId: id,
      transcriptPath: index === 0 ? fixture.firstPath : fixture.secondPath,
      cwd: fixture.workspace, active: true, source: "process", timestamp: "2026-09-05T12:00:00Z",
    })),
  }));
  const env = { ...fixture.env, SPARK_TEST_CODEX_SECOND_WORKING: "1" };
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.addInitScript(({ workspace, first, second, firstPath, secondPath }) => {
      localStorage.setItem("spark.tabs:ws-restore", JSON.stringify({ v: 6,
        tabs: [first, second].map((id, index) => ({
          id: `boot-tab-${index}`, kind: "terminal", title: `Restored ${index + 1}`,
          activePaneId: `boot-pane-${index}`,
          root: { kind: "leaf", paneId: `boot-pane-${index}`, cwd: workspace,
            agentSession: { runtime: "codex", sessionId: id, cwd: workspace,
              transcriptPath: index === 0 ? firstPath : secondPath,
              active: true, capturedAt: "2026-09-05T12:00:00Z" } },
        })), activeId: "boot-tab-0",
      }));
    }, { workspace: fixture.workspace, first: FIRST, second: SECOND, firstPath: fixture.firstPath, secondPath: fixture.secondPath });
    await page.reload();
    await expect(page.locator('[data-workspace-id="ws-restore"]'))
      .toHaveAttribute("data-agent-count", "1/2", { timeout: 20_000 });
    await page.locator('[data-workspace-id="ws-other"]').evaluate(element => (element as HTMLElement).click());
    await app.close();
    app = null;
    const before = (await fixture.launches()).length;
    app = await electron.launch({ args: ["."], env });
    const restoredPage = await app.firstWindow();
    const row = restoredPage.locator('[data-workspace-id="ws-restore"]');
    await expect.poll(async () => (await fixture.launches()).length, { timeout: 20_000 }).toBe(before + 2);
    await expect(row).toHaveAttribute("data-agent-count", "1/2", { timeout: 15_000 });
    await restoredPage.locator('[data-workspace-id="ws-other"]').evaluate(element => (element as HTMLElement).click());
    await expect(row).toHaveAttribute("data-agent-count", "1/2");
    await expect(restoredPage.locator('[data-workspace-id="ws-other"]')).not.toHaveAttribute("data-agent-count");
  } finally {
    await app?.close();
  }
});

for (const pointer of ["no-path", "stale-path"] as const) {
  test(`Codex finds its conversation by id after a restart when the pointer has ${pointer === "no-path" ? "no transcript path" : "a stale transcript path"}`, async () => {
    test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
    test.setTimeout(60_000);
    const fixture = await prepare();
    let app: ElectronApplication | null = null;
    try {
      app = await electron.launch({ args: ["."], env: fixture.env });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await seedCodexPane(page, fixture.workspace, {
        sessionId: THIRD,
        ...(pointer === "stale-path" ? { transcriptPath: fixture.firstPath.replace(FIRST, THIRD) } : {}),
      });
      await page.reload();
      await expect.poll(async () => (await fixture.launches()).filter((entry) => entry[0] === "resume").at(-1)?.[1],
        { timeout: 20_000 }).toBe(THIRD);
      await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => readFile(join(fixture.userData, "logs", "main.log"), "utf8"))
        .toContain(`plan codex id=${THIRD} cwd=${fixture.workspace} probe(exists=true resumable=true repairable=-) -> resume (rollout found by id`);
    } finally {
      await app?.close();
    }
  });
}

test("a Codex session whose files are gone says so with its id instead of opening a silent shell", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(60_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await seedCodexPane(page, fixture.workspace, { sessionId: GONE });
    await page.reload();
    // The pane prints the same notice its restore log line records.
    await expect.poll(() => readFile(join(fixture.userData, "logs", "main.log"), "utf8"), { timeout: 20_000 })
      .toContain(`pane=restore-pane notice: Codex session ${GONE} was not found on this computer`);
    expect((await fixture.launches()).filter((entry) => entry[0] === "resume")).toEqual([]);
  } finally {
    await app?.close();
  }
});

test("a Codex pane asleep at quit comes back asleep and resumes by id on Resume", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(60_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await seedCodexPane(page, fixture.workspace, { sessionId: THIRD, asleep: true });
    await page.reload();
    const pane = page.locator('[data-terminal-pane-id="restore-pane"]');
    await expect(pane.getByTestId("pane-sleeping-card")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    expect(await fixture.launches()).toEqual([]);
    await pane.getByTestId("pane-resume").click();
    await expect.poll(async () => (await fixture.launches()).filter((entry) => entry[0] === "resume").at(-1)?.[1],
      { timeout: 20_000 }).toBe(THIRD);
    await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible({ timeout: 10_000 });
  } finally {
    await app?.close();
  }
});

// A restored Codex pane as a relaunch hydrates it: no SessionStart record, so
// the probe has only the pointer to go on.
async function seedCodexPane(
  page: Page,
  workspace: string,
  pointer: { sessionId: string; transcriptPath?: string; asleep?: boolean },
): Promise<void> {
  await page.addInitScript(({ workspace, pointer }) => {
    localStorage.setItem("spark.tabs:ws-restore", JSON.stringify({ v: 6, tabs: [{
      id: "restore-terminal", kind: "terminal", title: "terminals", activePaneId: "restore-pane",
      root: { kind: "leaf", paneId: "restore-pane", cwd: workspace,
        agentSession: { runtime: "codex", sessionId: pointer.sessionId, cwd: workspace,
          ...(pointer.transcriptPath ? { transcriptPath: pointer.transcriptPath } : {}),
          active: true, capturedAt: "2026-09-01T00:00:00Z" },
        ...(pointer.asleep ? { restoreAsleep: { runtime: "codex", sleptAt: Date.parse("2026-09-01T00:10:00Z") } } : {}) },
    }], activeId: "restore-terminal" }));
  }, { workspace, pointer });
}

for (const pointer of ["missing", "stale", "wrong-runtime", "closed"] as const) {
  test(pointer === "closed" ? "Codex keeps an intentionally closed conversation closed" : `Codex restores the process-bound conversation with a ${pointer} renderer pointer`, async () => {
    test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
    test.setTimeout(60_000);
    const fixture = await prepare();
    await writeFile(join(fixture.userData, "agent-session-starts.json"), JSON.stringify({ version: 1, entries: [{
      paneId: "restore-pane", runtime: "codex", sessionId: SECOND, transcriptPath: fixture.secondPath,
      cwd: fixture.workspace, active: pointer !== "closed", source: "process", timestamp: "2026-09-05T12:00:00Z",
    }] }));
    let app: ElectronApplication | null = null;
    try {
      app = await electron.launch({ args: ["."], env: {
        ...fixture.env, SPARK_TEST_CODEX_REPLY_NOTICE: pointer === "missing" ? "1" : "0",
      } });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.addInitScript(({ pointer, workspace, first, firstPath }) => {
        localStorage.setItem("spark.tabs:ws-restore", JSON.stringify({ v: 6, tabs: [{
          id: "restore-terminal", kind: "terminal", title: "terminals", activePaneId: "restore-pane",
          root: { kind: "leaf", paneId: "restore-pane", cwd: pointer === "stale" ? `${workspace}/old` : workspace,
            ...(pointer !== "missing" ? { agentSession: { runtime: pointer === "wrong-runtime" ? "claude" : "codex", sessionId: first,
              transcriptPath: firstPath, cwd: workspace, active: pointer === "closed" || pointer === "wrong-runtime", capturedAt: "2026-09-01T00:00:00Z" } } : {}) },
        }], activeId: "restore-terminal" }));
      }, { pointer, workspace: fixture.workspace, first: FIRST, firstPath: fixture.firstPath });
      await page.reload();
      if (pointer === "closed") {
        await page.waitForTimeout(5000);
        expect(await fixture.launches()).toEqual([]);
      } else {
        await expect.poll(async () => (await fixture.launches()).filter((entry) => entry[0] === "resume").at(-1)?.[1],
          { timeout: 20_000 }).toBe(SECOND);
        await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible({ timeout: 10_000 });
        expect((await fixture.launches()).filter((entry) => entry[0] === "resume").at(-1)).toContain(`cwd:${await realpath(fixture.workspace)}`);
        if (pointer === "missing") {
          await expect.poll(() => readFile(fixture.startupReplies, "utf8").catch(() => "")).toContain("R");
          await page.waitForTimeout(2000);
          expect(await readFile(join(fixture.userData, "logs", "main.log"), "utf8"))
            .not.toContain("Codex: restored previous response");
          expect(await page.evaluate(() => window.spark.notifications.list())).toEqual([]);
          await page.locator(".xterm-helper-textarea:visible").first().press("Enter");
          await expect.poll(async () => (await page.evaluate(() => window.spark.notifications.list()))
            .filter(entry => entry.kind === "terminal.agent.done").map(entry => entry.body))
            .toEqual(["Codex: new prompt completed"]);
        }
      }
    } finally {
      await app?.close();
    }
  });
}

test("restart restores hidden Claude and leaves a closed Claude conversation closed", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix CLI wrapper.");
  test.setTimeout(90_000);
  const fixture = await prepare();
  const bin = dirname(fixture.script);
  const project = join(fixture.env.CLAUDE_CONFIG_DIR, "projects", fixture.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  for (const id of [FIRST, SECOND]) {
    await writeFile(join(project, `${id}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "fixture" } }) + "\n");
  }
  const script = join(bin, "claude.js");
  await writeFile(script, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args.includes("--version")) { console.log("Claude Code 2.1.261"); process.exit(0); }
    if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
    fs.appendFileSync(${JSON.stringify(fixture.launchLog)}, JSON.stringify(["claude", ...args]) + "\\n");
    process.stdout.write("Claude Code v2.1.261\\r\\n❯ \\r\\n? for shortcuts\\r\\n");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => { if (data.includes(113)) process.exit(0); });
  `);
  await writeFile(join(bin, "claude"), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(join(fixture.userData, "spark-state.json"), JSON.stringify({
    workspaces: [{ id: "ws-restore", name: "Restore", cwd: fixture.workspace, workers: [] },
      { id: "ws-other", name: "Other", cwd: join(fixture.workspace, "old"), workers: [] }], activeWorkspaceId: "ws-restore",
  }));
  await writeFile(join(fixture.userData, "agent-session-starts.json"), JSON.stringify({ version: 1,
    entries: [FIRST, SECOND].map((sessionId, index) => ({ paneId: `claude-pane-${index}`, runtime: "claude", sessionId,
      transcriptPath: join(project, `${sessionId}.jsonl`), cwd: fixture.workspace, active: true,
      timestamp: "2026-09-05T12:00:00Z" })),
  }));
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.addInitScript(({ workspace, first, second }) => {
      localStorage.setItem("spark.tabs:ws-restore", JSON.stringify({ v: 6,
        tabs: [first, second].map((id, index) => ({ id: `claude-tab-${index}`, kind: "terminal", title: `Claude ${index}`,
          activePaneId: `claude-pane-${index}`, root: { kind: "leaf", paneId: `claude-pane-${index}`, cwd: workspace,
            agentSession: { runtime: "claude", sessionId: id, cwd: workspace, active: true, capturedAt: "2026-09-01T00:00:00Z" } } })),
        activeId: "claude-tab-1",
      }));
    }, { workspace: fixture.workspace, first: FIRST, second: SECOND });
    await page.reload();
    await expect.poll(async () => (await fixture.launches()).length, { timeout: 20_000 }).toBe(2);
    const closedPane = page.locator('[data-terminal-pane-id="claude-pane-1"]');
    await expect(closedPane.getByRole("status", { name: "CLAUDE ready" })).toBeVisible({ timeout: 15_000 });
    await closedPane.locator(".xterm-helper-textarea").press("q");
    await expect(closedPane.getByRole("status", { name: "CLAUDE ready" })).toHaveCount(0, { timeout: 10_000 });
    await page.locator('[data-workspace-id="ws-other"]').evaluate(element => (element as HTMLElement).click());
    await app.close();
    app = null;
    expect((await fixture.records()).find(rec => rec.paneId === "claude-pane-0")?.active).toBe(true);
    expect((await fixture.records()).find(rec => rec.paneId === "claude-pane-1")?.active).toBe(false);
    const before = (await fixture.launches()).length;
    app = await electron.launch({ args: ["."], env: fixture.env });
    await expect.poll(async () => (await fixture.launches()).length, { timeout: 20_000 }).toBe(before + 1);
    expect((await fixture.launches()).at(-1)).toContain(FIRST);
    await expect((await app.firstWindow()).locator('[data-workspace-id="ws-restore"]'))
      .toHaveAttribute("data-agent-count", "1", { timeout: 10_000 });
    await (await app.firstWindow()).waitForTimeout(3000);
    expect((await fixture.launches()).length).toBe(before + 1);
  } finally {
    await app?.close();
  }
});

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "codara-codex-restore-e2e-"));
  const userData = join(root, "app");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "08", "01");
  await Promise.all([userData, join(workspace, "old"), bin, sessions].map((dir) => mkdir(dir, { recursive: true })));
  const firstPath = join(sessions, `rollout-2026-08-01T00-00-00-${FIRST}.jsonl`);
  const secondPath = join(sessions, `rollout-2026-08-01T00-00-01-${SECOND}.jsonl`);
  for (const [id, path] of [[FIRST, firstPath], [SECOND, secondPath]]) {
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: workspace, source: "cli", timestamp: "2026-08-01T00:00:00Z",
      base_instructions: { text: "CLI instructions. ".repeat(2000) } } }) +
      "\n" + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "fixture ".repeat(200) } }) + "\n");
  }
  const segmentDay = join(codexHome, "sessions", "2026", "08", "02");
  await mkdir(segmentDay, { recursive: true });
  const thirdPath = join(segmentDay, `rollout-2026-08-02T09-00-00-${THIRD}_55555555-5555-4555-8555-555555555555.jsonl`);
  await writeFile(thirdPath, JSON.stringify({ type: "session_meta", payload: { id: THIRD, cwd: workspace, source: "cli",
    timestamp: "2026-08-02T09:00:00Z" } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "user_message",
    message: "fixture ".repeat(200) } }) + "\n");
  // Older than every other rollout, so discovery never binds it to a new launch.
  await utimes(thirdPath, new Date("2026-08-02T09:00:00Z"), new Date("2026-08-02T09:00:00Z"));
  const launchLog = join(root, "launches.jsonl");
  const startupReplies = join(root, "terminal-replies.txt");
  const script = join(bin, "codex.js");
  await writeFile(script, `
    const fs = require("node:fs");
    const argv = process.argv.slice(2);
    if (argv.includes("--version")) { console.log("codex-cli 0.153.4"); process.exit(0); }
    // Codara puts its config overrides first (codex -c mcp_servers...=... resume <id>),
    // which Codex accepts before a subcommand. Read the subcommand the same way.
    const args = [];
    for (let i = 0; i < argv.length; i++) {
      if (args.length === 0 && (argv[i] === "-c" || argv[i] === "--config")) i++;
      else if (args.length > 0 || !/^--config=/.test(argv[i])) args.push(argv[i]);
    }
    fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify([...args, "cwd:" + process.cwd()]) + "\\n");
    const paths = ${JSON.stringify({ [FIRST]: firstPath, [SECOND]: secondPath, [THIRD]: thirdPath })};
    let current;
    const show = () => process.stdout.write("\\x1b[2J\\x1b[HOpenAI Codex (v0.153.4)\\r\\n" +
      (process.env.SPARK_TEST_CODEX_SECOND_WORKING === "1" && args[1] === ${JSON.stringify(SECOND)}
        ? "• Working (9m 21s • esc to interrupt)\\r\\n" : "") +
      "› Ask Codex to do anything\\r\\ngpt-6-astra high · ~/workspace");
    const select = (id) => { current = fs.openSync(paths[id], "a"); fs.writeSync(current, "\\n"); show(); };
    show();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      if (process.env.SPARK_TEST_CODEX_REPLY_NOTICE === "1") {
        if (/\\x1b\\[\\d+;\\d+R/.test(data.toString())) {
          fs.appendFileSync(${JSON.stringify(startupReplies)}, data);
          process.stdout.write("\\x1b]9;Codex: restored previous response\\x07");
        } else if (data.includes(13)) {
          process.stdout.write("\\x1b]9;Codex: new prompt completed\\x07");
        }
        return;
      }
      if (data.includes(115)) select(${JSON.stringify(SECOND)});
    });
    if (args[0] === "delayed") setTimeout(() => select(${JSON.stringify(FIRST)}), 18000);
    else select(args[0] === "resume" ? args[1] : ${JSON.stringify(FIRST)});
    if (process.env.SPARK_TEST_CODEX_REPLY_NOTICE === "1") process.stdout.write("\\x1b[6n");
  `);
  const wrapper = join(bin, "codex");
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  await chmod(wrapper, 0o755);
  // Keep login-shell PATH reconstruction inside the fixture, so installed
  // CLIs and personal shell profiles cannot replace the fake executables.
  const shell = join(bin, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  await writeFile(join(userData, "spark-preferences.json"), JSON.stringify({ restoreAgentSessions: true }));
  await writeFile(join(userData, "spark-state.json"), JSON.stringify({
    workspaces: [{ id: "ws-restore", name: "Restore", cwd: workspace, color: "#34D3C3", workers: [] }],
    activeWorkspaceId: "ws-restore",
  }));
  return {
    userData, workspace, script, firstPath, secondPath, launchLog, startupReplies,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, SHELL: shell,
      CODEX_HOME: codexHome, SPARK_USER_DATA_DIR: userData, CODARA_HOME_DIR: userData, SPARK_HOME_DIR: userData,
      CLAUDE_CONFIG_DIR: join(root, "claude-home"), GROK_HOME: join(root, "grok-home"),
      SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1" },
    records: async (): Promise<Array<{ paneId: string; sessionId: string; active: boolean }>> => {
      try { return JSON.parse(await readFile(join(userData, "agent-session-starts.json"), "utf8")).entries; } catch { return []; }
    },
    launches: async (): Promise<string[][]> => {
      try { return (await readFile(launchLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); } catch { return []; }
    },
  };
}
