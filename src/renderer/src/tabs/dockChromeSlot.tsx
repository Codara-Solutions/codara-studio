import React, { createContext, useContext, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { TabId } from "./types";

// Portal seam that lets docked content lift its toolbar controls into the
// DockedPaneChrome header band, next to the kind label — one bar per docked
// cell instead of the band stacked on top of the content's own toolbar row.
//
// Same ownership rules as dockGeometry: the grid (DockedPaneChrome) owns the
// band and registers a slot element per docked tab; the content Stack keeps
// owning the controls and merely portals them across. Only plain toolbar DOM
// crosses the portal — never the content surface itself, which must not be
// re-parented.

const slots = new Map<TabId, HTMLElement>();
let version = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const cb of subscribers) cb();
}

export function registerDockChromeSlot(tabId: TabId, el: HTMLElement): void {
  if (slots.get(tabId) === el) return;
  slots.set(tabId, el);
  notify();
}

// Element-checked, so a stale unmount (the cell moved hosts and the new
// chrome registered first) can't tear down the slot the new band owns.
export function unregisterDockChromeSlot(tabId: TabId, el: HTMLElement): void {
  if (slots.get(tabId) !== el) return;
  slots.delete(tabId);
  notify();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getVersion(): number {
  return version;
}

// Which tab's chrome slot a pane's toolbars should target. Provided by the
// owning Stack around each dockable pane; null (the default) means "not a
// dockable pane", so toolbars render their normal block row.
export const DockSlotTabIdContext = createContext<TabId | null>(null);

export function useDockChromeSlot(): HTMLElement | null {
  const tabId = useContext(DockSlotTabIdContext);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return tabId ? (slots.get(tabId) ?? null) : null;
}

const barStyle: React.CSSProperties = {
  flex: "0 0 32px",
  height: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 6,
  padding: "0 10px",
  background: "var(--panel)",
  borderBottom: "1px solid var(--rule-soft)",
  color: "var(--muted)",
  fontSize: 11,
};

// Toolbar row for dockable content. Undocked it renders the familiar block
// row; docked it portals the same children into the cell's chrome band. The
// slot is pointer-events:none (band dead space stays click-through to the
// cell), so interactive children must carry pointerEvents: "auto" themselves.
export function DockablePaneBar({
  children,
  style,
  forceLocal = false,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  forceLocal?: boolean;
}) {
  const slot = useDockChromeSlot();
  if (slot && !forceLocal) return createPortal(children, slot);
  return <div style={style ? { ...barStyle, ...style } : barStyle}>{children}</div>;
}
