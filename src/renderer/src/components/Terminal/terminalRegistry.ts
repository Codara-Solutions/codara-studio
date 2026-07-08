// Module-level adapter injected by App.tsx so the codara-studio MCP terminal
// bridge can spawn an agent-owned terminal tab without a manual user action.
//
// We can't reach React state (useTabs) from the main → ipcRenderer.send
// dispatch path without a hidden context dance, so App registers a callback
// here at mount and terminalRpc calls it. Mirrors Preview/registry.ts'
// setOpenPreviewTabFn. Lives for the renderer process lifetime.

export interface CreateAgentTerminalInput {
  // Working directory for the new terminal. Undefined → the adapter defaults it
  // to the active workspace cwd.
  cwd?: string;
  // Optional command autorun into the pane once its shell prompt settles.
  command?: string;
  // Optional tab title; defaults to the usual "terminals" numbering.
  title?: string;
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
  // No-op if unregistered — the caller is best-effort cleanup and must not throw
  // just because the renderer already tore the adapter down.
  closeAgentTerminalFn?.(tabId);
}
