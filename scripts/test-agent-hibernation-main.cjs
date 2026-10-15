// Agent hibernation, main side: the decision in src/main/agent-hibernation.ts
// (every check runs, the listing is re-judged, the stop is fenced on the
// process generation) and the notifier's part in src/main/terminal-agent-
// notify.ts (the evidence it hands over, and a hibernated exit that raises no
// alert and paints no chip).
//
//   node scripts/test-agent-hibernation-main.cjs
//
// esbuild-bundles the REAL modules with electron, pty-manager, preferences
// and the notify pipeline stubbed. No process is listed or stopped.

// The notifier's flight-recorder log stays off; this run is not a session.
process.env.SPARK_TERMINAL_NOTIFY_LOG ??= "0";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const MAIN_DIR = path.join(ROOT, "src", "main");

const init =
  "globalThis.__AH ??= { prefs: { agentHibernationMinutes: 30 }, e2e: false, taps: new Map(), exits: new Map(), alerts: [], chips: [] };\n";

const harnessPlugin = (stubNotifier) => ({
  name: "agent-hibernation-main-harness",
  setup(build) {
    if (stubNotifier) {
      build.onResolve({ filter: /^\.\/terminal-agent-notify$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    }
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      {
        filter:
          /^(electron|\.\/e2e-background|\.\/pty-manager|\.\/preferences-store|\.\/notify|\.\/agent-session-registry|\.\/orchestration\/usage-activity-refresh|\.\/owned-process-tree-stub|\.\/remote-access\/studio-terminal-share)$/,
      },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      switch (args.path) {
        case "electron":
          return { contents: init + "export const BrowserWindow = { getFocusedWindow: () => null };\nexport const app = {};\n", loader: "js" };
        case "./e2e-background":
          return {
            contents: init + "export const E2E_BACKGROUND = globalThis.__AH.e2e;\n",
            loader: "js",
          };
        case "./preferences-store":
          return {
            contents: init + "export async function loadPreferences(){ return globalThis.__AH.prefs; }\n",
            loader: "js",
          };
        case "./remote-access/studio-terminal-share":
          return {
            contents: "export function studioPaneWatchedFromPhone(){ return false; }\n",
            loader: "js",
          };
        case "./agent-session-registry":
          return { contents: "export function latestSessionStart(){ return null; }\n", loader: "js" };
        case "./orchestration/usage-activity-refresh":
          return { contents: "export function nudgeUsageRefresh() {}\n", loader: "js" };
        case "./terminal-agent-notify":
          return {
            contents:
              init +
              "export function terminalAgentHibernationEvidence(){ return null; }\n" +
              "export function terminalPanePlacement(id){ return globalThis.__AH.placed?.has(id) ? { workspaceId: 'ws', tabId: 't' } : null; }\n",
            loader: "js",
          };
        case "./notify":
          return {
            contents:
              init +
              "export const paneSourceKey = (paneId) => `pane:${paneId}`;\n" +
              "export function rearm() {}\n" +
              "export function emitTerminalAgentState(payload){ globalThis.__AH.chips.push(payload); }\n" +
              "export function publish(event){ globalThis.__AH.alerts.push(event); }\n",
            loader: "js",
          };
        default:
          // ./pty-manager
          return {
            contents:
              init +
              "export function hibernationSessionInfo(){ return null; }\n" +
              "export async function hibernate(){ return false; }\n" +
              "export function hasSession(id){ return globalThis.__AH.live ? globalThis.__AH.live.has(id) : true; }\n" +
              "export function sessionAgentFlagsReachCli(){ return true; }\n" +
              "export function tap(id, h){ globalThis.__AH.taps.set(id, h); return () => globalThis.__AH.taps.delete(id); }\n" +
              "export function onExit(id, h){ globalThis.__AH.exits.set(id, h); return () => globalThis.__AH.exits.delete(id); }\n" +
              "export function readTailChunks(){ return []; }\n" +
              "export function sessionPid(){ return null; }\n" +
              "export function sessionDimensions(){ return null; }\n" +
              "export function waitForSpawn(){ return Promise.resolve(true); }\n" +
              "export function write(){}\n",
            loader: "js",
          };
      }
    });
  },
});

async function bundle(dir, entry, name, stubNotifier = false) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [harnessPlugin(stubNotifier)],
    logLevel: "silent",
  });
  return require(outfile);
}

const MIN = 60_000;
const NOW = 1_000 * MIN;

function makeDeps(overrides = {}) {
  const calls = { stop: [], list: 0, ttyPaths: [], terminalPanes: [] };
  const state = {
    session: {
      generationId: "gen-1",
      pid: 100,
      remote: false,
      createdAt: NOW - 200 * MIN,
      lastInputAt: NOW - 90 * MIN,
      lastOutputAt: NOW - 60 * MIN,
      ttyPath: "/dev/pts/7",
    },
    evidence: {
      excluded: false,
      disposing: false,
      attached: true,
      runtime: "claude",
      state: "idle",
      chipState: "idle",
      turnActive: false,
      pendingDone: false,
      pendingToolCalls: 0,
      backgroundRunning: 0,
      teammatesActive: 0,
      codexAwaitingIdle: false,
      lastUserInputAt: NOW - 90 * MIN,
      lastSubmitAt: NOW - 90 * MIN,
      lastOutputAt: NOW - 60 * MIN,
    },
    processes: [
      { pid: 100, parentPid: 1, startMs: NOW - 200 * MIN, command: "/usr/bin/zsh -f -ic claude; exec zsh -i" },
      { pid: 101, parentPid: 100, startMs: NOW - 200 * MIN, command: "node /usr/local/bin/claude" },
      { pid: 102, parentPid: 101, startMs: NOW - 200 * MIN + 2_000, command: "node /srv/mcp/index.js" },
    ],
    terminalPids: [100, 101, 102],
  };
  const deps = {
    now: () => NOW,
    policy: async () => ({ idleMs: 30 * MIN, tickMs: MIN }),
    session: () => (state.session ? { ...state.session } : null),
    evidence: () => (state.evidence ? { ...state.evidence } : null),
    listProcesses: async () => {
      calls.list += 1;
      if (state.duringList) state.duringList(state);
      return state.processes;
    },
    terminalPids: async (pane) => {
      calls.ttyPaths.push(pane.ttyPath);
      calls.terminalPanes.push(pane);
      return state.terminalPids;
    },
    stop: async (paneId, generationId) => {
      calls.stop.push({ paneId, generationId });
      return state.stopResult ?? true;
    },
    log: () => {},
    ...overrides,
  };
  return { deps, state, calls };
}

const request = (extra = {}) => ({ paneId: "pane-1", runtime: "claude", hiddenForMs: 45 * MIN, ...extra });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hibernation-main-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const ah = await bundle(dir, path.join(MAIN_DIR, "agent-hibernation.ts"), "agent-hibernation", true);
  const notify = await bundle(dir, path.join(MAIN_DIR, "terminal-agent-notify.ts"), "terminal-agent-notify");
  const H = globalThis.__AH;

  let failures = 0;
  const check = (name, cond, detail) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
  };
  const run = async (mutate, req = request()) => {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    mutate?.(t);
    const result = await ah.hibernateAgentPane(req, t.deps);
    return { result, ...t };
  };

  // ── The decision ──
  let r = await run();
  check("an idle, finished, lone agent in a long-hidden pane sleeps", r.result.ok === true && r.result.sleptAt === NOW, r.result);
  check("the stop is fenced on the judged generation", r.calls.stop.length === 1 && r.calls.stop[0].generationId === "gen-1", r.calls.stop);

  H.live = new Set();
  H.placed = new Set(["pane-1"]);
  check("a stopped pane is remembered as sleeping for the quit census", ah.sleepingAgentPanes().get("pane-1") === "claude");
  H.live = new Set(["pane-1"]);
  check("a pane that spawned again is awake", !ah.sleepingAgentPanes().has("pane-1"));
  H.live = undefined;
  H.placed = undefined;

  r = await run(undefined, { paneId: "", runtime: "claude", hiddenForMs: 1 });
  check("a malformed request is refused", r.result.reason === "bad-request" && r.calls.stop.length === 0);
  r = await run(undefined, { paneId: "p", runtime: "bash", hiddenForMs: 1 });
  check("an unknown runtime is refused", r.result.reason === "bad-request");
  r = await run((t) => { t.deps.policy = async () => ({ idleMs: 0, tickMs: MIN }); });
  check("the setting turned off refuses everything", r.result.reason === "off" && r.calls.list === 0);
  r = await run((t) => { t.state.session = null; });
  check("no live pty: refused", r.result.reason === "no-session");
  r = await run((t) => { t.state.session.remote = true; });
  check("a remote (ssh) pane never sleeps", r.result.reason === "remote");
  r = await run((t) => { t.state.evidence.state = "working"; t.state.evidence.chipState = "working"; });
  check("a working agent stays awake without listing processes", r.result.reason === "agent-busy" && r.calls.list === 0);
  r = await run((t) => { t.state.evidence.chipState = "blocked"; });
  check("an agent waiting for an answer stays awake", r.result.reason === "waiting-on-user");
  r = await run((t) => { t.state.evidence.lastUserInputAt = NOW - 80 * MIN; });
  check("text typed after the last submit keeps it awake", r.result.reason === "unsent-input");
  r = await run((t) => { t.state.session.lastOutputAt = NOW - 5 * MIN; });
  check("recent output keeps it awake", r.result.reason === "not-idle-long-enough");
  r = await run((t) => { t.state.session.lastInputAt = NOW - 5 * MIN; });
  check("recent input keeps it awake", r.result.reason === "not-idle-long-enough");
  r = await run(undefined, request({ hiddenForMs: 5 * MIN }));
  check("a workspace hidden only briefly keeps it awake", r.result.reason === "hidden-too-short");
  r = await run((t) => { t.state.processes = null; });
  check("no process listing: stays awake", r.result.reason === "process-list-unavailable" && r.calls.stop.length === 0);
  r = await run((t) => { t.state.terminalPids = null; });
  check("unreadable terminal holders: stays awake", r.result.reason === "process-list-unavailable");
  r = await run((t) => {
    t.state.session.ttyPath = null;
    // What listTerminalPids answers on POSIX for an unknown terminal.
    t.deps.terminalPids = async (pane) => (pane.ttyPath === null ? null : t.state.terminalPids);
  });
  check(
    "a pane whose terminal is unknown is asked about, and stays awake on POSIX",
    r.result.reason === "process-list-unavailable" && r.calls.stop.length === 0,
    r.result,
  );
  r = await run();
  check(
    "the pane's terminal and shell are what the holder check reads",
    JSON.stringify(r.calls.terminalPanes) === JSON.stringify([{ pid: 100, ttyPath: "/dev/pts/7" }]),
    r.calls.terminalPanes,
  );
  r = await run((t) => {
    t.state.processes = [...t.state.processes, { pid: 103, parentPid: 100, startMs: NOW - 300 * MIN, command: "node vite" }];
  });
  check("a dev server in the pane keeps it awake", r.result.reason === "other-processes" && r.calls.stop.length === 0, r.result);
  r = await run((t) => {
    t.state.duringList = (s) => { s.session = { ...s.session, generationId: "gen-2" }; };
  });
  check("a pane respawned while listing is not stopped", r.result.reason === "no-session" && r.calls.stop.length === 0);
  r = await run((t) => {
    t.state.duringList = (s) => { s.evidence = { ...s.evidence, lastUserInputAt: NOW, lastSubmitAt: NOW }; };
  });
  check("input that arrives while listing keeps it awake", r.result.reason === "not-idle-long-enough" && r.calls.stop.length === 0);
  r = await run((t) => { t.state.stopResult = false; });
  check("a stop that did not happen is reported", r.result.reason === "stop-failed");
  r = await run((t) => { t.deps.watchedOnPhone = (paneId) => paneId === "pane-1"; });
  check(
    "a pane a paired phone has open stays awake without listing processes",
    r.result.reason === "watched-on-phone" && r.calls.list === 0 && r.calls.stop.length === 0,
    r.result,
  );
  r = await run((t) => {
    let calls = 0;
    t.deps.watchedOnPhone = () => (calls += 1) > 1;
  });
  check("a phone that opens the pane while processes are listed keeps it awake", r.result.reason === "watched-on-phone" && r.calls.stop.length === 0);

  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    let release;
    t.deps.listProcesses = () => new Promise((resolve) => { release = () => resolve(t.state.processes); });
    const first = ah.hibernateAgentPane(request(), t.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await ah.hibernateAgentPane(request(), t.deps);
    release();
    const firstResult = await first;
    check("one decision per pane at a time", second.reason === "in-flight" && firstResult.ok === true && t.calls.stop.length === 1);
  }

  // ── Census backoff ──
  const devServer = { pid: 103, parentPid: 100, startMs: NOW - 300 * MIN, command: "node vite" };
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    const lone = t.state.processes;
    t.state.processes = [...lone, devServer];
    const first = await ah.hibernateAgentPane(request(), t.deps);
    const second = await ah.hibernateAgentPane(request(), t.deps);
    check(
      "a census refusal is reused on the next ticks without listing every process again",
      first.reason === "other-processes" && second.reason === "other-processes" && t.calls.list === 1,
      { first, second, list: t.calls.list },
    );
    t.state.evidence.state = "working";
    t.state.evidence.chipState = "working";
    const busy = await ah.hibernateAgentPane(request(), t.deps);
    check("the pane's own state still answers first while the census is held", busy.reason === "agent-busy", busy);
    t.state.evidence.state = "idle";
    t.state.evidence.chipState = "idle";
    t.state.processes = lone;
    t.state.session = { ...t.state.session, generationId: "gen-2" };
    const respawned = await ah.hibernateAgentPane(request(), t.deps);
    check(
      "a new process generation is listed afresh",
      respawned.ok === true && t.calls.list === 2 && t.calls.stop.length === 1,
      { respawned, list: t.calls.list },
    );
  }
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    let clock = NOW;
    t.deps.now = () => clock;
    const lone = t.state.processes;
    t.state.processes = [...lone, devServer];
    await ah.hibernateAgentPane(request(), t.deps);
    t.state.processes = lone;
    clock += 4 * MIN;
    const held = await ah.hibernateAgentPane(request(), t.deps);
    clock += 2 * MIN;
    const fresh = await ah.hibernateAgentPane(request(), t.deps);
    check(
      "the held verdict expires after five ticks and the stopped dev server lets the pane sleep",
      held.reason === "other-processes" && fresh.ok === true && t.calls.list === 2,
      { held, fresh, list: t.calls.list },
    );
  }
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    t.state.processes = null;
    await ah.hibernateAgentPane(request(), t.deps);
    await ah.hibernateAgentPane(request(), t.deps);
    check("an unreadable listing is not retried on every tick", t.calls.list === 1, t.calls.list);
  }

  // ── Quit during the stop ──
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    let duringStop = null;
    t.deps.stop = async () => {
      // pty-manager drops the session from its table as the stop begins.
      H.live = new Set();
      H.placed = new Set(["pane-1"]);
      duringStop = ah.sleepingAgentPanes().get("pane-1") ?? null;
      return true;
    };
    const result = await ah.hibernateAgentPane(request(), t.deps);
    check(
      "a quit while the stop runs already counts the pane as a sleeping agent",
      result.ok === true && duringStop === "claude",
      { result, duringStop },
    );
    ah.resetAgentHibernationForTests();
    const failed = makeDeps();
    failed.state.stopResult = false;
    await ah.hibernateAgentPane(request(), failed.deps);
    check("a stop that did not happen leaves no sleeping mark", !ah.sleepingAgentPanes().has("pane-1"));
    H.live = undefined;
    H.placed = undefined;
  }

  // ── Policy ──
  H.prefs = { agentHibernationMinutes: 60 };
  let policy = await ah.currentHibernationPolicy();
  check("the policy follows the setting", policy.idleMs === 60 * MIN && policy.tickMs === MIN, policy);
  H.prefs = { agentHibernationMinutes: 0 };
  policy = await ah.currentHibernationPolicy();
  check("Off gives a zero idle time", policy.idleMs === 0);
  H.prefs = { agentHibernationMinutes: 30 };
  process.env.CODARA_E2E_HIBERNATION_IDLE_MS = "2000";
  policy = await ah.currentHibernationPolicy();
  check("the e2e override is ignored outside the e2e runner", policy.idleMs === 30 * MIN);
  delete process.env.CODARA_E2E_HIBERNATION_IDLE_MS;

  // ── Notifier ──
  notify.syncTerminalNotifyPanes({
    workspaceId: "ws",
    workspaceName: "W",
    panes: [
      { paneId: "n1", tabId: "t", tabTitle: "T", excluded: false, runtimeHint: "claude" },
      { paneId: "n2", tabId: "t", tabTitle: "T", excluded: false, runtimeHint: "claude" },
      { paneId: "nx", tabId: "w", tabTitle: "workers", excluded: true },
    ],
  });
  let ev = notify.terminalAgentHibernationEvidence("n1");
  check(
    "the notifier hands over its view of the pane",
    ev && ev.runtime === "claude" && ev.state === "idle" && ev.attached === true && ev.pendingToolCalls === 0,
    ev,
  );
  check("an unknown pane has no evidence", notify.terminalAgentHibernationEvidence("nope") === null);
  check("an excluded pane says so", notify.terminalAgentHibernationEvidence("nx")?.excluded === true);
  notify.noteTerminalUserInput("n1", "hel");
  ev = notify.terminalAgentHibernationEvidence("n1");
  check("keys without Enter leave unsent text", ev.lastUserInputAt > ev.lastSubmitAt, ev);
  notify.noteTerminalUserInput("n1", "lo\r");
  ev = notify.terminalAgentHibernationEvidence("n1");
  check("Enter sends it", ev.lastUserInputAt === ev.lastSubmitAt && ev.lastSubmitAt > 0, ev);
  notify.noteTerminalUserInput("n1", "\x1b[I");
  check("a focus report is not typing", notify.terminalAgentHibernationEvidence("n1").lastUserInputAt === ev.lastUserInputAt);

  const alertsBefore = H.alerts.length;
  const chipsBefore = H.chips.length;
  H.exits.get("n1")?.({ exitCode: 1, signal: 1, sanctioned: true, hibernated: true });
  check("a hibernated exit raises no alert", H.alerts.length === alertsBefore, H.alerts.slice(alertsBefore));
  check("a hibernated exit paints no chip", H.chips.length === chipsBefore, H.chips.slice(chipsBefore));
  check("the watcher re-attaches for the resumed agent", H.taps.has("n1") && H.exits.has("n1"));
  H.exits.get("n2")?.({ exitCode: 1 });
  check(
    "an ordinary non-zero exit still alerts and paints the error chip",
    H.alerts.some((a) => a.kind === "terminal.agent.failed") && H.chips.some((c) => c.paneId === "n2" && c.state === "error"),
  );
  notify.disposeAllTerminalAgentWatchers();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall agent hibernation main checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
