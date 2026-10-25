import React, { createContext, useContext } from "react";

// Where something the user sends from a browser tab (picked elements, a
// comment drawn on the page, a tab reference) can land: the agent in any
// terminal pane, a Cora chat, a new Cora chat, or the workspace inbox that
// any agent pulls with codara_preview_inbox. App.tsx builds the list and the
// route; sends to a pane, chat or inbox go through main's delivery service
// (src/main/agent-delivery.ts), so every runtime gets the same text and
// file paths.

export type RoutingDestinationKind = "pane" | "chat" | "chat-new" | "inbox";

export interface RoutingDestination {
  // "pane:<paneId>", "chat:<runId>", "chat-new" or "inbox".
  id: string;
  kind: RoutingDestinationKind;
  label: string;
  // Muted text after the label ("focused", "open", "any agent pulls it").
  sublabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  group: "agents" | "chat" | "inbox";
  paneId?: string;
  runId?: string;
}

export interface SelectionAttachment {
  /** File name the agent sees. */
  name: string;
  mimeType?: string;
  /** Base64 contents. */
  data?: string;
  /** A file under Codara's workspace data folder. */
  sourcePath?: string;
}

export interface SelectionPayload {
  // What produced it; the inbox lists it and the menu titles itself with it.
  // "git" is a Fix with agent send from Source Control.
  source: "inspect" | "draw" | "tab" | "git";
  // The full text the agent receives. The delivery service appends one
  // "Attached: <path>" line per attachment.
  text: string;
  attachments?: SelectionAttachment[];
  // The browser tab it came from, as the id agents pass back.
  tabId?: string;
  url?: string;
}

export interface RouteOptions {
  // Press Enter after pasting into a pane. Only the explicit Send does.
  submit?: boolean;
}

export interface RouteResult {
  outcome: "pasted" | "chat" | "queued" | "started";
  // The destination's label, for a confirmation.
  label: string;
}

export interface SelectionRoutingApi {
  workspaceId: string | null;
  // The menu for a send from this browser tab: every pane and chat, the
  // chat of the run that owns the tab, the inbox, and the default pick.
  destinationsFor: (tabId: string | null) => { destinations: RoutingDestination[]; defaultId: string };
  route: (payload: SelectionPayload, destinationId: string, options?: RouteOptions) => Promise<RouteResult>;
  // Who drives the tab, in words ("Codex · Terminal 2", "Cora chat · Fix nav").
  tabSession: (tabId: string) => string | null;
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

/** The routing API when one is mounted; previews rendered outside App (tests, storybooks) have none. */
export function useOptionalSelectionRouting(): SelectionRoutingApi | null {
  return useContext(SelectionRoutingContext);
}
