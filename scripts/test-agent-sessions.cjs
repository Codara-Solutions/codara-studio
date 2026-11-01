#!/usr/bin/env node
"use strict";

// codara_session_*: a session one agent starts for another
// (src/shared/agent-sessions.ts, src/main/agent-sessions.ts).
//
// Proven here:
//   1. The status comes from the pane now and the recorded turn end: a turn
//      from before the latest prompt never reads as its answer, a started
//      session is not "finished" at its first idle screen, a prompt for the
//      user reads needs_you, a closed tab keeps a finished session's answer,
//      a restart mid-turn says so, and a launch that never showed an agent
//      fails rather than starting forever.
//   2. The brief reaches the agent as one argument whatever it holds: the
//      real shell gets it byte for byte through the command line, which names
//      only the private file. Windows reads the file instead.
//   3. Requests are validated: runtime, effort, a model that could read as a
//      flag, an oversized or empty brief.
//   4. Records survive a new store, are mode 600, are found only from the
//      caller's workspace (or its own process with none), keep the whole final
//      message for one session and a cut one in a list, and a broken file
//      reads as none. Briefs are removed once the first turn ended, and left
//      overs at load.
//   5. The cap on live sessions holds for starts made together.
//   6. A wait returns on the first settled session (any), on the last (all),
//      on a timeout with the sessions still running, and when its client went.
//   7. A follow-up is refused while the session works, waits for the user
//      (Enter could approve what it asked), is closed, asleep or exited, and
//      while the user is typing; Claude's older draft is parked instead.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-agent-sessions-"));
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

async function load() {
  const outfile = path.join(OUT_DIR, "agent-sessions.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src/main/agent-sessions.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    external: ["electron"],
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  return require(outfile);
}

const T0 = 1_800_000_000_000;

function record(over = {}) {
  return {
    id: "as-1",
    runtime: "claude",
    model: null,
    effort: null,
    title: "Task",
    paneId: "pane-1",
    tabId: "tab-1",
    workspaceId: "ws-target",
    workspaceName: "Target",
    cwd: "/target",
    branch: null,
    callerWorkspaceId: "ws-caller",
    ownerProcess: "1:2",
    startedAt: T0,
    promptAt: T0,
    turnEndedAt: null,
    failure: null,
    finalMessage: null,
    closedAt: null,
    ...over,
  };
}

function live(over = {}) {
  return { runtime: "claude", state: "idle", tool: null, question: null, lastTurnStartedAt: 0, turnActive: false, ...over };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(OUT_DIR, "store-"));
  return dir;
}

(async () => {
  const sessions = await load();
  const { agentSessionState } = await bundleShared();
  const status = (rec, pane, now = T0 + 5_000, bootAt = T0 - 60_000) => agentSessionState(rec, pane, now, bootAt).status;

  // 1. Status.
  assert.equal(status(record(), null), "starting", "a new tab has not reached the notifier yet");
  assert.equal(status(record(), live()), "starting", "the first idle screen is not a finished session");
  assert.equal(status(record(), live({ state: "launching" })), "starting");
  assert.equal(status(record(), live({ state: "working" })), "working");
  assert.equal(status(record(), live({ state: "background" })), "working", "its background work still runs");
  assert.equal(status(record(), live({ turnActive: true })), "working", "a turn waiting to be announced is not over");
  const ended = record({ turnEndedAt: T0 + 3_000, finalMessage: "Done." });
  assert.equal(status(ended, live()), "finished");
  assert.equal(status(ended, live({ state: "working" })), "working", "the user gave it more work in its tab");
  const asked = agentSessionState(record(), live({ state: "blocked", question: "Allow npm test?" }), T0 + 5_000, T0 - 1);
  assert.deepEqual(asked, { status: "needs_you", detail: "Allow npm test?" });
  const stale = record({ promptAt: T0 + 10_000, turnEndedAt: T0 + 3_000 });
  assert.equal(status(stale, live(), T0 + 11_000), "working", "an earlier turn does not answer a later message");
  assert.equal(
    status(record({ turnEndedAt: T0 + 3_000, failure: "API error" }), live()),
    "failed",
    "a turn that ended in an error is not finished",
  );
  assert.equal(status(record(), live({ state: "error" })), "failed");
  assert.equal(
    status(record(), live({ lastTurnStartedAt: T0 + 1_000 })),
    "finished",
    "a turn the user stopped closes with no answer and must not read as starting forever",
  );
  assert.equal(status(ended, null, T0 + 60_000), "finished", "a closed tab keeps the answer");
  assert.equal(status(record(), null, T0 + 60_000), "closed");
  assert.equal(status(record({ closedAt: T0 + 1_000 }), null, T0 + 2_000), "closed");
  assert.equal(status(record(), live({ runtime: null }), T0 + 4 * 60_000), "failed", "no agent ever started");
  assert.equal(status(record(), live(), T0 + 4 * 60_000), "starting", "an agent is there: it may be slow, not failed");
  const restarted = agentSessionState(record(), live(), T0 + 60_000, T0 + 30_000);
  assert.equal(restarted.status, "failed");
  assert.match(restarted.detail, /restarted during this turn/);

  // 2. The brief through a real shell.
  const dir = tempDir();
  const brief = 'it\'s "quoted" `whoami` $(touch /tmp/never) $HOME \\ \n; rm -rf nothing | & > x\n\tünï 日本語\n';
  const briefPath = path.join(dir, "o'brien dir", "brief.md");
  fs.mkdirSync(path.dirname(briefPath));
  fs.writeFileSync(briefPath, brief);
  const fake = path.join(dir, "bin");
  fs.mkdirSync(fake);
  fs.writeFileSync(
    path.join(fake, "claude"),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fake, "codex"),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o755 },
  );
  const line = sessions.agentSessionCommand({
    runtime: "claude",
    model: "some-model",
    effort: "high",
    briefPath,
    codexTrust: null,
    compaction: { claudeSettingsPath: null },
    platform: "linux",
  });
  assert.ok(!line.includes("whoami"), "the brief itself never enters the command line");
  const shells = ["bash", "sh", ...(fs.existsSync("/usr/bin/zsh") || fs.existsSync("/bin/zsh") ? ["zsh"] : [])];
  for (const shell of shells) {
    const out = JSON.parse(
      execFileSync(shell, ["-c", line], { env: { ...process.env, PATH: `${fake}:${process.env.PATH}` }, encoding: "utf8" }),
    );
    assert.equal(out.at(-1), brief.replace(/\n+$/, ""), `${shell} passes the brief unchanged but for trailing newlines`);
    assert.ok(out.includes("some-model"));
  }
  const codexLine = sessions.agentSessionCommand({
    runtime: "codex",
    model: null,
    effort: null,
    briefPath,
    codexTrust: "projects={'/tmp/a b'={trust_level='trusted'}}",
    platform: "linux",
  });
  const codexArgs = JSON.parse(
    execFileSync("bash", ["-c", codexLine], { env: { ...process.env, PATH: `${fake}:${process.env.PATH}` }, encoding: "utf8" }),
  );
  assert.ok(codexArgs.includes("projects={'/tmp/a b'={trust_level='trusted'}}"), "Codex keeps its trust override whole");
  assert.equal(codexArgs.at(-1), brief.replace(/\n+$/, ""));
  assert.equal(codexArgs.at(-2), "--", "a brief that opens with a dash stays the brief");
  const windows = sessions.agentSessionCommand({
    runtime: "claude",
    model: null,
    effort: null,
    briefPath: "C:\\Users\\o'b\\brief.md",
    codexTrust: null,
    platform: "win32",
  });
  assert.match(windows, /Read the file C:\\Users\\o''b\\brief\.md/, "PowerShell doubles a quote");
  assert.ok(!windows.includes("$("), "PowerShell gets no POSIX substitution");

  // 3. Validation.
  const ok = sessions.parseAgentSessionStart({ brief: "First line\nmore", runtime: "codex" });
  assert.equal(ok.title, "First line");
  assert.equal(ok.model, null);
  assert.match(sessions.parseAgentSessionStart({ runtime: "claude" }), /brief is required/);
  assert.match(sessions.parseAgentSessionStart({ brief: "x", runtime: "grok" }), /runtime must be/);
  assert.match(sessions.parseAgentSessionStart({ brief: "x", runtime: "claude", effort: "huge" }), /effort must be/);
  for (const model of ["--dangerously-skip-permissions", "a b", "a;b", "$(x)", "a'b", ""]) {
    assert.equal(typeof sessions.parseAgentSessionStart({ brief: "x", runtime: "claude", model }), "string", model);
  }
  assert.equal(typeof sessions.parseAgentSessionStart({ brief: "x", runtime: "claude", model: "claude-x-1[1m]" }), "object");
  assert.match(sessions.parseAgentSessionStart({ brief: "x".repeat(60_001), runtime: "claude" }), /limited to/);
  assert.equal(sessions.agentSessionWaitMs(undefined), 120_000);
  assert.equal(sessions.agentSessionWaitMs(9_999), 540_000, "a wait never holds a turn past the cap");
  assert.equal(typeof sessions.agentSessionWaitMs("soon"), "string");

  // 4. Records.
  const storeDir = tempDir();
  let panes = new Map();
  let now = T0;
  const makeStore = (bootAt = T0 - 1) =>
    new sessions.AgentSessions({ dir: storeDir, live: (paneId) => panes.get(paneId) ?? null, now: () => now, bootAt });
  const store = makeStore();
  await store.load();
  const briefFile = await store.writeBrief("as-1", "secret brief");
  assert.equal(fs.statSync(briefFile).mode & 0o777, 0o600);
  await store.add(record());
  await store.add(record({ id: "as-2", paneId: "pane-2", callerWorkspaceId: "ws-other", ownerProcess: "9:9" }));
  await store.flush();
  assert.equal(fs.statSync(path.join(storeDir, sessions.AGENT_SESSIONS_FILE)).mode & 0o777, 0o600);
  store.noteTurnEnd({ paneId: "pane-1", failed: false, message: "m".repeat(2_000), at: T0 + 1_000 });
  await store.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(briefFile), false, "the brief goes once the first turn ended");
  store.noteTurnEnd({ paneId: "pane-unknown", failed: false, message: "x", at: T0 });
  const releaseEarly = store.reserve();
  store.noteTurnEnd({ paneId: "pane-quick", failed: false, message: "Quick.", at: T0 + 500 });
  await store.add(record({ id: "as-quick", paneId: "pane-quick", promptAt: T0 + 100, callerWorkspaceId: "ws-quick" }));
  releaseEarly();
  assert.equal(store.get("as-quick").finalMessage, "Quick.", "a turn that ended before its record existed still counts");
  store.noteTurnEnd({ paneId: "pane-stale", failed: false, message: "Old.", at: T0 });
  await store.add(record({ id: "as-stale", paneId: "pane-stale", promptAt: T0 + 100, callerWorkspaceId: "ws-quick" }));
  assert.equal(store.get("as-stale").finalMessage, null, "nor does a turn from before the launch, or with no start under way");

  const again = makeStore();
  await again.load();
  panes.set("pane-1", live());
  const seen = again.visibleTo({ workspaceId: "ws-caller", process: null });
  assert.deepEqual(seen.map((entry) => entry.id), ["as-1"], "a later session in the workspace finds it; another workspace does not");
  assert.equal(again.view(seen[0]).status, "finished");
  assert.equal(again.view(seen[0]).finalMessage.length, 2_000, "one session returns the whole message");
  const cut = again.view(seen[0], { cut: true });
  assert.equal(cut.finalMessage.length, 500);
  assert.equal(cut.finalMessageCut, true);
  assert.equal(cut.link, "codara://tab/ws-target/tab-1");
  assert.deepEqual(again.visibleTo({ workspaceId: null, process: "9:9" }).map((entry) => entry.id), ["as-2"]);
  assert.deepEqual(again.visibleTo({ workspaceId: null, process: null }), [], "nobody identified sees nothing");
  assert.equal(again.holdsPane("pane-1"), true, "a session keeps its pane");
  assert.equal(again.holdsPane("pane-other"), false);

  const leftover = path.join(storeDir, sessions.AGENT_SESSION_BRIEFS_DIR, "as-gone.md");
  fs.writeFileSync(leftover, "x");
  const third = makeStore();
  await third.load();
  assert.equal(fs.existsSync(leftover), false, "a brief with no session is not left on disk");
  third.notePrompt("as-1");
  assert.equal(third.get("as-1").finalMessage, null, "a follow-up clears the answer it replaces");
  await third.flush();

  const brokenDir = tempDir();
  fs.writeFileSync(path.join(brokenDir, sessions.AGENT_SESSIONS_FILE), "{nope");
  const broken = new sessions.AgentSessions({ dir: brokenDir, live: () => null });
  await broken.load();
  assert.deepEqual(broken.visibleTo({ workspaceId: "ws-caller", process: null }), []);

  // 5. The cap holds for starts made together.
  const capDir = tempDir();
  const capped = new sessions.AgentSessions({ dir: capDir, live: () => live({ state: "working" }), now: () => T0 });
  await capped.load();
  const releases = [];
  for (let i = 0; i < 12; i += 1) releases.push(capped.reserve());
  assert.ok(releases.every(Boolean));
  assert.equal(capped.reserve(), null, "the thirteenth is refused before any record exists");
  releases[0]();
  releases[0]();
  assert.ok(capped.reserve(), "a released place is free once");

  // 6. Waiting.
  const waitDir = tempDir();
  let waitNow = T0;
  const waitPanes = new Map([
    ["pane-1", live({ state: "working" })],
    ["pane-2", live({ state: "working" })],
  ]);
  const waiter = new sessions.AgentSessions({ dir: waitDir, live: (paneId) => waitPanes.get(paneId) ?? null, now: () => waitNow, bootAt: T0 - 1 });
  await waiter.load();
  const first = record();
  const second = record({ id: "as-2", paneId: "pane-2" });
  await waiter.add(first);
  await waiter.add(second);
  const never = () => false;
  const timedOut = await waiter.wait({
    records: [first],
    mode: "any",
    timeoutMs: 1,
    cancelled: () => {
      waitNow += 10;
      return false;
    },
    pollMs: 1,
  });
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.sessions[0].status, "working", "a timeout reports them still running");
  waiter.noteTurnEnd({ paneId: "pane-1", failed: false, message: "One.", at: waitNow });
  waitPanes.set("pane-1", live());
  const any = await waiter.wait({ records: [first, second], mode: "any", timeoutMs: 1000, cancelled: never, pollMs: 1 });
  assert.equal(any.reason, "any_settled");
  assert.equal(any.sessions[0].finalMessage, "One.");
  setTimeout(() => {
    waitPanes.set("pane-2", live({ state: "blocked", question: "Which one?" }));
  }, 5);
  const all = await waiter.wait({ records: [first, second], mode: "all", timeoutMs: 60_000, cancelled: never, pollMs: 1 });
  assert.equal(all.reason, "all_settled", "needing a person ends a wait: nothing else will");
  assert.equal(all.sessions[1].status, "needs_you");
  waitPanes.set("pane-2", live({ state: "working" }));
  const gone = await waiter.wait({ records: [second], mode: "any", timeoutMs: 60_000, cancelled: () => true, pollMs: 1 });
  assert.equal(gone.reason, "cancelled");

  // 7. Follow-ups.
  const can = { status: "finished", runtime: "claude", running: true, lastUserInputAt: 0, lastSubmitAt: 0, now: T0 };
  const refuse = sessions.agentSessionMessageRefusal;
  assert.equal(refuse(can), null);
  assert.equal(refuse({ ...can, status: "failed" }), null);
  assert.match(refuse({ ...can, status: "needs_you" }), /waiting for the user/);
  assert.match(refuse({ ...can, status: "working" }), /working/);
  assert.match(refuse({ ...can, status: "starting" }), /working/);
  assert.match(refuse({ ...can, status: "closed" }), /closed/);
  assert.match(refuse({ ...can, running: false }), /asleep/);
  assert.match(refuse({ ...can, runtime: null }), /exited/);
  assert.match(refuse({ ...can, lastUserInputAt: T0 - 1_000 }), /typing/);
  assert.equal(refuse({ ...can, lastUserInputAt: T0 - 60_000 }), null, "Claude parks an old draft");
  assert.match(refuse({ ...can, runtime: "codex", lastUserInputAt: T0 - 60_000 }), /typing/, "Codex cannot park one");
  assert.equal(refuse({ ...can, lastUserInputAt: T0 - 1_000, lastSubmitAt: T0 - 1_000 }), null, "a submitted line is no draft");

  console.log("test-agent-sessions: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function bundleShared() {
  const outfile = path.join(OUT_DIR, "shared-agent-sessions.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src/shared/agent-sessions.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}
