// Agent hibernation policy: the pure rules that decide which idle agent
// terminals may sleep, and how a sleeping pane survives persist, hydration
// and the quit snapshot.
//
//   - src/shared/agent-hibernation.ts: setting presets, the notifier
//     evidence verdict, the idle clock;
//   - src/renderer/src/lib/agentHibernation.ts: candidate panes in a
//     background layout, hidden-since bookkeeping, the sleeping census;
//   - src/renderer/src/tabs/useTabs.ts: persist strips the runtime-only mark,
//     hydration drops it, the quit snapshot counts a sleeping pane as running.
//
//   node scripts/test-agent-hibernation-policy.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

const harnessPlugin = {
  name: "agent-hibernation-policy-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
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

async function bundle(dir, entry, name) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

const session = (extra = {}) => ({
  runtime: "claude",
  sessionId: "11111111-2222-3333-4444-555555555555",
  cwd: "/tmp/proj",
  capturedAt: "2026-10-15T00:00:00.000Z",
  active: true,
  ...extra,
});
const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, cwd: "/tmp/proj", ...extra });
const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
const terminalTab = (id, root, extra = {}) => ({ id, kind: "terminal", title: id, root, activePaneId: null, ...extra });

const idleEvidence = (extra = {}) => ({
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
  lastUserInputAt: 1_000,
  lastSubmitAt: 1_000,
  lastOutputAt: 2_000,
  ...extra,
});

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hibernation-policy-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = await bundle(dir, path.join(SHARED_DIR, "agent-hibernation.ts"), "shared");
  const lib = await bundle(dir, path.join(ROOT, "src", "renderer", "src", "lib", "agentHibernation.ts"), "lib");
  const tabs = await bundle(dir, path.join(ROOT, "src", "renderer", "src", "tabs", "useTabs.ts"), "useTabs");
  const types = await bundle(dir, path.join(SHARED_DIR, "types.ts"), "types");

  let failures = 0;
  const check = (name, cond, detail) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
  };

  // ── Setting ──
  const { normalizeAgentHibernationMinutes: norm, DEFAULT_AGENT_HIBERNATION_MINUTES } = shared;
  check("presets are Off, 15, 30, 60, 120", JSON.stringify(shared.AGENT_HIBERNATION_MINUTE_PRESETS) === "[0,15,30,60,120]");
  check("default is 30 minutes", DEFAULT_AGENT_HIBERNATION_MINUTES === 30 && norm(undefined) === 30);
  check("app preferences default matches", types.DEFAULT_PREFERENCES.agentHibernationMinutes === DEFAULT_AGENT_HIBERNATION_MINUTES);
  check("Off survives", norm(0) === 0);
  check("each preset survives", [15, 30, 60, 120].every((m) => norm(m) === m));
  check("anything else falls back to the default", [7, -1, "30", null, NaN, 1e9].every((m) => norm(m) === 30));

  // ── Notifier evidence ──
  const judge = shared.judgeAgentEvidence;
  check("an idle agent with nothing pending may sleep", judge(idleEvidence(), "claude") === null);
  check("a finished turn (chip done) may sleep", judge(idleEvidence({ chipState: "done" }), "claude") === null);
  check("no watcher: stays awake", judge(null, "claude") === "not-watched");
  check("excluded (Cora worker) pane: stays awake", judge(idleEvidence({ excluded: true }), "claude") === "not-watched");
  check("pane being closed: stays awake", judge(idleEvidence({ disposing: true }), "claude") === "not-watched");
  check("agent already left the pane: stays awake", judge(idleEvidence({ runtime: null }), "claude") === "runtime-mismatch");
  check("another agent than the session's: stays awake", judge(idleEvidence({ runtime: "codex" }), "claude") === "runtime-mismatch");
  check("a working agent stays awake", judge(idleEvidence({ state: "working", chipState: "working" }), "claude") === "agent-busy");
  check("an agent waiting for an answer stays awake", judge(idleEvidence({ state: "blocked", chipState: "blocked" }), "claude") === "waiting-on-user");
  check("a blocked chip alone keeps it awake", judge(idleEvidence({ chipState: "blocked" }), "claude") === "waiting-on-user");
  check(
    "an agent that started and never ran a turn is quiet too (a resumed session nobody typed into)",
    judge(idleEvidence({ chipState: "launching" }), "claude") === null,
  );
  check("an agent still booting is busy", judge(idleEvidence({ chipState: "launching", state: "working" }), "claude") === "agent-busy");
  check("an error chip stays awake", judge(idleEvidence({ chipState: "error" }), "claude") === "unknown-state");
  check("no chip state yet: stays awake", judge(idleEvidence({ chipState: null }), "claude") === "unknown-state");
  check("a pending tool call keeps it awake", judge(idleEvidence({ pendingToolCalls: 1 }), "claude") === "agent-busy");
  check("background tasks keep it awake", judge(idleEvidence({ backgroundRunning: 2 }), "claude") === "agent-busy");
  check("live teammates keep it awake", judge(idleEvidence({ teammatesActive: 1 }), "claude") === "agent-busy");
  check("an unannounced turn keeps it awake", judge(idleEvidence({ turnActive: true }), "claude") === "agent-busy");
  check("a pending done keeps it awake", judge(idleEvidence({ pendingDone: true }), "claude") === "agent-busy");
  check("codex between outcome and idle composer stays awake", judge(idleEvidence({ runtime: "codex", codexAwaitingIdle: true }), "codex") === "agent-busy");
  check("typed but unsent text keeps it awake", judge(idleEvidence({ lastUserInputAt: 5_000, lastSubmitAt: 1_000 }), "claude") === "unsent-input");

  // ── Idle clock ──
  const clock = shared.judgeIdleClock;
  const MIN = 60_000;
  check("quiet long enough and hidden long enough: may sleep", clock({ now: 100 * MIN, idleMs: 30 * MIN, hiddenForMs: 40 * MIN, activityAt: [10 * MIN, 50 * MIN] }) === null);
  check("off never sleeps", clock({ now: 100 * MIN, idleMs: 0, hiddenForMs: 99 * MIN, activityAt: [] }) === "off");
  check("hidden too briefly stays awake", clock({ now: 100 * MIN, idleMs: 30 * MIN, hiddenForMs: 10 * MIN, activityAt: [] }) === "hidden-too-short");
  check("recent activity stays awake", clock({ now: 100 * MIN, idleMs: 30 * MIN, hiddenForMs: 40 * MIN, activityAt: [10 * MIN, 90 * MIN] }) === "not-idle-long-enough");
  check("a stamp from the future stays awake", clock({ now: 100 * MIN, idleMs: 30 * MIN, hiddenForMs: 40 * MIN, activityAt: [200 * MIN] }) === "not-idle-long-enough");
  check("an unknown hidden time stays awake", clock({ now: 100 * MIN, idleMs: 30 * MIN, hiddenForMs: NaN, activityAt: [] }) === "hidden-too-short");

  // ── Candidates in a background layout ──
  const layout = [
    terminalTab(
      "t1",
      split(
        leaf("p-ok", { agentSession: session() }),
        split(
          leaf("p-pinned", { agentSession: session({ sessionId: "s2" }), keepAwake: true }),
          leaf("p-sleeping", { agentSession: session({ sessionId: "s3" }), hibernation: { runtime: "claude", sleptAt: 1 } }),
        ),
      ),
    ),
    terminalTab(
      "t2",
      split(
        split(
          leaf("p-inactive", { agentSession: session({ sessionId: "s4", active: false }) }),
          leaf("p-shell"),
        ),
        split(
          leaf("p-cora", { agentSession: session({ sessionId: "s5" }), worker: { source: "spark", state: "running", runId: "r", workerTaskId: "w", attemptId: "a" } }),
          split(
            leaf("p-phone", { agentSession: session({ sessionId: "s6" }), origin: { kind: "phone" } }),
            split(
              leaf("p-working", { agentSession: session({ sessionId: "s7" }), worker: { source: "manual", state: "running", runId: "", workerTaskId: "", attemptId: "", runtimeState: "working" } }),
              split(
                // Restored into a hidden workspace: its restore marker stays
                // until the workspace is shown, and must not keep it awake.
                leaf("p-boot", { agentSession: session({ sessionId: "s8" }), bootResume: true }),
                // A stale "launching" (the restored-pane case) is left to main.
                leaf("p-codex", { agentSession: session({ runtime: "codex", sessionId: "s9" }), worker: { source: "manual", state: "running", runId: "", workerTaskId: "", attemptId: "", runtimeState: "launching" } }),
              ),
            ),
          ),
        ),
      ),
    ),
    terminalTab("t3", leaf("p-worker-tab", { agentSession: session({ sessionId: "s10" }) }), { scope: { kind: "workers", runId: "r" } }),
    { id: "chat", kind: "chat", title: "Chat" },
  ];
  const candidates = lib.hibernationCandidates("ws-b", layout).map((c) => c.paneId);
  check(
    "only unpinned, awake, user-run agents with a running session are candidates",
    JSON.stringify(candidates) === JSON.stringify(["p-ok", "p-boot", "p-codex"]),
    candidates,
  );
  check("a candidate carries its workspace and tab", lib.hibernationCandidates("ws-b", layout)[0].workspaceId === "ws-b" && lib.hibernationCandidates("ws-b", layout)[0].tabId === "t1");
  check("sleeping panes are counted for the rail", JSON.stringify(lib.sleepingPaneIds(layout)) === JSON.stringify(["p-sleeping"]));
  check("isLeafSleeping reads the mark", lib.isLeafSleeping({ hibernation: { runtime: "pi", sleptAt: 1 } }) && !lib.isLeafSleeping({}));

  const stamps = new Map();
  lib.updateHiddenSince(stamps, "ws-a", ["ws-b", "ws-c"], 100);
  check("workspaces leaving the screen get a stamp", stamps.get("ws-b") === 100 && stamps.get("ws-c") === 100 && !stamps.has("ws-a"));
  lib.updateHiddenSince(stamps, "ws-b", ["ws-a", "ws-c"], 200);
  check("the shown workspace loses its stamp, a kept stamp is not reset", !stamps.has("ws-b") && stamps.get("ws-a") === 200 && stamps.get("ws-c") === 100);
  lib.updateHiddenSince(stamps, "ws-b", ["ws-a"], 300);
  check("a removed workspace is forgotten", !stamps.has("ws-c") && stamps.get("ws-a") === 200);

  // ── Persist, hydration, quit snapshot ──
  const sleeping = leaf("p1", { agentSession: session({ active: true }), hibernation: { runtime: "claude", sleptAt: 5 }, keepAwake: true });
  const persisted = tabs.stripTransientPaneState(sleeping, true);
  check("persist drops the sleeping mark, keeps the pin and the pointer", !("hibernation" in persisted) && persisted.keepAwake === true && persisted.agentSession?.sessionId);
  const persistedOff = tabs.stripTransientPaneState(sleeping, false);
  check("with restore off, persist still keeps the pin", !("hibernation" in persistedOff) && persistedOff.keepAwake === true && !("agentSession" in persistedOff));

  const hydrated = JSON.parse(JSON.stringify(sleeping));
  hydrated.keepAwake = "yes";
  tabs.cleanupTransientTerminalState(hydrated);
  check("hydration drops a stray sleeping mark and a malformed pin", !("hibernation" in hydrated) && !("keepAwake" in hydrated));

  const asleepAtQuit = leaf("p2", { agentSession: session({ active: false }), hibernation: { runtime: "claude", sleptAt: 5 } });
  const marked = tabs.markTerminalAgentSessionsActive(asleepAtQuit, new Set());
  check("a pane asleep at quit counts as a running agent for relaunch restore", marked.agentSession?.active === true);
  const awakeIdle = leaf("p3", { agentSession: session({ active: true }) });
  check("an awake pane the quit snapshot did not list is still inactive", tabs.markTerminalAgentSessionsActive(awakeIdle, new Set()).agentSession?.active === false);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall agent hibernation policy checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
