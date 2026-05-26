import React, { createContext, useContext } from "react";

// Where a preview-mode selection (inspect pick / draw screenshot) can be
// shipped to from the routing menu. The menu shows a fixed set of "chat"
// and "new worker" entries plus a dynamic list of currently-open workers.

export type RoutingDestinationKind =
  | "chat-new"
  | "chat-current"
  | "worker-new-claude"
  | "worker-new-codex"
  | "worker-existing";

export interface RoutingDestination {
  // Stable id used by SelectionRouteMenu when calling route(). For
  // worker-existing entries this encodes the attemptId / paneId.
  id: string;
  kind: RoutingDestinationKind;
  // Visible row text. Worker rows are labelled "Claude · <chat name>"
  // (or "Manual Claude" when the pane was launched by the user directly).
  label: string;
  // Optional secondary label shown to the right of `label` in muted text.
  sublabel?: string;
  // Greyed-out entries the user can see but not pick (e.g. "Send to current
  // chat" when there is no active chat).
  disabled?: boolean;
  disabledReason?: string;
  // Visual grouping. The menu renders a thin divider between groups.
  group: "chat" | "worker-new" | "worker-existing";
}

export interface SelectionPayload {
  // Where this payload came from. Drives whether the "draw" branch (image
  // attachment / file URL in worker prompts) is taken on send.
  source: "inspect" | "draw";
  // Composed prompt text. Identical for every destination — chat routes
  // pass it as the message body, worker routes type it into the agent.
  text: string;
  // For "draw" mode only: the absolute OS path of the saved annotated PNG.
  // Chat routes pass it as an image attachment; worker routes already have
  // the raw path baked into `text`, so this is unused there.
  imagePath?: string;
  // Same image as a file:// URL — handy when callers want to surface a
  // clickable link.
  imageFileUrl?: string;
}

export interface SelectionRoutingApi {
  destinations: RoutingDestination[];
  route: (payload: SelectionPayload, destinationId: string) => Promise<void>;
}

const SelectionRoutingContext = createContext<SelectionRoutingApi | null>(null);

export function SelectionRoutingProvider({
  value,
  children,
}: {
  value: SelectionRoutingApi;
  children: React.ReactNode;
}) {
  return (
    <SelectionRoutingContext.Provider value={value}>
      {children}
    </SelectionRoutingContext.Provider>
  );
}

export function useSelectionRouting(): SelectionRoutingApi {
  const ctx = useContext(SelectionRoutingContext);
  if (!ctx) {
    throw new Error(
      "useSelectionRouting must be used inside <SelectionRoutingProvider>",
    );
  }
  return ctx;
}

// Read the routing API without throwing when no provider is present. Used
// by the overlays so they can keep rendering inside isolated test harnesses
// or storybook hosts that never set up the provider.
export function useOptionalSelectionRouting(): SelectionRoutingApi | null {
  return useContext(SelectionRoutingContext);
}
