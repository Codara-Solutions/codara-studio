// Agent session search: the transcript parsers, the SQLite index (first
// build, incremental appends, rewrites, removals, copies, cut-short passes,
// scope filters) and the resume command a found session opens with.
//
//   node scripts/test-session-search.cjs
//
// Every transcript here is a small fixture written by this file into a temp
// folder; no real transcript is read.

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

async function load(work) {
  const outfile = path.join(work, "session-search-test.cjs");
  await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/main/session-search/session-index";',
        'export * from "./src/main/session-search/transcript-parsers";',
        'export * from "./src/main/session-search/jsonl-reader";',
        'export * from "./src/shared/session-search";',
        'export * from "./src/renderer/src/workers/session-resume";',
        'export { buildAgentResumeCommand } from "./src/renderer/src/workers/launch-commands";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  return require(outfile);
}

// ── Fixture writers ───────────────────────────────────────────────────────

const uuid = () => crypto.randomUUID();
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString();
const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function claudeUser(text, cwd, minute, extra = {}) {
  return { type: "user", cwd, timestamp: at(minute), message: { role: "user", content: text }, ...extra };
}

function claudeAssistant(text, minute, model = "claude-test") {
  return {
    type: "assistant",
    timestamp: at(minute),
    message: { role: "assistant", model, content: [{ type: "text", text }] },
  };
}

function claudeTranscript(cwd, prompts) {
  return prompts.flatMap(([user, reply], index) => [
    claudeUser(user, cwd, index * 2),
    claudeAssistant(reply, index * 2 + 1),
  ]);
}

const noPause = { checkpoint: async () => undefined };

function snapshotFiles(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.set(full, `${stat.size}:${stat.mtimeMs}:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "codara-session-search-test-"));
  try {
    const m = await load(work);
    await parserTests(m);
    await helperTests(m);
    await resumeTests(m);
    await indexTests(m, work);
    await cutShortPassTest(m, work);
    console.log(`\n${passed} session search checks passed`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function parserTests(m) {
  const run = (parser, records) => {
    const state = m.initialTranscriptState();
    const messages = [];
    for (const record of records) parser(typeof record === "string" ? record : JSON.stringify(record), state, (msg) => messages.push(msg));
    return { state, messages };
  };

  await check("Claude: prose only, titles, folder, model; tool traffic and injected context left out", () => {
    const { state, messages } = run(m.parseClaudeLine, [
      claudeUser("<command-name>/clear</command-name>", "/work/alpha", 0),
      claudeUser("Why does the zebra parser fail?", "/work/alpha", 1),
      claudeUser("Caveat: hidden", "/work/alpha", 2, { isMeta: true }),
      { type: "assistant", timestamp: at(3), message: { model: "claude-test", content: [{ type: "tool_use", name: "Bash", input: { command: "echo hiddencommandword" } }] } },
      { type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "toolsecretword output" }] } },
      claudeAssistant("The zebra parser drops the last line.", 5),
      { ...claudeAssistant("A side task", 6), isSidechain: true },
      { type: "ai-title", aiTitle: "Fix the zebra parser" },
      "not json at all",
    ]);
    assert.deepEqual(messages.map((msg) => [msg.role, msg.text]), [
      ["user", "Why does the zebra parser fail?"],
      ["assistant", "The zebra parser drops the last line."],
    ]);
    assert.equal(state.cwd, "/work/alpha");
    assert.equal(state.model, "claude-test");
    assert.equal(state.firstPrompt, "Why does the zebra parser fail?");
    assert.equal(m.sessionTitle(state), "Fix the zebra parser");
    m.parseClaudeLine(JSON.stringify({ type: "custom-title", customTitle: "My own name" }), state, () => undefined);
    assert.equal(m.sessionTitle(state), "My own name", "a /rename wins over the agent's title");
    assert.equal(messages[0].at, Date.parse(at(1)));
  });

  await check("Codex: response items only, injected blocks dropped, subagent threads rejected", () => {
    const { state, messages } = run(m.parseCodexLine, [
      { timestamp: at(0), type: "session_meta", payload: { id: "0198aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/work/beta", source: "cli", originator: "codex_cli_rs" } },
      { type: "turn_context", payload: { cwd: "/work/beta", model: "gpt-test" } },
      {
        timestamp: at(1),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions for /work/beta\nRules" },
            { type: "input_text", text: "<environment_context>cwd</environment_context>" },
            { type: "input_text", text: "Where is the quokka config?" },
          ],
        },
      },
      { timestamp: at(1), type: "event_msg", payload: { type: "user_message", message: "Where is the quokka config?" } },
      { timestamp: at(2), type: "response_item", payload: { type: "function_call_output", output: "codexoutputsecret" } },
      { timestamp: at(3), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] } },
      { timestamp: at(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The quokka config is in settings.toml." }] } },
    ]);
    assert.deepEqual(messages.map((msg) => [msg.role, msg.text]), [
      ["user", "Where is the quokka config?"],
      ["assistant", "The quokka config is in settings.toml."],
    ]);
    assert.equal(state.cwd, "/work/beta");
    assert.equal(state.model, "gpt-test");
    assert.equal(state.rejected, false);
    const sub = run(m.parseCodexLine, [{ type: "session_meta", payload: { id: "x", cwd: "/w", source: { subagent: "review" } } }]);
    assert.equal(sub.state.rejected, true);
    const exec = run(m.parseCodexLine, [{ type: "session_meta", payload: { id: "x", cwd: "/w", source: "exec" } }]);
    assert.equal(exec.state.rejected, true, "exec runs are not conversations to resume");
  });

  await check("Grok: user and assistant text, CLI-written user records skipped, summary applied", () => {
    const { state, messages } = run(m.parseGrokLine, [
      { type: "user", content: "skills list", synthetic_reason: "skills" },
      { type: "user", content: [{ type: "text", text: "Plan the ocelot migration" }], timestamp: at(1) },
      { type: "assistant", content: [{ type: "text", text: "Step one of the ocelot plan." }], model_id: "grok-test", timestamp: at(2) },
      { type: "tool", content: "grokoutputsecret" },
    ]);
    assert.deepEqual(messages.map((msg) => msg.text), ["Plan the ocelot migration", "Step one of the ocelot plan."]);
    assert.equal(state.model, "grok-test");
    m.applyGrokSummary(JSON.stringify({ info: { id: "g1", cwd: "/work/gamma" }, generated_title: "Ocelot migration", created_at: at(0) }), state);
    assert.equal(state.cwd, "/work/gamma");
    assert.equal(m.sessionTitle(state), "Ocelot migration");
  });

  await check("Pi: session, name, model and messages; tool results skipped", () => {
    const { state, messages } = run(m.parsePiLine, [
      { type: "session", id: "pi-1", cwd: "/work/delta", timestamp: at(0) },
      { type: "model_change", modelId: "pi-model" },
      { type: "message", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Count the wombats" }] } },
      { type: "message", timestamp: at(2), message: { role: "toolResult", content: [{ type: "text", text: "pioutputsecret" }] } },
      { type: "message", timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "There are three wombats." }] } },
      { type: "session_info", name: "Wombat census" },
    ]);
    assert.deepEqual(messages.map((msg) => msg.role), ["user", "assistant"]);
    assert.equal(state.cwd, "/work/delta");
    assert.equal(state.model, "pi-model");
    assert.equal(m.sessionTitle(state), "Wombat census");
  });

  await check("Cora: run.json chat messages and the run's folder", () => {
    const run = m.parseCoraRun(
      JSON.stringify({
        id: "run-abc",
        workspaceId: "ws-1",
        title: "Narwhal plan",
        chatModel: "cora-model",
        humanMessages: [
          { author: "user", message: "Draft the narwhal plan", createdAt: at(1) },
          { author: "spark", message: "Here is the narwhal plan.", createdAt: at(2) },
          { author: "system", message: "ignored" },
        ],
      }),
    );
    assert.equal(run.runId, "run-abc");
    assert.equal(run.workspaceId, "ws-1");
    assert.deepEqual(run.messages.map((msg) => msg.role), ["user", "assistant"]);
    assert.equal(m.coraRunCwd(JSON.stringify({ type: "run.started", payload: { cwd: "/work/alpha" } })), "/work/alpha");
    assert.equal(m.parseCoraRun("{"), null);
  });

  await check("Indexed text never carries control characters (the snippet markers)", () => {
    assert.equal(m.cleanIndexText("a\u0001b\u0002c\u0007d"), "a b c d");
    assert.equal(m.cleanIndexText("x".repeat(m.MAX_MESSAGE_CHARS + 50)).length, m.MAX_MESSAGE_CHARS);
  });

  await check("A transcript state survives a round trip through the index", () => {
    const state = m.initialTranscriptState();
    state.cwd = "/work/alpha";
    state.firstPrompt = "hello";
    state.startedAt = 42;
    assert.deepEqual(m.restoreTranscriptState(JSON.stringify(state)), state);
    assert.deepEqual(m.restoreTranscriptState("garbage"), m.initialTranscriptState());
  });
}

async function helperTests(m) {
  await check("Session ids: only the shapes the CLIs mint can reach a shell", () => {
    for (const ok of ["0198aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "run-abc_123", "A1"]) assert.ok(m.isSafeSessionId(ok), ok);
    for (const bad of ["", "-rf", "a b", "a;rm -rf ~", "$(id)", "a/b", "x".repeat(129), null, 7]) {
      assert.ok(!m.isSafeSessionId(bad), String(bad));
    }
  });

  await check("Queries: words quoted, last one a prefix, FTS syntax inert", () => {
    assert.equal(m.buildFtsMatch("zebra par"), '"zebra" "par"*');
    assert.equal(m.buildFtsMatch("zebra par", "any"), '"zebra" OR "par"*');
    assert.equal(m.buildFtsMatch('  "*:() NEAR  '), '"NEAR"*');
    assert.equal(m.buildFtsMatch("  ---  "), null);
  });

  await check("Snippet marks split into highlighted parts", () => {
    const parts = m.splitSnippetMarks(`…the ${m.SNIPPET_MARK_START}zebra${m.SNIPPET_MARK_END} parser`);
    assert.deepEqual(parts, [
      { text: "…the ", mark: false },
      { text: "zebra", mark: true },
      { text: " parser", mark: false },
    ]);
  });

  await check("Progress line, counts, ages and preferences", () => {
    const status = { ...m.EMPTY_SESSION_SEARCH_STATUS, phase: "indexing", filesTotal: 172, filesDone: 172, messages: 46_000 };
    assert.equal(m.sessionSearchProgressLine(status), "172 of 172 sessions · 46K messages searchable");
    assert.equal(m.compactCount(1250), "1.3K");
    assert.equal(m.relativeAge(Date.now() - 3 * 3_600_000, Date.now()), "3h ago");
    const prefs = m.normalizeSessionSearchPreferences({ enabled: false, agents: ["codex", "nope"], agentToolScope: "everything" });
    assert.equal(prefs.enabled, false);
    assert.deepEqual(prefs.agents, ["codex"]);
    assert.equal(prefs.agentToolScope, "project");
    assert.deepEqual(m.normalizeSessionSearchPreferences(undefined), m.DEFAULT_SESSION_SEARCH_PREFERENCES);
  });
}

async function resumeTests(m) {
  const id = "0198aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await check("Resume: each agent's own resume command, from the session's folder", () => {
    const expected = {
      claude: `claude --dangerously-skip-permissions --resume ${id}`,
      codex: `codex resume ${id} --yolo`,
      grok: `grok --yolo --resume ${id}`,
      pi: `pi --session ${id}`,
    };
    for (const [runtime, command] of Object.entries(expected)) {
      const launch = m.sessionResumeLaunch({ runtime, cwd: "/work/alpha", sessionId: id }, "2026-01-01T00:00:00.000Z");
      assert.equal(launch.command, command);
      assert.equal(launch.pointer.cwd, "/work/alpha");
      assert.equal(launch.pointer.sessionId, id);
      assert.equal(launch.pointer.active, false);
    }
    assert.equal(m.sessionResumeLaunch({ runtime: "claude", cwd: "/w", sessionId: "x; rm -rf ~" }, ""), null);
    assert.equal(m.sessionResumeLaunch({ runtime: "codex", cwd: "/w", sessionId: "--yolo" }, ""), null);
  });

  await check("Resume: the session's own workspace, else the deepest local one holding its folder", () => {
    const workspaces = [
      { id: "root", cwd: "/work" },
      { id: "alpha", cwd: "/work/alpha/" },
      { id: "remote", cwd: "/work/alpha/packages", remote: { hostId: "h" } },
      { id: "alpha-two", cwd: "/work/alpha-two" },
    ];
    assert.equal(m.workspaceForSessionFolder(workspaces, "/work/alpha", "linux").id, "alpha");
    assert.equal(m.workspaceForSessionFolder(workspaces, "/work/alpha/packages/ui", "linux").id, "alpha", "remote workspaces never take a local session");
    assert.equal(m.workspaceForSessionFolder(workspaces, "/work/alphabet", "linux").id, "root", "a name prefix is not a parent folder");
    assert.equal(m.workspaceForSessionFolder(workspaces, "/elsewhere", "linux"), null);
    const win = [{ id: "w", cwd: "C:\\Users\\Me\\Repo" }];
    assert.equal(m.workspaceForSessionFolder(win, "c:/users/me/repo/src", "win32").id, "w");
    assert.ok(m.hasWorkspaceFolder(win, "C:/USERS/me/Repo", "win32"));
    assert.ok(!m.hasWorkspaceFolder(win, "C:/USERS/me/Repo", "linux"));
  });
}

async function indexTests(m, work) {
  const home = path.join(work, "home");
  const claudeRoot = path.join(home, "claude", "projects");
  const claudeOld = path.join(home, "claude-old", "projects");
  const codexHome = path.join(home, "codex");
  const codexRoot = path.join(codexHome, "sessions");
  const grokRoot = path.join(home, "grok", "sessions");
  const piRoot = path.join(home, "pi", "sessions");
  const coraRoot = path.join(home, "codara", "runs");
  const roots = [
    { agent: "claude", dir: claudeRoot },
    { agent: "codex", dir: codexRoot },
    { agent: "grok", dir: grokRoot },
    { agent: "pi", dir: piRoot },
    { agent: "cora", dir: coraRoot },
  ];
  const ids = { alpha: uuid(), alphaTwo: uuid(), alphaUi: uuid(), big: uuid(), partial: uuid(), copy: uuid(), codex: uuid(), codexSub: uuid(), grok: uuid(), pi: uuid() };

  const alphaFile = path.join(claudeRoot, "-work-alpha", `${ids.alpha}.jsonl`);
  write(alphaFile, jsonl([
    ...claudeTranscript("/work/alpha", [
      ["Why does the zebra parser fail?", "The zebra parser drops the last line."],
      ["Fix it please", `Done. ${"lorem ipsum ".repeat(1500)} closingword`],
    ]),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "toolsecretword" }] } },
    { type: "ai-title", aiTitle: "Zebra hunt" },
  ]));
  write(path.join(claudeRoot, "-work-alpha-two", `${ids.alphaTwo}.jsonl`), jsonl(claudeTranscript("/work/alpha-two", [["Prefix trap zebra", "Not in alpha"]])));
  write(path.join(claudeRoot, "-work-alpha-packages-ui", `${ids.alphaUi}.jsonl`), jsonl(claudeTranscript("/work/alpha/packages/ui", [["Button zebra stripes", "Styled"]])));
  write(path.join(claudeRoot, "-work-alpha", "notes.jsonl"), jsonl(claudeTranscript("/work/alpha", [["notindexedword", "x"]])));
  write(path.join(claudeRoot, "-work-alpha", ids.alpha, "subagents", "agent-1.jsonl"), jsonl(claudeTranscript("/work/alpha", [["subagentword", "x"]])));
  const bigLine = JSON.stringify(claudeUser(`giantlineword ${"x".repeat(1_200_000)}`, "/work/epsilon", 1));
  write(path.join(claudeRoot, "-work-epsilon", `${ids.big}.jsonl`), `${bigLine}\n${jsonl(claudeTranscript("/work/epsilon", [["smallword survives", "ok"]]))}`);
  const partialFile = path.join(claudeRoot, "-work-zeta", `${ids.partial}.jsonl`);
  write(partialFile, `${jsonl(claudeTranscript("/work/zeta", [["first complete line", "ok"]]))}${JSON.stringify(claudeUser("pendingword arrives", "/work/zeta", 9))}`);
  // An older, shorter copy of one session in a second Claude home.
  const copyRecords = claudeTranscript("/work/eta", [["copyword one", "reply one"], ["copyword two", "reply two"]]);
  write(path.join(claudeOld, "-work-eta", `${ids.copy}.jsonl`), jsonl(copyRecords.slice(0, 2)));

  const codexDay = path.join(codexRoot, "2026", "01", "02");
  const codexMeta = (id, extra = {}) => ({ timestamp: at(0), type: "session_meta", payload: { id, cwd: "/work/beta", source: "cli", originator: "codex_cli_rs", ...extra } });
  const codexMsg = (role, text, minute) => ({
    timestamp: at(minute),
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  write(path.join(codexDay, `rollout-2026-01-02T10-00-00-${ids.codex}.jsonl`), jsonl([
    codexMeta(ids.codex),
    { type: "turn_context", payload: { cwd: "/work/beta", model: "gpt-test" } },
    codexMsg("user", "Where is the quokka config?", 1),
    { timestamp: at(2), type: "response_item", payload: { type: "function_call_output", output: "codexoutputsecret" } },
    codexMsg("assistant", "In settings.toml.", 3),
  ]));
  write(path.join(codexDay, `rollout-2026-01-02T11-00-00-${ids.codex}_${uuid()}.jsonl`), jsonl([codexMsg("user", "Segment two mentions capybara", 20), codexMsg("assistant", "Capybara noted", 21)]));
  write(path.join(codexDay, `rollout-2026-01-02T12-00-00-${ids.codexSub}.jsonl`), jsonl([codexMeta(ids.codexSub, { source: { subagent: "review" } }), codexMsg("user", "subagentquokka", 1)]));
  write(path.join(codexHome, "session_index.jsonl"), jsonl([{ id: ids.codex, thread_name: "Quokka settings tour" }]));

  const grokDir = path.join(grokRoot, "%2Fwork%2Fgamma", ids.grok);
  write(path.join(grokDir, "chat_history.jsonl"), jsonl([
    { type: "user", content: "Plan the ocelot migration", timestamp: at(1) },
    { type: "assistant", content: [{ type: "text", text: "Step one of the ocelot plan." }], model_id: "grok-test", timestamp: at(2) },
  ]));
  write(path.join(grokDir, "summary.json"), JSON.stringify({ info: { id: ids.grok, cwd: "/work/gamma" }, generated_title: "Ocelot migration" }));

  write(path.join(piRoot, "--work-delta--", `2026-01-01T10-00-00-000Z_${ids.pi}.jsonl`), jsonl([
    { type: "session", id: ids.pi, cwd: "/work/delta", timestamp: at(0) },
    { type: "message", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Count the wombats" }] } },
    { type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Three wombats." }] } },
  ]));

  write(path.join(coraRoot, "run-abc", "run.json"), JSON.stringify({
    id: "run-abc",
    workspaceId: "ws-alpha",
    title: "Narwhal plan",
    humanMessages: [
      { author: "user", message: "Draft the narwhal plan", createdAt: at(1) },
      { author: "spark", message: "Here is the narwhal plan.", createdAt: at(2) },
    ],
  }));
  write(path.join(coraRoot, "run-abc", "events.jsonl"), jsonl([{ type: "run.started", payload: { cwd: "/work/alpha" } }]));
  write(path.join(coraRoot, "bad;name", "run.json"), JSON.stringify({ id: "bad;name", humanMessages: [{ author: "user", message: "badrunword" }] }));

  const dbPath = path.join(work, "index", "sessions.sqlite");
  const index = await m.SessionIndex.open(dbPath, "linux");
  const allAgents = new Set(m.SESSION_SEARCH_AGENTS);
  const search = (query, extra = {}) =>
    index.search({ query, agents: m.SESSION_SEARCH_AGENTS, scopeKeys: null, limit: 50, offset: 0, now: Date.now(), snippetTokens: 10, ...extra }).hits;
  const found = (query, extra) => search(query, extra).map((hit) => hit.sessionId).sort();
  const before = snapshotFiles(home);
  const progress = [];

  let summary;
  await check("First build indexes every agent's sessions and only reads", async () => {
    summary = await index.sync([...roots, { agent: "claude", dir: claudeOld }], allAgents, noPause, (p) => progress.push(p));
    const stats = index.stats();
    assert.equal(stats.byAgent.claude.sessions, 6, "alpha, alpha-two, alpha-ui, big, partial, copy");
    assert.equal(stats.byAgent.codex.sessions, 1, "the subagent thread is left out");
    assert.equal(stats.byAgent.grok.sessions, 1);
    assert.equal(stats.byAgent.pi.sessions, 1);
    assert.equal(stats.byAgent.cora.sessions, 1, "a run folder with an unsafe name is left out");
    assert.equal(stats.built, true);
    assert.ok(stats.lastSyncAt > 0);
    assert.deepEqual(progress.at(-1), { filesTotal: summary.filesTotal, filesDone: summary.filesTotal });
    assert.equal(summary.skippedLines, 1, "the line over 1 MB is skipped");
    assert.deepEqual(snapshotFiles(home), before, "no transcript was written to");
    if (process.platform !== "win32") assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  });

  await check("Search: words, titles, highlights; tool output, long lines and stray files never indexed", () => {
    const hits = search("zebra parser");
    assert.equal(hits[0].sessionId, ids.alpha);
    const marked = m.splitSnippetMarks(hits[0].snippet).filter((part) => part.mark).map((part) => part.text.toLowerCase());
    assert.ok(marked.includes("zebra"), `snippet marks the word: ${hits[0].snippet}`);
    assert.equal(hits[0].title, "Zebra hunt");
    assert.equal(hits[0].messageCount, 4);
    assert.equal(hits[0].cwd, "/work/alpha");
    assert.equal(hits[0].model, "claude-test");
    assert.deepEqual(found("hunt"), [ids.alpha], "the title is searchable");
    assert.equal(search("hunt")[0].snippet, null, "a title-only match repeats no excerpt");
    assert.deepEqual(found("quokka tour"), [ids.codex], "Codex thread names from session_index.jsonl");
    assert.deepEqual(found("capybara"), [ids.codex], "a Codex session's later segment is part of it");
    for (const word of ["toolsecretword", "codexoutputsecret", "giantlineword", "notindexedword", "subagentword", "subagentquokka", "badrunword"]) {
      assert.deepEqual(found(word), [], word);
    }
    assert.deepEqual(found("smallword"), [ids.big]);
    assert.deepEqual(found("closingword"), [ids.alpha], "the end of a message split across rows");
    assert.deepEqual(found("wombats"), [ids.pi]);
    assert.deepEqual(found("ocelot"), [ids.grok]);
    assert.deepEqual(found("narwhal"), ["run-abc"]);
    assert.deepEqual(found("zeb"), [ids.alpha, ids.alphaTwo, ids.alphaUi].sort(), "the last word is a prefix");
    assert.deepEqual(found("zebra unicornword"), [ids.alpha, ids.alphaTwo, ids.alphaUi].sort(), "no session has every word: any word");
    const own = { [ids.alpha]: /zebra parser/i, [ids.alphaTwo]: /prefix trap/i, [ids.alphaUi]: /button zebra/i };
    for (const hit of search("zebra")) {
      const text = m.splitSnippetMarks(hit.snippet).map((part) => part.text).join("");
      assert.match(text, own[hit.sessionId], `each session shows its own excerpt: ${text}`);
    }
    assert.doesNotThrow(() => search('zebra" OR "* NEAR( :'));
  });

  await check("Search: agent filter and an empty query listing recent sessions", () => {
    assert.deepEqual(found("zebra", { agents: ["codex"] }), []);
    assert.deepEqual(found("wombats", { agents: ["pi"] }), [ids.pi]);
    const recent = search("");
    assert.equal(recent.length, 10);
    for (let i = 1; i < recent.length; i += 1) assert.ok((recent[i - 1].lastAt ?? 0) >= (recent[i].lastAt ?? 0));
    assert.ok(recent.every((hit) => hit.snippet === null));
    const page = index.search({ query: "", agents: m.SESSION_SEARCH_AGENTS, scopeKeys: null, limit: 4, offset: 0, now: Date.now(), snippetTokens: 10 });
    assert.equal(page.hits.length, 4);
    assert.equal(page.hasMore, true);
  });

  await check("Scope: a folder and the folders under it, never a sibling that shares its name", () => {
    const alpha = m.sessionCwdKey("/work/alpha/", "linux");
    assert.deepEqual(found("zebra", { scopeKeys: [alpha] }), [ids.alpha, ids.alphaUi].sort());
    assert.deepEqual(found("narwhal", { scopeKeys: [alpha] }), ["run-abc"], "a Cora chat by its run's folder");
    assert.deepEqual(found("zebra", { scopeKeys: [alpha, "/work/alpha-two"] }), [ids.alpha, ids.alphaTwo, ids.alphaUi].sort(), "a project is every worktree folder");
    assert.deepEqual(found("zebra", { scopeKeys: [] }), [], "no folder, no sessions");
    assert.equal(search("", { scopeKeys: ["/work/beta"] }).length, 1);
    assert.equal(search("", { scopeKeys: ["/"] }).length, 10, "the root folder holds every session");
  });

  await check("Copies of one session across homes count once, the fullest copy wins", async () => {
    assert.equal(search("copyword")[0].messageCount, 2);
    write(path.join(claudeRoot, "-work-eta", `${ids.copy}.jsonl`), jsonl(copyRecords));
    await index.sync([...roots, { agent: "claude", dir: claudeOld }], allAgents, noPause);
    const hits = search("copyword");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].messageCount, 4, "the shorter copy's messages are gone");
    assert.equal(index.transcript(`claude:${ids.copy}`, 50).total, 4);
    assert.equal(index.session(`claude:${ids.copy}`).transcriptPath, path.join(claudeRoot, "-work-eta", `${ids.copy}.jsonl`));
  });

  await check("No change: a second pass reads nothing", async () => {
    const again = await index.sync([...roots, { agent: "claude", dir: claudeOld }], allAgents, noPause);
    assert.equal(again.filesRead, 0);
    assert.equal(again.bytesRead, 0);
    assert.equal(again.removedFiles, 0);
  });

  await check("Append: only the new bytes are read; a line still being written waits", async () => {
    assert.deepEqual(found("pendingword"), []);
    const sizeBefore = fs.statSync(alphaFile).size;
    const appended = jsonl([claudeUser("Now the yak shaving", "/work/alpha", 30), claudeAssistant("Yak shaved.", 31)]);
    fs.appendFileSync(alphaFile, appended);
    fs.appendFileSync(partialFile, `\n${jsonl([claudeAssistant("pending answered", 10)])}`);
    const pass = await index.sync(roots, allAgents, noPause);
    assert.equal(pass.filesRead, 2);
    // The whole partial file is far smaller than the Zebra transcript.
    assert.ok(pass.bytesRead < fs.statSync(partialFile).size + appended.length, `read ${pass.bytesRead} bytes, not whole files`);
    assert.ok(sizeBefore > 2 * appended.length);
    assert.deepEqual(found("yak"), [ids.alpha]);
    assert.ok(found("zebra parser").includes(ids.alpha), "what was there stays searchable");
    assert.equal(search("yak")[0].messageCount, 6);
    assert.deepEqual(found("pendingword"), [ids.partial]);
    assert.equal(search("pendingword")[0].messageCount, 4);
  });

  await check("Rewrite: a transcript replaced in place is read again from the start", async () => {
    const twoFile = path.join(claudeRoot, "-work-alpha-two", `${ids.alphaTwo}.jsonl`);
    // Smaller than before: a rewrite, not an append.
    write(twoFile, jsonl(claudeTranscript("/work/alpha-two", [["heron", "ok"]])));
    await index.sync(roots, allAgents, noPause);
    assert.deepEqual(found("prefix trap"), []);
    assert.deepEqual(found("heron"), [ids.alphaTwo]);
    assert.equal(search("heron")[0].messageCount, 2);
  });

  await check("Gone: a deleted transcript leaves; an unreadable folder keeps its sessions", async () => {
    fs.rmSync(path.join(claudeRoot, "-work-alpha-two"), { recursive: true });
    let pass = await index.sync(roots, allAgents, noPause);
    assert.ok(pass.removedFiles >= 1);
    assert.deepEqual(found("heron"), []);
    const moved = `${codexRoot}-away`;
    fs.renameSync(codexRoot, moved);
    pass = await index.sync(roots, allAgents, noPause);
    assert.deepEqual(found("quokka"), [ids.codex], "a missing folder is not an empty one");
    fs.renameSync(moved, codexRoot);
  });

  await check("Agents left out are taken out of the index, and come back", async () => {
    await index.sync(roots, new Set(m.SESSION_SEARCH_AGENTS.filter((agent) => agent !== "grok")), noPause);
    assert.deepEqual(found("ocelot"), []);
    assert.equal(index.stats().byAgent.grok, undefined);
    await index.sync(roots, allAgents, noPause);
    assert.deepEqual(found("ocelot"), [ids.grok]);
  });

  await check("Transcript view: oldest first, split messages joined, capped", () => {
    const transcript = index.transcript(`claude:${ids.alpha}`, 50);
    assert.equal(transcript.total, 6);
    assert.equal(transcript.messages.length, 6);
    assert.equal(transcript.messages[0].text, "Why does the zebra parser fail?");
    assert.ok(transcript.messages[3].text.startsWith("Done."));
    assert.ok(transcript.messages[3].text.endsWith("closingword"));
    assert.equal(transcript.title, "Zebra hunt");
    assert.equal(index.transcript(`claude:${ids.alpha}`, 2).messages.length, 2);
    assert.equal(index.transcript("claude:nope", 5), null);
    assert.equal(index.transcript("bogus", 5), null);
    const cora = search("narwhal")[0];
    assert.equal(cora.workspaceId, "ws-alpha");
    assert.equal(cora.cwd, "/work/alpha");
    assert.equal(index.session("cora:run-abc").transcriptPath, path.join(coraRoot, "run-abc", "run.json"));
  });

  await check("Reopening keeps the index; a file from another schema is replaced", async () => {
    index.close();
    const reopened = await m.SessionIndex.open(dbPath, "linux");
    assert.equal(reopened.stats().sessions, 9);
    reopened.close();
    const foreign = path.join(work, "foreign", "sessions.sqlite");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE other (x); INSERT INTO other VALUES (1);");
    db.close();
    const replaced = await m.SessionIndex.open(foreign, "linux");
    assert.equal(replaced.stats().sessions, 0);
    replaced.close();
  });
}

async function cutShortPassTest(m, work) {
  await check("A pass cut short resumes where it stopped, with no message twice", async () => {
    const root = path.join(work, "cut", "projects");
    const id = uuid();
    const records = [];
    for (let i = 0; i < 1000; i += 1) records.push(claudeUser(`message number ${i} kestrel${i}`, "/work/cut", i % 59));
    write(path.join(root, "-work-cut", `${id}.jsonl`), jsonl(records));
    const index = await m.SessionIndex.open(path.join(work, "cut-index", "sessions.sqlite"), "linux");
    let calls = 0;
    const stopping = {
      async checkpoint() {
        calls += 1;
        if (calls === 1) throw new Error("stopped");
      },
    };
    await assert.rejects(index.sync([{ agent: "claude", dir: root }], new Set(["claude"]), stopping), /stopped/);
    const partial = index.transcript(`claude:${id}`, 2000).total;
    assert.ok(partial > 0 && partial < 1000, `the first slice was kept (${partial})`);
    const pass = await index.sync([{ agent: "claude", dir: root }], new Set(["claude"]), noPause);
    assert.equal(pass.filesRead, 1, "the file is not taken for unchanged");
    assert.equal(index.transcript(`claude:${id}`, 2000).total, 1000);
    const hits = index.search({ query: "kestrel999", agents: ["claude"], scopeKeys: null, limit: 5, offset: 0, now: Date.now(), snippetTokens: 10 }).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].messageCount, 1000);
    index.close();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
