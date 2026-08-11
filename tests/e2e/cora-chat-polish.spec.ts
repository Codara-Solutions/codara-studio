import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("Cora messages keep a readable measure and the terminal remains healthy behind chat", async () => {
  const fixture = await prepareFixture("codara-chat-polish-");
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("domcontentloaded");

    const runId = await seedConversation(page, fixture.workspaceDir);
    const coraTab = page.getByRole("tab", { name: "Cora" }).last();
    await expect(coraTab).toBeAttached();
    await coraTab.dispatchEvent("click");
    await expect(coraTab).toHaveClass(/spark-tab--active/);
    await selectChatFromHistory(page, "Project map", runId);

    const column = page.getByTestId("cora-conversation");
    const user = page.locator('[data-message-author="user"]').last();
    const assistant = page.locator('[data-message-author="cora"]').last();
    await expect(column).toBeVisible();
    await expect(user).toContainText("Map this project for me", { timeout: 15_000 });
    // The 16 seeded messages land over IPC while the debounced runs refresh
    // catches up; give the final assistant bubble the same headroom as the
    // user bubble above instead of the 5s default.
    await expect(assistant).toContainText("I mapped the project into three layers", {
      timeout: 15_000,
    });
    await expect(assistant.locator("li")).toHaveCount(3);
    const assistantTurn = page.locator(".cora-turn").filter({ has: assistant }).last();
    const assistantCopy = assistantTurn.getByRole("button", { name: "Copy message" });
    await assistant.hover();
    await expect(assistantCopy).toBeVisible();
    const minimap = page.getByRole("navigation", { name: "Conversation map" });
    // One mark per user turn (buildConversationMinimap, ChatConversation.tsx:345),
    // so this count is seedConversation's 7 "Earlier question" turns plus the
    // final one. Keep it above the threshold in ChatConversation.tsx:391, which
    // renders nothing at all below 7 entries: trimming the seed would turn this
    // into a confusing "element not found" rather than a count mismatch.
    await expect(minimap).toBeVisible();
    await expect(minimap.getByRole("button")).toHaveCount(8);
    await minimap.getByRole("button").first().hover();
    await expect(minimap).toContainText("Earlier question 1");

    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
      };
      return {
        column: box("[data-cora-conversation-column]"),
        user: box('[data-message-author="user"]'),
        assistant: box('[data-message-author="cora"]'),
        userSurface: (() => {
          const style = getComputedStyle(document.querySelector('[data-message-author="user"]')!);
          return { background: style.backgroundColor, border: style.borderTopWidth };
        })(),
        assistantSurface: (() => {
          const style = getComputedStyle(document.querySelector('[data-message-author="cora"]')!);
          return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow };
        })(),
        viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geometry.column?.width).toBeLessThanOrEqual(769);
    expect(geometry.user?.width).toBeLessThanOrEqual(721);
    expect(geometry.assistant?.width).toBeLessThanOrEqual(769);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.userSurface.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(geometry.userSurface.border).toBe("1px");
    expect(geometry.assistantSurface.background).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.assistantSurface.border).toBe("0px");
    expect(geometry.assistantSurface.shadow).toBe("none");

    const screenshotPath = process.env.SPARK_CHAT_SCREENSHOT;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

    // The chat is one workbench tab layered over the same live terminal stack.
    // Switch away and back to prove the visual changes did not unmount or
    // collapse the terminal renderer behind it.
    await page.getByRole("tab", { name: /terminals/ }).click();
    await expect(page.locator(".xterm-host").first()).toBeVisible({ timeout: 15_000 });
    const terminalBox = await page.locator(".xterm-host").first().boundingBox();
    expect(terminalBox?.width ?? 0).toBeGreaterThan(300);
    expect(terminalBox?.height ?? 0).toBeGreaterThan(200);
    await selectCoraTab(page);
    await expect(assistant).toBeVisible();

    // Narrow workbench: the same durable conversation must remain readable
    // without document-level horizontal overflow after rails/panels collapse.
    await page.setViewportSize({ width: 820, height: 760 });
    await expect(column).toBeVisible();
    await expect(assistant).toBeVisible();
    const narrow = await page.evaluate(() => {
      const column = document.querySelector('[data-testid="cora-conversation"]')?.getBoundingClientRect();
      const assistantNodes = document.querySelectorAll('[data-message-author="cora"]');
      const assistant = assistantNodes.item(assistantNodes.length - 1)?.getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        columnRight: column?.right ?? 0,
        assistantRight: assistant?.right ?? 0,
      };
    });
    expect(narrow.overflow).toBeLessThanOrEqual(1);
    expect(narrow.columnRight).toBeLessThanOrEqual(narrow.viewport + 1);
    expect(narrow.assistantRight).toBeLessThanOrEqual(narrow.viewport + 1);
    await page.getByTitle("Toggle workspaces").click();
    await expect(page.locator('[data-responsive-panel="left"]')).toBeVisible();
    await page.getByTitle("Toggle workspaces").click();
    await expect(page.locator('[data-responsive-panel="left"]')).toHaveCount(0);
    await page.getByTitle("Toggle right sidebar").click();
    await expect(page.locator('[data-responsive-panel="right"]')).toBeVisible();
    await page.getByTitle("Toggle right sidebar").click();
    await expect(page.locator('[data-responsive-panel="right"]')).toHaveCount(0);
    if (process.env.SPARK_CHAT_NARROW_SCREENSHOT) {
      await page.screenshot({ path: process.env.SPARK_CHAT_NARROW_SCREENSHOT, fullPage: true });
    }
  } finally {
    await app?.close();
  }
});

test("completed Cora turns retain provider-ordered text and tools without duplicating the final answer", async () => {
  const fixture = await prepareFixture("codara-ordered-trace-");
  const runId = "run-ordered-trace";
  await seedPersistedExecutionRun(fixture.userDataDir, fixture.workspaceDir, runId);
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await selectCoraTab(page);
    await selectChatFromHistory(page, "Ordered execution", runId);

    // The settled chat turn keeps its streamed prose and tool rows INLINE in
    // the transcript (no disclosure to open): text and tools stay visible in
    // provider order, and the trailing streamed copy of the final answer is
    // deduped against the durable message below.
    const worked = page.getByText(/Worked for 4\s*s/);
    await expect(worked).toBeVisible({ timeout: 15_000 });
    const manager = page.locator('.cora-settled-turn[data-manager-call-id="spark-ordered"]');
    await expect(manager).toBeVisible();
    await expect(manager).toContainText("I’ll inspect the package metadata first.");
    await expect(manager).toContainText("The entry point is clear; now I’ll inspect the runtime.");
    await expect(manager.getByText("The durable final answer.")).toHaveCount(0);
    await expect(page.locator('[data-message-author="cora"]').last()).toContainText(
      "The durable final answer.",
    );
    expect(await manager.locator("[data-execution-kind]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-execution-kind")),
    )).toEqual(["text", "tool", "text", "tool"]);
  } finally {
    await app?.close();
  }
});

test("plain conversational Cora turns omit empty technical disclosures", async () => {
  const fixture = await prepareFixture("codara-conversation-only-");
  const runId = "run-conversation-only";
  await seedPersistedConversationOnlyRun(fixture.userDataDir, fixture.workspaceDir, runId);
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await selectCoraTab(page);
    await selectChatFromHistory(page, "Conversation only", runId);

    await expect(page.locator('[data-message-author="cora"]')).toContainText("Hello! How can I help?");
    await expect(page.getByText(/Worked for 3\.6\s*s/)).toHaveCount(0);
    await expect(page.getByText("Technical details", { exact: false })).toHaveCount(0);
    await expect(page.locator('[data-manager-call-id="spark-conversation-only"]')).toHaveCount(0);
  } finally {
    await app?.close();
  }
});

test("message roles stay explicit, explicit rewind works, and Stop preserves chat", async () => {
  const fixture = await prepareFixture("codara-rewind-roles-");
  const seededRunId = "run-rewind-seeded";
  const manualRunId = "run-rewind-manual";
  const oldSessionUuid = "00000000-0000-4000-8000-000000000077";
  await seedPersistedRewindRun(
    fixture.userDataDir,
    fixture.workspaceDir,
    seededRunId,
    oldSessionUuid,
  );
  await seedPersistedRewindRun(
    fixture.userDataDir,
    fixture.workspaceDir,
    manualRunId,
    oldSessionUuid,
    true,
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const rewind = await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.stopAndUndoPending(runId);
    }, seededRunId);
    expect(rewind.restoredText).toBe("Immediate steering to recover");
    expect(rewind.run.conversationEpoch).toBe(1);
    expect(rewind.run.chatSessionUuid).toBeUndefined();
    expect(rewind.run.chatSessionMode).toBeUndefined();
    expect(rewind.run.humanMessages.map((message: any) => message.id)).toEqual(["msg-retained"]);
    const persistedRewind = await readRun(fixture.userDataDir, seededRunId) as any;
    expect(persistedRewind.conversationEpoch).toBe(1);
    expect(persistedRewind.chatSessionUuid).toBeUndefined();
    expect(persistedRewind.checkpoints.some((entry: any) => entry.messageId === "msg-pending")).toBe(false);

    const manualRewind = await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.undoToCheckpoint({
        runId,
        checkpointId: "checkpoint-message",
        scope: "chat",
      });
    }, manualRunId);
    expect(manualRewind.restoredText).toBe("Immediate steering to recover");
    expect(manualRewind.run.conversationEpoch).toBe(1);
    expect(manualRewind.run.chatSessionUuid).toBeUndefined();
    expect(manualRewind.run.humanMessages.map((message: any) => message.id)).toEqual(["msg-retained"]);

    const roleRunId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({
        workspaceId: "ws-e2e",
        workspaceName: "workspace",
        cwd,
        title: "Message roles",
      });
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: "user",
        kind: "note",
        message: "Normal user turn",
      });
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: "spark",
        kind: "note",
        message: "Cora answer",
      });
      await spark.orchestration.updateRunStatus({ runId: run.id, status: "planning" });
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: "user",
        kind: "note",
        message: "Steering queued while Cora works",
      });
      return run.id as string;
    }, fixture.workspaceDir);

    await selectCoraTab(page);
    await selectChatFromHistory(page, "Message roles", roleRunId);
    await expect
      .poll(async () => page.locator('[data-message-intent="steer"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(roleRunId).toBeTruthy();
    const normal = page.locator('[data-message-intent="turn"]').last();
    const steering = page.locator('[data-message-intent="steer"]').last();
    await expect(normal).toContainText("Normal user turn");
    await expect(steering).toContainText("Queued");
    await expect(steering).toContainText("Steering queued while Cora works");
    await expect(page.locator('[data-message-author="cora"]').last()).toContainText("Cora answer");
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop run" });
    await expect(stop).toBeVisible();
    await stop.click();

    // Stop is an execution control, not a hidden rewind. All submitted and
    // queued chat turns remain visible and durable; only the run state pauses.
    await expect(normal).toContainText("Normal user turn");
    await expect(steering).toContainText("Steering queued while Cora works");
    await expect(page.locator('[data-message-author="cora"]').last()).toContainText("Cora answer");
    await expect
      .poll(() =>
        page.evaluate(async (runId) => {
          const spark = (window as unknown as { spark: any }).spark;
          return (await spark.orchestration.getRun(runId)).status;
        }, roleRunId),
      )
      .toBe("paused");
    const stopped = await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.getRun(runId);
    }, roleRunId);
    expect(stopped.status).toBe("paused");
    expect(stopped.humanMessages.map((message: any) => message.message)).toEqual([
      "Normal user turn",
      "Cora answer",
      "Steering queued while Cora works",
    ]);
  } finally {
    await app?.close();
  }
});

test("a rejected Codex launch fails once, stays failed, and never adopts a foreign rollout", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture("codara-codex-failure-");
  const fakeHome = join(fixture.root, "home");
  const fakeBin = join(fixture.root, "bin");
  const argsCapture = join(fixture.root, "codex-args.log");
  const codexHome = await seedConnectedCodexHome(fakeHome);
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, "codex"),
    [
      "#!/bin/sh",
      'line="CALL"',
      'for arg in "$@"; do line="$line|$arg"; done',
      `printf "%s\\n" "$line" >> "${argsCapture}"`,
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: fakeHome,
        SHELL: "/bin/false",
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        // Same value HOME would produce, pinned so an inherited CODEX_HOME
        // (a retired feature exported one from the user's shell profile) can
        // never point the account gate at the developer's real credentials.
        CODEX_HOME: codexHome,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.startAutopilot({
        workspaceId: "ws-e2e",
        workspaceName: "workspace",
        cwd,
        initialUserNote: "Reply with a short project map.",
        chatBackend: "codex",
        chatModel: "gpt-5.6-sol",
        chatMode: "auto",
        chatEffort: "medium",
      });
      return run.id as string;
    }, fixture.workspaceDir);

    await expect
      .poll(async () => (await readRun(fixture.userDataDir, runId)).status, { timeout: 15_000 })
      .toBe("failed");
    const failed = await readRun(fixture.userDataDir, runId);
    expect(failed.autopilot?.status).toBe("failed");
    expect(failed.sparkCalls).toHaveLength(1);
    expect(failed.sparkCalls[0].status).toBe("failed");

    // Create a plausible same-workspace rollout after the failed child exits.
    // The old background discovery loop attached to this and replayed it.
    const marker = "FOREIGN_TRANSCRIPT_MUST_NOT_APPEAR";
    const now = new Date();
    const rolloutDir = join(
      fakeHome,
      ".codex",
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(
      rolloutDir,
      "rollout-foreign-00000000-0000-4000-8000-000000000099.jsonl",
    );
    const timestamp = new Date().toISOString();
    await writeFile(
      rolloutPath,
      `${JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: { timestamp, cwd: fixture.workspaceDir, source: "cli" },
      })}\n${JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "agent_message", message: marker },
      })}\n`,
      "utf8",
    );
    const future = new Date(Date.now() + 2_000);
    await utimes(rolloutPath, future, future);
    await page.waitForTimeout(1_200);

    const events = await page.evaluate(async (id) => {
      const spark = (window as unknown as { spark: any }).spark;
      return spark.orchestration.listEvents(id);
    }, runId);
    const eventText = JSON.stringify(events);
    expect(eventText).not.toContain(marker);
    expect(eventText).not.toContain("CLI session JSONL not found");
    const stillFailed = await readRun(fixture.userDataDir, runId);
    expect(stillFailed.status).toBe("failed");
    expect(stillFailed.autopilot?.status).toBe("failed");

    const calls = (await readFile(argsCapture, "utf8")).split("\n");
    const managerCall = calls.find((call) => call.includes("app-server")) ?? "";
    expect(managerCall).toContain("app-server");
    expect(managerCall).toContain("--stdio");
    expect(managerCall).toContain("mcp_servers.codara-studio.env.SPARK_MCP_MODE=\"execute\"");
    expect(managerCall).not.toContain('mcp_servers."codara-studio"');
    expect(managerCall).not.toContain("--yolo");

    await selectCoraTab(page);
    // A failed turn is not dialogue. run-store records the failed SparkCall and
    // nothing else — this run's persisted humanMessages hold only the user's
    // note — so the chat's authoritative failure surface is that call's own
    // manager row: "Turn failed" (timeline.ts:618) plus the backend's recorded
    // reason (timeline.ts:626), rendered with the is-failed modifier at
    // ChatConversation.tsx:1753. The older "Cora couldn’t complete this turn"
    // card is NOT it: BackendFailureMessage only renders for a spark MESSAGE
    // whose text matches "<backend> backend error: …" (backendFailureDetails,
    // ChatConversation.tsx:819), a shape only legacy runs persisted — see the
    // note at ChatConversation.tsx:533.
    const failureReason = stillFailed.sparkCalls[0].error ?? "";
    expect(failureReason).toContain("Codex app server exited");
    const failedTurn = page.locator(
      `.cora-settled-turn.is-failed[data-manager-call-id="${stillFailed.sparkCalls[0].id}"]`,
    );
    await expect(failedTurn).toBeVisible({ timeout: 15_000 });
    await expect(failedTurn).toContainText("Turn failed");
    // The reason the run-store persisted is the reason the reader is shown.
    await expect(failedTurn).toContainText(failureReason);
    if (process.env.SPARK_CHAT_FAILURE_SCREENSHOT) {
      await page.screenshot({ path: process.env.SPARK_CHAT_FAILURE_SCREENSHOT, fullPage: true });
    }
  } finally {
    await app?.close();
  }
});

test("Claude manager uses stream-json and preserves streamed text/tool order", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture("codara-claude-stream-");
  const fakeHome = join(fixture.root, "home");
  const fakeBin = join(fixture.root, "bin");
  const argsCapture = join(fixture.root, "claude-args.json");
  await mkdir(join(fakeHome, ".claude"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const events = [
    { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" },
    { type: "stream_event", session_id: "11111111-1111-4111-8111-111111111111", event: { type: "message_start", message: { id: "provider-progress-1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "metadata." } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-read", name: "Read", input: {} } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"package.json\"}" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-read", content: "package metadata" }] } },
    { type: "stream_event", event: { type: "message_start", message: { id: "provider-progress-2" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I found the entry point." } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_start", message: { id: "provider-final" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is the final streamed answer." } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "result", subtype: "success", session_id: "11111111-1111-4111-8111-111111111111", result: "Here is the final streamed answer.", usage: { input_tokens: 12, output_tokens: 9, cache_read_input_tokens: 4 } },
  ];
  await writeFile(join(fakeBin, "claude"), [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const argv = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(argsCapture)}, JSON.stringify(argv) + "\\n");`,
    // A native-CLI manager only launches once the selected account resolves as
    // connected (claude-cli-account-profiles.ts:1179), and connectivity is
    // probed by running `claude auth status --json` on PATH
    // (defaultClaudeCliAuthChecker, claude-cli-account-profiles.ts:742).
    // parseLoggedInOnly (claude-cli-account-profiles.ts:721) JSON.parses the
    // WHOLE bounded stdout and keeps one boolean, so this branch must print
    // that object alone — the stream-json events below would parse as nothing
    // and read as "not connected". Falling off the end (rather than
    // process.exit) lets the pipe flush.
    'if (argv[0] === "auth" && argv[1] === "status") {',
    '  process.stdout.write(JSON.stringify({ loggedIn: true }));',
    "  return;",
    "}",
    `const events = ${JSON.stringify(events)};`,
    "(async () => { for (const event of events) { process.stdout.write(JSON.stringify(event) + '\\n'); await new Promise((resolve) => setTimeout(resolve, 12)); } })();",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o755 });

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: fakeHome,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        // This fixture validates the legacy stream-json parser with a fake
        // executable. Production defaults to the Claude Agent SDK.
        SPARK_CLAUDE_TRANSPORT: "print",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.startAutopilot({
        workspaceId: "ws-e2e", workspaceName: "workspace", cwd,
        initialUserNote: "Map the fixture.", chatBackend: "claude",
        chatModel: "claude-opus-4-8", chatMode: "auto", chatEffort: "medium",
      });
      return run.id as string;
    }, fixture.workspaceDir);
    await expect.poll(async () => (await readRun(fixture.userDataDir, runId)).status, { timeout: 20_000 }).toBe("complete");
    const args = (await readFile(argsCapture, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as string[])
      .find((entry) => entry.includes("-p")) ?? [];
    expect(args).toContain("-p");
    expect(args).toContain("stream-json");
    expect(args).toContain("--include-partial-messages");
    const mcpConfigFlag = args.indexOf("--mcp-config");
    expect(mcpConfigFlag).toBeGreaterThanOrEqual(0);
    const mcpConfig = JSON.parse(await readFile(args[mcpConfigFlag + 1], "utf8"));
    expect(mcpConfig.mcpServers["codara-studio"].env.SPARK_RUN_ID).toBe(runId);
    expect(mcpConfig.mcpServers["codara-studio"].timeout).toBe(20 * 60_000);

    await selectCoraTab(page);
    await selectChatFromHistory(page, "Map the fixture.", runId);
    const sparkCallId = (await readRun(fixture.userDataDir, runId) as any).sparkCalls[0].id;
    // Settled chat turns keep their streamed prose and tool rows inline.
    const manager = page.locator(`.cora-settled-turn[data-manager-call-id="${sparkCallId}"]`);
    await expect(manager).toBeVisible({ timeout: 15_000 });
    await expect(manager).toContainText("Reading metadata.");
    await expect(manager).toContainText("I found the entry point.");
    await expect(page.locator('[data-message-author="cora"]').last()).toContainText(
      "Here is the final streamed answer.",
    );
    await expect.poll(() => manager.locator("[data-execution-kind]").evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute("data-execution-kind")),
    )).toEqual(["text", "tool", "text"]);
  } finally {
    await app?.close();
  }
});

test("Codex manager uses app-server deltas and preserves streamed text/tool order", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture("codara-codex-app-server-");
  const fakeHome = join(fixture.root, "home");
  const fakeBin = join(fixture.root, "bin");
  const argsCapture = join(fixture.root, "codex-args.json");
  const codexHome = await seedConnectedCodexHome(fakeHome);
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, "codex"), [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    `fs.appendFileSync(${JSON.stringify(argsCapture)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    'const rl = readline.createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });',
    '  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "22222222-2222-4222-8222-222222222222" }, model: "gpt-5.6-sol", modelProvider: "openai", cwd: process.cwd() } });',
    '  if (message.method !== "turn/start") return;',
    '  send({ id: message.id, result: { turn: { id: "turn-fixture", items: [], status: "inProgress", error: null } } });',
    '  setTimeout(() => send({ method: "item/started", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", item: { type: "agentMessage", id: "message-1", text: "", phase: "commentary" } } }), 10);',
    '  setTimeout(() => send({ method: "item/agentMessage/delta", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", itemId: "message-1", delta: "Reading metadata." } }), 15);',
    '  setTimeout(() => send({ method: "item/started", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", item: { type: "commandExecution", id: "tool-shell", command: "pwd", cwd: process.cwd(), status: "inProgress", aggregatedOutput: null, exitCode: null } } }), 30);',
    '  setTimeout(() => send({ method: "item/completed", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", item: { type: "commandExecution", id: "tool-shell", command: "pwd", cwd: process.cwd(), status: "completed", aggregatedOutput: process.cwd(), exitCode: 0 } } }), 45);',
    '  setTimeout(() => send({ method: "item/started", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", item: { type: "agentMessage", id: "message-2", text: "", phase: "final_answer" } } }), 55);',
    '  setTimeout(() => send({ method: "item/agentMessage/delta", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", itemId: "message-2", delta: "Here is the final Codex answer." } }), 60);',
    '  setTimeout(() => send({ method: "thread/tokenUsage/updated", params: { threadId: "22222222-2222-4222-8222-222222222222", turnId: "turn-fixture", tokenUsage: { total: { inputTokens: 10, outputTokens: 8, cachedInputTokens: 3 }, last: { inputTokens: 10, outputTokens: 8, cachedInputTokens: 3 }, modelContextWindow: 200000 } } }), 70);',
    '  setTimeout(() => send({ method: "turn/completed", params: { threadId: "22222222-2222-4222-8222-222222222222", turn: { id: "turn-fixture", items: [], status: "completed", error: null } } }), 80);',
    '});',
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o755 });

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: fakeHome,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        // Same value HOME would produce, pinned so an inherited CODEX_HOME
        // (a retired feature exported one from the user's shell profile) can
        // never point the account gate at the developer's real credentials.
        CODEX_HOME: codexHome,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.startAutopilot({
        workspaceId: "ws-e2e", workspaceName: "workspace", cwd,
        initialUserNote: "Map the fixture.", chatBackend: "codex",
        chatModel: "gpt-5.6-sol", chatMode: "auto", chatEffort: "medium",
      });
      return run.id as string;
    }, fixture.workspaceDir);
    await expect.poll(async () => (await readRun(fixture.userDataDir, runId)).status, { timeout: 20_000 }).toBe("complete");
    const args = (await readFile(argsCapture, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as string[])
      .find((entry) => entry[0] === "app-server") ?? [];
    expect(args.slice(0, 2)).toEqual(["app-server", "--stdio"]);

    await selectCoraTab(page);
    await selectChatFromHistory(page, "Map the fixture.", runId);
    const sparkCallId = (await readRun(fixture.userDataDir, runId) as any).sparkCalls[0].id;
    // Settled chat turns keep their streamed prose and tool rows inline.
    const manager = page.locator(`.cora-settled-turn[data-manager-call-id="${sparkCallId}"]`);
    await expect(manager).toBeVisible({ timeout: 15_000 });
    await expect(manager).toContainText("Reading metadata.");
    expect(await manager.locator("[data-execution-kind]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-execution-kind")))).toEqual(["text", "tool"]);
    await expect(page.locator('[data-message-author="cora"]').last()).toContainText("Here is the final Codex answer.");
  } finally {
    await app?.close();
  }
});

async function prepareFixture(prefix: string): Promise<{
  root: string;
  userDataDir: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Project\n\nA compact fixture.\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { root, userDataDir, workspaceDir };
}

/**
 * A native-Codex manager only launches once the selected account resolves as
 * connected (codex-cli-account-profiles.ts:964). For the personal profile —
 * the one every fixture here uses, since the fake ~/.Codara holds no managed
 * accounts — connectivity is pure filesystem state: defaultCodexCliAuthChecker
 * (codex-cli-account-profiles.ts:539) wants $CODEX_HOME to be a real directory
 * (not a symlink) holding a regular auth.json that is not readable by group or
 * other users. A bare ~/.codex directory reads as "missing" and the launch
 * fails before any argv is captured.
 *
 * The credential shape mirrors scripts/test-native-cli-accounts.cjs so the
 * account-card identity reader finds the fields it expects; nothing in these
 * tests reads the values back.
 */
async function seedConnectedCodexHome(fakeHome: string): Promise<string> {
  const codexHome = join(fakeHome, ".codex");
  await mkdir(codexHome, { recursive: true });
  const unverifiedJwt = (claims: Record<string, unknown>) =>
    [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "not-a-real-signature",
    ].join(".");
  const authFile = join(codexHome, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: unverifiedJwt({ email: "fixture@example.test" }),
        access_token: "not-a-real-token",
        refresh_token: "not-a-real-token",
        account_id: "acct_00000000-0000-4000-8000-000000000001",
      },
      last_refresh: new Date().toISOString(),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  // writeFile's mode is masked by the process umask; chmod is what actually
  // guarantees the 0600 the checker requires.
  await chmod(authFile, 0o600);
  return codexHome;
}

async function seedConversation(page: Page, cwd: string): Promise<string> {
  return page.evaluate(async (workspaceCwd) => {
    const spark = (window as unknown as { spark: any }).spark;
    const run = await spark.orchestration.createRun({
      workspaceId: "ws-e2e",
      workspaceName: "workspace",
      cwd: workspaceCwd,
      title: "Project map",
    });
    for (let index = 1; index <= 7; index += 1) {
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: "user",
        kind: "note",
        message: `Earlier question ${index}`,
      });
      await spark.orchestration.addRunMessage({
        runId: run.id,
        author: "spark",
        kind: "note",
        message: `Earlier answer ${index}`,
      });
    }
    await spark.orchestration.addRunMessage({
      runId: run.id,
      author: "user",
      kind: "note",
      message:
        "Map this project for me. Explain its architecture, main entry points, important workflows, and the highest-leverage place to start working.",
    });
    await spark.orchestration.addRunMessage({
      runId: run.id,
      author: "spark",
      kind: "note",
      message: [
        "I mapped the project into three layers.",
        "",
        "- **Desktop shell** — Electron owns windows, IPC, and persistence.",
        "- **Orchestration** — Cora turns chat outcomes into managed worker runs.",
        "- **Workbench UI** — React presents chat, terminals, files, and run state together.",
        "",
        "Start at `src/main/orchestration/run-store.ts`; it is the junction between a Cora decision and everything the user sees next.",
      ].join("\n"),
    });
    return run.id as string;
  }, cwd);
}

async function seedPersistedRewindRun(
  userDataDir: string,
  workspaceDir: string,
  runId: string,
  sessionUuid: string,
  includeMessageCheckpoint = false,
): Promise<void> {
  const runDir = join(userDataDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify(
      {
        id: runId,
        workspaceId: "ws-e2e",
        title: "Seeded rewind",
        status: "planning",
        settingsSnapshot: { workspaceCwd: workspaceDir },
        artifactDir: runDir,
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:00:03.000Z",
        conversationEpoch: 0,
        plans: [],
        steps: [],
        workerTasks: [],
        workerAttempts: [],
        sparkCalls: [
          {
            id: "spark-active",
            runId,
            mode: "chat",
            model: "gpt-5.6-sol",
            status: "started",
            inputMessageIds: ["msg-retained"],
            conversationEpoch: 0,
            createdAt: "2026-07-13T10:00:02.000Z",
          },
        ],
        humanMessages: [
          {
            id: "msg-retained",
            runId,
            author: "user",
            kind: "note",
            intent: "turn",
            deliveryState: "acknowledged",
            backendTurnId: "spark-active",
            conversationEpoch: 0,
            message: "Retained context",
            attachments: [],
            createdAt: "2026-07-13T10:00:01.000Z",
          },
          {
            id: "msg-pending",
            runId,
            author: "user",
            kind: "note",
            intent: "steer",
            deliveryState: "queued",
            targetTurnId: "after:spark-active",
            conversationEpoch: 0,
            message: "Immediate steering to recover",
            attachments: [],
            createdAt: "2026-07-13T10:00:03.000Z",
          },
        ],
        checkpoints: [
          {
            id: "checkpoint-start",
            kind: "run-start",
            messagePointer: 0,
            sha: null,
            label: "Chat start",
            createdAt: "2026-07-13T10:00:00.500Z",
          },
          ...(includeMessageCheckpoint
            ? [{
                id: "checkpoint-message",
                kind: "user-message",
                messagePointer: 1,
                messageId: "msg-pending",
                sha: null,
                label: "Immediate steering to recover",
                createdAt: "2026-07-13T10:00:03.100Z",
              }]
            : []),
        ],
        autopilot: { status: "running", updatedAt: "2026-07-13T10:00:03.000Z" },
        chatBackend: "codex",
        chatMode: "auto",
        chatSessionUuid: sessionUuid,
        chatSessionMode: "auto",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function seedPersistedExecutionRun(
  userDataDir: string,
  workspaceDir: string,
  runId: string,
): Promise<void> {
  const runDir = join(userDataDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({
    id: runId,
    workspaceId: "ws-e2e",
    title: "Ordered execution",
    status: "complete",
    settingsSnapshot: { workspaceCwd: workspaceDir },
    artifactDir: runDir,
    createdAt: "2026-07-13T09:00:00.000Z",
    updatedAt: "2026-07-13T09:00:05.000Z",
    completedAt: "2026-07-13T09:00:05.000Z",
    conversationEpoch: 0,
    plans: [], steps: [], workerTasks: [], workerAttempts: [], checkpoints: [], assumptions: [],
    sparkCalls: [{
      id: "spark-ordered", runId, mode: "chat", model: "claude-opus-4-8",
      status: "completed", inputMessageIds: ["msg-user"], conversationEpoch: 0,
      createdAt: "2026-07-13T09:00:01.000Z", completedAt: "2026-07-13T09:00:05.000Z", durationMs: 4_000,
    }],
    humanMessages: [
      { id: "msg-user", runId, author: "user", kind: "note", intent: "turn", deliveryState: "acknowledged", backendTurnId: "spark-ordered", conversationEpoch: 0, message: "Map it", attachments: [], createdAt: "2026-07-13T09:00:00.500Z" },
      { id: "msg-answer", runId, author: "spark", kind: "note", intent: "answer", deliveryState: "acknowledged", backendTurnId: "spark-ordered", conversationEpoch: 0, message: "The durable final answer.", attachments: [], createdAt: "2026-07-13T09:00:04.900Z" },
    ],
    autopilot: { status: "complete", updatedAt: "2026-07-13T09:00:05.000Z" },
    chatBackend: "claude", chatMode: "auto",
  }, null, 2), "utf8");
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => JSON.stringify({
    id: `evt-ordered-${sequence}`, timestamp: `2026-07-13T09:00:0${sequence}.000Z`, eventVersion: 1,
    sequence, workspaceId: "ws-e2e", runId, sparkCallId: "spark-ordered", type, payload,
  });
  await writeFile(join(runDir, "events.jsonl"), [
    event(1, "chat.assistant_block", { kind: "assistant_block", messageId: "provider-1", text: "I’ll inspect the package metadata first.", conversationEpoch: 0 }),
    event(2, "chat.tool_use", { kind: "tool_use", toolUseId: "tool-1", toolName: "Read", input: { file_path: "package.json" }, conversationEpoch: 0 }),
    event(3, "chat.tool_result", { kind: "tool_result", toolUseId: "tool-1", output: "{ name: 'fixture' }", conversationEpoch: 0 }),
    event(4, "chat.assistant_block", { kind: "assistant_block", messageId: "provider-2", text: "The entry point is clear; now I’ll inspect the runtime.", conversationEpoch: 0 }),
    event(5, "chat.tool_use", { kind: "tool_use", toolUseId: "tool-2", toolName: "Glob", input: { pattern: "src/**/*.ts" }, conversationEpoch: 0 }),
    event(6, "chat.tool_result", { kind: "tool_result", toolUseId: "tool-2", output: "src/main.ts", conversationEpoch: 0 }),
    event(7, "chat.assistant_block", { kind: "assistant_block", messageId: "provider-final", text: "The durable final answer.", conversationEpoch: 0 }),
  ].join("\n") + "\n", "utf8");
}

async function seedPersistedConversationOnlyRun(
  userDataDir: string,
  workspaceDir: string,
  runId: string,
): Promise<void> {
  const runDir = join(userDataDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({
    id: runId,
    workspaceId: "ws-e2e",
    title: "Conversation only",
    status: "complete",
    settingsSnapshot: { workspaceCwd: workspaceDir },
    artifactDir: runDir,
    createdAt: "2026-07-13T09:30:00.000Z",
    updatedAt: "2026-07-13T09:30:04.000Z",
    completedAt: "2026-07-13T09:30:04.000Z",
    conversationEpoch: 0,
    plans: [], steps: [], workerTasks: [], workerAttempts: [], checkpoints: [], assumptions: [],
    sparkCalls: [{
      id: "spark-conversation-only", runId, mode: "chat", model: "gpt-5.6-sol",
      status: "completed", inputMessageIds: ["msg-hello"], conversationEpoch: 0,
      createdAt: "2026-07-13T09:30:00.200Z", completedAt: "2026-07-13T09:30:03.800Z", durationMs: 3_600,
    }],
    humanMessages: [
      { id: "msg-hello", runId, author: "user", kind: "note", intent: "turn", deliveryState: "acknowledged", backendTurnId: "spark-conversation-only", conversationEpoch: 0, message: "Hello", attachments: [], createdAt: "2026-07-13T09:30:00.100Z" },
      { id: "msg-hello-answer", runId, author: "spark", kind: "note", intent: "answer", deliveryState: "acknowledged", backendTurnId: "spark-conversation-only", conversationEpoch: 0, message: "Hello! How can I help?", attachments: [], createdAt: "2026-07-13T09:30:03.700Z" },
    ],
    autopilot: { status: "complete", updatedAt: "2026-07-13T09:30:04.000Z" },
    chatBackend: "pi", chatMode: "auto",
  }, null, 2), "utf8");
  const event = (
    sequence: number,
    type: string,
    payload: Record<string, unknown>,
  ) => JSON.stringify({
    id: `evt-conversation-${sequence}`,
    timestamp: `2026-07-13T09:30:0${sequence}.000Z`,
    eventVersion: 1,
    sequence,
    workspaceId: "ws-e2e",
    runId,
    sparkCallId: "spark-conversation-only",
    type,
    payload,
  });
  await writeFile(join(runDir, "events.jsonl"), [
    event(1, "chat.system_note", { kind: "system_note", message: "Cora Pi session ready", conversationEpoch: 0 }),
    event(2, "chat.assistant_block", { kind: "assistant_block", messageId: "provider-hello", text: "Hello! How can I help?", conversationEpoch: 0 }),
  ].join("\n") + "\n", "utf8");
}

async function selectCoraTab(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "Cora" }).last();
  await expect(tab).toBeAttached();
  await tab.dispatchEvent("click");
  await expect(tab).toHaveClass(/spark-tab--active/);
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

async function selectChatFromHistory(page: Page, title: string, runId: string): Promise<void> {
  await clickAttached(page.getByRole("button", { name: "Open chat history" }).last());
  await clickAttached(page.getByRole("option").filter({ hasText: title }));
  // RunIdChip.tsx:64 spells the tooltip "Copy run id: <id>", and it only puts
  // the full id in the tooltip when the chip had to truncate it — i.e. when the
  // id is longer than the chip's maxChars (12 by default). Every run id these
  // fixtures use ("run-<base36>-<base36>", or a "run-<name>" literal well past
  // 12 characters) clears that threshold; a shorter id would render the plain
  // "Copy run id" title and never match here.
  await expect(page.getByTitle(`Copy run id: ${runId}`)).toBeVisible({ timeout: 15_000 });
}

async function readRun(
  userDataDir: string,
  runId: string,
): Promise<{
  status: string;
  autopilot?: { status: string };
  sparkCalls: Array<{ id: string; status: string; error?: string }>;
}> {
  // Run folders are keyed by run id, but keep a defensive directory scan for
  // older fixtures that may prefix/sanitize their folder names.
  const direct = join(userDataDir, "runs", runId, "run.json");
  try {
    return JSON.parse(await readFile(direct, "utf8"));
  } catch {
    const entries = await readdir(join(userDataDir, "runs"));
    for (const entry of entries) {
      const parsed = JSON.parse(await readFile(join(userDataDir, "runs", entry, "run.json"), "utf8"));
      if (parsed.id === runId) return parsed;
    }
    throw new Error(`Run ${runId} not found`);
  }
}
