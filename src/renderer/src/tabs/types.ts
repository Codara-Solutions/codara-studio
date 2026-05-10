// Tab discriminated union for the workspace's tabs+stacks layout.
//
// Every "kind" maps 1:1 to a Stack component (EditorStack, TerminalStack,
// PreviewStack, RunsStack). The Stack is responsible for keeping every tab
// of its kind mounted in an absolutely positioned div and toggling
// `visibility: hidden` + `pointer-events: none` based on whether the tab
// owns the active id. Mounting is the contract that keeps editor cursors,
// terminal PTYs, and dev-server iframes alive across tab switches.

import type { FsEntry } from "@shared/types";

export type TabId = string;

export interface BaseTab {
  id: TabId;
  title: string;
}

export interface EditorTab extends BaseTab {
  kind: "editor";
  // Path on disk; the editor stack uses path as its content key.
  path: string;
  // Synthesized FsEntry that the existing EditorPane component expects. The
  // tab carries it so the FileTree click → openFileTab path can pre-fill
  // ext/name without a second IPC round-trip.
  entry: FsEntry;
  dirty: boolean;
}

export interface TerminalTab extends BaseTab {
  kind: "terminal";
  cwd?: string;
  // Locally remembered URL detected on this terminal's stdout. Used to
  // suppress repeat preview-tab spawns from the same terminal.
  detectedUrl?: string;
}

export interface PreviewTab extends BaseTab {
  kind: "preview";
  url: string;
}

// `runId === null` shows the "all runs" placeholder; concrete ids open one
// canvas per run. The runs stack keeps RunsView mounted so the user keeps
// their pan/zoom across tab switches.
export interface RunsTab extends BaseTab {
  kind: "runs";
  runId: string | null;
}

export type Tab = EditorTab | TerminalTab | PreviewTab | RunsTab;

export type TabKind = Tab["kind"];
