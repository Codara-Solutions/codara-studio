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

  // Stop pressed while the cursor glides keeps the action that would follow.
  store.allowDriver("t1", "pane:p1");
  store.registerCursorAnimator("t1", () => new Promise((resolve) => setTimeout(() => {
    store.stopDriver("t1", claude);
    resolve();
  }, 30)));
  await assert.rejects(
    store.moveAgentCursor("t1", claude, { action: "Clicking", point: { x: 9, y: 9 }, press: true }),
    (error) => error instanceof store.StoppedDriverError,
    "the call fails once the glide ends, before the click",
  );

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

  await trustedInput();

  console.log("agent presence: glide math, waiting for the cursor, Stop and Undo, run end, driver identity, trusted input around the glide");
}

// Main's trusted input (src/main/preview-input.ts) waits for the cursor
// through the renderer's "activity" op; these drive it with a fake guest.
async function trustedInput() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/preview-input.ts")], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["electron", "./preview-bridge", "../preview-bridge", "./main-window-trust", "../main-window-trust"],
  });
  let center = { x: 50, y: 30 };
  let probes = 0;
  let destroyed = false;
  let onActivity = () => {};
  let onKey = () => {};
  const events = [];
  const activities = [];
  const wc = {
    id: 7, on() {}, once() {},
    isDestroyed: () => destroyed,
    executeJavaScript: async () => { probes++; return { ok: true, ...center }; },
    sendInputEvent: (event) => {
      if (destroyed) throw new Error("Object has been destroyed");
      events.push(event);
    },
    debugger: { on() {}, isAttached: () => true, sendCommand: async (method, command) => {
      if (method !== "Input.dispatchKeyEvent") return;
      events.push({ type: `key:${command.type}`, key: command.key });
      await onKey(command);
    } },
  };
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, (name) => {
    if (name === "electron") return { ipcMain: { on() {} }, webContents: { fromId: () => wc } };
    if (name.endsWith("main-window-trust")) return { isTrustedPreviewGuest: () => true, isTrustedOnSender: () => true, onTrustedPreviewGuestAttached: () => () => {} };
    if (name.endsWith("preview-bridge")) return { requestPreviewOp: async (op, params) => {
      if (op === "activity") {
        activities.push(params);
        await onActivity(params, activities.length);
        return { ok: true };
      }
      return { webContentsId: 7, tabId: "tab-a", viewport: { width: 400, height: 400 }, devicePixelRatio: 1 };
    } };
    return require(name);
  });
  const call = mod.exports.handlePreviewInputOp;
  const reset = () => { events.length = 0; activities.length = 0; probes = 0; destroyed = false; center = { x: 50, y: 30 }; onActivity = () => {}; onKey = () => {}; };

  // The page shifts while the cursor glides: the click lands on the target's new place.
  onActivity = (_params, n) => { if (n === 1) center = { x: 80, y: 70 }; };
  await call("mouse", { selector: "#buy" });
  assert.deepEqual(events.map((e) => [e.type, e.x, e.y]), [["mouseMove", 80, 70], ["mouseDown", 80, 70], ["mouseUp", 80, 70]], "input goes where the target is after the glide");
  assert.equal(activities.length, 2, "the cursor snaps to the new place");
  assert.equal(activities[1].follow, true);

  // A still page costs one extra probe and no extra move; explicit coordinates cost none.
  reset();
  await call("hover", { selector: "#buy" });
  assert.equal(activities.length, 1);
  assert.equal(probes, 2);
  reset();
  await call("mouse", { x: 10, y: 12 });
  assert.equal(probes, 0, "explicit coordinates are never re-measured");
  assert.equal(events[1].x, 10);

  // Stop during the glide: the renderer refuses the activity, and no input follows.
  reset();
  onActivity = () => { throw new Error("The user stopped Claude Code from using browser tab tab-a and took it back."); };
  await assert.rejects(call("mouse", { selector: "#buy" }), /The user stopped Claude Code/);
  await assert.rejects(call("scroll", { selector: "#list", deltaY: 200 }), /The user stopped Claude Code/);
  assert.equal(events.length, 0, "a stopped agent's click never reaches the page");

  // Stop mid-drag cancels it: Escape while the button is held, then back to
  // the start, then release, so nothing is dropped where the drag got to.
  reset();
  onActivity = (_params, n) => { if (n === 4) throw new Error("The user stopped Claude Code from using browser tab tab-a and took it back."); };
  await assert.rejects(call("drag", { from: { x: 10, y: 5 }, to: { x: 110, y: 5 }, steps: 10 }), /The user stopped/);
  assert.equal(events.at(-1).type, "mouseUp", "the page is not left with its button held");
  assert.deepEqual([events.at(-1).x, events.at(-1).y], [10, 5], "released where the drag began, not midway");
  assert.deepEqual([events.at(-2).type, events.at(-2).x, events.at(-2).y], ["mouseMove", 10, 5], "after moving back there");
  const escape = events.findIndex((e) => e.type === "key:rawKeyDown" && e.key === "Escape");
  assert.ok(escape > events.findIndex((e) => e.type === "mouseDown") && escape < events.length - 2, "Escape goes while the button is still held");
  assert.equal(events.filter((e) => e.type === "mouseUp").length, 1);

  // A finished drag releases once, at its end.
  reset();
  await call("drag", { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, steps: 4 });
  assert.deepEqual(events.filter((e) => e.type === "mouseUp").map((e) => [e.x, e.y]), [[100, 0]]);
  assert.equal(events.some((e) => e.key === "Escape"), false, "a finished drag is never cancelled");

  // The tab closes during the Escape: the agent still reads why the drag
  // stopped, and nothing is sent to the dead page.
  reset();
  const stop = new Error("The user stopped Claude Code from using browser tab tab-a and took it back.");
  onActivity = (_params, n) => { if (n === 4) throw stop; };
  let sentBeforeClose = -1;
  onKey = (command) => { if (command.key === "Escape" && sentBeforeClose < 0) { destroyed = true; sentBeforeClose = events.length; } };
  await assert.rejects(call("drag", { from: { x: 10, y: 5 }, to: { x: 110, y: 5 }, steps: 10 }), (error) => error === stop);
  assert.ok(sentBeforeClose > 0);
  assert.equal(events.length, sentBeforeClose, "no input after the tab closed");

  // A renderer that never answers the Escape: the button is released anyway,
  // and the Stop error arrives within the abort's cap.
  reset();
  onActivity = (_params, n) => { if (n === 4) throw stop; };
  onKey = (command) => (command.key === "Escape" ? new Promise(() => {}) : undefined);
  const started = Date.now();
  let deadline;
  const hung = new Promise((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("the drag never returned while the Escape hung")), 3000);
  });
  await assert.rejects(Promise.race([call("drag", { from: { x: 10, y: 5 }, to: { x: 110, y: 5 }, steps: 10 }), hung]), (error) => error === stop);
  clearTimeout(deadline);
  const held = Date.now() - started;
  assert.ok(held >= 450 && held < 1500, `the hung Escape cost about the cap: ${held}`);
  assert.deepEqual([events.at(-1).type, events.at(-1).x, events.at(-1).y], ["mouseUp", 10, 5], "and the button was released at the start");

  // The tab closed mid-drag: nothing is sent to the dead page, and the error is the close's.
  reset();
  onActivity = (_params, n) => { if (n === 3) { destroyed = true; throw new Error("No browser tab is open."); } };
  await assert.rejects(call("drag", { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, steps: 10 }), /No browser tab is open/);
  assert.equal(events.filter((e) => e.type === "mouseUp").length, 0);
  assert.equal(events.some((e) => e.key === "Escape"), false);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
