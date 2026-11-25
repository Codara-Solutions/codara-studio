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
          /^(electron|\.\/e2e-background|\.\/pty-manager|\.\/preferences-store|\.\/system-metrics|\.\/workspace-status|\.\/notify|\.\/agent-session-registry|\.\/orchestration\/usage-activity-refresh|\.\/owned-process-tree-stub|\.\/remote-access\/studio-terminal-share)$/,
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
        case "./workspace-status":
          return {
            contents: init + "export function paneAgentNote(id){ return globalThis.__AH.notes?.[id] ?? null; }\n",
            loader: "js",
          };
        case "./system-metrics":
          return {
            contents:
              init +
              "export async function readAvailableMemory(){ globalThis.__AH.memoryReads = (globalThis.__AH.memoryReads ?? 0) + 1; return globalThis.__AH.memory ?? null; }\n",
            loader: "js",
          };
        case "./remote-access/studio-terminal-share":
          return {
            contents: "export function studioPaneWatchedFromPhone(){ return false; }\n",
            loader: "js",
          };
        case "./agent-session-registry":
          return { contents: init + "export function latestSessionStart(id){ return globalThis.__AH.starts?.[id] ?? null; }\n", loader: "js" };
        case "./orchestration/usage-activity-refresh":
          return { contents: "export function nudgeUsageRefresh() {}\n", loader: "js" };
        case "./terminal-agent-notify":
          return {
            contents:
              init +
              "export function terminalAgentHibernationEvidence(){ return null; }\n" +
              "export function terminalAgentActivitySnapshot(){ return globalThis.__AH.activity ?? []; }\n" +
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
              "export function sleepOutput(){ return null; }\n" +
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
      lastComposerEditAt: NOW - 90 * MIN,
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
    policy: async () => ({ idleMs: 30 * MIN, workspaceIdleMs: {}, tickMs: MIN, memoryLevel: "ok" }),
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

const request = (extra = {}) => ({ paneId: "pane-1", runtime: "claude", placement: "background-workspace", ...extra });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hibernation-main-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const ah = await bundle(dir, path.join(MAIN_DIR, "agent-hibernation.ts"), "agent-hibernation", true);
  const notify = await bundle(dir, path.join(MAIN_DIR, "terminal-agent-notify.ts"), "terminal-agent-notify");
  const shared = await bundle(dir, path.join(MAIN_DIR, "..", "shared", "agent-hibernation.ts"), "shared-agent-hibernation");
  const scheduledWork = await bundle(dir, path.join(MAIN_DIR, "agent-scheduled-work.ts"), "agent-scheduled-work");
  const presence = await bundle(dir, path.join(MAIN_DIR, "antigravity-presence.ts"), "antigravity-presence");
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
  check("an idle, finished, lone agent sleeps", r.result.ok === true && r.result.sleptAt === NOW, r.result);
  check("the stop is fenced on the judged generation", r.calls.stop.length === 1 && r.calls.stop[0].generationId === "gen-1", r.calls.stop);

  H.live = new Set();
  H.placed = new Set(["pane-1"]);
  check("a stopped pane is remembered as sleeping for the quit census", ah.sleepingAgentPanes().get("pane-1") === "claude");
  H.live = new Set(["pane-1"]);
  check("a pane that spawned again is awake", !ah.sleepingAgentPanes().has("pane-1"));
  H.live = undefined;
  H.placed = undefined;

  r = await run(undefined, { paneId: "", runtime: "claude", placement: "visible" });
  check("a malformed request is refused", r.result.reason === "bad-request" && r.calls.stop.length === 0);
  r = await run(undefined, { paneId: "p", runtime: "bash", placement: "visible" });
  check("an unknown runtime is refused", r.result.reason === "bad-request");
  r = await run((t) => { t.deps.policy = async () => ({ idleMs: 0, workspaceIdleMs: {}, tickMs: MIN, memoryLevel: "ok" }); });
  check("the setting turned off refuses everything", r.result.reason === "off" && r.calls.list === 0);
  r = await run((t) => { t.state.session = null; });
  check("no live pty: refused", r.result.reason === "no-session");
  r = await run((t) => { t.state.session.remote = true; });
  check("a remote (ssh) pane never sleeps", r.result.reason === "remote");
  r = await run((t) => { t.state.evidence.state = "working"; t.state.evidence.chipState = "working"; });
  check("a working agent stays awake without listing processes", r.result.reason === "agent-busy" && r.calls.list === 0);
  r = await run((t) => { t.state.evidence.chipState = "blocked"; });
  check("an agent waiting for an answer stays awake", r.result.reason === "waiting-on-user");
  r = await run((t) => {
    t.state.evidence.lastUserInputAt = NOW - 80 * MIN;
    t.state.evidence.lastComposerEditAt = NOW - 80 * MIN;
  });
  check("text typed after the last submit keeps it awake", r.result.reason === "unsent-input");
  r = await run((t) => { t.state.evidence.lastUserInputAt = NOW - 80 * MIN; });
  check("a key after the last submit that leaves no text does not", r.result.ok === true, r.result);
  r = await run((t) => { t.state.session.lastOutputAt = NOW - 5 * MIN; });
  check("recent output keeps it awake", r.result.reason === "not-idle-long-enough");
  r = await run((t) => { t.state.session.lastInputAt = NOW - 5 * MIN; });
  check("recent input keeps it awake", r.result.reason === "not-idle-long-enough");
  r = await run(undefined, { paneId: "pane-1", runtime: "claude", placement: "somewhere" });
  check("an unknown placement is a bad request", r.result.reason === "bad-request", r.result);
  r = await run(undefined, { paneId: "pane-1", runtime: "claude", hiddenForMs: 45 * MIN });
  check("a request in the old shape is a bad request", r.result.reason === "bad-request", r.result);
  for (const placement of ["visible", "hidden-tab", "background-workspace"]) {
    r = await run(undefined, request({ placement }));
    check(`a quiet pane may sleep wherever it is (${placement})`, r.result.ok === true, r.result);
  }

  // ── Antigravity: agy's screen, plus the conversation its process holds
  // open and agy's own busy flag for it and its subagents ──
  const agyRun = (mutate, extra = {}) =>
    run(
      (t) => {
        t.state.processes = [
          { pid: 100, parentPid: 1, startMs: NOW - 200 * MIN, command: "/usr/bin/zsh -f -ic agy; exec zsh -i" },
          { pid: 101, parentPid: 100, startMs: NOW - 200 * MIN, command: "/home/u/.local/bin/agy --continue" },
          { pid: 102, parentPid: 101, startMs: NOW - 200 * MIN + 2_000, command: "node /srv/mcp/index.js" },
        ];
        t.state.evidence.runtime = "antigravity";
        t.state.open = ["conv-1"];
        t.state.activity = { known: true, busy: null };
        // The paned agy (101) holds t.state.open; every other process in the
        // pane holds what t.state.others says, nothing by default.
        t.state.others = {};
        t.deps.antigravity = (pid, command, conversationId, otherPids) =>
          presence.antigravitySleepVerdict(
            pid,
            command,
            conversationId,
            {
              open: async (openPid) => {
                if (openPid === pid) t.calls.openPid = openPid;
                return openPid === pid ? t.state.open : openPid in t.state.others ? t.state.others[openPid] : [];
              },
              activity: () => t.state.activity,
            },
            otherPids,
          );
        t.deps.antigravityActivity = (id) => presence.antigravityActivityVerdict(id, () => t.state.finalActivity ?? t.state.activity);
        mutate?.(t);
      },
      request({ runtime: "antigravity", conversationId: "conv-1", ...extra }),
    );
  r = await agyRun();
  check("an idle agy holding the pane's conversation sleeps", r.result.ok === true && r.calls.stop.length === 1, r.result);
  check("it reads the open conversation off the agy process the census found", r.calls.openPid === 101, r.calls);
  check("the answer names the conversation main proved", r.result.conversationId === "conv-1", r.result);
  r = await agyRun(undefined, { session: { runtime: "antigravity", sessionId: "continue", cwd: "/w" } });
  H.live = new Set();
  H.placed = new Set(["pane-1"]);
  const keptAgy = ah.takeSleepingPane("pane-1");
  H.live = undefined;
  H.placed = undefined;
  check(
    "the sleep keeps the conversation it proved, not the pane's lagging pointer",
    r.result.ok === true && keptAgy?.session?.sessionId === "conv-1" && keptAgy.session.cwd === "/w",
    keptAgy,
  );
  r = await agyRun(undefined, { manual: true });
  check("Sleep now puts an idle agy to sleep too", r.result.ok === true, r.result);
  const agyRefusals = [
    ["agy working on screen", (t) => Object.assign(t.state.evidence, { state: "working", chipState: "working" }), {}, "agent-busy"],
    ["agy marking the conversation working", (t) => (t.state.activity = { known: true, busy: "conversation" }), {}, "agent-busy", "agy marks it working"],
    ["a subagent agy marks working", (t) => (t.state.activity = { known: true, busy: "subagent" }), {}, "agent-busy", "a subagent is working"],
    ["the placeholder id of agy --continue", null, { conversationId: "continue" }, "conversation-unknown", "no conversation id"],
    ["no conversation id", null, { conversationId: undefined }, "conversation-unknown", "no conversation id"],
    ["agy holding another conversation than the pane names", (t) => (t.state.open = ["conv-2"]), {}, "conversation-unknown", "agy has another conversation open"],
    ["agy holding a second conversation (a subagent's, another one's)", (t) => (t.state.open = ["conv-1", "conv-sub"]), {}, "conversation-unknown", "agy holds 2 conversations open"],
    ["agy holding none", (t) => (t.state.open = []), {}, "conversation-unknown", "agy holds 0 conversations open"],
    ["agy's open files unreadable", (t) => (t.state.open = null), {}, "conversation-unknown", "open conversation unreadable"],
    ["agy's conversation list unreadable", (t) => (t.state.activity = undefined), {}, "conversation-unknown", "conversation list unreadable"],
    ["agy's conversation list without its busy flag", (t) => (t.state.activity = null), {}, "unknown-state", "agy's conversation list has another shape"],
    ["a conversation agy does not list", (t) => (t.state.activity = { known: false, busy: null }), {}, "conversation-unknown", "not in agy's conversation list"],
    ["text typed and not sent", (t) => (t.state.evidence.lastComposerEditAt = NOW - 80 * MIN), {}, "unsent-input"],
    ["a command agy started after boot", (t) => t.state.processes.push({ pid: 103, parentPid: 101, startMs: NOW - 20 * MIN, command: "npm run dev" }), {}, "other-processes"],
    ["a program beside agy in the pane", (t) => t.state.processes.push({ pid: 104, parentPid: 100, startMs: NOW - 20 * MIN, command: "vim notes" }), {}, "other-processes"],
    ["agy in print mode", (t) => (t.state.processes[1].command = "agy -p summarize"), {}, "other-processes", "agy is not an interactive session"],
    ["agy with a remote connection", (t) => (t.state.processes[1].command = "agy --remote-control"), {}, "other-processes", "agy is not an interactive session"],
    ["a second agy under the first", (t) => t.state.processes.push({ pid: 105, parentPid: 101, startMs: NOW - 200 * MIN + 1_000, command: "agy -r conv-9" }), {}, "other-processes"],
    [
      "the pane's processes changing while agy was checked",
      (t) => {
        const checked = t.deps.antigravity;
        t.deps.antigravity = async (...args) => {
          const verdict = await checked(...args);
          t.state.processes = [...t.state.processes, { pid: 106, parentPid: 101, startMs: NOW - 200 * MIN + 1_500, command: "/opt/Agent Tools/agy" }];
          return verdict;
        };
      },
      {},
      "other-processes",
      "the pane's processes changed while agy was checked",
    ],
    [
      "a pid of the pane reused by another program while agy was checked",
      (t) => {
        const checked = t.deps.antigravity;
        t.deps.antigravity = async (...args) => {
          const verdict = await checked(...args);
          t.state.processes = t.state.processes.map((p) => (p.pid === 102 ? { ...p, startMs: p.startMs + 1, command: "node /srv/other.js" } : p));
          return verdict;
        };
      },
      {},
      "other-processes",
      "the pane's processes changed while agy was checked",
    ],
    [
      "a subagent turning busy during the re-census",
      (t) => (t.state.finalActivity = { known: true, busy: "subagent" }),
      {},
      "agent-busy",
      "a subagent is working",
    ],
    [
      "agy moving to another conversation during the re-census",
      (t) => {
        let lists = 0;
        t.state.duringList = (state) => {
          if (++lists === 2) state.open = ["conv-2"];
        };
      },
      {},
      "conversation-unknown",
      "agy has another conversation open",
    ],
    [
      "a second holder started through a link named otherwise",
      (t) => {
        t.state.processes.push({ pid: 107, parentPid: 101, startMs: NOW - 200 * MIN + 1_000, command: "/opt/tools/antigravity" });
        t.state.others[107] = ["conv-9"];
      },
      {},
      "other-processes",
      "another process in the pane holds an agy conversation",
    ],
    [
      "a process in the pane whose files cannot be read",
      (t) => (t.state.others[102] = null),
      {},
      "conversation-unknown",
      "a process in the pane could not be read",
    ],
    ["no last look at agy's flags", (t) => delete t.deps.antigravityActivity, {}, "conversation-unknown", "agy could not be checked"],
    ["no way to check agy at all", (t) => delete t.deps.antigravity, {}, "conversation-unknown", "agy could not be checked"],
  ];
  for (const [name, mutate, extra, reason, detail] of agyRefusals) {
    for (const manual of [false, true]) {
      r = await agyRun(mutate ?? undefined, { ...extra, ...(manual ? { manual: true } : {}) });
      check(
        `${manual ? "Sleep now: " : ""}${name} keeps agy awake (${reason})`,
        r.result.ok === false &&
          r.result.reason === reason &&
          (detail === undefined || r.result.detail === detail) &&
          r.calls.stop.length === 0,
        r.result,
      );
    }
  }
  r = await agyRun(undefined, { conversationId: "continue" });
  check("a pane without a conversation id is refused before any process listing", r.calls.list === 0, r.calls);
  r = await agyRun((t) => {
    t.state.processes[1].command = "agy";
    t.state.evidence.runtime = "claude";
  });
  check("an agy pane the notifier knows as another agent is refused", r.result.reason === "runtime-mismatch", r.result);

  // ── A settled agent that repaints (Claude Code's status line) ──
  const repainting = (t, extra = {}) => {
    t.state.session.lastOutputAt = NOW - 1_000;
    t.state.session.lastInputAt = NOW - 1_000; // the terminal's replies to the repaint's queries
    Object.assign(t.state.evidence, { lastOutputAt: NOW - 1_000, structured: true, settledAt: NOW - 45 * MIN }, extra);
  };
  r = await run((t) => repainting(t));
  check("a settled agent with hooks sleeps although its status line repaints", r.result.ok === true, r.result);
  r = await run((t) => repainting(t, { structured: false }));
  check(
    "screen-only evidence keeps every byte on the clock",
    r.result.reason === "not-idle-long-enough" && /^pty input|^pty output/.test(r.result.detail),
    r.result,
  );
  r = await run((t) => repainting(t, { settledAt: 0 }));
  check("an unknown settle moment keeps output on the clock", r.result.reason === "not-idle-long-enough", r.result);
  r = await run((t) => repainting(t, { settledAt: NOW - 5 * MIN }));
  check(
    "a state that moved recently (a turn ended, a hook fired) restarts the clock",
    r.result.reason === "not-idle-long-enough" && r.result.detail === "agent state 300s ago, needs 1800s",
    r.result,
  );
  r = await run((t) => repainting(t, { lastUserInputAt: NOW - 2 * MIN, lastSubmitAt: NOW - 2 * MIN, lastComposerEditAt: NOW - 2 * MIN }));
  check(
    "the user's own keys still restart it",
    r.result.reason === "not-idle-long-enough" && r.result.detail === "agent input 120s ago, needs 1800s",
    r.result,
  );
  r = await run((t) => repainting(t, { state: "working", chipState: "working" }));
  check("a working agent that repaints stays awake", r.result.reason === "agent-busy", r.result);
  r = await run((t) => repainting(t, { chipState: "blocked" }));
  check("a waiting agent that repaints stays awake", r.result.reason === "waiting-on-user", r.result);
  r = await run((t) => repainting(t, { backgroundRunning: 1 }));
  check("background work that repaints stays awake", r.result.reason === "agent-busy", r.result);
  r = await run((t) => repainting(t, { lastComposerEditAt: NOW - 50 * MIN, lastSubmitAt: NOW - 55 * MIN, lastUserInputAt: NOW - 50 * MIN }));
  check("unsent text in a repainting agent keeps it awake", r.result.reason === "unsent-input", r.result);
  r = await run((t) => {
    repainting(t);
    t.state.processes = [...t.state.processes, { pid: 103, parentPid: 101, startMs: NOW - 10 * MIN, command: "bash -c 'source /x/shell-snapshots/snapshot-zsh-1.sh; npm run dev'" }];
  });
  check("a command the agent left running keeps a repainting agent awake", r.result.reason === "other-processes", r.result);
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    repainting(t);
    ah.noteAgentPanesTouched(["pane-1"], NOW - 2 * MIN);
    const touched = await ah.hibernateAgentPane(request(), t.deps);
    check("a pane the user showed still restarts it", touched.reason === "not-idle-long-enough" && /^shown or touched/.test(touched.detail), touched);
  }
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    ah.noteAgentPanesTouched(["pane-1"], NOW - 5 * MIN);
    const touched = await ah.hibernateAgentPane(request({ placement: "visible" }), t.deps);
    check(
      "a pane the user showed or touched five minutes ago stays awake, and says why",
      touched.reason === "not-idle-long-enough" && touched.detail === "shown or touched 300s ago, needs 1800s" && t.calls.list === 0,
      touched,
    );
    ah.noteAgentPanesTouched(["pane-1"], NOW - 31 * MIN);
    const quiet = await ah.hibernateAgentPane(request({ placement: "visible" }), t.deps);
    check("a touch older than the idle time no longer holds it", quiet.ok === true, quiet);
    ah.resetAgentHibernationForTests();
    const other = makeDeps();
    ah.noteAgentPanesTouched(["pane-2", "", 7], NOW);
    check("a touch on another pane does not hold this one", (await ah.hibernateAgentPane(request(), other.deps)).ok === true);
    ah.resetAgentHibernationForTests();
    const viaChannel = makeDeps();
    ah.onAgentHibernationMessage("touched", ["pane-1"]);
    check(
      "the renderer's touched message reaches the idle clock",
      (await ah.hibernateAgentPane(request(), viaChannel.deps)).reason !== undefined,
    );
    ah.onAgentHibernationMessage("touched", "pane-1");
    ah.onAgentHibernationMessage("touched", new Array(65).fill("pane-1"));
    check("a malformed touched message is ignored", true);
  }
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
  check("a pane respawned while listing is not stopped", r.result.reason === "respawned" && r.calls.stop.length === 0);
  r = await run((t) => {
    t.state.duringList = (s) => { s.evidence = { ...s.evidence, lastUserInputAt: NOW, lastComposerEditAt: NOW, lastSubmitAt: NOW }; };
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

  r = await run((t) => { t.state.evidence.scheduledWork = "a wake-up by 20:31"; });
  check(
    "a scheduled wake-up keeps the agent, and the log says what it waits for",
    r.result.reason === "scheduled-work" && r.result.detail === "a wake-up by 20:31" && r.calls.stop.length === 0,
    r.result,
  );

  // ── When a ScheduleWakeup fires ──
  {
    const at = scheduledWork.scheduledWakeAt;
    check("a delay in seconds", at({ delaySeconds: 600 }, NOW) === NOW + 600_000);
    check("a delay in minutes", at({ minutes: 5 }, NOW) === NOW + 300_000);
    check("a delay in milliseconds", at({ delayMs: 90_000 }, NOW) === NOW + 90_000);
    check("a time", at({ at: new Date(NOW + 20 * MIN).toISOString() }, NOW) === NOW + 20 * MIN);
    check("clamped as the runtime does: a minute at least", at({ delaySeconds: 10 }, NOW) === NOW + 60_000);
    check("and an hour at most", at({ delaySeconds: 99_999 }, NOW) === NOW + 3_600_000);
    check("nothing readable", at({ prompt: "go" }, NOW) === null && at(null, NOW) === null);

    // Every hold ends on its own.
    const MARGIN = scheduledWork.SCHEDULED_WAKE_MARGIN_MS;
    const T0 = new Date(2026, 10, 23, 10, 0).getTime();
    let s = new scheduledWork.ScheduledWork();
    const note = s.toolStarted("ScheduleWakeup", { prompt: "later" }, T0);
    check(
      "an unreadable wake-up time holds an hour and the margin, and says so",
      /until \d\d:\d\d at most/.test(note ?? "") && s.describe(T0 + 3_600_000 + MARGIN - 1) !== null && s.describe(T0 + 3_600_000 + MARGIN) === null,
      note,
    );
    s.toolStarted("ScheduleWakeup", { delaySeconds: 900 }, T0);
    s.toolStarted("ScheduleWakeup", { stop: true }, T0 + 1);
    check("ScheduleWakeup stop ends the loop: nothing held", s.describe(T0 + 2) === null);
    const cron = (input, response, now = T0) => {
      s.toolStarted("CronCreate", input, now);
      return s.toolFinished("CronCreate", input, response, false, now);
    };
    s = new scheduledWork.ScheduledWork();
    cron({ cron: "30 10 * * *", prompt: "once", recurring: false }, { id: "c1" });
    check(
      "a one-shot cron holds until it fires, plus the margin",
      s.describe(T0) === "a cron job" && s.describe(T0 + 30 * MIN + MARGIN - 1) === "a cron job" && s.describe(T0 + 30 * MIN + MARGIN) === null,
    );
    s = new scheduledWork.ScheduledWork();
    const unreadable = cron({ cron: "whenever", recurring: false }, { id: "c2" });
    check(
      "a one-shot cron with no readable time holds 24 h at most, and says so",
      /24 h/.test(unreadable ?? "") && s.describe(T0 + 23 * 60 * MIN) !== null && s.describe(T0 + 24 * 60 * MIN) === null,
      unreadable,
    );
    s = new scheduledWork.ScheduledWork();
    cron({ cron: "*/5 * * * *", prompt: "poll" }, { id: "c3" });
    check("a recurring cron holds a week at most", s.describe(T0 + 6 * 24 * 60 * MIN) !== null && s.describe(T0 + 7 * 24 * 60 * MIN) === null);
    s = new scheduledWork.ScheduledWork();
    s.toolStarted("CronCreate", { cron: "0 * * * *" }, T0);
    check("a cron waiting on its permission prompt counts", s.describe(T0) === "a cron job");
    s.turnEnded();
    check("and is dropped when the turn ends with no answer (denied or interrupted)", s.describe(T0) === null);
    s = new scheduledWork.ScheduledWork();
    cron({ cron: "0 * * * *" }, "Created cron job 7f3a12 (every hour)");
    s.toolFinished("CronDelete", { id: "7f3a12" }, null, false, T0);
    check("the id is read from the answer's text, not the word job", s.describe(T0) === null);
    cron({ cron: "0 * * * *" }, "Created.");
    s.toolFinished("CronDelete", { id: "zz99" }, null, false, T0);
    check("a delete of an id never learned clears the one cron held", s.describe(T0) === null);
    check("an answer's structured id wins", scheduledWork.cronId({ id: "abc", content: "job 123" }) === "abc");
    check("a keyword alone is no id", scheduledWork.cronId("Created cron job") === null);

    const fire = scheduledWork.nextCronFire;
    check("cron: later today", fire("30 14 * * *", T0) === new Date(2026, 10, 23, 14, 30).getTime());
    check("cron: tomorrow", fire("0 9 * * *", T0) === new Date(2026, 10, 24, 9, 0).getTime());
    check("cron: a step", fire("*/15 * * * *", T0) === new Date(2026, 10, 23, 10, 15).getTime());
    check("cron: next year", fire("0 9 1 1 *", T0) === new Date(2027, 0, 1, 9, 0).getTime());
    const monday = new Date(fire("0 9 * * 1", T0) ?? 0);
    check("cron: a weekday", monday.getDay() === 1 && monday.getHours() === 9 && monday.getTime() > T0);
    s = new scheduledWork.ScheduledWork();
    cron({ cron: "0 9 1 1 *", prompt: "once", recurring: false }, { id: "c9" });
    check(
      "a one-shot cron far away (or already past, so next year) holds a week at most",
      s.describe(T0 + 7 * 24 * 60 * MIN + MARGIN - 1) !== null && s.describe(T0 + 7 * 24 * 60 * MIN + MARGIN) === null,
    );
    check("cron: nonsense", fire("every day", T0) === null && fire("61 * * * *", T0) === null);
  }

  // ── Sleep now (manual) ──
  {
    const manual = (extra = {}) => request({ placement: "visible", manual: true, ...extra });
    const fresh = (t) => {
      t.state.session = { ...t.state.session, lastInputAt: NOW - 5_000, lastOutputAt: NOW - 1_000 };
      Object.assign(t.state.evidence, {
        lastUserInputAt: NOW - 5_000,
        lastComposerEditAt: NOW - 5_000,
        lastSubmitAt: NOW - 5_000,
        lastOutputAt: NOW - 1_000,
        structured: true,
        settledAt: NOW - 5_000,
      });
    };
    r = await run(fresh, manual());
    check("Sleep now skips the idle clock", r.result.ok === true && r.calls.stop.length === 1, r.result);
    r = await run(fresh);
    check("the timer still waits for the clock", r.result.ok === false && r.calls.stop.length === 0, r.result);
    r = await run((t) => { t.deps.policy = async () => ({ idleMs: 0, workspaceIdleMs: {}, tickMs: MIN, memoryLevel: "ok" }); }, manual());
    check("Sleep now works with hibernation off", r.result.ok === true, r.result);
    r = await run((t) => { t.deps.policy = async () => ({ idleMs: 30 * MIN, workspaceIdleMs: { w1: 0 }, tickMs: MIN, memoryLevel: "ok" }); t.deps.placement = () => ({ workspaceId: "w1" }); }, manual());
    check("Sleep now works in a workspace set to Never", r.result.ok === true, r.result);
    r = await run((t) => { t.state.evidence.state = "working"; t.state.evidence.chipState = "working"; t.state.evidence.turnActive = true; }, manual());
    check("Sleep now leaves a working agent running", r.result.reason === "agent-busy" && r.calls.stop.length === 0, r.result);
    r = await run((t) => { t.state.evidence.lastComposerEditAt = NOW - 1_000; }, manual());
    check("Sleep now leaves unsent text alone", r.result.reason === "unsent-input" && r.calls.stop.length === 0, r.result);
    r = await run((t) => { t.state.processes = [...t.state.processes, { pid: 103, parentPid: 100, startMs: NOW - 300 * MIN, command: "node vite" }]; }, manual());
    check("Sleep now refuses another program in the terminal", r.result.reason === "other-processes" && r.calls.stop.length === 0, r.result);
    r = await run((t) => { t.state.session = { ...t.state.session, remote: true }; }, manual());
    check("Sleep now refuses a remote pane", r.result.reason === "remote" && r.calls.stop.length === 0, r.result);
    // Known only from its screen: a working frame the patterns missed looks
    // like idle output, so output in the last seconds keeps it running.
    r = await run((t) => { fresh(t); Object.assign(t.state.evidence, { structured: false, settledAt: 0 }); }, manual());
    check(
      "Sleep now leaves a screen-only agent that printed a moment ago running",
      r.result.reason === "recent-output" && /^output 1s ago$/.test(r.result.detail ?? "") && r.calls.stop.length === 0,
      r.result,
    );
    r = await run((t) => {
      fresh(t);
      Object.assign(t.state.evidence, { structured: false, settledAt: 0, lastOutputAt: NOW - 10_000 });
      t.state.session = { ...t.state.session, lastOutputAt: NOW - 10_000 };
    }, manual());
    check("and puts it to sleep once it has been quiet a few seconds", r.result.ok === true, r.result);

    // A held census verdict is not reused: the dev server may have ended.
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    const lone = t.state.processes;
    t.state.processes = [...lone, { pid: 103, parentPid: 100, startMs: NOW - 300 * MIN, command: "node vite" }];
    await ah.hibernateAgentPane(request(), t.deps);
    t.state.processes = lone;
    const now = await ah.hibernateAgentPane(manual(), t.deps);
    check("Sleep now takes a fresh census", now.ok === true && t.calls.list === 2, { now, list: t.calls.list });

    // The timer's decision in flight: Sleep now waits for it.
    ah.resetAgentHibernationForTests();
    const w = makeDeps();
    let release;
    w.deps.listProcesses = () => new Promise((resolve) => { release = () => resolve(w.state.processes); });
    const timer = ah.hibernateAgentPane(request(), w.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pressed = ah.hibernateAgentPane(manual(), w.deps);
    release();
    const [timerResult, pressedResult] = await Promise.all([timer, pressed]);
    check(
      "Sleep now during the timer's decision answers with its sleep, one stop",
      timerResult.ok === true && pressedResult.ok === true && w.calls.stop.length === 1,
      { timerResult, pressedResult, stops: w.calls.stop.length },
    );

    // A timer request that starts while Sleep now reads the settings: Sleep
    // now still sees it and waits for it, one decision, one stop.
    ah.resetAgentHibernationForTests();
    const raced = makeDeps();
    const policyOf = raced.deps.policy;
    let policyCalls = 0;
    raced.deps.policy = async () => {
      policyCalls += 1;
      if (policyCalls === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return policyOf();
    };
    // The timer's census is still running when Sleep now's read returns.
    const listOf = raced.deps.listProcesses;
    raced.deps.listProcesses = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return listOf();
    };
    const byHand = ah.hibernateAgentPane(manual(), raced.deps);
    const byTimer = ah.hibernateAgentPane(request(), raced.deps);
    const [handResult, timerOutcome] = await Promise.all([byHand, byTimer]);
    check(
      "a timer request during Sleep now's settings read is waited for, not raced",
      handResult.ok === true && timerOutcome.ok === true && raced.calls.stop.length === 1,
      { handResult, timerOutcome, stops: raced.calls.stop.length },
    );

    const said = [];
    ah.resetAgentHibernationForTests();
    const logged = makeDeps({ log: (line) => said.push(line) });
    logged.state.evidence.lastComposerEditAt = NOW - 1_000;
    await ah.hibernateAgentPane(manual(), logged.deps);
    await ah.hibernateAgentPane(manual(), logged.deps);
    check("each refusal of Sleep now is logged", said.length === 2 && said[0] === "pane=pane-1 Sleep now refused: unsent-input", said);
    said.length = 0;
    logged.state.evidence.lastComposerEditAt = NOW - 90 * MIN;
    await ah.hibernateAgentPane(manual(), logged.deps);
    check("and a sleep by hand says so", /^pane=pane-1 claude is sleeping \(visible, Sleep now, census/.test(said[0] ?? ""), said);
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

  // ── The sleeping pane as main remembers it ──
  {
    ah.resetAgentHibernationForTests();
    const t = makeDeps();
    t.deps.sleepOutput = (paneId) =>
      paneId === "pane-1"
        ? { tail: Buffer.from("the whole screen\r\nthe end of the turn\r\n"), unsent: Buffer.from("the end of the turn\r\n") }
        : null;
    const result = await ah.hibernateAgentPane(request(), t.deps);
    H.live = new Set();
    H.placed = new Set(["pane-1"]);
    check("a stopped pane is asleep for delivery", result.ok === true && ah.agentPaneAsleep("pane-1") === true);
    const first = ah.takeSleepingPane("pane-1", false);
    check(
      "a view that kept its copy learns its runtime, when it slept and only the output it missed",
      first && first.runtime === "claude" && first.sleptAt === NOW && Buffer.from(first.output).toString() === "the end of the turn\r\n",
      first,
    );
    const second = ah.takeSleepingPane("pane-1", false);
    check("that missed output is handed over once", second && second.output === null && second.runtime === "claude", second);
    const fresh = ah.takeSleepingPane("pane-1", true);
    check(
      "an empty view (a reloaded window) gets the pane's newest output, as often as it comes back",
      Buffer.from(fresh?.output ?? []).toString() === "the whole screen\r\nthe end of the turn\r\n" &&
        Buffer.from(ah.takeSleepingPane("pane-1", true)?.output ?? []).toString().startsWith("the whole screen"),
      fresh,
    );
    // The stop's own exit keeps the mark; the woken session's exit ends it.
    H.exits.get("pane-1")?.({ exitCode: 0, signal: 1, sanctioned: true, hibernated: true });
    check("the stop's own exit leaves the pane asleep", ah.agentPaneAsleep("pane-1") === true);
    H.exits.get("pane-1")?.({ exitCode: 0 });
    check(
      "a woken pane whose shell later ends is not taken for a sleeping one",
      ah.agentPaneAsleep("pane-1") === false && !ah.sleepingAgentPanes().has("pane-1") && ah.takeSleepingPane("pane-1") === null,
    );
    H.placed = new Set();
    ah.resetAgentHibernationForTests();
    await ah.hibernateAgentPane(request(), makeDeps().deps);
    check("a closed sleeping pane is not asleep", ah.agentPaneAsleep("pane-1") === false && !H.exits.has("pane-1"));
    H.placed = new Set(["pane-1"]);
    H.live = new Set(["pane-1"]);
    ah.resetAgentHibernationForTests();
    await ah.hibernateAgentPane(request(), makeDeps().deps);
    check("a pane that runs again is awake", ah.agentPaneAsleep("pane-1") === false);
    check("an unknown pane is not asleep", ah.agentPaneAsleep("nope") === false && ah.takeSleepingPane("nope") === null);

    // A pane restored asleep at launch: the renderer tells main.
    ah.resetAgentHibernationForTests();
    H.live = new Set();
    H.placed = new Set();
    check("a restored sleeping pane is recorded", ah.registerRestoredAsleep({ paneId: "r1", runtime: "codex", sleptAt: 1234 }) === true);
    check(
      "it is asleep for delivery and the quit census before the renderer has placed it",
      ah.agentPaneAsleep("r1") === true && ah.sleepingAgentPanes().get("r1") === "codex",
    );
    const restored = ah.takeSleepingPane("r1", true);
    check(
      "a reloaded window finds it asleep since the time it fell asleep, with no output to replay",
      restored && restored.runtime === "codex" && restored.sleptAt === 1234 && restored.output === null,
      restored,
    );
    H.exits.get("r1")?.({ exitCode: 0 });
    check("its record ends when the session that woke it exits", ah.agentPaneAsleep("r1") === false);
    ah.registerRestoredAsleep({ paneId: "r2", runtime: "claude", sleptAt: 1 }, Date.now() - 121_000);
    check("a restored pane the renderer never placed is dropped after the grace time", ah.agentPaneAsleep("r2") === false);
    ah.registerRestoredAsleep({ paneId: "r3", runtime: "claude", sleptAt: 1 }, Date.now() - 121_000);
    H.placed = new Set(["r3"]);
    check("a placed one stays asleep past it", ah.agentPaneAsleep("r3") === true);
    H.live = new Set(["r4"]);
    check("a pane that already runs is not recorded", ah.registerRestoredAsleep({ paneId: "r4", runtime: "claude", sleptAt: 1 }) === false);
    check(
      "malformed records are refused",
      [null, "r5", {}, { paneId: "", runtime: "claude" }, { paneId: "r5", runtime: "aider" }, { paneId: "x".repeat(257), runtime: "claude" }].every(
        (input) => ah.registerRestoredAsleep(input) === false,
      ),
    );
    H.live = undefined;
    H.placed = undefined;
    ah.resetAgentHibernationForTests();
  }

  // ── Policy ──
  H.prefs = { agentHibernationMinutes: 60 };
  let policy = await ah.currentHibernationPolicy();
  check("the policy follows the setting", policy.idleMs === 60 * MIN && policy.tickMs === MIN, policy);
  H.prefs = { agentHibernationMinutes: 0 };
  policy = await ah.currentHibernationPolicy();
  check("Off gives a zero idle time", policy.idleMs === 0);
  H.prefs = { agentHibernationMinutes: 30 };
  // Memory pressure: the policy's idle time is the level's floor when that
  // is sooner than the setting.
  const GB = 1024 ** 3;
  ah.resetMemoryLevelForTests();
  H.memory = { totalBytes: 32 * GB, availableBytes: 16 * GB };
  policy = await ah.currentHibernationPolicy();
  check("plenty of memory keeps the setting's idle time", policy.idleMs === 30 * MIN && policy.memoryLevel === "ok", policy);
  ah.resetMemoryLevelForTests();
  H.memory = { totalBytes: 32 * GB, availableBytes: 3 * GB };
  policy = await ah.currentHibernationPolicy();
  check("low memory gives the 10 minute idle time", policy.idleMs === 10 * MIN && policy.memoryLevel === "low", policy);
  const readsBefore = H.memoryReads;
  H.memory = { totalBytes: 32 * GB, availableBytes: 16 * GB };
  policy = await ah.currentHibernationPolicy();
  check(
    "the level keeps between reads",
    policy.memoryLevel === "low" && H.memoryReads === readsBefore,
    { policy, reads: H.memoryReads },
  );
  ah.resetMemoryLevelForTests();
  H.memory = { totalBytes: 32 * GB, availableBytes: 1 * GB };
  policy = await ah.currentHibernationPolicy();
  check("critical memory gives the 3 minute idle time", policy.idleMs === 3 * MIN && policy.memoryLevel === "critical", policy);
  H.prefs = { agentHibernationMinutes: 30, agentHibernationSoonerWhenLow: false };
  ah.resetMemoryLevelForTests();
  const readsOff = H.memoryReads;
  policy = await ah.currentHibernationPolicy();
  check(
    "with the preference off the setting's idle time holds and memory is not read",
    policy.idleMs === 30 * MIN && policy.memoryLevel === "ok" && H.memoryReads === readsOff,
    policy,
  );
  H.prefs = { agentHibernationMinutes: 0 };
  policy = await ah.currentHibernationPolicy();
  check("pressure never turns hibernation on", policy.idleMs === 0 && H.memoryReads === readsOff, policy);
  H.prefs = { agentHibernationMinutes: 30 };
  ah.resetMemoryLevelForTests();
  H.memory = null;
  policy = await ah.currentHibernationPolicy();
  check("an unreadable memory reading is no pressure", policy.idleMs === 30 * MIN && policy.memoryLevel === "ok", policy);
  // Per-workspace times.
  ah.resetMemoryLevelForTests();
  H.memory = { totalBytes: 32 * GB, availableBytes: 16 * GB };
  H.prefs = { agentHibernationMinutes: 30, agentHibernationWorkspaces: { a: 0, b: 45, c: "x" } };
  policy = await ah.currentHibernationPolicy();
  check(
    "the policy carries each workspace's own idle time",
    policy.idleMs === 30 * MIN && JSON.stringify(policy.workspaceIdleMs) === JSON.stringify({ a: 0, b: 45 * MIN }),
    policy,
  );
  H.prefs = { agentHibernationMinutes: 0, agentHibernationWorkspaces: { b: 45 } };
  policy = await ah.currentHibernationPolicy();
  check(
    "with the default Off a workspace's own time still stands",
    policy.idleMs === 0 && policy.workspaceIdleMs.b === 45 * MIN,
    policy,
  );
  H.prefs = { agentHibernationMinutes: 0, agentHibernationWorkspaces: { a: 0 } };
  const readsNever = H.memoryReads;
  policy = await ah.currentHibernationPolicy();
  check(
    "Off everywhere reads no memory",
    policy.idleMs === 0 && policy.workspaceIdleMs.a === 0 && H.memoryReads === readsNever,
    policy,
  );
  ah.resetMemoryLevelForTests();
  H.memory = { totalBytes: 32 * GB, availableBytes: 3 * GB };
  H.prefs = { agentHibernationMinutes: 30, agentHibernationWorkspaces: { a: 0, b: 45, quick: 5 } };
  policy = await ah.currentHibernationPolicy();
  check(
    "pressure shortens a workspace's time too, and leaves Never and shorter times alone",
    policy.workspaceIdleMs.a === 0 && policy.workspaceIdleMs.b === 10 * MIN && policy.workspaceIdleMs.quick === 5 * MIN,
    policy,
  );
  H.prefs = { agentHibernationMinutes: 30 };
  ah.resetMemoryLevelForTests();
  H.memory = null;
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
      { paneId: "n3", tabId: "t", tabTitle: "T", excluded: false, runtimeHint: "claude" },
      { paneId: "n4", tabId: "t", tabTitle: "T", excluded: false, runtimeHint: "claude" },
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
  notify.syncTerminalNotifyPanes({
    workspaceId: "ws-agy",
    workspaceName: "A",
    panes: [{ paneId: "na", tabId: "ta", tabTitle: "T", excluded: false, runtimeHint: "antigravity" }],
  });
  check(
    "an Antigravity pane's evidence names its agent, so main can judge it",
    notify.terminalAgentHibernationEvidence("na")?.runtime === "antigravity",
    notify.terminalAgentHibernationEvidence("na"),
  );
  check("an excluded pane says so", notify.terminalAgentHibernationEvidence("nx")?.excluded === true);
  notify.noteTerminalUserInput("n1", "hel");
  ev = notify.terminalAgentHibernationEvidence("n1");
  check("keys without Enter leave unsent text", ev.lastComposerEditAt > ev.lastSubmitAt, ev);
  notify.noteTerminalUserInput("n1", "lo\r");
  ev = notify.terminalAgentHibernationEvidence("n1");
  check("Enter sends it", ev.lastComposerEditAt === ev.lastSubmitAt && ev.lastSubmitAt > 0, ev);
  for (const [name, keys] of [
    ["a lone Esc", "\x1b"],
    ["Ctrl+C", "\x03"],
    ["Backspace", "\x7f"],
    ["Delete", "\x1b[3~"],
    ["Left and Right", "\x1b[D\x1b[C"],
    ["Home and End", "\x1b[H\x1bOF"],
    ["Page Up and Page Down", "\x1b[5~\x1b[6~"],
    ["Shift+Left", "\x1b[1;2D"],
  ]) {
    const before = notify.terminalAgentHibernationEvidence("n1");
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n1", keys);
    const after = notify.terminalAgentHibernationEvidence("n1");
    check(
      `${name} after the submit counts as input but leaves no unsent text`,
      after.lastUserInputAt > before.lastUserInputAt && after.lastComposerEditAt === before.lastComposerEditAt,
      { before: before.lastComposerEditAt, after: after.lastComposerEditAt },
    );
  }
  {
    const before = notify.terminalAgentHibernationEvidence("n1");
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n1", "\x1b[A");
    const after = notify.terminalAgentHibernationEvidence("n1");
    check("Up recalls an earlier prompt, so it can leave text", after.lastComposerEditAt > before.lastComposerEditAt, after);
    notify.noteTerminalUserInput("n1", "\r");
  }
  ev = notify.terminalAgentHibernationEvidence("n1");
  notify.noteTerminalUserInput("n1", "\x1b[I");
  check("a focus report is not typing", notify.terminalAgentHibernationEvidence("n1").lastUserInputAt === ev.lastUserInputAt);
  for (const [name, keys] of [
    ["Shift+Tab (permission mode)", "\x1b[Z"],
    ["Ctrl+O (transcript)", "\x0f"],
    ["Ctrl+T (task list)", "\x14"],
    ["Ctrl+L (redraw)", "\x0c"],
  ]) {
    const before = notify.terminalAgentHibernationEvidence("n1");
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n1", keys);
    const after = notify.terminalAgentHibernationEvidence("n1");
    check(`${name} puts no text in the box`, after.lastComposerEditAt === before.lastComposerEditAt, after);
  }
  // The unsent-text rule, as judgeAgentEvidence reads it (the policy test
  // covers the judge itself).
  const unsent = (e) => e.lastComposerEditAt > Math.max(e.lastSubmitAt, e.lastComposerClearAt ?? 0);
  // A Claude at its prompt with no turn open: the only state where Ctrl+C
  // empties the box.
  notify.noteTerminalHookEvent("n3", "SessionStart", { session_id: "s-3", source: "startup" });
  {
    notify.noteTerminalUserInput("n3", "half a thought");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const typed = notify.terminalAgentHibernationEvidence("n3");
    check("typed text is unsent", unsent(typed), typed);
    notify.noteTerminalUserInput("n3", "\x03");
    const cleared = notify.terminalAgentHibernationEvidence("n3");
    check("Ctrl+C at Claude's idle prompt empties its box: nothing is unsent", !unsent(cleared), cleared);
    check(
      "but the submit stamp other features guard drafts with stays raw",
      cleared.lastSubmitAt === typed.lastSubmitAt && cleared.lastComposerClearAt > cleared.lastSubmitAt,
      cleared,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n3", "more");
    const again = notify.terminalAgentHibernationEvidence("n3");
    check("text typed after the Ctrl+C is unsent again", unsent(again), again);
    notify.noteTerminalUserInput("n3", "abc\x03");
    const mixed = notify.terminalAgentHibernationEvidence("n3");
    check("a Ctrl+C sent together with text is not taken as a clear", unsent(mixed), mixed);
    notify.noteTerminalUserInput("n3", "\x03");
  }
  {
    // A settled Claude with hooks: a hook moves the settle moment, its
    // status line repainting does not.
    ev = notify.terminalAgentHibernationEvidence("n2");
    check("no hook yet: screen-only evidence", ev.structured === false, ev);
    notify.noteTerminalHookEvent("n2", "SessionStart", { session_id: "s-1" });
    ev = notify.terminalAgentHibernationEvidence("n2");
    check("a hook makes the evidence structured", ev.structured === true && ev.settledAt > 0, ev);
    const settled = ev.settledAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    H.taps.get("n2")?.(Buffer.from("\x1b7\x1b[40;1H\x1b[2K  Opus 4.7 | ctx 41% | 18:02:11\x1b8"));
    ev = notify.terminalAgentHibernationEvidence("n2");
    check(
      "a status line repaint is output but leaves the settle moment",
      ev.settledAt === settled && ev.lastOutputAt > settled && ev.state === "idle",
      ev,
    );
    notify.noteTerminalHookEvent("n2", "UserPromptSubmit", { session_id: "s-1", prompt: "go" });
    ev = notify.terminalAgentHibernationEvidence("n2");
    check("a turn starting moves it", ev.settledAt > settled && ev.turnActive === true, ev);

    // Ctrl+C during a turn interrupts; a draft typed meanwhile can survive it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n2", "next idea");
    notify.noteTerminalUserInput("n2", "\x03");
    ev = notify.terminalAgentHibernationEvidence("n2");
    check("Ctrl+C during a turn clears nothing", ev.lastComposerClearAt < ev.lastComposerEditAt, ev);
    // In a permission dialog it dismisses the dialog, not the draft.
    notify.noteTerminalHookEvent("n2", "PreToolUse", { session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" } });
    notify.noteTerminalHookEvent("n2", "Notification", { session_id: "s-1", notification_type: "permission_prompt", message: "ok?" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const asked = notify.terminalAgentHibernationEvidence("n2");
    notify.noteTerminalUserInput("n2", "2");
    ev = notify.terminalAgentHibernationEvidence("n2");
    check(
      "a key that answers a dialog is input, not text in the box",
      asked.state === "blocked" && ev.lastUserInputAt > asked.lastUserInputAt && ev.lastComposerEditAt === asked.lastComposerEditAt,
      { asked, ev },
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n2", "\x03");
    ev = notify.terminalAgentHibernationEvidence("n2");
    check("Ctrl+C in a permission dialog clears nothing", ev.lastComposerClearAt < ev.lastComposerEditAt, ev);
    notify.noteTerminalHookEvent("n2", "PostToolUse", { session_id: "s-1", tool_name: "Bash" });
    notify.noteTerminalHookEvent("n2", "Stop", { session_id: "s-1" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const answered = notify.terminalAgentHibernationEvidence("n2");
    notify.noteTerminalUserInput("n2", "then this");
    ev = notify.terminalAgentHibernationEvidence("n2");
    check(
      "once the dialog is gone, typing is text in the box again",
      answered.state !== "blocked" && ev.lastComposerEditAt > answered.lastComposerEditAt,
      { answered, ev },
    );
  }
  {
    // Work scheduled for later: a /loop's ScheduleWakeup and cron jobs leave
    // no process and no background task, yet the agent must stay up for them.
    const hook = (name, extra) => notify.noteTerminalHookEvent("n3", name, { session_id: "s-3", ...extra });
    const tool = (tool_name, tool_input, tool_response) => {
      hook("PreToolUse", { tool_name, tool_input });
      hook("PostToolUse", { tool_name, tool_input, tool_response });
    };
    const scheduled = () => notify.terminalAgentHibernationEvidence("n3").scheduledWork;
    const judged = () => shared.judgeAgentEvidence({ ...notify.terminalAgentHibernationEvidence("n3"), chipState: "idle" }, "claude");
    check("nothing scheduled at first", scheduled() === null && judged() !== "scheduled-work", scheduled());
    tool("ScheduleWakeup", { delaySeconds: 1800, prompt: "check CI", reason: "waiting on CI" });
    const first = scheduled();
    check("a wake-up in 30 minutes keeps the pane awake, named by its clock time", /^a wake-up by \d\d:\d\d$/.test(first ?? "") && judged() === "scheduled-work", first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    check("the words stay the same from tick to tick (one log line, not one a minute)", scheduled() === first, scheduled());
    tool("ScheduleWakeup", { stop: true, reason: "done" });
    check("ScheduleWakeup stop ends the loop", scheduled() === null, scheduled());
    tool("ScheduleWakeup", { delaySeconds: 600 });
    hook("SessionEnd", {});
    check("the session's end ends it", scheduled() === null, scheduled());
    tool("ScheduleWakeup", { prompt: "later" });
    check("a wake-up whose time cannot be read keeps it awake, for a bounded time", /^a wake-up by \d\d:\d\d$/.test(scheduled() ?? ""), scheduled());
    hook("SessionStart", { source: "startup" });
    tool("CronCreate", { cron: "*/30 * * * *", prompt: "poll" }, { id: "cron-7a" });
    check("a cron job keeps it awake", scheduled() === "a cron job" && judged() === "scheduled-work", scheduled());
    hook("SessionStart", { source: "clear" });
    check("/clear keeps it (the same process may keep its crons)", scheduled() === "a cron job", scheduled());
    tool("CronDelete", { id: "cron-7a" });
    check("until it is deleted", scheduled() === null, scheduled());
    hook("PreToolUse", { tool_name: "CronCreate", tool_input: { cron: "0 * * * *" } });
    hook("PostToolUseFailure", { tool_name: "CronCreate", tool_input: { cron: "0 * * * *" } });
    check("a cron that failed to be created keeps nothing", scheduled() === null, scheduled());
    hook("PreToolUse", { tool_name: "CronCreate", tool_input: { cron: "0 * * * *" } });
    hook("Stop", {});
    check("a cron denied at its prompt (no Post hook) is dropped at the turn's end", scheduled() === null, scheduled());
    tool("CronCreate", { cron: "0 * * * *" }, { id: "cron-8b" });
    tool("ScheduleWakeup", { delaySeconds: 600 });
    hook("SessionStart", { source: "resume" });
    check("a resume of the same session keeps its cron (the runtime restores it) and drops the wake-up", scheduled() === "a cron job", scheduled());
    notify.noteTerminalHookEvent("n3", "SessionStart", { session_id: "s-other", source: "resume" });
    check("a resume of another session starts with nothing scheduled", scheduled() === null, scheduled());
    // Back to this block's session for the checks below.
    hook("SessionStart", { source: "startup" });
  }
  {
    // A startup dialog no hook announces (an MCP server approval): kept
    // awake until the user answers it.
    notify.noteTerminalHookEvent("n4", "SessionStart", { session_id: "s-4", source: "startup" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n4", "draft");
    await new Promise((resolve) => setTimeout(resolve, 2));
    H.taps.get("n4")?.(Buffer.from("\r\n New MCP server found in .mcp.json: tools\r\n ❯ 1. Use this and all future MCP servers in this project\r\n"));
    let e = notify.terminalAgentHibernationEvidence("n4");
    check(
      "a dialog on screen with no tool call waiting keeps the pane awake",
      e.screenDialog === true && shared.judgeAgentEvidence({ ...e, chipState: "idle" }, "claude") === "waiting-on-user",
      e,
    );
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 10 * MIN;
      check("held 10 minutes at most: sleeping it loses nothing, the dialog comes back on --resume", notify.terminalAgentHibernationEvidence("n4").screenDialog === false);
    } finally {
      Date.now = realNow;
    }
    notify.noteTerminalUserInput("n4", "\x03");
    e = notify.terminalAgentHibernationEvidence("n4");
    check("Ctrl+C there dismisses the dialog, not the draft", e.lastComposerClearAt < e.lastComposerEditAt && e.screenDialog === false, e);

    // Answered: the prompt and its footer come up, and the window closes.
    H.taps.get("n4")?.(Buffer.from("\r\n> \r\n  ? for shortcuts\r\n"));
    notify.noteTerminalUserInput("n4", "1. plan the release");
    H.taps.get("n4")?.(Buffer.from("\r\n ❯ 1. plan the release\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    notify.noteTerminalUserInput("n4", "\x03");
    e = notify.terminalAgentHibernationEvidence("n4");
    check("a draft that starts \"1. \" after the caret is no dialog, and Ctrl+C clears it", e.screenDialog === false && e.lastComposerClearAt >= e.lastComposerEditAt, e);

    // A resumed session prints its transcript: phrases that look like a
    // dialog are text, and the pane can sleep.
    notify.noteTerminalHookEvent("n4", "SessionStart", { session_id: "s-4", source: "resume" });
    H.taps.get("n4")?.(
      Buffer.from(
        "\r\n> Allow shallow clones in the script to run faster\r\n Press Enter to wake it\r\n Do you want to proceed with the migration?\r\n ❯ 1. Keep the old table\r\n",
      ),
    );
    e = notify.terminalAgentHibernationEvidence("n4");
    check(
      "a resumed transcript with dialog-like text keeps nothing awake",
      e.screenDialog === false && shared.judgeAgentEvidence({ ...e, chipState: "idle" }, "claude") !== "waiting-on-user",
      e,
    );
    // A startup whose window passed: the same text is transcript too.
    notify.noteTerminalHookEvent("n4", "SessionStart", { session_id: "s-5", source: "startup" });
    try {
      Date.now = () => realNow() + 3 * MIN;
      H.taps.get("n4")?.(Buffer.from("\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n"));
      e = notify.terminalAgentHibernationEvidence("n4");
    } finally {
      Date.now = realNow;
    }
    check("after the startup window a dialog-like screen holds nothing", e.screenDialog === false, e);
  }
  {
    // A background subagent runs inside the agent's own process: only the
    // hook's task list shows it, and it keeps the pane awake.
    notify.noteTerminalHookEvent("n3", "Stop", {
      session_id: "s-3",
      background_tasks: [{ id: "a1", type: "local_agent", status: "running", description: "review" }],
    });
    const e = notify.terminalAgentHibernationEvidence("n3");
    check(
      "a background subagent keeps the pane awake",
      e.backgroundRunning > 0 && shared.judgeAgentEvidence({ ...e, chipState: "idle" }, "claude") === "agent-busy",
      e,
    );
  }

  // ── The log: one line per change of verdict ──
  {
    ah.resetAgentHibernationForTests();
    const lines = [];
    const t = makeDeps({ log: (line) => lines.push(line) });
    t.state.session = { ...t.state.session, lastOutputAt: NOW - 5 * MIN };
    await ah.hibernateAgentPane(request(), t.deps);
    t.state.session = { ...t.state.session, lastOutputAt: NOW - 6 * MIN };
    const again = await ah.hibernateAgentPane(request(), t.deps);
    check(
      "a refusal repeated on the next tick is logged once, with the stamp that held it",
      lines.length === 1 && lines[0] === "pane=pane-1 stays awake: not-idle-long-enough (pty output 300s ago, needs 1800s)",
      lines,
    );
    check("the caller still gets the fresh detail", again.detail === "pty output 360s ago, needs 1800s", again);

    t.state.session = { ...t.state.session, lastOutputAt: NOW - 60 * MIN };
    t.state.processes = [...t.state.processes, { pid: 103, parentPid: 101, startMs: NOW - 10 * MIN, command: "node /srv/app/dev.js --token=secret" }];
    await ah.hibernateAgentPane(request(), t.deps);
    await ah.hibernateAgentPane(request(), t.deps);
    check(
      "a change of verdict is logged, once, without the process's arguments",
      lines.length === 2 && /^pane=pane-1 stays awake: other-processes \(/.test(lines[1]) && !lines[1].includes("secret"),
      lines,
    );

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const failing = makeDeps({ log: (line) => lines.push(line) });
    failing.state.stopResult = false;
    await ah.hibernateAgentPane(request(), failing.deps);
    await ah.hibernateAgentPane(request(), failing.deps);
    check(
      "a failed stop is logged every time",
      lines.length === 2 && lines.every((line) => line === "pane=pane-1 stays awake: stop-failed"),
      lines,
    );

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const sleeps = makeDeps({ log: (line) => lines.push(line) });
    await ah.hibernateAgentPane(request(), sleeps.deps);
    check(
      "a sleep says how long the pane was idle and what the census cost",
      lines.length === 1 && lines[0] === "pane=pane-1 claude is sleeping (background-workspace, idle 1800s, census 3 processes in 0ms, freed unknown, card none)",
      lines,
    );

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const pressed = makeDeps({
      log: (line) => lines.push(line),
      policy: async () => ({ idleMs: 10 * MIN, workspaceIdleMs: {}, tickMs: MIN, memoryLevel: "low" }),
    });
    await ah.hibernateAgentPane(request(), pressed.deps);
    check(
      "a sleep under memory pressure names the level",
      lines.length === 1 &&
        lines[0] === "pane=pane-1 claude is sleeping (background-workspace, idle 600s, memory low, census 3 processes in 0ms, freed unknown, card none)",
      lines,
    );

    // A pane kept awake for the same reason is said again once an hour.
    ah.resetAgentHibernationForTests();
    lines.length = 0;
    let clock = NOW;
    const held = makeDeps({ log: (line) => lines.push(line), now: () => clock });
    held.state.evidence.state = "working";
    held.state.evidence.chipState = "working";
    for (let minute = 0; minute <= 125; minute += 1) {
      clock = NOW + minute * MIN;
      await ah.hibernateAgentPane(request(), held.deps);
    }
    check(
      "the same refusal is logged again each hour, with how long it has held",
      lines.length === 3 &&
        lines[0] === "pane=pane-1 stays awake: agent-busy" &&
        lines[1] === "pane=pane-1 stays awake: agent-busy (still, for 60 min)" &&
        lines[2] === "pane=pane-1 stays awake: agent-busy (still, for 120 min)",
      lines,
    );

    // POSIX listings carry no memory: the sleep reads the tree's own.
    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const asked = [];
    const measured = makeDeps({
      log: (line) => lines.push(line),
      treeMemory: async (pids) => {
        asked.push(pids);
        return 412 * 1024 * 1024;
      },
    });
    const freed = await ah.hibernateAgentPane(request(), measured.deps);
    check(
      "the memory of the pane's shell, agent and MCP servers is read before the stop",
      freed.ok === true && freed.freedBytes === 412 * 1024 * 1024 && JSON.stringify(asked) === "[[100,101,102]]",
      { freed, asked },
    );
    check("and logged", /freed 412 MB, card none\)$/.test(lines[0] ?? ""), lines);
    ah.resetAgentHibernationForTests();
    const noFigure = makeDeps({ treeMemory: async () => null });
    const unknown = await ah.hibernateAgentPane(request(), noFigure.deps);
    check("an unreadable tree still sleeps, its figure unknown", unknown.ok === true && unknown.freedBytes === null, unknown);

    // A prompt sent while the memory is read keeps the agent: the re-check
    // comes after the read.
    ah.resetAgentHibernationForTests();
    const sent = makeDeps({
      treeMemory: async () => {
        Object.assign(sent.state.evidence, { state: "working", chipState: "working", turnActive: true, lastSubmitAt: NOW });
        return 300 * 1024 * 1024;
      },
    });
    const kept = await ah.hibernateAgentPane(request(), sent.deps);
    check("a prompt sent during the memory read keeps the pane awake", kept.ok === false && sent.calls.stop.length === 0, kept);

    // Nothing is awaited between the last look at the pane and the stop: a
    // microtask queued at that look has not run when the stop is called.
    ah.resetAgentHibernationForTests();
    let yielded = false;
    let yieldedAtStop = null;
    const fenced = makeDeps({ treeMemory: async () => 300 * 1024 * 1024 });
    const look = fenced.deps.evidence;
    fenced.deps.evidence = (...args) => {
      yielded = false;
      queueMicrotask(() => { yielded = true; });
      return look(...args);
    };
    const stopAfter = fenced.deps.stop;
    fenced.deps.stop = async (...args) => {
      yieldedAtStop = yielded;
      return stopAfter(...args);
    };
    const fencedResult = await ah.hibernateAgentPane(request(), fenced.deps);
    check("the re-check and the stop run in one tick", fencedResult.ok === true && yieldedAtStop === false, { fencedResult, yieldedAtStop });

    // The card's line: asked for before the stop, handed back with the sleep
    // and kept for a pane that mounts later. Only its source is logged.
    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const order = [];
    const summary = { title: "Fix the zebra parser", detail: "now add the tests", source: "ai-title" };
    const told = makeDeps({
      log: (line) => lines.push(line),
      describe: async (_paneId, _runtime, probed) => {
        order.push(`describe:${probed}`);
        return summary;
      },
      stop: async () => {
        order.push("stop");
        return true;
      },
    });
    H.live = new Set();
    H.placed = new Set(["pane-1"]);
    let slept = await ah.hibernateAgentPane(request({ transcriptPath: "/t/s.jsonl" }), told.deps);
    check(
      "a sleep comes back with the card's line, read before the stop",
      slept.ok === true && JSON.stringify(slept.summary) === JSON.stringify(summary) && order.join(",") === "describe:/t/s.jsonl,stop",
      { slept, order },
    );
    check(
      "the log names where the line came from, never the line",
      lines.length === 1 && lines[0].endsWith(", card ai-title)") && !lines[0].includes("zebra"),
      lines,
    );
    check("a listing without a memory column frees an unknown amount", slept.ok === true && slept.freedBytes === null, slept);
    const mounted = ah.takeSleepingPane("pane-1", true);
    check("a pane mounting asleep gets the same line", JSON.stringify(mounted?.summary) === JSON.stringify(summary), mounted);

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const weighed = makeDeps({ log: (line) => lines.push(line) });
    weighed.state.processes = weighed.state.processes.map((p) => ({ ...p, memoryBytes: 100 * 1024 * 1024 }));
    slept = await ah.hibernateAgentPane(request(), weighed.deps);
    check(
      "a sleep says how much memory the pane's processes held",
      slept.ok === true && slept.freedBytes === 300 * 1024 * 1024 && lines[0]?.includes(", freed 300 MB, "),
      { slept, lines },
    );
    check("and a pane mounting later is told the same", ah.takeSleepingPane("pane-1", true)?.freedBytes === 300 * 1024 * 1024);

    // The session pointer: kept as handed over, for a reloaded pane that has none.
    ah.resetAgentHibernationForTests();
    const pointer = { runtime: "claude", sessionId: "abc", cwd: "/w", capturedAt: "2026-01-01T00:00:00.000Z", active: true };
    const keeps = makeDeps();
    await ah.hibernateAgentPane(request({ session: pointer }), keeps.deps);
    check(
      "main hands a mounting pane the session pointer it fell asleep with",
      JSON.stringify(ah.takeSleepingPane("pane-1", true)?.session) === JSON.stringify(pointer),
    );
    for (const [name, bad] of [
      ["an array", [1]],
      ["a string", "x"],
      ["an oversized object", { blob: "x".repeat(40_000) }],
    ]) {
      ah.resetAgentHibernationForTests();
      const drops = makeDeps();
      const answer = await ah.hibernateAgentPane(request({ session: bad }), drops.deps);
      check(
        `${name} is not kept as a pointer, and the pane still sleeps`,
        answer.ok === true && ah.takeSleepingPane("pane-1", true)?.session === null,
        answer,
      );
    }

    ah.resetAgentHibernationForTests();
    const unreadable = makeDeps({
      describe: async () => {
        throw new Error("unreadable");
      },
    });
    slept = await ah.hibernateAgentPane(request(), unreadable.deps);
    check("a line that cannot be read never stops the sleep", slept.ok === true && slept.summary === null, slept);

    ah.resetAgentHibernationForTests();
    const refused = makeDeps({ describe: async () => summary, stopResult: undefined });
    refused.state.stopResult = false;
    slept = await ah.hibernateAgentPane(request(), refused.deps);
    check("a failed stop hands back no line", slept.ok === false && slept.reason === "stop-failed", slept);

    ah.resetAgentHibernationForTests();
    check(
      "a pane restored asleep keeps its line, cut to the card's limits",
      ah.registerRestoredAsleep({
        paneId: "pane-r",
        runtime: "claude",
        sleptAt: NOW - MIN,
        summary: { title: `  ${"t".repeat(300)}`, detail: "x", source: "prompt" },
      }) === true &&
        ah.takeSleepingPane("pane-r", true)?.summary?.title.length === 120,
    );
    ah.resetAgentHibernationForTests();
    check(
      "a malformed line on a restored pane is dropped, the pane still sleeps",
      ah.registerRestoredAsleep({ paneId: "pane-r", runtime: "claude", sleptAt: NOW - MIN, summary: { title: 5, source: "x" } }) === true &&
        ah.takeSleepingPane("pane-r", true)?.summary === null,
    );
    H.live = undefined;
    H.placed = undefined;

    // A workspace with its own time, or set to Never.
    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const inWorkspace = (workspaceId, workspaceIdleMs, idleMs = 30 * MIN) =>
      makeDeps({
        log: (line) => lines.push(line),
        placement: () => ({ workspaceId }),
        policy: async () => ({ idleMs, workspaceIdleMs, tickMs: MIN, memoryLevel: "ok" }),
      });
    const never = inWorkspace("ws-never", { "ws-never": 0 });
    let verdict = await ah.hibernateAgentPane(request(), never.deps);
    check(
      "a workspace set to Never keeps its agents awake without a process listing",
      verdict.ok === false && verdict.reason === "exempt" && never.calls.list === 0 && never.calls.stop.length === 0,
      verdict,
    );
    await ah.hibernateAgentPane(request(), never.deps);
    check(
      "and says so once",
      lines.length === 1 && lines[0] === "pane=pane-1 stays awake: exempt (workspace ws-never never sleeps)",
      lines,
    );

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    // The pane was idle for 60 minutes: under its workspace's 2 hours it
    // stays awake, though the default 30 minutes have long passed.
    const slower = inWorkspace("ws-slow", { "ws-slow": 120 * MIN });
    verdict = await ah.hibernateAgentPane(request(), slower.deps);
    check(
      "a workspace's longer time holds a pane the default would let sleep",
      verdict.ok === false && verdict.reason === "not-idle-long-enough" && /needs 7200s/.test(verdict.detail ?? ""),
      verdict,
    );

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const own = inWorkspace("ws-own", { "ws-own": 45 * MIN }, 0);
    verdict = await ah.hibernateAgentPane(request(), own.deps);
    check(
      "a workspace with its own time sleeps while the default is Off",
      verdict.ok === true && own.calls.stop.length === 1 && /idle 2700s/.test(lines[0] ?? ""),
      { verdict, lines },
    );
    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const elsewhere = inWorkspace("ws-other", { "ws-own": 45 * MIN }, 0);
    verdict = await ah.hibernateAgentPane(request(), elsewhere.deps);
    check(
      "while the others stay off, silently",
      verdict.ok === false && verdict.reason === "off" && lines.length === 0,
      { verdict, lines },
    );

    ah.resetAgentHibernationForTests();
    lines.length = 0;
    const off = makeDeps({ log: (line) => lines.push(line), policy: async () => ({ idleMs: 0, workspaceIdleMs: {}, tickMs: MIN, memoryLevel: "ok" }) });
    await ah.hibernateAgentPane(request(), off.deps);
    check("nothing is logged while the setting is off", lines.length === 0, lines);
  }

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
