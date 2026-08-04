// Pi-harness workers run in-process over RPC and own no pty. Materializing a
// terminal pane for one spawns a bare shell the user never asked for, which is
// what produced "extra tabs but nothing was running inside" in
// run-msds90l0-gzkim5. App.tsx already skipped preparing/prompt_ready attempts
// for exactly this reason, but it filtered on attempt STATUS, and a Pi worker
// reaches "running" while still owning no pty.
//
// Takes an optional path so the same assertions can be aimed at an older
// revision (git show HEAD:...) to prove they actually fail without the gate.
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

let checks = 0;

// 1. The gate keys off a command string minted in run-store. If that template
//    ever stops starting with "Pi harness", the classifier silently returns
//    "cli" for every Pi worker and the panes come back.
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

// 3. EVERY call site that materializes a worker pane must be gated. A new
//    unguarded one reintroduces the empty tabs, so this counts call sites
//    rather than checking a known few.
const callSites = [...app.matchAll(/ensureWorkerTerminalTab\(/g)]
  .map((m) => m.index)
  .filter((i) => {
    // Skip the interface declaration and the destructured api reference.
    const line = app.slice(app.lastIndexOf("\n", i) + 1, app.indexOf("\n", i));
    return /\.ensureWorkerTerminalTab\(/.test(line) || /=\s*t\.ensureWorkerTerminalTab/.test(line);
  });
assert.ok(callSites.length >= 2, `expected at least 2 pane-creating call sites, found ${callSites.length}`);
checks += 1;

const GUARD = /(harness\s*===\s*"pi")|(workerHarnessFromCommand\([^)]*\)\s*===\s*"pi")/;
for (const idx of callSites) {
  const before = app.slice(Math.max(0, idx - 2600), idx);
  assert.ok(
    GUARD.test(before),
    `an ensureWorkerTerminalTab call site at offset ${idx} is not gated on harness === "pi"; a Pi worker would materialize an empty terminal pane`,
  );
  checks += 1;
}

console.log(
  `PASS Pi-harness workers never materialize a terminal pane (${checks} checks, ${callSites.length} call sites gated)`,
);
