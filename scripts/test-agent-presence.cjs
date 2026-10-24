"use strict";
// The agent's cursor and driving banner on a browser tab
// (src/renderer/src/components/Preview/agent-presence/): the glide math, the
// store that waits for a glide before an action, and the Stop that refuses
// the stopped agent's next call. Main's side is the driver it stamps on every
// browser call (src/main/browser/agent-driver.ts).
//
//   node scripts/test-agent-presence.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(entry) {
  const output = await esbuild.build({ entryPoints: [path.join(ROOT, entry)], bundle: true, write: false, platform: "node", format: "cjs" });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const glide = await load("src/renderer/src/components/Preview/agent-presence/glide.ts");
  const from = { x: 10, y: 10 };

  // Duration: still is free, then 250 to 450 ms growing with distance.
  assert.equal(glide.glideDuration(from, { x: 11, y: 10 }), 0, "no glide for a point the cursor is on");
  const near = glide.glideDuration(from, { x: 40, y: 10 });
  const mid = glide.glideDuration(from, { x: 410, y: 10 });
  const far = glide.glideDuration(from, { x: 3000, y: 2000 });
  assert.ok(near >= glide.GLIDE_MIN_MS && near < mid && mid < far, `durations grow with distance: ${near} ${mid} ${far}`);
  assert.equal(far, glide.GLIDE_MAX_MS, "and stop growing at the cap");

  // Easing: starts and ends still, symmetric, monotonic.
  assert.equal(glide.easeInOutCubic(0), 0);
  assert.equal(glide.easeInOutCubic(1), 1);
  assert.equal(glide.easeInOutCubic(0.5), 0.5);
  assert.ok(glide.easeInOutCubic(0.1) < 0.1 && glide.easeInOutCubic(0.9) > 0.9, "slow start, soft landing");
  for (let t = 0; t < 1; t += 0.05) assert.ok(glide.easeInOutCubic(t + 0.05) >= glide.easeInOutCubic(t));

  // Path: starts and ends exactly on the points, bows out to one side, never by much.
  const to = { x: 410, y: 10 };
  assert.deepEqual(glide.glidePoint(from, to, 0), from);
  assert.deepEqual(glide.glidePoint(from, to, 1), to);
  const control = glide.glideControl(from, to);
  const halfway = glide.glidePoint(from, to, 0.5, control);
  assert.ok(Math.abs(halfway.x - 210) < 1e-9, "halfway in time is halfway along");
  const bow = Math.abs(halfway.y - 10);
  assert.ok(bow > 5 && bow <= 48, `a gentle curve, not a straight line or a loop: ${bow}`);
  const back = glide.glidePoint(to, from, 0.5);
  assert.ok(Math.sign(back.y - 10) === -Math.sign(halfway.y - 10), "the bow follows the direction of travel, like a wrist");
  const long = glide.glidePoint({ x: 0, y: 0 }, { x: 5000, y: 0 }, 0.5);
  assert.ok(Math.abs(long.y) <= 48 / 2 + 1e-9, "a long move bows no more than the cap");

  const store = await load("src/renderer/src/components/Preview/agent-presence/store.ts");
  const claude = { key: "pane:p1", name: "Claude Code", runtime: "claude", workspace: "AI Continous Improvment" };
  const codex = { key: "pane:p2", name: "Codex", runtime: "codex", workspace: "Studio app" };

  assert.equal(store.readDriver(null), null, "a call without a driver is the user's, not an agent's");
  assert.equal(store.readDriver({ name: "x" }), null);
  assert.deepEqual(store.readDriver({ key: "run:1" }), { key: "run:1", name: "An agent", runtime: null, workspace: null });

  // Without a pane drawing it, the cursor never holds an action up.
  let started = Date.now();
  await store.moveAgentCursor("t1", claude, { action: "Clicking", point: { x: 5, y: 5 } });
  assert.ok(Date.now() - started < 50);
  assert.equal(store.presenceState("t1").driver.name, "Claude Code", "the banner names who acts");
  assert.equal(store.presenceState("t1").action, "Clicking");

  // With one, the action waits for the glide, up to the cap and no longer.
  const moves = [];
  const off = store.registerCursorAnimator("t1", (move) => {
    moves.push(move);
    return new Promise((resolve) => setTimeout(resolve, 120));
  });
  started = Date.now();
  await store.moveAgentCursor("t1", claude, { action: "Clicking", point: { x: 50, y: 60 }, press: true });
  assert.ok(Date.now() - started >= 110, "the action waited for the cursor");
  assert.deepEqual(moves.at(-1), { action: "Clicking", point: { x: 50, y: 60 }, press: true });
  off();
  store.registerCursorAnimator("t1", () => new Promise(() => {}));
  started = Date.now();
  await store.moveAgentCursor("t1", claude, { action: "Clicking", point: { x: 1, y: 1 } });
  const waited = Date.now() - started;
  assert.ok(waited >= store.GLIDE_WAIT_CAP_MS - 20 && waited < store.GLIDE_WAIT_CAP_MS + 200, `a stuck animation costs at most the cap: ${waited}`);

  // Stop refuses that agent on that tab only, with a message it can act on.
  let notified = 0;
  store.subscribePresence("t1", () => notified++);
  assert.doesNotThrow(() => store.assertDriverAllowed("t1", claude));
  const stopped = store.stopDriver("t1");
  assert.equal(stopped.key, "pane:p1", "Stop with no key stops whoever drives now");
  assert.ok(notified > 0, "the banner hears about it");
  assert.equal(store.presenceState("t1").driver, null, "the stopped agent no longer drives");
  assert.equal(store.presenceState("t1").stopped.name, "Claude Code", "the notice says who was stopped");
  assert.throws(() => store.assertDriverAllowed("t1", claude), (error) => {
    assert.ok(error instanceof store.StoppedDriverError);
    assert.match(error.message, /The user stopped Claude Code from using browser tab t1/);
    assert.match(error.message, /Do not use this tab again or retry/);
    return true;
  });
  assert.doesNotThrow(() => store.assertDriverAllowed("t1", codex), "another agent may still use the tab");
  assert.doesNotThrow(() => store.assertDriverAllowed("t2", claude), "and the stopped agent may use another tab");
  assert.doesNotThrow(() => store.assertDriverAllowed("t1", null), "the user's own actions are never refused");

  // Undo lets it back; closing the tab forgets every stop.
  store.allowDriver("t1", "pane:p1");
  assert.doesNotThrow(() => store.assertDriverAllowed("t1", claude));
  assert.equal(store.presenceState("t1").stopped, null);
  store.stopDriver("t1", codex);
  assert.ok(store.isDriverStopped("t1", "pane:p2"));
  store.forgetPresenceTab("t1");
  assert.equal(store.isDriverStopped("t1", "pane:p2"), false);

  // A run that ends stops showing as driving.
  store.noteDriving("t3", { key: "run:r1", name: "Cora", runtime: "pi", workspace: null });
  store.clearDriver("run:r1");
  assert.equal(store.presenceState("t3").driver, null);

  const driver = await load("src/main/browser/agent-driver.ts");
  const lookups = { paneRuntime: (pane) => (pane === "p1" ? "claude" : null), workspaceName: async (id) => (id === "ws1" ? "AI Continous Improvment" : null) };
  assert.deepEqual(await driver.describeDriver({ callerPaneId: "p1", workspaceId: "ws1" }, lookups), claude);
  assert.deepEqual(await driver.describeDriver({ runId: "r9", callerPaneId: "p1" }, lookups), { key: "run:r9", name: "Cora", runtime: "pi", workspace: null }, "a run is Cora, whatever pane started it");
  assert.deepEqual(await driver.describeDriver({ callerPaneId: "p7" }, lookups), { key: "pane:p7", name: "An agent", runtime: null, workspace: null });
  assert.equal(driver.driverKey({ callerPid: 4242 }), "pid:4242", "an agent outside Codara's terminals is keyed by its MCP process");
  assert.equal(driver.driverKey({}), "agent");
  const throwing = { paneRuntime: () => { throw new Error("gone"); } };
  assert.equal((await driver.describeDriver({ callerPaneId: "p1" }, throwing)).name, "An agent", "a failing lookup never fails the call");

  console.log("agent presence: glide math, waiting for the cursor, Stop and Undo, run end, driver identity");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
