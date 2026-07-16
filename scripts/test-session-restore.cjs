// Harness for the cold terminal-layout hydration/persist helpers in
// src/renderer/src/tabs/useTabs.ts. A full app relaunch keeps layout and cwd,
// but never restores terminal output, worker state, or agent sessions.
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
  const { cleanupTransientTerminalState, stripTransientPaneState } = require(outfile);

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
  check("cold hydration strips agent session", !("agentSession" in active));
  check("cold hydration strips boot resume", !("bootResume" in active));
  check("cold hydration preserves cwd and pane id", active.cwd === "/tmp/kept" && active.paneId === "p1");

  for (const [name, pointer] of [
    ["inactive Claude", session({ active: false })],
    ["legacy Claude", session()],
    ["pending Claude", session({ active: true, sessionId: "" })],
    ["active Codex", session({ runtime: "codex", active: true })],
  ]) {
    const item = leaf(name, { agentSession: pointer, bootResume: true, scrollback: name });
    cleanupTransientTerminalState(item);
    check(`${name} pointer never resumes`, !("agentSession" in item) && !("bootResume" in item));
    check(`${name} scrollback never replays`, !("scrollback" in item));
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
  check("nested hydration strips every leaf", !tree.a.scrollback && !tree.b.a.scrollback && !tree.b.b.bootResume);
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
  check("persist strips every process-local field", ["scrollback", "worker", "autorun", "bootResume", "agentSession"].every((key) => !(key in stripped)));
  check("persist preserves layout fields", stripped.paneId === "q1" && stripped.cwd === "/persisted");

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
  console.log("all fresh-terminal restore checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
