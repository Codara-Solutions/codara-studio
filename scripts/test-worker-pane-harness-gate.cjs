// Pi-harness workers run in-process over RPC. MAIN owns their display pty
// (run-store's ensurePiWorkerDisplayPty) and the renderer's workers pane is a
// pure ATTACHER: it materializes only once that session exists and hands
// TerminalPane a fail-closed no-op shell, so pane creation can never spawn a
// bare interactive shell wearing a worker's name (run-msds90l0-gzkim5). CLI
// workers are the opposite contract — their pane creation IS what drives
// pty:spawn — so the gates below are what keep the two paths from bleeding
// into each other.
//
// Takes an optional App.tsx path so the same assertions can be aimed at an
// older revision (git show HEAD:...) to prove they actually fail without the
// gates.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appPath = process.argv[2] || path.join(root, "src/renderer/src/App.tsx");
const app = fs.readFileSync(appPath, "utf8");
const runStore = fs.readFileSync(
  path.join(root, "src/main/orchestration/run-store.ts"),
  "utf8",
);
const terminalStack = fs.readFileSync(
  path.join(root, "src/renderer/src/tabs/TerminalStack.tsx"),
  "utf8",
);

let checks = 0;

// 1. The gates key off a command string minted in run-store. If that template
//    ever stops starting with "Pi harness", the classifier silently returns
//    "cli" for every Pi worker and its pane starts spawning real shells.
const template = /`Pi harness \(\$\{/.test(runStore);
assert.ok(
  template,
  "run-store no longer mints commands starting with `Pi harness (` — workerHarnessFromCommand can no longer recognise a Pi worker",
);
checks += 1;

// 2. The classifier itself, lifted from source so we test the real function.
const fnMatch = /function workerHarnessFromCommand\([\s\S]*?\n\}/.exec(app);
assert.ok(fnMatch, "workerHarnessFromCommand not found in App.tsx");
const workerHarnessFromCommand = new Function(
  `${fnMatch[0].replace(/:\s*"pi"\s*\|\s*"cli"\s*\|\s*undefined/, "").replace(/:\s*string\s*\|\s*undefined/g, "")}\nreturn workerHarnessFromCommand;`,
)();
assert.equal(workerHarnessFromCommand("Pi harness (codex/gpt-5.6-sol, medium)"), "pi");
assert.equal(workerHarnessFromCommand("Pi harness (claude/claude-opus-5, high)"), "pi");
assert.equal(workerHarnessFromCommand("claude --dangerously-skip-permissions"), "cli");
assert.equal(workerHarnessFromCommand("codex --yolo"), "cli");
assert.equal(workerHarnessFromCommand(undefined), undefined);
checks += 5;

// 3. EVERY call site that materializes a worker pane must be pi-gated: either
//    it skips Pi attempts outright (the edge-triggered launch-event path — the
//    display session does not exist yet when that event lands) or it requires
//    main's display session to already exist (the level-triggered reconcile
//    loop). An unguarded new call site would let a Pi attempt materialize a
//    pane with nothing to attach to, so this counts call sites rather than
//    checking a known few.
const callSites = [...app.matchAll(/ensureWorkerTerminalTab\(/g)]
  .map((m) => m.index)
  .filter((i) => {
    // Skip the interface declaration and the destructured api reference.
    const line = app.slice(app.lastIndexOf("\n", i) + 1, app.indexOf("\n", i));
    return /\.ensureWorkerTerminalTab\(/.test(line) || /=\s*t\.ensureWorkerTerminalTab/.test(line);
  });
assert.ok(callSites.length >= 2, `expected at least 2 pane-creating call sites, found ${callSites.length}`);
checks += 1;

// A Pi gate is either the hard skip or the attach-only existence gate. Both
// shapes must sit in the code that runs before the ensure call.
const SKIP_GATE = /if \((?:harness|workerHarnessFromCommand\([^)]*\))\s*===\s*"pi"\)\s*(?:return|\{)/;
const EXISTS_GATE =
  /(?:harness|workerHarnessFromCommand\([^)]*\))\s*===\s*"pi"\)\s*\{[\s\S]{0,400}?window\.spark\.pty\s*[\s\S]{0,80}?\.exists\(attempt\.id\)/;
for (const idx of callSites) {
  const before = app.slice(Math.max(0, idx - 3000), idx);
  assert.ok(
    SKIP_GATE.test(before) || EXISTS_GATE.test(before),
    `an ensureWorkerTerminalTab call site at offset ${idx} is neither skipped for harness === "pi" nor gated on the main-owned display session existing; a Pi worker would materialize a pane with nothing to attach to`,
  );
  checks += 1;
}

// 4. The reconcile loop's Pi branch must be the ATTACH gate, not a plain skip:
//    somewhere in App.tsx a pi-harness check has to consult pty.exists for the
//    attempt before ensuring the pane, or live Pi transcripts have no visible
//    terminal at all (the "Open terminal does nothing" regression).
assert.ok(
  EXISTS_GATE.test(app),
  'App.tsx no longer gates Pi worker panes on window.spark.pty.exists(attempt.id) — live Pi attempts would never get a terminal pane',
);
checks += 1;

// 5. The pane itself must be fail-closed: TerminalStack hands Pi worker
//    leaves a placeholder no-op shell so a spawn that slips past the exists
//    gate (attempt finished in between) errors visibly instead of leaving a
//    bare interactive shell.
assert.ok(
  /harness === "pi" \? PI_WORKER_DISPLAY_SHELL : shell/.test(terminalStack),
  "TerminalStack no longer routes Pi worker leaves onto the fail-closed display shell — an accidental spawn would open a real shell",
);
assert.ok(
  /PI_WORKER_DISPLAY_SHELL: ShellInfo = \{[\s\S]{0,200}?exe: "noop"/.test(terminalStack),
  'PI_WORKER_DISPLAY_SHELL must keep a no-op executable ("noop") so accidental spawns fail closed',
);
checks += 2;

// 6. Main must actually own the display session the pane attaches to:
//    ensurePiWorkerDisplayPty spawns it headless (webContents: null) when it
//    does not already exist.
assert.ok(
  /async function ensurePiWorkerDisplayPty\([\s\S]{0,600}?webContents: null/.test(runStore),
  "run-store's ensurePiWorkerDisplayPty no longer creates the main-owned headless display pty — Pi panes would have nothing to attach to",
);
checks += 1;

console.log(
  `PASS Pi worker panes attach to main-owned display sessions and can never spawn a shell (${checks} checks, ${callSites.length} call sites gated)`,
);
