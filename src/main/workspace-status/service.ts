// The workspace status store and the app lookups the socket tool needs, as
// the handler in preview-tools/ reaches them. index.ts provides them when
// main loads it, so that handler never imports Electron, the pty manager or
// the state file and stays loadable on its own (the routing suite bundles it).

import type { AgentNoteBook } from "./agent-notes";
import type { WorkspaceStatusStore } from "./store";

export interface WorkspaceStatusService {
  store(): WorkspaceStatusStore;
  /** Each agent's own note, which the tool writes. */
  notes(): AgentNoteBook;
  /** The workspace's name, or null when no such workspace exists any more. */
  workspaceName(workspaceId: string): Promise<string | null>;
  /**
   * Whether the agent a note belongs to is still there: its pane still open,
   * or its Cora chat still on the Agents view (working, waiting, or finished
   * and not yet seen or aged out).
   */
  agentIsLive(key: string): Promise<boolean>;
  /** "Claude Code", "Codex", ... for the agent Codara sees in that pane, if any. */
  agentLabelForPane(paneId: string): string | null;
}

let service: WorkspaceStatusService | null = null;

export function provideWorkspaceStatusService(next: WorkspaceStatusService): void {
  service = next;
}

export function workspaceStatusService(): WorkspaceStatusService {
  if (!service) throw new Error("Codara's workspace status is not ready yet.");
  return service;
}
