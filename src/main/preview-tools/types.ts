// The contract between the agent socket and the modules in this folder.
// A module exports a table from socket method name to handler; index.ts
// merges the tables, so a module that adds a method edits only itself.

/** What a handler needs from the agent socket, passed in so modules import no socket internals. */
export interface PreviewToolHost {
  /** Stamps the caller's workspace and pane from callerPid / callerPaneId (no run). */
  scopeToCaller(params: Record<string, unknown>): Promise<void>;
  getRun(runId: string): Promise<{ workspaceId?: string | null } | null>;
  /**
   * Whether this caller may drive a tab of the user's own browser, with its
   * logged-in sessions. False for an imported pull-request run.
   */
  mayUseUserBrowser(params: Record<string, unknown>): Promise<boolean>;
  /** A workspace's name, or the one on screen for null; null when there is none. */
  workspaceName?(workspaceId: string | null): Promise<string | null>;
  /** Whether the caller opened this terminal pane and it is still running (codara_tab). */
  ownsTerminalPane?(paneId: string, runId: string | null, callerPaneId: string | null): boolean;
  /** Whether an agent CLI still holds a session in this pane, idle at its prompt included. */
  agentRunningIn?(paneId: string): boolean;
}

export type PreviewToolHandler = (params: Record<string, unknown>, method: string, host: PreviewToolHost) => Promise<unknown>;

export interface PreviewToolEntry {
  run: PreviewToolHandler;
  /**
   * "browser" (the default for preview.*) resolves the caller's workspace and
   * pane, or the run's workspace, before the handler runs; a run whose
   * workspace is gone is refused. "none" passes the params through untouched.
   */
  scope?: "browser" | "none";
  /**
   * Which tabs the handler can drive. "preview" (the default) handlers only
   * know Codara's own tabs; a `chrome:` tabId then goes to the Chrome table
   * (chrome.ts) or is refused. "any" handlers resolve their tab with
   * resolveBrowserTarget() and work on both.
   */
  targets?: "preview" | "any";
  /**
   * Refused for an imported pull-request run at the socket, before any
   * handler runs, like terminal execution. Set it on anything that runs
   * commands, starts processes or writes outside the browser tab.
   */
  trustedRunsOnly?: boolean;
}

export type PreviewToolTable = Readonly<Record<string, PreviewToolHandler | PreviewToolEntry>>;

/** Thrown for a bad argument; the socket answers it with invalid-params instead of an internal error. */
export class PreviewToolParamsError extends Error {}
