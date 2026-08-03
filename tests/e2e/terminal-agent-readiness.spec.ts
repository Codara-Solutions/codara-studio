import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

for (const runtime of ["claude", "codex"] as const) {
  for (const launchKind of ["manual", "fresh", "resume"] as const) {
  test(`${runtime} ${launchKind} sessions become and remain ready without a first message`, async () => {
    test.setTimeout(60_000);
    const fixture = await prepareFixture();
    let app: ElectronApplication | null = null;
    try {
      const {
        ELECTRON_RUN_AS_NODE: _electronRunAsNode,
        ELECTRON_RENDERER_URL: _electronRendererUrl,
        ...electronEnv
      } = process.env;
      app = await electron.launch({
        args: ["."],
        env: {
          ...electronEnv,
          HOME: fixture.homeDir,
          PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
          SPARK_USER_DATA_DIR: fixture.userDataDir,
          CODARA_HOME_DIR: fixture.userDataDir,
          SPARK_HOME_DIR: fixture.userDataDir,
          SPARK_SKIP_LEGACY_MIGRATION: "1",
          SPARK_NO_SHELL_INTEGRATION: "1",
        },
      });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await openSession(page, runtime, launchKind);

      const label = runtime.toUpperCase();
      const ready = page.getByRole("status", { name: `${label} ready` });
      await expect(ready).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(3_500);
      await expect(ready).toBeVisible();
      await expect(page.getByRole("status", { name: `${label} starting` })).toHaveCount(0);
    } finally {
      await app?.close();
    }
  });
  }
}

async function openSession(
  page: Page,
  runtime: "claude" | "codex",
  launchKind: "manual" | "fresh" | "resume",
) {
  if (launchKind === "manual") {
    await page.getByRole("tab", { name: /terminals/i }).first().dispatchEvent("click");
    const pane = page.locator(".spark-terminal-pane:visible").first();
    await pane.locator(".xterm-host").dispatchEvent("mousedown", { button: 0 });
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.type(runtime);
    await page.keyboard.press("Enter");
    return;
  }
  await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
  const picker = page.locator(".spark-tabbar-picker");
  const workerLabel = runtime === "claude" ? "Claude worker" : "Codex worker";
  await picker.getByRole("button", { name: workerLabel }).dispatchEvent("click");
  const dialogName = runtime === "claude" ? "Claude Code sessions" : "Codex sessions";
  const dialog = page.getByRole("dialog", { name: dialogName });
  await expect(dialog).toBeVisible();
  if (launchKind === "fresh") {
    await dialog.getByRole("button", { name: "New session" }).dispatchEvent("click");
  } else {
    await dialog.getByTitle("Resume readiness fixture").dispatchEvent("click");
  }
}

async function prepareFixture(): Promise<{
  userDataDir: string;
  workspaceDir: string;
  binDir: string;
  homeDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-agent-ready-"));
  const homeDir = join(root, "home");
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const binDir = join(root, "bin");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# readiness fixture\n", "utf8");
  await writeFile(
    join(homeDir, ".zprofile"),
    `export PATH='${binDir}':$PATH\n`,
    "utf8",
  );
  await writeSessionFixtures(homeDir, workspaceDir);
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        {
          id: "ws-agent-ready",
          name: "workspace",
          cwd: workspaceDir,
          color: "#34D3C3",
          workers: [],
        },
      ],
      activeWorkspaceId: "ws-agent-ready",
    }),
    "utf8",
  );

  await writeFakeCli(
    join(binDir, "claude"),
    "\\033[?1049h╭───Claude Code v2.1.220───╮\\r\\n❯ Try a task\\r\\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\\r\\n",
  );
  await writeFakeCli(
    join(binDir, "codex"),
    ">_ OpenAI Codex (v0.146.0)\\r\\n› Write tests for @filename\\r\\ngpt-5.6-sol default · Context 100% left\\r\\n",
  );
  return { userDataDir, workspaceDir, binDir, homeDir };
}

async function writeSessionFixtures(homeDir: string, workspaceDir: string) {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const claudeHome = join(homeDir, ".claude");
  const claudeProject = join(
    claudeHome,
    "projects",
    workspaceDir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await mkdir(claudeProject, { recursive: true });
  await writeFile(
    join(claudeHome, "history.jsonl"),
    `${JSON.stringify({ sessionId, cwd: workspaceDir })}\n`,
    "utf8",
  );
  await writeFile(
    join(claudeProject, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      cwd: workspaceDir,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "readiness fixture" },
    })}\n`,
    "utf8",
  );

  const codexHome = join(homeDir, ".codex");
  const codexSessions = join(codexHome, "sessions", "2026", "08", "03");
  await mkdir(codexSessions, { recursive: true });
  await writeFile(
    join(codexHome, "history.jsonl"),
    `${JSON.stringify({ session_id: sessionId, ts: Date.now(), text: "readiness fixture" })}\n`,
    "utf8",
  );
  await writeFile(
    join(codexSessions, `rollout-2026-08-03T12-00-00-${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: {
          id: sessionId,
          cwd: workspaceDir,
          source: "cli",
          timestamp: new Date().toISOString(),
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "readiness fixture" },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeFakeCli(file: string, frame: string) {
  const paint = file.endsWith("claude")
    ? `printf '\\033[?1049h'\nsleep 0.1\nprintf '${frame.replace("\\033[?1049h", "")}'`
    : `printf '${frame}'`;
  await writeFile(
    file,
    `#!/bin/sh\n${paint}\ntrap 'exit 0' INT TERM\nwhile :; do sleep 1; done\n`,
    "utf8",
  );
  await chmod(file, 0o755);
}
