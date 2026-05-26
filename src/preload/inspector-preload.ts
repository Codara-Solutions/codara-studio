/// <reference lib="dom" />
import { ipcRenderer } from "electron";

// Inspector preload — runs inside the embedded <webview> next to the loaded
// page. The host (BrowserPane) toggles inspect mode via `webview.send`; we
// listen for that message, attach mouseover/click listeners to the document,
// draw a thin outline around the hovered element, and on click capture a
// best-effort selector + visible text + tag + URL. The capture is shipped
// back to the host through `ipcRenderer.sendToHost`. Nothing else is exposed
// to the page — this preload runs in the isolated world, so it cannot be
// reached by site code.

const HOST_CHANNEL_TOGGLE = "spark:inspector:toggle";
const HOST_CHANNEL_PICKED = "spark:inspector:picked";
const HOST_CHANNEL_CANCELLED = "spark:inspector:cancelled";

// CSS the inspector injects when active. We use a thin solid outline rather
// than a border so the highlighted element's box model isn't shifted, which
// would otherwise break the very selector we're trying to capture.
const STYLE_ID = "spark-inspector-style";
const STYLE_CONTENT = `
  .__spark-inspector-active * { cursor: crosshair !important; }
  .__spark-inspector-target {
    outline: 2px solid #6ab1ff !important;
    outline-offset: -2px !important;
    background-color: rgba(106, 177, 255, 0.08) !important;
  }
`;

let active = false;
let lastTarget: Element | null = null;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_CONTENT;
  document.documentElement.appendChild(style);
}

function clearTarget(): void {
  if (lastTarget && lastTarget instanceof Element) {
    lastTarget.classList.remove("__spark-inspector-target");
  }
  lastTarget = null;
}

function highlight(el: Element): void {
  if (lastTarget === el) return;
  clearTarget();
  el.classList.add("__spark-inspector-target");
  lastTarget = el;
}

function visibleText(el: Element): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

// Best-effort CSS selector: prefer #id when stable, else a unique class, else
// fall back to an nth-of-type path up to <body>. The result is meant to be
// human-readable in a prompt, not a guarantee of future correctness — the AI
// downstream will re-resolve the element from this hint + the visible text.
function buildSelector(el: Element): string {
  if (!(el instanceof Element)) return "";
  if (el.id) {
    const candidate = `#${cssEscape(el.id)}`;
    if (document.querySelectorAll(candidate).length === 1) return candidate;
  }
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node.nodeType === Node.ELEMENT_NODE) {
    let part = node.tagName.toLowerCase();
    if (node.classList.length > 0) {
      const uniqueClass = Array.from(node.classList).find((cls) => {
        if (!cls) return false;
        try {
          return document.querySelectorAll(`.${cssEscape(cls)}`).length === 1;
        } catch {
          return false;
        }
      });
      if (uniqueClass) {
        return `.${cssEscape(uniqueClass)}`;
      }
      const firstClass = Array.from(node.classList)[0];
      if (firstClass) part += `.${cssEscape(firstClass)}`;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === node!.tagName,
      );
      if (sameTag.length > 1) {
        const index = sameTag.indexOf(node) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    node = parent;
    if (parts.length > 6) break;
  }
  return parts.join(" > ");
}

// CSS.escape isn't always available inside webview contexts (depends on the
// page's environment), so we ship a minimal fallback.
function cssEscape(value: string): string {
  const css = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css && typeof css.escape === "function") {
    return css.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function onMouseOver(event: MouseEvent): void {
  if (!active) return;
  const target = event.target;
  if (target instanceof Element) {
    highlight(target);
  }
}

function onMouseOut(event: MouseEvent): void {
  if (!active) return;
  const target = event.target;
  if (target === lastTarget) {
    // intentional no-op: we keep the highlight until another element wins
    void target;
  }
}

function onClick(event: MouseEvent): void {
  if (!active) return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.target;
  if (!(target instanceof Element)) return;
  const payload = {
    selector: buildSelector(target),
    text: visibleText(target),
    tagName: target.tagName.toLowerCase(),
    url: window.location.href,
  };
  deactivate();
  ipcRenderer.sendToHost(HOST_CHANNEL_PICKED, payload);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active) return;
  if (event.key === "Escape") {
    event.preventDefault();
    deactivate();
    ipcRenderer.sendToHost(HOST_CHANNEL_CANCELLED);
  }
}

function activate(): void {
  if (active) return;
  active = true;
  ensureStyle();
  document.documentElement.classList.add("__spark-inspector-active");
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
}

function deactivate(): void {
  if (!active) return;
  active = false;
  clearTarget();
  document.documentElement.classList.remove("__spark-inspector-active");
  document.removeEventListener("mouseover", onMouseOver, true);
  document.removeEventListener("mouseout", onMouseOut, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKeyDown, true);
}

ipcRenderer.on(HOST_CHANNEL_TOGGLE, (_event, enabled: boolean) => {
  if (enabled) activate();
  else deactivate();
});
