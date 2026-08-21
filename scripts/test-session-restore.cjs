// Harness for the cold terminal-layout hydration/persist helpers in
// src/renderer/src/tabs/useTabs.ts. A relaunch always keeps layout and cwd;
// whether terminal output and agent-session pointers survive persist is gated
// on the restoreAgentSessions preference (stripTransientPaneState's second
// argument). Hydration re-validates pointers and mints a one-shot resume
// marker for sessions that were active at quit. Worker chips / autorun / phone
// origin / the boot-once marker never survive.
//
//   node scripts/test-session-restore.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "tabs", "useTabs.ts");

const harnessPlugin = {
  name: "session-restore-harness",
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

const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
const split = (a, b, ratio = 0.5) => ({ kind: "split", direction: "horizontal", ratio, a, b });
const session = (extra = {}) => ({
  runtime: "claude",
  sessionId: "11111111-2222-3333-4444-555555555555",
  cwd: "/tmp/proj",
  capturedAt: "2026-07-06T00:00:00.000Z",
  ...extra,
});

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-session-restore-test", "useTabs.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY], bundle: true, platform: "node", format: "cjs", outfile,
    plugins: [harnessPlugin], logLevel: "silent",
  });
  delete require.cache[outfile];
  const {
    appendAgentTerminalToWorkspaceLayout,
    cleanupTransientTerminalState,
    markTerminalAgentSessionsActive,
    mergeDeferredWorkspaceTerminalLayout,
    stripTransientPaneState,
    terminalTabIdForPane,
    upsertInactiveWorkspaceLayout,
  } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  const terminalSource = fs.readFileSync(
    path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "useTerminalSession.ts"),
    "utf8",
  );
  check(
    "tab/workspace hides remember the exact xterm viewport",
    /viewportBeforeHideRef[\s\S]*line: buffer\.viewportY[\s\S]*atBottom: buffer\.viewportY >= buffer\.baseY/.test(terminalSource),
  );
  check(
    "revealing a Codex terminal restores bottom-follow or its prior line",
    /savedViewport\.atBottom\) term\.scrollToBottom\(\);[\s\S]*term\.scrollToLine\(savedViewport\.line\)/.test(terminalSource),
  );
  check(
    "a Codex terminal first created while hidden follows the bottom on reveal",
    terminalSource.includes("viewportBeforeHideRef.current = { line: 0, atBottom: true }"),
  );
  check(
    "the viewport is restored after all three delayed fit frames",
    terminalSource.includes("let remainingRestoreFrames = 3") &&
      terminalSource.includes("requestAnimationFrame(restoreAfterFit)"),
  );

  // ---- never-visited background workspace placement ----

  const deferredPhone = appendAgentTerminalToWorkspaceLayout(
    { workspaceId: "ws-phone", tabs: [], activeId: null },
    {
      cwd: "/tmp/phone-workspace",
      title: "Phone shell",
      origin: { kind: "phone", deviceName: "Test phone" },
    },
  );
  const phoneTab = deferredPhone.layout.tabs[0];
  check(
    "cold background placement contains only the requested phone terminal",
    deferredPhone.layout.tabs.length === 1 && phoneTab?.kind === "terminal",
  );
  check(
    "cold background placement preserves no active selection",
    deferredPhone.layout.activeId === null,
  );
  check(
    "cold background placement preserves authenticated phone origin",
    phoneTab?.kind === "terminal" &&
      phoneTab.root.kind === "leaf" &&
      phoneTab.root.origin?.kind === "phone" &&
      phoneTab.root.origin.deviceName === "Test phone",
  );
  check(
    "phone terminal does not receive the amber agent tint",
    phoneTab?.kind === "terminal" && !("color" in phoneTab),
  );

  const mountedColdLayout = upsertInactiveWorkspaceLayout(
    [],
    deferredPhone.layout,
  );
  check(
    "never-visited workspace is inserted into the hidden mounted layouts",
    mountedColdLayout.length === 1 &&
      mountedColdLayout[0].workspaceId === "ws-phone",
  );

  const normalColdLayout = {
    workspaceId: "ws-phone",
    tabs: [
      { id: "draft:cold", kind: "chat", title: "Cora" },
      {
        id: "term-cold",
        kind: "terminal",
        title: "terminals",
        root: leaf("pane-cold", { cwd: "/tmp/phone-workspace" }),
        activePaneId: "pane-cold",
      },
    ],
    activeId: "draft:cold",
  };
  const mergedColdLayout = mergeDeferredWorkspaceTerminalLayout(
    normalColdLayout,
    deferredPhone.layout,
  );
  check(
    "first desktop visit merges its normal cold layout with the live phone pane",
    mergedColdLayout.tabs.length === 3 &&
      mergedColdLayout.tabs.some((tab) => tab.id === deferredPhone.tabId),
  );
  check(
    "first desktop visit keeps the normal cold selection instead of focusing phone",
    mergedColdLayout.activeId === "draft:cold",
  );

  const movedPaneTabs = [
    {
      id: "term-original",
      kind: "terminal",
      title: "terminals",
      root: leaf("pane-other"),
      activePaneId: "pane-other",
    },
    {
      id: "term-moved",
      kind: "terminal",
      title: "terminals 2",
      root: leaf("pane-phone"),
      activePaneId: "pane-phone",
    },
  ];
  check(
    "bridge teardown follows a phone pane moved out of its original tab",
    terminalTabIdForPane(movedPaneTabs, "term-original", "pane-phone") ===
      "term-moved",
  );
  check(
    "bridge teardown still prefers the original tab while it owns the pane",
    terminalTabIdForPane(movedPaneTabs, "term-moved", "pane-phone") ===
      "term-moved",
  );

  // ---- cold hydration: keeps durable state, mints boot-once marker ----

  const active = leaf("p1", {
    cwd: "/tmp/kept",
    scrollback: "OLD_OUTPUT",
    worker: { runId: "manual" },
    autorun: "claude",
    origin: { kind: "phone", deviceName: "Test phone" },
    agentSession: session({ active: true }),
  });
  cleanupTransientTerminalState(active);
  check("cold hydration keeps scrollback", active.scrollback === "OLD_OUTPUT");
  check("cold hydration strips worker", !("worker" in active));
  check("cold hydration strips autorun", !("autorun" in active));
  check("cold hydration strips phone origin", !("origin" in active));
  check("cold hydration keeps agent session", active.agentSession?.sessionId === session().sessionId);
  check("cold hydration mints bootResume for running-at-quit pointer", active.bootResume === true);
  check("cold hydration preserves cwd and pane id", active.cwd === "/tmp/kept" && active.paneId === "p1");

  // Only a validated pointer whose agent was RUNNING at quit earns the
  // boot-once marker; scrollback replays regardless (persist already gated it).
  for (const [name, pointer, resumes] of [
    ["inactive Claude", session({ active: false }), false],
    ["legacy Claude", session(), false],
    ["active Codex", session({ runtime: "codex", active: true }), true],
  ]) {
    const item = leaf(name, { agentSession: pointer, bootResume: !resumes, scrollback: name });
    cleanupTransientTerminalState(item);
    check(`${name} keeps its validated pointer`, item.agentSession === pointer);
    check(`${name} resume eligibility follows active state`, (item.bootResume === true) === resumes);
    check(`${name} scrollback still replays`, item.scrollback === name);
  }
  const codexActive = leaf("cx", { agentSession: session({ runtime: "codex", active: true }) });
  cleanupTransientTerminalState(codexActive);
  check("active Codex pointer mints bootResume", codexActive.bootResume === true);

  for (const [name, pointer] of [
    ["pending session", session({ active: true, sessionId: "" })],
    ["control-character id", session({ active: true, sessionId: "bad\ncommand" })],
    ["unknown runtime", session({ runtime: "other", active: true })],
    ["missing cwd", session({ active: true, cwd: "" })],
    [
      "Claude pointer with native Codex profile",
      session({
        runtime: "claude",
        nativeCodexProfileId: "personal",
      }),
    ],
    [
      "control-character native Codex profile",
      session({
        runtime: "codex",
        nativeCodexProfileId: "bad\nprofile",
      }),
    ],
    [
      "Codex pointer with native Claude profile",
      session({
        runtime: "codex",
        nativeClaudeProfileId: "personal",
      }),
    ],
    [
      "control-character native Claude profile",
      session({
        runtime: "claude",
        nativeClaudeProfileId: "bad\nprofile",
      }),
    ],
    [
      "non-v4 native Claude profile",
      session({
        runtime: "claude",
        nativeClaudeProfileId: "10000000-0000-3000-8000-000000000042",
      }),
    ],
  ]) {
    const item = leaf(name, { agentSession: pointer, bootResume: true });
    cleanupTransientTerminalState(item);
    check(`${name} pointer is rejected`, !("agentSession" in item) && !("bootResume" in item));
  }

  const tree = split(
    leaf("s1", { cwd: "/one", scrollback: "one", agentSession: session({ active: true }) }),
    split(
      leaf("s2", { cwd: "/two", scrollback: "two", autorun: "codex" }),
      leaf("s3", { cwd: "/three", bootResume: true }),
      0.35,
    ),
    0.62,
  );
  cleanupTransientTerminalState(tree);
  check("nested hydration mints/clears bootResume per leaf", tree.a.bootResume === true && !("bootResume" in tree.b.b));
  check("nested hydration strips autorun everywhere", !("autorun" in tree.b.a));
  check("nested hydration keeps scrollback and the active pointer", tree.a.scrollback === "one" && tree.a.agentSession?.active === true);
  check("nested hydration preserves split geometry", tree.ratio === 0.62 && tree.b.ratio === 0.35);
  check("nested hydration preserves pane ids and cwd", tree.a.paneId === "s1" && tree.b.a.cwd === "/two" && tree.b.b.cwd === "/three");

  // ---- persist, restore preference OFF (default): fresh-shell contract ----

  const dirty = leaf("q1", {
    cwd: "/persisted",
    scrollback: "OLD_OUTPUT",
    worker: { runId: "manual" },
    autorun: "claude",
    origin: { kind: "phone", deviceName: "Test phone" },
    bootResume: true,
    agentSession: session({ active: true }),
  });
  const stripped = stripTransientPaneState(dirty);
  check("persist(off) strips every process-local field", ["scrollback", "worker", "autorun", "origin", "bootResume", "agentSession"].every((key) => !(key in stripped)));
  check("persist(off) preserves layout fields", stripped.paneId === "q1" && stripped.cwd === "/persisted");

  const malformed = leaf("bad", { agentSession: session({ sessionId: "" }), bootResume: true });
  const malformedStripped = stripTransientPaneState(malformed);
  check("persist rejects malformed pointers", !("agentSession" in malformedStripped));
  check("persist never writes boot resume", !("bootResume" in malformedStripped));

  const quitTree = split(
    leaf("running-pane", { agentSession: session({ active: false }) }),
    leaf("idle-pane", { agentSession: session({ runtime: "codex", active: false }) }),
  );
  const quitMarked = markTerminalAgentSessionsActive(quitTree, new Set(["running-pane"]));
  check("quit-time liveness promotes the reported pane", quitMarked.a.agentSession?.active === true);
  check("quit-time liveness leaves other pointers inactive", quitMarked.b.agentSession?.active === false);
  check("quit-time liveness preserves untouched leaf identity", quitMarked.b === quitTree.b);

  const clean = leaf("q2", { cwd: "/clean" });
  check("persist(off) preserves clean leaf identity", stripTransientPaneState(clean) === clean);

  const dirtyTree = split(leaf("q3", { scrollback: "old" }), leaf("q4"), 0.4);
  const strippedTree = stripTransientPaneState(dirtyTree);
  check("persist(off) strips recursively", !("scrollback" in strippedTree.a));
  check("persist(off) keeps untouched sibling identity", strippedTree.b === dirtyTree.b);
  check("persist(off) keeps split ratio", strippedTree.ratio === 0.4);

  // ---- persist, restore preference ON: pointer + scrollback survive ----

  const kept = stripTransientPaneState(
    leaf("k1", {
      cwd: "/kept",
      scrollback: "KEEP_ME",
      worker: { runId: "manual" },
      autorun: "claude",
      origin: { kind: "phone", deviceName: "Test phone" },
      bootResume: true,
      agentSession: session({ active: true }),
    }),
    true,
  );
  check("persist(on) keeps scrollback", kept.scrollback === "KEEP_ME");
  check("persist(on) keeps agent session", kept.agentSession?.active === true);
  check("persist(on) still strips worker/autorun/origin/bootResume", !("worker" in kept) && !("autorun" in kept) && !("origin" in kept) && !("bootResume" in kept));

  const codexProfilePointer = session({
    runtime: "codex",
    nativeCodexProfileId: "00000000-0000-4000-8000-000000000042",
    active: true,
  });
  const keptCodexProfile = stripTransientPaneState(
    leaf("codex-profile", { agentSession: codexProfilePointer }),
    true,
  );
  check(
    "terminal restore preserves the frozen native Codex profile",
    keptCodexProfile.agentSession?.nativeCodexProfileId ===
      "00000000-0000-4000-8000-000000000042",
  );

  const claudeProfilePointer = session({
    nativeClaudeProfileId: "10000000-0000-4000-8000-000000000042",
    active: true,
  });
  const keptClaudeProfile = stripTransientPaneState(
    leaf("claude-profile", { agentSession: claudeProfilePointer }),
    true,
  );
  check(
    "terminal restore preserves the frozen native Claude profile",
    keptClaudeProfile.agentSession?.nativeClaudeProfileId ===
      "10000000-0000-4000-8000-000000000042",
  );
  cleanupTransientTerminalState(keptClaudeProfile);
  check(
    "cold hydration retains a valid native Claude profile and resumes it once",
    keptClaudeProfile.agentSession?.nativeClaudeProfileId ===
      "10000000-0000-4000-8000-000000000042" &&
      keptClaudeProfile.bootResume === true,
  );

  const cleanOn = leaf("k2", { cwd: "/clean", scrollback: "s", agentSession: session() });
  check("persist(on) preserves durable-only leaf identity", stripTransientPaneState(cleanOn, true) === cleanOn);

  const keptTree = stripTransientPaneState(
    split(leaf("k3", { scrollback: "three", bootResume: true }), leaf("k4", { agentSession: session() }), 0.4),
    true,
  );
  check("persist(on) recurses keeping durable state", keptTree.a.scrollback === "three" && !("bootResume" in keptTree.a) && keptTree.b.agentSession?.runtime === "claude");

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all session-restore persistence checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
