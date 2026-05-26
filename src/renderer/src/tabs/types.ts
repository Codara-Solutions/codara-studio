// Tab discriminated union for the workspace's tabs+stacks layout.
//
// Every "kind" maps 1:1 to a Stack component (ChatStack, EditorStack,
// TerminalStack, PreviewStack, RunsStack). The Stack is responsible for keeping every tab
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

export interface ChatTab extends BaseTab {
  kind: "chat";
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
  // VS Code-style preview tabs are temporary: opening another file replaces
  // the preview until the tab is pinned by double-clicking or by editing.
  preview?: boolean;
}

// Each terminal tab owns a recursive tree of panes. A leaf is one PTY-backed
// pane; a split renders two children separated by a draggable handle. The tab
// remembers which leaf is "active" so split / close shortcuts know what to
// operate on, and so per-pane URL detection can highlight the right surface.
export interface TerminalLeaf {
  kind: "leaf";
  paneId: string;
  cwd?: string;
  // Last visible scrollback captured before/while the app was running. PTY
  // processes cannot survive a full app quit, but replaying this snapshot
  // gives restored panes their previous context before the fresh prompt.
  scrollback?: string;
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
  runtime?: "claude" | "codex" | "cursor" | "opencode";
  runId: string;
  workerTaskId: string;
  attemptId: string;
  source: "spark" | "manual";
  // Lifecycle of the worker attempt. While "running" the chip pulses; on
  // "done" the pane may show a static completion chip until the foreground
  // agent exits and the shell prompt is back.
  state: "running" | "done";
  // Foreground Claude/Codex process state as sniffed from the terminal
  // stream. Spark can finish the attempt before the user exits the TUI; once
  // the shell prompt is back, the pane should stop showing an agent chip.
  agentRunning?: boolean;
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
  // Run-scoped worker tabs are mounted like normal terminals so their PTYs
  // keep running, but the tab strip only shows them while their run is the
  // active chat.
  scope?: {
    kind: "workers";
    runId: string;
  };
  // When set, the named leaf is displayed at full tab size and every other
  // leaf is hidden via CSS (display:none) — but kept mounted, so xterm
  // canvases and PTY connections survive the zoom toggle. The split tree and
  // its ratios are untouched; on unzoom the original layout is restored
  // pixel-for-pixel. Cleared automatically when the leaf is closed or the
  // pane is split.
  zoomedPaneId?: string | null;
}

export interface PreviewTab extends BaseTab {
  kind: "preview";
  url: string;
}

// Runs tabs are derived from the selected chat. `runId === null` is kept only
// for backward-compatible persisted shapes; new visible Runs tabs point at a
// concrete chat/run.
export interface RunsTab extends BaseTab {
  kind: "runs";
  runId: string | null;
}

export type Tab = ChatTab | EditorTab | TerminalTab | PreviewTab | RunsTab;

export type TabKind = Tab["kind"];
