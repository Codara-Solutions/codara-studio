// DevTools protocol sessions for preview tabs, over webContents.debugger.
//
// A session is created the moment Chromium attaches a <webview> guest to the
// main window, so console and network are recorded from the tab's first
// request. Every consumer (trusted input, recorders, emulation, audits)
// shares that one session through previewCdpSession().
//
// Electron (43) lets this session coexist with the user's own DevTools
// window: opening or closing BrowserPane's DevTools neither detaches it nor
// stops its events, and attaching while DevTools is open works. If a target
// still refuses (another exclusive client), the session stays unattached,
// recorders stay empty, and a call that needs the protocol fails with a
// message saying what to close; the next call tries again.
//
// Commands sent before the guest's first navigation are only answered once
// a renderer exists, so nothing here awaits an enable at creation time.

import type { WebContents } from "electron";

import { onTrustedPreviewGuestAttached } from "../main-window-trust";
import { CdpSession, type CdpTransport, type RingBuffer } from "./cdp-session";
import { startPageActivity } from "./page-activity";
import { startConsoleRecorder } from "./recorders/console";
import { startDialogRecorder } from "./recorders/dialogs";
import { startNetworkRecorder } from "./recorders/network";

const sessions = new Map<number, CdpSession>();
const tabOfGuest = new Map<number, string>();
const guestOfTab = new Map<string, number>();
// Buffers of a guest that went away while its tab lives on (the webview was
// re-created), adopted by the tab's next guest.
const parkedRings = new Map<string, ReadonlyMap<string, RingBuffer<unknown>>>();
const PARKED_TAB_LIMIT = 20;

export function electronCdpTransport(wc: WebContents): CdpTransport {
  return {
    attach() {
      if (wc.isDestroyed()) throw new Error("the tab closed");
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    },
    isAttached: () => !wc.isDestroyed() && wc.debugger.isAttached(),
    detach() {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    },
    send: (method, params) => wc.debugger.sendCommand(method, params),
    onEvent(listener) {
      const handler = (_event: unknown, method: string, params: Record<string, unknown>) => listener(method, params ?? {});
      wc.debugger.on("message", handler);
      return () => {
        if (!wc.isDestroyed()) wc.debugger.removeListener("message", handler);
      };
    },
    onDetach(listener) {
      const handler = (_event: unknown, reason: string) => {
        if (!wc.isDestroyed()) listener(reason);
      };
      wc.debugger.on("detach", handler);
      return () => {
        if (!wc.isDestroyed()) wc.debugger.removeListener("detach", handler);
      };
    },
  };
}

/** The shared session of a preview guest, created (and recording) on first use. */
export function previewCdpSession(wc: WebContents): CdpSession {
  const existing = sessions.get(wc.id);
  if (existing && !existing.isDisposed) return existing;
  const wcId = wc.id;
  const session = new CdpSession(`preview-guest:${wcId}`, electronCdpTransport(wc));
  sessions.set(wcId, session);
  startConsoleRecorder(session);
  startNetworkRecorder(session);
  startDialogRecorder(session, { beforeUnload: "host" });
  startPageActivity(session);
  wc.once("destroyed", () => {
    const tabId = tabOfGuest.get(wcId);
    if (tabId && guestOfTab.get(tabId) === wcId) {
      parkedRings.set(tabId, session.ringsSnapshot());
      while (parkedRings.size > PARKED_TAB_LIMIT) parkedRings.delete(parkedRings.keys().next().value as string);
      guestOfTab.delete(tabId);
    }
    tabOfGuest.delete(wcId);
    sessions.delete(wcId);
    session.dispose({ detach: false });
  });
  return session;
}

/**
 * Record which tab a guest belongs to, so a tab whose webview is re-created
 * keeps its console and network history.
 */
export function bindPreviewTabGuest(tabId: string, wc: WebContents): void {
  const session = previewCdpSession(wc);
  if (tabOfGuest.get(wc.id) === tabId) return;
  tabOfGuest.set(wc.id, tabId);
  guestOfTab.set(tabId, wc.id);
  const parked = parkedRings.get(tabId);
  if (parked) {
    parkedRings.delete(tabId);
    session.adoptRings(parked);
  }
}

/** Forget a closed tab's parked history. */
export function forgetPreviewTab(tabId: string): void {
  parkedRings.delete(tabId);
}

export function previewTabOfGuest(wcId: number): string | null {
  return tabOfGuest.get(wcId) ?? null;
}

/** The guest webContents id of every tab that has a page right now. */
export function previewTabGuests(): Array<[tabId: string, wcId: number]> {
  return [...guestOfTab];
}

let registered = false;

export function registerPreviewCdpSessions(): void {
  if (registered) return;
  registered = true;
  onTrustedPreviewGuestAttached((guest) => {
    previewCdpSession(guest);
  });
}
