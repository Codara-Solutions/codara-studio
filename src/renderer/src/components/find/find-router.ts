import { chordMatches, mod } from "../../shortcuts/chord";

// Routes Ctrl/Cmd+F to the one surface it is meant for. Every surface with
// a find bar (the editor, rendered previews, the Cora chat) registers here,
// and a single window listener decides:
//
//   1. focus inside a surface: that surface (the innermost one);
//   2. focus nowhere (the body): the surface last clicked, if still shown;
//   3. focus in app chrome (a tab, the file tree): the focused document;
//   4. focus on the body and no document: a panel such as the chat.
//
// A key some handler already took (a terminal, a vim keymap, Settings'
// search) is left alone, as is a key pressed in a text field, a terminal or
// a modal dialog. The listener sits in the bubble phase on purpose: the
// global shortcut dispatcher's capture phase would beat xterm, which keeps
// Ctrl+F for full-screen programs.

export const FIND_CHORD = mod("f");

export interface FindTarget {
  /** The surface's root; focus or clicks inside it mean "this surface". */
  root(): HTMLElement | null;
  /** On screen and able to search right now. */
  eligible(): boolean;
  /** The document in the focused pane (rule 3). Panels such as the chat are not. */
  primary(): boolean;
  /** Open find, or refocus it when open. */
  open(): void;
}

interface Entry {
  target: FindTarget;
  touched: number;
}

const entries = new Set<Entry>();
let clock = 0;
let installed = false;

function containing(entryList: Entry[], node: Node | null): Entry | null {
  if (!node) return null;
  let best: Entry | null = null;
  let bestRoot: HTMLElement | null = null;
  for (const entry of entryList) {
    const root = entry.target.root();
    if (!root || !root.contains(node)) continue;
    // Innermost wins: a preview inside the editor pane, say.
    if (!bestRoot || bestRoot.contains(root)) {
      best = entry;
      bestRoot = root;
    }
  }
  return best;
}

function isTextEntry(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Shown on screen: connected, laid out and not visibility:hidden. */
export function isShown(el: Element | null): boolean {
  if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

export function pickFindTarget(active: Element | null): FindTarget | null {
  const live = [...entries].filter((entry) => entry.target.eligible());
  const body = !active || active === document.body || active === document.documentElement;
  if (!body && active) {
    const inside = containing(live, active);
    if (inside) return inside.target;
    if (isTextEntry(active) || active.closest(".xterm, webview, [aria-modal='true'], [role='dialog']")) {
      return null;
    }
  }
  if (document.querySelector("[aria-modal='true']")) return null;
  if (body) {
    const recent = live.reduce<Entry | null>((best, entry) => (entry.touched > (best?.touched ?? 0) ? entry : best), null);
    if (recent) return recent.target;
  }
  const primary = live.find((entry) => entry.target.primary());
  if (primary) return primary.target;
  return body ? live[0]?.target ?? null : null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || !chordMatches(FIND_CHORD, event)) return;
  const target = pickFindTarget(document.activeElement);
  if (!target) return;
  event.preventDefault();
  target.open();
}

function onTouch(event: Event): void {
  const node = event.target instanceof Node ? event.target : null;
  const entry = containing([...entries], node);
  if (entry) entry.touched = ++clock;
}

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("pointerdown", onTouch, true);
  window.addEventListener("focusin", onTouch, true);
}

export function registerFindTarget(target: FindTarget): () => void {
  install();
  const entry: Entry = { target, touched: 0 };
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}
