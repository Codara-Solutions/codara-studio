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

// Each terminal tab owns a recursive tree of panes. A leaf is one PTY-backed
// pane; a split renders two children separated by a draggable handle. The tab
// remembers which leaf is "active" so split / close shortcuts know what to
// operate on, and so per-pane URL detection can highlight the right surface.
export interface TerminalLeaf {
  kind: "leaf";
  paneId: string;
  cwd?: string;
  // Locally remembered URL sniffed on this leaf's stdout. Used to suppress
  // repeat preview-tab spawns from the same pane.
  detectedUrl?: string;
  // Set when an orchestration worker is hosted in this leaf. The pane still
  // renders as a normal TerminalPane (so the user sees live agent output);
  // the meta drives a small chip overlay and prevents the leaf from being
  // claimed for another worker while one is running.
  worker?: TerminalLeafWorker | null;
  // One-shot shell command typed into the PTY once the shell prompt has
  // settled. Used by the "Worker — Claude/Codex" entries in the new-tab
  // picker to auto-launch the agent CLI without the user having to retype
  // the flags. Consumed by useTerminalSession on first spawn and ignored on
  // any later re-mount (the PTY persists across remounts, so the command
  // should only fire once per session).
  autorun?: string;
}

export interface TerminalLeafWorker {
  runtime?: "claude" | "codex" | "opencode";
  runId: string;
  workerTaskId: string;
  attemptId: string;
  source?: "spark" | "manual";
  // Lifecycle of the worker pane. While "running" the chip pulses; on
  // "done" the pane sticks around so the user can read the output, but
  // the next worker can claim it (it's idle again).
  state: "running" | "done";
}

export interface TerminalSplit {
  kind: "split";
  // "horizontal" = side-by-side (a | b); "vertical" = stacked (a / b).
  direction: "horizontal" | "vertical";
  // Fraction of the container occupied by `a` (0..1). Persisted so the user's
  // drag survives tab switches and re-renders.
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = TerminalLeaf | TerminalSplit;

export interface TerminalTab extends BaseTab {
  kind: "terminal";
  root: PaneNode;
  activePaneId: string;
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
