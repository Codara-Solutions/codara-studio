import assert from "node:assert/strict";
import vm from "node:vm";

import {
  PRESENCE_INSTALL,
  hidesPresence,
  isPresenceNode,
  newerSettings,
  pointerOf,
  presenceCall,
  presenceSettings,
  presenceView,
  withoutPresenceNodes,
} from "../lib/presence.js";

// Just enough DOM for the page script: elements that keep their listeners and classes.
function fakePage() {
  const element = () => {
    const classes = new Set();
    const listeners = {};
    return {
      listeners,
      style: { cssText: "", setProperty() {} },
      isConnected: false,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
      addEventListener(type, listener) {
        (listeners[type] ??= []).push(listener);
      },
      setAttribute() {},
      append() {},
      replaceChildren() {},
      remove() {
        this.isConnected = false;
      },
    };
  };
  const parts = {};
  const document = {
    createElement() {
      const node = element();
      node.attachShadow = () => ({
        set innerHTML(_html) {},
        querySelector: (selector) => (parts[selector] ??= element()),
      });
      return node;
    },
    documentElement: { append: (node) => (node.isConnected = true) },
  };
  const context = vm.createContext({ document, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout });
  const api = vm.runInContext(`${PRESENCE_INSTALL}; globalThis.__codaraPresence`, context);
  const fire = (target, type) => {
    const event = { isTrusted: true, prevented: false, stopPropagation() {}, preventDefault() { this.prevented = true; } };
    for (const listener of target.listeners[type] ?? []) listener(event);
    return event;
  };
  return { api, parts, fire };
}

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
  // The page script itself.
  const { api, parts, fire } = fakePage();
  // Values from the page's realm, compared as data.
  const take = () => JSON.parse(JSON.stringify(api.take()));
  const viewOf = (serial, state = "working") => presenceView({ name: `Agent ${serial}`, serial, state });
  api.show(viewOf(1), 10_000);
  // A Stop is bound to the agent shown when it was pressed, even if another
  // agent takes the pill before the extension reads it.
  fire(parts.button, "click");
  api.show(viewOf(2), 10_000);
  assert.deepEqual(take(), [{ action: "stop", serial: 1 }]);
  // The pill lets clicks through only while the agent's input is dispatched.
  api.hold(true, 5, 6, true);
  assert.equal(parts[".pill"].classList.contains("agent-input"), true);
  fire(parts.button, "click");
  assert.deepEqual(take(), [], "a click during the agent's input is the agent's");
  api.hold(false);
  assert.equal(parts[".pill"].classList.contains("agent-input"), false, "the user's Stop works again right after");
  fire(parts.button, "click");
  assert.deepEqual(take(), [{ action: "stop", serial: 2 }]);
  // Pressing the pill never moves the page's focus.
  assert.equal(fire(parts[".pill"], "mousedown").prevented, true);
  // Concealing says when the overlay is really out.
  assert.equal(api.conceal(true), true);
  api.show(viewOf(2), 10_000);
  assert.equal(api.conceal(true), true, "a redraw while concealed stays out");
  assert.equal(api.conceal(false), true);
  api.remove();

  // DOM events never carry the overlay's host.
  const host = { nodeName: "DIV", attributes: ["aria-hidden", "true", "style", "all: initial !important; position: fixed !important; inset: 0px !important; z-index: 2147483647 !important;"] };
  const page = { nodeName: "DIV", attributes: ["style", "z-index: 2"] };
  assert.equal(isPresenceNode(host), true);
  assert.equal(isPresenceNode(page), false);
  assert.equal(isPresenceNode({ nodeName: "DIV", attributes: ["title", "z-index: 2147483647 !important"] }), false, "only the style attribute counts");
  assert.equal(withoutPresenceNodes("DOM.childNodeInserted", { parentNodeId: 1, node: host }), null);
  assert.deepEqual(withoutPresenceNodes("DOM.setChildNodes", { parentId: 1, nodes: [{ nodeName: "BODY", children: [page, host] }, host] }), { parentId: 1, nodes: [{ nodeName: "BODY", children: [page] }] });
  for (const method of ["DOM.describeNode", "DOM.getOuterHTML", "DOM.requestChildNodes", "DOM.performSearch", "DOM.getNodeForLocation"]) {
    assert.equal(hidesPresence(method), true, method);
  }

  return "presence: captures hide the overlay, the pointer follows the agent's mouse, settings sync by time, the page gets plain data, Stop is bound to the agent shown and works between its inputs, DOM events skip the overlay";
}
