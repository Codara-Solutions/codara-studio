import { ipcMain, type IpcMainEvent, type WebContents } from "electron";

import { isTrustedPreviewGuest } from "../main-window-trust";

// Forward chord keystrokes (Ctrl/Cmd/Alt/Meta + key) from a <webview> guest
// back to its host renderer so app-wide shortcuts (Ctrl+1, Ctrl+P Quick
// Open, ...) keep working when focus is inside the embedded page. Listening
// on the webContents is the only place this fires: the webview tag in the
// host renderer does not emit before-input-event. The host preload turns the
// forwarded payload into a synthetic KeyboardEvent dispatched on window.
//
// The page sees every chord first, as in a browser. A guest that runs the
// browser pane's preload reports whether the page handled the key (called
// preventDefault), and only an unhandled chord reaches the app: a page whose
// Ctrl+K opens its own palette keeps the key, where forwarding it used to
// open Codara's run switcher and pull focus out of the page. Guests without
// that preload (file previews) forward at once, as before.
//
// Keys an agent sends never reach the app. Chromium does not pre-handle
// protocol key events today, and dispatches marked with withAgentKeys() are
// dropped here as well, so a future change cannot route them to Codara.

export interface ChordInput {
  key: string;
  code?: string;
  modifiers: string[];
}

export interface ChordReport {
  key: string;
  code?: string;
  handled: boolean;
}

/**
 * Chords the app keeps whatever the page does, like a browser's reserved tab
 * keys: Mod+W, Mod+T and Ctrl+Tab. A page cannot take new tab or close tab
 * from Chrome either, and a terminal tab that never opens because the page in
 * view swallowed Mod+T looks like a dead shortcut.
 */
export function isReservedChord(input: ChordInput): boolean {
  const mods = input.modifiers;
  const primary = mods.includes("control") || mods.includes("meta");
  if (!primary || mods.includes("alt")) return false;
  if (input.key === "Tab") return mods.includes("control");
  const key = input.key.toLowerCase();
  return !mods.includes("shift") && (key === "w" || key === "t");
}

export interface ChordRouterOptions {
  forward(input: ChordInput): void;
  /** How long to wait for the page's report before forwarding anyway (a busy page, focus in a frame without the preload). */
  reportTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Plain keys the app keeps from a browser page: F11 (full screen) and F12
 * (DevTools) always, Escape only while the tab is full screen, where it leaves.
 */
export function isReservedPlainKey(input: ChordInput, escapeLeavesFullScreen: boolean): boolean {
  if (input.modifiers.some((mod) => mod === "control" || mod === "alt" || mod === "meta" || mod === "shift")) return false;
  if (input.key === "F11" || input.key === "F12") return true;
  return escapeLeavesFullScreen && input.key === "Escape";
}

/** The decision logic for one guest, kept free of Electron so it can be tested. */
export function createChordRouter(options: ChordRouterOptions) {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const timeoutMs = options.reportTimeoutMs ?? 300;
  const waiting: Array<{ input: ChordInput; timer: unknown }> = [];
  let reporter = false;
  let agentDepth = 0;
  let fullScreen = false;

  function settle(entry: { input: ChordInput; timer: unknown }, forward: boolean) {
    const index = waiting.indexOf(entry);
    if (index < 0) return;
    waiting.splice(index, 1);
    clearTimer(entry.timer);
    if (forward) options.forward(entry.input);
  }

  return {
    /** The guest's page preload is running and will report chords. */
    reporterReady() {
      reporter = true;
    },
    agentKeysStart() {
      agentDepth += 1;
    },
    agentKeysEnd() {
      agentDepth = Math.max(0, agentDepth - 1);
    },
    setFullScreen(on: boolean) {
      fullScreen = on;
    },
    keyDown(input: ChordInput) {
      const mods = input.modifiers;
      if (!input.key || agentDepth > 0) return;
      // The page still gets these keys; the app hears them as well.
      if (isReservedPlainKey(input, fullScreen)) {
        options.forward(input);
        return;
      }
      if (!(mods.includes("control") || mods.includes("alt") || mods.includes("meta"))) return;
      if (!reporter || isReservedChord(input)) {
        options.forward(input);
        return;
      }
      const entry: { input: ChordInput; timer: unknown } = { input, timer: null };
      entry.timer = setTimer(() => settle(entry, true), timeoutMs);
      waiting.push(entry);
    },
    report(report: ChordReport) {
      // Reports arrive in key order; one that matches nothing waiting (it
      // already timed out) is ignored.
      const entry = waiting.find((candidate) => candidate.input.key === report.key && (!report.code || !candidate.input.code || candidate.input.code === report.code));
      if (entry) settle(entry, !report.handled);
    },
    dispose() {
      for (const entry of waiting.splice(0)) clearTimer(entry.timer);
    },
  };
}

type ChordRouter = ReturnType<typeof createChordRouter>;
const routers = new Map<number, ChordRouter>();

export function forwardGuestChords(contents: WebContents): void {
  const wcId = contents.id;
  const router = createChordRouter({
    forward(input) {
      const host = contents.isDestroyed() ? null : contents.hostWebContents;
      if (!host || host.isDestroyed()) return;
      host.send("webview:chord-key", { key: input.key, code: input.code, modifiers: input.modifiers });
    },
  });
  routers.set(wcId, router);
  contents.once("destroyed", () => {
    router.dispose();
    if (routers.get(wcId) === router) routers.delete(wcId);
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // F11 is the browser pane's full screen, forwarded below. Unhandled, it
    // would also reach Electron's default menu and full screen the window.
    const modifiers = input.modifiers ?? [];
    if (input.key === "F11" && isReservedPlainKey({ key: input.key, modifiers }, false)) event.preventDefault();
    router.keyDown({ key: input.key, code: input.code, modifiers });
  });
}

/** While a tab is full screen, Escape typed in its page reaches the app too. */
export function setGuestFullScreen(wcId: number, on: boolean): void {
  routers.get(wcId)?.setFullScreen(on);
}

/** Run an agent's key dispatch on a guest; chords it produces are never forwarded to the app. */
export async function withAgentKeys<T>(contents: WebContents, dispatch: () => Promise<T>): Promise<T> {
  const router = routers.get(contents.id);
  router?.agentKeysStart();
  try {
    return await dispatch();
  } finally {
    router?.agentKeysEnd();
  }
}

export const GUEST_CHORD_READY_CHANNEL = "preview-guest:chord-reporter";
export const GUEST_CHORD_REPORT_CHANNEL = "preview-guest:chord";

function guestRouter(event: IpcMainEvent): ChordRouter | null {
  // Only the browser pane's own preload, running in a real preview guest of
  // the trusted window, may answer for a guest.
  if (event.sender.getType() !== "webview" || !isTrustedPreviewGuest(event.sender)) return null;
  if (event.senderFrame && event.senderFrame.parent) return null;
  return routers.get(event.sender.id) ?? null;
}

let registered = false;

export function registerGuestChordReports(): void {
  if (registered) return;
  registered = true;
  // Ungated by the main-window sender gate on purpose (ON_OPT_OUT in
  // scripts/test-ipc-gate-default.cjs): the sender is a preview guest, which
  // that gate refuses. guestRouter() admits only a real guest's top frame, and
  // a report can only settle a chord the user really pressed in that guest.
  ipcMain.on(GUEST_CHORD_READY_CHANNEL, (event) => guestRouter(event)?.reporterReady());
  ipcMain.on(GUEST_CHORD_REPORT_CHANNEL, (event, payload: Partial<ChordReport> | undefined) => {
    if (!payload || typeof payload.key !== "string") return;
    guestRouter(event)?.report({
      key: payload.key,
      code: typeof payload.code === "string" ? payload.code : undefined,
      handled: payload.handled === true,
    });
  });
}
