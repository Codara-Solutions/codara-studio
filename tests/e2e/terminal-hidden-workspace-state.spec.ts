import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Regression for workspace-aware terminal chips. A fake Codex process starts
// in a working state, then settles to its idle composer after the user
// switches projects. The main-process terminal notifier still sees the hidden
// PTY and must update that hidden workspace's retained leaf. Before the fix,
// App routed the event only through the active workspace's tabs and the chip
// stayed stuck on WORKING forever.

test("hidden workspace terminal chip keeps receiving agent state", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.codarastudio state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const workspaceA = page.locator('[data-workspace-id="ws-a"]');
    const workspaceB = page.locator('[data-workspace-id="ws-b"]');
    await expect(workspaceA).toBeVisible();

    // The default layout includes a retained terminal tab. Launch the fake
    // Codex process through the real xterm/PTY path so the renderer mints a
    // manual worker chip and the main notifier registers the pane naturally.
    // Electron's compact CI window intermittently reports this visible tab as
    // having an unstable/zero action box. Dispatch the same DOM click without
    // making terminal retention depend on Playwright's viewport heuristics.
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => {
      (tab as HTMLElement).click();
    });
    const terminalInput = page.locator(".xterm-helper-textarea:visible").first();
    // Focus directly: on compact Electron test windows the pane's drag handle
    // can overlap the textarea's zero-width accessibility host even though the
    // terminal itself is fully visible and interactive.
    await terminalInput.focus();
    await terminalInput.pressSequentially(fixture.fakeCodex, { delay: 2 });
    await terminalInput.press("Enter");
    await expect(page.getByRole("status", { name: "CODEX working" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(workspaceA).toHaveAttribute("aria-busy", "true");

    const visiblePane = page.locator("[data-terminal-pane-id]:visible").first();
    const paneId = await visiblePane.getAttribute("data-terminal-pane-id");
    expect(paneId).toBeTruthy();
    const terminalNode = visiblePane.locator(".xterm").first();
    await expect(terminalNode).toBeAttached();
    await terminalNode.evaluate((node) => {
      (
        window as unknown as {
          __codaraKeptTerminalNode?: Element;
        }
      ).__codaraKeptTerminalNode = node;
    });

    // Leave while Codex is working. Its script prints an idle composer after
    // three seconds, when this workspace's TerminalStack is mounted but hidden.
    // The xterm DOM node itself must remain the exact same object: keeping only
    // the PTY alive and recreating xterm on return is the unload regression.
    await workspaceB.evaluate((row) => {
      (row as HTMLElement).click();
    });
    const hiddenTerminalNode = page.locator(
      `[data-terminal-pane-id="${paneId}"] .xterm`,
    );
    await expect(hiddenTerminalNode).toBeAttached();
    expect(
      await hiddenTerminalNode.evaluate(
        (node) =>
          (
            window as unknown as {
              __codaraKeptTerminalNode?: Element;
            }
          ).__codaraKeptTerminalNode === node,
      ),
    ).toBe(true);
    const hiddenChip = page.locator(
      `[data-terminal-pane-id="${paneId}"] [role="status"]`,
    );
    await expect(hiddenChip).toHaveAttribute("aria-label", "CODEX ready", {
      timeout: 15_000,
    });
    await expect(workspaceA).toHaveAttribute("aria-busy", "false");

    // Returning to the project must reveal the current state, not the stale
    // pre-switch WORKING chip, and must still reveal the original xterm rather
    // than a snapshot-backed replacement.
    await workspaceA.evaluate((row) => {
      (row as HTMLElement).click();
    });
    await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible();
    expect(
      await page
        .locator(`[data-terminal-pane-id="${paneId}"]:visible .xterm`)
        .evaluate(
          (node) =>
            (
              window as unknown as {
                __codaraKeptTerminalNode?: Element;
              }
            ).__codaraKeptTerminalNode === node,
        ),
    ).toBe(true);
  } finally {
    await app?.close();
  }
});

test("Codex stays ready during draft editing and working through partial repaints", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  const launcher = join(fixture.binDir, "codex.js");
  await writeFile(launcher, String.raw`
    const out = (text) => process.stdout.write(text);
    const idle = () => out("\x1b[2J\x1b[HOpenAI Codex (v0.153.4)\x1b[7;1H› Explain this status\r\nWorking (9m 21s • esc to interrupt)\r\ngpt-6-astra high fast · ~/project");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    idle();
    let started = false;
    process.stdin.on("data", (data) => {
      if (started || !data.includes(13)) { if (!started) idle(); return; }
      started = true;
      out("\x1b[2J\x1b[HOpenAI Codex (v0.153.4)\x1b[5;1H• Working (9m 21s • esc to interrupt)\x1b[7;1H› Ask Codex to do anything\x1b[8;1Hgpt-6-astra high fast · ~/project");
      setTimeout(() => out("\x1b[5;6Hking\x1b[5;16H2"), 1000);
      setTimeout(idle, 22000);
    });
  `);
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially(`"${process.execPath}" "${launcher}"`, { delay: 2 });
    await input.press("Enter");
    const ready = page.getByRole("status", { name: "CODEX ready" });
    const working = page.getByRole("status", { name: "CODEX working" });
    await expect(ready).toBeVisible({ timeout: 15_000 });
    await input.pressSequentially("Working (9m 21s • esc to interrupt)", { delay: 30 });
    await page.waitForTimeout(3000);
    await expect(ready).toBeVisible();
    await input.press("Enter");
    await expect(working).toBeVisible({ timeout: 5000 });
    for (let i = 0; i < 17; i++) {
      await page.waitForTimeout(1000);
      await expect(working).toBeVisible();
    }
    await expect(ready).toBeVisible({ timeout: 15_000 });
  } finally {
    await app?.close();
  }
});

test("silent Codex is detected without a banner or saved session", async () => {
  test.skip(process.platform === "win32", "Process discovery uses the Unix process listing");
  test.setTimeout(60_000);
  const fixture = await prepareFixture();
  // A silent Codex-shaped Node launcher proves process recovery without
  // emitting any agent text or touching a real Codex account.
  const silentCodex = join(fixture.binDir, "codex.js");
  await writeFile(silentCodex, "setTimeout(() => {}, 30000);\n");
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => {
      (tab as HTMLElement).click();
    });
    const input = page.locator(".xterm-helper-textarea:visible").first();
    await input.focus();
    await input.pressSequentially(`"${process.execPath}" "${silentCodex}"`, { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: "CODEX ready" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status", { name: "CODEX working" })).toHaveCount(0);
    await input.press("Control+c");
    await expect(page.getByRole("status", { name: "CODEX ready" })).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await app?.close();
  }
});

test("cold-restored Claude is rehydrated as working even when output starts immediately", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
        CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
        // Force PATH reconstruction to use the explicit test PATH instead of
        // the developer machine's login-shell PATH (which contains real
        // Claude ahead of this fixture binary).
        ...(process.platform === "win32" ? {} : { SHELL: "/bin/false" }),
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Install the exact cold-hydration shape: the durable pointer survives,
    // while `worker` is absent. Reloading the renderer makes bootResume launch
    // the fake Claude, which prints one busy frame immediately and then stays
    // silent — there is no later repaint available to repair a missed edge.
    // Install on the NEW document, before Codara hydrates. Writing this into
    // the current document and then reloading races the outgoing page's
    // beforeunload checkpoint, which legitimately persists its current blank
    // terminal layout over the fixture.
    await page.addInitScript(
      ({ workspaceA, sessionId }) => {
        localStorage.setItem(
          "spark.tabs:ws-a",
          JSON.stringify({
            v: 6,
            tabs: [
              {
                id: "restored-terminal",
                kind: "terminal",
                title: "terminals",
                activePaneId: "restored-pane",
                root: {
                  kind: "leaf",
                  paneId: "restored-pane",
                  cwd: workspaceA,
                  agentSession: {
                    runtime: "claude",
                    sessionId,
                    cwd: workspaceA,
                    capturedAt: "2026-07-18T00:00:00.000Z",
                    active: true,
                  },
                },
              },
            ],
            activeId: "restored-terminal",
          }),
        );
      },
      { workspaceA: fixture.workspaceA, sessionId: fixture.claudeSessionId },
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const workspaceA = page.locator('[data-workspace-id="ws-a"]');
    await expect(page.getByRole("status", { name: "CLAUDE working" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(workspaceA).toHaveAttribute("aria-busy", "true");
  } finally {
    await app?.close();
  }
});

async function prepareFixture(): Promise<{
  userDataDir: string;
  binDir: string;
  fakeCodex: string;
  workspaceA: string;
  claudeConfigDir: string;
  claudeSessionId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-hidden-agent-e2e-"));
  const userDataDir = join(root, "user-data");
  const binDir = join(root, "bin");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const claudeConfigDir = join(root, "claude-config");
  const claudeSessionId = "11111111-2222-4333-8444-555555555555";
  const claudeProjectDir = join(
    claudeConfigDir,
    "projects",
    workspaceA.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
    mkdir(claudeProjectDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspaceA, "README.md"), "# workspace-a\n", "utf8"),
    writeFile(join(workspaceB, "README.md"), "# workspace-b\n", "utf8"),
  ]);

  const fakeCodex = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const fakeClaude = join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") {
    await writeFile(
      fakeCodex,
      [
        "@echo off",
        "echo ^>_ OpenAI Codex (v0.144.1)",
        "echo * Working (0s * esc to interrupt)",
        "ping 127.0.0.1 -n 4 >nul",
        "echo ^> Write tests for @filename",
        "echo gpt-5.6-sol default · Context 100% left",
        "ping 127.0.0.1 -n 30 >nul",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      fakeClaude,
      [
        "@echo off",
        "echo Claude Code v2.1.216",
        "echo Working... (esc to interrupt)",
        "ping 127.0.0.1 -n 30 >nul",
      ].join("\r\n"),
      "utf8",
    );
  } else {
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "printf '>_ OpenAI Codex (v0.144.1)\\r\\n'",
        "printf '• Working (9m 21s • esc to interrupt)\\r\\n'",
        "sleep 3",
        "printf '\\033[1A\\r\\033[2K› Write tests for @filename\\r\\n'",
        "printf 'gpt-5.6-sol default · Context 100% left\\r\\n'",
        "sleep 30",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
    await writeFile(
      fakeClaude,
      [
        "#!/bin/sh",
        "printf 'Claude Code v2.1.216\\r\\n'",
        "printf '✻ Restoring… (4s · ↓ 12 tokens)\\r\\n'",
        "sleep 30",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeClaude, 0o755);
  }

  await writeFile(
    join(claudeProjectDir, `${claudeSessionId}.jsonl`),
    '{"type":"user","message":{"role":"user","content":"hello"}}\n',
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-preferences.json"),
    JSON.stringify({ restoreAgentSessions: true }),
    "utf8",
  );

  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          { id: "ws-a", name: "workspace-a", cwd: workspaceA, color: "#34D3C3", workers: [] },
          { id: "ws-b", name: "workspace-b", cwd: workspaceB, color: "#78A8FF", workers: [] },
        ],
        activeWorkspaceId: "ws-a",
      },
      null,
      2,
    ),
    "utf8",
  );
  return {
    userDataDir,
    binDir,
    fakeCodex,
    workspaceA,
    claudeConfigDir,
    claudeSessionId,
  };
}
