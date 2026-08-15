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
  // Main-resolved identity for a local phone-created Claude terminal. SSH
  // terminals never receive local account profiles.
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

export interface ShareableStudioTerminal {
  paneId: string;
  tabId: string;
  workspaceId: string;
  title?: string;
  cwd?: string;
  profile: "shell" | "claude" | "codex";
}

type ListShareableStudioTerminalsFn = () => ShareableStudioTerminal[];
let listShareableStudioTerminalsFn: ListShareableStudioTerminalsFn | null = null;

export function setListShareableStudioTerminalsFn(
  fn: ListShareableStudioTerminalsFn | null,
): void {
  listShareableStudioTerminalsFn = fn;
}

export function listShareableStudioTerminals(): ShareableStudioTerminal[] {
  return listShareableStudioTerminalsFn?.() ?? [];
}

type CreateAgentTerminalFn = (
  input: CreateAgentTerminalInput,
) => Promise<CreateAgentTerminalResult> | CreateAgentTerminalResult;

let createAgentTerminalFn: CreateAgentTerminalFn | null = null;

// A bridge create can land while App is between adapter registrations: app
// boot (main's remote-access listener is up ~1.5s before React mounts), a
// window reload, or a dev HMR remount. The old instant throw told the caller
// to "retry in a moment", but neither the phone's terminal.create nor the MCP
// bridge retries — the spawn failed outright inside a gap that closes by
// itself. So createAgentTerminal waits boundedly for the adapter instead; the
// error remains for a renderer that genuinely never comes up.
const CREATE_FN_REGISTRATION_WAIT_MS = 10_000;
const createFnWaiters = new Set<(fn: CreateAgentTerminalFn) => void>();

export function setCreateAgentTerminalFn(fn: CreateAgentTerminalFn | null): void {
  createAgentTerminalFn = fn;
  if (fn) {
    for (const waiter of [...createFnWaiters]) waiter(fn);
    createFnWaiters.clear();
  }
}

export async function createAgentTerminal(
  input: CreateAgentTerminalInput,
  registrationWaitMs: number = CREATE_FN_REGISTRATION_WAIT_MS,
): Promise<CreateAgentTerminalResult> {
  let fn = createAgentTerminalFn;
  if (!fn) {
    fn = await new Promise<CreateAgentTerminalFn | null>((resolve) => {
      const waiter = (registered: CreateAgentTerminalFn): void => {
        clearTimeout(timer);
        resolve(registered);
      };
      const timer = setTimeout(() => {
        createFnWaiters.delete(waiter);
        resolve(null);
      }, registrationWaitMs);
      createFnWaiters.add(waiter);
    });
  }
  if (!fn) {
    throw new Error(
      "Codara is not ready to create terminal tabs yet (renderer not mounted). Retry in a moment.",
    );
  }
  return Promise.resolve(fn(input));
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
