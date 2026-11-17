import assert from "node:assert/strict";

import {
  PRESENCE_INSTALL,
  hidesPresence,
  newerSettings,
  pointerOf,
  presenceCall,
  presenceSettings,
  presenceView,
} from "../lib/presence.js";

export function run() {
  // What the agent captures never shows the overlay; its own commands never move it.
  for (const method of ["Page.captureScreenshot", "DOMSnapshot.captureSnapshot", "DOM.getDocument", "Accessibility.getFullAXTree", "Page.printToPDF"]) {
    assert.equal(hidesPresence(method), true, method);
  }
  assert.equal(hidesPresence("Runtime.evaluate"), false, "the snapshot script reads <body>; the overlay hangs off <html>, aria-hidden");
  assert.deepEqual(pointerOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 10.4, y: 20.6 }), { x: 10, y: 21, press: true });
  assert.deepEqual(pointerOf("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }), { x: 1, y: 2, press: false });
  assert.equal(pointerOf("Input.dispatchKeyEvent", { x: 1, y: 2 }), null);
  assert.equal(pointerOf("Input.dispatchMouseEvent", { x: "1", y: 2 }), null);

  // Settings: both on by default, the newer change wins, a tie keeps what is held.
  assert.deepEqual(presenceSettings(undefined), { overlay: true, glow: true, at: 0 });
  assert.deepEqual(presenceSettings({ glow: false, at: 5 }), { overlay: true, glow: false, at: 5 });
  assert.deepEqual(newerSettings({ glow: false, at: 5 }, { glow: true, at: 9 }), { overlay: true, glow: true, at: 9 });
  assert.deepEqual(newerSettings({ glow: false, at: 9 }, { glow: true, at: 9 }), { overlay: true, glow: false, at: 9 });

  // The page gets plain data: a clean name and colours from a fixed set.
  const view = presenceView({ name: "Claude Code\u0007</b><img>", runtime: "claude", glow: false, state: "working" });
  assert.equal(view.name, "Claude Code </b><img>", "control characters go; the page sets it as text, never HTML");
  assert.equal(view.light, "oklch(0.58 0.17 50)");
  assert.equal(view.glow, false);
  assert.equal(presenceView({ runtime: "x;}body{display:none" }).light, "#2aa298", "an unknown agent uses the accent");
  assert.equal(presenceView({ name: "", state: "stopped" }).state, "stopped");
  assert.equal(presenceView({ name: "A".repeat(99) }).name.length, 40);

  // Calls are JSON, never code built from strings.
  assert.equal(presenceCall("move", 1, 2, true), 'globalThis.__codaraPresence ? globalThis.__codaraPresence.move(1, 2, true) : null');
  assert.match(presenceCall("show", { name: '"); alert(1); ("' }), /show\(\{"name":"\\"\); alert\(1\); \(\\""\}\)/);
  assert.throws(() => presenceCall("eval"), /Unknown presence call/);
  assert.match(PRESENCE_INSTALL, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(PRESENCE_INSTALL, /aria-hidden/);
  assert.doesNotMatch(PRESENCE_INSTALL, /innerText|document\.(body|title|cookie|querySelector|getElement)|location\.|localStorage/, "the overlay reads nothing from the page");
  return "presence: captures hide the overlay, the pointer follows the agent's mouse, settings sync by time, the page gets plain data";
}
