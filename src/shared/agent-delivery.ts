// What the user sends an agent from Codara (a picked element, a comment on a
// page, a screenshot, a Chrome tab), and where it goes. Shared by main's
// delivery service, the renderer's send menus and the agent-side inbox tool.

/** Where a delivery lands. */
export type AgentDeliveryTarget =
  /** The agent in a terminal pane, whatever CLI it runs: pasted into its prompt. */
  | { kind: "pane"; paneId: string }
  /** A Cora chat: added as the user's message. */
  | { kind: "chat"; runId: string }
  /**
   * Kept until an agent pulls it with codara_preview_inbox or `cora tool`.
   * With paneId, only that pane's agent receives it; without, any agent in
   * the workspace.
   */
  | { kind: "inbox"; paneId?: string | null };

export interface AgentDeliveryAttachment {
  /** File name shown to the agent; sanitized before it is used on disk. */
  name: string;
  mimeType?: string;
  /** Base64 file contents. Pass this or sourcePath. */
  data?: string;
  /** An existing file to copy. */
  sourcePath?: string;
}

export interface AgentDeliveryRequest {
  workspaceId: string;
  target: AgentDeliveryTarget;
  text: string;
  attachments?: AgentDeliveryAttachment[];
  /** Press Enter after pasting into a pane. Off unless the user pressed Send. */
  submit?: boolean;
  /** What produced it, for the inbox listing: "picker", "comment", "screenshot", ... */
  source: string;
  /** The browser tab it came from, as a tab id agents can pass back ("tab-3", "chrome:12"). */
  tabId?: string;
  url?: string;
}

export type AgentDeliveryOutcome = "pasted" | "chat" | "queued";

export interface AgentDeliveryResult {
  id: string;
  outcome: AgentDeliveryOutcome;
  /** The text as delivered, attachment paths included. */
  text: string;
  /** Saved attachments, in request order. */
  paths: string[];
}

/** One pulled inbox item, as the inbox tool returns it. */
export interface AgentInboxItem {
  id: string;
  at: number;
  source: string;
  text: string;
  paths: string[];
  tabId?: string;
  url?: string;
}
