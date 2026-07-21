// Harness for the cold terminal-layout hydration/persist helpers in
// src/renderer/src/tabs/useTabs.ts. A full app relaunch keeps layout/cwd and a
// validated Claude/Codex session pointer, while process-local fields and output
// are always removed. Active pointers receive a one-shot resume marker.
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
    cleanupTransientTerminalState,
    markTerminalAgentSessionsActive,
    stripTransientPaneState,
  } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  const active = leaf("p1", {
    cwd: "/tmp/kept",
    scrollback: "OLD_OUTPUT",
    worker: { runId: "manual" },
    autorun: "claude",
    bootResume: true,
    agentSession: session({ active: true }),
  });
  cleanupTransientTerminalState(active);
  check("cold hydration strips scrollback", !("scrollback" in active));
  check("cold hydration strips worker", !("worker" in active));
  check("cold hydration strips autorun", !("autorun" in active));
  check("cold hydration retains a validated active session", active.agentSession?.sessionId === session().sessionId);
  check("cold hydration derives the one-shot resume marker", active.bootResume === true);
  check("cold hydration preserves cwd and pane id", active.cwd === "/tmp/kept" && active.paneId === "p1");

  for (const [name, pointer, resumes] of [
    ["inactive Claude", session({ active: false }), false],
    ["legacy Claude", session(), false],
    ["active Codex", session({ runtime: "codex", active: true }), true],
  ]) {
    const item = leaf(name, { agentSession: pointer, bootResume: !resumes, scrollback: name });
    cleanupTransientTerminalState(item);
    check(`${name} keeps its validated pointer`, item.agentSession === pointer);
    check(`${name} resume eligibility follows active state`, (item.bootResume === true) === resumes);
    check(`${name} scrollback never replays`, !("scrollback" in item));
  }

  for (const [name, pointer] of [
    ["pending session", session({ active: true, sessionId: "" })],
    ["control-character id", session({ active: true, sessionId: "bad\ncommand" })],
    ["unknown runtime", session({ runtime: "other", active: true })],
    ["missing cwd", session({ active: true, cwd: "" })],
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
  check("nested hydration strips process-local fields", !tree.a.scrollback && !tree.b.a.scrollback && !tree.b.b.bootResume);
  check("nested hydration marks active pointer", tree.a.agentSession?.active === true && tree.a.bootResume === true);
  check("nested hydration preserves split geometry", tree.ratio === 0.62 && tree.b.ratio === 0.35);
  check("nested hydration preserves pane ids and cwd", tree.a.paneId === "s1" && tree.b.a.cwd === "/two" && tree.b.b.cwd === "/three");

  const dirty = leaf("q1", {
    cwd: "/persisted",
    scrollback: "OLD_OUTPUT",
    worker: { runId: "manual" },
    autorun: "claude",
    bootResume: true,
    agentSession: session({ active: true }),
  });
  const stripped = stripTransientPaneState(dirty);
  check("persist strips every process-local field", ["scrollback", "worker", "autorun", "bootResume"].every((key) => !(key in stripped)));
  check("persist retains the validated session pointer", stripped.agentSession === dirty.agentSession);
  check("persist preserves layout fields", stripped.paneId === "q1" && stripped.cwd === "/persisted");

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
  check("persist preserves clean leaf identity", stripTransientPaneState(clean) === clean);

  const dirtyTree = split(leaf("q3", { scrollback: "old" }), leaf("q4"), 0.4);
  const strippedTree = stripTransientPaneState(dirtyTree);
  check("persist strips recursively", !("scrollback" in strippedTree.a));
  check("persist keeps untouched sibling identity", strippedTree.b === dirtyTree.b);
  check("persist keeps split ratio", strippedTree.ratio === 0.4);

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all opt-in session restore checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
