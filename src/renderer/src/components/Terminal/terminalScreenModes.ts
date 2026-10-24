import type { Terminal } from "@xterm/xterm";

// A pane's xterm is disposed and recreated while its PTY keeps running, and
// the text snapshot that rebuilds the fresh instance carries no escape
// sequences. A full-screen TUI still believes it owns the alternate screen,
// mouse reporting and the rest, so the fresh instance has to be told. Every
// mode here is set by the TUI exactly once at startup, which is why the
// TUI's own repaint after a reattach does not bring them back.
export type TerminalMouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
export type TerminalMouseEncoding = "DEFAULT" | "SGR" | "SGR_PIXELS";

export interface TerminalScreenModes {
  alternateScreen: boolean;
  bracketedPaste: boolean;
  applicationCursorKeys: boolean;
  sendFocus: boolean;
  mouseTracking: TerminalMouseTracking;
  mouseEncoding: TerminalMouseEncoding;
}

type TerminalWithMouseCore = Terminal & {
  _core?: { coreMouseService?: { activeEncoding?: unknown } };
};

function mouseEncodingOf(term: Terminal): TerminalMouseEncoding {
  // xterm 5.5 keeps the report encoding off its public `modes`.
  const encoding = (term as TerminalWithMouseCore)._core?.coreMouseService?.activeEncoding;
  return encoding === "SGR" || encoding === "SGR_PIXELS" ? encoding : "DEFAULT";
}

export function captureTerminalScreenModes(term: Terminal): TerminalScreenModes {
  const modes = term.modes;
  return {
    alternateScreen: term.buffer.active.type === "alternate",
    bracketedPaste: modes.bracketedPasteMode === true,
    applicationCursorKeys: modes.applicationCursorKeysMode === true,
    sendFocus: modes.sendFocusMode === true,
    mouseTracking: modes.mouseTrackingMode ?? "none",
    mouseEncoding: mouseEncodingOf(term),
  };
}

const MOUSE_TRACKING_MODE: Record<Exclude<TerminalMouseTracking, "none">, number> = {
  x10: 9,
  vt200: 1000,
  drag: 1002,
  any: 1003,
};

// Written to the LOCAL xterm only, after the normal-screen snapshot has been
// replayed, so the snapshot lands under the alternate screen exactly where it
// was. Nothing reaches the PTY.
export function terminalScreenModesSequence(modes: TerminalScreenModes): string {
  const set: number[] = [];
  if (modes.alternateScreen) set.push(1049);
  if (modes.applicationCursorKeys) set.push(1);
  if (modes.mouseTracking !== "none") {
    set.push(MOUSE_TRACKING_MODE[modes.mouseTracking]);
    if (modes.mouseEncoding === "SGR") set.push(1006);
    if (modes.mouseEncoding === "SGR_PIXELS") set.push(1016);
  }
  if (modes.sendFocus) set.push(1004);
  if (modes.bracketedPaste) set.push(2004);
  return set.map((mode) => `\u001b[?${mode}h`).join("");
}

// Panes whose live xterm currently shows the alternate screen. App keeps
// their workspace mounted: a full-screen TUI's frame exists only in that
// xterm and in the TUI's memory, so unloading it leaves a blank pane until
// the TUI happens to repaint.
const alternateScreenPanes = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

export function setTerminalPaneAlternateScreen(paneId: string, alternate: boolean): void {
  if (alternateScreenPanes.has(paneId) === alternate) return;
  if (alternate) alternateScreenPanes.add(paneId);
  else alternateScreenPanes.delete(paneId);
  revision += 1;
  for (const listener of [...listeners]) listener();
}

export function isTerminalPaneInAlternateScreen(paneId: string): boolean {
  return alternateScreenPanes.has(paneId);
}

export function subscribeAlternateScreenPanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function alternateScreenPanesRevision(): number {
  return revision;
}
