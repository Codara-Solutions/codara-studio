// Harness for the boot-once session-restore hydration/persist helpers in
// src/renderer/src/tabs/useTabs.ts (cleanupTransientTerminalState /
// stripTransientPaneState, exported for tests). Asserts the persisted-blob
// contract behind "resume only what was RUNNING at quit":
//   - hydration mints `bootResume` iff agentSession.active===true with a real
//     sessionId, and deletes any stale marker that leaked into a blob
//   - old blobs without `active` are NOT restore-eligible
//   - persist strips bootResume (and worker/autorun) from every leaf
//
//   node scripts/test-session-restore.cjs
//
// Mirrors scripts/test-terminal-agent-notify.cjs: esbuild-bundles the REAL
// useTabs.ts with react stubbed (the module's top level never calls hooks;
// only the pure exported helpers are exercised here).

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
    build.onResolve({ filter: /^react$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export const useCallback = (fn) => fn;\n" +
        "export const useEffect = () => {};\n" +
        "export const useMemo = (fn) => fn();\n" +
        "export const useRef = (v) => ({ current: v });\n" +
        "export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];\n",
      loader: "js",
    }));
  },
};

const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
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
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const { cleanupTransientTerminalState, stripTransientPaneState } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // ── hydration: bootResume minted only for active pointers with a real id ──
  const active = leaf("p1", { worker: { runId: "manual" }, autorun: "claude", agentSession: session({ active: true }) });
  cleanupTransientTerminalState(active);
  check("active:true pointer mints bootResume", active.bootResume === true);
  check("hydration still deletes worker", !("worker" in active));
  check("hydration still deletes autorun", !("autorun" in active));

  const inactive = leaf("p2", { agentSession: session({ active: false }) });
  cleanupTransientTerminalState(inactive);
  check("active:false pointer does not restore", !("bootResume" in inactive));

  const oldBlob = leaf("p3", { agentSession: session() });
  cleanupTransientTerminalState(oldBlob);
  check("old blob without `active` does not restore", !("bootResume" in oldBlob));

  const pendingCapture = leaf("p4", { agentSession: session({ active: true, sessionId: "" }) });
  cleanupTransientTerminalState(pendingCapture);
  check("active pointer with empty sessionId does not restore", !("bootResume" in pendingCapture));

  const staleMarker = leaf("p5", { bootResume: true, agentSession: session({ active: false }) });
  cleanupTransientTerminalState(staleMarker);
  check("stale bootResume in a blob is deleted at hydration", !("bootResume" in staleMarker));

  const noSession = leaf("p6", { bootResume: true });
  cleanupTransientTerminalState(noSession);
  check("stale bootResume without a pointer is deleted", !("bootResume" in noSession));

  // ── hydration recurses through splits ──
  const tree = split(
    leaf("s1", { agentSession: session({ active: true }) }),
    split(leaf("s2", { agentSession: session({ active: false }) }), leaf("s3", { bootResume: true })),
  );
  cleanupTransientTerminalState(tree);
  check("split: active leaf mints bootResume", tree.a.bootResume === true);
  check("split: inactive leaf stays quiet", !("bootResume" in tree.b.a));
  check("split: stale marker deleted in nested leaf", !("bootResume" in tree.b.b));

  // ── persist: bootResume stripped alongside worker/autorun ──
  const dirty = leaf("q1", {
    worker: { runId: "manual" },
    autorun: "claude",
    bootResume: true,
    agentSession: session({ active: true }),
  });
  const stripped = stripTransientPaneState(dirty);
  check("persist strips bootResume", !("bootResume" in stripped));
  check("persist strips worker", !("worker" in stripped));
  check("persist strips autorun", !("autorun" in stripped));
  check("persist keeps agentSession (incl. active)", stripped.agentSession?.active === true);

  const consumed = leaf("q2", { bootResume: false, agentSession: session({ active: true }) });
  check("persist strips a consumed (false) marker too", !("bootResume" in stripTransientPaneState(consumed)));

  const clean = leaf("q3", { agentSession: session({ active: true }) });
  check("persist returns the same node when nothing to strip", stripTransientPaneState(clean) === clean);

  const dirtyTree = split(leaf("q4", { bootResume: true }), leaf("q5"));
  const strippedTree = stripTransientPaneState(dirtyTree);
  check("persist strips through splits", !("bootResume" in strippedTree.a));
  check("persist keeps untouched sibling identity", strippedTree.b === dirtyTree.b);

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all session-restore checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
