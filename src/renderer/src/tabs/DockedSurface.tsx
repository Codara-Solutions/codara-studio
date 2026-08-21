import React, { useCallback, useSyncExternalStore } from "react";
import type { TabId } from "./types";
import {
  DOCK_CONTENT_Z,
  getDockVersion,
  peekDockPlacementSnapshot,
  registerDockElement,
  subscribeDockChanges,
} from "./dockGeometry";

// The wrapper every dockable stack puts around one tab's content.
//
// A workspace surface has exactly two states: filling the workbench (shown iff
// it is the active tab) or lending its rect to a cell in a terminal tab's split
// grid (shown iff that cell is on screen). The element never re-parents between
// them — that is the whole point of the dock design, since re-parenting reloads
// a <webview> and throws away editor/board state — so the difference is only
// which of the two writes this element's frame: React, or the grid publishing
// geometry into the registered node.
//
// EditorStack, PreviewStack and ChatStack predate this and inline the same
// shape with extras of their own (webview liveness, the chat's backend-terminal
// inset). New dockable surfaces should use this instead of copying it: four
// stacks repeating the registration by hand is four places for the docked and
// undocked branches to drift apart.
interface Props {
  tabId: TabId;
  // This tab holds a cell in some terminal tab's grid (App's dockIndex).
  docked: boolean;
  // This tab is the active workbench tab. Only consulted when undocked.
  active: boolean;
  // Content that needs to know whether it is on screen (to pause polling, skip
  // canvas work, …) reads the argument; content that doesn't can ignore it.
  children: (visible: boolean) => React.ReactNode;
}

export default function DockedSurface({ tabId, docked, active, children }: Props) {
  // Re-render this surface when its cell is shown, hidden, parked or moved.
  // Per-surface rather than per-stack, so one cell changing state doesn't
  // re-render every other tab of the same kind.
  useSyncExternalStore(subscribeDockChanges, getDockVersion, getDockVersion);
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerDockElement(tabId, el),
    [tabId],
  );
  const visible = docked ? (peekDockPlacementSnapshot(tabId)?.shown ?? false) : active;
  return (
    <div
      ref={ref}
      // Marks the element the grid positions (see dockGeometry.ts).
      data-dock-content-id={docked ? tabId : undefined}
      aria-hidden={!visible}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
        ...(docked
          ? {
              // Placeholder box only: the registry overwrites the frame
              // imperatively as soon as the host publishes its layout, so the
              // cell must start hidden rather than flash at inset 0.
              zIndex: DOCK_CONTENT_Z,
              visibility: "hidden" as const,
              pointerEvents: "none" as const,
              overflow: "hidden",
              borderRadius: "var(--terminal-pane-radius)",
            }
          : null),
      }}
    >
      {children(visible)}
    </div>
  );
}
