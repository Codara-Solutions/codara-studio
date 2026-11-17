// The agent's presence on a shared tab of the user's own browser: a pointer
// in the agent's colour with its name, a thin glow around the page and a
// "<agent> working: Stop" pill. Drawn through the debugger session the
// extension already holds, in an isolated world the page's scripts cannot
// reach, inside a closed shadow root hung off <html> (outside <body>, where
// Codara's snapshots read) and marked aria-hidden. A page can notice the host
// element and remove it, but cannot read the agent's name or press Stop for
// the user. Nothing in it reads the page: the only thing that leaves it is
// the user's click on Stop. No chrome.* here, so the tests run it in Node.

export const PRESENCE_WORLD = "codara-presence";

/** How long the pill and glow stay after the agent's last call, and the "Stopped" notice after Stop. */
export const PRESENCE_IDLE_MS = 8_000;
export const PRESENCE_STOPPED_MS = 6_000;

// Read only from the page: these commands capture what the page shows or
// holds, so the overlay is taken out for them and put back after.
const CAPTURE_METHODS = new Set([
  "Page.captureScreenshot",
  "Page.captureSnapshot",
  "Page.printToPDF",
  "DOMSnapshot.captureSnapshot",
  "DOMSnapshot.getSnapshot",
  "DOM.getDocument",
  "DOM.getFlattenedDocument",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.queryAXTree",
  "Accessibility.getRootAXNode",
  // DOM reads that can pierce the closed shadow root.
  "DOM.describeNode",
  "DOM.getOuterHTML",
  "DOM.requestChildNodes",
  "DOM.performSearch",
  "DOM.getSearchResults",
  "DOM.getNodeForLocation",
  "DOM.querySelector",
  "DOM.querySelectorAll",
]);

/** Whether a command the agent sends must not see the overlay. */
export function hidesPresence(method) {
  return CAPTURE_METHODS.has(String(method ?? ""));
}

/** Whether a command is the agent's input on the page (a click, a key, touch). */
export function isAgentInput(method) {
  return String(method ?? "").startsWith("Input.");
}

/**
 * Whether the pill must let clicks through while this command runs: the
 * agent's input, and scripts, whose own hit tests (elementFromPoint) would
 * otherwise find the pill over a fixed element at the bottom of the page.
 */
export function holdsPresence(method) {
  return isAgentInput(method) || method === "Runtime.evaluate" || method === "Runtime.callFunctionOn";
}

/**
 * An agent's command that would reach into the overlay's own world: creating
 * a world of the same name, or running in its context. Returns the refusal,
 * or null.
 */
export function presenceWorldError(method, params, contextId) {
  const record = params && typeof params === "object" ? params : {};
  if (method === "Page.createIsolatedWorld" && record.worldName === PRESENCE_WORLD) return "That world name is reserved by the Codara extension.";
  if (String(method ?? "").startsWith("Runtime.") && contextId != null && (record.contextId === contextId || record.executionContextId === contextId)) {
    return "That execution context belongs to the Codara extension.";
  }
  return null;
}

// The host's inline style. A node with it is the overlay even before its
// backend node id is known.
const HOST_STYLE = "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;";

/** Whether a CDP DOM node is the overlay's host: by its backend node id, or its inline style. */
export function isPresenceNode(node, backendIds = new Set()) {
  if (!node || typeof node !== "object") return false;
  if (backendIds.has(node.backendNodeId)) return true;
  if (node.nodeName !== "DIV" || !Array.isArray(node.attributes)) return false;
  const style = node.attributes.indexOf("style");
  return style >= 0 && style % 2 === 0 && String(node.attributes[style + 1] ?? "").includes("z-index: 2147483647 !important");
}

function collect(node, ids) {
  if (Number.isInteger(node?.nodeId)) ids.add(node.nodeId);
  for (const child of [...(node?.children ?? []), ...(node?.shadowRoots ?? [])]) collect(child, ids);
}

function strip(nodes, hidden) {
  const kept = [];
  for (const node of nodes) {
    if (isPresenceNode(node, hidden.backendIds)) collect(node, hidden.nodeIds);
    else kept.push(Array.isArray(node.children) ? { ...node, children: strip(node.children, hidden) } : node);
  }
  return kept;
}

/**
 * A DOM or Runtime event's params without the overlay, or null when the
 * event is only about it. hidden: { backendIds, nodeIds, contextId } for the
 * tab; node ids of filtered nodes are added, so later events about them drop.
 */
export function withoutPresenceNodes(method, params, hidden = { backendIds: new Set(), nodeIds: new Set(), contextId: null }) {
  if (!params || typeof params !== "object") return params;
  if (method === "Runtime.executionContextDestroyed") return hidden.contextId != null && params.executionContextId === hidden.contextId ? null : params;
  if (!String(method).startsWith("DOM.")) return params;
  if (method === "DOM.childNodeInserted") {
    if (!isPresenceNode(params.node, hidden.backendIds)) return params;
    collect(params.node, hidden.nodeIds);
    return null;
  }
  if (method === "DOM.setChildNodes" && Array.isArray(params.nodes)) return { ...params, nodes: strip(params.nodes, hidden) };
  if (method === "DOM.inlineStyleInvalidated" && Array.isArray(params.nodeIds)) {
    const nodeIds = params.nodeIds.filter((id) => !hidden.nodeIds.has(id));
    return nodeIds.length ? { ...params, nodeIds } : null;
  }
  for (const field of ["nodeId", "hostId", "parentNodeId", "parentId"]) {
    if (hidden.nodeIds.has(params[field])) {
      if (method === "DOM.childNodeRemoved" && field === "nodeId") hidden.nodeIds.delete(params.nodeId);
      return null;
    }
  }
  return params;
}

/** The point an agent's mouse command lands on, or null. */
export function pointerOf(method, params) {
  if (method !== "Input.dispatchMouseEvent" || !params || typeof params !== "object") return null;
  const { x, y, type } = params;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y), press: type === "mousePressed" };
}

/** The user's presence settings, defaults filled in: { overlay, glow, at }. */
export function presenceSettings(value) {
  const record = value && typeof value === "object" ? value : {};
  return {
    overlay: record.overlay !== false,
    glow: record.glow !== false,
    at: Number.isFinite(record.at) ? record.at : 0,
  };
}

/** The newer of two settings, by when the user changed them; a tie keeps the first. */
export function newerSettings(mine, theirs) {
  const a = presenceSettings(mine);
  const b = presenceSettings(theirs);
  return b.at > a.at ? b : a;
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|oklch\([0-9. ]+\))$/i;

// Studio's agent colours, light and dark (src/renderer/src/styles.css).
const AGENT_COLORS = {
  claude: ["oklch(0.58 0.17 50)", "oklch(0.76 0.16 52)"],
  codex: ["oklch(0.5 0.13 175)", "oklch(0.74 0.13 175)"],
  grok: ["oklch(0.48 0.16 128)", "oklch(0.82 0.18 128)"],
  pi: ["oklch(0.5 0.15 300)", "oklch(0.74 0.14 300)"],
};
const ACCENT = ["#2aa298", "#2aa298"];

/** The view the page draws: plain data, no page content. */
export function presenceView({ name, runtime, glow, state, id, keyless }) {
  const colors = AGENT_COLORS[runtime] ?? ACCENT;
  return {
    name: String(name || "An agent").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 40),
    light: COLOR_RE.test(colors[0]) ? colors[0] : ACCENT[0],
    dark: COLOR_RE.test(colors[1]) ? colors[1] : ACCENT[1],
    glow: glow !== false,
    state: state === "stopped" ? "stopped" : "working",
    // Which agent the pill showed when the user pressed Stop: a random id, so
    // it means nothing to the page and never repeats after a worker restart.
    id: typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? id : "",
    // An older Codara cannot refuse one agent: Stop unshares the tab.
    keyless: keyless === true,
  };
}

/** A click the page script reported, checked: { id } for a Stop, or null. */
export function presenceClick(value) {
  if (!value || typeof value !== "object" || value.action !== "stop") return null;
  return typeof value.id === "string" && /^[\w-]{1,64}$/.test(value.id) ? { id: value.id } : null;
}

// Runs in the isolated world, stringified. Idempotent: a second install
// keeps the first one's element. Every method swallows its own errors, so
// nothing reaches the page's console or the agent's exception log.
function install(hostStyle) {
  if (globalThis.__codaraPresence) return true;
  let host = null;
  let parts = null;
  let view = null;
  let holds = 0;
  let holdSafety = null;
  let hidden = false;
  let expiry = null;
  let point = null;
  const events = [];
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const css = `
    .r { position: absolute; inset: 0; }
    .glow { position: absolute; inset: 0; box-shadow: inset 0 0 0 2px var(--c), inset 0 0 26px color-mix(in oklch, var(--c) 35%, transparent); }
    .glow[hidden], button[hidden] { display: none; }
    .ptr { position: absolute; left: 0; top: 0; color: var(--c); transform: translate(-40px, -40px); opacity: 0; }
    .ptr.on { opacity: 1; }
    .ptr svg { overflow: visible; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); display: block; }
    .ptr path { fill: currentColor; stroke: rgba(255,255,255,.95); stroke-width: 1.6; stroke-linejoin: round; }
    .ptr .nm { position: absolute; left: 16px; top: 18px; padding: 2px 6px; border-radius: 6px; background: var(--c); color: #14110d; font: 600 11px/16px system-ui, sans-serif; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
    .ptr.press svg { transform: scale(.86); transform-origin: 2px 2px; }
    .pill { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; min-height: 26px; box-sizing: border-box; border-radius: 999px; background: #1d1b18; color: #f4f3f1; font: 12px/18px system-ui, sans-serif; box-shadow: 0 0 0 1px rgba(255,255,255,.16), 0 6px 24px rgba(0,0,0,.35); white-space: nowrap; pointer-events: auto; }
    .pill.stopped { padding-right: 12px; }
    .pill.agent-input { pointer-events: none; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in oklch, var(--c) 30%, transparent); }
    .pill b { font-weight: 600; }
    button { all: unset; cursor: pointer; background: #f4f3f1; color: #1d1b18; border-radius: 999px; padding: 1px 10px; font: 600 12px/18px system-ui, sans-serif; }
    @media (prefers-reduced-motion: no-preference) {
      .ptr { transition: transform 320ms cubic-bezier(.2,.7,.2,1), opacity 160ms; }
      .ptr svg { transition: transform 120ms; }
    }
    @media print { .r { display: none; } }`;
  const el = (tag, className, parent) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    parent.append(node);
    return node;
  };
  const build = () => {
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    // Set through the style object, which a page's CSP does not block, and
    // important, so no page style can move, hide or reveal it.
    host.style.cssText = hostStyle;
    const root = host.attachShadow({ mode: "closed" });
    // A constructed sheet: a page's style-src cannot block it, and no markup
    // is parsed, so Trusted Types have nothing to refuse.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    const r = el("div", "r", root);
    const glow = el("div", "glow", r);
    const ptr = el("div", "ptr", r);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 20 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M2 2 L2 19 L6.6 15.2 L9.8 22 L13 20.6 L9.9 14 L16 13.6 Z");
    svg.append(path);
    ptr.append(svg);
    const nm = el("span", "nm", ptr);
    const pill = el("div", "pill", r);
    pill.setAttribute("role", "status");
    el("span", "dot", pill);
    const txt = el("span", "txt", pill);
    const btn = el("button", "", pill);
    btn.type = "button";
    btn.tabIndex = -1;
    parts = { r, glow, ptr, nm, pill, txt, btn };
    // The page never sees the user's click on the pill, and keeps its focus.
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keyup"]) {
      pill.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "mousedown") event.preventDefault();
      });
    }
    pill.classList.toggle("agent-input", holds > 0);
    btn.addEventListener("click", (event) => {
      // The agent's own input is trusted too: a click while it is being
      // dispatched is the agent's, not the user's.
      if (!event.isTrusted || holds > 0 || !view || view.state !== "working") return;
      events.push({ action: "stop", id: view.id });
    });
  };
  const place = () => {
    if (!parts || !point || view?.state === "stopped") return;
    parts.ptr.style.transform = `translate(${point.x}px, ${point.y}px)`;
    parts.ptr.classList.add("on");
  };
  const bold = (text) => Object.assign(document.createElement("b"), { textContent: text });
  const paint = () => {
    if (!view || !parts) return;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    // Inside the shadow root: nothing on the host for the page to read.
    parts.r.style.setProperty("--c", dark ? view.dark : view.light);
    parts.glow.hidden = !view.glow || view.state === "stopped";
    parts.nm.textContent = view.name;
    parts.txt.replaceChildren();
    const stopped = view.state === "stopped";
    parts.pill.classList.toggle("stopped", stopped);
    parts.btn.hidden = stopped;
    if (stopped) {
      // No Undo here: the same spot that said Stop must never take it back,
      // and a page cannot lure a click into giving the tab back.
      parts.txt.append("Stopped ", bold(view.name), view.keyless ? ". Share the tab again from the Codara popup." : ". Give it back from the Codara popup.");
      parts.ptr.classList.remove("on");
    } else {
      parts.txt.append(bold(view.name), " working");
      parts.btn.textContent = "Stop";
      parts.btn.setAttribute("aria-label", `Stop ${view.name}`);
      place();
    }
  };
  const attach = () => {
    const built = !host;
    if (built) build();
    if (!host.isConnected && !hidden) document.documentElement.append(host);
    return built;
  };
  const api = {
    // ttl: the extension renews it with every call; if its debugger session
    // ends without a goodbye, the overlay leaves on its own. Says "new" when
    // the host was made just now, so the extension can learn its node id.
    show(next, ttl) {
      try {
        view = next;
        const built = attach();
        paint();
        clearTimeout(expiry);
        expiry = setTimeout(() => api.remove(), ttl);
        return built ? "new" : true;
      } catch {
        return false;
      }
    },
    // The host, for the extension to learn its backend node id (by reference only).
    hostNode() {
      return host;
    },
    // The agent's command is running (on) or done (off): only for that long
    // the pill lets clicks through, so the agent cannot press Stop on itself
    // and the user's Stop works between its actions.
    hold(on, x, y, press) {
      try {
        holds = on ? holds + 1 : Math.max(0, holds - 1);
        clearTimeout(holdSafety);
        // A release that never comes, or a long wait, ends on its own.
        if (holds > 0) {
          holdSafety = setTimeout(() => {
            holds = 0;
            parts?.pill.classList.remove("agent-input");
          }, 2000);
        }
        parts?.pill.classList.toggle("agent-input", holds > 0);
        if (on && typeof x === "number") api.move(x, y, press);
      } catch {}
      return true;
    },
    // The pointer goes to where the agent acts.
    move(x, y, press) {
      try {
        if (view?.state === "stopped") return true;
        // The first input can arrive before the first show: keep the point.
        if (typeof x === "number") point = { x, y };
        if (!parts) return true;
        place();
        if (press && typeof x === "number" && !reduced()) {
          parts.ptr.classList.add("press");
          setTimeout(() => parts.ptr.classList.remove("press"), 160);
        }
      } catch {}
      return true;
    },
    // True only once the overlay is out of the page (on) or back (off).
    conceal(on) {
      try {
        hidden = on;
        if (on) host?.remove();
        else if (view) attach();
        return on ? !host?.isConnected : true;
      } catch {
        return false;
      }
    },
    take() {
      return events.splice(0);
    },
    remove() {
      try {
        view = null;
        clearTimeout(expiry);
        host?.remove();
      } catch {}
      return true;
    },
  };
  globalThis.__codaraPresence = api;
  return true;
}

/** The expression that installs the overlay's API in the isolated world. */
export const PRESENCE_INSTALL = `(${install.toString()})(${JSON.stringify(HOST_STYLE)})`;

/** The expression that calls one of the overlay's methods with JSON arguments. */
export function presenceCall(method, ...args) {
  if (!["show", "hostNode", "hold", "move", "conceal", "take", "remove"].includes(method)) throw new Error(`Unknown presence call ${method}.`);
  return `globalThis.__codaraPresence ? globalThis.__codaraPresence.${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")}) : null`;
}
