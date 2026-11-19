"use strict";
// Which paired Firefoxes really went away, for the "Load Codara in Firefox
// again" notice (src/renderer/src/components/chrome/firefox-gone.ts), on fake
// timers: a drop counts only after the wait; back in time, it never counts;
// once per disconnect; and never for a browser the user unpaired or
// disconnected, also when they did it while the wait was running.
//
//   node scripts/test-firefox-gone.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/components/chrome/firefox-gone.ts")],
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function fakeClock() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    set(callback, ms) { const id = next++; pending.set(id, { at: now + ms, callback }); return id; },
    clear(id) { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && pending.has(id)) { pending.delete(id); timer.callback(); }
      }
    },
    get pending() { return pending.size; },
  };
}

const firefox = (linkId, connected) => ({ linkId, connected, browser: { name: "Firefox" } });
const chrome = (linkId, connected) => ({ linkId, connected, browser: { name: "Chrome" } });

(async () => {
  const { GoneFirefoxTracker } = await load();
  const WAIT = 45_000;
  const setup = () => {
    const clock = fakeClock();
    const changes = [];
    const tracker = new GoneFirefoxTracker(WAIT, (gone) => changes.push(gone), clock);
    return { clock, changes, tracker, gone: () => changes.at(-1) ?? [] };
  };

  // Drops and stays away: counted after the wait, not before.
  {
    const { clock, tracker, gone } = setup();
    tracker.update([firefox("a", true)]);
    tracker.update([firefox("a", false)]);
    clock.advance(WAIT - 1);
    assert.deepEqual(gone(), []);
    clock.advance(1);
    assert.deepEqual(gone(), ["a"]);
    // Once per disconnect: more updates while away add nothing.
    tracker.update([firefox("a", false)]);
    clock.advance(WAIT * 2);
    assert.deepEqual(gone(), ["a"]);
    // Back connected: no longer gone; a later drop counts again.
    tracker.update([firefox("a", true)]);
    assert.deepEqual(gone(), []);
    tracker.update([firefox("a", false)]);
    clock.advance(WAIT);
    assert.deepEqual(gone(), ["a"]);
  }

  // A blink (back within the wait, as the add-on's own 30 s reconnect): never counted.
  {
    const { clock, tracker, gone } = setup();
    tracker.update([firefox("a", true)]);
    tracker.update([firefox("a", false)]);
    clock.advance(30_000);
    tracker.update([firefox("a", true)]);
    clock.advance(WAIT * 2);
    assert.deepEqual(gone(), []);
    assert.equal(clock.pending, 0);
  }

  // The real unpair case: Firefox drops, then within the wait the user
  // presses Disconnect (or unpairs): the browser leaves the list, no notice.
  {
    const { clock, tracker, gone } = setup();
    tracker.update([firefox("a", true)]);
    tracker.update([firefox("a", false)]);
    clock.advance(10_000);
    tracker.update([]);
    assert.equal(clock.pending, 0, "the wait is forgotten when the browser leaves the list");
    clock.advance(WAIT * 2);
    assert.deepEqual(gone(), []);
  }

  // Gone, then disconnected in Settings: the notice goes.
  {
    const { clock, tracker, gone } = setup();
    tracker.update([firefox("a", true)]);
    tracker.update([firefox("a", false)]);
    clock.advance(WAIT);
    assert.deepEqual(gone(), ["a"]);
    tracker.update([]);
    assert.deepEqual(gone(), []);
  }

  // Never seen connected (Codara started with Firefox closed), and Chrome: never counted.
  {
    const { clock, tracker, gone } = setup();
    tracker.update([firefox("a", false), chrome("c", true)]);
    tracker.update([firefox("a", false), chrome("c", false)]);
    clock.advance(WAIT * 2);
    assert.deepEqual(gone(), []);
  }

  // Disposed (the notice unmounted): no wait left running.
  {
    const { clock, tracker, changes } = setup();
    tracker.update([firefox("a", true)]);
    tracker.update([firefox("a", false)]);
    tracker.dispose();
    assert.equal(clock.pending, 0);
    clock.advance(WAIT * 2);
    assert.deepEqual(changes, []);
  }

  console.log("ok firefox gone");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
