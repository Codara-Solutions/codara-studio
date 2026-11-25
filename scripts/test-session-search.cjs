// Agent session search: the transcript parsers, the SQLite index (first
// build, incremental appends, rewrites, removals, copies, cut-short passes,
// scope filters), Antigravity's summary database read only, and the resume
// command a found session opens with.
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
        'export * from "./src/main/session-search/session-labels";',
        'export * from "./src/main/session-search/transcript-parsers";',
        'export * from "./src/main/session-search/jsonl-reader";',
        'export * from "./src/main/session-search/antigravity-summaries";',
        'export * from "./src/shared/session-search";',
        'export * from "./src/renderer/src/workers/session-resume";',
        'export * from "./src/renderer/src/components/session-search/cora-runs";',
        'export * from "./src/shared/run-delete-guard";',
        'export { buildAgentForkCommand, buildAgentResumeCommand, runtimeFromAgentSessionLaunchCommand, workerSessionsRuntime } from "./src/renderer/src/workers/launch-commands";',
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
    await pickerTests(m, work);
    await antigravityTests(m, work);
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
    const long = m.splitSnippetMarks(
      `Write a helper that verifies HMAC signatures on incoming ${m.SNIPPET_MARK_START}webhooks${m.SNIPPET_MARK_END} today`,
    );
    assert.deepEqual(m.trimSnippetLead(long, 28), [
      { text: "\u2026HMAC signatures on incoming ", mark: false },
      { text: "webhooks", mark: true },
      { text: " today", mark: false },
    ]);
    assert.equal(m.trimSnippetLead(long, 24)[0].text, "\u2026signatures on incoming ", "the cut starts at a word");
    assert.deepEqual(m.trimSnippetLead(parts, 28), parts, "a short lead is kept");
    const unmarked = [{ text: "x".repeat(80), mark: false }];
    assert.deepEqual(m.trimSnippetLead(unmarked, 28), unmarked, "an excerpt without a match is kept");
  });

  await check("Progress line, counts, ages and preferences", () => {
    const status = { ...m.EMPTY_SESSION_SEARCH_STATUS, phase: "indexing", filesTotal: 172, filesDone: 172, messages: 46_000 };
    assert.equal(m.sessionSearchProgressLine(status), "172 of 172 sessions · 46K messages searchable");
    assert.equal(m.compactCount(1250), "1.3K");
    assert.equal(m.relativeAge(Date.now() - 3 * 3_600_000, Date.now()), "3h ago");
    const prefs = m.normalizeSessionSearchPreferences({ enabled: false, agents: ["codex", "nope"], agentToolScope: "everything" });
    assert.equal(prefs.enabled, false);
    assert.deepEqual(prefs.agents, ["codex", "antigravity"], "a list saved before Antigravity existed never turned it off");
    const known = m.normalizeSessionSearchPreferences({ agents: ["codex"], knownAgents: m.SESSION_SEARCH_AGENTS });
    assert.deepEqual(known.agents, ["codex"], "once the list could name it, leaving it out turns it off");
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
      antigravity: `agy --conversation ${id}`,
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
    assert.equal(m.sessionResumeLaunch({ runtime: "antigravity", cwd: "/w", sessionId: "-p hi" }, ""), null);
    assert.equal(m.buildAgentResumeCommand({ runtime: "antigravity", sessionId: "continue" }), "agy --continue", "a new pane's pointer");
  });

  await check("Worker rows: Pi offers its sessions like Claude, Codex and Grok; a shell offers none", () => {
    assert.equal(m.workerSessionsRuntime("pi"), "pi");
    assert.equal(m.workerSessionsRuntime("claude --dangerously-skip-permissions"), "claude");
    assert.equal(m.workerSessionsRuntime("codex --yolo"), "codex");
    assert.equal(m.workerSessionsRuntime("grok --yolo"), "grok");
    assert.equal(m.workerSessionsRuntime(undefined), null);
    assert.equal(m.workerSessionsRuntime("pip install x"), null);
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

async function pickerTests(m, work) {
  const search = (index, query, extra = {}) =>
    index.search({ query, agents: ["claude"], scopeKeys: null, limit: 20, offset: 0, now: Date.now(), snippetTokens: 12, ...extra });

  const root = path.join(work, "picker", "projects");
  const named = uuid();
  const older = uuid();
  const detached = uuid();
  const openIndex = () => m.SessionIndex.open(path.join(work, "picker-index", "sessions.sqlite"), "linux");
  write(
    path.join(root, "-work-birds", `${named}.jsonl`),
    jsonl([
      claudeUser("Count the osprey nests near the lake", "/work/birds", 1, { gitBranch: "feat/nests" }),
      claudeAssistant("There are twelve kingfisher burrows and one egret", 2),
      claudeUser("Mention the egret again", "/work/birds", 3, { gitBranch: "feat/nests" }),
      claudeAssistant("The egret is still there", 4),
      { type: "ai-title", aiTitle: "Wetland census" },
    ]),
  );
  write(
    path.join(root, "-work-birds", `${older}.jsonl`),
    jsonl([claudeUser("An older talk about gulls", "/work/birds", 0), claudeAssistant("Noted", 0)]),
  );
  write(
    path.join(root, "-work-birds", `${detached}.jsonl`),
    jsonl([claudeUser("Detached checkout", "/work/birds", 5, { gitBranch: "HEAD" }), claudeAssistant("Fine", 6)]),
  );
  const index = await openIndex();
  await index.sync([{ agent: "claude", dir: root }], new Set(["claude"]), noPause);
  const namedKey = `claude:${named}`;
  const olderKey = `claude:${older}`;

  await check("a search says which part of a session matched", () => {
    const only = (query) => search(index, query).hits.find((hit) => hit.key === namedKey);
    assert.deepEqual(only("osprey").matches.map((match) => match.kind), ["user"]);
    assert.deepEqual(only("kingfisher").matches.map((match) => match.kind), ["assistant"]);
    assert.deepEqual(only("egret").matches.map((match) => match.kind), ["user", "assistant"]);
    assert.deepEqual(only("wetland").matches.map((match) => match.kind), ["name"]);
    assert.equal(only("wetland").snippet, null, "no message matched, so the row has no excerpt");
    assert.equal(only("osprey").snippetRole, "user");
    const marked = only("kingfisher").matches[0].snippet;
    assert.ok(marked.includes(`${m.SNIPPET_MARK_START}kingfisher${m.SNIPPET_MARK_END}`), "the snippet marks the word");
  });

  await check("a name is searchable, shows as the title, and the original still finds it", () => {
    index.applyLabels({ [namedKey]: { name: "Lake survey" } });
    const byName = search(index, "survey").hits;
    assert.equal(byName.length, 1);
    assert.equal(byName[0].title, "Lake survey");
    assert.equal(byName[0].originalTitle, "Wetland census");
    assert.deepEqual(byName[0].matches.map((match) => match.kind), ["name"]);
    assert.equal(search(index, "wetland").hits[0].title, "Lake survey", "the session's own title still finds it");
    assert.equal(index.transcript(namedKey, 10).title, "Lake survey");
    assert.equal(search(index, "").hits.find((hit) => hit.key === namedKey).messageCount, 4, "a name is not a message");
  });

  await check("a new pass keeps the name, and clearing it brings the title back", async () => {
    const file = path.join(root, "-work-birds", `${named}.jsonl`);
    fs.appendFileSync(file, jsonl([claudeUser("One more grebe", "/work/birds", 7)]));
    await index.sync([{ agent: "claude", dir: root }], new Set(["claude"]), noPause);
    index.applyLabels({ [namedKey]: { name: "Lake survey" } });
    assert.equal(search(index, "grebe").hits[0].title, "Lake survey");
    assert.equal(search(index, "survey").hits.length, 1, "the name is one row, however often it is applied");
    index.applyLabels({});
    assert.equal(search(index, "survey").hits.length, 0);
    assert.equal(search(index, "grebe").hits[0].title, "Wetland census");
    assert.equal(search(index, "grebe").hits[0].originalTitle, null);
  });

  await check("pinned sessions lead only when asked, and only an empty box", () => {
    index.applyLabels({ [olderKey]: { pinned: true } });
    const recent = search(index, "").hits;
    assert.notEqual(recent[0].key, olderKey);
    const pinned = search(index, "", { pinnedFirst: true }).hits;
    assert.equal(pinned[0].key, olderKey);
    assert.equal(pinned[0].pinned, true);
    assert.equal(pinned[1].pinned, false);
    index.applyLabels({});
    assert.equal(search(index, "").hits.find((hit) => hit.key === olderKey).pinned, false);
  });

  await check("the preview is the end of the conversation, oldest first and clipped", () => {
    const preview = index.preview(namedKey, 2, 8);
    assert.equal(preview.total, 5);
    assert.equal(preview.messages.length, 2);
    assert.equal(preview.messages[0].text, "The egre…");
    assert.equal(preview.messages[0].role, "assistant");
    assert.equal(preview.messages[1].text, "One more…");
    assert.equal(preview.messages[1].role, "user");
    assert.equal(index.preview("claude:not-there", 2, 8), null);
    assert.equal(index.preview("nonsense", 2, 8), null);
  });

  await check("the branch comes from the transcript, and a detached checkout names none", () => {
    const hits = search(index, "").hits;
    assert.equal(hits.find((hit) => hit.key === namedKey).branch, "feat/nests");
    assert.equal(hits.find((hit) => hit.key === `claude:${detached}`).branch, null);
    const state = m.initialTranscriptState();
    m.parseCodexLine(
      JSON.stringify({ type: "session_meta", payload: { id: uuid(), cwd: "/work", git: { branch: "main" } } }),
      state,
      () => undefined,
    );
    assert.equal(state.branch, "main");
    assert.equal(m.restoreTranscriptState(JSON.stringify(state)).branch, "main");
  });
  index.close();

  await check("day headings and length follow the local calendar", () => {
    const now = new Date(2026, 5, 17, 15, 0).getTime();
    assert.equal(m.sessionDayGroup(new Date(2026, 5, 17, 0, 1).getTime(), now), "Today");
    assert.equal(m.sessionDayGroup(new Date(2026, 5, 16, 23, 59).getTime(), now), "Yesterday");
    assert.equal(m.sessionDayGroup(new Date(2026, 5, 11, 0, 1).getTime(), now), "This week");
    assert.equal(m.sessionDayGroup(new Date(2026, 5, 10, 23, 59).getTime(), now), "Older");
    assert.equal(m.sessionDayGroup(null, now), "Older");
    assert.equal(m.sessionLengthLabel(0, 72 * 60_000), "1h 12m");
    assert.equal(m.sessionLengthLabel(0, 10_000), "under 1m");
    assert.equal(m.sessionLengthLabel(0, 49 * 3_600_000), "2d 1h");
    assert.equal(m.sessionLengthLabel(null, 10), "");
    assert.equal(m.sessionLengthLabel(10, 5), "");
  });

  await check("a name is one clean line of bounded length", () => {
    assert.equal(m.cleanSessionName("  two\n\tlines  "), "two lines");
    assert.equal(m.cleanSessionName("   "), null);
    assert.equal(m.cleanSessionName(42), null);
    assert.equal([...m.cleanSessionName("é".repeat(500))].length, m.SESSION_NAME_MAX);
  });

  await check("names and pins live in their own file, and survive a new store", async () => {
    const file = path.join(work, "labels", "session-labels.json");
    const store = new m.SessionLabelStore(file);
    const id = uuid();
    const key = `codex:${id}`;
    await Promise.all([
      store.update(key, { name: "  First   name " }),
      store.update(key, { pinned: true }),
      store.update(`claude:${uuid()}`, { name: "Other" }),
    ]);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const reopened = new m.SessionLabelStore(file);
    await reopened.load();
    assert.deepEqual(reopened.snapshot()[key], { name: "First name", pinned: true });
    assert.equal(reopened.nameOf(key), "First name");
    await reopened.update(key, { name: null });
    assert.deepEqual(reopened.snapshot()[key], { pinned: true });
    await reopened.update(key, { pinned: false });
    assert.equal(reopened.snapshot()[key], undefined, "an empty label leaves nothing behind");
    await assert.rejects(reopened.update("claude:../../etc", { name: "x" }), /Not a session/);
    await assert.rejects(reopened.update("rm:abc", { name: "x" }), /Not a session/);
  });

  await check("a corrupt labels file is set aside, not overwritten", async () => {
    const file = path.join(work, "labels-bad", "session-labels.json");
    write(file, "{ not json");
    const store = new m.SessionLabelStore(file);
    await store.load();
    assert.deepEqual(store.snapshot(), {});
    assert.equal(fs.readFileSync(`${file}.corrupt`, "utf8"), "{ not json");
    await store.update(`claude:${uuid()}`, { name: "Fresh" });
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length, 1);
  });

  await check("a labels file that cannot be read is never overwritten", async () => {
    const file = path.join(work, "labels-unreadable", "session-labels.json");
    // A folder in its place fails to read with something other than "not found".
    fs.mkdirSync(file, { recursive: true });
    const store = new m.SessionLabelStore(file);
    await assert.rejects(store.load());
    await assert.rejects(store.update(`claude:${uuid()}`, { name: "Lost" }));
    assert.ok(fs.statSync(file).isDirectory(), "nothing was written over it");
    fs.rmdirSync(file);
    write(file, JSON.stringify({ [`claude:${uuid()}`]: { name: "Kept" } }));
    await store.update(`claude:${uuid()}`, { name: "Added" });
    assert.equal(Object.keys(store.snapshot()).length, 2, "the next try reads the file and keeps what it holds");
  });

  await check("a fork keeps the source's history under a new id", () => {
    const id = uuid();
    const claude = m.sessionForkLaunch({ runtime: "claude", cwd: "/w", sessionId: id }, "now");
    assert.match(claude.command, new RegExp(`^claude .*--resume ${id} --fork-session --session-id [0-9a-f-]{36}$`));
    assert.notEqual(claude.pointer.sessionId, id);
    assert.ok(claude.command.endsWith(claude.pointer.sessionId));
    const grok = m.sessionForkLaunch({ runtime: "grok", cwd: "/w", sessionId: id }, "now");
    assert.match(grok.command, new RegExp(`^grok .*--resume ${id} --fork-session --session-id `));
    const codex = m.sessionForkLaunch({ runtime: "codex", cwd: "/w", sessionId: id }, "now");
    assert.equal(codex.command, `codex fork ${id} --yolo`);
    assert.equal(codex.pointer, null, "Codex mints the id; discovery finds it");
    assert.equal(m.runtimeFromAgentSessionLaunchCommand(codex.command), "codex");
    assert.equal(m.sessionForkLaunch({ runtime: "pi", cwd: "/w", sessionId: id }, "now"), null);
    assert.equal(m.sessionForkLaunch({ runtime: "claude", cwd: "/w", sessionId: "x; rm -rf /" }, "now"), null);
  });

  await check("a session running in a pane is found, asleep included, and a finished one is not", () => {
    const id = uuid();
    const leaf = (extra) => ({
      kind: "leaf",
      paneId: "p1",
      agentSession: { runtime: "claude", sessionId: id, cwd: "/w", capturedAt: "now", active: false },
      ...extra,
    });
    const layout = (root) => [{ workspaceId: "w1", tabs: [{ id: "t1", kind: "terminal", root }] }];
    const find = (root) => m.findOpenSessionPane(layout(root), "claude", id);
    assert.equal(find(leaf({})), null, "a pointer alone is a finished session");
    assert.deepEqual(find(leaf({ hibernation: { at: 1 } })), { workspaceId: "w1", tabId: "t1", paneId: "p1" });
    assert.ok(find(leaf({ worker: { state: "running", agentRunning: true } })));
    assert.equal(find(leaf({ worker: { state: "done" } })), null);
    assert.ok(find({ kind: "split", a: leaf({ paneId: "p0", agentSession: null }), b: leaf({ hibernation: { at: 1 } }) }));
    assert.equal(m.findOpenSessionPane(layout(leaf({ hibernation: { at: 1 } })), "codex", id), null);
  });

  await check("a Cora row: what it is, where opening lands, and when it may be deleted", () => {
    const run = (extra = {}) => ({ id: "run-a", status: "complete", workerAttempts: [], ...extra });
    const loom = { automationId: "loom-1", executionMode: "direct" };
    const jobs = (history, currentRunId) => [{ id: "loom-1", history: history.map((runId) => ({ runId })), state: { status: "idle", currentRunId } }];
    assert.equal(m.coraRunKind(run()), "chat");
    assert.equal(m.coraRunKind(run(loom)), "loom-pass");
    assert.equal(m.coraRunKind(run({ automationId: "a" })), "automation-run");
    assert.equal(m.coraRunKind(run({ workflow: { name: "w" } })), "workflow-run");

    // A chat opens as its chat, and goes to its tab when one shows it.
    assert.deepEqual(m.coraPrimary(m.coraRunFacts(run(), null, false)), { action: "open-chat", label: "Open chat" });
    assert.equal(m.coraPrimary(m.coraRunFacts(run(), null, true)).label, "Go to its tab");
    // A pass its Loom still lists opens in the hub; one it does not is read here.
    const listed = m.coraRunFacts(run(loom), jobs(["run-a"]), false);
    assert.deepEqual(m.coraPrimary(listed), { action: "open-hub", label: "Open pass in Automations" });
    const orphan = m.coraPrimary(m.coraRunFacts(run(loom), jobs(["run-b"]), false));
    assert.equal(orphan.action, "view");
    assert.equal(orphan.label, "View");
    assert.match(orphan.notice, /Its Loom no longer lists it/);
    const deleted = m.coraPrimary(m.coraRunFacts(run(loom), [], false));
    assert.equal(deleted.action, "view");
    assert.match(deleted.notice, /Its Loom was deleted/);
    assert.equal(m.coraPrimary(m.coraRunFacts(run({ workflow: { name: "w" } }), null, false)).action, "open-hub");
    const gone = m.coraRunFacts(null, null, false);
    assert.equal(m.coraPrimary(gone).action, "view");

    // Delete: finished and closed only.
    assert.equal(m.coraDeleteBlock(listed), null);
    assert.equal(m.coraDeleteBlock(m.coraRunFacts(run(), null, false)), null);
    assert.match(m.coraDeleteBlock(m.coraRunFacts(run(), null, true)), /Open in a tab/);
    for (const status of ["planning", "running", "reviewing"]) {
      assert.match(m.coraDeleteBlock(m.coraRunFacts(run({ ...loom, status }), jobs(["run-a"]), false)), /Working now/, status);
    }
    const stillWorking = run({ ...loom, status: "paused", workerAttempts: [{ status: "running" }] });
    assert.match(m.coraDeleteBlock(m.coraRunFacts(stillWorking, null, false)), /Working now/);
    const settled = run({ status: "paused", workerAttempts: [{ status: "succeeded" }, { status: "failed" }] });
    assert.equal(m.coraDeleteBlock(m.coraRunFacts(settled, null, false)), null);
    assert.ok(m.coraDeleteBlock(gone), "nothing left to delete");

    // A Loom adds its next pass to its current run, which reads as finished in between,
    // and keeps it through a pause or a question: deleting it would stop the Loom.
    const held = m.coraRunFacts(run(loom), jobs(["run-a"], "run-a"), false);
    assert.equal(m.coraDeleteBlock(held), "Its Loom is still using this run. Stop the Loom first.");
    assert.equal(m.coraDeleteBlock(m.coraRunFacts(run(loom), jobs(["run-a"], "run-z"), false)), null);
    // Looms that could not be listed are not read as "no Loom".
    const unknown = m.coraRunFacts(run(loom), null, false);
    assert.match(m.coraDeleteBlock(unknown), /Could not read its Loom/);
    assert.equal(m.coraPrimary(unknown).action, "view");
    assert.match(m.coraPrimary(unknown).notice, /could not be read/, "an unread list is not called a deleted Loom");
    assert.equal(m.coraDeleteBlock(m.coraRunFacts(run(), null, false)), null, "a chat needs no Loom list");

    // The confirm names what goes: every pass that ran in this run, and what Cora learned.
    assert.equal(
      m.coraDeleteConfirm(listed),
      "Deletes this run and its saved output from this computer, with what Cora learned from it. Its Loom and its other passes stay.",
    );
    const shared = m.coraRunFacts(run(loom), jobs(["run-a", "run-b", "run-a", "run-a"]), false);
    assert.equal(shared.passCount, 3);
    assert.equal(
      m.coraDeleteConfirm(shared),
      "Deletes these 3 passes, which ran in this one run, and their saved output from this computer, with what Cora learned from them. Its Loom stays.",
    );
    assert.match(m.coraDeleteConfirm(m.coraRunFacts(run({ workflow: { name: "w" } }), null, false)), /Its workflow and its other runs stay/);
    assert.match(m.coraDeleteConfirm(m.coraRunFacts(run(), null, false)), /^Deletes this chat/);
    assert.match(m.coraDeleteConfirm(m.coraRunFacts(run(loom), [], false)), /learned from it\. Its other passes stay\.$/, "a deleted Loom is not said to stay");

    // Main refuses the same shapes under the run's queue.
    assert.equal(m.liveRunDeleteRefusal(run({ status: "running" }), []), m.RUN_IS_WORKING);
    assert.equal(m.liveRunDeleteRefusal(run(), jobs([], "run-a")), m.LOOM_HOLDS_RUN);
    assert.equal(m.liveRunDeleteRefusal(run(), jobs([], undefined)), null);
    assert.ok(m.RUN_ID_SHAPE.test("run-mabc12-x9y8z7"));
    for (const bad of ["../run-a", "run-a/..", "run-", "x-run-a", "run-a b", `run-${"a".repeat(129)}`]) {
      assert.equal(m.RUN_ID_SHAPE.test(bad), false, bad);
    }
  });

  await check("a tab shows a run: its chat, its Runs tab or its workers, in any workspace", () => {
    const layouts = (tabs) => [{ workspaceId: "w0", tabs: [] }, { workspaceId: "w1", tabs }];
    assert.equal(m.runShownInTab(layouts([{ id: "run-a", kind: "chat" }]), "run-a"), true);
    assert.equal(m.runShownInTab(layouts([{ id: "t", kind: "runs", runId: "run-a" }]), "run-a"), true);
    assert.equal(m.runShownInTab(layouts([{ id: "t", kind: "terminal", scope: { kind: "workers", runId: "run-a" } }]), "run-a"), true);
    assert.equal(m.runShownInTab(layouts([{ id: "run-b", kind: "chat" }, { id: "t", kind: "terminal" }]), "run-a"), false);
  });
}

// agy's own schema for its summary table, as `sqlite3 .schema` prints it.
const AGY_SUMMARY_SCHEMA =
  "CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT \"\",`preview` text NOT NULL DEFAULT \"\",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT \"\",`source` text NOT NULL DEFAULT \"\",`project_id` text NOT NULL DEFAULT \"\",`agent_name` text NOT NULL DEFAULT \"\",`parent_conversation_id` text NOT NULL DEFAULT \"\",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT \"\",`winning_conversation_id` text NOT NULL DEFAULT \"\",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT \"\",`raw_summary` blob,`group_id` text NOT NULL DEFAULT \"\",PRIMARY KEY (`conversation_id`));";

async function antigravityTests(m, work) {
  const { DatabaseSync } = require("node:sqlite");
  const ids = { heron: uuid(), kestrel: uuid(), child: uuid() };
  const agyDir = path.join(work, "agy-home", ".gemini", "antigravity-cli");
  fs.mkdirSync(agyDir, { recursive: true });
  const dbPath = path.join(agyDir, m.ANTIGRAVITY_SUMMARY_DB);
  // The CLI's own connection stays open with its changes still in the WAL, as while agy runs.
  const cli = new DatabaseSync(dbPath);
  cli.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  cli.exec(AGY_SUMMARY_SCHEMA);
  const insert = cli.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, last_user_input_time, raw_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const row = (id, title, preview, time, uris, parent = "", depth = 0) =>
    insert.run(id, title, preview, 12, time, uris, parent, depth, time, Buffer.from("rawsecretword"));
  row(ids.heron, "Refactor the heron cache", "We moved the heron cache behind one lock", "2026-01-01 10:30:00.123456789+00:00", '["file:///work/agy"]');
  row(ids.kestrel, "Kestrel notes", "", "2026-01-01T09:00:00Z", "/work/other");
  row(ids.child, "Child heron task", "a subagent", "2026-01-01 10:31:00+00:00", '["file:///work/agy"]', ids.heron, 1);
  row("x; rm -rf ~", "Unsafe heron", "never typed", "2026-01-01 10:32:00+00:00", "/work/agy");
  row("continue", "Continue heron", "the pointer word", "2026-01-01 10:33:00+00:00", "/work/agy");
  const root = { agent: "antigravity", dir: agyDir };
  const agents = new Set(m.SESSION_SEARCH_AGENTS);
  const index = await m.SessionIndex.open(path.join(work, "agy-index", "sessions.sqlite"), "linux");
  const search = (query, extra = {}) =>
    index.search({ query, agents: ["antigravity"], scopeKeys: null, limit: 50, offset: 0, now: Date.now(), snippetTokens: 10, ...extra }).hits;
  const bytes = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = [bytes(dbPath), bytes(`${dbPath}-wal`)];
  let cli2;

  await check("Antigravity: top-level conversations from the summary table, read only, WAL included", async () => {
    await index.sync([root], agents, noPause);
    assert.equal(index.stats().byAgent.antigravity.sessions, 2, "the child, the unsafe id and the pointer word are left out");
    const [heron] = search("heron");
    assert.equal(search("heron").length, 1);
    assert.equal(heron.sessionId, ids.heron);
    assert.equal(heron.title, "Refactor the heron cache");
    assert.equal(heron.cwd, "/work/agy");
    assert.equal(heron.lastAt, Date.parse("2026-01-01T10:30:00.123Z"));
    assert.deepEqual(heron.matches.map((match) => match.kind), ["name", "assistant"], "title and preview both match");
    assert.deepEqual(search("lock").map((hit) => hit.sessionId), [ids.heron], "the preview is searchable");
    const [kestrel] = search("kestrel");
    assert.equal(kestrel.cwd, "/work/other", "a title without a preview still lists");
    assert.deepEqual(kestrel.matches.map((match) => match.kind), ["name"], "no title copied in as a preview");
    const asked = [];
    m.readAntigravitySummaries(dbPath, (file) => {
      const db = m.openSummaryDatabase(file);
      return { prepare: (sql) => (asked.push(sql), db.prepare(sql)), close: () => db.close() };
    });
    assert.ok(asked.length > 0 && asked.every((sql) => !/raw_summary|\*/.test(sql)), "raw_summary is never selected");
    assert.deepEqual(search("", { scopeKeys: ["/work/agy"] }).map((hit) => hit.sessionId), [ids.heron]);
    assert.equal(index.preview(`antigravity:${ids.heron}`, 6, 1500).messages[0].text, "We moved the heron cache behind one lock");
    assert.deepEqual([bytes(dbPath), bytes(`${dbPath}-wal`)], before, "agy's database and its WAL are unchanged");
    assert.equal((await index.sync([root], agents, noPause)).filesRead, 0, "an unchanged row is not read again");
  });

  await check("Antigravity: a renamed conversation is read again, a removed one leaves", async () => {
    cli.prepare("UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?").run("Heron cache, part two", ids.heron);
    cli.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(ids.kestrel);
    await index.sync([root], agents, noPause);
    assert.equal(search("heron")[0].title, "Heron cache, part two");
    assert.deepEqual(search("kestrel"), []);
  });
  cli.close();

  await check("Antigravity: with agy closed or crashed nothing is written beside its database, live rows come from not_fully_idle, and a vanished one keeps the rows", async () => {
    const listing = () => fs.readdirSync(agyDir).sort();
    assert.deepEqual(listing(), [m.ANTIGRAVITY_SUMMARY_DB], "the closed writer checkpointed its WAL");
    cli2 = new DatabaseSync(dbPath);
    cli2.prepare("UPDATE conversation_summaries SET preview = ? WHERE conversation_id = ?").run("The heron cache now has a lock per shard", ids.heron);
    cli2.prepare("UPDATE conversation_summaries SET not_fully_idle = 1 WHERE conversation_id IN (?, ?)").run(ids.heron, ids.child);
    cli2.close();
    await index.sync([root], agents, noPause);
    assert.deepEqual(search("shard").map((hit) => hit.sessionId), [ids.heron]);
    assert.deepEqual(m.readLiveAntigravityConversations(dbPath), [ids.heron], "top-level conversations only");
    assert.deepEqual(listing(), [m.ANTIGRAVITY_SUMMARY_DB], "no -wal or -shm appeared");
    // A crashed agy can leave a -wal and no -shm: still read as immutable.
    fs.writeFileSync(`${dbPath}-wal`, "");
    assert.deepEqual(m.readLiveAntigravityConversations(dbPath), [ids.heron]);
    await index.sync([root], agents, noPause);
    assert.deepEqual(listing(), [m.ANTIGRAVITY_SUMMARY_DB, `${m.ANTIGRAVITY_SUMMARY_DB}-wal`], "no -shm appeared, the -wal is left as it was");
    assert.equal(fs.statSync(`${dbPath}-wal`).size, 0);
    fs.rmSync(`${dbPath}-wal`);
    fs.renameSync(dbPath, `${dbPath}.away`);
    await index.sync([root], agents, noPause);
    assert.deepEqual(search("heron").map((hit) => hit.sessionId), [ids.heron], "a database that vanished keeps the rows");
    fs.renameSync(`${dbPath}.away`, dbPath);
  });

  await check("Antigravity: --continue skips a conversation another pane names, saved layouts count, folders fold case on Windows", () => {
    const row = (id, cwd, lastAt) => ({ id, title: "", preview: "", steps: 1, lastAt, cwd });
    const list = [row("a", "/w", 100), row("b", "/w", 200), row("c", "/other", 300)];
    assert.equal(m.continueReopensNamed(list, "/w", ["c"]), true, "the latest overall");
    assert.equal(m.continueReopensNamed(list, "/w", ["b"]), true, "the latest of the folder");
    assert.equal(m.continueReopensNamed(list, "/w", ["a"]), false);
    assert.equal(m.continueReopensNamed(list, "/w", []), false);
    const leaf = (paneId, sessionId) => ({ kind: "leaf", paneId, agentSession: { runtime: "antigravity", sessionId, cwd: "/w", capturedAt: "now" } });
    const layouts = [
      { tabs: [{ id: "t", kind: "terminal", root: { kind: "split", a: leaf("p1", "conv-1"), b: { kind: "split", a: leaf("p2", "continue"), b: leaf("p3", "conv-3") } } }] },
      // A workspace not loaded yet, from its saved layout.
      { tabs: [{ id: "u", kind: "terminal", root: leaf("p4", "conv-4") }] },
    ];
    assert.deepEqual(m.antigravityConversationsNamed(layouts, "p3").sort(), ["conv-1", "conv-4"]);
    assert.equal(m.sameFolder("C:\\Work\\App", "c:\\work\\app", "win32"), true);
    assert.equal(m.sameFolder("/work/App", "/work/app", "linux"), false);
    assert.equal(m.sameFolder("/work/app/", "/work/app", "linux"), true);
    assert.equal(m.sameFolder(null, "/work/app"), false);
  });

  await check("Antigravity sleep: the pane sleeps with the conversation its agy holds, wakes with agy --conversation, never onto a shared one", () => {
    const pointer = (sessionId) => ({ runtime: "antigravity", sessionId, cwd: "/w", capturedAt: "now", active: true });
    const typed = m.antigravitySleepPointer(pointer("continue"), "conv-9", ["conv-1"]);
    assert.equal(typed.session?.sessionId, "conv-9", "a typed agy takes the conversation it holds open");
    assert.equal(m.buildAgentResumeCommand(typed.session), "agy --conversation conv-9", "waking reopens that conversation");
    assert.equal(m.antigravitySleepPointer(pointer("conv-2"), "conv-9", []).session?.sessionId, "conv-9", "a pane whose agy moved on takes the open one");
    const same = pointer("conv-9");
    assert.equal(m.antigravitySleepPointer(same, "conv-9", []).session, same, "an unchanged pointer is kept as it is");
    for (const [name, open, named] of [
      ["unknown open conversation", null, []],
      ["the placeholder", "continue", []],
      ["an id that is not one", "-p hi", []],
      ["a conversation another pane names", "conv-1", ["conv-1"]],
    ]) {
      assert.ok("skip" in m.antigravitySleepPointer(pointer("continue"), open, named), name);
    }
    assert.equal(m.antigravityWakeRefusal("conv-9", ["conv-1"], false), null);
    assert.match(m.antigravityWakeRefusal("continue", [], false), /does not know which Antigravity conversation/, "the placeholder would reopen agy's latest");
    assert.match(m.antigravityWakeRefusal(null, [], false), /does not know/);
    assert.match(m.antigravityWakeRefusal("conv-9", ["conv-9"], false), /Another tab has this Antigravity conversation/);
    assert.match(m.antigravityWakeRefusal("conv-9", [], true), /open in another terminal/, "an agy outside Codara holds it");
    assert.match(m.antigravityWakeRefusal("conv-9", [], null), /could not check/, "unknown is not free");
    assert.match(m.antigravityWakeRefusal("conv-9", [], "missing"), /no longer lists this conversation/, "a deleted conversation is not free");
  });

  await check("Antigravity: a missing database or a table of another shape lists nothing and fails nothing", async () => {
    const empty = path.join(work, "agy-empty");
    const odd = path.join(work, "agy-odd");
    fs.mkdirSync(empty, { recursive: true });
    fs.mkdirSync(odd, { recursive: true });
    const other = new DatabaseSync(path.join(odd, m.ANTIGRAVITY_SUMMARY_DB));
    other.exec("CREATE TABLE conversation_summaries (id TEXT, name TEXT); INSERT INTO conversation_summaries VALUES ('a', 'heron');");
    other.close();
    const fresh = await m.SessionIndex.open(path.join(work, "agy-index-2", "sessions.sqlite"), "linux");
    for (const dir of [empty, odd]) await fresh.sync([{ agent: "antigravity", dir }], agents, noPause);
    assert.equal(fresh.stats().byAgent.antigravity, undefined);
    assert.equal(fs.existsSync(path.join(empty, m.ANTIGRAVITY_SUMMARY_DB)), false, "a missing database is not created");
    fresh.close();
  });

  await check("Antigravity: summary times and workspace folders in the shapes agy may write", () => {
    assert.equal(m.parseSummaryTime("2026-01-01 10:30:00.5+01:00"), Date.parse("2026-01-01T09:30:00.500Z"));
    assert.equal(m.parseSummaryTime("2026-01-01 10:30:00 +0100"), Date.parse("2026-01-01T09:30:00.000Z"));
    assert.equal(m.parseSummaryTime(1_767_000_000), 1_767_000_000_000);
    assert.equal(m.parseSummaryTime("yesterday"), null);
    assert.equal(m.summaryWorkspaceFolder('["file:///work/a%20b", "file:///work/c"]'), "/work/a b");
    assert.equal(m.summaryWorkspaceFolder("https://example.com,/work/d"), "/work/d");
    assert.equal(m.summaryWorkspaceFolder(""), null);
    assert.equal(m.antigravityCliDir("/home/x"), path.join("/home/x", ".gemini", "antigravity-cli"));
  });
  index.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
