// A terminal an agent without a run opened belongs to that agent only: the
// ledger (src/main/agent-terminal-registry.ts) records the opener's process,
// pane and agent CLI session, and only the same captured session or the same
// live process matches. Codex in another pane, a new agent started in the
// opener's pane, or anyone asking about a terminal with no recorded opener
// cannot write to or close it. A session counts only when it was captured
// after the caller's agent started. It stays that agent's after Codara
// restarts (src/shared/agent-terminal-owner.ts): the owner record is saved
// with the pane in the layout, survives persist and hydration, and lets the
// same run, or the same resumed agent CLI session in the same workspace,
// adopt the pane back into a fresh, empty ownership ledger and close it.
// Anyone else still gets the refusal.
//
//   node scripts/test-agent-terminal-owner.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const harnessPlugin = {
  name: "agent-terminal-owner-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^react$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export const useCallback = (fn) => fn;\n" +
        "export const useEffect = () => {};\n" +
        "export const useLayoutEffect = () => {};\n" +
        "export const useMemo = (fn) => fn();\n" +
        "export const useRef = (v) => ({ current: v });\n" +
        "export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];\n",
      loader: "js",
    }));
  },
};

async function load(entry) {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [harnessPlugin],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const owner = await load("src/shared/agent-terminal-owner.ts");
  const { sanitizeTerminalAgentOwner, terminalAgentOwnerMatches, restoredAgentTerminal } = owner;

  const claude = { workspaceId: "ws-a", sessionId: "11111111-2222-3333-4444-555555555555" };
  const cora = { workspaceId: "ws-a", runId: "run-7", retention: "service" };
  assert.deepEqual(sanitizeTerminalAgentOwner(claude), claude);
  assert.deepEqual(sanitizeTerminalAgentOwner(cora), cora);
  assert.equal(sanitizeTerminalAgentOwner({ workspaceId: "ws-a" }), null, "no run and no session");
  assert.equal(sanitizeTerminalAgentOwner({ sessionId: "x" }), null, "no workspace");
  assert.equal(sanitizeTerminalAgentOwner({ workspaceId: "ws a", sessionId: "x" }), null);
  assert.deepEqual(sanitizeTerminalAgentOwner({ workspaceId: "w", runId: "r", sessionId: "s", retention: "forever" }), { workspaceId: "w", runId: "r" });

  const sameSession = { runId: null, sessionId: claude.sessionId, workspaceId: "ws-a" };
  assert.equal(terminalAgentOwnerMatches(claude, sameSession), true, "the resumed session owns it");
  assert.equal(terminalAgentOwnerMatches(claude, { ...sameSession, sessionId: "other" }), false, "another session does not");
  assert.equal(terminalAgentOwnerMatches(claude, { ...sameSession, workspaceId: "ws-b" }), false, "the same session from another workspace does not");
  assert.equal(terminalAgentOwnerMatches(claude, { ...sameSession, runId: "run-7" }), false, "a run never takes a session's pane");
  assert.equal(terminalAgentOwnerMatches(cora, { runId: "run-7", sessionId: null, workspaceId: null }), true);
  assert.equal(terminalAgentOwnerMatches(cora, { runId: "run-8", sessionId: null, workspaceId: null }), false);
  assert.equal(terminalAgentOwnerMatches(cora, { runId: null, sessionId: claude.sessionId, workspaceId: "ws-a" }), false);
  const { callerAgentSession } = owner;
  const claudeStarted = Date.parse("2026-10-25T01:00:00Z");
  const start = { sessionId: claude.sessionId, runtime: "claude", timestamp: "2026-10-25T01:00:03.000Z" };
  const agent = (runtime, startedMs = claudeStarted) => ({ runtime, startedMs });
  assert.equal(callerAgentSession(start, agent("claude")), claude.sessionId, "a session captured after the caller's agent started is its own");
  assert.equal(callerAgentSession(start, agent(null)), claude.sessionId, "no live agent known: the captured session");
  assert.equal(
    callerAgentSession(start, agent("claude", Date.parse("2026-10-25T02:00:00Z"))),
    null,
    "a new Claude started in the pane is not the session captured before it started",
  );
  assert.equal(callerAgentSession(start, agent("claude", null)), null, "nor is an agent whose start time is unknown");
  assert.equal(callerAgentSession(start, agent("codex")), null, "Codex started where Claude ran is not Claude's session");
  assert.equal(callerAgentSession({ ...start, active: false }, agent("claude")), null, "a session whose process ended");
  assert.equal(callerAgentSession(null, agent("claude")), null, "nothing captured yet");
  console.log("owner records validate and match only their own run or session");

  const tabs = await load("src/renderer/src/tabs/useTabs.ts");
  const minted = tabs.appendAgentTerminalToWorkspaceLayout({ workspaceId: "ws-a", tabs: [], activeId: null }, { cwd: "/p", agentOwner: claude });
  const created = minted.layout.tabs.find((tab) => tab.id === minted.tabId);
  assert.deepEqual(created.root.agentOwner, claude, "create puts the record on the pane");
  const saved = JSON.parse(JSON.stringify(tabs.stripTransientPaneState({ ...created.root, openedBy: "Other", worker: { runId: "r" } }, false)));
  assert.deepEqual(saved.agentOwner, claude, "persist keeps it, with resume-on-relaunch off too");
  assert.equal(saved.openedBy, undefined);
  tabs.cleanupTransientTerminalState(saved);
  assert.deepEqual(saved.agentOwner, claude, "hydration keeps a valid record");
  const tampered = { kind: "leaf", paneId: "p", agentOwner: { workspaceId: "ws-a" } };
  tabs.cleanupTransientTerminalState(tampered);
  assert.equal("agentOwner" in tampered, false, "hydration drops a malformed record");
  console.log("the record survives persist and hydration");

  const { AgentTerminalRegistry, AgentTerminalOwnershipError } = await load("src/main/agent-terminal-registry.ts");
  const stop = async () => {};
  const destroyTab = async () => ({ ok: true });

  const opened = new AgentTerminalRegistry();
  const claudeInA = { paneId: "pane-a", sessionId: "sess-claude", process: "500@1000" };
  const codexInB = { paneId: "pane-b", sessionId: "sess-codex", process: "600@1000" };
  opened.register({ paneId: "dev", tabId: "t-dev", runId: null, ownerPaneId: "pane-a", ownerSessionId: "sess-claude", ownerProcess: "500@1000" });
  assert.equal(opened.isActiveOwnedBy("dev", null, claudeInA), true, "the opener writes to it");
  assert.equal(opened.isActiveOwnedBy("dev", null, codexInB), false, "an agent in another pane does not");
  assert.equal(opened.isActiveOwnedBy("dev", null, null), false, "nor a caller outside any pane");
  assert.equal(opened.isActiveOwnedBy("dev", null, { paneId: "pane-a", sessionId: "sess-codex", process: "700@2000" }), false, "nor a new agent started in the opener's pane");
  assert.equal(opened.isActiveOwnedBy("dev", null, { paneId: "pane-c", sessionId: "sess-claude", process: "800@3000" }), true, "the same session resumed in another pane does");
  assert.equal(opened.isActiveOwnedBy("dev", null, { paneId: "pane-a", sessionId: null, process: "500@1000" }), true, "the opening process itself does while its session reads as not captured");
  assert.equal(opened.isActiveOwnedBy("dev", null, { paneId: "pane-a", sessionId: null, process: "700@2000" }), false, "a later agent in the opener's pane whose session is not captured does not");
  assert.equal(opened.isActiveOwnedBy("dev", "run-1", claudeInA), false, "a run does not");
  assert.deepEqual(opened.openerOf("dev"), { paneId: "pane-a", sessionId: "sess-claude", process: "500@1000" });
  await assert.rejects(
    opened.close({ paneId: "dev", runId: null, caller: codexInB, stop, destroyTab }),
    AgentTerminalOwnershipError,
    "codara_terminal_close refuses another agent",
  );
  assert.equal((await opened.close({ paneId: "dev", runId: null, caller: claudeInA, stop, destroyTab })).alreadyClosed, false);

  // The opener's session was never captured: its pane proves nothing, since
  // every later agent in that pane has the same one.
  opened.register({ paneId: "pane-only", tabId: "t-p", runId: null, ownerPaneId: "pane-a", ownerProcess: "500@1000" });
  assert.equal(opened.isActiveOwnedBy("pane-only", null, { paneId: "pane-a", sessionId: "sess-claude", process: "500@1000" }), true, "the same live process owns it");
  assert.equal(opened.isActiveOwnedBy("pane-only", null, { paneId: "pane-a", sessionId: "sess-later", process: "700@2000" }), false, "a later agent in that pane does not");
  assert.equal(opened.isActiveOwnedBy("pane-only", null, { paneId: "pane-a", sessionId: null, process: null }), false, "nor a caller in that pane whose process is unknown");
  assert.equal(opened.isActiveOwnedBy("pane-only", null, { paneId: "pane-a", sessionId: null, process: "500@1001" }), false, "a reused pid is another process");
  assert.equal(opened.isActiveOwnedBy("pane-only", null, codexInB), false);

  // Claude Code inside tmux: outside every pane, it owns what it opened by its process.
  opened.register({ paneId: "tmux-dev", tabId: "t-tmux", runId: null, ownerProcess: "900@5" });
  assert.equal(opened.isActiveOwnedBy("tmux-dev", null, { paneId: null, sessionId: null, process: "900@5" }), true, "the opener outside any pane keeps it");
  assert.equal(opened.isActiveOwnedBy("tmux-dev", null, codexInB), false, "Codex in a pane does not own it");
  assert.equal(opened.isActiveOwnedBy("tmux-dev", null, { paneId: null, sessionId: null, process: "901@5" }), false, "nor another process outside any pane");
  assert.equal(opened.isActiveOwnedBy("tmux-dev", null, null), false);

  // No opener recorded at all: it belongs to nobody, so every run-less request about it is refused or carded.
  opened.register({ paneId: "anon", tabId: "t-anon", runId: null });
  assert.equal(opened.openerOf("anon"), null);
  assert.equal(opened.isActiveOwnedBy("anon", null, null), false, "a terminal with no recorded opener belongs to nobody");
  assert.equal(opened.isActiveOwnedBy("anon", null, { paneId: null, sessionId: null, process: null }), false);
  assert.equal(opened.isActiveOwnedBy("anon", null, codexInB), false, "an agent in a pane does not own it");
  await assert.rejects(
    opened.close({ paneId: "anon", runId: null, caller: null, stop, destroyTab }),
    AgentTerminalOwnershipError,
    "codara_terminal_close refuses everyone",
  );
  assert.deepEqual(opened.listOpenedBy({ paneId: null, sessionId: null, process: "900@5" }).map((entry) => entry.paneId), ["tmux-dev"]);
  console.log("a run-less agent owns only what its own pane and session opened");

  const ledger = new AgentTerminalRegistry();
  const restored = { paneId: saved.paneId, tabId: minted.tabId, workspaceId: "ws-a", agentOwner: saved.agentOwner };

  assert.equal(ledger.knows(restored.paneId), false, "a relaunch starts with an empty ledger");
  await assert.rejects(
    ledger.close({ paneId: restored.paneId, runId: null, caller: { paneId: "pane-caller", sessionId: claude.sessionId }, stop, destroyTab }),
    AgentTerminalOwnershipError,
    "without adoption the refusal stands",
  );
  assert.equal(restoredAgentTerminal(restored, { ...sameSession, sessionId: "intruder", paneId: "pane-x" }), null);
  assert.equal(restoredAgentTerminal(restored, { runId: "run-7", sessionId: null, workspaceId: null, paneId: null }), null);
  const registration = restoredAgentTerminal(restored, { ...sameSession, paneId: "pane-caller", process: "510@4000" });
  assert.deepEqual(registration, {
    paneId: restored.paneId,
    tabId: minted.tabId,
    runId: null,
    retention: "temporary",
    ownerPaneId: "pane-caller",
    ownerSessionId: claude.sessionId,
    ownerProcess: "510@4000",
  });
  ledger.register(registration);
  const resumed = { paneId: "pane-caller", sessionId: claude.sessionId, process: "510@4000" };
  assert.equal(ledger.isActiveOwnedBy(restored.paneId, null, resumed), true, "the resumed agent writes to it again");
  assert.equal(ledger.isActiveOwnedBy(restored.paneId, null, { paneId: "pane-other", sessionId: "sess-codex" }), false, "another agent still may not");
  const closed = await ledger.close({ paneId: restored.paneId, runId: null, caller: resumed, stop, destroyTab });
  assert.equal(closed.alreadyClosed, false, "and closes it");
  assert.equal(ledger.knows(restored.paneId), true, "a closed pane is never adopted again");

  const elsewhere = restoredAgentTerminal({ ...restored, workspaceId: "ws-b" }, { ...sameSession, paneId: "pane-caller" });
  assert.equal(elsewhere.ownerSessionId, claude.sessionId, "a pane opened in another workspace is steered by its opener again");
  const run = restoredAgentTerminal({ ...restored, agentOwner: cora }, { runId: "run-7", sessionId: null, workspaceId: null, paneId: null });
  assert.deepEqual(run, { paneId: restored.paneId, tabId: minted.tabId, runId: "run-7", retention: "service" });
  console.log("after a restart the opener adopts and closes its pane; others are refused");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
