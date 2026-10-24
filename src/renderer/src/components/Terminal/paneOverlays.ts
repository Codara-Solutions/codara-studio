// Temporary terminals that cover an existing pane (pane.open's overlay mode,
// what the `codara-pane overlay` helper asks for): same size and place as the
// pane underneath, keyboard focus while open, gone when the command exits.
// Kept outside the tab tree on purpose: an overlay belongs to one running
// process, so it is never persisted, restored, split or moved on its own.
// TerminalStack renders the overlay inside its host pane's frame, so it
// follows that pane through splits, zoom and drags.

import { makeId } from "@shared/ids";
import type { ShellInfo } from "@shared/types";

export interface PaneOverlay {
  // The overlay's own PTY session id.
  paneId: string;
  hostPaneId: string;
  command: string;
  cwd?: string;
  title?: string;
}

let overlaysByHost: ReadonlyMap<string, PaneOverlay> = new Map();
const listeners = new Set<() => void>();
const exitSubscriptions = new Map<string, () => void>();

type HostLocator = (paneId: string) => boolean;
let locateHost: HostLocator | null = null;

// App registers the lookup: only it sees every workspace's tab layouts.
export function setPaneOverlayHostLocator(fn: HostLocator | null): void {
  locateHost = fn;
}

export function subscribePaneOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function paneOverlaysSnapshot(): ReadonlyMap<string, PaneOverlay> {
  return overlaysByHost;
}

function publish(next: Map<string, PaneOverlay>): void {
  overlaysByHost = next;
  for (const listener of [...listeners]) listener();
}

export function openPaneOverlay(input: {
  hostPaneId: string;
  command: string;
  cwd?: string;
  title?: string;
}): PaneOverlay {
  if (!locateHost) {
    throw new Error("Codara is not ready to open overlays yet (renderer not mounted). Retry in a moment.");
  }
  if (!locateHost(input.hostPaneId)) {
    throw new Error(`No open terminal pane '${input.hostPaneId}' to cover.`);
  }
  if (overlaysByHost.has(input.hostPaneId)) {
    throw new Error("This pane already has an overlay open.");
  }
  const overlay: PaneOverlay = {
    paneId: makeId("overlay"),
    hostPaneId: input.hostPaneId,
    command: input.command,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.title ? { title: input.title } : {}),
  };
  const next = new Map(overlaysByHost);
  next.set(overlay.hostPaneId, overlay);
  publish(next);
  // Subscribed here rather than in the overlay's view: main also ends an
  // overlay when its host pane closes, and by then that view is unmounted.
  const off = window.spark?.pty?.onExit?.(overlay.paneId, () => {
    closePaneOverlay(overlay.paneId);
  });
  if (off) exitSubscriptions.set(overlay.paneId, off);
  return overlay;
}

export function closePaneOverlay(paneId: string): boolean {
  const overlay = [...overlaysByHost.values()].find((entry) => entry.paneId === paneId);
  if (!overlay) return false;
  exitSubscriptions.get(paneId)?.();
  exitSubscriptions.delete(paneId);
  const next = new Map(overlaysByHost);
  next.delete(overlay.hostPaneId);
  publish(next);
  return true;
}

// The overlay's shell runs the command and then leaves, so the overlay closes
// with it, the way a zoomed WezTerm split running one program does.
export function overlayStartupCommand(command: string, family: ShellInfo["family"]): string {
  return family === "cmd" ? `${command} & exit` : `${command}; exit`;
}
