// The agent's presence on a shared tab of the user's own browser: a pointer
// in the agent's colour with its name, a thin glow around the page and a
// "<agent> working: Stop" pill. Drawn through the debugger session the
// extension already holds, in an isolated world the page's scripts cannot
// reach, inside a closed shadow root hung off <html> (outside <body>, where
// Codara's snapshots read) and marked aria-hidden. Nothing in it reads the
// page: the only thing that leaves it is the user's click on Stop or Undo.
// No chrome.* here, so the tests run it in Node.

export const PRESENCE_WORLD = "codara-presence";

/** How long the pill and glow stay after the agent's last call, and the Undo after Stop. */
export const PRESENCE_IDLE_MS = 8_000;
export const PRESENCE_UNDO_MS = 6_000;

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
  "Page.startScreencast",
]);

/** Whether a command the agent sends must not see the overlay. */
export function hidesPresence(method) {
  return CAPTURE_METHODS.has(String(method ?? ""));
}

/** Whether a command is the agent's input on the page (a click, a key, touch). */
export function isAgentInput(method) {
  return String(method ?? "").startsWith("Input.");
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
export function presenceView({ name, runtime, glow, state }) {
  const colors = AGENT_COLORS[runtime] ?? ACCENT;
  return {
    name: String(name || "An agent").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 40),
    light: COLOR_RE.test(colors[0]) ? colors[0] : ACCENT[0],
    dark: COLOR_RE.test(colors[1]) ? colors[1] : ACCENT[1],
    glow: glow !== false,
    state: state === "stopped" ? "stopped" : "working",
  };
}

// Runs in the isolated world, stringified. Idempotent: a second install
// keeps the first one's element. Every method swallows its own errors, so
// nothing reaches the page's console or the agent's exception log.
function install() {
  if (globalThis.__codaraPresence) return true;
  let host = null;
  let parts = null;
  let view = null;
  let inputUntil = 0;
  let hidden = false;
  let expiry = null;
  let point = null;
  const events = [];
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const css = `
    .glow { position: absolute; inset: 0; box-shadow: inset 0 0 0 2px var(--c), inset 0 0 26px color-mix(in oklch, var(--c) 35%, transparent); }
    .ptr { position: absolute; left: 0; top: 0; color: var(--c); transform: translate(-40px, -40px); opacity: 0; }
    .ptr.on { opacity: 1; }
    .ptr svg { overflow: visible; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); display: block; }
    .ptr path { fill: currentColor; stroke: rgba(255,255,255,.95); stroke-width: 1.6; stroke-linejoin: round; }
    .ptr .nm { position: absolute; left: 16px; top: 18px; padding: 2px 6px; border-radius: 6px; background: var(--c); color: #14110d; font: 600 11px/16px system-ui, sans-serif; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
    .ptr.press svg { transform: scale(.86); transform-origin: 2px 2px; }
    .pill { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: 999px; background: #1d1b18; color: #f4f3f1; font: 12px/18px system-ui, sans-serif; box-shadow: 0 0 0 1px rgba(255,255,255,.16), 0 6px 24px rgba(0,0,0,.35); white-space: nowrap; pointer-events: auto; }
    .pill.agent-input { pointer-events: none; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in oklch, var(--c) 30%, transparent); }
    .pill b { font-weight: 600; }
    button { all: unset; cursor: pointer; background: #f4f3f1; color: #1d1b18; border-radius: 999px; padding: 1px 10px; font: 600 12px/18px system-ui, sans-serif; }
    button:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
    @media (prefers-reduced-motion: no-preference) {
      .ptr { transition: transform 320ms cubic-bezier(.2,.7,.2,1), opacity 160ms; }
      .ptr svg { transition: transform 120ms; }
    }`;
  const build = () => {
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    // Inline and important, so no page style can move, hide or reveal it.
    host.style.cssText = "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${css}</style><div class="glow"></div><div class="ptr"><svg width="20" height="24" viewBox="0 0 20 24"><path d="M2 2 L2 19 L6.6 15.2 L9.8 22 L13 20.6 L9.9 14 L16 13.6 Z"/></svg><span class="nm"></span></div><div class="pill" role="status"><span class="dot"></span><span class="txt"></span><button type="button" tabindex="-1"></button></div>`;
    parts = { glow: root.querySelector(".glow"), ptr: root.querySelector(".ptr"), nm: root.querySelector(".nm"), pill: root.querySelector(".pill"), txt: root.querySelector(".txt"), btn: root.querySelector("button") };
    // The page never sees the user's click on the pill.
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keyup"]) {
      parts.pill.addEventListener(type, (event) => event.stopPropagation());
    }
    parts.btn.addEventListener("click", (event) => {
      // An agent's own synthetic click can land here: only a click while no
      // agent input is in flight counts.
      if (!event.isTrusted || Date.now() < inputUntil) return;
      events.push(view?.state === "stopped" ? "undo" : "stop");
    });
  };
  const place = () => {
    if (!parts || !point || view?.state === "stopped") return;
    parts.ptr.style.transform = `translate(${point.x}px, ${point.y}px)`;
    parts.ptr.classList.add("on");
  };
  const paint = () => {
    if (!view || !parts) return;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    host.style.setProperty("--c", dark ? view.dark : view.light);
    parts.glow.hidden = !view.glow || view.state === "stopped";
    parts.nm.textContent = view.name;
    parts.txt.replaceChildren();
    if (view.state === "stopped") {
      parts.txt.append("Stopped ", Object.assign(document.createElement("b"), { textContent: view.name }));
      parts.btn.textContent = "Undo";
      parts.ptr.classList.remove("on");
    } else {
      parts.txt.append(Object.assign(document.createElement("b"), { textContent: view.name }), " working");
      parts.btn.textContent = "Stop";
      place();
    }
    parts.btn.setAttribute("aria-label", `${parts.btn.textContent} ${view.name}`);
  };
  const attach = () => {
    if (!host) build();
    if (!host.isConnected && !hidden) document.documentElement.append(host);
  };
  const api = {
    // ttl: the extension renews it with every call; if its debugger session
    // ends without a goodbye, the overlay leaves on its own.
    show(next, ttl) {
      try {
        view = next;
        attach();
        paint();
        clearTimeout(expiry);
        expiry = setTimeout(() => api.remove(), ttl);
      } catch {}
      return true;
    },
    // An agent's input is on its way: the pill lets it through to the page,
    // and a mouse command moves the pointer to where it lands.
    move(x, y, press) {
      try {
        if (view?.state === "stopped") return true;
        inputUntil = Date.now() + 1200;
        // The first input can arrive before the first show: keep the point.
        if (typeof x === "number") point = { x, y };
        if (!parts) return true;
        parts.pill.classList.add("agent-input");
        setTimeout(() => {
          if (Date.now() >= inputUntil) parts.pill.classList.remove("agent-input");
        }, 1300);
        place();
        if (press && typeof x === "number" && !reduced()) {
          parts.ptr.classList.add("press");
          setTimeout(() => parts.ptr.classList.remove("press"), 160);
        }
      } catch {}
      return true;
    },
    conceal(on) {
      try {
        hidden = on;
        if (on) host?.remove();
        else if (view) attach();
      } catch {}
      return true;
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
export const PRESENCE_INSTALL = `(${install.toString()})()`;

/** The expression that calls one of the overlay's methods with JSON arguments. */
export function presenceCall(method, ...args) {
  if (!["show", "move", "conceal", "take", "remove"].includes(method)) throw new Error(`Unknown presence call ${method}.`);
  return `globalThis.__codaraPresence ? globalThis.__codaraPresence.${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")}) : null`;
}
