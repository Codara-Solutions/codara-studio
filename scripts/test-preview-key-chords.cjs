"use strict";
// Chords sent to a preview page (feedback round 5, item 1):
// - parseKeyChord / normalizeKeyModifiers (src/main/preview-keyboard.ts):
//   "Control+K", "Mod+Shift+P", "Cmd+," and modifier aliases, Mod per platform;
// - previewKeyEvents: the letter of a chord is lowercased unless Shift is held,
//   punctuation carries its US code and virtual key;
// - the guest chord router (src/main/browser/guest-chords.ts): a chord the
//   page handled stays in the page, an unhandled one reaches the app after
//   the page's report or a timeout, reserved chords always reach the app, and
//   an agent's keys never do.
// - F11 and F12 typed in a page always reach the app, Escape only while the
//   tab is full screen, and an agent's keys still never do.
// The real window path is tests/e2e/preview-agent-input.spec.ts and, for
// full screen, tests/e2e/browser-pane-toolbar.spec.ts.
//
//   node scripts/test-preview-key-chords.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function bundle(contents) {
  const out = esbuild.buildSync({
    stdin: { contents, resolveDir: path.join(ROOT, "src/main"), loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const lib = bundle(`
  export { parseKeyChord, normalizeKeyModifiers, previewKeyEvents } from "./preview-keyboard";
  export { createChordRouter, forwardGuestChords, isReservedChord, isReservedPlainKey } from "./browser/guest-chords";
`);

function chords() {
  const { parseKeyChord, normalizeKeyModifiers } = lib;
  assert.deepEqual(parseKeyChord("Control+K", [], "linux"), { key: "K", modifiers: ["control"] });
  assert.deepEqual(parseKeyChord("ctrl+shift+p", [], "linux"), { key: "p", modifiers: ["control", "shift"] });
  assert.deepEqual(parseKeyChord("Mod+K", [], "darwin"), { key: "K", modifiers: ["meta"] });
  assert.deepEqual(parseKeyChord("Mod+K", [], "win32"), { key: "K", modifiers: ["control"] });
  assert.deepEqual(parseKeyChord("Cmd+,", [], "darwin"), { key: ",", modifiers: ["meta"] });
  assert.deepEqual(parseKeyChord("Control++", [], "linux"), { key: "+", modifiers: ["control"] });
  assert.deepEqual(parseKeyChord("+", [], "linux"), { key: "+", modifiers: [] });
  assert.deepEqual(parseKeyChord("k", ["Ctrl", "Option"], "linux"), { key: "k", modifiers: ["control", "alt"] });
  assert.deepEqual(parseKeyChord("Shift+Control+K", ["control"], "linux").modifiers.sort(), ["control", "shift"]);
  assert.throws(() => parseKeyChord("Hyper+K", [], "linux"), /Unsupported key chord: Hyper\+K\. Write it like Control\+K/);
  assert.throws(() => parseKeyChord("Control+", [], "linux"), /Unsupported key chord/);
  assert.deepEqual(normalizeKeyModifiers(["cmdorctrl", "SHIFT", "bogus", 3], "darwin"), ["meta", "shift"]);
  assert.deepEqual(normalizeKeyModifiers("control", "linux"), []);
}

function events() {
  const { previewKeyEvents } = lib;
  const ctrlK = previewKeyEvents("K", ["control"], null);
  assert.equal(ctrlK[0].key, "k", "Ctrl+K reports key k, as a keyboard does");
  assert.equal(ctrlK[0].code, "KeyK");
  assert.equal(ctrlK[0].windowsVirtualKeyCode, 75);
  assert.equal(ctrlK[0].type, "rawKeyDown", "a chord inserts no text");
  assert.equal(ctrlK[0].modifiers, 2);
  assert.equal(previewKeyEvents("p", ["control", "shift"], null)[0].key, "P", "Ctrl+Shift+P reports P");
  assert.equal(previewKeyEvents("K", ["meta"], null)[0].modifiers, 4);
  assert.equal(previewKeyEvents("K", [], null)[0].key, "K", "a plain letter keeps its case");
  assert.equal(previewKeyEvents("K", ["shift"], null)[0].text, "K");
  const slash = previewKeyEvents("/", ["control"], null)[0];
  assert.equal(slash.code, "Slash");
  assert.equal(slash.windowsVirtualKeyCode, 191);
  assert.equal(previewKeyEvents(",", ["meta"], null)[0].code, "Comma");
}

function reserved() {
  const { isReservedChord } = lib;
  assert.equal(isReservedChord({ key: "w", modifiers: ["control"] }), true);
  assert.equal(isReservedChord({ key: "W", modifiers: ["meta"] }), true);
  assert.equal(isReservedChord({ key: "Tab", modifiers: ["control"] }), true);
  assert.equal(isReservedChord({ key: "Tab", modifiers: ["control", "shift"] }), true);
  assert.equal(isReservedChord({ key: "k", modifiers: ["control"] }), false);
  assert.equal(isReservedChord({ key: "w", modifiers: ["control", "shift"] }), false);
  assert.equal(isReservedChord({ key: "w", modifiers: ["control", "alt"] }), false);
}

function router() {
  const timers = new Map();
  let nextTimer = 1;
  const forwarded = [];
  const make = () =>
    lib.createChordRouter({
      forward: (input) => forwarded.push(input.key),
      setTimer: (fn) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });
  const fire = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  const ctrl = (key, code) => ({ key, code, modifiers: ["control"] });

  // Without the page preload (file previews) every chord goes to the app at once.
  const bare = make();
  bare.keyDown(ctrl("k", "KeyK"));
  bare.keyDown({ key: "k", modifiers: [] });
  bare.keyDown({ key: "K", modifiers: ["shift"] });
  assert.deepEqual(forwarded.splice(0), ["k"], "only chords with Control, Alt or Meta are forwarded");

  const page = make();
  page.reporterReady();
  page.keyDown(ctrl("k", "KeyK"));
  assert.deepEqual(forwarded, [], "the page sees a chord first");
  page.report({ key: "k", code: "KeyK", handled: true });
  assert.equal(timers.size, 0);
  assert.deepEqual(forwarded, [], "a chord the page handled stays in the page");

  page.keyDown(ctrl("p", "KeyP"));
  page.report({ key: "p", code: "KeyP", handled: false });
  assert.deepEqual(forwarded.splice(0), ["p"], "an unhandled chord reaches the app");

  page.keyDown(ctrl("1", "Digit1"));
  fire();
  assert.deepEqual(forwarded.splice(0), ["1"], "no report in time: the app gets it");
  page.report({ key: "1", code: "Digit1", handled: true });
  assert.deepEqual(forwarded, [], "a late report is ignored");

  page.keyDown(ctrl("w", "KeyW"));
  assert.deepEqual(forwarded.splice(0), ["w"], "reserved chords skip the page's verdict");

  page.agentKeysStart();
  page.keyDown(ctrl("k", "KeyK"));
  page.keyDown(ctrl("w", "KeyW"));
  page.agentKeysEnd();
  fire();
  assert.deepEqual(forwarded, [], "an agent's keys never reach the app, reserved or not");
  page.agentKeysEnd();
  page.keyDown(ctrl("j", "KeyJ"));
  page.report({ key: "j", code: "KeyJ", handled: false });
  assert.deepEqual(forwarded.splice(0), ["j"], "an unbalanced end does not leave the guard negative");

  page.keyDown(ctrl("a", "KeyA"));
  page.keyDown(ctrl("b", "KeyB"));
  page.report({ key: "b", code: "KeyB", handled: false });
  page.report({ key: "a", code: "KeyA", handled: true });
  assert.deepEqual(forwarded.splice(0), ["b"], "reports match their own key");
  page.keyDown(ctrl("c", "KeyC"));
  page.dispose();
  fire();
  assert.deepEqual(forwarded, [], "dispose drops pending chords");
}

// The guest keeps F11 from Electron's default menu only when it is the pane's
// own key: Shift+F11 is Step Out in a code editor running in the page.
function guestF11() {
  const { forwardGuestChords } = lib;
  const handlers = {};
  const contents = {
    id: 9001,
    on: (name, fn) => { handlers[name] = fn; },
    once: () => {},
    isDestroyed: () => false,
    hostWebContents: { isDestroyed: () => false, send: () => {} },
  };
  forwardGuestChords(contents);
  const prevented = (key, modifiers) => {
    let taken = false;
    handlers["before-input-event"]({ preventDefault: () => { taken = true; } }, { type: "keyDown", key, code: key, modifiers });
    return taken;
  };
  assert.equal(prevented("F11", []), true, "plain F11 is the pane's full screen");
  assert.equal(prevented("F11", ["shift"]), false, "Shift+F11 stays with the page");
  assert.equal(prevented("F11", ["control"]), false, "Ctrl+F11 stays with the page");
  assert.equal(prevented("F10", []), false);
}

function fullScreenKeys() {
  const { createChordRouter, isReservedPlainKey } = lib;
  const plain = (key) => ({ key, modifiers: [] });
  assert.equal(isReservedPlainKey(plain("F11"), false), true);
  assert.equal(isReservedPlainKey(plain("F12"), false), true);
  assert.equal(isReservedPlainKey(plain("Escape"), false), false, "Escape stays in the page outside full screen");
  assert.equal(isReservedPlainKey(plain("Escape"), true), true);
  assert.equal(isReservedPlainKey({ key: "F11", modifiers: ["shift"] }, false), false);
  assert.equal(isReservedPlainKey({ key: "Escape", modifiers: ["control"] }, true), false);
  assert.equal(isReservedPlainKey({ key: "F12", modifiers: ["isautorepeat"] }, false), true, "a held key is still the key");
  assert.equal(isReservedPlainKey(plain("a"), true), false);

  const forwarded = [];
  const timers = [];
  const page = createChordRouter({
    forward: (input) => forwarded.push(input.key),
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  page.reporterReady();
  page.keyDown(plain("F11"));
  page.keyDown(plain("F12"));
  page.keyDown(plain("Escape"));
  assert.deepEqual(forwarded.splice(0), ["F11", "F12"], "F11 and F12 reach the app at once, without waiting for the page");
  page.setFullScreen(true);
  page.keyDown(plain("Escape"));
  page.keyDown(plain("Enter"));
  assert.deepEqual(forwarded.splice(0), ["Escape"], "full screen: Escape reaches the app");
  page.agentKeysStart();
  page.keyDown(plain("Escape"));
  page.keyDown(plain("F11"));
  page.agentKeysEnd();
  assert.deepEqual(forwarded.splice(0), [], "an agent's Escape never leaves full screen");
  page.setFullScreen(false);
  page.keyDown(plain("Escape"));
  assert.deepEqual(forwarded.splice(0), [], "out of full screen, Escape is the page's again");
  assert.equal(timers.length, 0, "plain keys never wait for a page report");
}

chords();
events();
reserved();
router();
fullScreenKeys();
guestF11();
console.log("preview key chords: chord notation, case and codes, reserved chords, page-first routing, agent keys kept from the app, full screen keys");
