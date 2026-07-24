// Tab discriminated union for the workspace's tabs+stacks layout.
//
// Every "kind" maps 1:1 to a Stack component (ChatStack, EditorStack,
// TerminalStack, PreviewStack, RunsStack). The Stack is responsible for keeping every tab
// of its kind mounted in an absolutely positioned div and toggling
// `visibility: hidden` + `pointer-events: none` based on whether the tab
// owns the active id. Mounting is the contract that keeps editor cursors,
// terminal PTYs, and dev-server iframes alive across tab switches.

import type { FsEntry, RuntimeState } from "@shared/types";

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

// Durable pointer to a Claude/Codex CLI session detected in a terminal leaf,
// whether it came from Codara's launcher or a command typed by the user.
// Persisted with the tab layout so a reopen can relaunch the same conversation
// with `claude --resume <id>` /
// `codex resume <id>`. Only the session id (+ its cwd) is stored — the transcript
// itself lives in the CLI's own on-disk history and is rehydrated by --resume.
// Unlike `worker`/`autorun` (transient, stripped on save), this survives restart.
export interface TerminalAgentSession {
  runtime: "claude" | "codex";
  // Claude: UUID we forced with `--session-id`. Codex: UUID discovered from the
  // rollout filename after launch. Empty string means "capture still pending"
  // (Codex, before discovery resolves).
  sessionId: string;
  // The exact cwd the session was launched from. Claude resume is scoped to this
  // directory's project bucket, so restore must relaunch from the same cwd.
  cwd: string;
  // Full path to the CLI's jsonl transcript, when known — lets restore probe
  // existence with a single stat (mainly for Codex, whose sessions are not
  // path-addressable by cwd).
  transcriptPath?: string;
  // ISO timestamp of capture; debugging / staleness only.
  capturedAt: string;
  // True while the pane's runtime poller currently detects this agent running;
  // undefined/false = not running. Restore eligibility requires active===true
  // in the persisted blob — old blobs without the field are deliberately not
  // restore-eligible (only sessions RUNNING at quit come back on reopen).
  active?: boolean;
}

// Each terminal tab owns a recursive tree of panes. A leaf is one PTY-backed
// pane; a split renders two children separated by a draggable handle. The tab
// remembers which leaf is "active" so split / close shortcuts know what to
// operate on, and so per-pane URL detection can highlight the right surface.
export interface TerminalLeaf {
  kind: "leaf";
  paneId: string;
  cwd?: string;
  // Runtime scrollback snapshot used to preserve context while panes move
  // between mounted workspace layers. Cold hydration strips it, so a full app
  // relaunch always starts with a clean shell.
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
  // Durable Claude/Codex session pointer for an agent running in this pane.
  // Cold hydration validates it and marks an active session as eligible for the
  // opt-in resume-on-launch flow; the preference is checked before any command
  // is started.
  agentSession?: TerminalAgentSession | null;
  // Runtime-only, one-shot cold-restore marker. It is derived from a validated
  // active agentSession during hydration and is never written to localStorage.
  bootResume?: boolean;
}

export interface TerminalLeafWorker {
  runtime?: "claude" | "codex" | "opencode";
  runId: string;
  workerTaskId: string;
  attemptId: string;
  source: "spark" | "manual";
  // Human task title (WorkerTask.title) shown in the worker pane header so the
  // user can tell panes apart. Best-effort: filled from a getRun lookup, so it
  // can lag the pane by a beat or stay unset if the lookup fails.
  title?: string;
  // 1-based WorkerAttempt.attemptNumber. The pane header shows "attempt N"
  // when > 1, and open-from-graph prefers the leaf with the highest ordinal.
  attemptOrdinal?: number;
  // Which harness executes the attempt: "cli" panes host a real provider TUI,
  // "pi" panes mirror the main-process Pi event stream. Derived from
  // WorkerAttempt.command, which is only stamped at launch — undefined before
  // then.
  harness?: "pi" | "cli";
  // WorkerAttempt.startedAt (ISO). Drives the header's live elapsed readout;
  // absent until the attempt has actually launched.
  startedAt?: string;
  // Lifecycle of the worker attempt. While "running" the chip pulses; on
  // "done" the pane may show a static completion chip until the foreground
  // agent exits and the shell prompt is back.
  state: "running" | "done";
  // Foreground Claude/Codex process state as sniffed from the terminal
  // stream. Codara can finish the attempt before the user exits the TUI; once
  // the shell prompt is back, the pane should stop showing an agent chip.
  agentRunning?: boolean;
  // Finer-grained live state of the foreground agent. Two writers feed it: the
  // visible-buffer poller in useTerminalSession (fast, freezes when the pane is
  // hidden) and the focus-independent main-process notifier
  // (terminal-agent-notify.ts → terminal-agent:state → App's onState effect),
  // which covers the hidden case where a turn finishes off-screen. Distinct from
  // `state` (the attempt LIFECYCLE): `runtimeState` drives the chip's label +
  // dot tone — "launching" (calm "starting"), "working" (pulsing accent),
  // "blocked" (steady amber "needs you"), "idle" (calm green "ready" — your
  // turn), "error" (red "exited"), or "done". Undefined until the first report.
  runtimeState?: RuntimeState;
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
  // Opaque CSS color token (e.g. "var(--agent-tab-accent)") marking the tab as
  // owned by a background agent that created it on the user's behalf. Drives the
  // tinted glyph + pill edge in TabBar so the user can tell an agent opened it.
  // Undefined for ordinary user-opened terminals. Stored as a token reference
  // rather than a literal so palette changes need no tab-model migration.
  // Persisted with the tab (it is not a leaf field, so the transient-state
  // strippers leave it intact).
  color?: string;
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
  // When the preview was spawned by an orchestration run (URL detector inside
  // a worker pane, or an orchestrator file-preview opener), this carries the
  // owning run id so the chat panel can render the preview inside its inner
  // tab strip. User-opened previews (TabBar picker, Codara browser) leave it
  // unset and stay top-level.
  runId?: string;
}

// Runs tabs are derived from the selected chat. `runId === null` is kept only
// for backward-compatible persisted shapes; new visible Runs tabs point at a
// concrete chat/run.
export interface RunsTab extends BaseTab {
  kind: "runs";
  runId: string | null;
}

// A working-tree / index diff opened as its own workbench tab (VS Code's
// "file.ts (Working Tree)"). Identity is (path, staged) — everything else
// (untracked, renamed, still-changed-at-all) is derived live from the shared
// GitStatus at render time, so rename/commit/discard while the tab is open
// degrade gracefully instead of needing invalidation plumbing. The payload is
// intentionally this small so persistence needs no special casing.
export interface DiffTab extends BaseTab {
  kind: "diff";
  // Repo-relative path, forward-slash separated — matches GitFileChange.path.
  path: string;
  // true = diff of the index vs HEAD (staged); false = working tree vs index.
  staged: boolean;
}

// Automations tabs host the workspace's scheduler + overnight-queue panel.
// Modeled on RunsTab: a single workspace-scoped surface mounted absolutely by
// AutomationsStack, with no per-tab payload beyond the base id/title (the panel
// reads the active workspace's id/name/cwd from props passed down by App).
export interface AutomationsTab extends BaseTab {
  kind: "automations";
}

// An untitled whiteboard draft opened from the "+" picker. The board content
// itself is runtime-only (a module-level draft map in WhiteboardFilePreview
// keyed by this tab's id), so these tabs are never restored from a persisted
// layout — the first save-as replaces the draft tab with a regular editor tab
// bound to the saved .coraboard file, which IS durable.
export interface WhiteboardTab extends BaseTab {
  kind: "whiteboard";
}

export type Tab =
  | ChatTab
  | EditorTab
  | TerminalTab
  | PreviewTab
  | RunsTab
  | AutomationsTab
  | WhiteboardTab
  | DiffTab;

export type TabKind = Tab["kind"];

// True when a tab represents content owned by an orchestration run (worker
// terminal, Runs canvas, orchestration-spawned preview). These render inside
// the chat panel's inner tab strip instead of the top tab bar — which also
// means they have NO pill anywhere once their owning chat tab is closed, so
// tab-close/reroute logic must never leave one of them as the active tab.
// Shared by App (strip filtering) and useTabs (close-time active rerouting).
export function isRunOwnedTab(tab: Tab): boolean {
  if (tab.kind === "terminal" && tab.scope?.kind === "workers") return true;
  if (tab.kind === "runs") return true;
  if (tab.kind === "preview" && tab.runId) return true;
  return false;
}
