// Workspace status: the status you set on a workspace by hand (the store),
// each agent's own note (agent-notes.ts), their IPC channels and change
// broadcasts. ipc.ts registers the channels once, so this area never edits
// that file beyond one call. Agents write their notes through the
// codara_workspace_status tool (preview-tools/workspace-status.ts). The
// renderer side is window.spark.workspaceStatus
// (src/preload/areas/workspace-status.ts).

import { join } from "node:path";
import { webContents } from "electron";

import { coraRunPlacement } from "@shared/agent-board";
import { paneNoteKey, type AgentNoteChange, type AgentNoteMap } from "@shared/agent-status";
import {
  isWorkspaceIdLike,
  parseWorkspaceStatusId,
  workspaceStatusAgentLabel,
  type WorkspaceStatusChange,
  type WorkspaceStatusEntry,
  type WorkspaceStatusMap,
  type WorkspaceStatusPatch,
} from "@shared/workspace-status";
import { codaraHome } from "../codara-home";
import type { IpcHandle } from "../ipc";
import { loadState, onStateSaved } from "../storage";
import { onTerminalPaneRemoved, terminalAgentStateSnapshot, terminalPanePlacement } from "../terminal-agent-notify";
import { createAgentNoteBook, type AgentNoteBook } from "./agent-notes";
import { provideWorkspaceStatusService } from "./service";
import { createWorkspaceStatusStore, type WorkspaceStatusStore } from "./store";

export const WORKSPACE_STATUS_CHANGED_CHANNEL = "workspaceStatus:changed";
export const AGENT_NOTES_CHANGED_CHANNEL = "workspaceStatus:agentNoteChanged";

let store: WorkspaceStatusStore | null = null;
let notes: AgentNoteBook | null = null;

function broadcast(channel: string, change: WorkspaceStatusChange | AgentNoteChange): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      contents.send(channel, change);
    } catch {
      // A renderer may close between enumeration and send.
    }
  }
}

function agentNotes(): AgentNoteBook {
  if (notes) return notes;
  notes = createAgentNoteBook();
  notes.onChange((key, note) => broadcast(AGENT_NOTES_CHANGED_CHANNEL, { key, note }));
  // A note lives and dies with its agent: a closed pane takes its note along.
  onTerminalPaneRemoved((paneId) => notes?.drop(paneNoteKey(paneId)));
  return notes;
}

function workspaceStatusStore(): WorkspaceStatusStore {
  if (store) return store;
  store = createWorkspaceStatusStore({ file: join(codaraHome(), "workspace-status.json") });
  store.onChange((workspaceId, entry) => broadcast(WORKSPACE_STATUS_CHANGED_CHANNEL, { workspaceId, entry }));
  // A deleted workspace takes its status and its agents' notes with it.
  // Every main and renderer save goes through storage, so this sees each
  // removal once it is durable.
  const prune = (workspaces: readonly { id: string }[]) => {
    const live = new Set(workspaces.map((workspace) => workspace.id));
    void store?.prune(live).catch(() => undefined);
    agentNotes().pruneWorkspaces(live);
  };
  onStateSaved((state) => prune(state.workspaces));
  // And those removed while the store was not loaded yet.
  void loadState().then((state) => prune(state.workspaces), () => undefined);
  return store;
}

async function workspaceName(workspaceId: string): Promise<string | null> {
  const state = await loadState().catch(() => null);
  return state?.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null;
}

// A pane's note goes with its pane (onTerminalPaneRemoved). A chat has no
// pane, so its note lasts while the chat is on the Agents view, as its line
// does, and the next tool call in its workspace drops it after that.
async function agentIsLive(key: string): Promise<boolean> {
  if (key.startsWith("pane:")) return terminalPanePlacement(key.slice("pane:".length)) !== null;
  if (!key.startsWith("run:")) return false;
  const { getRun } = await import("../orchestration/run-store");
  const run = await getRun(key.slice("run:".length)).catch(() => null);
  return run !== null && coraRunPlacement(run, Date.now()) !== null;
}

provideWorkspaceStatusService({
  store: workspaceStatusStore,
  notes: agentNotes,
  agentIsLive,
  workspaceName,
  agentLabelForPane(paneId) {
    const runtime = terminalAgentStateSnapshot().find((entry) => entry.paneId === paneId)?.runtime;
    return runtime ? workspaceStatusAgentLabel(runtime) : null;
  },
});

/** The renderer's patch, checked field by field; anything malformed is refused. */
export function workspaceStatusPatchFromIpc(raw: unknown): WorkspaceStatusPatch {
  if (!raw || typeof raw !== "object") throw new TypeError("A workspace status change must be an object.");
  const value = raw as Record<string, unknown>;
  const patch: WorkspaceStatusPatch = {};
  if (value.clear === true) patch.clear = true;
  if (value.status === null) patch.status = null;
  else if (value.status !== undefined) {
    const status = parseWorkspaceStatusId(value.status);
    if (!status) throw new TypeError("Unknown workspace status.");
    patch.status = status;
  }
  if (value.note === null) patch.note = null;
  else if (value.note !== undefined) {
    if (typeof value.note !== "string") throw new TypeError("A workspace note must be text.");
    patch.note = value.note;
  }
  return patch;
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerWorkspaceStatusIpc(handle: IpcHandle): void {
  workspaceStatusStore();
  handle("workspaceStatus:list", (): Promise<WorkspaceStatusMap> => workspaceStatusStore().list());
  handle("workspaceStatus:agentNotes", (): AgentNoteMap => agentNotes().list());
  handle("workspaceStatus:set", async (_event, workspaceId: unknown, rawPatch: unknown): Promise<WorkspaceStatusEntry | null> => {
    if (!isWorkspaceIdLike(workspaceId)) throw new TypeError("workspaceId is required.");
    const patch = workspaceStatusPatchFromIpc(rawPatch);
    if (!patch.clear && (await workspaceName(workspaceId)) === null) {
      throw new Error("That workspace no longer exists.");
    }
    const result = await workspaceStatusStore().update(workspaceId, patch, { kind: "user", label: "You" });
    return result.entry;
  });
}
