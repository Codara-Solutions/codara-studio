// Focused harness for the worker-session JSONL metadata parsers.
//
//   node scripts/test-worker-sessions.cjs

// Bundles the production module so the fixtures exercise the same parsing
// functions used by the Electron IPC handler.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "worker-sessions.ts");

async function main() {
  const outfile = path.join(os.tmpdir(), "codara-worker-sessions-test.cjs");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-session-fixtures-"));
  const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(fixtureRoot, "claude-home");
  process.env.CODEX_HOME = path.join(fixtureRoot, "codex-home");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const {
    deleteWorkerSession,
    listAllWorkerSessions,
    listWorkerSessions,
    parseClaudeSessionHead,
    parseCodexSessionHead,
  } = require(outfile);

  let failures = 0;
  const check = (name, condition) => {
    if (!condition) failures += 1;
    console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  };
  const jsonl = (...records) => records.map((record) => JSON.stringify(record)).join("\n");

  const claude = parseClaudeSessionHead(jsonl(
    { type: "permission-mode" },
    {
      type: "user",
      isSidechain: false,
      message: {
        role: "user",
        content: "<system-reminder>private setup</system-reminder> Build the session picker",
      },
    },
  ));
  check("Claude finds a resumable user record", claude.hasUser === true);
  check("Claude strips setup metadata from the title", claude.title === "Build the session picker");

  const claudeCommandOnly = parseClaudeSessionHead(jsonl(
    {
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: "<local-command-caveat>Caveat: The messages below were generated</local-command-caveat>",
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          "<command-name>/usage</command-name>",
          "<command-message>usage</command-message>",
          "<command-args></command-args>",
        ].join("\n"),
      },
    },
  ));
  check("Claude ignores command-only transcripts", claudeCommandOnly.hasUser === false);

  const claudeSidechain = parseClaudeSessionHead(jsonl({
    type: "user",
    isSidechain: true,
    message: { role: "user", content: "background task" },
  }));
  check("Claude ignores sidechain-only transcripts", claudeSidechain.hasUser === false);
  check("Claude marks sidechain transcripts", claudeSidechain.isSidechain === true);

  const codex = parseCodexSessionHead(jsonl(
    {
      type: "session_meta",
      timestamp: "2026-07-17T12:00:00.000Z",
      payload: {
        cwd: "/workspace/project",
        source: "cli",
        timestamp: "2026-07-17T11:59:59.000Z",
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Fix the terminal split" },
    },
  ));
  check("Codex reads the recorded cwd", codex.cwd === "/workspace/project");
  check("Codex reads the first user message", codex.title === "Fix the terminal split");
  check("Codex reads the session timestamp", codex.startedAtMs === Date.parse("2026-07-17T11:59:59.000Z"));
  check("Codex reads the interactive CLI source", codex.source === "cli");

  const codexFallback = parseCodexSessionHead(jsonl(
    { type: "session_meta", payload: { cwd: "/workspace/project" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review this change" }],
      },
    },
  ));
  check("Codex supports response-item user records", codexFallback.title === "Review this change");

  const codexSubagent = parseCodexSessionHead(jsonl({
    type: "session_meta",
    payload: {
      cwd: "/workspace/project",
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: "parent", depth: 1 },
        },
      },
    },
  }));
  check("Codex marks native subagent rollouts", codexSubagent.isSubagent === true);

  const workspace = path.join(fixtureRoot, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const claudeId = "11111111-1111-4111-8111-111111111111";
  const claudeProject = path.join(
    process.env.CLAUDE_CONFIG_DIR,
    "projects",
    workspace.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  const claudeTranscript = path.join(claudeProject, `${claudeId}.jsonl`);
  fs.mkdirSync(claudeProject, { recursive: true });
  fs.writeFileSync(
    claudeTranscript,
    jsonl({
      type: "user",
      cwd: workspace,
      sessionId: claudeId,
      timestamp: "2026-07-17T10:00:00.000Z",
      message: { role: "user", content: "Claude fixture session" },
    }),
  );
  const automatedClaudeId = "33333333-3333-4333-8333-333333333333";
  fs.writeFileSync(
    path.join(claudeProject, `${automatedClaudeId}.jsonl`),
    jsonl({
      type: "user",
      cwd: workspace,
      sessionId: automatedClaudeId,
      timestamp: "2026-07-17T10:01:00.000Z",
      message: { role: "user", content: "Automated Claude worker" },
    }),
  );
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, "file-history", claudeId), {
    recursive: true,
  });
  fs.mkdirSync(path.join(claudeProject, "memory"), { recursive: true });
  fs.writeFileSync(path.join(claudeProject, "memory", "MEMORY.md"), "fixture memory");
  fs.writeFileSync(
    path.join(process.env.CLAUDE_CONFIG_DIR, "history.jsonl"),
    `${JSON.stringify({ sessionId: claudeId, project: workspace, display: "fixture" })}\n`,
  );

  const codexId = "22222222-2222-4222-8222-222222222222";
  const codexDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "17");
  const codexTranscript = path.join(
    codexDir,
    `rollout-2026-07-17T10-00-00-${codexId}.jsonl`,
  );
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    codexTranscript,
    jsonl(
      {
        type: "session_meta",
        timestamp: "2026-07-17T10:00:00.000Z",
        payload: {
          id: codexId,
          cwd: workspace,
          source: "cli",
          timestamp: "2026-07-17T10:00:00.000Z",
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "Codex fixture session" } },
    ),
  );
  const automatedCodexId = "44444444-4444-4444-8444-444444444444";
  fs.writeFileSync(
    path.join(codexDir, `rollout-2026-07-17T10-01-00-${automatedCodexId}.jsonl`),
    jsonl(
      {
        type: "session_meta",
        payload: {
          id: automatedCodexId,
          cwd: workspace,
          source: "exec",
          timestamp: "2026-07-17T10:01:00.000Z",
        },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Automated Codex worker" },
      },
    ),
  );
  const subagentCodexId = "55555555-5555-4555-8555-555555555555";
  fs.writeFileSync(
    path.join(codexDir, `rollout-2026-07-17T10-02-00-${subagentCodexId}.jsonl`),
    jsonl(
      {
        type: "session_meta",
        payload: {
          id: subagentCodexId,
          cwd: workspace,
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: codexId, depth: 1 },
            },
          },
          timestamp: "2026-07-17T10:02:00.000Z",
        },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Native Codex subagent" },
      },
    ),
  );
  fs.mkdirSync(path.join(process.env.CODEX_HOME, "memories"), { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "memories", "fixture.md"), "memory");
  fs.writeFileSync(
    path.join(process.env.CODEX_HOME, "history.jsonl"),
    [
      JSON.stringify({ session_id: codexId, ts: 1, text: "fixture" }),
      JSON.stringify({ session_id: automatedCodexId, ts: 2, text: "automated" }),
      JSON.stringify({ session_id: subagentCodexId, ts: 3, text: "subagent" }),
      "",
    ].join("\n"),
  );

  const allSessions = await listAllWorkerSessions();
  check("All-session scan finds Claude fixture", allSessions.some((item) => item.sessionId === claudeId));
  check("All-session scan finds Codex fixture", allSessions.some((item) => item.sessionId === codexId));
  check(
    "All-session scan hides automated Claude workers",
    allSessions.every((item) => item.sessionId !== automatedClaudeId),
  );
  check(
    "All-session scan hides automated Codex workers",
    allSessions.every((item) => item.sessionId !== automatedCodexId),
  );
  check(
    "All-session scan hides native Codex subagents",
    allSessions.every((item) => item.sessionId !== subagentCodexId),
  );
  check("All-session scan reports an existing cwd", allSessions.every((item) => item.cwdExists));

  const [claudeSessions, codexSessions] = await Promise.all([
    listWorkerSessions("claude", workspace),
    listWorkerSessions("codex", workspace),
  ]);
  check(
    "Directory picker lists only the interactive Claude session",
    claudeSessions.length === 1 && claudeSessions[0].sessionId === claudeId,
  );
  check(
    "Directory picker lists only the interactive Codex session",
    codexSessions.length === 1 && codexSessions[0].sessionId === codexId,
  );

  let rejectedOutsideStore = false;
  try {
    await deleteWorkerSession({
      runtime: "codex",
      sessionId: codexId,
      cwd: workspace,
      transcriptPath: path.join(fixtureRoot, `rollout-${codexId}.jsonl`),
      memoryScope: "none",
    });
  } catch {
    rejectedOutsideStore = true;
  }
  check("Deletion rejects a transcript outside its provider store", rejectedOutsideStore);

  let rejectedWrongWorkspace = false;
  try {
    await deleteWorkerSession({
      runtime: "codex",
      sessionId: codexId,
      cwd: path.join(fixtureRoot, "different-workspace"),
      transcriptPath: codexTranscript,
      memoryScope: "none",
    });
  } catch {
    rejectedWrongWorkspace = true;
  }
  check("Deletion rejects a mismatched recorded workspace", rejectedWrongWorkspace);

  let rejectedWrongMemoryScope = false;
  try {
    await deleteWorkerSession({
      runtime: "codex",
      sessionId: codexId,
      cwd: workspace,
      transcriptPath: codexTranscript,
      memoryScope: "claude-project",
    });
  } catch {
    rejectedWrongMemoryScope = true;
  }
  check("Deletion rejects another provider's memory scope", rejectedWrongMemoryScope);

  await deleteWorkerSession({
    runtime: "claude",
    sessionId: claudeId,
    cwd: workspace,
    transcriptPath: claudeTranscript,
    memoryScope: "claude-project",
  });
  check("Claude deletion removes transcript", !fs.existsSync(claudeTranscript));
  check("Claude deletion removes companion state", !fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, "file-history", claudeId)));
  check("Claude deletion removes selected project memory", !fs.existsSync(path.join(claudeProject, "memory")));
  check("Claude deletion filters prompt history", fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "history.jsonl"), "utf8") === "");

  await deleteWorkerSession({
    runtime: "codex",
    sessionId: codexId,
    cwd: workspace,
    transcriptPath: codexTranscript,
    memoryScope: "codex-all",
  });
  check("Codex deletion removes transcript", !fs.existsSync(codexTranscript));
  check("Codex deletion removes selected global memory", !fs.existsSync(path.join(process.env.CODEX_HOME, "memories")));
  check(
    "Codex deletion filters only the selected prompt history",
    !fs.readFileSync(path.join(process.env.CODEX_HOME, "history.jsonl"), "utf8").includes(codexId),
  );

  if (failures > 0) {
    console.error(`${failures} worker-session check(s) failed`);
    process.exit(1);
  }
  console.log("all worker-session checks passed");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
