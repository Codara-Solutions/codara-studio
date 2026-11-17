import assert from "node:assert/strict";
import vm from "node:vm";

import {
  PRESENCE_INSTALL,
  PRESENCE_WORLD,
  hidesPresence,
  holdsPresence,
  isPresenceNode,
  newerSettings,
  pointerOf,
  presenceCall,
  presenceClick,
  presenceSettings,
  presenceView,
  presenceWorldError,
  withoutPresenceNodes,
} from "../lib/presence.js";

// Just enough DOM for the page script: elements that keep their listeners,
// classes and text, and a record of everything made.
function fakePage() {
  const made = [];
  const element = (tag) => {
    const classes = new Set();
    const listeners = {};
    const node = {
      tag,
      listeners,
      children: [],
      text: "",
      hidden: false,
      style: { cssText: "", transform: "", vars: {}, setProperty(name, value) { this.vars[name] = value; } },
      isConnected: false,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
      set className(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
      get className() { return [...classes].join(" "); },
      set textContent(value) { this.text = String(value); },
      get textContent() { return this.text + this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join(""); },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; this.text = ""; },
      remove() { this.isConnected = false; },
      attachShadow() {
        const root = { adoptedStyleSheets: [], children: [], append(...children) { this.children.push(...children); } };
        node.shadow = root;
        return root;
      },
    };
    made.push(node);
    return node;
  };
  const sheets = [];
  class CSSStyleSheet {
    replaceSync(text) { this.text = text; sheets.push(text); }
  }
  const document = {
    createElement: (tag) => element(tag),
    createElementNS: (_ns, tag) => element(tag),
    documentElement: { append: (node) => (node.isConnected = true) },
  };
  const context = vm.createContext({ document, CSSStyleSheet, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout });
  const api = vm.runInContext(`${PRESENCE_INSTALL}; globalThis.__codaraPresence`, context);
  const find = (test) => made.find(test);
  const fire = (target, type) => {
    const event = { isTrusted: true, prevented: false, stopPropagation() {}, preventDefault() { this.prevented = true; } };
    for (const listener of target.listeners[type] ?? []) listener(event);
    return event;
  };
  return { api, find, fire, sheets };
}

export function run() {
  // What the agent captures never shows the overlay.
  for (const method of ["Page.captureScreenshot", "DOMSnapshot.captureSnapshot", "DOM.getDocument", "Accessibility.getFullAXTree", "Page.printToPDF", "DOM.describeNode", "DOM.getOuterHTML", "DOM.requestChildNodes", "DOM.performSearch", "DOM.getNodeForLocation"]) {
    assert.equal(hidesPresence(method), true, method);
  }
  assert.equal(hidesPresence("Runtime.evaluate"), false, "the snapshot script reads <body>; the overlay hangs off <html>, aria-hidden");
  // Scripts hold the pill open too, so a fixed element under it stays clickable by selector.
  for (const method of ["Input.dispatchMouseEvent", "Input.insertText", "Runtime.evaluate", "Runtime.callFunctionOn"]) assert.equal(holdsPresence(method), true, method);
  assert.equal(holdsPresence("Page.navigate"), false);
  assert.deepEqual(pointerOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 10.4, y: 20.6 }), { x: 10, y: 21, press: true });
  assert.deepEqual(pointerOf("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }), { x: 1, y: 2, press: false });
  assert.equal(pointerOf("Input.dispatchKeyEvent", { x: 1, y: 2 }), null);
  assert.equal(pointerOf("Input.dispatchMouseEvent", { x: "1", y: 2 }), null);

  // The overlay's own world is not the agent's.
  assert.match(presenceWorldError("Page.createIsolatedWorld", { worldName: PRESENCE_WORLD }, 7), /reserved/);
  assert.equal(presenceWorldError("Page.createIsolatedWorld", { worldName: "mine" }, 7), null);
  assert.match(presenceWorldError("Runtime.evaluate", { expression: "1", contextId: 7 }, 7), /belongs to the Codara extension/);
  assert.match(presenceWorldError("Runtime.getProperties", { executionContextId: 7 }, 7), /belongs/);
  assert.equal(presenceWorldError("Runtime.evaluate", { expression: "1" }, 7), null, "the page's own world is fine");
  assert.equal(presenceWorldError("Runtime.evaluate", { contextId: 7 }, null), null);

  // Settings: both on by default, the newer change wins, a tie keeps what is held.
  assert.deepEqual(presenceSettings(undefined), { overlay: true, glow: true, at: 0 });
  assert.deepEqual(presenceSettings({ glow: false, at: 5 }), { overlay: true, glow: false, at: 5 });
  assert.deepEqual(newerSettings({ glow: false, at: 5 }, { glow: true, at: 9 }), { overlay: true, glow: true, at: 9 });
  assert.deepEqual(newerSettings({ glow: false, at: 9 }, { glow: true, at: 9 }), { overlay: true, glow: false, at: 9 });

  // The page gets plain data: a clean name, colours from a fixed set, an opaque id.
  const view = presenceView({ name: "Claude Code\u0007</b><img>", runtime: "claude", glow: false, state: "working", id: "3f1c-aa" });
  assert.equal(view.name, "Claude Code </b><img>", "control characters go; the page sets it as text, never HTML");
  assert.equal(view.light, "oklch(0.58 0.17 50)");
  assert.equal(view.glow, false);
  assert.equal(view.id, "3f1c-aa");
  assert.equal(presenceView({ id: "x\"; alert(1)" }).id, "", "an id is word characters only");
  assert.equal(presenceView({ runtime: "x;}body{display:none" }).light, "#2aa298", "an unknown agent uses the accent");
  assert.equal(presenceView({ name: "", state: "stopped" }).state, "stopped");
  assert.equal(presenceView({ name: "A".repeat(99) }).name.length, 40);
  // What take() returns is checked before it means anything.
  assert.deepEqual(presenceClick({ action: "stop", id: "ab-1" }), { id: "ab-1" });
  for (const bad of [null, "stop", { action: "undo", id: "a" }, { action: "stop", id: 3 }, { action: "stop", id: "a b" }]) assert.equal(presenceClick(bad), null, JSON.stringify(bad));

  // Calls are JSON, never code built from strings.
  assert.equal(presenceCall("move", 1, 2, true), 'globalThis.__codaraPresence ? globalThis.__codaraPresence.move(1, 2, true) : null');
  assert.match(presenceCall("show", { name: '"); alert(1); ("' }), /show\(\{"name":"\\"\); alert\(1\); \(\\""\}\)/);
  assert.throws(() => presenceCall("eval"), /Unknown presence call/);
  assert.match(PRESENCE_INSTALL, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(PRESENCE_INSTALL, /adoptedStyleSheets/, "styles through a constructed sheet, which a page's CSP cannot block");
  assert.doesNotMatch(PRESENCE_INSTALL, /innerHTML/, "no markup parsing");
  assert.match(PRESENCE_INSTALL, /@media print/);
  assert.doesNotMatch(PRESENCE_INSTALL, /innerText|document\.(body|title|cookie|querySelector|getElement)|location\.|localStorage/, "the overlay reads nothing from the page");

  // The page script itself.
  const { api, find, fire, sheets } = fakePage();
  // Values from the page's realm, compared as data.
  const take = () => JSON.parse(JSON.stringify(api.take()));
  const viewOf = (id, state = "working") => presenceView({ name: `Agent ${id}`, id, state });
  assert.equal(api.show(viewOf("a1"), 10_000), "new", "the first show makes the host");
  assert.equal(api.show(viewOf("a1"), 10_000), true);
  assert.equal(sheets.length, 1);
  const host = find((node) => node.shadow);
  const button = find((node) => node.tag === "button");
  const pill = find((node) => node.className.includes("pill"));
  const wrap = find((node) => node.className === "r");
  assert.equal(api.hostNode(), host);
  assert.equal(wrap.style.vars["--c"], "#2aa298", "the colour lives inside the shadow root");
  assert.equal(host.style.vars["--c"], undefined, "nothing on the host for the page to read");
  // A Stop is bound to the agent shown when it was pressed, even if another
  // agent takes the pill before the extension reads it.
  fire(button, "click");
  api.show(viewOf("b2"), 10_000);
  assert.deepEqual(take(), [{ action: "stop", id: "a1" }]);
  // The pill lets clicks through only while the agent's command runs.
  api.hold(true, 5, 6, true);
  assert.equal(pill.classList.contains("agent-input"), true);
  fire(button, "click");
  assert.deepEqual(take(), [], "a click during the agent's input is the agent's");
  api.hold(false);
  assert.equal(pill.classList.contains("agent-input"), false, "the user's Stop works again right after");
  fire(button, "click");
  assert.deepEqual(take(), [{ action: "stop", id: "b2" }]);
  // Pressing the pill never moves the page's focus.
  assert.equal(fire(pill, "mousedown").prevented, true);
  // After Stop the pill says how to give it back, and offers no button.
  api.show(viewOf("b2", "stopped"), 10_000);
  assert.equal(button.hidden, true);
  assert.match(pill.textContent, /Stopped Agent b2\. Give it back from the Codara popup\./);
  fire(button, "click");
  assert.deepEqual(take(), [], "nothing to press on a stopped pill");
  api.show(presenceView({ name: "Old", id: "c3", state: "stopped", keyless: true }), 10_000);
  assert.match(pill.textContent, /Share the tab again from the Codara popup/, "an older Codara offers no give-back that does nothing");
  // Concealing says when the overlay is really out.
  assert.equal(api.conceal(true), true);
  api.show(viewOf("b2"), 10_000);
  assert.equal(host.isConnected, false, "a redraw while concealed stays out");
  assert.equal(api.conceal(false), true);
  assert.equal(host.isConnected, true);
  api.remove();

  // DOM events never carry the overlay's host: by backend node id, or by style before it is known.
  const hostNode = { nodeId: 40, backendNodeId: 900, nodeName: "DIV", attributes: ["aria-hidden", "true"], shadowRoots: [{ nodeId: 41, children: [{ nodeId: 42 }] }] };
  const styled = { nodeId: 50, nodeName: "DIV", attributes: ["style", "all: initial !important; position: fixed !important; inset: 0px !important; z-index: 2147483647 !important;"] };
  const page = { nodeId: 60, nodeName: "DIV", attributes: ["style", "z-index: 2"] };
  const hidden = { backendIds: new Set([900]), nodeIds: new Set(), contextId: 7 };
  assert.equal(isPresenceNode(hostNode, hidden.backendIds), true);
  assert.equal(isPresenceNode(styled), true);
  assert.equal(isPresenceNode(page), false);
  assert.equal(isPresenceNode({ nodeName: "DIV", attributes: ["title", "z-index: 2147483647 !important"] }), false, "only the style attribute counts");
  assert.equal(withoutPresenceNodes("DOM.childNodeInserted", { parentNodeId: 1, node: hostNode }, hidden), null);
  assert.deepEqual([...hidden.nodeIds].sort(), [40, 41, 42], "its subtree is remembered");
  assert.equal(withoutPresenceNodes("DOM.attributeModified", { nodeId: 40, name: "style", value: "x" }, hidden), null);
  assert.equal(withoutPresenceNodes("DOM.shadowRootPushed", { hostId: 40, root: {} }, hidden), null);
  assert.equal(withoutPresenceNodes("DOM.childNodeCountUpdated", { nodeId: 41, childNodeCount: 3 }, hidden), null);
  assert.deepEqual(withoutPresenceNodes("DOM.inlineStyleInvalidated", { nodeIds: [40, 60] }, hidden), { nodeIds: [60] });
  assert.deepEqual(withoutPresenceNodes("DOM.setChildNodes", { parentId: 1, nodes: [{ nodeId: 2, nodeName: "BODY", children: [page, styled] }, hostNode] }, hidden), { parentId: 1, nodes: [{ nodeId: 2, nodeName: "BODY", children: [page] }] });
  assert.equal(withoutPresenceNodes("DOM.childNodeRemoved", { parentNodeId: 1, nodeId: 40 }, hidden), null);
  assert.equal(hidden.nodeIds.has(40), false);
  assert.equal(withoutPresenceNodes("Runtime.executionContextDestroyed", { executionContextId: 7 }, hidden), null);
  assert.deepEqual(withoutPresenceNodes("Runtime.executionContextDestroyed", { executionContextId: 3 }, hidden), { executionContextId: 3 });
  assert.deepEqual(withoutPresenceNodes("DOM.attributeModified", { nodeId: 60, name: "a", value: "b" }, hidden), { nodeId: 60, name: "a", value: "b" });

  return "presence: captures and recordings hide the overlay, scripts and input hold the pill open, its world is reserved, Stop is bound to the agent shown with no Undo on the page, DOM events skip the overlay";
}
