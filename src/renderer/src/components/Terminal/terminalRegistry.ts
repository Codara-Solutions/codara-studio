// Module-level adapter injected by App.tsx so the codara-studio MCP terminal
// bridge can spawn an agent-owned terminal tab without a manual user action.
//
// We can't reach React state (useTabs) from the main → ipcRenderer.send
// dispatch path without a hidden context dance, so App registers a callback
// here at mount and terminalRpc calls it. Mirrors Preview/registry.ts'
// setOpenPreviewTabFn. Lives for the renderer process lifetime.

import type { TerminalLeafOrigin } from "../../tabs/types";

export interface CreateAgentTerminalInput {
  // Working directory for the new terminal. Undefined → the adapter defaults it
  // to the calling run's workspace cwd (below), else the active workspace cwd.
  cwd?: string;
  // Optional command autorun into the pane once its shell prompt settles.
  command?: string;
  // Optional tab title; defaults to the usual "terminals" numbering.
  title?: string;
  // Calling run's workspace, resolved by agent-socket from the SPARK_RUN_ID the
  // MCP server stamped on terminal.create. When it names a background
  // workspace, the adapter mints the tab into THAT workspace's layout instead
  // of the active one. Absent for user-facing/non-run agents.
  workspaceId?: string;
  workspaceCwd?: string;
  nativeClaudeProfileId?: string;
  // Trusted device origin supplied by main. Phone-created terminals use this
  // for a live tab badge and tooltip instead of the amber agent tint.
  origin?: TerminalLeafOrigin;
}

export interface CreateAgentTerminalResult {
  tabId: string;
  paneId: string;
  // The cwd actually used (input.cwd or the resolved active-workspace default).
  cwd: string;
}

type CreateAgentTerminalFn = (
  input: CreateAgentTerminalInput,
) => Promise<CreateAgentTerminalResult> | CreateAgentTerminalResult;

let createAgentTerminalFn: CreateAgentTerminalFn | null = null;

export function setCreateAgentTerminalFn(fn: CreateAgentTerminalFn | null): void {
  createAgentTerminalFn = fn;
}

export async function createAgentTerminal(
  input: CreateAgentTerminalInput,
): Promise<CreateAgentTerminalResult> {
  if (!createAgentTerminalFn) {
    throw new Error(
      "Codara is not ready to create terminal tabs yet (renderer not mounted). Retry in a moment.",
    );
  }
  return Promise.resolve(createAgentTerminalFn(input));
}

// Close a terminal tab by id. Used by the terminal.create failure path to remove
// the orphan tab when its PTY never comes online (e.g. a bad cwd), so a failed
// create doesn't leave a dead amber tab behind.
type CloseAgentTerminalFn = (tabId: string) => void;
let closeAgentTerminalFn: CloseAgentTerminalFn | null = null;

export function setCloseAgentTerminalFn(fn: CloseAgentTerminalFn | null): void {
  closeAgentTerminalFn = fn;
}

export function closeAgentTerminal(tabId: string): void {
  // A destroy acknowledgement is the main process's commit signal: once it
  // receives success, it drops the only run/retention ownership record for the
  // pane. Returning success while App is remounting would therefore orphan the
  // visual tab permanently. Surface a retryable bridge error instead; the
  // terminal.create bad-cwd cleanup already treats destroy as best-effort.
  if (!closeAgentTerminalFn) {
    throw new Error(
      "Codara is not ready to close terminal tabs yet (renderer not mounted). Retry in a moment.",
    );
  }
  closeAgentTerminalFn(tabId);
}

type ExternalTerminalSize = { cols: number; rows: number };
type ExternalTerminalSizeHandler = (size: ExternalTerminalSize) => void;

// Phone-origin PTYs are sized by the phone rather than the desktop container.
// Main routes each authenticated terminal.resize through terminalRpc into this
// tiny registry. Keeping the latest size lets a temporarily remounting pane
// catch up before it receives another PTY byte.
const externalTerminalSizes = new Map<string, ExternalTerminalSize>();
const externalTerminalSizeHandlers = new Map<string, ExternalTerminalSizeHandler>();
const MAX_EXTERNAL_TERMINAL_SIZES = 256;

export function setExternalTerminalSize(
  paneId: string,
  cols: number,
  rows: number,
): void {
  const size = { cols, rows };
  externalTerminalSizes.delete(paneId);
  externalTerminalSizes.set(paneId, size);
  while (externalTerminalSizes.size > MAX_EXTERNAL_TERMINAL_SIZES) {
    const oldest = externalTerminalSizes.keys().next().value;
    if (!oldest) break;
    externalTerminalSizes.delete(oldest);
  }
  externalTerminalSizeHandlers.get(paneId)?.(size);
}

export function subscribeExternalTerminalSize(
  paneId: string,
  handler: ExternalTerminalSizeHandler,
): () => void {
  externalTerminalSizeHandlers.set(paneId, handler);
  const current = externalTerminalSizes.get(paneId);
  if (current) handler(current);
  return () => {
    if (externalTerminalSizeHandlers.get(paneId) === handler) {
      externalTerminalSizeHandlers.delete(paneId);
    }
  };
}

export function forgetExternalTerminalSize(paneId: string): void {
  externalTerminalSizes.delete(paneId);
  externalTerminalSizeHandlers.delete(paneId);
}
