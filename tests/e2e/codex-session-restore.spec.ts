import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

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
    await expect(restoredPage.locator('[data-workspace-id="ws-restore"]').getByTestId("workspace-agent-count"))
      .toHaveText("1", { timeout: 15_000 });
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
    await expect(page.locator('[data-workspace-id="ws-restore"]').getByTestId("workspace-agent-count"))
      .toHaveText("1/2", { timeout: 20_000 });
    await app.close();
    app = null;
    const before = (await fixture.launches()).length;
    app = await electron.launch({ args: ["."], env });
    const restoredPage = await app.firstWindow();
    const row = restoredPage.locator('[data-workspace-id="ws-restore"]');
    await expect.poll(async () => (await fixture.launches()).length, { timeout: 20_000 }).toBe(before + 2);
    await expect(row.getByTestId("workspace-agent-count")).toHaveText("1/2", { timeout: 15_000 });
    await expect(row.getByTestId("workspace-agent-count")).toHaveAttribute("aria-label", "1 of 2 agents working");
    await restoredPage.locator('[data-workspace-id="ws-other"]').evaluate(element => (element as HTMLElement).click());
    await expect(row.getByTestId("workspace-agent-count")).toHaveText("1/2");
    await expect(restoredPage.locator('[data-workspace-id="ws-other"]').getByTestId("workspace-agent-count")).toHaveCount(0);
  } finally {
    await app?.close();
  }
});

for (const pointer of ["missing", "stale", "closed"] as const) {
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
      app = await electron.launch({ args: ["."], env: fixture.env });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.addInitScript(({ pointer, workspace, first, firstPath }) => {
        localStorage.setItem("spark.tabs:ws-restore", JSON.stringify({ v: 6, tabs: [{
          id: "restore-terminal", kind: "terminal", title: "terminals", activePaneId: "restore-pane",
          root: { kind: "leaf", paneId: "restore-pane", cwd: pointer === "stale" ? `${workspace}/old` : workspace,
            ...(pointer !== "missing" ? { agentSession: { runtime: "codex", sessionId: first,
              transcriptPath: firstPath, cwd: workspace, active: pointer === "closed", capturedAt: "2026-09-01T00:00:00Z" } } : {}) },
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
      }
    } finally {
      await app?.close();
    }
  });
}

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
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: workspace, source: "cli", timestamp: "2026-08-01T00:00:00Z" } }) +
      "\n" + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "fixture ".repeat(200) } }) + "\n");
  }
  const launchLog = join(root, "launches.jsonl");
  const script = join(bin, "codex.js");
  await writeFile(script, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args.includes("--version")) { console.log("codex-cli 0.153.4"); process.exit(0); }
    fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify([...args, "cwd:" + process.cwd()]) + "\\n");
    const paths = ${JSON.stringify({ [FIRST]: firstPath, [SECOND]: secondPath })};
    let current;
    const show = () => process.stdout.write("\\x1b[2J\\x1b[HOpenAI Codex (v0.153.4)\\r\\n" +
      (process.env.SPARK_TEST_CODEX_SECOND_WORKING === "1" && args[1] === ${JSON.stringify(SECOND)}
        ? "• Working (9m 21s • esc to interrupt)\\r\\n" : "") +
      "› Ask Codex to do anything\\r\\ngpt-6-astra high · ~/workspace");
    const select = (id) => { current = fs.openSync(paths[id], "a"); fs.writeSync(current, "\\n"); show(); };
    show();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => { if (data.includes(115)) select(${JSON.stringify(SECOND)}); });
    if (args[0] === "delayed") setTimeout(() => select(${JSON.stringify(FIRST)}), 18000);
    else select(args[0] === "resume" ? args[1] : ${JSON.stringify(FIRST)});
  `);
  const wrapper = join(bin, "codex");
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  await chmod(wrapper, 0o755);
  await writeFile(join(userData, "spark-preferences.json"), JSON.stringify({ restoreAgentSessions: true }));
  await writeFile(join(userData, "spark-state.json"), JSON.stringify({
    workspaces: [{ id: "ws-restore", name: "Restore", cwd: workspace, color: "#34D3C3", workers: [] }],
    activeWorkspaceId: "ws-restore",
  }));
  return {
    userData, workspace, script, firstPath, secondPath,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, SHELL: "/bin/false",
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
