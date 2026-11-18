// Agent CLI updates, the words on screen: the worker picker's mark and the
// Settings row's version line for every state (agent-cli-text.ts).

const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const status = (overrides = {}) => ({
  id: "claude",
  label: "Claude Code",
  installed: true,
  version: "2.1.325",
  latestVersion: "2.1.327",
  updateAvailable: true,
  installMethod: "native",
  installSource: "native installer",
  canUpdate: true,
  manualCommand: "claude update",
  phase: "idle",
  message: null,
  liveSessions: 0,
  ...overrides,
});

async function main() {
  const root = path.resolve(__dirname, "..");
  const cache = path.join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const outfile = path.join(cache, `agent-cli-text-test-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, "src/renderer/src/components/agent-cli-updates/agent-cli-text.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(root, "src/shared") },
    logLevel: "silent",
  });
  try {
    run(require(outfile));
  } finally {
    rmSync(outfile, { force: true });
  }
  console.log("agent CLI text: ok");
}

function run(m) {
  // Marks.
  assert.deepEqual(m.agentCliMark(status()), {
    label: "Update",
    tone: "accent",
    title: "Claude Code 2.1.327 is out (you have 2.1.325). Update now.",
    action: "update",
  });
  assert.equal(m.agentCliMark(status({ updateAvailable: false })), null, "no mark when up to date");
  assert.equal(m.agentCliMark(status({ installed: false })), null);
  assert.equal(m.agentCliMark(status({ phase: "updating" })).label, "Updating");
  assert.equal(m.agentCliMark(status({ phase: "updating" })).action, null);
  assert.equal(m.agentCliMark(status({ phase: "rolling-back" })).label, "Restoring");
  assert.equal(m.agentCliMark(status({ phase: "rolled-back", message: "put back" })).tone, "warn");
  assert.equal(m.agentCliMark(status({ phase: "failed" })).tone, "danger");
  assert.equal(m.agentCliMark(status({ canUpdate: false, manualCommand: "brew upgrade claude-code" })).action, "settings");
  const refused = m.agentCliMark(status(), "Agent tool updates are off in this launch.");
  assert.equal(refused.title, "Agent tool updates are off in this launch.", "a refused request shows its reason on the mark");
  assert.equal(refused.action, "settings");

  // Pi: the pinned version, or both when they differ.
  const pi = (version) => status({ id: "pi", label: "Pi", version, pinnedVersion: "1.5.2", updateAvailable: false, canUpdate: false, installMethod: "pinned" });
  assert.equal(m.agentCliMark(pi("1.5.2")).label, "Pinned 1.5.2");
  const differs = m.agentCliMark(pi("1.5.3"));
  assert.equal(differs.label, "Pi 1.5.3", "a Pi that is not the pinned one is not called pinned");
  assert.equal(differs.tone, "warn");
  assert.match(differs.title, /tested with 1\.5\.2/);

  // Version lines: before the first check nothing is "not installed".
  const missing = status({ installed: false, version: null });
  assert.equal(m.agentCliVersionLine(missing, { lastCheckedAt: null, checking: false }), "Not checked yet.");
  assert.equal(m.agentCliVersionLine(missing, { lastCheckedAt: null, checking: true }), "Checking…");
  assert.equal(m.agentCliVersionLine(missing, { lastCheckedAt: "2026-11-18T12:00:00Z", checking: false }), "Not installed.");
  assert.equal(m.agentCliVersionLine(status(), { lastCheckedAt: "x", checking: false }), "v2.1.325 · native installer");
  assert.equal(m.agentCliVersionLine(pi("1.5.2"), { lastCheckedAt: "x", checking: false }), "v1.5.2 · pinned to 1.5.2 · native installer");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
