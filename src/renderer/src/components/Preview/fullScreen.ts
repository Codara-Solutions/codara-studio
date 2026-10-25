// Which browser tab is full screen, if any. One at a time: the pane fills the
// Codara window (PreviewStack lifts its wrapper over everything but dialogs),
// and "display" also makes the window full screen. App reads this to route
// F11 and to leave when the tab's workspace goes off screen.

import { useSyncExternalStore } from "react";
import { nextFullScreenMode, type FullScreenMode } from "./tabs-memory/sleepPolicy";

interface State {
  tabId: string | null;
  mode: FullScreenMode;
}

let state: State = { tabId: null, mode: "off" };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => state;

export function browserFullScreen(): State {
  return state;
}

export function setBrowserFullScreen(tabId: string | null, mode: FullScreenMode): void {
  const next: State = mode === "off" || !tabId ? { tabId: null, mode: "off" } : { tabId, mode };
  if (next.tabId === state.tabId && next.mode === state.mode) return;
  state = next;
  void window.spark?.previewBridge?.fullScreen?.({ tabId: next.tabId, mode: next.mode }).catch(() => {});
  for (const listener of listeners) listener();
}

/** Steps a tab's full screen by F11, Escape or the toolbar button. */
export function stepBrowserFullScreen(tabId: string, input: "F11" | "Escape" | "button"): FullScreenMode {
  const current = state.tabId === tabId ? state.mode : "off";
  const next = nextFullScreenMode(current, input);
  setBrowserFullScreen(tabId, next);
  return next;
}

export function useBrowserFullScreen(tabId: string | undefined): FullScreenMode {
  const current = useSyncExternalStore(subscribe, read, read);
  return tabId && current.tabId === tabId ? current.mode : "off";
}

export function useAnyBrowserFullScreen(): State {
  return useSyncExternalStore(subscribe, read, read);
}

/** Menus opened from the toolbar stack above a full screen pane (`.bp-fullscreen`, z-index 95). */
export const BROWSER_MENU_Z = 100;
