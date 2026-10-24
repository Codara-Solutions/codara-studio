import React, { createContext, useContext } from "react";
import type { QuickCommand, TerminalRightClickPref } from "@shared/quick-commands";

// What the quick command surfaces (tab strip button, terminal menu, palette,
// Settings page) share: the saved list, the active workspace's repository,
// and the one run path. App builds it with useQuickCommandsApi.

export interface QuickCommandRepoOption {
  /** The repository key a scope stores. */
  key: string;
  /** Workspace names that share it, for the scope picker. */
  label: string;
}

export interface RunQuickCommandOptions {
  /** A right-click names its own pane as "the focused terminal". */
  paneId?: string;
}

export interface QuickCommandsApi {
  /** Every saved command, in saved order. */
  commands: readonly QuickCommand[];
  hydrated: boolean;
  workspaceId: string | null;
  /** The active workspace's repository key, or null without a workspace. */
  repoKey: string | null;
  repoName: string | null;
  /** Repositories of the open workspaces, for the scope picker. */
  repoOptions: readonly QuickCommandRepoOption[];
  terminalRightClick: TerminalRightClickPref;
  run: (command: QuickCommand, options?: RunQuickCommandOptions) => Promise<void>;
  save: (commands: QuickCommand[]) => Promise<void>;
  setTerminalRightClick: (pref: TerminalRightClickPref) => Promise<void>;
}

const QuickCommandsContext = createContext<QuickCommandsApi | null>(null);

export function QuickCommandsProvider({ value, children }: { value: QuickCommandsApi; children: React.ReactNode }) {
  return <QuickCommandsContext.Provider value={value}>{children}</QuickCommandsContext.Provider>;
}

/** The API when App mounted one; surfaces rendered outside App (tests) have none. */
export function useOptionalQuickCommands(): QuickCommandsApi | null {
  return useContext(QuickCommandsContext);
}
