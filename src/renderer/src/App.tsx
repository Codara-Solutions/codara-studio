import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppState,
  BoardCard,
  ChatBackendKind,
  FsEntry,
  GitFileChange,
  GitStatus,
  InAppNotificationKind,
  PtyExitInfo,
  RunState,
  RuntimeState,
  ShellInfo,
  SparkEvent,
  TerminalAgentTarget,
  TerminalAgentForegroundState,
  TerminalAgentStatePayload,
  WorkerSessionRuntime,
  WorkerSessionSummary,
  Workspace,
  WorkspaceGroup,
} from "@shared/types";
import {
  DEFAULT_COPY_BRANCH_SETUP_COMMAND,
  TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
} from "@shared/types";
import type {
  GitHubIssueSummary,
  GitHubWorkQueueItem,
} from "@shared/github";
import { makeId } from "@shared/ids";
import {
  applyWorkspaceGroupShades,
  ensureWorkspaceGroupColors,
  normalizeWorkspaceColor,
  pickWorkspaceColor,
} from "@shared/workspace-colors";
import WindowChrome from "./components/WindowChrome";
import WorkspaceRail from "./components/WorkspaceRail";
import StatusBar from "./components/StatusBar";
import UpdateBanner from "./components/UpdateBanner";
import SearchPanel from "./components/Search/SearchPanel";
import FileSearchPanel from "./components/Search/FileSearchPanel";
import ToastHost from "./components/Toast";
import WorkerSessionPicker, {
  type WorkerSessionPickerRequest,
} from "./components/WorkerSessionPicker";
import RunSwitcher from "./components/RunSwitcher";
import { CopyBranchDeleteDialog } from "./components/CopyBranchDialogs";
import CreateCopyDialog from "./components/CreateCopyDialog";
import { playNotificationSound } from "./components/notification-sounds";
import TabBar, { type PickerHints } from "./tabs/TabBar";
import ChatStack from "./tabs/ChatStack";
import { boardBackend } from "./components/board/board-backend";
import { peekChatComposerChipConfig } from "./components/chat/ChatComposer";
import InnerTabStrip from "./tabs/InnerTabStrip";
import TerminalStack from "./tabs/TerminalStack";
import { buildDockIndex, isDockLeaf } from "./tabs/dock";
import PreviewStack from "./tabs/PreviewStack";
import { setOpenPreviewTabFn } from "./components/Preview/registry";
import {
  setCloseAgentTerminalFn,
  setCreateAgentTerminalFn,
  setListShareableStudioTerminalsFn,
} from "./components/Terminal/terminalRegistry";
import { mergeSessionStart } from "./components/Terminal/resume-policy";
import DiffStack from "./tabs/DiffStack";
import { useSharedGitStatus } from "./git/useSharedGitStatus";
import RemoteAuthPrompt from "./components/remote/RemoteAuthPrompt";
import SshManagerDialog from "./components/remote/SshManagerDialog";
import { makeRemotePath, type RemoteHostConfig } from "@shared/remote";
import { useTabs, isDraftChatTabId, restoredChatRunIds, sameWorkerMeta } from "./tabs/useTabs";
import { useChatSurfaces } from "./tabs/chatSurfaces";
import { createNavigateTo, useNotifyFocusRouting } from "./notifications/routing";
import type { ActiveNotificationView } from "./notifications/viewed";
import type { TerminalPaneDragPayload } from "./tabs/terminalDrag";
import type {
  PaneNode,
  PreviewTab,
  RunsTab,
  Tab,
  TabId,
  TerminalAgentSession,
  TerminalLeaf,
  TerminalLeafWorker,
  TerminalTab,
} from "./tabs/types";
import { isRunOwnedTab } from "./tabs/types";
import {
  createManualAgentLaunchWorker,
  isPaneAgentInjectable,
  mergeTerminalRuntimeState,
} from "./tabs/terminalAgentState";
import {
  resolveEffectiveActiveId,
  resolveTopStripActiveId,
  runOwnedTabRunId,
} from "./tabs/workbenchRouting";
import type { CoraView } from "./components/chat/cora-view";
import { basename } from "./path-utils";
import ShortcutsDialog from "./shortcuts/ShortcutsDialog";
import { useGlobalShortcuts, type ShortcutHandlers } from "./shortcuts/useGlobalShortcuts";
import { buildBindingTable, type BindingTable } from "./shortcuts/bindings";
import { chordToHint } from "./shortcuts/chord";
import type { CommandId } from "./shortcuts/commands";
import { isRecording } from "./shortcuts/recording";
import { IS_MAC } from "./shortcuts/platform";
import { usePreferences } from "./preferences/usePreferences";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
  buildAgentResumeCommand,
  runtimeFromAgentSessionLaunchCommand,
} from "./workers/launch-commands";
import { usePanelLayout, type PanelSectionKey, type PanelSide } from "./panels/usePanelLayout";
import ResizeHandle from "./panels/ResizeHandle";
import {
  SelectionRoutingProvider,
  type RoutingDestination,
  type SelectionPayload,
  type SelectionRoutingApi,
} from "./routing/SelectionRoutingContext";
import {
  enumerateOpenWorkers,
  workerMenuLabel,
} from "./routing/enumerate-open-workers";
import { useGlobalRuns } from "./lib/useGlobalRuns";
import { onSettingsChanged, publishSettings } from "./lib/useOpenAiFastMode";
import { isRunningStatus } from "./lib/run-status";
import { isAppTearingDown, markAppTearingDown } from "./lib/app-lifecycle";
import {
  buildAwayDigest,
  captureAwayDigestBaseline,
  compareRunsByAttention,
  describeRunStatus,
  findOpenQuestion,
  pruneAwayDigest,
  statusToneColor,
  type AwayDigest,
  type AwayDigestBaseline,
  type ChatStatusTone,
} from "./components/chat/timeline";

// Keep the heavyweight settings surfaces out of the startup bundle, but warm
// their chunks as soon as the workbench has an idle slice. Without this, the
// first click has to fetch, parse, and evaluate several thousand lines before
// React can paint anything, which reads as a missed/laggy click.
const loadSettingsDialog = () => import("./components/SettingsDialog");
const loadAgentCapabilitiesDialog = () => import("./components/AgentCapabilitiesDialog");
const SettingsDialog = lazy(loadSettingsDialog);
const SessionInspector = lazy(() => import("./components/SessionInspector"));
const AgentCapabilitiesDialog = lazy(loadAgentCapabilitiesDialog);
const EditorStack = lazy(() => import("./tabs/EditorStack"));
const RunsStack = lazy(() => import("./tabs/RunsStack"));
const AutomationsStack = lazy(() => import("./tabs/AutomationsStack"));
const UsageStack = lazy(() => import("./tabs/UsageStack"));
const WhiteboardStack = lazy(() => import("./tabs/WhiteboardStack"));

// React StrictMode intentionally remounts effects in development. The ready
// handshake is document-scoped, so send it once per evaluated renderer module
// rather than logging/disarming the same boot twice.
let rendererReadySignaled = false;

// Stable brand label for every chat tab in the top strip. The first-message-
// derived run.title is kept on the RunState for the chat panel header and the
// history popover; only the workspace tab strip is forced to this constant so
// short prompts ("hello") don't surface as truncated "He..." labels.
const CHAT_TAB_LABEL = "Cora";
const EXACT_GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

const DEFAULT_SETTINGS: AppSettings = {
  defaultShellId: null,
  openAiFastMode: false,
  terminalScrollbackLineLimit: TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  openRouterApiKey: "",
  openRouterModel: "google/gemini-flash-latest",
  commitMessageModel: "auto",
  agentMcpSyncEnabled: true,
  agentSkillSyncEnabled: true,
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
  agentMcpCoraManagerIds: [],
  agentMcpPiWorkerIds: [],
  playwrightMcpAutoInstall: true,
  autopilotSandbox: false,
};

function resolveDefaultShell(
  shells: ShellInfo[],
  settings: AppSettings,
  detectedDefault: ShellInfo | null,
): ShellInfo | null {
  return shells.find((shell) => shell.id === settings.defaultShellId) ?? detectedDefault ?? shells[0] ?? null;
}

function entryFromPath(path: string): FsEntry {
  const segments = path.split(/[\\/]/);
  const name = segments[segments.length - 1] || path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
  return { name, path, isDir: false, ext };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

// Resolve a single inline keybind hint string for a command id from the
// effective binding table. Uses the first/primary chord; returns undefined
// when the command is unbound (the picker then renders no hint at all).
function hintForCommand(table: BindingTable, id: CommandId): string | undefined {
  const binding = table.find((b) => b.command.id === id);
  const chord = binding?.chords[0];
  return chord ? chordToHint(chord) : undefined;
}

function isBrowserUrl(url: string): boolean {
  return /^(https?:|file:)/i.test(url);
}

// Every real Cora chat owns stable run surfaces from its first snapshot. Runs
// and Whiteboard must not pop into the navigation several seconds later just
// because planning or delegation finally produced an artifact.
// Runs the board engine started for a Cora Board card. Like loom-owned runs
// (automationId) they never auto-materialize chat tabs or cockpit rows — their
// surface is the board — except where a site deliberately resurfaces blocked
// runs ("needs you" must still reach the user).
function isBoardCardRun(run: RunState): boolean {
  return Boolean(run.boardCardId);
}

function runHasWorkbench(run: RunState): boolean {
  return Boolean(run.id);
}

function collectTerminalPaneIds(node: PaneNode, ids: Set<string>): void {
  if (node.kind === "leaf") {
    // Dock cells borrow the grid's geometry for another tab's content; their
    // id was never a PTY session.
    if (!isDockLeaf(node)) ids.add(node.paneId);
    return;
  }
  collectTerminalPaneIds(node.a, ids);
  collectTerminalPaneIds(node.b, ids);
}

function countTerminalPanes(node: PaneNode): number {
  if (node.kind === "leaf") return 1;
  return countTerminalPanes(node.a) + countTerminalPanes(node.b);
}

function disposeTerminalPanesInTabs(tabs: Tab[]): void {
  const paneIds = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind === "terminal") collectTerminalPaneIds(tab.root, paneIds);
  }
  for (const paneId of paneIds) {
    void window.spark.pty.dispose(paneId).catch(() => undefined);
  }
}

function disposePersistedWorkspaceTerminalPanes(workspaceId: string): void {
  try {
    const raw = window.localStorage.getItem(`spark.tabs:${workspaceId}`);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { tabs?: Tab[] };
    if (Array.isArray(parsed.tabs)) disposeTerminalPanesInTabs(parsed.tabs);
  } catch {
    /* best-effort cleanup only */
  }
}

function findLeafByPaneId(node: PaneNode, paneId: string): TerminalLeaf | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeafByPaneId(node.a, paneId) ?? findLeafByPaneId(node.b, paneId);
}

function findWorkerLeafByTaskId(node: PaneNode, workerTaskId: string): TerminalLeaf | null {
  // Prefer the pane hosting the task's LATEST attempt so open-from-graph lands
  // on the live retry, not a finished predecessor. attemptOrdinal is
  // best-effort metadata; `>=` keeps the later-in-tree pane on ties/absence
  // (retries historically appended to the right of the grid).
  let best: TerminalLeaf | null = null;
  forEachTerminalLeaf(node, (leaf) => {
    if (leaf.worker?.workerTaskId !== workerTaskId) return;
    if (!best || (leaf.worker.attemptOrdinal ?? 0) >= (best.worker?.attemptOrdinal ?? 0)) {
      best = leaf;
    }
  });
  return best;
}

// WorkerAttempt.command is stamped at launch: the Pi worker harness records a
// "Pi harness (...)" descriptor there instead of a CLI command line. Undefined
// before launch — the header simply omits the harness until then.
function workerHarnessFromCommand(command: string | undefined): "pi" | "cli" | undefined {
  if (!command) return undefined;
  return command.startsWith("Pi harness") ? "pi" : "cli";
}

// Value-equality proxy for the lifted runs list. Main bumps run.updatedAt on
// every committed run change, so id + updatedAt (plus the cheap renderer-
// visible scalars) identify an unchanged snapshot. Refresh paths use this to
// keep the previous state reference when a poll found nothing new — otherwise
// each 1s listRuns round-trip republishes a fresh array and re-renders the
// whole app.
function sameRunsList(a: RunState[], b: RunState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.updatedAt !== y.updatedAt ||
      x.status !== y.status ||
      x.seen !== y.seen
    ) {
      return false;
    }
  }
  return true;
}

function forEachTerminalLeaf(node: PaneNode, fn: (leaf: TerminalLeaf) => void): void {
  if (node.kind === "leaf") {
    fn(node);
    return;
  }
  forEachTerminalLeaf(node.a, fn);
  forEachTerminalLeaf(node.b, fn);
}

function countRunningWorkerLeaves(node: PaneNode): number {
  if (node.kind === "leaf") {
    return node.worker?.state === "running" && node.worker.agentRunning !== false ? 1 : 0;
  }
  return countRunningWorkerLeaves(node.a) + countRunningWorkerLeaves(node.b);
}

function countRunningTerminalWorkers(tabs: Tab[]): number {
  return tabs.reduce(
    (count, tab) => count + (tab.kind === "terminal" ? countRunningWorkerLeaves(tab.root) : 0),
    0,
  );
}

function normalizedWorkspaceRailOrder(
  order: readonly string[],
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
): string[] {
  const eligible = new Set([
    ...workspaces.filter((workspace) => !workspace.groupId).map((workspace) => workspace.id),
    ...groups.map((group) => group.id),
  ]);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (!eligible.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of eligible) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

export default function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [createCopyDialogWs, setCreateCopyDialogWs] = useState<Workspace | null>(null);
  const [createCopyBusy, setCreateCopyBusy] = useState(false);
  const [createCopyError, setCreateCopyError] = useState<string | null>(null);
  const [workspaceGroups, setWorkspaceGroups] = useState<WorkspaceGroup[]>([]);
  const [workspaceRailOrder, setWorkspaceRailOrder] = useState<string[]>([]);
  const workspaceGroupsRef = useRef(workspaceGroups);
  workspaceGroupsRef.current = workspaceGroups;
  const workspaceRailOrderRef = useRef(workspaceRailOrder);
  workspaceRailOrderRef.current = workspaceRailOrder;
  const [pendingCopyDelete, setPendingCopyDelete] = useState<Workspace | null>(null);
  const [copyDeleteBusy, setCopyDeleteBusy] = useState(false);
  const [copyDeleteError, setCopyDeleteError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [compactWorkbench, setCompactWorkbench] = useState(
    () => window.matchMedia("(max-width: 1050px)").matches,
  );
  const [compactPanel, setCompactPanel] = useState<"left" | "right" | null>(null);
  // Runs for the currently active workspace, plus the user's selection. Lifted
  // here so the workbench RunsView and Codara chat tab both read from the same
  // source of truth: picking a chat updates the graph, deleting a chat removes
  // it everywhere.
  const [runs, setRuns] = useState<RunState[]>([]);
  // Identifies which workspace the async `runs` payload belongs to. During a
  // workspace switch the previous payload remains in state until listRuns
  // resolves; consumers use this owner id to retain the destination chat's
  // last snapshot instead of briefly painting an empty/new conversation.
  const [runsWorkspaceId, setRunsWorkspaceId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Each workspace has its own Codara chat selection. The visible state stays
  // as a single activeRunId, but this map lets workspace switches restore the
  // previous chat instead of inheriting another workspace's draft/new-chat UI.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;
  const activeRunIdsByWorkspaceRef = useRef<Record<string, string | null>>({});
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [defaultShell, setDefaultShell] = useState<ShellInfo | null>(null);
  const [detectedDefaultShell, setDetectedDefaultShell] = useState<ShellInfo | null>(null);
  // Default shell augmented with the bundled OSC 7/133/633/8888 shell
  // integration. Used as the launch profile for terminal tabs so a fresh
  // interactive pane reports cwd/prompt/open-file events to the renderer.
  const [integratedShell, setIntegratedShell] = useState<ShellInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remoteConnectOpen, setRemoteConnectOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [workerSessionPicker, setWorkerSessionPicker] =
    useState<WorkerSessionPickerRequest | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  // Pure renderer overlay — reads the active run, displays cost / events /
  // context-window / failure tabs. Toggled via the `session.openInspector`
  // shortcut (Mod+Shift+I).
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Cmd/Ctrl-K recent-run picker. It is mounted only while open so the closed
  // picker has zero rendering cost; RunSwitcher drops orphaned workspace
  // history and caps its rows.
  const [runSwitcherOpen, setRunSwitcherOpen] = useState(false);
  // Single "While you were away" digest surfaced on window focus-after-away.
  // Holds the snapshot computed at focus time; null when nothing landed or the
  // user dismissed it.
  const [awayDigest, setAwayDigest] = useState<AwayDigest | null>(null);
  const awayBaselineRef = useRef<AwayDigestBaseline>({});
  useEffect(() => {
    if (!awayDigest) return;
    const timer = window.setTimeout(() => {
      setAwayDigest(null);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [awayDigest]);
  const [platform, setPlatform] = useState<string>("");
  const [home, setHome] = useState<string>("");
  // Side-panel layout: outer widths, internal split ratios, per-section
  // collapse. Persisted globally. Mirrored through a ref so the resize-drag
  // callbacks can read the latest widths at drag start with a stable identity.
  const panels = usePanelLayout();
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  // User preferences, hoisted to the top of App so callbacks defined before the
  // shortcuts wiring (e.g. handleDetectedUrl, ~auto-preview gating) can read the
  // latest values via the ref without re-subscribing. The shortcuts block below
  // reuses this same `preferences` object.
  const { preferences } = usePreferences();
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [draggingPanelSection, setDraggingPanelSection] = useState<PanelSectionKey | null>(null);
  const saveTimer = useRef<number | null>(null);
  // Trailing-debounce timer for the orchestration-event → listRuns refresh.
  // A single run emits a burst of events (planning → running → many worker
  // lifecycle events → reviewing → complete); refreshing on every one would
  // fire dozens of IPC round-trips. We coalesce a burst into one refresh.
  const runRefreshTimer = useRef<number | null>(null);
  // Absolute max-wait deadline for the burst currently being coalesced. A
  // purely trailing debounce starves under a sustained event stream (events
  // closer together than the debounce window re-arm the timer forever, so it
  // never fires); the deadline guarantees a flush even mid-stream.
  const runRefreshDeadline = useRef<number | null>(null);
  const processedSpawnTerminalEventsRef = useRef<Set<string>>(new Set());
  // Edge events close failed worker panes immediately, while the debounced run
  // snapshot can still describe the attempt as live for another render. Keep a
  // short bounded tombstone so level-triggered reconciliation cannot recreate
  // that dead pane during the gap.
  const finishedWorkerAttemptsRef = useRef<Set<string>>(new Set());
  // Spawn-terminal specs that arrived for a workspace that wasn't active at the
  // time. We can't drop them into tabsRef (that's the ACTIVE workspace's tab
  // store), so we queue them per workspace and replay when that workspace is
  // activated — see the replay effect keyed on activeId below.
  const pendingSpawnTerminalsRef = useRef<
    Map<string, Array<{ command: string; runtime?: string }>>
  >(new Map());
  // Set of workspace ids that received an orchestration event since the last
  // debounced flush — so the flush refreshes counts for exactly the affected
  // workspaces (not a blanket re-list of everything).
  const runRefreshPendingRef = useRef<Set<string>>(new Set());
  // Live state per terminal-tab leaf: most recent OSC 7 cwd and the timestamp
  // of the latest PTY activity. Used by the orchestration claim logic to
  // decide whether a user pane is "doing nothing" and therefore safe to take
  // over for a new worker. Held in a ref so per-byte activity callbacks
  // don't trigger React re-renders.
  const paneRuntimeRef = useRef<
    Map<
      string,
      {
        cwd?: string;
        lastActivityAt: number;
        userInputAt?: number;
        // True while the PTY is in alt-screen mode — i.e. a TUI (any Ink-based
        // agent CLI, vim, less, htop, fzf, …) is in the foreground. Tracked
        // separately from `leaf.worker` so the worker keybind has a safety
        // net even when banner-based agent detection didn't fire (custom
        // builds, unrecognised CLIs). The keybind refuses to inject into a
        // pane with altScreenActive=true.
        altScreenActive?: boolean;
      }
    >
  >(new Map());
  // Panes with an in-flight session-id capture (post agent-detection), so
  // repeated "agent running" events don't kick off duplicate discovery calls.
  const capturingPanesRef = useRef<Set<string>>(new Set());
  // Session discovery can take up to 15 seconds. Track only positively
  // confirmed exits during that window so a visibility/terminal-tail false
  // negative cannot make a still-running session permanently non-resumable.
  const confirmedAgentExitAtRef = useRef<Map<string, number>>(new Map());
  const handlePaneCwd = useCallback(
    (tabId: string, paneId: string, cwd: string) => {
      const entry = paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
      entry.cwd = cwd;
      paneRuntimeRef.current.set(paneId, entry);
      // Mirror into the persisted leaf state so a reload remembers the cwd
      // and the smart-add picker can read it without a live OSC 7 round-trip.
      tabsRef.current?.setLeafCwd(tabId, paneId, cwd);
    },
    [],
  );
  const handlePaneActivity = useCallback((_tabId: string, paneId: string) => {
    const entry = paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
    entry.lastActivityAt = Date.now();
    paneRuntimeRef.current.set(paneId, entry);
  }, []);
  // Distinct from onActivity, which fires for every PTY chunk (including
  // shell output). This only fires on real user keystrokes — used by the
  // worker keybind to decide whether the active pane is "untouched" and
  // therefore safe to take over with an injected launch command, vs. a pane
  // the user is in the middle of typing in.
  const handlePaneUserInput = useCallback((_tabId: string, paneId: string) => {
    const entry = paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
    entry.userInputAt = Date.now();
    paneRuntimeRef.current.set(paneId, entry);
  }, []);

  const handlePaneScrollback = useCallback(
    (tabId: string, paneId: string, scrollback: string) => {
      tabsRef.current?.setLeafScrollback(tabId, paneId, scrollback);
    },
    [],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  // Stable set of existing workspace ids. Its identity changes ONLY when a
  // workspace is added/removed — not on a color/name edit — so handing it to
  // the memoized <Workspace> doesn't defeat that memo (e.g. during a live
  // workspace-color drag). It's used there to prune deleted workspaces from the
  // mounted-but-hidden terminal stacks.
  const workspaceIdsKey = workspaces.map((w) => w.id).join(",");
  const validWorkspaceIds = useMemo(
    () => new Set(workspaces.map((w) => w.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceIdsKey],
  );

  // Self-heal a null/dangling active workspace id. The app renders the full
  // Workspace UI whenever `workspaces.length > 0` (see the NoWorkspace gate in
  // the render), but `activeWorkspace` is resolved by id — so a null or stale
  // `activeId` (e.g. a persisted pointer to a since-removed workspace, or a
  // transient gap) leaves the UI up with `activeWorkspace === null`, which
  // disables the chat composer and every workspace-gated control even though a
  // workspace plainly exists. Coerce to the first real workspace so the active
  // workspace is never null while workspaces exist. No-op in normal operation
  // (activeId already valid); only fires to recover from a broken pointer.
  useEffect(() => {
    if (!booted || workspaces.length === 0) return;
    if (activeId && workspaces.some((w) => w.id === activeId)) return;
    setActiveId(workspaces[0].id);
  }, [booted, workspaces, activeId]);

  // App-wide last-line guard against navigating the whole webContents to a
  // dropped file:// URL. The main-process will-navigate handler deliberately
  // allows file:// through, so a Finder file dropped on bare DOM that has no
  // drop handler — the terminal pane's 8px padding gutter, the 3px split-pane
  // gap, or any dead space — would otherwise replace the entire app (every tab,
  // terminal, and chat) with the file's raw contents.
  //
  // preventDefault here only cancels the browser's default navigation action;
  // it does NOT stop element-level handlers from running. The terminal drop
  // handler and the chat composer's attachment drop-zone are deeper targets, so
  // their handlers still fire first (bubble order target -> window) and do their
  // work. Gating on types.includes("Files") means text drags into inputs and
  // the internal pane-reorder drag (a custom MIME, not "Files") are untouched,
  // so nothing that relies on native drop behavior regresses.
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  // Tabs are scoped per-workspace so each workspace remembers its own layout.
  // useTabs internally swaps tab lists when the workspaceId argument changes.
  const tabs = useTabs(
    activeId,
    activeWorkspace?.cwd,
    settings.terminalScrollbackLineLimit,
    preferences.restoreAgentSessions === true,
  );

  // One shared git status/log poll per active workspace — feeds the Source
  // Control panel, the explorer's changed-file decorations, and the diff
  // tabs from a single source of truth (was GitPanel's private poll).
  const sharedGit = useSharedGitStatus(activeWorkspace?.cwd ?? null);

  // Evict frozen terminal layouts for deleted workspaces so they don't linger
  // in state. Render already prunes them (the validWorkspaceIds gate in
  // terminalWorkspaceLayers), but useTabs' switch effect alone can't catch an
  // inactive workspace closed without a subsequent switch. Runs only when the
  // workspace-id set changes; the callback no-ops when nothing is stale. Fires
  // after useTabs' own switch effect (registered earlier in this component), so
  // a just-appended leaving workspace is correctly pruned in the same pass.
  useEffect(() => {
    tabs.pruneWorkspaceLayouts(validWorkspaceIds);
  }, [validWorkspaceIds, tabs.pruneWorkspaceLayouts]);
  const visibleWorkbenchTabs = useMemo(
    () => tabs.tabs.filter((tab) => isTabVisibleForRun(tab, activeRunId)),
    [tabs.tabs, activeRunId],
  );
  const activeVisibleTabId = useMemo(() => {
    if (tabs.activeId && visibleWorkbenchTabs.some((tab) => tab.id === tabs.activeId)) {
      return tabs.activeId;
    }
    return visibleWorkbenchTabs[0]?.id ?? null;
  }, [tabs.activeId, visibleWorkbenchTabs]);

  // useTabs returns a fresh object every render, which would force any
  // useCallback/useEffect that depends on `tabs` to re-run on every render.
  // We mirror it through a ref so the run-selection callbacks stay stable
  // and the auto-reopen effect only fires when its real input (runs)
  // actually changes.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeNotificationView = useMemo<ActiveNotificationView>(() => {
    const activeTab = tabs.activeTab;
    return {
      workspaceId: tabs.tabsWorkspaceId,
      visibleRunId: visibleRunIdForTab(activeTab),
      terminal:
        activeTab?.kind === "terminal" && tabs.tabsWorkspaceId
          ? {
              workspaceId: tabs.tabsWorkspaceId,
              tabId: activeTab.id,
              paneId: activeTab.activePaneId,
            }
          : null,
      automationsActive: activeTab?.kind === "automations",
    };
  }, [tabs.activeTab, tabs.tabsWorkspaceId]);

  // The useTabs API's methods are stable for the hook instance's lifetime
  // (only its data fields re-key the memo). Destructure the ones the hoisted
  // callbacks below need so those callbacks can depend on truly stable
  // references instead of the whole `tabs` object, whose identity changes on
  // every tab-state publish. Callbacks that read DATA off `tabs` (tabs.tabs,
  // tabs.activeId, ...) must still list that data as a dep.
  const {
    setActiveTab: setActiveTabStable,
    newTerminalTab,
    newPreviewTab,
    addDraftChatTab,
    newWhiteboardTab,
    hideRunsTabs,
    closeChatTabForRun,
    renameChatTab,
    setPreviewUrl,
    setDetectedUrl,
    openEditorTab,
    closeEditorByPath,
    setEditorEntry,
    moveTerminalPane,
    detachTerminalPaneToNewTab,
  } = tabs;

  // Settings prepares native CLI login entirely in main and dispatches only a
  // one-time opaque token. Turn that token into a visible terminal tab; if the
  // tab cannot be created, cancel the still-prepared plan so its profile guard
  // is released immediately instead of waiting for TTL expiry.
  useEffect(() => {
    const handleNativeCliLogin = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{
        launchToken?: unknown;
        label?: unknown;
      }>;
      const launchToken = event.detail?.launchToken;
      if (
        typeof launchToken !== "string" ||
        launchToken.length < 24 ||
        launchToken.length > 256 ||
        /[\u0000-\u0020\u007f]/.test(launchToken)
      ) {
        return;
      }
      if (!activeIdRef.current) {
        void window.spark.nativeCliAccounts.cancelLogin({ launchToken });
        return;
      }
      const rawLabel =
        typeof event.detail?.label === "string"
          ? event.detail.label.trim()
          : "";
      const title =
        rawLabel && rawLabel.length <= 96 ? rawLabel : "CLI sign-in";
      try {
        newTerminalTab(home || undefined, undefined, {
          focus: true,
          nativeCliLoginToken: launchToken,
          title,
        });
        setSettingsOpen(false);
        event.preventDefault();
      } catch {
        void window.spark.nativeCliAccounts.cancelLogin({ launchToken });
      }
    };
    window.addEventListener(
      "spark:open-native-cli-login",
      handleNativeCliLogin,
    );
    return () =>
      window.removeEventListener(
        "spark:open-native-cli-login",
        handleNativeCliLogin,
      );
  }, [home, newTerminalTab]);

  // Mirror the runs list through a ref so run-selection callbacks can read
  // the latest chat titles without taking `runs` as a dependency.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const runsWorkspaceIdRef = useRef(runsWorkspaceId);
  runsWorkspaceIdRef.current = runsWorkspaceId;
  // Run selection can happen while a debounced orchestration-event refresh is
  // still carrying an older snapshot (for example, run.created immediately
  // followed by human.note). The history picker refreshes through this ref so
  // the selected conversation always converges on its durable run.json state.
  const refreshRunsForRef = useRef<(workspaceId: string | null) => Promise<void>>(
    async () => undefined,
  );
  // Several sources can request the same list concurrently (workspace
  // activation, orchestration events, and an explicit history selection).
  // Only the newest request may publish its result; otherwise a slower read
  // that started before a message was persisted can overwrite the fresher
  // conversation with its older snapshot.
  const runsRefreshGenerationRef = useRef(0);
  // Distinguish a genuine later user selection from the runs[] reconciliation
  // effect temporarily clearing a just-selected id while React is applying a
  // previously queued list snapshot.
  const runSelectionGenerationRef = useRef(0);
  const pendingCrossWorkspaceRunSelectionRef = useRef<{
    runId: string;
    workspaceId: string;
    generation: number;
    route: "run" | "automation";
  } | null>(null);

  // Cross-workspace runs feed for the walk-away cockpit surfaces (run
  // switcher, rail tone dots, focus digest). Independent of the lifted `runs`
  // state above, which is scoped to the active workspace only.
  const globalRuns = useGlobalRuns(booted);

  const handleRunSnapshot = useCallback(
    (
      run: RunState,
      options?: { select?: boolean; focusRuns?: boolean },
    ) => {
      // Loom-owned and board-card runs never enter the lifted chat state
      // (defensive — the listRuns filter is the primary gate). Board runs the
      // user explicitly opened from their card are exempt.
      if (run.automationId) return;
      if (isBoardCardRun(run) && !openedBoardRunIdsRef.current.has(run.id)) return;
      if (run.workspaceId === activeIdRef.current) {
        const sameWorkspace = runsWorkspaceIdRef.current === run.workspaceId;
        runsWorkspaceIdRef.current = run.workspaceId;
        setRunsWorkspaceId(run.workspaceId);
        setRuns((current) => {
          const withoutRun = (sameWorkspace ? current : []).filter(
            (item) => item.id !== run.id,
          );
          const next = [run, ...withoutRun];
          next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          // A redelivered snapshot (same run version, same order) must not
          // republish the list — snapshots arrive on every daemon event.
          return sameRunsList(current, next) ? current : next;
        });
      }

      if (!options?.select) return;
      const workspaceId = run.workspaceId;
      activeRunIdsByWorkspaceRef.current[workspaceId] = run.id;
      // A retained background panel can deliver this snapshot after the user
      // switched workspaces (its startAutopilot/forcePauseRun IPC was still in
      // flight). Remember the run for its own workspace above, but never
      // repoint the live selection of the workspace on screen now.
      if (workspaceId !== activeIdRef.current) return;
      activeRunIdRef.current = run.id;
      setActiveRunId(run.id);
      const focusRuns = options.focusRuns ?? false;
      // If the user sent their first message from a draft chat tab, repurpose
      // that tab for this run instead of creating a sibling tab — otherwise
      // the strip would briefly show both the orphan draft and the new
      // run-backed tab.
      const activeTab = tabsRef.current.activeTab;
      const draftToPromote =
        activeTab && activeTab.kind === "chat" && isDraftChatTabId(activeTab.id)
          ? activeTab.id
          : null;
      if (draftToPromote) {
        // The top-strip chat tab always reads "Cora" — the first-
        // message-derived run.title would otherwise truncate to fragments
        // like "He..." for short prompts. The real title is still surfaced
        // in the chat panel header and the history popover.
        tabsRef.current.promoteDraftChatTab(draftToPromote, run.id, CHAT_TAB_LABEL);
      }
      if (runHasWorkbench(run)) {
        tabsRef.current.openRunsTab(run.id, "Runs", focusRuns);
        if (!focusRuns) tabsRef.current.openChatTab({ runId: run.id, focus: true });
      } else {
        tabsRef.current.hideRunsTabs();
        tabsRef.current.openChatTab({ runId: run.id, focus: true });
      }
    },
    [],
  );

  const handleSelectRun = useCallback(
    (
      runId: string | null,
      workspaceId?: string | null,
      options?: { focus?: "chat" | "runs" | "none" },
    ) => {
      pendingCrossWorkspaceRunSelectionRef.current = null;
      const targetWorkspaceId = workspaceId ?? activeIdRef.current;
      // The Settings run manager lists runs of deleted workspaces by design.
      // There is no workspace to restore such a selection into, so it must be
      // a no-op — recording it or touching the live selection would blank the
      // workspace currently on screen.
      if (
        targetWorkspaceId &&
        !workspacesRef.current.some((w) => w.id === targetWorkspaceId)
      ) {
        return;
      }
      const selectionGeneration = ++runSelectionGenerationRef.current;
      if (targetWorkspaceId) {
        activeRunIdsByWorkspaceRef.current[targetWorkspaceId] = runId;
        // A history row may have arrived from the run.created event just
        // before the first human.note event. Refresh the collection, then
        // read the chosen run directly so selecting it always converges on
        // the latest durable run.json rather than displaying that stale row.
        void (async () => {
          await refreshRunsForRef.current(targetWorkspaceId);
          if (!runId) return;
          const fresh = await window.spark.orchestration.getRun(runId).catch(() => null);
          if (
            !fresh ||
            fresh.workspaceId !== targetWorkspaceId ||
            activeIdRef.current !== targetWorkspaceId ||
            runSelectionGenerationRef.current !== selectionGeneration
          ) {
            return;
          }
          // A runs[] reconciliation scheduled before this click may have
          // temporarily cleared the id because that older list did not yet
          // contain the run. Reassert the still-current user intent alongside
          // the exact durable snapshot. A later user selection increments the
          // generation and prevents this from stealing focus back.
          activeRunIdsByWorkspaceRef.current[targetWorkspaceId] = runId;
          activeRunIdRef.current = runId;
          setActiveRunId(runId);
          handleRunSnapshot(fresh);
        })();
      }
      // A selection targeting a background workspace (mid-await workspace
      // switch, handleSelectRunAnywhere) only records intent in the restore
      // map above — the workspace-switch effect re-applies it on activation.
      if (targetWorkspaceId !== activeIdRef.current) return;
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      const focus = options?.focus ?? "chat";
      if (runId === null) {
        tabsRef.current.hideRunsTabs();
        if (focus === "chat") tabsRef.current.openChatTab({ runId: null, focus: true });
        return;
      }
      const target = runsRef.current.find((r) => r.id === runId) ?? null;
      const hasWorkbench = target ? runHasWorkbench(target) : false;
      if (hasWorkbench) {
        tabsRef.current.openRunsTab(runId, "Runs", focus === "runs");
      } else {
        tabsRef.current.hideRunsTabs();
      }
      if (focus === "chat" || (!hasWorkbench && focus === "runs")) {
        tabsRef.current.openChatTab({ runId, focus: true });
      }
    },
    [handleRunSnapshot],
  );

  // Cross-workspace run selection used by the global RunSwitcher and the
  // focus-after-away digest. Queue the requested surface before switching so
  // the old workspace's tab store remains untouched. The replay effect below
  // applies it after useTabs has loaded the destination layout.
  // Board-card runs a user explicitly opened from a card's "Open chat". Runs
  // in this set are exempt from the board-run suppression below — without the
  // exemption the lifted runs list never contains the run and the chat tab
  // handleSelectRun focuses would render empty.
  const openedBoardRunIdsRef = useRef<Set<string>>(new Set());

  const handleSelectRunAnywhere = useCallback(
    (runId: string, workspaceId?: string) => {
      const target = globalRuns.runsRef.current.find((r) => r.id === runId);
      const route = target?.automationId ? "automation" : "run";
      const generation = ++runSelectionGenerationRef.current;
      pendingCrossWorkspaceRunSelectionRef.current = null;

      // Board-card runs are suppressed from the lifted list until explicitly
      // opened (openedBoardRunIdsRef). A RunSwitcher / away-digest /
      // notification click is such an explicit open. Register the exemption
      // before either the immediate selection or the deferred replay rebuilds
      // the lifted run list.
      if (target && isBoardCardRun(target)) {
        openedBoardRunIdsRef.current.add(runId);
      }

      if (workspaceId && workspaceId !== activeIdRef.current) {
        const currentWorkspaceId = activeIdRef.current;
        if (currentWorkspaceId) {
          activeRunIdsByWorkspaceRef.current[currentWorkspaceId] = activeRunIdRef.current;
        }
        if (route === "run") {
          activeRunIdsByWorkspaceRef.current[workspaceId] = runId;
        }
        pendingCrossWorkspaceRunSelectionRef.current = {
          runId,
          workspaceId,
          generation,
          route,
        };
        setActiveId(workspaceId);
        return;
      }

      // Loom-owned runs have no chat surface anywhere because the lifted list
      // filters them. Their home is the Automations Hub.
      if (route === "automation") {
        setAwayDigest((current) =>
          current ? pruneAwayDigest(current, runId) : current,
        );
        tabsRef.current.openAutomationsTab();
        return;
      }
      handleSelectRun(runId, workspaceId);
    },
    [handleSelectRun, globalRuns.runsRef],
  );

  useEffect(() => {
    const pending = pendingCrossWorkspaceRunSelectionRef.current;
    if (!pending || pending.workspaceId === activeId) return;
    pendingCrossWorkspaceRunSelectionRef.current = null;
    runSelectionGenerationRef.current += 1;
  }, [activeId]);

  useEffect(() => {
    if (!booted) return;
    const pending = pendingCrossWorkspaceRunSelectionRef.current;
    if (!pending || pending.workspaceId !== tabs.tabsWorkspaceId) return;
    pendingCrossWorkspaceRunSelectionRef.current = null;
    if (
      pending.generation !== runSelectionGenerationRef.current ||
      activeIdRef.current !== pending.workspaceId
    ) {
      return;
    }
    if (pending.route === "automation") {
      setAwayDigest((current) =>
        current ? pruneAwayDigest(current, pending.runId) : current,
      );
      tabsRef.current.openAutomationsTab();
      return;
    }
    handleSelectRun(pending.runId, pending.workspaceId);
  }, [booted, tabs.tabsWorkspaceId, handleSelectRun]);

  // Unseen terminal-agent alerts, keyed workspace → pane. Set when main
  // fires a terminal alert (event arrives even with all notification
  // channels muted); cleared when the user visits the pane's tab. This is
  // what keeps the workspace rail showing "something in there wants you"
  // after the transient toast/native notification is gone.
  const [terminalAttention, setTerminalAttention] = useState<
    Record<string, Record<string, { tabId: string; kind: InAppNotificationKind }>>
  >({});

  // Manual terminal panes whose agent is actively working, keyed
  // workspaceId → paneId → true, tracked across ALL workspaces (the
  // main-process notifier keeps watching panes in non-active workspaces).
  // Feeds the workspace rail's activity spin alongside live/loom runs.
  const [terminalWorking, setTerminalWorking] = useState<
    Record<string, Record<string, true>>
  >({});

  // Keep the rail's per-pane activity map level-triggered and idempotent. Both
  // detectors feed this: the main-process PTY monitor covers hidden workspaces,
  // while the visible terminal poller is the authoritative fallback for the
  // pane currently drawing the worker chip. If either one confirms working,
  // the workspace dot animates; any non-working state from that same detector
  // clears its pane entry.
  const setTerminalPaneWorking = useCallback(
    (workspaceId: string, paneId: string, active: boolean) => {
      if (!workspaceId || !paneId) return;
      setTerminalWorking((current) => {
        const workspace = current[workspaceId];
        if (active) {
          if (workspace?.[paneId]) return current;
          return {
            ...current,
            [workspaceId]: { ...(workspace ?? {}), [paneId]: true },
          };
        }
        if (!workspace?.[paneId]) return current;
        const { [paneId]: _droppedPane, ...remainingPanes } = workspace;
        if (Object.keys(remainingPanes).length === 0) {
          const { [workspaceId]: _droppedWorkspace, ...remainingWorkspaces } = current;
          return remainingWorkspaces;
        }
        return { ...current, [workspaceId]: remainingPanes };
      });
    },
    [],
  );

  // Per-workspace status-tone for the WorkspaceRail dots: the tone of each
  // workspace's highest-attention run (blocked > done-unseen > live > …),
  // sourced from the global feed so the dot reflects every project, not just
  // the active one. Unseen terminal-agent alerts fold into the same dot —
  // blocked terminals rank like blocked runs, finished ones like done-unseen
  // — so the rail has ONE attention cue, not two competing ones.
  const toneByWorkspaceId = useMemo(() => {
    const rank: Record<ChatStatusTone, number> = {
      blocked: 6,
      failed: 5,
      "done-unseen": 4,
      live: 3,
      paused: 2,
      done: 1,
      idle: 0,
    };
    const m: Record<string, ChatStatusTone | null> = {};
    for (const w of workspaces) {
      let tone: ChatStatusTone | null = null;
      // Loom passes count only while blocked ("needs you" must light the dot);
      // their completions are per-iteration noise — and since no chat tab ever
      // views a loom run, an unfiltered feed would pin "done-unseen" forever.
      const wr = globalRuns.runs.filter(
        (r) => r.workspaceId === w.id && (!r.automationId || r.status === "blocked"),
      );
      if (wr.length > 0) {
        // compareRunsByAttention sorts highest-attention first, so the head
        // run dictates the dot. describeRunStatus(top).tone is the same tone
        // the switcher buckets and chat rows use, so the cues never disagree.
        const top = wr.slice().sort(compareRunsByAttention)[0];
        tone = describeRunStatus(top).tone;
      }
      const attention = terminalAttention[w.id];
      if (attention && Object.keys(attention).length > 0) {
        const termTone: ChatStatusTone = Object.values(attention).some(
          (a) => a.kind === "blocked",
        )
          ? "blocked"
          : "done-unseen";
        if (tone === null || rank[termTone] > rank[tone]) tone = termTone;
      }
      m[w.id] = tone;
    }
    return m;
  }, [workspaces, globalRuns.runs, terminalAttention]);

  // Per-workspace "something inside is working" flag for the rail's activity
  // spin. Unlike toneByWorkspaceId this does NOT filter out automation (loom)
  // runs — a running loom pass still counts as work in progress. The active
  // workspace also derives directly from the same leaf.runtimeState that
  // paints each visible worker chip. That direct path is the final invariant:
  // if a pane says "CLAUDE working" / "CODEX working", its workspace ring
  // animates even if the independent main-process state event was missed.
  const workingByWorkspaceId = useMemo(() => {
    const m: Record<string, boolean> = {};
    let activeLayerHasWorkingTerminal = false;
    for (const tab of tabs.tabs) {
      if (tab.kind !== "terminal" || activeLayerHasWorkingTerminal) continue;
      forEachTerminalLeaf(tab.root, (leaf) => {
        if (leaf.worker?.runtimeState === "working") {
          activeLayerHasWorkingTerminal = true;
        }
      });
    }
    for (const w of workspaces) {
      m[w.id] =
        globalRuns.runs.some((r) => r.workspaceId === w.id && isRunningStatus(r.status)) ||
        Object.keys(terminalWorking[w.id] ?? {}).length > 0 ||
        (w.id === tabs.tabsWorkspaceId && activeLayerHasWorkingTerminal);
    }
    return m;
  }, [workspaces, globalRuns.runs, terminalWorking, tabs.tabs, tabs.tabsWorkspaceId]);

  // Reclaim activity-spin records for workspaces that no longer exist: a
  // workspace deleted while a hidden pane was mid-turn never receives a
  // clearing state event, so its map entry would otherwise live forever
  // (invisible — workingByWorkspaceId iterates live workspaces — but leaked).
  // The empty-list guard skips the pre-boot render where workspaces haven't
  // loaded yet.
  useEffect(() => {
    if (workspaces.length === 0) return;
    setTerminalWorking((current) => {
      const live = new Set(workspaces.map((w) => w.id));
      const stale = Object.keys(current).filter((id) => !live.has(id));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [workspaces]);

  // Keep every active chat's stable Runs surface in existence without stealing
  // focus. Whiteboard lives beside it in the inner strip, so no
  // destination appears late when planning or delegation starts.
  useEffect(() => {
    if (!activeRunId) {
      tabsRef.current.hideRunsTabs();
      return;
    }
    // During a workspace switch `runs` still holds the previous workspace's
    // payload until listRuns resolves; resolving the restored selection
    // against that stale list would tear down the just-restored Runs tab.
    // refreshRunsFor publishes runsWorkspaceId and runs together, so the
    // effect re-fires against the owned payload once it lands.
    if (runsWorkspaceIdRef.current !== activeIdRef.current) return;
    const target = runsRef.current.find((r) => r.id === activeRunId) ?? null;
    if (target && runHasWorkbench(target)) {
      tabsRef.current.openRunsTab(activeRunId, "Runs", false);
    } else {
      tabsRef.current.hideRunsTabs();
    }
  }, [activeRunId, runs]);

  // Mirror the workbench selection back into the active chat: clicking a
  // chat's node-graph tab makes the Codara chat tab follow along.
  useEffect(() => {
    const tab = tabs.activeTab;
    if (tab && tab.kind === "runs" && tab.runId) {
      const runId = tab.runId;
      const workspaceId = activeIdRef.current;
      if (workspaceId) activeRunIdsByWorkspaceRef.current[workspaceId] = runId;
      activeRunIdRef.current = runId;
      setActiveRunId((current) => (current === runId ? current : runId));
    }
  }, [tabs.activeTab]);

  // Sync top-strip chat tabs to the run store: add tabs for new runs,
  // remove tabs for deleted runs, refresh titles when a run is renamed.
  // Drafts are left alone — they hold their position until the user
  // closes them or sends their first message (which then rekeys the draft
  // tab id to the new run id via promoteDraftChatTab).
  useEffect(() => {
    // All chat tabs in the top strip render as "Cora" — see
    // CHAT_TAB_LABEL above. Run.title is preserved on the RunState for the
    // chat panel header and history popover; only the tab label is forced
    // to a stable brand so short prompts don't surface as "He...".
    //
    // Automation-architect chats (chatMode "automation") live in the
    // Automations tab's assist view now, so they never auto-materialize a
    // chat tab here. A run whose chat tab is ALREADY open stays in the sync
    // list, though — syncChatTabsToRuns drops tabs for unlisted runs, and a
    // legacy automation chat opened via deep link (toast, run switcher) must
    // survive the next runs refresh. tabsRef is read fresh on every sync, so
    // an automation tab opened after this effect ran is protected by the
    // following one.
    const openChatTabIds = new Set(
      tabsRef.current.tabs
        .filter((tab) => tab.kind === "chat")
        .map((tab) => tab.id),
    );
    tabsRef.current.syncChatTabsToRuns(
      runs
        .filter((run) => run.chatMode !== "automation" || openChatTabIds.has(run.id))
        .map((run) => ({ id: run.id, title: CHAT_TAB_LABEL })),
    );
  }, [runs]);

  // Clicking a chat tab in the top strip selects that run. The shape mirrors
  // the runs-tab → chat sync above, but for the chat-tab kind.
  useEffect(() => {
    const tab = tabs.activeTab;
    if (!tab || tab.kind !== "chat") return;
    // Drafts represent a not-yet-created chat: clear the active run so the
    // composer renders in "new chat" mode (matches the old onSelectRun(null)
    // behavior). The first message will promote the draft via the
    // handleStartChat callback below.
    const runId = isDraftChatTabId(tab.id) ? null : tab.id;
    const workspaceId = activeIdRef.current;
    if (workspaceId) activeRunIdsByWorkspaceRef.current[workspaceId] = runId;
    activeRunIdRef.current = runId;
    setActiveRunId((current) => (current === runId ? current : runId));
  }, [tabs.activeTab]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [state, appSettings, sh, def, plat, hm] = await Promise.all([
          window.spark.state.load(),
          window.spark.settings.load(),
          window.spark.shells.list(),
          window.spark.shells.default(),
          window.spark.app.platform(),
          window.spark.app.home(),
        ]);
        if (cancelled) return;
        const coloredGroups = ensureWorkspaceGroupColors(state.workspaceGroups ?? []);
        setWorkspaces(applyWorkspaceGroupShades(state.workspaces, coloredGroups));
        setWorkspaceGroups(coloredGroups);
        setWorkspaceRailOrder(state.workspaceRailOrder ?? []);
        setActiveId(state.activeWorkspaceId);
        setSettings(appSettings);
        setShells(sh);
        setDetectedDefaultShell(def);
        setDefaultShell(resolveDefaultShell(sh, appSettings, def));
        setPlatform(plat);
        setHome(hm);
        setBooted(true);
      } catch (err) {
        setBootError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The `cora start --cwd …` path can register or activate a workspace from
  // the main process while this renderer is already mounted. The main process
  // changes activeWorkspaceId only for executable sessions whose visible
  // worker PTYs must belong to that workspace; Talk/Plan starts preserve the
  // existing active id. Mirror that authoritative selection here.
  useEffect(() => {
    const off = window.spark.state.onChanged?.((state) => {
      const coloredGroups = ensureWorkspaceGroupColors(state.workspaceGroups ?? []);
      setWorkspaces(applyWorkspaceGroupShades(state.workspaces, coloredGroups));
      setWorkspaceGroups(coloredGroups);
      setWorkspaceRailOrder(state.workspaceRailOrder ?? []);
      const next = state.activeWorkspaceId;
      activeIdRef.current = next;
      setActiveId(next);
    });
    return () => off?.();
  }, []);

  // Resolve the integrated-shell launch profile lazily. Materializing the
  // bundled scripts touches the user's home directory; no need to block
  // initial paint on it. A failure here just means the strip falls back to
  // the orchestration default shell, which still works (without inline
  // OSC 7/8888 from a Unix shell). Re-runs once `home` is known so the
  // call is gated on the main process having a usable HOME.
  useEffect(() => {
    if (!booted) return;
    let cancelled = false;
    (async () => {
      try {
        const shell = await window.spark.shells.integratedDefault();
        if (!cancelled) setIntegratedShell(shell);
      } catch {
        /* fall back to defaultShell */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [booted]);

  // Persist on change (debounced)
  useEffect(() => {
    if (!booted) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      const state: AppState = {
        workspaces,
        workspaceGroups,
        workspaceRailOrder,
        activeWorkspaceId: activeId,
      };
      void window.spark.state.save(state);
    }, 200);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [workspaces, workspaceGroups, workspaceRailOrder, activeId, booted]);

  // Keep the mixed top-level rail sequence complete as workspaces are created,
  // grouped, ungrouped, or deleted. The equality guard makes this a no-op for
  // ordinary renders and preserves every explicit drag order.
  useEffect(() => {
    setWorkspaceRailOrder((current) => {
      const next = normalizedWorkspaceRailOrder(current, workspaces, workspaceGroups);
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [workspaces, workspaceGroups]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1050px)");
    const sync = () => {
      setCompactWorkbench(query.matches);
      if (!query.matches) setCompactPanel(null);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const leftPanelVisible = compactWorkbench ? compactPanel === "left" : showLeft;
  const rightPanelVisible = compactWorkbench ? compactPanel === "right" : showRight;

  // Close editor when rail hidden — kept for parity with old behaviour.
  useEffect(() => {
    if (!leftPanelVisible) setEditingId(null);
  }, [leftPanelVisible]);

  // Comma-joined sorted list of workspace cwds plus any attached external
  // Explorer folders. Used as a stable dep for the setAllowedRoots push so we
  // only re-send when the actual root set changes (renaming a workspace's
  // color, for instance, must not re-fire the IPC).
  const workspaceCwdsKey = useMemo(
    () =>
      workspaces
        .flatMap((w) => [w.cwd, ...(w.extraFolders ?? [])])
        .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)
        .slice()
        .sort()
        .join("\0"),
    [workspaces],
  );

  // Push the renderer's set of active workspace cwds to main so the fs:*
  // read handlers know which paths are in scope. Main treats this list as the
  // authoritative source of allowed workspace roots; if the renderer never
  // calls this, only the static CLI/config dirs in fs-sandbox.ts remain
  // reachable — that's the safe default for a fresh boot.
  useEffect(() => {
    if (!booted) return;
    const cwds = workspaceCwdsKey ? workspaceCwdsKey.split("\0").filter((c) => c.length > 0) : [];
    void window.spark.ui?.setAllowedRoots(cwds).catch(() => {
      /* sandbox push is best-effort; failures only restrict reachable reads */
    });
  }, [booted, workspaceCwdsKey]);

  // Refresh the lifted runs list for whichever workspace is active right now.
  // Reads activeId via the closure, so wrap the body in a function that takes
  // the workspaceId explicitly to avoid stale-closure issues in subscriptions.
  const refreshRunsFor = useCallback(async (workspaceId: string | null) => {
    const generation = ++runsRefreshGenerationRef.current;
    if (!workspaceId) {
      runsWorkspaceIdRef.current = null;
      setRunsWorkspaceId(null);
      setRuns([]);
      return;
    }
    try {
      const next = await window.spark.orchestration.listRuns(workspaceId);
      if (
        generation !== runsRefreshGenerationRef.current ||
        activeIdRef.current !== workspaceId
      ) {
        return;
      }
      // Loom-owned runs live inside the Automations tab (Workers sub-tab +
      // per-loom history) — keeping them out of the lifted list is what keeps
      // chat tabs / RunsStack rows from materializing for them.
      runsWorkspaceIdRef.current = workspaceId;
      setRunsWorkspaceId(workspaceId);
      // Board-card exemptions survive a relaunch by DERIVATION: a board run
      // whose chat tab sat in this workspace's persisted layout was explicitly
      // opened by the user last session, so it re-registers here before the
      // filter runs (the exemption set itself is session-scoped).
      const restored = restoredChatRunIds(workspaceId);
      if (restored.size > 0) {
        for (const run of next) {
          if (isBoardCardRun(run) && restored.has(run.id)) {
            openedBoardRunIdsRef.current.add(run.id);
          }
        }
      }
      setRuns((current) => {
        const filtered = next.filter(
          (run) =>
            !run.automationId &&
            (!isBoardCardRun(run) || openedBoardRunIdsRef.current.has(run.id)),
        );
        return sameRunsList(current, filtered) ? current : filtered;
      });
    } catch {
      /* Surface details elsewhere; this is opportunistic. */
    }
  }, []);
  refreshRunsForRef.current = refreshRunsFor;

  // Initial load + reload on workspace change. Run selection is scoped per
  // workspace, so coming back to a project restores the chat the user was
  // reading there instead of inheriting another workspace's draft/new-chat
  // state.
  useEffect(() => {
    if (!booted) return;
    const remembered =
      activeId && Object.prototype.hasOwnProperty.call(activeRunIdsByWorkspaceRef.current, activeId)
        ? activeRunIdsByWorkspaceRef.current[activeId]
        : null;
    activeRunIdRef.current = remembered;
    setActiveRunId((current) => (current === remembered ? current : remembered));
    void refreshRunsFor(activeId);
  }, [activeId, booted, refreshRunsFor]);

  // When the runs list changes, reconcile the active selection. A null
  // selection is intentional now (the draft/new-chat state), so don't jump
  // into the latest run unless the user actually had a selected chat that
  // disappeared.
  useEffect(() => {
    setActiveRunId((current) => {
      const workspaceId = activeIdRef.current;
      if (!workspaceId) {
        activeRunIdRef.current = null;
        return null;
      }
      if (!current) {
        activeRunIdsByWorkspaceRef.current[workspaceId] = null;
        activeRunIdRef.current = null;
        return null;
      }
      if (current && runs.some((run) => run.id === current)) {
        activeRunIdsByWorkspaceRef.current[workspaceId] = current;
        activeRunIdRef.current = current;
        return current;
      }
      // Automation-architect chats never become the fallback selection — they
      // live in the Automations tab's assist view, and silently landing one in
      // the Cora chat panel would surface a conversation the chat tab
      // deliberately hides. (An EXPLICIT selection of one — the deep-link case
      // — is the `current` branch above, which doesn't filter.)
      const selectable = runs.filter((run) => run.chatMode !== "automation");
      const live = selectable.find((run) =>
        ["planning", "running", "reviewing", "blocked", "paused"].includes(run.status),
      );
      const fallback = live?.id ?? selectable[0]?.id ?? null;
      activeRunIdsByWorkspaceRef.current[workspaceId] = fallback;
      activeRunIdRef.current = fallback;
      return fallback;
    });
  }, [runs]);

  useEffect(() => {
    if (!booted) return undefined;

    // Trailing-debounce window. A burst of orchestration events (a run going
    // planning → running → N worker events → complete) collapses into a
    // single refresh once events stop arriving for this long.
    const RUN_REFRESH_DEBOUNCE_MS = 250;
    // Upper bound on how long a refresh can be deferred while events keep
    // arriving. Without it, a stream of events spaced under the debounce
    // window (a busy run's worker chatter) would postpone the flush forever
    // and the runs list would go stale for the whole burst.
    const RUN_REFRESH_MAX_WAIT_MS = 1_000;

    // Drain the pending-workspace set: refresh the run count for every
    // workspace that saw an event, and the lifted runs list if the currently
    // active workspace was among them. Reads activeId via the ref so this is
    // always against the workspace on screen *now*, not whenever the listener
    // was registered.
    const flushRunRefresh = (): void => {
      runRefreshTimer.current = null;
      runRefreshDeadline.current = null;
      const pending = runRefreshPendingRef.current;
      if (pending.size === 0) return;
      const workspaceIds = Array.from(pending);
      pending.clear();
      const currentActiveId = activeIdRef.current;
      for (const workspaceId of workspaceIds) {
        if (workspaceId === currentActiveId) {
          void refreshRunsFor(workspaceId);
        }
      }
    };

    // (Re)arm the coalescing timer: trailing-debounce by default, but never
    // later than the burst's max-wait deadline (set when the burst started).
    const armRunRefresh = (): void => {
      const now = Date.now();
      if (runRefreshDeadline.current === null) {
        runRefreshDeadline.current = now + RUN_REFRESH_MAX_WAIT_MS;
      }
      const delay = Math.max(
        0,
        Math.min(RUN_REFRESH_DEBOUNCE_MS, runRefreshDeadline.current - now),
      );
      if (runRefreshTimer.current !== null) {
        window.clearTimeout(runRefreshTimer.current);
      }
      runRefreshTimer.current = window.setTimeout(flushRunRefresh, delay);
    };

    return window.spark.orchestration.onEvent((event) => {
      if (!event.workspaceId) return;
      // Record the affected workspace and (re)arm the trailing timer. The
      // active workspace's runs/counts still update — just batched into one
      // refresh per burst rather than one per event.
      runRefreshPendingRef.current.add(event.workspaceId);
      armRunRefresh();

      // A deletion can race with the orchestration runner still flushing the
      // run file; a delayed second pass picks up the settled state. We just
      // re-mark the workspace ~500ms later so the regular debounced flush
      // re-lists it once things have quiesced.
      if (event.type === "run.deleted") {
        if (event.runId) {
          tabsRef.current.closeRunsTabFor(event.runId);
          tabsRef.current.closeWorkerTerminalTabFor(event.runId);
          // Previews spawned by the deleted run must close too: they're listed
          // only in the run's inner tab strip, which a deleted run can never
          // show again — leaving them would strand invisible browser tabs (and
          // if one was active, a fullscreen browser with no way to close it).
          tabsRef.current.closePreviewTabsFor(event.runId);
          // The three closers above only touch the ACTIVE workspace's store.
          // The Settings run manager can delete a background workspace's run;
          // its frozen snapshot would restore the dead run's tabs verbatim on
          // switch-back (stranded browser again). Prune those stores too.
          tabsRef.current.pruneDeletedRunTabsFromInactiveWorkspaces(event.runId);
          // Drop the chat tab too, so the active selection can't keep pointing
          // at a deleted run until the debounced refresh catches up. Unlike the
          // two calls above (which only mutate the active workspace's setTabs and
          // no-op for foreign runs), closeChatTabForRun writes the active
          // workspace's persisted closedChatRunIds set as a side-effect — so gate
          // it to the owning workspace, else a background workspace's deletion
          // leaks a dead id into the active workspace's dismissed-set.
          if (event.workspaceId === activeIdRef.current) {
            tabsRef.current.closeChatTabForRun(event.runId);
          }
          // The runs[] reconciliation only maintains the ACTIVE workspace's
          // remembered selection; scrub the dead id from every workspace's
          // restore map so switching into a background workspace can't
          // resurrect the deleted chat as its selection.
          for (const wsId of Object.keys(activeRunIdsByWorkspaceRef.current)) {
            if (activeRunIdsByWorkspaceRef.current[wsId] === event.runId) {
              activeRunIdsByWorkspaceRef.current[wsId] = null;
            }
          }
        }
        const deletedWorkspaceId = event.workspaceId;
        window.setTimeout(() => {
          runRefreshPendingRef.current.add(deletedWorkspaceId);
          armRunRefresh();
        }, 500);
      }

      // A spawn_terminals decision: Codara opened interactive terminals for
      // the user to drive. Each request gets a fresh numbered terminal tab
      // so it doesn't disturb whatever terminal layout the user already has.
      if (event.type === "spark.spawn_terminals") {
        if (processedSpawnTerminalEventsRef.current.has(event.id)) return;
        processedSpawnTerminalEventsRef.current.add(event.id);
        // Bound the dedup set so it can't grow forever over a long session.
        if (processedSpawnTerminalEventsRef.current.size > 500) {
          const ids = Array.from(processedSpawnTerminalEventsRef.current);
          processedSpawnTerminalEventsRef.current = new Set(ids.slice(ids.length - 250));
        }
        const payload = event.payload as
          | { terminals?: Array<{ command?: unknown; runtime?: unknown }> }
          | undefined;
        const spawnWorkspaceId = event.workspaceId;
        const cwd = workspacesRef.current.find(
          (w) => w.id === spawnWorkspaceId,
        )?.cwd;
        const specs = (payload?.terminals ?? [])
          .map((spec) => ({
            command: typeof spec.command === "string" ? spec.command : "",
            runtime: typeof spec.runtime === "string" ? spec.runtime : "",
          }))
          .filter((spec) => spec.command.length > 0);
        if (specs.length > 0) {
          if (spawnWorkspaceId && spawnWorkspaceId !== activeIdRef.current) {
            // Background run: don't drop its grid into the ACTIVE workspace's
            // tab store (that would land a cd'd-into-B terminal inside
            // workspace A and steal focus). Queue it; the replay effect spawns
            // it when this workspace is activated.
            const queue = pendingSpawnTerminalsRef.current.get(spawnWorkspaceId) ?? [];
            queue.push(...specs);
            pendingSpawnTerminalsRef.current.set(spawnWorkspaceId, queue);
          } else {
            window.setTimeout(() => {
              window.requestAnimationFrame(() => {
                tabsRef.current.newTerminalGrid(cwd, specs);
              });
            }, 0);
          }
        }
      }
    });
  }, [booted, refreshRunsFor]);

  // The event channel above only refreshes when orchestration APPENDS an
  // event. A live worker's activity readout (WorkerAttempt.runtimeActivity)
  // is deliberately event-less and in-memory — one journal append per tool
  // call would be spam — so a long worker turn can mutate the run cache for
  // minutes without a single event. While any attempt is live, poll the
  // snapshot at 1Hz to carry those silent mutations to the Runs card.
  // Cheap in every idle dimension: the tick is one array scan when nothing
  // is running, skips entirely while the window is hidden, and a no-change
  // poll is absorbed by refreshRunsFor's sameRunsList reference-keep.
  useEffect(() => {
    if (!booted) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const hasLiveAttempt = runsRef.current.some((run) =>
        run.workerAttempts.some((attempt) =>
          ["launching", "running", "finishing"].includes(attempt.status),
        ),
      );
      if (!hasLiveAttempt) return;
      void refreshRunsForRef.current(activeIdRef.current);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [booted]);

  // Replay any spawn-terminal specs queued for a workspace while it was in the
  // background. Runs whenever the active workspace changes (and once after
  // boot): if the now-active workspace has pending specs, drop them into its
  // tab store (which useTabs has already swapped to this workspace). The grid's
  // cwd is re-resolved from the live workspace list at replay time.
  useEffect(() => {
    if (!booted || !activeId) return;
    const queued = pendingSpawnTerminalsRef.current.get(activeId);
    if (!queued || queued.length === 0) return;
    pendingSpawnTerminalsRef.current.delete(activeId);
    const cwd = workspacesRef.current.find((w) => w.id === activeId)?.cwd;
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        tabsRef.current.newTerminalGrid(cwd, queued);
      });
    }, 0);
  }, [activeId, booted]);

  // Clear the run-refresh debounce timer on unmount so a pending flush can't
  // fire into an unmounted tree.
  useEffect(() => {
    return () => {
      if (runRefreshTimer.current !== null) {
        window.clearTimeout(runRefreshTimer.current);
        runRefreshTimer.current = null;
      }
      runRefreshDeadline.current = null;
    };
  }, []);

  // Sibling components that receive a fresh RunState from an IPC mutation can
  // dispatch `spark:run-snapshot` to push it through immediately, instead of
  // waiting for the debounced refresh that the orchestration event channel
  // drives. Used by the chat-message undo flow so the undo pill disappears
  // the instant the IPC call resolves rather than after a 250ms listRuns
  // roundtrip.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ run?: RunState }>).detail;
      if (detail?.run) handleRunSnapshot(detail.run);
    };
    window.addEventListener("spark:run-snapshot", handler);
    return () => window.removeEventListener("spark:run-snapshot", handler);
  }, [handleRunSnapshot]);

  // ── Focus-after-away digest + markRunSeen finalization ─────────────────────
  //
  // The walk-away thesis: the user delegates, leaves, and comes back. On
  // window 'blur' we stamp when they left; on 'focus' we compute one
  // "While you were away" digest from the global feed and surface it instead
  // of letting unseen-complete runs silently flip seen. Showing the digest is
  // also where markRunSeen finishes its wiring: every done-unseen run in the
  // digest is acknowledged (seen=true) so the teal "done while you were
  // elsewhere" cues clear deliberately, not behind the user's back.
  const awayAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!booted) return undefined;

    // Ignore sub-threshold focus flickers (e.g. a transient OS focus steal or
    // an alt-tab-and-back within the same glance) — "away" means the user
    // actually left for a beat, not every momentary blur.
    const AWAY_THRESHOLD_MS = 60_000;

    const managedRuns = () =>
      globalRuns.runsRef.current.filter(
        (run) => (!run.automationId && !isBoardCardRun(run)) || run.status === "blocked",
      );
    const onBlur = () => {
      awayAtRef.current = Date.now();
      awayBaselineRef.current = captureAwayDigestBaseline(managedRuns());
    };
    const onFocus = () => {
      const awayAt = awayAtRef.current;
      awayAtRef.current = null;
      if (awayAt === null || Date.now() - awayAt < AWAY_THRESHOLD_MS) return;
      // Same cockpit rule as the rail dots: loom runs surface only while
      // blocked (clicks route to the Automations Hub); their per-pass
      // completions never enter done-unseen.
      const digest = buildAwayDigest(
        managedRuns(),
        awayBaselineRef.current,
        visibleRunIdForTab(tabsRef.current.activeTab),
      );
      if (digest.total === 0) return;
      setAwayDigest(digest);
      // Finish markRunSeen wiring: acknowledge every done-unseen run so the
      // OS/unseen cues clear once surfaced. Best-effort; refresh the global
      // feed afterward so the rail dots/switcher drop the teal immediately.
      for (const run of digest.doneUnseen) {
        window.spark.orchestration
          .markRunSeen({ runId: run.id })
          .then(() => globalRuns.refresh())
          .catch(() => {
            /* best-effort: a stale seen flag self-heals on the next focus */
          });
      }
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
    // globalRuns.runsRef / refresh are stable refs; gate solely on booted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  const visibleAttentionRunId = visibleRunIdForTab(tabs.activeTab);
  useEffect(() => {
    if (!visibleAttentionRunId) return;
    setAwayDigest((current) =>
      current ? pruneAwayDigest(current, visibleAttentionRunId) : current,
    );
  }, [visibleAttentionRunId]);

  // Visiting a workspace answers its rail dot. The teal done-unseen cue exists
  // to pull the user TO the workspace; once they have dwelt there a beat, its
  // finished-unseen chats are acknowledged even if each one was never opened —
  // otherwise a chat that completed in the background keeps the dot lit
  // forever for a user who never blurs the window long enough for the away
  // digest to sweep it.
  const activeDoneUnseenCount = useMemo(
    () =>
      globalRuns.runs.filter(
        (r) =>
          r.workspaceId === activeId &&
          !r.automationId &&
          r.status === "complete" &&
          r.seen !== true,
      ).length,
    [globalRuns.runs, activeId],
  );
  useEffect(() => {
    if (!booted || !activeId || activeDoneUnseenCount === 0) return undefined;
    const workspaceId = activeId;
    const timer = window.setTimeout(() => {
      // An unfocused window is not "looking" — leave the cue for the digest.
      if (!document.hasFocus()) return;
      const pending = globalRuns.runsRef.current.filter(
        (r) =>
          r.workspaceId === workspaceId &&
          !r.automationId &&
          r.status === "complete" &&
          r.seen !== true,
      );
      if (pending.length === 0) return;
      void Promise.allSettled(
        pending.map((run) => window.spark.orchestration.markRunSeen({ runId: run.id })),
      ).then(() => globalRuns.refresh());
    }, 2500);
    return () => window.clearTimeout(timer);
    // runsRef/refresh are stable; the unseen count re-arms the dwell timer
    // when a run finishes while this workspace is already active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, activeId, activeDoneUnseenCount]);

  // Subscribe to renderer-side notification channels. The toast channel is
  // owned by <ToastHost/> below; this effect handles the embedded-sound
  // channel by playing the right WAV clip whenever main fires
  // "notification:sound". The main process has already filtered against
  // the user's preferences before sending — by the time we get here, the
  // user has the sound channel enabled, so we just play.
  useEffect(() => {
    const off = window.spark.notifications.onNotificationSound(({ kind }) => {
      playNotificationSound(kind);
    });
    return () => off();
  }, []);

  // Open the Automations Hub when main asks for it — fired by the tray menu's
  // "Open Automations" item and the global CommandOrControl+Shift+A
  // accelerator. tabsRef keeps the subscription stable across tab-state churn.
  useEffect(() => {
    const off = window.spark.windowControls.onOpenAutomations(() => {
      tabsRef.current.openAutomationsTab();
    });
    // Renderer-side twin of the same intent: surfaces without tab-store access
    // (the new-chat welcome's Automations row) broadcast this instead of prop
    // drilling through the chat stack.
    const onOpenTab = () => tabsRef.current.openAutomationsTab();
    window.addEventListener("spark:open-automations-tab", onOpenTab);
    return () => {
      off();
      window.removeEventListener("spark:open-automations-tab", onOpenTab);
    };
  }, []);

  // Main signals a quit is starting BEFORE it kills the PTYs (before-quit /
  // window-all-closed). Mark teardown so the pty:exit events that quit produces
  // don't deactivate running agents' restore pointers — otherwise the boot-once
  // resume is dropped and panes reopen as plain shells (the "resume only works
  // sometimes" bug). pagehide/beforeunload also set this, but on a Cmd+Q / tray
  // Quit the PTYs are killed while the renderer is still alive, before any
  // unload fires — so this earlier main-driven signal is what makes it reliable.
  useEffect(() => {
    const off = window.spark.app.onBeforeQuit?.(({ activeAgentPaneIds }) => {
      markAppTearingDown();
      const active = new Set(activeAgentPaneIds);
      for (const [paneId, runtime] of paneRuntimeRef.current) {
        if (runtime.altScreenActive === true) active.add(paneId);
      }
      // The worker chip is a third independent liveness signal. It covers a
      // just-launched agent whose raw-stream watcher has not identified its
      // banner yet and a TUI that does not use the alternate screen.
      const collectLiveWorkers = (node: PaneNode): void => {
        if (node.kind === "leaf") {
          if (
            node.agentSession?.sessionId &&
            node.worker?.state === "running" &&
            node.worker.agentRunning !== false
          ) {
            active.add(node.paneId);
          }
          return;
        }
        collectLiveWorkers(node.a);
        collectLiveWorkers(node.b);
      };
      for (const tab of tabsRef.current.tabs) {
        if (tab.kind === "terminal") collectLiveWorkers(tab.root);
      }
      tabsRef.current.flushAgentSessionsNow(Array.from(active));
    });
    return () => off?.();
  }, []);

  // Live pane → session-identity updates from the SessionStart hook. This is
  // what keeps a pane's restore pointer tracking in-TUI `/resume` and `/clear`
  // — both swap the session id with no filesystem signal, so the discovery
  // capture below never sees them and the pointer would go stale until the
  // next boot's registry heal. Panes in hidden workspace layers miss this
  // write (setLeafAgentSession only reaches the active workspace); their
  // pointers heal from the registry at next mount instead.
  useEffect(() => {
    const off = window.spark.agentSession.onStarted?.((rec) => {
      const t = tabsRef.current;
      for (const tab of t.tabs) {
        if (tab.kind !== "terminal") continue;
        const leaf = findLeafByPaneId(tab.root, rec.paneId);
        if (!leaf) continue;
        const healed = mergeSessionStart(leaf.agentSession ?? null, rec);
        if (healed) {
          t.setLeafAgentSession(tab.id, rec.paneId, {
            ...healed,
            // The hook fired because a session is starting in this pane right
            // now, but `active` is the running-at-quit judgment the poller
            // owns — only assert it when the TUI is already confirmed live
            // (the poller's next tick keeps it correct either way).
            active:
              paneRuntimeRef.current.get(rec.paneId)?.altScreenActive === true ||
              healed.active === true,
          });
        }
        return;
      }
    });
    return () => off?.();
  }, []);

  // Boot handshake for main's renderer watchdog: React is mounted, the boot
  // splash is gone. If a loaded page never sends this, main escalates recovery
  // instead of leaving the user staring at the breathing-square splash.
  useEffect(() => {
    if (rendererReadySignaled) return;
    rendererReadySignaled = true;
    window.spark.app.signalReady?.();
  }, []);

  // Theme the entire UI with the active workspace's color. Falls back to the
  // default yellow when nothing is active.
  useEffect(() => {
    const accent = activeWorkspace?.color || "#2AA298";
    document.documentElement.style.setProperty("--accent", accent);
  }, [activeWorkspace?.color]);

  // Open the unified in-app SettingsDialog when any part of the app
  // dispatches the `spark:open-settings` window event. Previously this
  // routed to a dedicated Settings BrowserWindow (still on disk under
  // src/renderer/settings); we fold both surfaces into the polished old
  // dialog so users only see one settings UI.
  useEffect(() => {
    const handler = () => {
      void loadSettingsDialog();
      setSettingsOpen(true);
    };
    window.addEventListener("spark:open-settings", handler);
    return () => window.removeEventListener("spark:open-settings", handler);
  }, []);

  // Warm both large dialog chunks after the initial workbench paint. The
  // timeout keeps this deterministic on a busy renderer where requestIdleCallback
  // might otherwise wait indefinitely. Dynamic imports are module-cached, so
  // the explicit preload and React.lazy always share the same evaluation.
  useEffect(() => {
    const preload = () => {
      void loadSettingsDialog();
      void loadAgentCapabilitiesDialog();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload, { timeout: 1200 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 250);
    return () => window.clearTimeout(id);
  }, []);

  // Mirror the workspaces list through a ref so the orchestration listener
  // doesn't re-subscribe on every workspace state change (which is often
  // — runs trigger updates).
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  // When the orchestration runner emits `launch_requested`, the worker is
  // being launched and is waiting for a renderer-side PTY at sessionId =
  // attemptId. Cora workers live in one run-scoped terminal tab titled
  // "workers" instead of claiming arbitrary user shells. The tab stays mounted
  // across chat switches so PTYs continue running, but the tab strip only
  // reveals it while its run is the active chat.
  //
  // Deliberately NOT `envelope_prepared`: that one fires when the prompt is
  // written to disk (attempt status prompt_ready), which can precede the launch
  // by a whole manager turn — or forever, if the run pauses first. It opened a
  // worker terminal for an agent that did not exist, and the user went looking
  // for the agent and found an empty shell (run-ms9ikoef-mnucvq).
  // `launch_requested` is emitted inside launchWorkerAttempt in the same commit
  // that flips the attempt to "launching", so a CLI worker's pane (whose
  // creation drives the actual pty:spawn) materializes right at launch. Pi
  // attempts skip this path entirely — see the harness gate below.
  useEffect(() => {
    if (!booted) return;

    const handleLaunchRequested = async (event: SparkEvent) => {
      if (event.type !== "worker_attempt.launch_requested") return;
      if (!event.runId || !event.workerTaskId || !event.attemptId) return;
      if (!event.workspaceId) return;
      // Loom workers: main owns their pty (direct-worker.ts) and the
      // Automations Hub renders them — never open a workers terminal tab.
      // Payload check is synchronous; a missing stamp falls through (fail-open
      // to the visible tab rather than an invisible worker).
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.automationId) return;

      // A useTabs instance only owns the workspace currently loaded into its
      // live store. A worker event for a background workspace must not create
      // its pane in whichever project happens to be on screen; the durable
      // reconciliation effect below will attach it when that workspace is
      // selected.
      if (tabsRef.current.tabsWorkspaceId !== event.workspaceId) return;

      const ws = workspacesRef.current.find((w) => w.id === event.workspaceId);
      if (!ws) return;
      const workspaceCwd = ws.cwd;

      // Pull the task/attempt metadata that names the pane header (title,
      // runtime, attempt ordinal). Best-effort — the header is decoration; the
      // PTY claim itself doesn't depend on it.
      let runtime: "claude" | "codex" | undefined;
      let title: string | undefined;
      let attemptOrdinal: number | undefined;
      let nativeCodexProfileId =
        typeof event.payload?.nativeCodexProfileId === "string"
          ? event.payload.nativeCodexProfileId
          : undefined;
      let nativeClaudeProfileId =
        typeof event.payload?.nativeClaudeProfileId === "string"
          ? event.payload.nativeClaudeProfileId
          : undefined;
      let harness: "pi" | "cli" | undefined;
      let startedAt: string | undefined;
      let model: string | undefined;
      try {
        const run = await window.spark.orchestration.getRun(event.runId);
        const task = run?.workerTasks.find((item) => item.id === event.workerTaskId);
        if (
          task?.runtimePreference === "claude" ||
          task?.runtimePreference === "codex"
        ) {
          runtime = task.runtimePreference;
        }
        title = task?.title;
        const attempt = run?.workerAttempts.find((item) => item.id === event.attemptId);
        attemptOrdinal = attempt?.attemptNumber;
        nativeCodexProfileId = attempt?.nativeCodexProfileId;
        nativeClaudeProfileId = attempt?.nativeClaudeProfileId;
        harness = workerHarnessFromCommand(attempt?.command);
        startedAt = attempt?.startedAt;
        // The attempt's resolved model beats the task's hint: the planner's
        // hint is a request, and the spawn path may coerce it onto the roster.
        model = attempt?.model ?? task?.modelHint;
      } catch {
        /* header metadata is decorative */
      }

      // getRun is asynchronous. The user may have switched workspaces while
      // it was in flight, so repeat the ownership gate immediately before the
      // tab mutation.
      if (tabsRef.current.tabsWorkspaceId !== event.workspaceId) return;

      const workerMeta = {
        runtime,
        nativeCodexProfileId,
        nativeClaudeProfileId,
        runId: event.runId,
        workerTaskId: event.workerTaskId,
        attemptId: event.attemptId,
        source: "spark" as const,
        state: "running" as const,
        title,
        attemptOrdinal,
        harness,
        model,
        startedAt,
      };

      const t = tabsRef.current;
      if (!t) return;
      // Pi-harness workers run in-process over RPC; main creates their display
      // pty a beat AFTER this launch event, so a pane materialized here would
      // have nothing to attach to yet. The 1s reconcile loop below owns Pi
      // panes instead: it waits for pty.exists(attemptId) and attaches then.
      if (harness === "pi") return;
      // ensureWorkerTerminalTab activates a newly materialized pane itself; a
      // repeat event for an existing pane must not steal the user's selection.
      const tabId = t.ensureWorkerTerminalTab(event.runId, workspaceCwd, event.attemptId, workerMeta, {
        focus: false,
      });
      t.setLeafCwd(tabId, event.attemptId, workspaceCwd);
    };

    // Keep successful worker evidence inspectable, but close failed worker
    // panes immediately. The run transcript owns the durable error + retry
    // lineage; a dead red terminal only looks like a provider is still live.
    const handleAttemptFinished = (event: SparkEvent) => {
      if (event.type !== "worker_attempt.finished") return;
      const attemptId = event.attemptId;
      if (!attemptId) return;
      finishedWorkerAttemptsRef.current.add(attemptId);
      if (finishedWorkerAttemptsRef.current.size > 1_000) {
        const ids = Array.from(finishedWorkerAttemptsRef.current);
        finishedWorkerAttemptsRef.current = new Set(ids.slice(ids.length - 500));
      }
      const payload = event.payload as Record<string, unknown> | undefined;
      const exitCode = typeof payload?.exitCode === "number" ? payload.exitCode : 0;
      const failed =
        exitCode !== 0 ||
        (typeof payload?.error === "string" && payload.error.length > 0);
      // Kill by durable attempt id even if renderer tab metadata was lost
      // during reload. The run transcript still owns the failure, and the
      // tombstone above prevents the reconciliation loop from respawning it.
      if (failed) {
        void window.spark.pty.dispose(attemptId).catch(() => undefined);
      }
      const t = tabsRef.current;
      if (!t) return;
      for (const tab of t.tabs) {
        if (tab.kind !== "terminal") continue;
        const leaf = findLeafByPaneId(tab.root, attemptId);
        if (leaf) {
          if (failed) {
            t.closeTerminalPane(tab.id, attemptId);
            return;
          }
          const prior = leaf.worker;
          t.setLeafWorker(tab.id, attemptId, {
            runtime: prior?.runtime,
            runId: event.runId ?? prior?.runId ?? "",
            workerTaskId: event.workerTaskId ?? prior?.workerTaskId ?? "",
            attemptId,
            source: "spark",
            state: "done",
            agentRunning: prior?.agentRunning,
            title: prior?.title,
            attemptOrdinal: prior?.attemptOrdinal,
            harness: prior?.harness,
            // The header names the MODEL and falls back to the harness only
            // when it has none; rebuilding the worker without it renamed every
            // finished pane back to "Pi · Claude". runtimeState carries the
            // finish through as well: an attempt that reached here without
            // error ended cleanly, and "done" is what keeps a late pty exit
            // from finding an unsettled worker to brand.
            model: prior?.model,
            runtimeState: "done",
            startedAt: prior?.startedAt,
          });
          return;
        }
      }
      // Not in the active workspace's store: the attempt's pane may live in a
      // mounted-but-hidden workspace's frozen layout. Apply the same cleanup
      // there, or switching back would restore a failed pane verbatim with its
      // chip stuck on "running" — the attempt is terminal and tombstoned, so
      // no reconcile pass ever heals it.
      const hidden = t.findTerminalPaneInInactiveWorkspaces(attemptId);
      if (!hidden) return;
      if (failed) {
        t.closeTerminalPaneInWorkspace(hidden.workspaceId, hidden.tabId, attemptId);
        return;
      }
      t.updateLeafWorkerInWorkspace(hidden.workspaceId, hidden.tabId, attemptId, (prior) => ({
        runtime: prior?.runtime,
        runId: event.runId ?? prior?.runId ?? "",
        workerTaskId: event.workerTaskId ?? prior?.workerTaskId ?? "",
        attemptId,
        source: "spark",
        state: "done",
        agentRunning: prior?.agentRunning,
        title: prior?.title,
        attemptOrdinal: prior?.attemptOrdinal,
        harness: prior?.harness,
        // Same identity + settled-state carry as the active-workspace branch
        // above: a hidden pane must come back named and calm, not crashed.
        model: prior?.model,
        runtimeState: "done",
        startedAt: prior?.startedAt,
      }));
    };

    return window.spark.orchestration.onEvent((event) => {
      void handleLaunchRequested(event);
      handleAttemptFinished(event);
    });
  }, [booted]);

  // Worker panes used to be edge-triggered: the renderer had exactly one
  // chance to hear the launch event. If that event landed before this
  // subscription mounted, during renderer reload, or while the worker's
  // workspace was in the background, no pane existed to call pty:spawn and main
  // eventually timed the worker out. Reconcile the durable run snapshot itself:
  // every LAUNCHED attempt gets a pane whether or not its PTY exists yet.
  // TerminalPane then creates a missing PTY or attaches to a main-owned one,
  // making the launch level-triggered instead of a one-shot renderer event.
  useEffect(() => {
    if (!booted || !activeId) return;

    const workspaceId = activeId;

    let disposed = false;
    let reconciling = false;
    // Last worker literal handed to useTabs per attempt. Re-passing the SAME
    // reference on a no-change tick lets setLeafField's Object.is bail without
    // even reaching the shallow meta compare.
    const workerMetaByAttempt = new Map<string, TerminalLeafWorker>();
    const reconcile = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        // Read runs through the ref: a `runs` dep would tear down and re-arm
        // this interval (plus run an extra immediate reconcile) on every 1s
        // refresh, even when nothing changed.
        // Launched only. "preparing"/"prompt_ready" mean a prompt on disk and
        // no process: they own no pty to attach to and may never launch at all,
        // so a pane for one is an empty shell wearing a worker's name. The
        // statuses here are the same ones deriveComposerWorkerActivity calls
        // live, so the chip, the rows and the terminal agree on what exists.
        const liveAttempts = runsRef.current.flatMap((run) =>
          run.workerAttempts
            .filter((attempt) =>
              ["launching", "running", "finishing"].includes(attempt.status),
            )
            .map((attempt) => ({ run, attempt })),
        );
        await Promise.all(
          liveAttempts.map(async ({ run, attempt }) => {
            // Loom/direct automation workers have their own durable Workers
            // surface and must never materialize as chat-owned terminal tabs.
            if (run.automationId || run.workspaceId !== workspaceId) return;
            if (finishedWorkerAttemptsRef.current.has(attempt.id)) return;
            // A Pi-harness worker runs in-process over RPC; MAIN owns its
            // display pty (ensurePiWorkerDisplayPty in run-store) and the pane
            // only ever ATTACHES to that session (TerminalStack hands pi
            // leaves a fail-closed shell, so pane creation cannot spawn one).
            // Gate on the session actually existing: a stale "running" attempt
            // whose session is gone (boot recovery, killed display) must not
            // materialize a pane that has nothing to attach to.
            if (workerHarnessFromCommand(attempt.command) === "pi") {
              const hasDisplaySession = await window.spark.pty
                .exists(attempt.id)
                .catch(() => false);
              if (!hasDisplaySession) return;
            }

            if (disposed) return;
            if (tabsRef.current.tabsWorkspaceId !== workspaceId) return;

            const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
            const runtime =
              attempt.runtime === "claude" || attempt.runtime === "codex"
                ? attempt.runtime
                : task?.runtimePreference === "claude" || task?.runtimePreference === "codex"
                  ? task.runtimePreference
                  : undefined;
            const snapshotCwd = run.settingsSnapshot?.workspaceCwd;
            const cwd =
              attempt.cwd ||
              (typeof snapshotCwd === "string" ? snapshotCwd : undefined) ||
              workspacesRef.current.find((workspace) => workspace.id === workspaceId)?.cwd;
            const candidateMeta: TerminalLeafWorker = {
              runtime,
              nativeCodexProfileId: attempt.nativeCodexProfileId,
              nativeClaudeProfileId: attempt.nativeClaudeProfileId,
              runId: run.id,
              workerTaskId: attempt.workerTaskId,
              attemptId: attempt.id,
              source: "spark",
              state: "running",
              runtimeState: attempt.runtimeState,
              title: task?.title,
              attemptOrdinal: attempt.attemptNumber,
              harness: workerHarnessFromCommand(attempt.command),
              model: attempt.model ?? task?.modelHint,
              startedAt: attempt.startedAt,
            };
            const cached = workerMetaByAttempt.get(attempt.id);
            const workerMeta =
              cached && sameWorkerMeta(cached, candidateMeta) ? cached : candidateMeta;
            workerMetaByAttempt.set(attempt.id, workerMeta);
            const tabId = tabsRef.current.ensureWorkerTerminalTab(
              run.id,
              cwd,
              attempt.id,
              workerMeta,
              // Level-triggered re-ensures run every second; they must never
              // move the user's pane selection. (A pane the loop MATERIALIZES
              // still activates — creation, not re-ensure, drives focus, and
              // pane creation is also what drives pty:spawn.)
              { focus: false, activate: false },
            );
            if (cwd) tabsRef.current.setLeafCwd(tabId, attempt.id, cwd);
          }),
        );
        // The cache only serves live attempts; without pruning it would grow
        // by one entry per attempt for the lifetime of the effect.
        if (workerMetaByAttempt.size > liveAttempts.length) {
          const live = new Set(liveAttempts.map(({ attempt }) => attempt.id));
          for (const id of workerMetaByAttempt.keys()) {
            if (!live.has(id)) workerMetaByAttempt.delete(id);
          }
        }
      } finally {
        reconciling = false;
      }
    };

    void reconcile();
    const interval = window.setInterval(() => void reconcile(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [booted, activeId]);

  // Apply both live daemon events and level-triggered snapshots through one
  // idempotent path. Cold hydration intentionally strips transient worker
  // metadata, so a known-active durable session is the one safe case where a
  // main-process state may recreate the manual chip instead of merely updating
  // an existing one.
  const reconcileTerminalAgentState = useCallback((payload: TerminalAgentStatePayload) => {
    if (payload?.workspaceId && payload.paneId && payload.state) {
      setTerminalPaneWorking(
        payload.workspaceId,
        payload.paneId,
        payload.state === "working",
      );
    }
    if (!payload?.tabId || !payload.paneId || !payload.state) return;
    const t = tabsRef.current;
    const targetWorkspaceId = payload.workspaceId ?? t.tabsWorkspaceId;
    if (!targetWorkspaceId) return;

    // Only inspect the active in-memory layer for mint authority. Hidden
    // workspace caches still receive updates to existing workers through
    // updateLeafWorkerInWorkspace, but cannot accidentally resurrect one from
    // a stale daemon event. They reconcile when their layer mounts.
    const activeTab =
      targetWorkspaceId === t.tabsWorkspaceId
        ? t.tabs.find((item) => item.id === payload.tabId && item.kind === "terminal")
        : null;
    const activeLeaf =
      activeTab?.kind === "terminal"
        ? findLeafByPaneId(activeTab.root, payload.paneId)
        : null;
    const sessionRuntime = activeLeaf?.agentSession?.active
      ? activeLeaf.agentSession.runtime
      : null;
    const canRehydrateManualWorker =
      payload.state !== "done" &&
      sessionRuntime !== null &&
      (payload.runtime === null || payload.runtime === sessionRuntime);

    t.updateLeafWorkerInWorkspace(
      targetWorkspaceId,
      payload.tabId,
      payload.paneId,
      (existing) => {
        if (!existing) {
          if (!canRehydrateManualWorker || !sessionRuntime) return existing;
          return {
            runtime: payload.runtime ?? sessionRuntime,
            runId: "manual",
            workerTaskId: `manual-${payload.paneId}`,
            attemptId: payload.paneId,
            source: "manual",
            state: "running",
            agentRunning: true,
            runtimeState: payload.state,
          };
        }
        // A pane already flipped to "error" is showing a PTY crash. Preserve
        // that authoritative exit state against delayed notifier snapshots.
        if (existing.runtimeState === "error") return existing;
        if (payload.state === "done") {
          if (existing.source === "spark") {
            return existing.agentRunning === false
              ? existing
              : { ...existing, agentRunning: false };
          }
          return null;
        }
        const runtimeState = mergeTerminalRuntimeState(
          existing.runtimeState,
          payload.state,
        );
        return existing.runtimeState === runtimeState
          ? existing
          : { ...existing, runtimeState };
      },
    );
  }, [setTerminalPaneWorking]);

  // ── Terminal-agent notifications (manual claude/codex panes) ──────────────
  //
  // The main-process watcher (terminal-agent-notify.ts) taps the raw pty
  // streams of user-facing terminal panes and alerts when a Claude/Codex CLI
  // finishes a turn or stops for permission while the user isn't
  // looking at that tab. The renderer owns three pieces of the loop:
  //
  //   1. The pane registry — which pty sessions are user terminal panes, and
  //      which workspace/tab each lives in (for routing the click back).
  //      Cora-orchestrated worker panes register excluded: run-store events
  //      already alert for those.
  //   2. The active context — which workspace + tab + split pane is selected,
  //      so main can suppress only the terminal that can currently receive
  //      input (a sibling permission prompt should still get attention).
  //   3. Click navigation — native-notification and toast clicks both land
  //      in focusTerminalTarget, which switches workspace if needed (queue +
  //      replay, same pattern as pendingSpawnTerminalsRef) and then activates
  //      the tab + pane.
  useEffect(() => {
    if (!booted) return;
    const workspaceId = tabs.tabsWorkspaceId;
    if (!workspaceId) return;
    const panes: Array<{
      paneId: string;
      tabId: string;
      tabTitle: string;
      excluded: boolean;
      runtimeHint?: "claude" | "codex" | null;
    }> = [];
    for (const tab of tabs.tabs) {
      if (tab.kind !== "terminal") continue;
      const workersTab = tab.scope?.kind === "workers";
      forEachTerminalLeaf(tab.root, (leaf) => {
        panes.push({
          paneId: leaf.paneId,
          tabId: tab.id,
          tabTitle: tab.title,
          // Cora-spawned worker panes are excluded from terminal-agent alerts
          // for their WHOLE lifetime, not just while state==="running". The
          // run-store lifecycle already alerts these workers; the pty tap must
          // never speak for them. The old state gate leaked at TEARDOWN: state
          // leaves "running" (worker_attempt.finished flips it to "done") while
          // the CLI is still painting its exit / a lingering permission prompt,
          // so the pane became watched and that boot/exit prompt matched the
          // broad "blocked" patterns → a bogus "needs you" toast for a prompt
          // nobody had to answer. `leaf.worker.source` is never cleared to null
          // once set to "spark" (only manual chips clear; spark panes keep their
          // metadata with agentRunning:false), so this covers the pane until it
          // is closed.
          //
          // Reachability: `source:"spark"` panes are created inside a
          // workers-scoped tab (ensureWorkerTerminalTab), already covered by the
          // `workersTab` clause. The spark clause therefore only bites once such
          // a pane is DETACHED/moved into a plain tab (detachTerminalPaneToNewTab
          // / moveTerminalPane carry the worker meta across). No chip regression
          // for the orchestration lifecycle: a running spark pane was ALREADY not
          // fed by this tap; its chip comes from the run-store worker lifecycle
          // (worker_attempt.* → setLeafWorker) and the renderer visible-buffer
          // poller, both independent of `excluded`.
          //
          // Known trade-off (accepted): if a user DETACHES a done worker pane and
          // manually runs `claude`/`codex` in it, that reused session no longer
          // fires done/blocked toasts and — while the pane is hidden — its chip
          // runtimeState can go stale (the notifier tap was the only hidden-pane
          // writer; teardown via alt-screen exit still clears it). This is a rare
          // path and the bogus-alert fix is worth it; if it ever needs alerts,
          // clear leaf.worker on detach so the pane reads as a plain terminal.
          excluded: workersTab || leaf.worker?.source === "spark",
          runtimeHint:
            leaf.agentSession?.active === true
              ? leaf.agentSession.runtime
              : leaf.worker?.agentRunning !== false &&
                  (leaf.worker?.runtime === "claude" || leaf.worker?.runtime === "codex")
                ? leaf.worker.runtime
                : null,
        });
      });
    }
    // Prune activity-spin entries for panes that closed while this workspace
    // was hidden: a pane removed off-screen never gets a clearing state event,
    // so drop any tracked paneId no longer in the live pane list. Same
    // same-object-when-unchanged discipline as the notifier effect.
    const livePaneIds = new Set(panes.map((p) => p.paneId));
    setTerminalWorking((current) => {
      const ws = current[workspaceId];
      if (!ws) return current;
      const kept: Record<string, true> = {};
      let changed = false;
      for (const paneId of Object.keys(ws)) {
        if (livePaneIds.has(paneId)) kept[paneId] = true;
        else changed = true;
      }
      if (!changed) return current;
      if (Object.keys(kept).length === 0) {
        const { [workspaceId]: _droppedWs, ...restWorkspaces } = current;
        return restWorkspaces;
      }
      return { ...current, [workspaceId]: kept };
    });
    // Optional chaining: during dev HMR the renderer can be newer than the
    // preload of a long-lived instance; degrade to no-op instead of throwing
    // inside the effect.
    const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? "";
    window.spark.terminalNotify
      ?.sync?.({ workspaceId, workspaceName, panes })
      ?.then((states) => {
        for (const state of states ?? []) reconcileTerminalAgentState(state);
      })
      ?.catch(() => {
        /* registry sync is best-effort; the next layout change retries */
      });
  }, [booted, tabs.tabs, tabs.tabsWorkspaceId, workspaces, reconcileTerminalAgentState]);

  useEffect(() => {
    if (!booted) return;
    // Report the unified attention snapshot — window focus plus the
    // (workspace, tab, run, pane) the user is looking at — so the notify
    // policy can suppress alerts for the surface already on screen. The
    // (workspace, tab) pair comes from the tabs state itself so it stays
    // internally consistent even on the one render where a workspace switch
    // has flipped activeId but tabs still hold the previous layout.
    const activeTab = tabs.tabs.find((t) => t.id === tabs.activeId);
    const send = () => {
      window.spark.ui
        .setAttention?.({
          focused: document.hasFocus(),
          workspaceId: tabs.tabsWorkspaceId,
          tabId: tabs.activeId,
          runId: visibleRunIdForTab(activeTab),
          paneId: activeTab?.kind === "terminal" ? activeTab.activePaneId : null,
        })
        ?.catch(() => {
          /* suppression context is best-effort */
        });
    };
    send();
    // Re-send on focus/blur so the `focused` bit tracks alt-tab (main also
    // queries live window focus; this keeps the snapshot honest).
    window.addEventListener("focus", send);
    window.addEventListener("blur", send);
    return () => {
      window.removeEventListener("focus", send);
      window.removeEventListener("blur", send);
    };
  }, [booted, tabs.tabs, tabs.tabsWorkspaceId, tabs.activeId]);

  // ── Terminal-agent attention (rail dot) ─────────────────────────────────
  useEffect(() => {
    const off = window.spark.terminalNotify?.onAttention?.((payload) => {
      const target = payload?.target;
      if (!target?.workspaceId || !target.tabId || !target.paneId) return;
      setTerminalAttention((current) => ({
        ...current,
        [target.workspaceId]: {
          ...(current[target.workspaceId] ?? {}),
          [target.paneId]: { tabId: target.tabId, kind: payload.kind },
        },
      }));
    });
    return () => off?.();
  }, []);

  // ── Terminal-agent live chip state (focus-independent) ──────────────────
  // The main-process notifier derives working/blocked/idle/done turn boundaries
  // from the RAW pty stream, so this fires even while the pane is hidden/
  // unfocused — exactly when the renderer's own visible-buffer poller is frozen
  // and the chip would otherwise stay stuck on "working". We write the state
  // onto the matching leaf.worker.runtimeState. Live IPC is the fast path;
  // snapshot reconciliation makes the channel level-triggered so a renderer
  // restart cannot permanently miss an already-working transition.
  useEffect(() => {
    if (!booted) return;
    const off = window.spark.terminalNotify?.onState?.(reconcileTerminalAgentState);
    let disposed = false;
    const reconcile = () => {
      void window.spark.terminalNotify
        ?.snapshot?.()
        ?.then((states) => {
          if (disposed) return;
          for (const state of states ?? []) reconcileTerminalAgentState(state);
        })
        ?.catch(() => {
          /* daemon reconciliation is best-effort; the next tick retries */
        });
    };
    reconcile();
    // Skip ticks while the window is hidden — the live onState channel above
    // keeps delivering transitions either way, and a hidden window has no chip
    // to correct. Returning to visible reconciles immediately so anything the
    // renderer missed is repaired before the user reads the tabs.
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      reconcile();
    }, 1_500);
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      off?.();
    };
  }, [booted, reconcileTerminalAgentState]);

  // Attention is "seen" once the user lands on the pane's tab — also prune
  // entries whose tab no longer exists so a closed tab can't pin the dot
  // forever. Reads tabsRef so the focus listener below can reuse it.
  const clearSeenTerminalAttention = useCallback(() => {
    const t = tabsRef.current;
    const wsId = t.tabsWorkspaceId;
    if (!wsId) return;
    setTerminalAttention((current) => {
      const entries = current[wsId];
      if (!entries) return current;
      const liveTabIds = new Set(t.tabs.map((tab) => tab.id));
      let changed = false;
      const kept: typeof entries = {};
      for (const [paneId, info] of Object.entries(entries)) {
        if (info.tabId === t.activeId || !liveTabIds.has(info.tabId)) {
          changed = true;
          continue;
        }
        kept[paneId] = info;
      }
      if (!changed) return current;
      const next = { ...current };
      if (Object.keys(kept).length === 0) delete next[wsId];
      else next[wsId] = kept;
      return next;
    });
  }, []);

  useEffect(() => {
    clearSeenTerminalAttention();
  }, [tabs.tabsWorkspaceId, tabs.activeId, tabs.tabs, clearSeenTerminalAttention]);

  // An alert can fire for the very tab the user has open in an UNFOCUSED
  // window (not watching by the suppression rule). Landing back on the
  // window means they see the pane — clear it then too.
  useEffect(() => {
    window.addEventListener("focus", clearSeenTerminalAttention);
    return () => window.removeEventListener("focus", clearSeenTerminalAttention);
  }, [clearSeenTerminalAttention]);

  const pendingFocusTerminalRef = useRef<TerminalAgentTarget | null>(null);

  const applyTerminalFocus = useCallback((target: TerminalAgentTarget) => {
    const t = tabsRef.current;
    let tab: TerminalTab | undefined;
    const byId = t.tabs.find((item) => item.id === target.tabId);
    if (byId?.kind === "terminal" && findLeafByPaneId(byId.root, target.paneId)) {
      tab = byId;
    } else {
      // The pane may have been dragged to a different tab (or its tab
      // closed) after the alert fired — locate it by paneId instead.
      tab = t.tabs.find(
        (item): item is TerminalTab =>
          item.kind === "terminal" && findLeafByPaneId(item.root, target.paneId) !== null,
      );
    }
    if (!tab) return;
    t.setActiveTab(tab.id);
    t.setActiveTerminalPane(tab.id, target.paneId);
  }, []);

  const focusTerminalTarget = useCallback(
    (target: TerminalAgentTarget) => {
      if (!target?.workspaceId || !target.paneId) return;
      if (activeIdRef.current !== target.workspaceId) {
        if (!workspacesRef.current.some((w) => w.id === target.workspaceId)) return;
        // Cross-workspace: switch first; the replay effect below applies the
        // tab/pane focus once useTabs has swapped in that workspace's layout.
        pendingFocusTerminalRef.current = target;
        setActiveId(target.workspaceId);
        return;
      }
      if (tabsRef.current.tabsWorkspaceId !== target.workspaceId) {
        // The workspace is already active but the tabs swap is still in
        // flight (one-render lag after a switch) — queue for the replay
        // effect instead of poking the previous workspace's layout.
        pendingFocusTerminalRef.current = target;
        return;
      }
      applyTerminalFocus(target);
    },
    [applyTerminalFocus],
  );

  // Replay a queued cross-workspace focus once the target workspace's tab
  // layout is actually loaded (tabsWorkspaceId catches up with activeId one
  // render after a switch). setTimeout + rAF mirrors the spawn-terminal
  // replay above and lets the swap commit paint before we move focus.
  useEffect(() => {
    if (!booted) return;
    const pending = pendingFocusTerminalRef.current;
    if (!pending || pending.workspaceId !== tabs.tabsWorkspaceId) return;
    pendingFocusTerminalRef.current = null;
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        applyTerminalFocus(pending);
      });
    }, 0);
  }, [booted, tabs.tabsWorkspaceId, applyTerminalFocus]);

  // One navigation entry point for every notification surface (toast cards,
  // native-notification clicks via "notify:focus", the notification center).
  const navigateToNotifyTarget = useMemo(
    () =>
      createNavigateTo({
        selectRun: handleSelectRunAnywhere,
        focusTerminal: focusTerminalTarget,
        openAutomations: () => tabsRef.current.openAutomationsTab(),
      }),
    [handleSelectRunAnywhere, focusTerminalTarget],
  );
  useNotifyFocusRouting(navigateToNotifyTarget, booted);

  // Shared by the toast cards and the notification center: resolve the exact
  // linked open question for inline answers. Main owns blocker clearing and the
  // resume strategy, including direct Loom behavior.
  const resolveRunQuestion = useCallback(
    (runId: string) => {
      const run = globalRuns.runsRef.current.find((r) => r.id === runId);
      const question = run ? findOpenQuestion(run) : null;
      if (!question) return null;
      // The question's message id rides along so answer surfaces can link
      // their answer to it (consent gates only accept linked answers).
      return { questionMessageId: question.id, options: question.questionOptions ?? [] };
    },
    [globalRuns.runsRef],
  );
  // WorkspaceRail prop callbacks. `setActiveId` / `setEditingId` are stable
  // React setters, so these can carry empty dep arrays and stay referentially
  // stable for the lifetime of the component — which lets the React.memo on
  // WorkspaceRail actually skip renders.
  const handleActivateWorkspace = useCallback((id: string) => {
    pendingCrossWorkspaceRunSelectionRef.current = null;
    runSelectionGenerationRef.current += 1;
    const currentWorkspaceId = activeIdRef.current;
    if (currentWorkspaceId) {
      activeRunIdsByWorkspaceRef.current[currentWorkspaceId] = activeRunIdRef.current;
    }
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const handleEditWorkspace = useCallback((id: string) => {
    setEditingId((prev) => (prev === id ? null : id));
  }, []);

  const handleCloseWorkspaceEditor = useCallback(() => {
    setEditingId(null);
  }, []);

  // WindowChrome prop callbacks — hoisted to stable references so the
  // React.memo on WindowChrome can skip re-renders triggered by unrelated
  // App state churn (color edits, orchestration events, run polls).
  const handleToggleLeft = useCallback(() => {
    if (compactWorkbench) {
      setCompactPanel((panel) => panel === "left" ? null : "left");
      return;
    }
    setShowLeft((v) => !v);
  }, [compactWorkbench]);

  const handleToggleRight = useCallback(() => {
    if (compactWorkbench) {
      setCompactPanel((panel) => panel === "right" ? null : "right");
      return;
    }
    setShowRight((v) => !v);
  }, [compactWorkbench]);

  // Panel resize: snapshot the panel's current width when a drag starts, then
  // translate the pointer delta the ResizeHandle reports into a new width.
  // usePanelLayout clamps, so an over-drag is harmless.
  const leftWidthAtDragStart = useRef(0);
  const rightWidthAtDragStart = useRef(0);
  const handleLeftWidthStart = useCallback(() => {
    leftWidthAtDragStart.current = panelsRef.current.leftWidth;
  }, []);
  const handleLeftWidthResize = useCallback((delta: number) => {
    panelsRef.current.setLeftWidth(leftWidthAtDragStart.current + delta);
  }, []);
  const handleRightWidthStart = useCallback(() => {
    rightWidthAtDragStart.current = panelsRef.current.rightWidth;
  }, []);
  const handleRightWidthResize = useCallback((delta: number) => {
    // The right handle sits on the panel's inner edge, so dragging left (a
    // negative delta) widens the panel.
    panelsRef.current.setRightWidth(rightWidthAtDragStart.current - delta);
  }, []);
  const togglePanelSection = useCallback((section: PanelSectionKey) => {
    panelsRef.current.toggleCollapse(section);
  }, []);
  const movePanelSection = useCallback((section: PanelSectionKey, side: PanelSide, index: number) => {
    panelsRef.current.moveSection(section, side, index);
  }, []);
  const handlePanelSectionDragStart = useCallback((section: PanelSectionKey) => {
    setDraggingPanelSection(section);
  }, []);
  const handlePanelSectionDragEnd = useCallback(() => {
    setDraggingPanelSection(null);
  }, []);

  const handleOpenSettings = useCallback(() => {
    void loadSettingsDialog();
    setSettingsOpen(true);
  }, []);

  // Read through tabsRef so the title bar's opener stays referentially stable
  // across App renders, like the tray's Automations handler above.
  const handleOpenUsage = useCallback(() => {
    tabsRef.current.openUsageTab();
  }, []);

  const handleOpenCapabilities = useCallback(() => {
    void loadAgentCapabilitiesDialog();
    setCapabilitiesOpen(true);
  }, []);

  // Dialog onClose handlers hoisted to stable refs so the memoized dialog
  // components don't see a fresh arrow on every App render.
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);
  const closeCapabilities = useCallback(() => {
    setCapabilitiesOpen(false);
  }, []);
  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);
  const closeFileSearch = useCallback(() => {
    setFileSearchOpen(false);
  }, []);
  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
  }, []);

  // Dialog onSave / onOpenRun / onOpenFile handlers hoisted so the dialogs
  // and search panel keep stable prop identities across App renders.
  const handleSaveSettings = useCallback(
    async (nextSettings: AppSettings) => {
      const saved = await window.spark.settings.save(nextSettings);
      setSettings(saved);
      // The composer's fast-mode toggle reads the same record; republish so it
      // never keeps a value this save just overwrote.
      publishSettings(saved);
      setDefaultShell(resolveDefaultShell(shells, saved, detectedDefaultShell));
    },
    [shells, detectedDefaultShell],
  );

  // ...and the reverse direction: a composer fast-mode flip persists the whole
  // AppSettings record, so App must adopt it or the next Settings save would
  // write back the stale copy it is still holding.
  useEffect(() => onSettingsChanged(setSettings), []);
  // Same reverse direction, one process further out: a paired phone flips fast
  // mode in main, which pushes the saved record here. Feeding it to
  // publishSettings lands it on App and the composer bolt at once.
  useEffect(() => window.spark.settings.onChanged?.(publishSettings), []);
  const handleSettingsOpenRun = useCallback(
    (runId: string, workspaceId: string) => {
      if (workspaces.some((w) => w.id === workspaceId)) {
        setActiveId(workspaceId);
      }
      handleSelectRun(runId, workspaceId);
      setSettingsOpen(false);
    },
    [workspaces, handleSelectRun],
  );

  useEffect(() => {
    window.addEventListener("spark:open-capabilities", handleOpenCapabilities);
    return () => window.removeEventListener("spark:open-capabilities", handleOpenCapabilities);
  }, [handleOpenCapabilities]);

  const updateWs = useCallback((id: string, patch: Partial<Workspace>) => {
    setWorkspaces((ws) => ws.map((w) => {
      if (w.id !== id) return w;
      if (!w.groupId || patch.color === undefined) return { ...w, ...patch };
      const safePatch = { ...patch };
      delete safePatch.color;
      return { ...w, ...safePatch };
    }));
  }, []);

  const moveWs = useCallback((workspaceId: string, groupId: string | null, beforeWorkspaceId: string | null) => {
    setWorkspaces((list) => {
      const sourceIndex = list.findIndex((workspace) => workspace.id === workspaceId);
      if (sourceIndex < 0 || beforeWorkspaceId === workspaceId) return list;
      const source = list[sourceIndex];
      const remaining = list.filter((workspace) => workspace.id !== workspaceId);
      const color = (source.groupId ?? null) === groupId
        ? source.color
        : groupId
          ? source.color
          : pickWorkspaceColor(remaining.map((workspace) => workspace.color), source.cwd);
      const moved: Workspace = groupId
        ? { ...source, groupId, color }
        : (() => {
          const { groupId: _discarded, ...ungrouped } = source;
          return { ...ungrouped, color };
        })();

      let insertAt = beforeWorkspaceId
        ? remaining.findIndex((workspace) => workspace.id === beforeWorkspaceId)
        : -1;
      if (insertAt < 0) {
        let lastInDestination = -1;
        for (let index = 0; index < remaining.length; index += 1) {
          if ((remaining[index].groupId ?? null) === groupId) lastInDestination = index;
        }
        insertAt = lastInDestination >= 0 ? lastInDestination + 1 : remaining.length;
      }
      const next = remaining.slice();
      next.splice(insertAt, 0, moved);
      if (next.length === list.length && next.every((workspace, index) =>
        workspace.id === list[index].id && workspace.groupId === list[index].groupId)) {
        return list;
      }
      const affectedGroups = [source.groupId, groupId]
        .filter((id): id is string => Boolean(id));
      return applyWorkspaceGroupShades(
        next,
        workspaceGroupsRef.current,
        [...new Set(affectedGroups)],
      );
    });
  }, []);

  const createWorkspaceGroup = useCallback(() => {
    const id = makeId("workspace-group");
    setWorkspaceGroups((groups) => {
      const names = new Set(groups.map((group) => group.name.trim().toLocaleLowerCase()));
      let name = "New folder";
      for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix += 1) {
        name = `New folder ${suffix}`;
      }
      const color = pickWorkspaceColor(
        groups.flatMap((group) => group.color ? [group.color] : []),
        id,
      );
      return [...groups, { id, name, collapsed: false, color }];
    });
    return id;
  }, []);

  const updateWorkspaceGroup = useCallback((id: string, patch: Partial<WorkspaceGroup>) => {
    const { color: requestedColor, ...rest } = patch;
    const normalizedColor = requestedColor === undefined
      ? undefined
      : normalizeWorkspaceColor(requestedColor);
    const safePatch: Partial<WorkspaceGroup> = {
      ...rest,
      ...(normalizedColor ? { color: normalizedColor } : {}),
    };
    const nextGroups = workspaceGroupsRef.current.map((group) =>
      group.id === id ? { ...group, ...safePatch } : group);
    setWorkspaceGroups(nextGroups);
    if (normalizedColor) {
      setWorkspaces((items) => applyWorkspaceGroupShades(items, nextGroups, [id]));
    }
  }, []);

  const reorderWorkspaceRailItem = useCallback((id: string, beforeItemId: string | null) => {
    setWorkspaceRailOrder((order) => {
      if (beforeItemId === id) return order;
      const remaining = order.filter((itemId) => itemId !== id);
      const insertAt = beforeItemId ? remaining.indexOf(beforeItemId) : remaining.length;
      if (beforeItemId && insertAt < 0) return order;
      const next = remaining.slice();
      next.splice(insertAt, 0, id);
      return next.length === order.length && next.every((itemId, index) => itemId === order[index])
        ? order
        : next;
    });
  }, []);

  const deleteWorkspaceGroup = useCallback((id: string) => {
    setWorkspaceGroups((groups) => groups.filter((group) => group.id !== id));
    setWorkspaces((items) => {
      const usedColors = items
        .filter((workspace) => workspace.groupId !== id)
        .map((workspace) => workspace.color);
      return items.map((workspace) => {
        if (workspace.groupId !== id) return workspace;
        const { groupId: _discarded, ...ungrouped } = workspace;
        const color = pickWorkspaceColor(usedColors, workspace.cwd);
        usedColors.push(color);
        return { ...ungrouped, color };
      });
    });
  }, []);

  const previewWsColor = useCallback((id: string, color: string) => {
    if (activeIdRef.current !== id) return;
    document.documentElement.style.setProperty("--accent", color);
  }, []);

  const removeWorkspaceFromState = useCallback((id: string) => {
    delete activeRunIdsByWorkspaceRef.current[id];
    if (activeIdRef.current === id) {
      disposeTerminalPanesInTabs(tabsRef.current.tabs);
    } else {
      disposePersistedWorkspaceTerminalPanes(id);
    }
    try {
      window.localStorage.removeItem(`spark.tabs:${id}`);
    } catch {
      /* best-effort cleanup only */
    }
    setWorkspaces((ws) => {
      const removed = ws.find((w) => w.id === id);
      const filtered = ws.filter((w) => w.id !== id);
      const next = removed?.groupId
        ? applyWorkspaceGroupShades(
            filtered,
            workspaceGroupsRef.current,
            [removed.groupId],
          )
        : filtered;
      if (removed) {
        for (const worker of removed.workers) {
          void window.spark.pty.dispose(worker.id);
        }
      }
      setActiveId((prev) => (prev === id ? next[0]?.id ?? null : prev));
      return next;
    });
    setEditingId(null);
  }, []);

  const deleteWs = useCallback(
    (id: string) => {
      const target = workspaces.find((w) => w.id === id);
      // Copy-branch workspaces own a worktree on disk — confirm + remove it
      // rather than orphaning the directory.
      if (target?.copyBranch) {
        setCopyDeleteError(null);
        setPendingCopyDelete(target);
        return;
      }
      removeWorkspaceFromState(id);
    },
    [workspaces, removeWorkspaceFromState],
  );

  const createWs = useCallback(async () => {
    const path = await window.spark.dialog.openDirectory(activeWorkspace?.cwd || home);
    if (!path) return;
    const color = pickWorkspaceColor(workspaces.map((workspace) => workspace.color), path);
    const ws: Workspace = {
      id: makeId("ws"),
      name: basename(path) || "workspace",
      cwd: path,
      color,
      workers: [],
    };
    // Part A — push the new root onto the main read-sandbox allowlist BEFORE we
    // make the workspace active. Otherwise FileTree mounts and fires
    // fs:list / fs:setWatchRoot for the new cwd before the parent effect (~752)
    // gets a chance to re-send the allowed roots — child effects run before
    // parent effects — so those calls throw "Path not allowed" and the watcher
    // is never armed. Awaiting the same setAllowedRoots call the parent effect
    // uses (current workspace cwds + the new one) closes that race. Best-effort:
    // a failure only restricts reads, and the parent effect re-sends anyway.
    const existingCwds = workspaces
      .map((w) => w.cwd)
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    await window.spark.ui?.setAllowedRoots([...existingCwds, ws.cwd]).catch(() => {
      /* sandbox push is best-effort; the parent effect re-sends on state change */
    });
    setWorkspaces((list) => [...list, ws]);
    activeRunIdsByWorkspaceRef.current[ws.id] = null;
    setActiveId(ws.id);
    setEditingId(ws.id);
  }, [workspaces, activeWorkspace, home]);

  // Attach a local folder outside the workspace cwd as an extra Explorer root
  // (e.g. a OneDrive clients folder). The picker is always the local OS
  // dialog, so this works for remote workspaces too.
  const addExternalFolder = useCallback(async () => {
    if (!activeWorkspace) return;
    const path = await window.spark.dialog.openDirectory(activeWorkspace.cwd || home);
    if (!path) return;
    const current = activeWorkspace.extraFolders ?? [];
    if (path === activeWorkspace.cwd || current.includes(path)) return;
    // Same race-avoidance as createWs above: the external FileTree mounts as
    // soon as state updates and immediately calls fs:list / fs:addWatchRoot,
    // before the parent setAllowedRoots effect re-fires — push the new root
    // onto the sandbox allowlist first.
    const existingRoots = workspaces
      .flatMap((w) => [w.cwd, ...(w.extraFolders ?? [])])
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    await window.spark.ui?.setAllowedRoots([...existingRoots, path]).catch(() => {
      /* sandbox push is best-effort; the parent effect re-sends on state change */
    });
    updateWs(activeWorkspace.id, { extraFolders: [...current, path] });
  }, [activeWorkspace, workspaces, home, updateWs]);

  // Detach an external folder from a workspace. Reference removal only —
  // nothing on disk is touched, and the sandbox allowlist shrinks on the next
  // natural setAllowedRoots push driven by the state change.
  const removeExternalFolder = useCallback((workspaceId: string, folderPath: string) => {
    setWorkspaces((list) =>
      list.map((w) =>
        w.id === workspaceId
          ? { ...w, extraFolders: (w.extraFolders ?? []).filter((f) => f !== folderPath) }
          : w,
      ),
    );
  }, []);

  // SSH remote workspace: the connect dialog resolves a host + POSIX folder,
  // and we mint a workspace whose cwd is the ssh:// virtual path. The main
  // process routes every fs/git/pty/search call on that prefix.
  const createRemoteWs = useCallback(
    async (host: RemoteHostConfig, remotePath: string) => {
      const cwd = makeRemotePath(host.id, remotePath);
      const color = pickWorkspaceColor(workspaces.map((workspace) => workspace.color), cwd);
      const ws: Workspace = {
        id: makeId("ws"),
        name: basename(remotePath) || host.id,
        cwd,
        color,
        workers: [],
        remote: { hostId: host.id },
      };
      const existingCwds = workspaces
        .map((w) => w.cwd)
        .filter((c): c is string => typeof c === "string" && c.length > 0);
      await window.spark.ui?.setAllowedRoots([...existingCwds, ws.cwd]).catch(() => undefined);
      setWorkspaces((list) => [...list, ws]);
      activeRunIdsByWorkspaceRef.current[ws.id] = null;
      setActiveId(ws.id);
      setRemoteConnectOpen(false);
    },
    [workspaces],
  );

  const createCopyBranchWs = useCallback(
    async (
      sourceWs: Workspace,
      opts?: {
        newBranch?: string;
        checkoutBranch?: string;
        checkoutIsRemote?: boolean;
        /** Issue provisioning stays on the source workspace until Cora starts. */
        activate?: boolean;
        /** Issue provisioning gives setup to Cora as an awaited first step. */
        launchSetupTerminal?: boolean;
      },
    ): Promise<Workspace> => {
      setCreateCopyBusy(true);
      setCreateCopyError(null);
      try {
        const activate = opts?.activate !== false;
        const launchSetupTerminal = opts?.launchSetupTerminal !== false;
        const worktreeOptions = opts
          ? {
              ...(opts.newBranch ? { newBranch: opts.newBranch } : {}),
              ...(opts.checkoutBranch ? { checkoutBranch: opts.checkoutBranch } : {}),
              ...(opts.checkoutIsRemote !== undefined
                ? { checkoutIsRemote: opts.checkoutIsRemote }
                : {}),
            }
          : undefined;
        const res = await window.spark.git.createCopyWorktree(
          sourceWs.cwd,
          worktreeOptions,
        );
        if (!res.ok) throw new Error(res.error);

        const list = workspacesRef.current;
        const group = sourceWs.groupId
          ? workspaceGroupsRef.current.find((candidate) => candidate.id === sourceWs.groupId)
          : null;
        const color = group?.color ?? pickWorkspaceColor(
          list.map((workspace) => workspace.color),
          res.path,
        );

        const ws: Workspace = {
          id: makeId("ws"),
          // The branch is always user-meaningful now (picked or typed), so it
          // names the workspace in both modes.
          name: res.branch,
          cwd: res.path,
          // A copy stays in its parent's folder family, but gets its own shade
          // so adjacent branches remain individually recognizable.
          color,
          workers: [],
          ...(sourceWs.groupId ? { groupId: sourceWs.groupId } : {}),
          copyBranch: {
            repoCwd: sourceWs.cwd,
            branch: res.branch,
            ...(res.baseBranch ? { baseBranch: res.baseBranch } : {}),
            city: res.city,
            mode: res.mode,
            createdAt: new Date().toISOString(),
            fileCount: res.fileCount,
          },
        };

        // Same Part A race as createWs: push the worktree path onto the main
        // read-sandbox allowlist BEFORE the workspace exists in state. The rail's
        // missing-folder probe (fs:pathExists) and FileTree's fs:list fire from
        // child effects ahead of the parent setAllowedRoots effect, and a
        // sandbox-denied probe reports exists:false — striking the brand-new
        // copy through as "folder not found" until the next re-check.
        const existingCwds = list
          .map((w) => w.cwd)
          .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
        await window.spark.ui?.setAllowedRoots([...existingCwds, res.path]).catch(() => {
          /* sandbox push is best-effort; the parent effect re-sends on state change */
        });

        // Insert directly below the source workspace (and any existing copy
        // branches of it) so it reads as an indented child of its parent.
        const nextWorkspaces = list.slice();
        const parentIdx = list.findIndex((w) => w.id === sourceWs.id);
        if (parentIdx === -1) {
          nextWorkspaces.push(ws);
        } else {
          let insertAt = parentIdx + 1;
          while (
            insertAt < list.length &&
            list[insertAt].copyBranch?.repoCwd === sourceWs.cwd
          ) {
            insertAt += 1;
          }
          nextWorkspaces.splice(insertAt, 0, ws);
        }
        const coloredNextWorkspaces = group
          ? applyWorkspaceGroupShades(
              nextWorkspaces,
              workspaceGroupsRef.current,
              [group.id],
            )
          : nextWorkspaces;
        const persistedWorkspace = coloredNextWorkspaces.find((item) => item.id === ws.id) ?? ws;
        const nextRailOrder = normalizedWorkspaceRailOrder(
          workspaceRailOrderRef.current,
          coloredNextWorkspaces,
          workspaceGroupsRef.current,
        );
        const previousActiveId = activeIdRef.current;
        const previousState: AppState = {
          workspaces: list,
          workspaceGroups: workspaceGroupsRef.current,
          workspaceRailOrder: workspaceRailOrderRef.current,
          activeWorkspaceId: previousActiveId,
        };
        const nextState: AppState = {
          workspaces: coloredNextWorkspaces,
          workspaceGroups: workspaceGroupsRef.current,
          workspaceRailOrder: nextRailOrder,
          activeWorkspaceId: activate ? ws.id : previousActiveId,
        };

        // Durability is phase one. Do not publish refs, React state, or active
        // selection until the exact snapshot is on disk; a failed save leaves
        // the source issue row mounted and makes cleanup invisible to no one.
        if (saveTimer.current !== null) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        try {
          await window.spark.state.save(nextState);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          let cleanupSucceeded = false;
          let cleanupDetail = "";
          try {
            const cleanup = await window.spark.git.removeCopyWorktree({
              repoCwd: sourceWs.cwd,
              worktreePath: res.path,
              branch: res.branch,
              force: true,
              // Fork mode created this branch in the failed transaction.
              // Checkout mode may point at a user's pre-existing branch.
              deleteBranch: res.mode === "fork",
            });
            if (cleanup.ok) {
              cleanupSucceeded = true;
            } else {
              const pathState = await window.spark.fs.pathExists({
                target: res.path,
              });
              if (!pathState.exists && res.mode === "fork") {
                // removeCopyWorktree can remove the directory successfully and
                // then report failure because its safe `branch -d` refused.
                // No setup or Cora work has run yet, so this transaction-owned
                // branch is safe to force-delete.
                const branchCleanup = await window.spark.git.deleteBranch(
                  sourceWs.cwd,
                  res.branch,
                  true,
                );
                if (branchCleanup.ok) {
                  cleanupSucceeded = true;
                } else {
                  const branches = await window.spark.git
                    .branches(sourceWs.cwd)
                    .catch(() => null);
                  const branchStillExists =
                    branches?.isRepo === true &&
                    !branches.error
                      ? branches.local.some((branch) => branch.name === res.branch)
                      : null;
                  if (branchStillExists === false) {
                    cleanupSucceeded = true;
                  } else {
                    cleanupDetail =
                      `The worktree directory was removed, but branch '${res.branch}' remains: ` +
                      `${branchCleanup.error} Delete that branch manually before retrying.`;
                  }
                }
              } else if (!pathState.exists) {
                cleanupSucceeded = true;
              } else {
                cleanupDetail =
                  `Automatic cleanup failed: ${cleanup.error} ` +
                  `Recover or remove the worktree at '${res.path}' ` +
                  `(branch '${res.branch}') before retrying.`;
              }
            }
          } catch (cleanupCause) {
            const cleanupReason =
              cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause);
            const pathState = await window.spark.fs
              .pathExists({ target: res.path })
              .catch(() => ({ exists: true }));
            cleanupDetail = pathState.exists
              ? `Automatic cleanup failed: ${cleanupReason} Recover or remove the worktree ` +
                `at '${res.path}' (branch '${res.branch}') before retrying.`
              : `The worktree directory was removed, but cleanup could not confirm branch ` +
                `'${res.branch}' was removed: ${cleanupReason}`;
          }

          // The failed next snapshot never published, but an older debounced
          // state save may have been cancelled above. Re-persist that exact
          // previous snapshot and shrink the read allowlist either way.
          await window.spark.state.save(previousState).catch(() => undefined);
          const rootsRestored = await window.spark.ui
            ?.setAllowedRoots(existingCwds)
            .then(() => true)
            .catch(() => false);
          const cleanupSummary = cleanupSucceeded
            ? "The incomplete worktree was removed."
            : cleanupDetail;
          const rootsSummary =
            rootsRestored === false
              ? " Codara could not restore the filesystem allowlist; restart Studio before retrying."
              : "";
          throw new Error(
            `The isolated workspace was created, but Codara could not persist it: ${reason} ` +
              `${cleanupSummary}${rootsSummary}`,
          );
        }

        // Publication is phase two. The issue path publishes the durable
        // workspace in the rail but deliberately keeps the source active until
        // startAutopilot succeeds, so any failure remains visible in its row.
        if (activate && previousActiveId) {
          activeRunIdsByWorkspaceRef.current[previousActiveId] = activeRunIdRef.current;
        }
        workspacesRef.current = coloredNextWorkspaces;
        workspaceRailOrderRef.current = nextRailOrder;
        activeRunIdsByWorkspaceRef.current[ws.id] = null;
        setWorkspaces(coloredNextWorkspaces);
        setWorkspaceRailOrder(nextRailOrder);
        if (activate) {
          activeIdRef.current = ws.id;
          setActiveId(ws.id);
        }

        setCreateCopyDialogWs(null);
        // Run the per-repo setup command live in a terminal in the new worktree.
        // Default is empty (opt-in) — nothing runs unless this repo has one set.
        if (launchSetupTerminal) {
          void window.spark.preferences.load().then((prefs) => {
            const cmd = (
              prefs.copyBranchSetupCommandByRepo?.[sourceWs.cwd] ??
              DEFAULT_COPY_BRANCH_SETUP_COMMAND
            ).trim();
            if (cmd) newTerminalTab(res.path, cmd);
          }).catch(() => undefined);
        }
        return persistedWorkspace;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // Surfaced inline by CreateCopyDialog or the GitHub issue row.
        setCreateCopyError(error.message);
        throw error;
      } finally {
        setCreateCopyBusy(false);
      }
    },
    [newTerminalTab],
  );

  const handleStartGitHubIssue = useCallback(
    async (sourceWs: Workspace, issue: GitHubIssueSummary): Promise<void> => {
      if (sourceWs.remote) {
        throw new Error(
          "GitHub issue workspaces require a local Git checkout; SSH workspaces are not supported yet.",
        );
      }
      // Cancel a pending renderer snapshot before the main-owned atomic
      // transaction changes workspace state. Its state:changed broadcast will
      // repopulate React and schedule a fresh save with the authoritative row.
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const result = await window.spark.github.startIssue({
        sourceWorkspaceId: sourceWs.id,
        issueNumber: issue.number,
      });
      if (!result.ok) throw new Error(result.message);
      const run = await window.spark.orchestration.getRun(result.runId);
      if (!run) {
        throw new Error(
          `The issue workspace started, but Cora run ${result.runId} could not be loaded.`,
        );
      }
      if (run.workspaceId !== result.workspaceId) {
        throw new Error(
          "The issue workspace started, but its Cora run was linked to a different workspace.",
        );
      }
      handleActivateWorkspace(result.workspaceId);
      handleRunSnapshot(run, { select: true, focusRuns: true });
    },
    [handleActivateWorkspace, handleRunSnapshot],
  );

  const handleStartGitHubPullRequest = useCallback(
    async (
      item: Extract<GitHubWorkQueueItem, { kind: "pull-request" }>,
    ): Promise<void> => {
      const expectedHeadCommitOid =
        item.pullRequest.headCommitOid?.trim().toLowerCase() ?? "";
      if (!EXACT_GIT_OBJECT_ID.test(expectedHeadCommitOid)) {
        throw new Error(
          "GitHub did not provide an exact pull-request revision. Refresh the queue and try again.",
        );
      }
      const source = workspacesRef.current.find(
        (workspace) => workspace.id === item.sourceWorkspaceId,
      );
      if (!source) {
        throw new Error(
          "The source workspace changed. Refresh the GitHub work queue.",
        );
      }
      if (source.remote) {
        throw new Error(
          "Pull-request workspaces require a local Git checkout; SSH workspaces are not supported yet.",
        );
      }
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const result = await window.spark.github.startPullRequest({
        sourceWorkspaceId: item.sourceWorkspaceId,
        repositoryUrl: item.repositoryUrl,
        pullRequestNumber: item.pullRequest.number,
        expectedHeadCommitOid,
      });
      if (!result.ok) throw new Error(result.message);
      const run = await window.spark.orchestration.getRun(result.runId);
      if (!run) {
        throw new Error(
          `The pull-request workspace started, but Cora run ${result.runId} could not be loaded.`,
        );
      }
      if (run.workspaceId !== result.workspaceId) {
        throw new Error(
          "The pull-request workspace started, but its Cora run was linked to a different workspace.",
        );
      }
      handleActivateWorkspace(result.workspaceId);
      handleRunSnapshot(run, { select: true, focusRuns: true });
    },
    [handleActivateWorkspace, handleRunSnapshot],
  );

  const handleOpenGitHubQueueItem = useCallback(
    async (item: GitHubWorkQueueItem): Promise<void> => {
      const link = item.link;
      if (
        link?.run &&
        workspacesRef.current.some(
          (workspace) => workspace.id === link.workspaceId,
        )
      ) {
        const run = await window.spark.orchestration.getRun(link.run.runId);
        if (!run || run.workspaceId !== link.workspaceId) {
          throw new Error(
            "This linked Cora run changed. Refresh the GitHub work queue.",
          );
        }
        handleActivateWorkspace(link.workspaceId);
        handleRunSnapshot(run, { select: true, focusRuns: true });
        return;
      }
      if (
        link?.matchCount === 1 &&
        workspacesRef.current.some(
          (workspace) => workspace.id === link.workspaceId,
        )
      ) {
        handleActivateWorkspace(link.workspaceId);
        return;
      }

      if (item.kind === "issue" && !link) {
        const source = workspacesRef.current.find(
          (workspace) => workspace.id === item.sourceWorkspaceId,
        );
        if (!source) {
          throw new Error(
            "The source workspace changed. Refresh the GitHub work queue.",
          );
        }
        await handleStartGitHubIssue(source, item.issue);
        return;
      }

      if (
        item.kind === "pull-request" &&
        !link &&
        EXACT_GIT_OBJECT_ID.test(
          item.pullRequest.headCommitOid?.trim() ?? "",
        )
      ) {
        await handleStartGitHubPullRequest(item);
        return;
      }

      const url =
        item.kind === "issue" ? item.issue.url : item.pullRequest.url;
      await window.spark.openExternal(url);
    },
    [
      handleActivateWorkspace,
      handleRunSnapshot,
      handleStartGitHubIssue,
      handleStartGitHubPullRequest,
    ],
  );

  const handleCreateCopyBranch = useCallback(
    (id: string) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws) {
        setCreateCopyError(null);
        setCreateCopyDialogWs(ws);
      }
    },
    [workspaces],
  );

  // Stable identity: an inline arrow here would defeat WorkspaceRail's
  // React.memo on both rails.
  const handleCreateRemote = useCallback(() => setRemoteConnectOpen(true), []);

  const confirmCopyDelete = useCallback(
    async (opts: { deleteBranch: boolean; force: boolean }) => {
      const target = pendingCopyDelete;
      if (!target?.copyBranch) return;
      setCopyDeleteBusy(true);
      setCopyDeleteError(null);
      const result = await window.spark.git.removeCopyWorktree({
        repoCwd: target.copyBranch.repoCwd,
        worktreePath: target.cwd,
        branch: target.copyBranch.branch,
        force: opts.force,
        deleteBranch: opts.deleteBranch,
      });
      setCopyDeleteBusy(false);
      if (!result.ok) {
        setCopyDeleteError(result.error);
        return;
      }
      removeWorkspaceFromState(target.id);
      setPendingCopyDelete(null);
    },
    [pendingCopyDelete, removeWorkspaceFromState],
  );

  // ── File / editor tab integration ──────────────────────────────────────────

  const openEditorFile = useCallback(
    (entry: FsEntry, options?: { preview?: boolean }) => {
      openEditorTab(entry, options);
    },
    [openEditorTab],
  );

  // File/search panels: open the picked file then dismiss the panel.
  // Hoisted to keep panel prop identities stable across App renders.
  const handleSearchOpenFile = useCallback(
    (entry: FsEntry) => {
      openEditorFile(entry);
      setSearchOpen(false);
      setFileSearchOpen(false);
    },
    [openEditorFile],
  );

  // Explorer prop callbacks. Hoisted to stable references (keyed on the
  // hook-lifetime-stable tab methods) so the memoized side panels can skip
  // re-renders when only unrelated App state changed.
  const handleDeleteFile = useCallback(
    (path: string) => {
      closeEditorByPath(path);
    },
    [closeEditorByPath],
  );

  const handleRenameFile = useCallback(
    (oldPath: string, entry: FsEntry) => {
      setEditorEntry(oldPath, entry);
    },
    [setEditorEntry],
  );

  // Right-click "Run plan" in the explorer: read the file and hand it to the
  // orchestrator as the plan for a brand-new chat, then select that chat so
  // its conversation and node-graph tab come forward.
  const handleRunPlan = useCallback(
    async (entry: FsEntry, backend?: ChatBackendKind) => {
      const ws = activeWorkspace;
      if (!ws) return;
      try {
        const file = await window.spark.fs.readText(entry.path);
        const run = await window.spark.orchestration.startAutopilot({
          workspaceId: ws.id,
          workspaceName: ws.name,
          cwd: ws.cwd,
          planPath: entry.path,
          planTitle: entry.name,
          planText: file.content,
          // Engine picked from the explorer's Run plan flyout. Undefined is
          // normalized to the bundled Cora · Pi route by createRun.
          chatBackend: backend,
        });
        // Bind the selection to the originating workspace: the user may have
        // switched away during the startAutopilot await.
        handleSelectRun(run.id, ws.id);
        void refreshRunsFor(ws.id);
      } catch (err) {
        // A pre-run failure here is rare (the file vanished between the
        // right-click and the read); planning failures instead surface on
        // the run itself as a failed status with events in the chat.
        console.error("Run plan failed:", err);
      }
    },
    [activeWorkspace, refreshRunsFor, handleSelectRun],
  );

  // Open a file by absolute path. Used by the terminal's OSC 8888 handler
  // (`tp <file>` / `spark_open <file>` from a shell) and the Source Control
  // panel's "open file" action. Reads `tabs` via the ref so the callback stays
  // referentially stable — WorkspaceRail's React.memo depends on it.
  const openFileByPath = useCallback((path: string) => {
    if (!path) return;
    tabsRef.current.openEditorTab(entryFromPath(path));
  }, []);

  // Open a changed file's diff as a workbench tab (Source Control row click).
  const handleOpenDiffTab = useCallback((file: GitFileChange) => {
    tabsRef.current.openDiffTab(file.path, file.staged);
  }, []);

  // Explorer "Open Changes": absolute path → repo-relative (forward slashes),
  // always the working-tree (unstaged) diff — matching VS Code's entry point.
  const activeCwdRef = useRef<string | null>(activeWorkspace?.cwd ?? null);
  activeCwdRef.current = activeWorkspace?.cwd ?? null;
  const handleOpenDiffForPath = useCallback((absolutePath: string) => {
    const cwd = activeCwdRef.current;
    if (!cwd || !absolutePath) return;
    const base = cwd.replace(/[\\/]+$/, "");
    let rel = absolutePath;
    if (absolutePath.toLowerCase().startsWith(base.toLowerCase())) {
      rel = absolutePath.slice(base.length).replace(/^[\\/]+/, "");
    }
    tabsRef.current.openDiffTab(rel.replace(/\\/g, "/"), false);
  }, []);

  // Result cards use window events so the deeply nested chat renderer stays
  // reusable and does not need the entire tabs API threaded through it.
  useEffect(() => {
    const openFile = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) openFileByPath(path);
    };
    const openDiff = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) handleOpenDiffForPath(path);
    };
    window.addEventListener("spark:open-file", openFile);
    window.addEventListener("spark:open-diff", openDiff);
    return () => {
      window.removeEventListener("spark:open-file", openFile);
      window.removeEventListener("spark:open-diff", openDiff);
    };
  }, [handleOpenDiffForPath, openFileByPath]);

  // Which diff tab is focused — highlights its ChangeRow in the git panel.
  const activeDiffTarget = useMemo(
    () =>
      tabs.activeTab?.kind === "diff"
        ? { path: tabs.activeTab.path, staged: tabs.activeTab.staged }
        : null,
    [tabs.activeTab],
  );

  // ── Detected URL → preview tab ─────────────────────────────────────────────

  // Ports we auto-spawn a preview tab for when a terminal sniffs the URL on
  // its stdout. Anything else just shows the detected-URL chip in the
  // status bar (or the user can open via the Ports preset dropdown).
  const AUTO_PREVIEW_PORTS = useMemo(
    () => new Set([3000, 3001, 4173, 4200, 4321, 5173, 5174, 6006, 8000, 8080, 8888]),
    [],
  );

  // Per-terminal-tab "last URL we already opened" cache so a chatty dev
  // server printing its URL on every change doesn't spam preview tabs.
  const lastOpenedUrlByTerminalRef = useRef<Map<string, string>>(new Map());

  const handleDetectedUrl = useCallback(
    (tabId: string, paneId: string, url: string, meta?: { replayed?: boolean }) => {
      setDetectedUrl(tabId, paneId, url);
      // Re-broadcast so other listeners (status bar, agent bridge) can
      // react without coupling directly to the terminal stack.
      window.dispatchEvent(
        new CustomEvent("spark:detected-url", {
          detail: { url, sessionId: paneId },
        }),
      );

      let port: number | null = null;
      try {
        const u = new URL(url);
        if (u.port) port = Number(u.port);
      } catch {
        return;
      }
      if (port === null || !AUTO_PREVIEW_PORTS.has(port)) return;

      // Replayed history is not an event. Main re-sends a pane's buffered
      // output verbatim down the live data channel after a lock/sleep (and as
      // the raw-tail frame on reattach), so a `Local: http://localhost:3000`
      // line a dev server printed before the laptop slept arrives again on
      // wake looking exactly like a server that just came up. The chip above
      // still updates — the URL is real and clickable — but a replay must
      // never spawn a tab on its own. Genuinely-live output is unaffected.
      if (meta?.replayed === true) return;

      // Part C — auto-open is opt-in. When the user hasn't enabled it, stop
      // here: the detected-URL chip above already ran (setDetectedUrl +
      // broadcast), so the user can click to open the preview, but Codara never
      // yanks a preview tab open on its own.
      if (preferencesRef.current.autoOpenPreview !== true) return;

      // Belt-and-suspenders (Part C3): never auto-open from an agent/worker
      // pane, even with the pref on — an agent's own dev server must not spawn a
      // preview. A pane is "agent-owned" if its tab is a Cora workers-scoped
      // terminal tab OR the source leaf currently hosts a worker chip (manual
      // claude/codex panes are exactly this case). Those still get the click-to-
      // open chip; they just never auto-open.
      const sourceTab = tabs.tabs.find((t) => t.id === tabId);
      const isWorkerScopedTab =
        sourceTab?.kind === "terminal" && sourceTab.scope?.kind === "workers";
      const sourceLeaf =
        sourceTab?.kind === "terminal"
          ? findLeafByPaneId(sourceTab.root, paneId)
          : null;
      if (isWorkerScopedTab || sourceLeaf?.worker) return;

      // Suppress repeats for this pane pointing at the same origin — keyed
      // by paneId, not tabId, so two split panes running different dev
      // servers each get their own auto-preview.
      const last = lastOpenedUrlByTerminalRef.current.get(paneId);
      if (last && sameOrigin(last, url)) return;

      // If a preview tab already shows the same origin, do nothing — it's
      // already in the strip. A passive stdout sniff must never reassign the
      // active tab, or a dev server printing its URL would yank the user off
      // their chat onto the browser (and hide the composer).
      const existing = tabs.tabs.find(
        (t) => t.kind === "preview" && sameOrigin(t.url, url),
      );
      if (existing) {
        // Still counts as handled for this pane: closing that preview is a
        // deliberate "I don't want this", and the next line the same dev server
        // prints must not undo it.
        lastOpenedUrlByTerminalRef.current.set(paneId, url);
        return;
      }
      // Inherit the worker's runId so the chat panel can render this preview
      // inside its inner tab strip; URLs detected on a plain (non-worker)
      // terminal stay top-level by leaving runId undefined. (Worker panes are
      // excluded above, so ownerRunId is always null here today — kept for the
      // shape the chat panel expects.)
      const ownerRunId =
        sourceTab?.kind === "terminal" && sourceTab.scope?.kind === "workers"
          ? sourceTab.scope.runId
          : null;

      // Last gate: is anything actually listening there? The replay guard above
      // covers history main re-sent, but not history a process reprints as its
      // own fresh output — a resumed `claude --resume` replaying a transcript
      // that quotes a dev-server URL is indistinguishable from a live banner at
      // the byte level. A blank tab pointed at a dead port is the exact symptom
      // either way, so probe the port (main retries briefly, so a server that
      // printed its banner a moment ago still passes) and only then mint a tab.
      void window.spark.preview
        .probeLocalServer(url)
        .then((reachable) => {
          if (!reachable) return;
          // Re-run both dedupes against post-await state: the probe takes up to
          // a second, in which the user (or another pane) may have opened this
          // origin. Suppression is recorded only where a tab exists — a probe
          // that came back dead leaves the pane free to auto-open later, when
          // the server the user is about to start actually answers.
          const alreadyOpen = tabsRef.current.tabs.some(
            (t) => t.kind === "preview" && sameOrigin(t.url, url),
          );
          const prior = lastOpenedUrlByTerminalRef.current.get(paneId);
          if (alreadyOpen || (prior && sameOrigin(prior, url))) {
            lastOpenedUrlByTerminalRef.current.set(paneId, url);
            return;
          }
          lastOpenedUrlByTerminalRef.current.set(paneId, url);
          // focus:false — an auto-detected preview opens in the background so it
          // doesn't steal the active tab from a chat the user is working in.
          newPreviewTab(url, { runId: ownerRunId, focus: false });
        })
        .catch(() => undefined);
    },
    // tabs.tabs is real data read above (worker-pane and existing-preview
    // checks), so it stays a dep; the method references are stable.
    [AUTO_PREVIEW_PORTS, setDetectedUrl, newPreviewTab, tabs.tabs],
  );

  // ── Tab toolbar handlers ───────────────────────────────────────────────────

  const handleNewTerminalTab = useCallback(() => {
    tabs.newTerminalTab(activeWorkspace?.cwd ?? undefined);
  }, [tabs, activeWorkspace?.cwd]);

  const handleNewBalancedTerminalPane = useCallback(() => {
    const active = tabs.tabs.find((t) => t.id === tabs.activeId);
    const target =
      active?.kind === "terminal"
        ? active
        : // Exclude run-scoped worker tabs: they're hidden unless their run is
          // active, so adding a user pane there would strand it and bounce the
          // active tab off the chat.
          tabs.tabs.find((t) => t.kind === "terminal" && t.scope?.kind !== "workers");
    if (!target || target.kind !== "terminal") {
      tabs.newTerminalTab(activeWorkspace?.cwd ?? undefined);
      return;
    }

    const paneId = makeId("pane");
    const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
    const cwd =
      paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
      activeLeaf?.cwd ??
      activeWorkspace?.cwd ??
      undefined;
    const added = tabs.addBalancedPaneToTab(target.id, paneId, { cwd });
    if (added) {
      tabs.setActiveTab(target.id);
      tabs.setActiveTerminalPane(target.id, paneId);
      return;
    }

    tabs.newTerminalTab(cwd);
  }, [tabs, activeWorkspace?.cwd]);

  // Add a terminal pane that auto-launches the given CLI worker once the
  // shell prompt is ready. Worker keybinds should keep the user's current
  // terminal tab together instead of creating a separate terminal tab.
  //
  // If the active terminal tab's focused pane is "unused" — no worker has
  // ever attached to it AND the user hasn't typed anything in it — we take
  // it over by injecting the launch command into the existing PTY instead
  // of splitting next to it. This matches the natural mental model: a fresh
  // shell prompt is a place to run things, so the keybind runs the worker
  // there. Touched panes (active build output, half-typed command) still
  // get a fresh sibling pane so the user's work isn't disturbed.
  // Interactive worker panes launch exactly the command shown in the UI. The
  // agent-state hook discovers Claude/Codex session ids after startup and then
  // persists the resume pointer; a user-created pane must not silently change
  // `claude --dangerously-skip-permissions` by appending a forced session id.
  const prepareWorkerLaunch = useCallback(
    (autorun: string, session?: TerminalAgentSession | null) => {
      return {
        command: autorun,
        makeSession: (_cwd: string | undefined): TerminalAgentSession | null => session ?? null,
      };
    },
    [],
  );

  const handleNewWorkerTab = useCallback(
    (
      autorun: string,
      options?: { cwd?: string; session?: TerminalAgentSession | null },
    ) => {
      const { command: launchCommand, makeSession } = prepareWorkerLaunch(
        autorun,
        options?.session,
      );
      const launchRuntime =
        options?.session?.runtime ?? runtimeFromAgentSessionLaunchCommand(launchCommand);
      const active = tabs.tabs.find((t) => t.id === tabs.activeId);
      const target =
        active?.kind === "terminal"
          ? active
          : // Skip run-scoped worker tabs (hidden unless their run is active)
            // so the worker pane lands in a visible top-strip terminal.
            tabs.tabs.find((t) => t.kind === "terminal" && t.scope?.kind !== "workers");
      if (!target || target.kind !== "terminal") {
        const seedCwd = options?.cwd ?? activeWorkspace?.cwd ?? undefined;
        tabs.newTerminalTab(seedCwd, launchCommand, {
          agentSession: makeSession(seedCwd),
          manualAgentRuntime: launchRuntime ?? undefined,
        });
        return;
      }

      const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
      const paneRuntime = paneRuntimeRef.current.get(target.activePaneId);
      const currentCwd = paneRuntime?.cwd ?? activeLeaf?.cwd ?? activeWorkspace?.cwd ?? undefined;
      // Three independent "this pane is in use" signals, any of which is
      // enough to skip the inject and split a fresh pane instead:
      //   - leaf.worker:        banner-based agent detection fired
      //   - leaf.autorun:       the leaf was originally spawned with one
      //   - userInputAt:        the user has typed at least one keystroke
      //   - altScreenActive:    a TUI is in the foreground (Ink / vim / less)
      // The alt-screen signal is the safety net for the case the user
      // hit: a Claude session whose banner regex didn't match, where
      // banner-only checks would mis-classify the pane as fresh and the
      // launch command would land inside the running TUI's input box.
      const isUnusedPane =
        activeLeaf !== null &&
        !activeLeaf.worker &&
        !activeLeaf.autorun &&
        !paneRuntime?.userInputAt &&
        !paneRuntime?.altScreenActive &&
        (!options?.cwd || currentCwd === options.cwd);
      if (isUnusedPane) {
        tabs.setActiveTab(target.id);
        tabs.setActiveTerminalPane(target.id, target.activePaneId);
        // Record the resume pointer on the reused pane before launching, so a
        // reopen can `--resume` this exact session. Runtime discovery fills
        // the pointer after the CLI starts.
        const injectCwd = options?.cwd ?? currentCwd;
        const injectSession = makeSession(injectCwd);
        if (launchRuntime) {
          tabs.setLeafWorker(
            target.id,
            target.activePaneId,
            createManualAgentLaunchWorker(launchRuntime, target.activePaneId),
          );
        }
        if (injectSession) {
          tabs.setLeafAgentSession(target.id, target.activePaneId, injectSession);
        }
        // Inject as a bracketed paste + submit so the existing pwsh/bash/zsh
        // prompt receives the autorun as if the user had typed it. pty.inject
        // is async but fire-and-forget is fine — failures (pane disposed,
        // PTY exited) just mean nothing runs, which is recoverable by
        // pressing the keybind again.
        void window.spark.pty.inject(target.activePaneId, launchCommand, { submit: true });
        return;
      }

      const paneId = makeId("pane");
      const cwd = options?.cwd ?? currentCwd;
      const added = tabs.addPaneInTab(target.id, paneId, {
        cwd,
        autorun: launchCommand,
        agentSession: makeSession(cwd),
        worker: launchRuntime
          ? createManualAgentLaunchWorker(launchRuntime, paneId)
          : undefined,
      });
      if (added) {
        tabs.setActiveTab(target.id);
        tabs.setActiveTerminalPane(target.id, paneId);
        return;
      }

      tabs.newTerminalTab(cwd, launchCommand, {
        agentSession: makeSession(cwd),
        manualAgentRuntime: launchRuntime ?? undefined,
      });
    },
    [tabs, activeWorkspace?.cwd, prepareWorkerLaunch],
  );

  const resolveWorkerLaunchCwd = useCallback((): string | null => {
    const current = tabsRef.current;
    const active = current.tabs.find((tab) => tab.id === current.activeId);
    const target =
      active?.kind === "terminal"
        ? active
        : current.tabs.find((tab) => tab.kind === "terminal" && tab.scope?.kind !== "workers");
    if (target?.kind === "terminal") {
      const leaf = findLeafByPaneId(target.root, target.activePaneId);
      return (
        paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
        leaf?.cwd ??
        activeWorkspace?.cwd ??
        null
      );
    }
    return activeWorkspace?.cwd ?? null;
  }, [activeWorkspace?.cwd]);

  const openShortcutWorkerSessions = useCallback(
    (runtime: WorkerSessionRuntime) => {
      const cwd = resolveWorkerLaunchCwd();
      const freshCommand =
        runtime === "claude" ? CLAUDE_LAUNCH_COMMAND : CODEX_LAUNCH_COMMAND;
      if (!cwd) {
        handleNewWorkerTab(freshCommand);
        return;
      }
      setWorkerSessionPicker({
        runtime,
        cwd,
        launch: (command, session) => handleNewWorkerTab(command, { cwd, session }),
      });
    },
    [handleNewWorkerTab, resolveWorkerLaunchCwd],
  );

  // Bound per-runtime so the tab strip's "+" rows get referentially stable
  // callbacks (TabBar is memoized). Both land on the same picker the
  // worker.newClaude / worker.newCodex commands open.
  const openClaudeWorkerSessions = useCallback(
    () => openShortcutWorkerSessions("claude"),
    [openShortcutWorkerSessions],
  );
  const openCodexWorkerSessions = useCallback(
    () => openShortcutWorkerSessions("codex"),
    [openShortcutWorkerSessions],
  );
  const openPaneWorkerSessions = useCallback(
    (
      runtime: WorkerSessionRuntime,
      cwd: string | undefined,
      launch: WorkerSessionPickerRequest["launch"],
    ) => {
      if (!cwd) {
        launch(runtime === "claude" ? CLAUDE_LAUNCH_COMMAND : CODEX_LAUNCH_COMMAND, null);
        return;
      }
      setWorkerSessionPicker({ runtime, cwd, launch });
    },
    [],
  );

  const pendingSettingsSessionLaunchRef = useRef<{
    workspaceId: string;
    runtime: WorkerSessionRuntime;
    cwd: string;
    session: WorkerSessionSummary | null;
  } | null>(null);

  const launchSettingsSession = useCallback(
    async (request: {
      runtime: WorkerSessionRuntime;
      cwd: string;
      session: WorkerSessionSummary | null;
    }) => {
      if (request.runtime === "codex") {
        await window.spark.agentSession
          .ensureCodexTrust(
            request.cwd,
            request.session?.nativeCodexProfileId,
          )
          .catch(() => undefined);
      }
      const pointer: TerminalAgentSession | null = request.session
        ? {
            runtime: request.runtime,
            nativeCodexProfileId:
              request.session.nativeCodexProfileId,
            sessionId: request.session.sessionId,
            cwd: request.cwd,
            transcriptPath: request.session.transcriptPath,
            capturedAt: new Date().toISOString(),
            active: false,
          }
        : null;
      const command = pointer
        ? buildAgentResumeCommand(pointer)
        : request.runtime === "claude"
          ? CLAUDE_LAUNCH_COMMAND
          : CODEX_LAUNCH_COMMAND;
      tabsRef.current.newTerminalTab(request.cwd, command, {
        agentSession: pointer,
        manualAgentRuntime: request.runtime,
      });
    },
    [],
  );

  const handleSettingsOpenWorkerSession = useCallback(
    async (
      runtime: WorkerSessionRuntime,
      cwd: string,
      session: WorkerSessionSummary | null,
    ) => {
      const normalized = (value: string) => {
        const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
        return platform === "win32" ? path.toLowerCase() : path;
      };
      const currentWorkspaces = workspacesRef.current;
      let workspace = currentWorkspaces.find((item) => normalized(item.cwd) === normalized(cwd));

      if (!workspace) {
        const color = pickWorkspaceColor(
          currentWorkspaces.map((item) => item.color),
          cwd,
        );
        workspace = {
          id: makeId("ws"),
          name: basename(cwd) || "workspace",
          cwd,
          color,
          workers: [],
        };
        await window.spark.ui
          ?.setAllowedRoots([...currentWorkspaces.map((item) => item.cwd), cwd])
          .catch(() => undefined);
        const created = workspace;
        setWorkspaces((items) =>
          items.some((item) => normalized(item.cwd) === normalized(cwd))
            ? items
            : [...items, created],
        );
        activeRunIdsByWorkspaceRef.current[workspace.id] = null;
      }

      const request = { runtime, cwd, session };
      setSettingsOpen(false);
      if (tabsRef.current.tabsWorkspaceId === workspace.id) {
        window.setTimeout(() => void launchSettingsSession(request), 0);
        return;
      }
      pendingSettingsSessionLaunchRef.current = { workspaceId: workspace.id, ...request };
      setActiveId(workspace.id);
    },
    [launchSettingsSession, platform],
  );

  useEffect(() => {
    const pending = pendingSettingsSessionLaunchRef.current;
    if (!pending || pending.workspaceId !== tabs.tabsWorkspaceId) return;
    pendingSettingsSessionLaunchRef.current = null;
    window.setTimeout(() => {
      void launchSettingsSession(pending);
    }, 0);
  }, [launchSettingsSession, tabs.tabsWorkspaceId]);

  const handleNewEditorTab = useCallback(() => {
    setSearchOpen(false);
    setFileSearchOpen(true);
  }, []);

  const handleNewPreviewTab = useCallback(() => {
    // window.prompt is disabled in Electron renderers (returns null silently
    // since Electron 4), which is why the previous prompt-based flow looked
    // like "click does nothing." Open the tab empty instead — BrowserPane's
    // EmptyState plus the address bar at the top of AddressBar (which
    // auto-focuses on mount when the URL is empty) gives the user a place
    // to type without any modal.
    newPreviewTab("");
  }, [newPreviewTab]);

  // Top tab strip "+" — append a fresh draft chat tab and focus it. The
  // composer renders in "new chat" mode; the first message will promote the
  // draft to a real run-backed chat tab via handleRunSnapshot.
  const handleNewChat = useCallback(() => {
    addDraftChatTab();
  }, [addDraftChatTab]);

  // "Open chat" on a board card whose run has started: exempt the run from
  // board-run suppression (see openedBoardRunIdsRef), pull it into the lifted
  // list, then route through the same run-selection path the run switcher /
  // toasts use.
  const handleOpenBoardCardRun = useCallback(
    (runId: string) => {
      openedBoardRunIdsRef.current.add(runId);
      void refreshRunsForRef.current?.(activeIdRef.current);
      handleSelectRunAnywhere(runId);
    },
    [handleSelectRunAnywhere],
  );

  // Kept for the tab.newWhiteboard chord — the "+" picker row was folded into
  // Cora chats (whiteboards are created from the chat's inner strip now).
  const handleNewWhiteboard = useCallback(() => {
    newWhiteboardTab();
  }, [newWhiteboardTab]);

  // Chat-tab "×" — close-only, and it STICKS (no auto-respawn). Drafts dissolve
  // locally; run-backed chats only have their top-strip tab removed and a
  // closedChatRunIds marker recorded so the runs-sync effect won't resurrect
  // them. The run stays on disk and shows up in the chat-history popover so the
  // user can reopen it later (which clears the marker). Permanent deletion is
  // reserved for the history popover's per-row delete button.
  const handleCloseChatTab = useCallback(
    (id: TabId) => {
      // If the closed chat is the active run, also clear the run selection and
      // collapse its inner-strip artifacts (Runs canvas, worker/preview pills).
      // Their PTYs keep running — isTabVisibleForRun just hides worker tabs once
      // they no longer match activeRunId — so this is still close-only: nothing
      // is disposed, and reopening the run from history brings the artifacts
      // back. Without this, closing the chat would strand a Runs/worker inner
      // strip under no chat panel.
      if (!isDraftChatTabId(id) && activeRunIdRef.current === id) {
        const workspaceId = activeIdRef.current;
        if (workspaceId) activeRunIdsByWorkspaceRef.current[workspaceId] = null;
        activeRunIdRef.current = null;
        setActiveRunId(null);
        hideRunsTabs();
      }
      closeChatTabForRun(id);
    },
    [hideRunsTabs, closeChatTabForRun],
  );

  // Chat-tab "✎" — rename via IPC; update the tab title locally as well so
  // the strip reflects the change before the run snapshot round-trips.
  const handleRenameChatTab = useCallback(
    (id: TabId, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      renameChatTab(id, trimmed);
      if (isDraftChatTabId(id)) return; // drafts have no backing run yet
      void window.spark.orchestration
        .renameRun({ runId: id, title: trimmed })
        .catch(() => {
          /* IPC failure — the local title may diverge until the next snapshot */
        });
    },
    [renameChatTab],
  );

  const openInSparkBrowser = useCallback(
    (url: string, options?: { forceNew?: boolean }) => {
      if (!isBrowserUrl(url)) return;
      if (options?.forceNew) {
        newPreviewTab(url);
        return;
      }
      const existing = tabs.tabs.find(
        (t) => t.kind === "preview" && (t.url === url || sameOrigin(t.url, url)),
      );
      if (existing) {
        setPreviewUrl(existing.id, url);
        setActiveTabStable(existing.id);
        return;
      }
      newPreviewTab(url);
    },
    // tabs.tabs is data (existing-preview dedupe); the methods are stable.
    [newPreviewTab, setPreviewUrl, setActiveTabStable, tabs.tabs],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: unknown; forceNew?: unknown }>).detail;
      if (typeof detail?.url === "string") {
        openInSparkBrowser(detail.url, { forceNew: detail.forceNew === true });
      }
    };
    window.addEventListener("spark:open-browser-url", handler);
    return () => window.removeEventListener("spark:open-browser-url", handler);
  }, [openInSparkBrowser]);

  // Expose a tab-creation entry point to the preview registry so the
  // spark-preview MCP bridge can auto-open a preview tab when a sub-agent
  // calls navigate without one already being open. The registered fn returns
  // the new tab id; the bridge then waits for PreviewStack to mount its
  // BrowserPaneHandle and drives the navigation.
  useEffect(() => {
    // MCP-driven preview spawns are tagged with the CALLING run's id (threaded
    // from the MCP server's SPARK_RUN_ID stamp through previewRpc.navigate) so
    // another run/workspace being selected can't adopt — or, on its deletion,
    // destroy — a preview a background run is driving. Only when no run
    // identity arrives (user-facing agents) does the tab inherit the active
    // run; reading the ref at call time avoids rebinding the registry hook on
    // every activeRunId change.
    // focus:false — an agent-driven preview spawns in the background (it
    // surfaces in the owning run's inner tab strip) instead of pulling the
    // user off their chat mid-run. The bridge drives navigation by tab id, so
    // the preview need not be the active tab.
    setOpenPreviewTabFn((url: string, runId?: string | null) =>
      newPreviewTab(url, { runId: runId ?? activeRunIdRef.current, focus: false }),
    );
    return () => setOpenPreviewTabFn(null);
  }, [newPreviewTab]);

  // Shared terminal bridge: an MCP client or the Remote Access service asks
  // for a new terminal tab; we mint an origin-marked, UNFOCUSED tab
  // (newAgentTerminalTab never steals focus) and hand the paneId back so the
  // caller can write/read the PTY. cwd
  // defaults to the calling run's workspace cwd (threaded through the bridge),
  // else the active workspace's cwd.
  //
  // Remembers where each bridge-owned pane was minted (survives the effect
  // re-running on tab-state changes) so destroy can reach a pane in a
  // background workspace's layout — plain closeTab only mutates the active
  // store.
  const agentTerminalPlacementsRef = useRef(
    new Map<
      string,
      { workspaceId: string | null; tabId: string; paneId: string }
    >(),
  );
  // Fingerprint of the last shareable-terminal inventory reported to main, so
  // the effect below (which re-runs on every tab-state change) only pings the
  // terminal bridge when a pane a phone could see actually appeared,
  // disappeared, or was retitled.
  const sharedTerminalFingerprintRef = useRef<string | null>(null);
  useEffect(() => {
    const listShareableTerminals = (): Array<{
      paneId: string;
      tabId: string;
      workspaceId: string;
      title?: string;
      cwd?: string;
      profile: "shell" | "claude" | "codex";
    }> => {
      const layouts: Array<{ workspaceId: string; tabs: Tab[] }> = [];
      if (tabs.tabsWorkspaceId && validWorkspaceIds.has(tabs.tabsWorkspaceId)) {
        layouts.push({ workspaceId: tabs.tabsWorkspaceId, tabs: tabs.tabs });
      }
      for (const layout of tabs.inactiveWorkspaceLayouts) {
        if (validWorkspaceIds.has(layout.workspaceId)) layouts.push(layout);
      }
      const shared: Array<{
        paneId: string;
        tabId: string;
        workspaceId: string;
        title?: string;
        cwd?: string;
        profile: "shell" | "claude" | "codex";
      }> = [];
      for (const layout of layouts) {
        for (const tab of layout.tabs) {
          if (tab.kind !== "terminal") continue;
          forEachTerminalLeaf(tab.root, (leaf) => {
            // Phone-owned panes are already durable terminal leases, and Cora
            // workers already have their purpose-built graph terminal surface.
            if (leaf.origin || leaf.worker) return;
            shared.push({
              paneId: leaf.paneId,
              tabId: tab.id,
              workspaceId: layout.workspaceId,
              title: tab.title,
              ...(leaf.cwd ? { cwd: leaf.cwd } : {}),
              profile: leaf.agentSession?.runtime ?? "shell",
            });
          });
        }
      }
      return shared;
    };
    setListShareableStudioTerminalsFn(listShareableTerminals);
    // Push-notify main when the phone-visible inventory changes. Main owns
    // debouncing and fan-out; this stays a bare ping so a burst of tab
    // operations costs a string compare per commit, nothing more.
    const fingerprint = JSON.stringify(
      listShareableTerminals().map((entry) => [
        entry.paneId,
        entry.tabId,
        entry.workspaceId,
        entry.title ?? null,
        entry.profile,
      ]),
    );
    if (fingerprint !== sharedTerminalFingerprintRef.current) {
      sharedTerminalFingerprintRef.current = fingerprint;
      // Optional-called: in dev the renderer can be hot-updated ahead of its
      // preload, and throwing here unmounts App — which unregisters every
      // bridge adapter and kills phone/MCP terminal creation with it.
      window.spark?.terminalBridge?.notifyInventoryChanged?.();
    }
    setCreateAgentTerminalFn((input) => {
      if (input.workspaceId && !validWorkspaceIds.has(input.workspaceId)) {
        throw new Error(
          `Cannot create a terminal for unknown workspace '${input.workspaceId}'.`,
        );
      }
      const cwd = input.cwd || input.workspaceCwd || activeWorkspace?.cwd || home;
      // A background run's terminal must not land in the ACTIVE workspace's
      // strip (same invariant as the spawn_terminals queue path). The hidden
      // mounted stack picks the tab up from its frozen layout and spawns the
      // PTY, so the returned paneId still comes online for write/read.
      if (input.workspaceId && input.workspaceId !== tabs.tabsWorkspaceId) {
        const minted = tabs.newAgentTerminalTabInWorkspace(input.workspaceId, {
          cwd,
          autorun: input.command,
          title: input.title,
          origin: input.origin,
          nativeClaudeProfileId: input.nativeClaudeProfileId,
        });
        agentTerminalPlacementsRef.current.set(minted.tabId, {
          workspaceId: input.workspaceId,
          tabId: minted.tabId,
          paneId: minted.paneId,
        });
        return { ...minted, cwd };
      }
      const { tabId, paneId } = tabs.newAgentTerminalTab({
        cwd,
        autorun: input.command,
        title: input.title,
        origin: input.origin,
        nativeClaudeProfileId: input.nativeClaudeProfileId,
      });
      const placementWorkspaceId =
        input.workspaceId ?? tabs.tabsWorkspaceId ?? activeWorkspace?.id ?? null;
      agentTerminalPlacementsRef.current.set(tabId, {
        workspaceId: placementWorkspaceId,
        tabId,
        paneId,
      });
      return { tabId, paneId, cwd };
    });
    // Cleanup path for terminal.create: if the PTY never spawns (bad cwd), main
    // asks us to close the orphan tab so a failed create leaves nothing behind.
    setCloseAgentTerminalFn((tabId) => {
      const placed = agentTerminalPlacementsRef.current.get(tabId);
      agentTerminalPlacementsRef.current.delete(tabId);
      if (placed) {
        // Close the exact bridge-owned pane wherever the user has since moved
        // it; do not destroy unrelated panes that now share its tab.
        if (placed.workspaceId) {
          tabs.closeTerminalPaneInWorkspace(
            placed.workspaceId,
            placed.tabId,
            placed.paneId,
          );
        } else {
          tabs.closeTerminalPane(placed.tabId, placed.paneId);
        }
      }
      // A missing placement means the user already removed the pane and the
      // prune effect below retired its entry. Do not close the old tab id:
      // after a move/split it may now contain unrelated desktop panes.
    });
    return () => {
      setListShareableStudioTerminalsFn(null);
      setCreateAgentTerminalFn(null);
      setCloseAgentTerminalFn(null);
    };
  }, [tabs, activeWorkspace?.cwd, activeWorkspace?.id, home, validWorkspaceIds]);

  // A user may close or move a bridge-created pane before main later sends its
  // destroy notification. Keep the process-lifetime placement registry aligned
  // with the live layouts: update a moved pane's current tab, and forget an
  // entry once the pane no longer exists anywhere.
  useEffect(() => {
    const layouts: Array<{ workspaceId: string; tabs: Tab[] }> = [];
    if (tabs.tabsWorkspaceId && validWorkspaceIds.has(tabs.tabsWorkspaceId)) {
      layouts.push({ workspaceId: tabs.tabsWorkspaceId, tabs: tabs.tabs });
    }
    for (const layout of tabs.inactiveWorkspaceLayouts) {
      if (!validWorkspaceIds.has(layout.workspaceId)) continue;
      layouts.push({ workspaceId: layout.workspaceId, tabs: layout.tabs });
    }

    for (const [bridgeTabId, placement] of agentTerminalPlacementsRef.current) {
      let located: { workspaceId: string; tabId: string } | null = null;
      for (const layout of layouts) {
        const tab = layout.tabs.find(
          (item) =>
            item.kind === "terminal" &&
            findLeafByPaneId(item.root, placement.paneId) !== null,
        );
        if (tab) {
          located = { workspaceId: layout.workspaceId, tabId: tab.id };
          break;
        }
      }
      if (!located) {
        agentTerminalPlacementsRef.current.delete(bridgeTabId);
        continue;
      }
      if (
        located.workspaceId !== placement.workspaceId ||
        located.tabId !== placement.tabId
      ) {
        agentTerminalPlacementsRef.current.set(bridgeTabId, {
          ...placement,
          ...located,
        });
      }
    }
  }, [
    tabs.tabsWorkspaceId,
    tabs.tabs,
    tabs.inactiveWorkspaceLayouts,
    validWorkspaceIds,
  ]);

  const handleTerminalPaneDropToTab = useCallback(
    (payload: TerminalPaneDragPayload, targetTabId?: string) => {
      if (targetTabId) {
        moveTerminalPane(payload.tabId, payload.paneId, targetTabId);
        return;
      }
      detachTerminalPaneToNewTab(payload.tabId, payload.paneId);
    },
    [moveTerminalPane, detachTerminalPaneToNewTab],
  );

  const handlePreviewUrlChange = useCallback(
    (id: string, url: string) => {
      // Reflect navigation back into the persisted tab state so a reload
      // restores the user where they were.
      setPreviewUrl(id, url);
    },
    [setPreviewUrl],
  );

  // ── Global keyboard shortcuts ──────────────────────────────────────────────

  // Capture-phase + stopImmediatePropagation in useGlobalShortcuts ensures
  // these chords win over xterm/CodeMirror panes that would otherwise eat
  // the keystroke. Cross-module side-effects (focus the chat composer, ask
  // other panels to toggle) are broadcast as `spark:*` CustomEvents so
  // listeners can wire up without prop drilling.
  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "shortcuts.open": () => setShortcutsOpen((open) => !open),
      "runSwitcher.open": () => setRunSwitcherOpen((open) => !open),
      "settings.open": () => {
        setSettingsOpen(true);
        window.dispatchEvent(new CustomEvent("spark:open-settings"));
      },
      "session.openInspector": () => setInspectorOpen((open) => !open),
      "automations.open": () => tabs.openAutomationsTab(),
      "usage.open": () => tabs.openUsageTab(),
      // The Cora Board is a chat sub-view now (no top-level tab). The chord
      // focuses the active chat's Board view; the chatView state lives inside
      // the Workspace component, so this is broadcast like the other
      // cross-module chords and handled there.
      "board.open": () =>
        window.dispatchEvent(new CustomEvent("spark:open-cora-board")),
      "composer.focus": () => {
        // Composer shortcut focuses the active chat if any, otherwise opens
        // (or creates) a draft so the user has somewhere to type.
        tabs.openChatTab({ runId: activeRunIdRef.current, focus: true });
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent("spark:focus-composer"));
        });
      },
      "sidebar.toggleLeft": () => {
        handleToggleLeft();
        window.dispatchEvent(new CustomEvent("spark:toggle-left-sidebar"));
      },
      "sidebar.toggleRight": () => {
        handleToggleRight();
        window.dispatchEvent(new CustomEvent("spark:toggle-sidebar"));
      },
      "chat.new": () => handleNewChat(),
      "search.open": () => {
        setFileSearchOpen(false);
        setSearchOpen(true);
        window.dispatchEvent(new CustomEvent("spark:open-search"));
      },
      "terminal.toggle": () => {
        // Without the bottom strip the chord now spawns or focuses a
        // terminal tab. If a terminal tab already exists and is active,
        // fall back to cycling to the next one for parity with the
        // "toggle visible terminal" mental model.
        const existing = visibleWorkbenchTabs.find((t) => t.kind === "terminal");
        if (!existing) {
          handleNewTerminalTab();
          return;
        }
        if (activeVisibleTabId === existing.id) {
          // Find any other terminal to cycle to; otherwise leave the
          // current one selected.
          const others = visibleWorkbenchTabs.filter((t) => t.kind === "terminal" && t.id !== existing.id);
          if (others.length > 0) tabs.setActiveTab(others[0].id);
        } else {
          tabs.setActiveTab(existing.id);
        }
      },
      "view.zoomIn": () => window.spark.view.zoomBy(1),
      "view.zoomOut": () => window.spark.view.zoomBy(-1),
      "view.zoomReset": () => window.spark.view.setZoomLevel(0),
      "view.selectByIndex": (event) => {
        const index = Number.parseInt(event.key, 10);
        if (Number.isFinite(index) && index >= 1) {
          const target = visibleWorkbenchTabs[index - 1];
          if (target) tabs.setActiveTab(target.id);
        }
        // Keep the legacy event so any listener (e.g. right panel run
        // selector) can also respond.
        window.dispatchEvent(
          new CustomEvent("spark:select-view", { detail: { index } }),
        );
      },
      "tab.newTerminal": handleNewTerminalTab,
      "terminal.newBalancedPane": handleNewBalancedTerminalPane,
      "tab.newEditor": handleNewEditorTab,
      "tab.newPreview": handleNewPreviewTab,
      "tab.newWhiteboard": handleNewWhiteboard,
      // Fresh-launch commands bypass the session picker entirely — rebinding
      // them to the picker broke existing muscle memory (Ctrl+Shift+ñ etc.).
      // The picker lives on its own `worker.*Sessions` commands.
      "worker.newClaude": () => handleNewWorkerTab(CLAUDE_LAUNCH_COMMAND),
      "worker.newCodex": () => handleNewWorkerTab(CODEX_LAUNCH_COMMAND),
      "worker.claudeSessions": () => openShortcutWorkerSessions("claude"),
      "worker.codexSessions": () => openShortcutWorkerSessions("codex"),
      "tab.close": () => {
        if (!activeVisibleTabId) return;
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        // Chat tabs close-and-stick through handleCloseChatTab — the SAME path
        // as the tab's × button — so the dismissed-run marker is recorded AND
        // the active run / inner-strip artifacts are cleared. Routing straight
        // to closeChatTabForRun here would skip that activeRunId cleanup and
        // strand the run's Runs/worker inner strip under no chat panel.
        // closeTab no-ops on chat tabs by design. Everything else closes
        // through the generic path.
        if (active?.kind === "terminal" && countTerminalPanes(active.root) > 1) {
          tabs.closeTerminalPane(active.id, active.activePaneId);
        } else if (active?.kind === "chat") {
          handleCloseChatTab(active.id);
        } else {
          tabs.closeTab(activeVisibleTabId);
        }
      },
      "tab.closeOthers": () => {
        if (activeVisibleTabId) tabs.closeOthers(activeVisibleTabId);
      },
      "tab.cycleNext": () => {
        if (!activeVisibleTabId || visibleWorkbenchTabs.length === 0) return;
        const idx = visibleWorkbenchTabs.findIndex((tab) => tab.id === activeVisibleTabId);
        const next = visibleWorkbenchTabs[(Math.max(0, idx) + 1) % visibleWorkbenchTabs.length];
        if (next) tabs.setActiveTab(next.id);
      },
      "tab.cyclePrev": () => {
        if (!activeVisibleTabId || visibleWorkbenchTabs.length === 0) return;
        const idx = visibleWorkbenchTabs.findIndex((tab) => tab.id === activeVisibleTabId);
        const prev =
          visibleWorkbenchTabs[
            (Math.max(0, idx) - 1 + visibleWorkbenchTabs.length) % visibleWorkbenchTabs.length
          ];
        if (prev) tabs.setActiveTab(prev.id);
      },
      "terminal.splitRight": () => {
        // The active workbench tab dictates which split happens — we only
        // act on terminal tabs so this chord is a no-op anywhere else.
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.splitTerminalPane(active.id, active.activePaneId, "horizontal");
      },
      "terminal.splitDown": () => {
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.splitTerminalPane(active.id, active.activePaneId, "vertical");
      },
      "terminal.closePane": () => {
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.closeTerminalPane(active.id, active.activePaneId);
      },
      "terminal.toggleZoom": () => {
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.toggleTerminalPaneZoom(active.id, active.activePaneId);
      },
      "markdown.togglePreview": () => {
        // Filter at dispatch time so the chord stays a no-op on terminal,
        // chat, and non-MD editor tabs. EditorPane re-checks `active` so the
        // event safely reaches only the currently visible editor.
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "editor") return;
        if (!/\.(md|markdown|mdown|mkd|mkdn)$/i.test(active.path)) return;
        window.dispatchEvent(new CustomEvent("spark:markdown.togglePreview"));
      },
    }),
    [
      handleNewBalancedTerminalPane,
      handleNewChat,
      handleNewEditorTab,
      handleNewPreviewTab,
      handleNewTerminalTab,
      handleNewWhiteboard,
      handleNewWorkerTab,
      openShortcutWorkerSessions,
      handleCloseChatTab,
      handleToggleLeft,
      handleToggleRight,
      activeVisibleTabId,
      tabs,
      visibleWorkbenchTabs,
    ],
  );

  const shortcutPreferences = preferences;
  const bindingTable = useMemo(
    () => buildBindingTable(shortcutPreferences.keybindings),
    [shortcutPreferences.keybindings],
  );
  useGlobalShortcuts(bindingTable, shortcutHandlers, {
    // While the Keybindings settings recorder is active, suppress all
    // shortcuts so chords like Ctrl+Tab can be captured for rebinding
    // instead of triggering their currently bound command.
    isDisabled: (id, event) => {
      if (isRecording()) return true;
      // The terminal split chords only act on terminal tabs; swallowing them
      // at capture phase elsewhere would kill surface-local bindings that
      // share the chord (the whiteboard's Ctrl+D duplicate).
      if (
        (id === "terminal.splitRight" || id === "terminal.splitDown") &&
        visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId)?.kind !== "terminal"
      ) {
        return true;
      }
      // Ctrl+L is the native readline/terminal clear chord on Windows and
      // Linux. The app-level "focus Cora" binding also resolves to Ctrl+L on
      // those platforms, so let xterm own it while a terminal has focus. On
      // macOS the Cora binding is Cmd+L and does not conflict with Ctrl+L.
      return (
        id === "composer.focus" &&
        !IS_MAC &&
        event.target instanceof Element &&
        event.target.closest(".xterm") !== null
      );
    },
  });

  // Resolved keybind hints for the tab-strip "+" picker. Derived from the
  // effective binding table so the menu always shows the user's actual chord
  // (rebinds included) with the right platform glyphs, and shows nothing when
  // a command is unbound. Memoized on bindingTable so TabBar's React.memo
  // identity holds across unrelated App renders. Each picker row maps to the
  // command that performs the SAME action as its onNew* handler.
  const pickerHints = useMemo<PickerHints>(
    () => ({
      terminal: hintForCommand(bindingTable, "tab.newTerminal"),
      preview: hintForCommand(bindingTable, "tab.newPreview"),
    }),
    [bindingTable],
  );

  // Dispose PTYs when terminal panes exit. The renderer-side TerminalPane
  // already calls pty.dispose on unmount, so this handler is intentionally
  // a no-op for unmount cases — but we keep the seam so future "exited
  // pane → auto-close" UX can hook in here without touching every call site.
  const onTerminalPaneExit = useCallback(
    (tabId: string, paneId: string, info?: PtyExitInfo) => {
      paneRuntimeRef.current.delete(paneId);
      if (!isAppTearingDown()) confirmedAgentExitAtRef.current.set(paneId, Date.now());
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      if (!leaf) return;
      // The shell died, taking any foreground agent with it — a pointer left
      // `active` here would wrongly restore on the next boot. The poller's
      // running:false usually lands first; this covers a pty that dies without
      // the TUI ever leaving alt-screen (kill, crash, window-manager teardown).
      //
      // EXCEPT during app teardown: at quit, disposeAllGraceful kills every
      // pane's shell, firing pty:exit into the still-alive renderer. Deactivating
      // here would persist active:false and DROP the boot-once resume — the pane
      // comes back a plain shell and the user has to `--resume` by hand. When the
      // app is tearing down, the agent WAS running (we're the ones killing it),
      // so keep active:true so the next launch resumes it. Which quit path won
      // the race with the final persist was the "resume only works sometimes" bug.
      if (leaf.agentSession?.active && !isAppTearingDown()) {
        t.setLeafAgentSession(tabId, paneId, { ...leaf.agentSession, active: false });
      }
      if (!leaf.worker) return;
      // Only Cora ends a worker, so a teardown Codara itself performed is never
      // a crash: main flags those with PtyExitInfo.sanctioned (orchestration
      // disposing a finished worker's host shell, the app-quit sweep), and app
      // teardown is double-covered by the renderer's own flag. pty.kill() is a
      // SIGHUP, reported as exitCode 0 + signal 1, so exit status cannot make
      // this distinction: reading it as one is what repainted every accepted
      // worker "crashed" the moment Cora disposed its pane.
      const sanctioned = info?.sanctioned === true || isAppTearingDown();
      // D5 (error). An unsanctioned non-zero pty exit is a crash, not a clean
      // finish. Keep the chip visible so the user sees the failure in red rather
      // than the pane silently dropping its badge. Manual chips keep the exit
      // status heuristic: a user typing `exit` in their own agent pane is a
      // normal quit, and only an abnormal status makes it a crash.
      const abnormal =
        !!info && (info.exitCode !== 0 || (typeof info.signal === "number" && info.signal !== 0));
      const crashed = abnormal && !sanctioned;
      // Manual chips (user-typed claude/codex, or AddPane menu launches) and
      // legacy chips without an explicit source have no lifecycle outside the
      // pane. Clear them outright when the PTY dies so an idle shell never keeps
      // displaying a stale "DONE" badge after the agent quits — UNLESS it
      // crashed, in which case we surface the error state instead of hiding it.
      if (leaf.worker.source !== "spark") {
        if (crashed) {
          t.setLeafWorker(tabId, paneId, {
            ...leaf.worker,
            agentRunning: false,
            runtimeState: "error",
          });
          return;
        }
        t.setLeafWorker(tabId, paneId, null);
        return;
      }
      // A PTY exit is not the worker completion signal. Codara-owned panes move
      // to "done" only when orchestration emits worker_attempt.finished.
      //
      // A worker that already reached "done" is settled: its outcome is the run
      // record's, and no later pty exit may repaint it, whatever the exit status
      // says. (Cora disposes the idle host shell right after acceptance, and
      // sweepDeadSessions synthesizes exitCode -1 for every dead shell after a
      // wake-from-sleep: both used to land on a finished pane as "crashed".)
      // The inverse holds too: a worker pane whose pty dies with no "done"
      // behind it died on its own, so the chip says crashed no matter how clean
      // the exit status looked. Only Cora ends a worker.
      const settled =
        leaf.worker.state === "done" ||
        leaf.worker.runtimeState === "done" ||
        finishedWorkerAttemptsRef.current.has(paneId);
      const workerCrashed = !sanctioned && !settled;
      t.setLeafWorker(tabId, paneId, {
        ...leaf.worker,
        agentRunning: false,
        ...(workerCrashed ? { runtimeState: "error" as const } : {}),
      });
    },
    [],
  );

  // useTerminalSession sniffs the PTY byte stream for the alt-screen toggle
  // every Ink TUI (claude / codex) emits and tells us when one enters or
  // leaves. We use it to add a "manual" worker chip the moment the user
  // types `codex`/`claude` in any shell pane, and to clear it again the
  // moment they Ctrl+C out — the chip means "an agent is live in this
  // pane" and nothing more, so once the agent quits the pane shows no chip
  // at all (rather than a lingering "DONE" badge).
  // Cora-orchestrated workers (source="spark") keep their completion
  // lifecycle in the run store, but the terminal chip still follows the
  // foreground process: when Claude/Codex returns to the shell prompt, the
  // pane stops advertising an active agent.
  const onTerminalPaneAgentState = useCallback(
    (
      tabId: string,
      paneId: string,
      state: TerminalAgentForegroundState,
    ) => {
      if (state.running) {
        confirmedAgentExitAtRef.current.delete(paneId);
      } else if (state.exitConfirmed === true) {
        confirmedAgentExitAtRef.current.set(paneId, Date.now());
      }
      // Mirror alt-screen / TUI activity into the pane runtime tracker so
      // the worker keybind has a foolproof "do not take over" signal even
      // when banner detection didn't recognise the runtime. Updated for
      // both known (claude/codex) and unknown (runtime=null)
      // TUIs — the moment the PTY enters alt-screen mode it's no longer
      // safe to inject the launch command.
      const runtimeEntry =
        paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
      // Previous TUI state, read BEFORE the overwrite below: capture re-arms
      // only on a genuine not-running → running transition, not on the
      // poller's repeated running:true emissions for one live TUI.
      const wasRunning = runtimeEntry.altScreenActive === true;
      runtimeEntry.altScreenActive = state.running;
      paneRuntimeRef.current.set(paneId, runtimeEntry);
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      if (!leaf) return;
      // Capture this pane's CLI session id when a claude/codex agent is
      // detected running, so a future reopen can `--resume` it. Discovery is
      // by newest transcript CREATED in the last minute for this cwd, so it
      // works for every launch path (keybind, picker, drag, inject, or a plain
      // `claude` the user typed).
      //
      // Two arms:
      // - Initial capture: the pane has no pointer yet.
      // - Re-capture: a NEW agent run just started (wasRunning=false) in a pane
      //   whose pointer is old. Without this the pointer is write-once — start
      //   a fresh conversation in the same pane and reopen would resume the
      //   previous one. The age guard keeps a just-minted `--session-id`
      //   pointer (keybind launch, seconds old when the TUI is first detected)
      //   from being clobbered by a discovery race. Discovery only matches
      //   transcripts CREATED within the last minute, so a `--resume` of an
      //   existing session (old file, appended in place) finds nothing and the
      //   pointer correctly stays put — while a genuinely new session (new
      //   file) takes over the pointer. For Codex this also keeps the chain
      //   alive if `codex resume` writes a fresh rollout file per run.
      const pointerAgeMs = leaf.agentSession?.capturedAt
        ? Date.now() - Date.parse(leaf.agentSession.capturedAt)
        : Number.POSITIVE_INFINITY;
      const shouldCapture =
        !leaf.agentSession?.sessionId ||
        (!wasRunning && !(pointerAgeMs < 90_000));
      if (
        state.running &&
        (state.runtime === "claude" || state.runtime === "codex") &&
        shouldCapture &&
        !capturingPanesRef.current.has(paneId)
      ) {
        const capRuntime = state.runtime;
        const capCwd = leaf.cwd ?? paneRuntimeRef.current.get(paneId)?.cwd;
        if (capCwd) {
          capturingPanesRef.current.add(paneId);
          // Session ids already bound to OTHER panes (any tab, any runtime).
          // Discovery must never rebind one of these to this pane: two agents
          // launched in the same cwd inside the discovery window would both
          // bind the newest transcript, and the earlier pane's conversation
          // would silently drop out of restore.
          const excludeSessionIds: string[] = [];
          const collectBoundSessions = (node: PaneNode): void => {
            if (node.kind === "leaf") {
              if (node.paneId !== paneId && node.agentSession?.sessionId) {
                excludeSessionIds.push(node.agentSession.sessionId);
              }
              return;
            }
            collectBoundSessions(node.a);
            collectBoundSessions(node.b);
          };
          for (const otherTab of t.tabs) {
            if (otherTab.kind === "terminal") collectBoundSessions(otherTab.root);
          }
          const captureStartedAt = Date.now();
          void window.spark.agentSession
            .capture({
              runtime: capRuntime,
              paneId,
              nativeCodexProfileId:
                leaf.agentSession?.nativeCodexProfileId ??
                leaf.worker?.nativeCodexProfileId,
              nativeClaudeProfileId:
                leaf.agentSession?.nativeClaudeProfileId ??
                leaf.worker?.nativeClaudeProfileId,
              cwd: capCwd,
              sinceMs: Date.now() - 60_000,
              excludeSessionIds,
            })
            .then((res) => {
              if (res) {
                // Capture polls up to 15s; a SessionStart hook event (exact
                // identity, agentSession.onStarted above) may have rebound the
                // pane meanwhile. Never let this heuristic overwrite it.
                const tNow = tabsRef.current;
                const tabNow = tNow.tabs.find((item) => item.id === tabId);
                const leafNow =
                  tabNow?.kind === "terminal" ? findLeafByPaneId(tabNow.root, paneId) : null;
                const pointerCapturedAt = leafNow?.agentSession?.capturedAt
                  ? Date.parse(leafNow.agentSession.capturedAt)
                  : 0;
                if (pointerCapturedAt > captureStartedAt) return;
                tNow.setLeafAgentSession(tabId, paneId, {
                  runtime: capRuntime,
                  sessionId: res.sessionId,
                  cwd: capCwd,
                  transcriptPath: res.transcriptPath,
                  nativeCodexProfileId: res.nativeCodexProfileId,
                  nativeClaudeProfileId: res.nativeClaudeProfileId,
                  capturedAt: new Date().toISOString(),
                  // Capture polls up to 15s; the agent may have exited in the
                  // meantime. Only a positively confirmed exit after capture
                  // began can make this new pointer inactive: the visible-tail
                  // poller may briefly report UI absence for a live TUI, which
                  // must not reproduce the reopen-as-a-shell failure.
                  active:
                    (confirmedAgentExitAtRef.current.get(paneId) ?? 0) <=
                    captureStartedAt,
                });
              }
            })
            .catch(() => undefined)
            .finally(() => capturingPanesRef.current.delete(paneId));
        }
      }
      // Restore eligibility (`active`) tracks "is this pointer's agent running
      // RIGHT NOW", independent of capture: a `--resume`d session appends to
      // its existing transcript, so discovery finds no new file and the
      // capture arm above never rewrites the pointer — the flag must still
      // flip here. Only written on a real change to avoid render churn.
      //
      // Two ACCEPTED limitations:
      // - An agent that exits while its workspace layer is HIDDEN is not
      //   recorded (hidden layers get noop write-backs), so the persisted blob
      //   keeps active:true and the next boot resumes a session that died
      //   while hidden. This only occurs on crash/kill — a clean exit is
      //   reported once the layer is active again — and resuming a crashed
      //   session reads as recovery, not annoyance.
      // - The 90s re-capture age guard above means a DIFFERENT claude started
      //   in the same pane within 90s of the previous pointer's capture can
      //   leave the old sessionId blessed as active. Narrow window; the mild
      //   failure is that restore opens that pane's previous conversation.
      if (
        state.running &&
        (state.runtime === "claude" || state.runtime === "codex") &&
        leaf.agentSession?.sessionId &&
        leaf.agentSession.runtime === state.runtime &&
        leaf.agentSession.active !== true
      ) {
        t.setLeafAgentSession(tabId, paneId, { ...leaf.agentSession, active: true });
      } else if (
        !state.running &&
        state.exitConfirmed === true &&
        leaf.agentSession?.active
      ) {
        t.setLeafAgentSession(tabId, paneId, { ...leaf.agentSession, active: false });
      }
      const existing = leaf.worker;
      if (state.running) {
        if (existing && existing.source === "spark") {
          t.setLeafWorker(tabId, paneId, {
            ...existing,
            runtime: state.runtime ?? existing.runtime,
            agentRunning: true,
          });
          return;
        }
        if (existing && existing.source !== "manual") return;
        // Unrecognised TUI (runtime=null) with no existing chip — the
        // alt-screen tracker above is enough to block the keybind; don't
        // sprout a "WORKER" badge on vim / less / fzf panes.
        if (state.runtime === null && !existing) return;
        const runtime = state.runtime ?? existing?.runtime;
        t.setLeafWorker(tabId, paneId, {
          runtime,
          runId: "manual",
          workerTaskId: existing?.workerTaskId ?? `manual-${paneId}`,
          attemptId: existing?.attemptId ?? paneId,
          source: "manual",
          state: "running",
          agentRunning: true,
        });
        return;
      }
      // running=false: the agent's TUI closed — the user Ctrl+C'd out (or
      // the agent exited) and the shell prompt is back. Clear manual chips
      // outright; for Codara-owned panes, keep the run metadata but mark the
      // foreground agent inactive so the terminal no longer shows CLAUDE DONE.
      if (!existing) return;
      if (existing.source === "spark") {
        t.setLeafWorker(tabId, paneId, { ...existing, agentRunning: false });
        return;
      }
      if (existing.source !== "manual") return;
      t.setLeafWorker(tabId, paneId, null);
    },
    [],
  );

  // Finer live agent state (working / blocked / idle) from the per-pane
  // terminal poller. The binary onTerminalPaneAgentState above owns chip
  // CREATE/TEARDOWN (it sprouts the manual chip on alt-screen enter and clears
  // it on exit); this handler only refreshes the runtimeState field on an
  // ALREADY-existing leaf worker so the chip can show "working" / "waiting for
  // you" / "idle" without us minting a chip on a bare pane the poller happens
  // to classify. Skipped when no worker is attached.
  //
  // "done" is deliberately ignored here: the poller emits it from the same
  // resetAgentPhase that fires onAgentState(running:false) — which removes the
  // manual chip / clears agentRunning on a Codara chip — and that callback runs
  // FIRST in the same synchronous stack. Writing runtimeState:"done" afterward
  // would resurrect the just-removed manual worker (a stale DONE chip), since
  // both setLeafWorker updaters are queued against the same pre-removal tab
  // tree. The chip's "done" look is already driven by the worker lifecycle.
  const onTerminalPaneRuntimeState = useCallback(
    (tabId: string, paneId: string, state: RuntimeState) => {
      const t = tabsRef.current;
      // The chip and workspace ring must never disagree for the visible pane.
      // Main's raw-PTY monitor remains responsible while this workspace is
      // hidden, but the local poller is already the source that painted the
      // chip the user sees here, so mirror its confirmed state into the rail.
      if (t.tabsWorkspaceId) {
        setTerminalPaneWorking(t.tabsWorkspaceId, paneId, state === "working");
      }
      if (state === "done") return;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      const existing = leaf?.worker;
      if (!existing) return;
      if (existing.runtimeState === state) return;
      t.setLeafWorker(tabId, paneId, { ...existing, runtimeState: state });
    },
    [setTerminalPaneWorking],
  );

  // Total live worker count for the status bar. `countRunningTerminalWorkers`
  // is a recursive walk of every terminal tab's pane tree — memoize it so a
  // status-bar repaint isn't triggered (and the walk isn't re-run) on every
  // unrelated App re-render. `tabs.tabs` is referentially stable across
  // renders, so it changes only when the tab layout actually does.
  // Declared before the early returns below because hooks must run on every
  // render in the same order.
  const workerCount = useMemo(
    () => (activeWorkspace?.workers.length ?? 0) + countRunningTerminalWorkers(tabs.tabs),
    [tabs.tabs, activeWorkspace?.workers.length],
  );

  // ── Selection routing (preview overlays) ──────────────────────────────
  //
  // The browser pane's inspector + draw overlays each produce a
  // SelectionPayload (text prompt, optionally an annotated PNG path). The
  // SelectionRouteMenu calls route() with one of the destinations below to
  // ship that payload at:
  //   - a brand-new Codara chat (startAutopilot with the payload pre-filled)
  //   - the currently-focused Codara chat (addRunMessage)
  //   - a freshly-spawned Claude Code or Codex worker pane (new pane with
  //     autorun + delayed pty.inject once the agent REPL settles)
  //   - any currently-running CLI worker pane (pty.inject)
  //
  // Image attachments only travel on the chat destinations. PTYs are text
  // only, so worker routes embed the saved PNG's absolute path in the prompt
  // and the CLI agent reads the file off disk.

  // Spawn a fresh worker pane in the same way the keyboard shortcut does
  // (handleNewWorkerTab). Returns the new pane id so the caller can later
  // inject a prompt once the agent is up; null if no terminal tab exists
  // and we had to fall back to creating a whole new tab (no stable id).
  const spawnRoutedWorkerPane = useCallback(
    (autorun: string): string | null => {
      const { command: launchCommand, makeSession } = prepareWorkerLaunch(autorun);
      const launchRuntime = runtimeFromAgentSessionLaunchCommand(launchCommand);
      const t = tabsRef.current;
      const active = t.tabs.find((tab) => tab.id === t.activeId);
      const target =
        active?.kind === "terminal"
          ? active
          : // Skip run-scoped worker tabs (hidden unless their run is active).
            t.tabs.find((tab) => tab.kind === "terminal" && tab.scope?.kind !== "workers");
      if (!target || target.kind !== "terminal") {
        const seedCwd = activeWorkspace?.cwd ?? undefined;
        t.newTerminalTab(seedCwd, launchCommand, {
          agentSession: makeSession(seedCwd),
          manualAgentRuntime: launchRuntime ?? undefined,
        });
        return null;
      }
      const paneId = makeId("pane");
      const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
      const cwd =
        paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
        activeLeaf?.cwd ??
        activeWorkspace?.cwd ??
        undefined;
      const added = t.addPaneInTab(target.id, paneId, {
        cwd,
        autorun: launchCommand,
        agentSession: makeSession(cwd),
        worker: launchRuntime
          ? createManualAgentLaunchWorker(launchRuntime, paneId)
          : undefined,
      });
      if (!added) {
        t.newTerminalTab(cwd, launchCommand, {
          agentSession: makeSession(cwd),
          manualAgentRuntime: launchRuntime ?? undefined,
        });
        return null;
      }
      t.setActiveTab(target.id);
      t.setActiveTerminalPane(target.id, paneId);
      return paneId;
    },
    [activeWorkspace?.cwd, prepareWorkerLaunch],
  );

  // Wait for a freshly spawned worker pane's CLI agent to enter its REPL
  // before typing our prompt at it. The seeded worker metadata paints the
  // starting chip before launch, so only detector-confirmed alt-screen state
  // proves that injection is safe. Keep the timeout for failed or slow boots.
  const waitForAgentReady = useCallback(
    (paneId: string, timeoutMs = 30000): Promise<void> =>
      new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          for (const tab of tabsRef.current.tabs) {
            if (tab.kind !== "terminal") continue;
            const leaf = findLeafByPaneId(tab.root, paneId);
            if (
              isPaneAgentInjectable(
                leaf?.worker,
                paneRuntimeRef.current.get(paneId),
              )
            ) {
              resolve();
              return;
            }
          }
          if (Date.now() - start > timeoutMs) {
            resolve();
            return;
          }
          window.setTimeout(tick, 250);
        };
        tick();
      }),
    [],
  );

  const routingDestinations = useMemo<RoutingDestination[]>(() => {
    const list: RoutingDestination[] = [];
    list.push({
      id: "chat-new",
      kind: "chat-new",
      label: "New Cora chat",
      group: "chat",
      disabled: !activeWorkspace,
      disabledReason: activeWorkspace ? undefined : "Open a workspace first.",
    });
    const currentRun = activeRunId ? runs.find((r) => r.id === activeRunId) ?? null : null;
    list.push({
      id: "chat-current",
      kind: "chat-current",
      label: currentRun ? "Send to current chat" : "Send to current chat",
      sublabel: currentRun?.title,
      group: "chat",
      disabled: !currentRun,
      disabledReason: currentRun ? undefined : "No chat is currently focused.",
    });
    list.push({
      id: "worker-new-claude",
      kind: "worker-new-claude",
      label: "New Claude Code worker",
      group: "worker-new",
      disabled: !activeWorkspace,
      disabledReason: activeWorkspace ? undefined : "Open a workspace first.",
    });
    list.push({
      id: "worker-new-codex",
      kind: "worker-new-codex",
      label: "New Codex worker",
      group: "worker-new",
      disabled: !activeWorkspace,
      disabledReason: activeWorkspace ? undefined : "Open a workspace first.",
    });
    const openWorkers = enumerateOpenWorkers(visibleWorkbenchTabs, runs).filter(
      (worker) => {
        for (const tab of visibleWorkbenchTabs) {
          if (tab.kind !== "terminal") continue;
          const leaf = findLeafByPaneId(tab.root, worker.injectId);
          if (
            isPaneAgentInjectable(
              leaf?.worker,
              paneRuntimeRef.current.get(worker.injectId),
            )
          ) {
            return true;
          }
        }
        return false;
      },
    );
    for (const worker of openWorkers) {
      list.push({
        id: `worker-existing-${worker.injectId}`,
        kind: "worker-existing",
        label: workerMenuLabel(worker),
        sublabel: worker.source === "spark" ? undefined : "manual",
        group: "worker-existing",
      });
    }
    return list;
  }, [activeWorkspace, activeRunId, runs, visibleWorkbenchTabs]);

  const routeSelection = useCallback(
    async (payload: SelectionPayload, destinationId: string) => {
      if (destinationId === "chat-new") {
        const ws = activeWorkspace;
        if (!ws) throw new Error("No workspace.");
        const attachments = payload.imagePath
          ? [{ sourcePath: payload.imagePath, kind: "image" as const }]
          : undefined;
        const run = await window.spark.orchestration.startAutopilot({
          workspaceId: ws.id,
          workspaceName: ws.name,
          cwd: ws.cwd,
          initialUserNote: payload.text,
          initialUserNoteClientMessageId: makeId("client-msg"),
          initialAttachments: attachments,
        });
        // Bind the selection to the originating workspace: the user may have
        // switched away during the startAutopilot await.
        handleSelectRun(run.id, ws.id);
        void refreshRunsFor(ws.id);
        return;
      }
      if (destinationId === "chat-current") {
        const runId = activeRunIdRef.current;
        if (!runId) throw new Error("No active chat.");
        const attachments = payload.imagePath
          ? [{ sourcePath: payload.imagePath, kind: "image" as const }]
          : undefined;
        await window.spark.orchestration.addRunMessage({
          runId,
          clientMessageId: makeId("client-msg"),
          author: "user",
          kind: "note",
          message: payload.text,
          attachments,
        });
        return;
      }
      if (destinationId === "worker-new-claude" || destinationId === "worker-new-codex") {
        const autorun =
          destinationId === "worker-new-claude" ? CLAUDE_LAUNCH_COMMAND : CODEX_LAUNCH_COMMAND;
        const paneId = spawnRoutedWorkerPane(autorun);
        if (!paneId) {
          // Fell back to a fresh tab; the leaf was created internally and we
          // don't have a handle to inject into. Skip the auto-prompt — the
          // user can paste the text manually if they want.
          return;
        }
        // Fire-and-forget so the menu can close immediately; the agent boot
        // takes seconds and we don't want to block the UI on it.
        void (async () => {
          await waitForAgentReady(paneId);
          try {
            await window.spark.pty.inject(paneId, payload.text, { submit: true });
          } catch {
            /* pane may have been closed; nothing to recover */
          }
        })();
        return;
      }
      if (destinationId.startsWith("worker-existing-")) {
        const injectId = destinationId.slice("worker-existing-".length);
        await window.spark.pty.inject(injectId, payload.text, { submit: true });
        return;
      }
      throw new Error(`Unknown routing destination: ${destinationId}`);
    },
    [activeWorkspace, handleSelectRun, refreshRunsFor, spawnRoutedWorkerPane, waitForAgentReady],
  );

  const routingApi = useMemo<SelectionRoutingApi>(
    () => ({ destinations: routingDestinations, route: routeSelection }),
    [routingDestinations, routeSelection],
  );

  if (bootError) {
    return (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 32,
          background: "var(--bg)",
          textAlign: "center",
        }}
      >
        <div className="spark-eyebrow" style={{ color: "var(--danger)" }}>
          Startup failed
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--ink-dim)",
            maxWidth: 480,
            wordBreak: "break-word",
          }}
        >
          {bootError}
        </div>
      </div>
    );
  }
  if (!booted) {
    return (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
        }}
      >
        <div className="spark-eyebrow" style={{ color: "var(--muted)" }}>
          Loading
        </div>
      </div>
    );
  }

  const terminalShell = integratedShell ?? defaultShell;

  return (
    <SelectionRoutingProvider value={routingApi}>
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      {/* Auto-updater banner — position:fixed so the banner sits above
          WindowChrome without disturbing the existing flex layout. Renders
          nothing in the resting state, so it's a no-op outside of the
          packaged-app update lifecycle. */}
      <UpdateBanner />
      <WindowChrome
        platform={platform}
        leftOn={leftPanelVisible}
        rightOn={rightPanelVisible}
        onToggleLeft={handleToggleLeft}
        onToggleRight={handleToggleRight}
        onOpenSettings={handleOpenSettings}
        onOpenUsage={handleOpenUsage}
        notifyNavigateTo={navigateToNotifyTarget}
        notifyResolveQuestion={resolveRunQuestion}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {leftPanelVisible && (
          <div
            data-responsive-panel="left"
            style={{
              display: "flex",
              minHeight: 0,
              flex: "0 0 auto",
              ...(compactWorkbench ? {
                position: "absolute" as const,
                inset: "0 auto 0 0",
                zIndex: 30,
                boxShadow: "var(--shadow-float)",
              } : {}),
            }}
          >
          <WorkspaceRail
            side="left"
            toneByWorkspaceId={toneByWorkspaceId}
            workingByWorkspaceId={workingByWorkspaceId}
            sections={panels.sections.left}
            draggingSection={draggingPanelSection}
            workspaces={workspaces}
            workspaceGroups={workspaceGroups}
            workspaceRailOrder={workspaceRailOrder}
            activeId={activeId}
            activeWorkspace={activeWorkspace}
            editingId={editingId}
            width={panels.leftWidth}
            split={panels.leftSplit}
            collapsed={panels.collapsed}
            activePath={
              tabs.activeTab && tabs.activeTab.kind === "editor"
                ? tabs.activeTab.path
                : null
            }
            onActivate={handleActivateWorkspace}
            onEdit={handleEditWorkspace}
            onChange={updateWs}
            onPreviewColor={previewWsColor}
            onDelete={deleteWs}
            onMoveWorkspace={moveWs}
            onCreateWorkspaceGroup={createWorkspaceGroup}
            onChangeWorkspaceGroup={updateWorkspaceGroup}
            onReorderWorkspaceRailItem={reorderWorkspaceRailItem}
            onDeleteWorkspaceGroup={deleteWorkspaceGroup}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onCreateRemote={handleCreateRemote}
            onCreateCopyBranch={handleCreateCopyBranch}
            onSplitChange={panels.setLeftSplit}
            onToggleSection={togglePanelSection}
            onMoveSection={movePanelSection}
            onSectionDragStart={handlePanelSectionDragStart}
            onSectionDragEnd={handlePanelSectionDragEnd}
            onOpenGitHubQueueItem={handleOpenGitHubQueueItem}
            onOpenFile={openFileByPath}
            onOpenFileEntry={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRunPlan={handleRunPlan}
            git={sharedGit}
            onOpenDiffTab={handleOpenDiffTab}
            activeDiffTarget={activeDiffTarget}
            onOpenDiffForPath={handleOpenDiffForPath}
            onAddExternalFolder={addExternalFolder}
            onRemoveExternalFolder={removeExternalFolder}
          />
          <ResizeHandle
            orientation="col"
            accent={activeWorkspace?.color}
            ariaLabel="Resize the workspaces panel"
            onResizeStart={handleLeftWidthStart}
            onResize={handleLeftWidthResize}
          />
          </div>
        )}

        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            position: "relative",
          }}
        >
          {workspaces.length === 0 ? (
            <NoWorkspace onCreate={createWs} />
          ) : (
            <Workspace
              tabs={tabs}
              workspace={activeWorkspace}
              validWorkspaceIds={validWorkspaceIds}
              shell={terminalShell}
              terminalScrollbackLineLimit={settings.terminalScrollbackLineLimit}
              runs={runs}
              runsWorkspaceId={runsWorkspaceId}
              activeRunId={activeRunId}
              onSelectRun={handleSelectRun}
              onRunSnapshot={handleRunSnapshot}
              onDetectedUrl={handleDetectedUrl}
              onSparkOpenFile={openFileByPath}
              gitStatus={sharedGit.status}
              gitVersion={sharedGit.gitVersion}
              onGitChanged={sharedGit.notifyChanged}
              onFileSaved={sharedGit.notifyChanged}
              onTerminalPaneExit={onTerminalPaneExit}
              onPreviewUrlChange={handlePreviewUrlChange}
              onPaneCwd={handlePaneCwd}
              onPaneActivity={handlePaneActivity}
              onPaneUserInput={handlePaneUserInput}
              onPaneScrollback={handlePaneScrollback}
              onTerminalPaneAgentState={onTerminalPaneAgentState}
              onTerminalPaneRuntimeState={onTerminalPaneRuntimeState}
              onOpenWorkerSessionPicker={openPaneWorkerSessions}
              onNewTerminalTab={handleNewTerminalTab}
              onNewPreviewTab={handleNewPreviewTab}
              onNewClaudeWorker={openClaudeWorkerSessions}
              onNewCodexWorker={openCodexWorkerSessions}
              onNewChat={handleNewChat}
              onOpenBoardCardRun={handleOpenBoardCardRun}
              onRenameChat={handleRenameChatTab}
              onCloseChat={handleCloseChatTab}
              onTerminalPaneDrop={handleTerminalPaneDropToTab}
              onReorderTab={tabs.reorderTab}
              onPinEditorTab={tabs.pinEditorTab}
              pickerHints={pickerHints}
              closeTabsOnMiddleClick={shortcutPreferences.closeTabsOnMiddleClick}
            />
          )}
        </main>

        {rightPanelVisible && (
          <div
            data-responsive-panel="right"
            style={{
              display: "flex",
              minHeight: 0,
              flex: "0 0 auto",
              ...(compactWorkbench ? {
                position: "absolute" as const,
                inset: "0 0 0 auto",
                zIndex: 30,
                boxShadow: "var(--shadow-float)",
              } : {}),
            }}
          >
            <ResizeHandle
              orientation="col"
              accent={activeWorkspace?.color}
              ariaLabel="Resize the right panel"
              onResizeStart={handleRightWidthStart}
              onResize={handleRightWidthResize}
            />
          <WorkspaceRail
            side="right"
            toneByWorkspaceId={toneByWorkspaceId}
            workingByWorkspaceId={workingByWorkspaceId}
            sections={panels.sections.right}
            draggingSection={draggingPanelSection}
            workspaces={workspaces}
            workspaceGroups={workspaceGroups}
            workspaceRailOrder={workspaceRailOrder}
            activeId={activeId}
            activeWorkspace={activeWorkspace}
            editingId={editingId}
            width={panels.rightWidth}
            split={panels.rightSplit}
            collapsed={panels.collapsed}
            activePath={
              tabs.activeTab && tabs.activeTab.kind === "editor"
                ? tabs.activeTab.path
                : null
            }
            onActivate={handleActivateWorkspace}
            onEdit={handleEditWorkspace}
            onChange={updateWs}
            onPreviewColor={previewWsColor}
            onDelete={deleteWs}
            onMoveWorkspace={moveWs}
            onCreateWorkspaceGroup={createWorkspaceGroup}
            onChangeWorkspaceGroup={updateWorkspaceGroup}
            onReorderWorkspaceRailItem={reorderWorkspaceRailItem}
            onDeleteWorkspaceGroup={deleteWorkspaceGroup}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onCreateRemote={handleCreateRemote}
            onCreateCopyBranch={handleCreateCopyBranch}
            onSplitChange={panels.setRightSplit}
            onToggleSection={togglePanelSection}
            onMoveSection={movePanelSection}
            onSectionDragStart={handlePanelSectionDragStart}
            onSectionDragEnd={handlePanelSectionDragEnd}
            onOpenGitHubQueueItem={handleOpenGitHubQueueItem}
            onOpenFile={openFileByPath}
            onOpenFileEntry={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRunPlan={handleRunPlan}
            git={sharedGit}
            onOpenDiffTab={handleOpenDiffTab}
            activeDiffTarget={activeDiffTarget}
            onOpenDiffForPath={handleOpenDiffForPath}
            onAddExternalFolder={addExternalFolder}
            onRemoveExternalFolder={removeExternalFolder}
          />
          </div>
        )}

        {remoteConnectOpen && (
          <SshManagerDialog
            onClose={() => setRemoteConnectOpen(false)}
            onPick={(host, remotePath) => void createRemoteWs(host, remotePath)}
          />
        )}
        <RemoteAuthPrompt />

        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsDialog
              settings={settings}
              shells={shells}
              defaultShell={defaultShell}
              workspaceCwd={activeWorkspace?.copyBranch?.repoCwd ?? activeWorkspace?.cwd ?? null}
              onClose={closeSettings}
              onSave={handleSaveSettings}
              onOpenRun={handleSettingsOpenRun}
              onOpenWorkerSession={handleSettingsOpenWorkerSession}
            />
          </Suspense>
        )}

        {inspectorOpen && (
          <Suspense fallback={null}>
            <SessionInspector
              run={runs.find((r) => r.id === activeRunId) ?? null}
              onClose={closeInspector}
            />
          </Suspense>
        )}

        {capabilitiesOpen && (
          <Suspense fallback={null}>
            <AgentCapabilitiesDialog
              settings={settings}
              workspaceCwd={activeWorkspace?.cwd ?? null}
              workspaceId={activeWorkspace?.id ?? null}
              onClose={closeCapabilities}
              onSave={handleSaveSettings}
            />
          </Suspense>
        )}

        {shortcutsOpen ? <ShortcutsDialog onClose={closeShortcuts} /> : null}

        <WorkerSessionPicker
          request={workerSessionPicker}
          onClose={() => setWorkerSessionPicker(null)}
        />

        {runSwitcherOpen ? (
          <RunSwitcher
            runs={globalRuns.runs.filter(
              (r) => !r.automationId && !isBoardCardRun(r),
            )}
            workspaces={workspaces}
            onClose={() => setRunSwitcherOpen(false)}
            onSelectRun={handleSelectRunAnywhere}
          />
        ) : null}

        <SearchPanel
          open={searchOpen}
          cwd={activeWorkspace?.cwd ?? null}
          onClose={closeSearch}
          onOpenFile={handleSearchOpenFile}
        />

        <FileSearchPanel
          open={fileSearchOpen}
          cwd={activeWorkspace?.cwd ?? null}
          onClose={closeFileSearch}
          onOpenFile={handleSearchOpenFile}
        />

        <ToastHost
          navigateTo={navigateToNotifyTarget}
          resolveQuestion={resolveRunQuestion}
          activeView={activeNotificationView}
        />
        {awayDigest && (
          <AwayDigestCard
            digest={awayDigest}
            workspaces={workspaces}
            onSelectRun={(runId, workspaceId) => {
              handleSelectRunAnywhere(runId, workspaceId);
            }}
            onDismiss={() => setAwayDigest(null)}
          />
        )}
        {createCopyDialogWs && (
          <CreateCopyDialog
            workspace={createCopyDialogWs}
            busy={createCopyBusy}
            error={createCopyError}
            onDismissError={() => setCreateCopyError(null)}
            onClose={() => {
              if (!createCopyBusy) {
                setCreateCopyDialogWs(null);
                setCreateCopyError(null);
              }
            }}
            onCreateNew={(name) =>
              void createCopyBranchWs(createCopyDialogWs, { newBranch: name }).catch(
                () => undefined,
              )
            }
            onOpenBranch={(b) =>
              void createCopyBranchWs(createCopyDialogWs, {
                checkoutBranch: b.name,
                checkoutIsRemote: b.isRemote,
              }).catch(() => undefined)
            }
          />
        )}
        {pendingCopyDelete?.copyBranch && (
          <CopyBranchDeleteDialog
            workspaceName={pendingCopyDelete.name}
            branch={pendingCopyDelete.copyBranch.branch}
            busy={copyDeleteBusy}
            error={copyDeleteError}
            onCancel={() => {
              if (!copyDeleteBusy) {
                setPendingCopyDelete(null);
                setCopyDeleteError(null);
              }
            }}
            onConfirm={confirmCopyDelete}
          />
        )}
      </div>

      <StatusBar
        workspace={activeWorkspace}
        defaultShell={defaultShell}
        platform={platform}
        workerCount={workerCount}
      />
    </div>
    </SelectionRoutingProvider>
  );
}

// ── While-you-were-away digest ───────────────────────────────────────────────
//
// One dismissible card surfaced on focus-after-away (see the focus/blur effect
// in App). Lists every run that needs a reply (click → jump to it, switching
// workspace if needed) and rolls finished-unseen / still-working runs into a
// summary line. The done-unseen runs were already acknowledged via markRunSeen
// when this card was built, so the card is purely informational for them.
function AwayDigestCard({
  digest,
  workspaces,
  onSelectRun,
  onDismiss,
}: {
  digest: AwayDigest;
  workspaces: Workspace[];
  onSelectRun: (runId: string, workspaceId?: string) => void;
  onDismiss: () => void;
}) {
  const workspaceName = (workspaceId: string): string =>
    workspaces.find((w) => w.id === workspaceId)?.name ?? "workspace";

  const summaryBits: string[] = [];
  if (digest.doneUnseen.length > 0) {
    summaryBits.push(
      `${digest.doneUnseen.length} finished`,
    );
  }
  if (digest.working.length > 0) {
    summaryBits.push(`${digest.working.length} still working`);
  }

  return (
    <div
      className="spark-fade-in"
      style={{
        position: "fixed",
        top: 48,
        // Sit to the left of the toast column (which pins to right:16) so a
        // needs-you toast and this digest don't overlap when both are up.
        right: 16,
        zIndex: 1001,
        width: "min(360px, calc(100vw - 32px))",
      }}
    >
      <div
        className="spark-glass--strong"
        role="status"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "12px 14px",
          borderRadius: 8,
          fontFamily: "var(--font-sans)",
        }}
      >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "var(--ink)",
              letterSpacing: "0.02em",
            }}
          >
            While you were away
          </div>
          {summaryBits.length > 0 && (
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-dim, var(--muted))",
                lineHeight: 1.4,
                marginTop: 2,
              }}
            >
              {summaryBits.join(" · ")}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss digest"
          onClick={onDismiss}
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            color: "var(--muted)",
            cursor: "default",
            fontSize: 16,
            lineHeight: 1,
            padding: 4,
            marginTop: -2,
            marginRight: -4,
            borderRadius: 5,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--hover)";
            e.currentTarget.style.color = "var(--ink)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--muted)";
          }}
        >
          ×
        </button>
      </div>

      {digest.needsYou.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--muted)",
            }}
          >
            Needs you
          </div>
          {digest.needsYou.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelectRun(run.id, run.workspaceId)}
              style={{
                appearance: "none",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid transparent",
                background: "transparent",
                cursor: "pointer",
                color: "var(--ink)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  flex: "0 0 8px",
                  background: statusToneColor(describeRunStatus(run).tone),
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {run.title || "Untitled run"}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 11,
                    color: "var(--muted)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {workspaceName(run.workspaceId)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

// ── Workspace pane (tab strip + stacks) ──────────────────────────────────────

function visibleRunIdForTab(tab: Tab | null | undefined): string | null {
  if (!tab) return null;
  if (tab.kind === "chat") return isDraftChatTabId(tab.id) ? null : tab.id;
  return runOwnedTabRunId(tab);
}

function isTabVisibleForRun(tab: Tab, activeRunId: string | null): boolean {
  return !(
    tab.kind === "terminal" &&
    tab.scope?.kind === "workers" &&
    tab.scope.runId !== activeRunId
  );
}

// Filter for what the top tab strip displays. Top strip = chat + workspace
// tabs (editors, plain user terminals, user-opened previews). Anything
// run-owned moves inside the chat panel.
function isTopStripTab(tab: Tab): boolean {
  return !isRunOwnedTab(tab);
}

interface WorkspaceProps {
  tabs: ReturnType<typeof useTabs>;
  workspace: Workspace | null;
  // Ids of all existing workspaces — used to prune deleted workspaces from the
  // mounted-but-hidden terminal stacks (see terminalWorkspaceLayers).
  validWorkspaceIds: ReadonlySet<string>;
  shell: ShellInfo | null;
  terminalScrollbackLineLimit: number;
  runs: RunState[];
  runsWorkspaceId: string | null;
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  onDetectedUrl: (
    tabId: string,
    paneId: string,
    url: string,
    meta?: { replayed?: boolean },
  ) => void;
  onSparkOpenFile: (path: string) => void;
  // Shared git state for the diff tabs (see useSharedGitStatus in App).
  gitStatus: GitStatus | null;
  gitVersion: number;
  onGitChanged: () => void;
  // Editor save (manual or autosave) → immediate git refresh; content-only
  // writes never fire the fs watcher, so without this the diff tabs and
  // explorer decorations lag behind saves by up to the 10s poll.
  onFileSaved: (path: string) => void;
  onTerminalPaneExit: (
    tabId: string,
    paneId: string,
    info?: PtyExitInfo,
  ) => void;
  onPreviewUrlChange: (id: string, url: string) => void;
  onPaneCwd: (tabId: string, paneId: string, cwd: string) => void;
  onPaneActivity: (tabId: string, paneId: string) => void;
  onPaneUserInput: (tabId: string, paneId: string) => void;
  onPaneScrollback: (tabId: string, paneId: string, scrollback: string) => void;
  onTerminalPaneAgentState: (
    tabId: string,
    paneId: string,
    state: TerminalAgentForegroundState,
  ) => void;
  onTerminalPaneRuntimeState: (tabId: string, paneId: string, state: RuntimeState) => void;
  onOpenWorkerSessionPicker: (
    runtime: WorkerSessionRuntime,
    cwd: string | undefined,
    launch: WorkerSessionPickerRequest["launch"],
  ) => void;
  onNewTerminalTab: () => void;
  onNewPreviewTab: () => void;
  // Tab-strip "+" worker rows. They open the worker session picker for the
  // resolved workspace cwd, so the same row starts a new agent or resumes /
  // deletes one from this workspace's history.
  onNewClaudeWorker: () => void;
  onNewCodexWorker: () => void;
  onNewChat: () => void;
  // "Open chat" on a Cora Board card with a live run — App's run-selection
  // path, threaded down to the chat panel's embedded board sub-view.
  onOpenBoardCardRun: (runId: string) => void;
  onRenameChat: (id: TabId, title: string) => void;
  onCloseChat: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId?: string) => void;
  onReorderTab: (fromId: string, toId: string, position: "before" | "after") => void;
  onPinEditorTab: (id: TabId) => void;
  // Resolved "+" picker keybind hints, memoized in App so this stays
  // referentially stable across unrelated renders (keeps the memo intact).
  pickerHints: PickerHints;
  // Mirrors the closeTabsOnMiddleClick preference; threaded down to TabBar so a
  // middle-click on a tab closes it. Kept as a plain boolean prop (rather than
  // reading usePreferences inside Workspace) so the memo only re-renders when
  // this value actually flips.
  closeTabsOnMiddleClick: boolean;
}

// Memoized: every prop is either referentially stable (the `tabs` object,
// all the hoisted useCallback handlers) or a value that genuinely changes
// (runs, the active run id). So the memo skips re-renders driven
// by unrelated App state — e.g. a live workspace-color drag.
const Workspace = React.memo(function Workspace({
  tabs,
  workspace,
  validWorkspaceIds,
  shell,
  terminalScrollbackLineLimit,
  runs,
  runsWorkspaceId,
  activeRunId,
  onSelectRun,
  onRunSnapshot,
  onDetectedUrl,
  onSparkOpenFile,
  gitStatus,
  gitVersion,
  onGitChanged,
  onFileSaved,
  onTerminalPaneExit,
  onPreviewUrlChange,
  onPaneCwd,
  onPaneActivity,
  onPaneUserInput,
  onPaneScrollback,
  onTerminalPaneAgentState,
  onTerminalPaneRuntimeState,
  onOpenWorkerSessionPicker,
  onNewTerminalTab,
  onNewPreviewTab,
  onNewClaudeWorker,
  onNewCodexWorker,
  onNewChat,
  onOpenBoardCardRun,
  onRenameChat,
  onCloseChat,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
  pickerHints,
  closeTabsOnMiddleClick,
}: WorkspaceProps) {
  // Destructure the tabs methods we need. useTabs returns a memoized API whose
  // methods are stable for the hook's lifetime, so destructuring here gives us
  // truly stable references — meaning the useCallback wrappers below also stay
  // stable and the memoized children (TabBar/EditorStack/TerminalStack) keep
  // their React.memo intact across App renders.
  const {
    setActiveTab,
    closeTab,
    setDirty,
    addDraftChatTab,
    setActiveTerminalPane,
    setTerminalSplitRatio,
    splitTerminalPane,
    moveTerminalPane,
    closeTerminalPane,
    openTabInSplit,
    dockTabInTerminal,
    undockTab,
    toggleTerminalPaneZoom,
    openEditorTab,
    registerDispose,
    setLeafAgentSession,
    setLeafBootResumeConsumed,
    flushWorkspaceScrollbackNow,
  } = tabs;
  const visibleTabs = useMemo(
    () => tabs.tabs.filter((tab) => isTabVisibleForRun(tab, activeRunId)),
    [tabs.tabs, activeRunId],
  );
  const effectiveActiveId = useMemo(
    () => resolveEffectiveActiveId(tabs.activeId, visibleTabs),
    [tabs.activeId, visibleTabs],
  );
  useEffect(() => {
    if (!effectiveActiveId || tabs.activeId === effectiveActiveId) return;
    setActiveTab(effectiveActiveId);
  }, [effectiveActiveId, tabs.activeId, setActiveTab]);

  // Stable no-op for the mounted-but-hidden workspace stacks. Their pane
  // write-backs (exit / cwd / agent-state / scrollback / …) must NOT reach the
  // live tab store, which belongs to the ACTIVE workspace — routing a hidden
  // workspace's pane event there would corrupt the wrong workspace. None of
  // that metadata is visible while hidden, and most re-syncs on return: cwd
  // from the buffered OSCs flushed on the visible transition, and a still-
  // running agent's worker chip via the level-triggered re-detection on the
  // next footer repaint. The one gap (pre-existing — an unmounted workspace had
  // it too): an agent that EXITS while its workspace is hidden can leave a
  // stale "running" chip until the next launch, since re-detection only
  // re-detects a PRESENT agent. Routing exit-while-hidden correctly would mean
  // per-workspace write-backs — deliberately out of scope here.
  const noopTerminalCb = useCallback(() => {}, []);

  // One terminal layer per kept-alive workspace: the ACTIVE workspace driven by
  // the live tab store, plus every visited-or-bridge-initialized inactive
  // workspace driven by its frozen layout. Rendering them all mounted (only the
  // active one visible) is what keeps each workspace's xterm — colors,
  // alt-screen TUI frame, real scrollback — alive across a switch, instead of
  // disposing it and replaying a lossy gray text snapshot. Keyed AND sorted by
  // workspaceId so React preserves each stack's instance (and its live PTYs)
  // as it moves between the active and hidden roles. The active layer is keyed
  // off `tabsWorkspaceId` (not App's activeId) so its key always agrees with
  // `tabs.tabs`, which lags by one render during a switch.
  const terminalWorkspaceLayers = useMemo(() => {
    const layers: Array<{ workspaceId: string; active: boolean; tabs: Tab[] }> = [];
    const seen = new Set<string>();
    const activeWorkspaceId = tabs.tabsWorkspaceId;
    if (activeWorkspaceId) {
      layers.push({ workspaceId: activeWorkspaceId, active: true, tabs: tabs.tabs });
      seen.add(activeWorkspaceId);
    }
    for (const layout of tabs.inactiveWorkspaceLayouts) {
      if (seen.has(layout.workspaceId)) continue;
      if (!validWorkspaceIds.has(layout.workspaceId)) continue; // pruned: deleted
      layers.push({ workspaceId: layout.workspaceId, active: false, tabs: layout.tabs });
      seen.add(layout.workspaceId);
    }
    layers.sort((a, b) =>
      a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
    );
    return layers;
  }, [tabs.tabsWorkspaceId, tabs.tabs, tabs.inactiveWorkspaceLayouts, validWorkspaceIds]);

  // Tabs the top strip renders: chat + workspace-level tabs only. Run-owned
  // tabs (workers, Runs, run-tagged previews) are surfaced inside the chat
  // panel's inner tab strip instead.
  // tabId -> the terminal cell lending it geometry. Derived from the pane
  // trees (the only source of truth), so a docked tab can never drift out of
  // sync with the grid it lives in.
  const dockIndex = useMemo(() => buildDockIndex(visibleTabs), [visibleTabs]);

  // A docked tab has no pill: it is visible inside its host's grid, and a
  // second entry point would let the user "select" it into a full-window view
  // that hides the very grid it is sitting in.
  // The one chat (if any) currently docked into a terminal grid. Its backend
  // terminal layer follows the cell instead of the workbench.
  const dockedChatTabId = useMemo(() => {
    for (const tab of visibleTabs) {
      if (tab.kind === "chat" && dockIndex.has(tab.id)) return tab.id;
    }
    return null;
  }, [visibleTabs, dockIndex]);

  const topStripTabs = useMemo(
    () => visibleTabs.filter((tab) => isTopStripTab(tab) && !dockIndex.has(tab.id)),
    [visibleTabs, dockIndex],
  );

  // Lifted from ChatPanel so the hoisted inner tab strip can drive the chat /
  // backend-PTY view toggle without ChatPanel keeping a separate state.
  // When the owning chat changes, useChatSurfaces below restores that chat's
  // remembered sub-view (a chat never visited before starts on "chat").
  const [chatView, setChatView] = useState<CoraView>("chat");
  // One-shot override for that restore: board.open may have to focus a
  // DIFFERENT chat tab (or a fresh draft) first, and that tab switch changes
  // activeRunId / the owning chat a commit later — without the marker, the
  // restore would stomp the just-requested "board" view. The marker is set
  // ONLY when the handler knows such a change is coming, so it is always
  // consumed by exactly that restore pass (inside useChatSurfaces).
  const pendingBoardViewRef = useRef(false);

  // Tabs owned by the active run, grouped by kind. These power the inner tab
  // strip: Runs section and preview entries. Worker terminals stay run-owned,
  // but are entered directly from the worker nodes on the Runs canvas.
  const runOwnedTabs = useMemo(() => {
    if (!activeRunId) {
      return { runs: null as RunsTab | null, previews: [] as PreviewTab[] };
    }
    let runsTab: RunsTab | null = null;
    const previews: PreviewTab[] = [];
    for (const tab of tabs.tabs) {
      if (tab.kind === "runs" && tab.runId === activeRunId) {
        runsTab = tab;
      } else if (tab.kind === "preview" && tab.runId === activeRunId) {
        previews.push(tab);
      }
    }
    return { runs: runsTab, previews };
  }, [tabs.tabs, activeRunId]);

  // Is there anything to show in the inner tab strip? The Chat / Terminal
  // toggle appears once the chat has at least one message (its backend PTY
  // session id is known). Runs / preview pills appear when the active run has
  // spawned that artifact. When none of these is true the
  // inner strip stays hidden.
  //
  // But artifacts existing is not enough: the strip is the chat tab's own
  // sub-navigation, so it must only render while the active view actually
  // belongs to the run. activeRunId stays pinned to a background run when the
  // user switches to a plain terminal/editor/preview tab (selecting those tabs
  // doesn't clear it), so gating on activeRunId alone leaked the strip under
  // every unrelated tab. Require the active tab to be the run's own chat tab
  // (its id equals the run id) or one of its run-owned children (worker
  // terminal / Runs canvas / run preview) that belongs to THIS run — a
  // run-owned tab owned by a different run (reachable by keyboard tab-cycling,
  // since previews/Runs tabs aren't run-filtered out of visibleTabs) must not
  // show the active run's strip over another run's surface.
  //
  // activeChatTabId is the chat tab whose run owns the current view —
  // either the chat tab whose id matches activeRunId, or (if no run is
  // selected and the user is on a draft) the active draft chat tab. The
  // inner strip uses this to route "Chat" / "Terminal" pill clicks back to
  // the right chat tab regardless of which run-owned sub-tab is active.
  const activeChatTabId = useMemo(() => {
    if (activeRunId) {
      const matching = topStripTabs.find(
        (tab) => tab.kind === "chat" && tab.id === activeRunId,
      );
      if (matching) return matching.id;
    }
    const activeTab = tabs.activeTab;
    if (activeTab?.kind === "chat") return activeTab.id;
    return null;
  }, [activeRunId, topStripTabs, tabs.activeTab]);
  const activeRunForStrip = useMemo(
    () => (activeRunId ? runs.find((run) => run.id === activeRunId) ?? null : null),
    [runs, activeRunId],
  );
  // Same escape for the Whiteboard view: it is run-scoped, so on a draft chat
  // (no run) it would render the welcome state with the composer hidden. The
  // strip hides the whiteboard affordances on drafts (whiteboardCreatable),
  // so this is a safety net for stale state, e.g. a run deleted from history
  // while its whiteboard was open. Bounce to chat.
  useEffect(() => {
    if (chatView === "whiteboard" && !activeRunForStrip) {
      setChatView("chat");
    }
  }, [chatView, activeRunForStrip]);
  const activeTabForStrip = useMemo(
    () => visibleTabs.find((tab) => tab.id === effectiveActiveId) ?? null,
    [visibleTabs, effectiveActiveId],
  );
  // Per-chat memory of the last explicitly chosen sub-surface (CoraView pill
  // or run-owned tab like the worker terminal grid), plus the routing that
  // restores it when the user returns to the chat tab. All user-driven view
  // changes below go through changeChatView so the memory stays current; the
  // two escape effects above keep the raw setter on purpose — they are
  // corrective bounces, not user choices, and must not overwrite what the
  // user actually picked.
  const { changeChatView, rememberChatView, selectTopStripTab } = useChatSurfaces({
    activeChatTabId,
    activeRunId,
    activeTabForStrip,
    visibleTabs,
    setActiveTab,
    setChatView,
    pendingBoardViewRef,
  });
  const activeViewBelongsToRun =
    Boolean(activeRunId) &&
    activeTabForStrip != null &&
    (runOwnedTabRunId(activeTabForStrip) === activeRunId ||
      (activeTabForStrip.kind === "chat" &&
        activeTabForStrip.id === activeRunId));
  // A DRAFT chat (no run yet) shows the strip too: the Board sub-view is
  // workspace-scoped, so the Board pill must be reachable before the first
  // message ever sends — the user can start a chat purely to work the kanban.
  // Run-scoped pills (Runs / Terminal / Whiteboard) hide themselves on drafts
  // through their own availability gates, so the strip stays honest. The
  // chatView === "board" clause covers the one non-draft gap: board.open
  // landing on a run-backed chat tab whose activeRunId hasn't committed yet.
  const innerStripVisible =
    activeViewBelongsToRun ||
    (activeTabForStrip?.kind === "chat" &&
      (chatView === "board" || isDraftChatTabId(activeTabForStrip.id)));
  const handleInnerChatClick = useCallback(() => {
    changeChatView("chat");
    if (activeChatTabId) setActiveTab(activeChatTabId);
  }, [activeChatTabId, setActiveTab, changeChatView]);
  const handleBackToRuns = useCallback(() => {
    if (runOwnedTabs.runs) {
      setActiveTab(runOwnedTabs.runs.id);
      return;
    }
    changeChatView("chat");
    if (activeChatTabId) setActiveTab(activeChatTabId);
  }, [activeChatTabId, runOwnedTabs.runs, setActiveTab, changeChatView]);
  const handleInnerWhiteboardClick = useCallback(() => {
    changeChatView("whiteboard");
    if (activeChatTabId) setActiveTab(activeChatTabId);
  }, [activeChatTabId, setActiveTab, changeChatView]);
  const handleInnerBoardClick = useCallback(() => {
    changeChatView("board");
    if (activeChatTabId) setActiveTab(activeChatTabId);
  }, [activeChatTabId, setActiveTab, changeChatView]);
  // board.open chord (broadcast from App's shortcut handler): focus the active
  // chat's Board sub-view. When the active tab isn't a chat, surface one first
  // — the selected run's own chat tab if it exists, else the most recent chat
  // tab in the strip, else a fresh draft — then land it on Board. When that
  // focus will change activeRunId (a later commit), arm pendingBoardViewRef so
  // the run-change reset lands on "board" instead of stomping it.
  useEffect(() => {
    const handler = () => {
      if (activeTabForStrip?.kind === "chat") {
        changeChatView("board");
        return;
      }
      const chatTabs = topStripTabs.filter((tab) => tab.kind === "chat");
      const target =
        (activeRunId && chatTabs.find((tab) => tab.id === activeRunId)) ||
        chatTabs[chatTabs.length - 1] ||
        null;
      const nextRunId =
        target && !isDraftChatTabId(target.id) ? target.id : null;
      // Arm the one-shot marker whenever the surface restore in
      // useChatSurfaces WILL fire for this focus change (activeRunId changes,
      // or the owning chat tab changes — including a fresh draft). When
      // neither changes the restore never runs, so record the choice directly
      // instead; a lingering marker would hijack a later, unrelated restore.
      const restoreWillFire =
        nextRunId !== activeRunId || (target ? target.id !== activeChatTabId : true);
      if (restoreWillFire) {
        pendingBoardViewRef.current = true;
        setChatView("board");
      } else {
        changeChatView("board");
      }
      if (target) setActiveTab(target.id);
      else addDraftChatTab();
    };
    window.addEventListener("spark:open-cora-board", handler);
    return () => window.removeEventListener("spark:open-cora-board", handler);
  }, [
    activeTabForStrip,
    topStripTabs,
    activeRunId,
    activeChatTabId,
    setActiveTab,
    addDraftChatTab,
    changeChatView,
  ]);
  // "Open chat" from a card of the embedded board: leave the Board sub-view
  // for the run's conversation ourselves — when the card's run is ALREADY the
  // active one, activeRunId doesn't change and the run-change restore would
  // never fire, leaving the user staring at the board they just left. The
  // TARGET run's memory is pinned to "chat" too (its tab id === run id):
  // "Open chat" must land on the conversation even when that chat's last
  // surface was its board or worker grid.
  const handleOpenBoardCardRunInChat = useCallback(
    (runId: string) => {
      rememberChatView(runId, "chat");
      setChatView("chat");
      onOpenBoardCardRun(runId);
    },
    [onOpenBoardCardRun, rememberChatView],
  );
  // First card mutation on a DRAFT chat's board: mint the run WITHOUT starting
  // autopilot, persist the cards on its board, then promote the draft tab via
  // the same snapshot path a first message uses. The user is looking at the
  // board, so the activeRunId-change chatView reset must land back on "board"
  // (pendingBoardViewRef) instead of bouncing them to the welcome chat.
  const handleCreateBoardRun = useCallback(
    async (cards: BoardCard[]) => {
      if (!workspace) throw new Error("No workspace is active.");
      const api = boardBackend();
      if (!api) throw new Error("The board backend isn't available in this build.");
      // Carry the draft composer's live chip selections onto the minted run,
      // exactly like a first send would — without this the promoted chat
      // silently flips back to the backend defaults. The draft key mirrors
      // ChatStack's composerDraftKey ("workspaceId:tabId").
      const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeId);
      const chip =
        activeTab && activeTab.kind === "chat"
          ? peekChatComposerChipConfig(`${workspace.id}:${activeTab.id}`)
          : undefined;
      const run = await window.spark.orchestration.createRun({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        title: cards[0]?.title ? cards[0].title.slice(0, 52) : undefined,
        chatBackend: chip?.backend,
        chatModel: chip?.model,
        chatEffort: chip?.effort,
      });
      await api.update({
        runId: run.id,
        baseRevision: 0,
        cards,
        workspaceCwd: workspace.cwd,
      });
      const fresh = await window.spark.orchestration.getRun(run.id).catch(() => null);
      pendingBoardViewRef.current = true;
      onRunSnapshot(fresh ?? run, { select: true, focusRuns: false });
    },
    [workspace, onRunSnapshot, tabs.tabs, tabs.activeId],
  );
  // The Whiteboard pill exists only while this chat actually has a board —
  // an unused surface must not clutter the workbench strip.
  const whiteboardAvailable = Boolean(activeRunForStrip?.whiteboard);
  // Attention dot: Cora updated the board while the user was looking at
  // another surface. Baselined per run on first sight so history never
  // badges; visiting the whiteboard (or any non-Cora edit) marks it seen.
  const whiteboardRevision = activeRunForStrip?.whiteboard?.revision ?? null;
  const whiteboardEditor = activeRunForStrip?.whiteboard?.lastEditedBy ?? null;
  const [whiteboardAttention, setWhiteboardAttention] = useState(false);
  const seenWhiteboardRevisionRef = useRef<Map<string, number>>(new Map());
  const attentionRunRef = useRef<string | null>(null);
  useEffect(() => {
    // On the commit where the active run just changed, chatView still belongs
    // to the previous run (its reset lands one commit later) — a stale
    // "whiteboard" view must not mark the new run's board as seen.
    const runJustChanged = attentionRunRef.current !== activeRunId;
    attentionRunRef.current = activeRunId;
    if (!activeRunId || !activeRunForStrip) {
      setWhiteboardAttention(false);
      return;
    }
    const seenMap = seenWhiteboardRevisionRef.current;
    if (!seenMap.has(activeRunId)) {
      seenMap.set(activeRunId, whiteboardRevision ?? -1);
      setWhiteboardAttention(false);
      return;
    }
    if (whiteboardRevision === null) {
      seenMap.set(activeRunId, -1);
      setWhiteboardAttention(false);
      return;
    }
    // A revision below the seen baseline means the board was cleared and
    // rebuilt from scratch (revisions restart at 1) — an entirely new board
    // deserves attention like any other unseen update.
    if (whiteboardRevision < (seenMap.get(activeRunId) ?? -1)) {
      seenMap.set(activeRunId, -1);
    }
    const viewingWhiteboard =
      chatView === "whiteboard" && effectiveActiveId === activeChatTabId && !runJustChanged;
    if (viewingWhiteboard || whiteboardEditor !== "cora") {
      seenMap.set(activeRunId, whiteboardRevision);
      setWhiteboardAttention(false);
      return;
    }
    setWhiteboardAttention(whiteboardRevision > (seenMap.get(activeRunId) ?? -1));
  }, [
    activeRunId,
    activeRunForStrip,
    whiteboardRevision,
    whiteboardEditor,
    chatView,
    effectiveActiveId,
    activeChatTabId,
  ]);
  const handleInnerSelectTab = useCallback(
    (id: TabId) => setActiveTab(id),
    [setActiveTab],
  );
  // A docked chat's own sub-navigation, rendered INSIDE its cell by ChatStack.
  //
  // The workbench-level strip keys off the active tab, and a docked chat is
  // never the active tab (its host terminal is) — so docking a chat silently
  // stripped it of Chat / Kanban / Runs / Terminal and left the conversation
  // as the only reachable surface. The strip belongs to the chat, so when the
  // chat moves into a cell it moves with it.
  //
  // These handlers deliberately drop the setActiveTab half of their
  // workbench-level twins: selecting a docked tab would "activate" a tab that
  // has no workbench slot, blanking the center while the cell keeps painting.
  // Flipping the view is the whole job here. Runs / preview pills still route
  // through handleInnerSelectTab — those are real tabs of their own.
  const handleDockedChatClick = useCallback(() => changeChatView("chat"), [changeChatView]);
  const handleDockedWhiteboardClick = useCallback(
    () => changeChatView("whiteboard"),
    [changeChatView],
  );
  const handleDockedBoardClick = useCallback(() => changeChatView("board"), [changeChatView]);
  // Returns whether a pane was actually focused, so callers with their own
  // notice surface (the board's card button) can explain a miss — a finished
  // worker's pane does not survive an app restart. The Runs Inspector ignores
  // the return value.
  const handleOpenWorkerTerminal = useCallback(
    (workerTaskId: string): boolean => {
      if (!activeRunId) return false;
      const workerTab = tabs.tabs.find(
        (tab): tab is TerminalTab =>
          tab.kind === "terminal" &&
          tab.scope?.kind === "workers" &&
          tab.scope.runId === activeRunId,
      );
      if (!workerTab) return false;
      const leaf = findWorkerLeafByTaskId(workerTab.root, workerTaskId);
      if (!leaf) return false;
      setActiveTerminalPane(workerTab.id, leaf.paneId);
      setActiveTab(workerTab.id);
      return true;
    },
    [activeRunId, tabs.tabs, setActiveTab, setActiveTerminalPane],
  );
  // When the underlying active tab is run-owned, the top strip should still
  // highlight the chat that owns it so the user keeps a "you're inside this
  // chat" anchor while viewing a worker / Runs / preview.
  const topStripActiveId = useMemo(
    () => resolveTopStripActiveId(effectiveActiveId, visibleTabs, topStripTabs),
    [effectiveActiveId, visibleTabs, topStripTabs],
  );

  // Top-strip selection routes through the chat-surface layer: clicking a
  // chat pill restores that chat's remembered run-owned surface (worker grid
  // / Runs canvas), or reads as the exit-to-conversation gesture when one of
  // its surfaces is already on screen.
  const handleTabSelect = selectTopStripTab;
  const handleTabClose = useCallback(
    (id: TabId) => closeTab(id),
    [closeTab],
  );
  const handleEditorDirty = useCallback(
    (id: TabId, dirty: boolean) => setDirty(id, dirty),
    [setDirty],
  );
  const handleSparkOpen = useCallback(
    (input: { file: string }) => onSparkOpenFile(input.file),
    [onSparkOpenFile],
  );
  const handlePaneExit = useCallback(
    (tabId: string, paneId: string, info: PtyExitInfo) =>
      onTerminalPaneExit(tabId, paneId, info),
    [onTerminalPaneExit],
  );
  const handleActivatePane = useCallback(
    (tabId: string, paneId: string) => setActiveTerminalPane(tabId, paneId),
    [setActiveTerminalPane],
  );
  const handleSplitRatioChange = useCallback(
    (tabId: string, path: Parameters<typeof setTerminalSplitRatio>[1], ratio: number) =>
      setTerminalSplitRatio(tabId, path, ratio),
    [setTerminalSplitRatio],
  );
  const handleSplitPane = useCallback(
    (
      tabId: string,
      paneId: string,
      direction: Parameters<typeof splitTerminalPane>[2],
      autorun?: string,
      agentSession?: TerminalAgentSession | null,
    ) => {
      return splitTerminalPane(tabId, paneId, direction, autorun, agentSession);
    },
    [splitTerminalPane],
  );
  const handleMovePane = useCallback(
    (
      payload: TerminalPaneDragPayload,
      targetTabId: string,
      target?: Parameters<typeof moveTerminalPane>[3],
    ) => moveTerminalPane(payload.tabId, payload.paneId, targetTabId, target),
    [moveTerminalPane],
  );
  const handleClosePane = useCallback(
    (tabId: string, paneId: string) => closeTerminalPane(tabId, paneId),
    [closeTerminalPane],
  );
  const handlePaneZoomToggle = useCallback(
    (tabId: string, paneId: string) => toggleTerminalPaneZoom(tabId, paneId),
    [toggleTerminalPaneZoom],
  );
  // Each hidden kept-alive terminal layer needs a flush callback bound to its
  // own workspaceId. An inline arrow per layer would change identity every App
  // render and defeat TerminalStack's memo, so cache one closure per workspace
  // (flushWorkspaceScrollbackNow is stable, so cached closures never go stale;
  // the map is bounded by the workspaces mounted this session).
  const hiddenFlushScrollbackFnsRef = useRef(
    new Map<
      string,
      (entries: Array<{ tabId: TabId; paneId: string; text: string }>) => void
    >(),
  );
  const flushScrollbackForHiddenLayer = (workspaceId: string) => {
    const cache = hiddenFlushScrollbackFnsRef.current;
    let fn = cache.get(workspaceId);
    if (!fn) {
      fn = (entries) => flushWorkspaceScrollbackNow(workspaceId, entries);
      cache.set(workspaceId, fn);
    }
    return fn;
  };
  // "+ → Browser pane": create the preview and dock it into the same grid in
  // one batch. The empty URL is the same starting point the top-strip picker
  // uses (tabs.newPreviewTab("")), so the pane opens on the address bar.
  const handleAddBrowserPane = useCallback(
    (
      hostTabId: string,
      target: { paneId: string; direction: "horizontal" | "vertical" } | null,
    ) => {
      const previewId = tabs.newPreviewTab("", { focus: false });
      dockTabInTerminal(
        previewId,
        hostTabId,
        target ? { ...target, position: "after", mode: "split" } : undefined,
      );
    },
    [tabs, dockTabInTerminal],
  );
  const handleDockTabDrop = useCallback(
    (
      dockedTabId: string,
      hostTabId: string,
      target: {
        paneId: string;
        direction: "horizontal" | "vertical";
        position: "before" | "after";
        mode: "split" | "line";
      },
    ) => {
      dockTabInTerminal(dockedTabId, hostTabId, target);
    },
    [dockTabInTerminal],
  );
  // Menu route into the grid: no drag, so useTabs resolves the host (the grid
  // on screen, else a container minted around the surface the user is looking
  // at) and places the cell itself.
  const handleOpenInSplit = useCallback(
    (dockedTabId: string) => {
      openTabInSplit(dockedTabId);
    },
    [openTabInSplit],
  );
  const handleUndockTab = useCallback(
    (dockedTabId: string) => undockTab(dockedTabId, { focus: true }),
    [undockTab],
  );
  // The × on a dock cell closes the TAB (same meaning it has everywhere else);
  // undocking is the separate, non-destructive control beside it.
  const handleCloseDockedTab = useCallback(
    (dockedTabId: string) => closeTab(dockedTabId),
    [closeTab],
  );

  // Safety net for dock cells whose tab disappeared without going through
  // closeTab — a chat tab dropped by syncChatTabsToRuns when its run is
  // archived, say. Only runs when a reference is genuinely dangling.
  useEffect(() => {
    for (const [dockedTabId] of dockIndex) {
      if (visibleTabs.some((tab) => tab.id === dockedTabId)) continue;
      if (tabs.tabs.some((tab) => tab.id === dockedTabId)) continue;
      undockTab(dockedTabId);
    }
  }, [dockIndex, visibleTabs, tabs.tabs, undockTab]);
  // A restored pane's `--resume` probe found no transcript on disk (pruned, or
  // the session id went stale). Clear the dead pointer so the pane stops trying
  // to resume it AND so a future launch in this pane can capture a fresh session
  // — without this, a single failed restore stranded the pointer permanently and
  // the pane could never self-heal.
  const handleLeafResumeUnavailable = useCallback(
    (tabId: string, paneId: string) => {
      setLeafAgentSession(tabId, paneId, null);
    },
    [setLeafAgentSession],
  );
  // A failed Claude restore self-healed: the pane launched a FRESH forced-id
  // session (buildClaudeLaunch) in the same cwd. Persist the replacement
  // pointer so the next reopen resumes the new conversation instead of the
  // dead one.
  const handleLeafResumeFallback = useCallback(
    (tabId: string, paneId: string, session: TerminalAgentSession) => {
      setLeafAgentSession(tabId, paneId, session);
    },
    [setLeafAgentSession],
  );
  // A restored pane's first mount made its boot-restore attempt (whatever the
  // outcome) — clear the one-shot hydration marker so no later remount of the
  // pane auto-resumes again.
  const handleLeafBootResumeConsumed = useCallback(
    (tabId: string, paneId: string) => {
      setLeafBootResumeConsumed(tabId, paneId);
    },
    [setLeafBootResumeConsumed],
  );
  // First save of an untitled whiteboard draft: rebind by swapping the draft
  // tab for a regular editor tab on the saved .coraboard file (openEditorTab
  // dedupes by path, so a later explorer click lands on this same tab). The
  // swap runs on a fresh tick: openEditorTab captures the new tab's id inside
  // its setTabs updater, which React only evaluates eagerly when it is the
  // FIRST queued update — the save path has already queued dirty/git updates
  // this tick, and a missed capture would leave the new tab unfocused and let
  // closeTab reroute to an unrelated neighbor. Open before close so the
  // editor is already active when the draft goes away (no reroute flicker).
  const handleWhiteboardSavedAs = useCallback(
    (id: TabId, path: string) => {
      window.setTimeout(() => {
        openEditorTab(entryFromPath(path));
        closeTab(id);
      }, 0);
    },
    [openEditorTab, closeTab],
  );

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <TabBar
        tabs={topStripTabs}
        activeId={topStripActiveId}
        onSelect={handleTabSelect}
        onClose={handleTabClose}
        onNewTerminal={onNewTerminalTab}
        onNewPreview={onNewPreviewTab}
        onNewClaudeWorker={onNewClaudeWorker}
        onNewCodexWorker={onNewCodexWorker}
        onNewChat={onNewChat}
        onRenameChat={onRenameChat}
        onCloseChat={onCloseChat}
        onTerminalPaneDrop={onTerminalPaneDrop}
        onReorderTab={onReorderTab}
        onPinEditorTab={onPinEditorTab}
        onOpenInSplit={handleOpenInSplit}
        pickerHints={pickerHints}
        closeOnMiddleClick={closeTabsOnMiddleClick}
        workspaceId={workspace?.id ?? null}
      />
      {innerStripVisible && (
        <InnerTabStrip
          activeId={effectiveActiveId}
          activeChatTabId={activeChatTabId}
          chatView={chatView}
          whiteboardAvailable={whiteboardAvailable}
          whiteboardCreatable={Boolean(activeRunForStrip)}
          whiteboardAttention={whiteboardAttention}
          runsTab={runOwnedTabs.runs}
          previews={runOwnedTabs.previews}
          onChatClick={handleInnerChatClick}
          onWhiteboardClick={handleInnerWhiteboardClick}
          onBoardClick={handleInnerBoardClick}
          onSelectTab={handleInnerSelectTab}
        />
      )}
      <div style={{ flex: 1, position: "relative", minWidth: 0, minHeight: 0 }}>
        {/* Also when effectiveActiveId is null with tabs present: every
            remaining tab is run-owned with no owning chat open (nothing is
            eligible to activate), and the empty state beats a blank void. */}
        {(visibleTabs.length === 0 || !effectiveActiveId) && (
          <EmptyWorkbench onNewChat={onNewChat} onNewTerminal={onNewTerminalTab} />
        )}
        <ChatStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          dockIndex={dockIndex}
          dockedStrip={
            dockedChatTabId ? (
              <InnerTabStrip
                activeId={dockedChatTabId}
                activeChatTabId={dockedChatTabId}
                chatView={chatView}
                whiteboardAvailable={whiteboardAvailable}
                whiteboardCreatable={Boolean(activeRunForStrip)}
                whiteboardAttention={whiteboardAttention}
                runsTab={runOwnedTabs.runs}
                previews={runOwnedTabs.previews}
                onChatClick={handleDockedChatClick}
                onWhiteboardClick={handleDockedWhiteboardClick}
                onBoardClick={handleDockedBoardClick}
                onSelectTab={handleInnerSelectTab}
              />
            ) : null
          }
          workspace={workspace}
          tabsWorkspaceId={tabs.tabsWorkspaceId}
          validWorkspaceIds={validWorkspaceIds}
          runs={runs}
          runsWorkspaceId={runsWorkspaceId}
          activeRunId={activeRunId}
          chatView={chatView}
          onChatViewChange={changeChatView}
          onOpenBoardCardRun={handleOpenBoardCardRunInChat}
          onOpenBoardWorkerTerminal={handleOpenWorkerTerminal}
          onCreateBoardRun={handleCreateBoardRun}
          onSelectRun={onSelectRun}
          onRunSnapshot={onRunSnapshot}
        />
        {visibleTabs.some((tab) => tab.kind === "editor") && (
          <Suspense fallback={null}>
            <EditorStack
              tabs={visibleTabs}
              activeId={effectiveActiveId}
              dockIndex={dockIndex}
              onDirtyChange={handleEditorDirty}
              onClose={handleTabClose}
              onSaved={onFileSaved}
            />
          </Suspense>
        )}
        <DiffStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          dockIndex={dockIndex}
          cwd={workspace?.cwd ?? null}
          status={gitStatus}
          gitVersion={gitVersion}
          onOpenFile={onSparkOpenFile}
          onChanged={onGitChanged}
          onCloseTab={handleTabClose}
        />
        {/* One mounted TerminalStack per kept-alive workspace. Only the active
            one is visible/interactive; the rest stay mounted-but-hidden so
            their live xterms + PTYs survive a workspace switch (no dispose, no
            lossy gray snapshot/replay). Hidden stacks get null activeId (every
            pane is non-interactive) but continue writing into their in-memory
            xterm buffers; no-op write-backs keep them from corrupting the active
            workspace's tab store. */}
        {terminalWorkspaceLayers.map((layer) => {
          const isActive = layer.active;
          return (
            <div
              key={layer.workspaceId}
              style={{
                position: "absolute",
                inset: 0,
                visibility: isActive ? "visible" : "hidden",
                // Always none — this layer paints above ChatStack, so enabling
                // pointer events here would let its empty space swallow clicks
                // aimed at the chat surface below (dead composer buttons).
                // TerminalStack keeps its own root at pointer-events:none and
                // each visible terminal-tab wrapper re-enables auto for itself.
                pointerEvents: "none",
              }}
            >
              <TerminalStack
                tabs={layer.tabs}
                activeId={isActive ? effectiveActiveId : null}
                workspaceVisible={isActive}
                shell={shell}
                scrollbackLineLimit={terminalScrollbackLineLimit}
                onDetectedUrl={isActive ? onDetectedUrl : noopTerminalCb}
                onSparkOpen={isActive ? handleSparkOpen : noopTerminalCb}
                onPaneExit={isActive ? handlePaneExit : noopTerminalCb}
                onActivatePane={isActive ? handleActivatePane : noopTerminalCb}
                onSplitRatioChange={isActive ? handleSplitRatioChange : noopTerminalCb}
                onSplitPane={isActive ? handleSplitPane : noopTerminalCb}
                onMovePane={isActive ? handleMovePane : noopTerminalCb}
                onClosePane={isActive ? handleClosePane : noopTerminalCb}
                onAddBrowserPane={isActive ? handleAddBrowserPane : noopTerminalCb}
                onDockTabDrop={isActive ? handleDockTabDrop : noopTerminalCb}
                onUndockTab={isActive ? handleUndockTab : noopTerminalCb}
                onCloseDockedTab={isActive ? handleCloseDockedTab : noopTerminalCb}
                onTabZoomToggle={isActive ? handlePaneZoomToggle : noopTerminalCb}
                onPaneCwd={isActive ? onPaneCwd : noopTerminalCb}
                onPaneActivity={isActive ? onPaneActivity : noopTerminalCb}
                onPaneUserInput={isActive ? onPaneUserInput : noopTerminalCb}
                onPaneScrollback={isActive ? onPaneScrollback : noopTerminalCb}
                onFlushScrollback={
                  isActive
                    ? tabs.flushScrollbackNow
                    : flushScrollbackForHiddenLayer(layer.workspaceId)
                }
                onPaneAgentState={isActive ? onTerminalPaneAgentState : noopTerminalCb}
                onPaneRuntimeState={isActive ? onTerminalPaneRuntimeState : noopTerminalCb}
                onOpenWorkerSessionPicker={
                  isActive ? onOpenWorkerSessionPicker : noopTerminalCb
                }
                onPaneResumeUnavailable={isActive ? handleLeafResumeUnavailable : noopTerminalCb}
                onPaneResumeFallback={isActive ? handleLeafResumeFallback : noopTerminalCb}
                onPaneBootResumeConsumed={isActive ? handleLeafBootResumeConsumed : noopTerminalCb}
                onBackToRuns={isActive ? handleBackToRuns : noopTerminalCb}
              />
            </div>
          );
        })}
        <PreviewStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          dockIndex={dockIndex}
          onUrlChange={onPreviewUrlChange}
        />
        {visibleTabs.some((tab) => tab.kind === "runs") && (
          <Suspense fallback={null}>
            <RunsStack
              tabs={visibleTabs}
              activeId={effectiveActiveId}
              workspace={workspace}
              runs={runs}
              runsWorkspaceId={runsWorkspaceId}
              activeRunId={activeRunId}
              onSelectRun={onSelectRun}
              onOpenWorkerTerminal={handleOpenWorkerTerminal}
            />
          </Suspense>
        )}
        {visibleTabs.some((tab) => tab.kind === "automations") && (
          <Suspense fallback={null}>
            <AutomationsStack
              tabs={visibleTabs}
              activeId={effectiveActiveId}
              dockIndex={dockIndex}
              workspace={workspace}
              onOpenRunChat={handleOpenBoardCardRunInChat}
            />
          </Suspense>
        )}
        {visibleTabs.some((tab) => tab.kind === "usage") && (
          <Suspense fallback={null}>
            <UsageStack
              tabs={visibleTabs}
              activeId={effectiveActiveId}
              dockIndex={dockIndex}
            />
          </Suspense>
        )}
        {visibleTabs.some((tab) => tab.kind === "whiteboard") && (
          <Suspense fallback={null}>
            <WhiteboardStack
              tabs={visibleTabs}
              activeId={effectiveActiveId}
              dockIndex={dockIndex}
              workspacePath={workspace?.cwd ?? null}
              registerDispose={registerDispose}
              onSavedAs={handleWhiteboardSavedAs}
              onSaved={onFileSaved}
            />
          </Suspense>
        )}
        {/* The legacy hidden orchestration TerminalGrid was removed: worker
            PTYs now spawn inside the user-visible TerminalStack via the
            launch_requested claim flow in App.tsx. This means worker
            output is watchable, and one PTY surface (TerminalStack) carries
            both user shells and worker shells. */}
      </div>
    </div>
  );
});

// Memoized: its sole prop `onCreate` is a stable useCallback, so this static
// empty-state view never re-renders once mounted.
const NoWorkspace = React.memo(function NoWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        background: "var(--bg)",
        backgroundImage:
          "radial-gradient(circle, var(--rule-soft) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        color: "var(--muted)",
        padding: 32,
        textAlign: "center",
      }}
    >
      <div className="spark-eyebrow" style={{ marginBottom: 2 }}>
        No workspace
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 24,
          fontWeight: 700,
          color: "var(--ink)",
          letterSpacing: "-0.005em",
        }}
      >
        Your workspace is empty
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 400,
          color: "var(--ink-dim)",
          marginBottom: 8,
        }}
      >
        Pick a folder to start orchestrating workers in it.
      </div>
      <button
        type="button"
        onClick={onCreate}
        style={{
          appearance: "none",
          background: "transparent",
          border: "1px solid var(--rule-strong)",
          borderRadius: 6,
          boxShadow: "var(--lift-hi)",
          color: "var(--ink-dim)",
          padding: "10px 18px",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          letterSpacing: "0.04em",
          fontWeight: 600,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--accent-soft)";
          e.currentTarget.style.borderColor = "var(--accent-edge)";
          e.currentTarget.style.color = "var(--ink)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.borderColor = "var(--rule-strong)";
          e.currentTarget.style.color = "var(--ink-dim)";
        }}
      >
        + Add a workspace
      </button>
      <div
        style={{
          marginTop: 12,
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          color: "var(--muted)",
          display: "inline-flex",
          alignItems: "baseline",
          gap: 6,
        }}
      >
        <span>Codara Studio stores its data in</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--ink-dim)",
          }}
        >
          ~/.Codara
        </span>
      </div>
    </div>
  );
});

// Centered empty state for a workspace whose tab strip has been emptied — e.g.
// the user closed the Cora chat and every terminal. The close STICKS
// (no tab is auto-respawned), so this is a legitimate resting state, not an
// error; it gives the user the two obvious ways back in. The "+" picker in the
// top strip offers the same actions plus Open file / Preview / Automations.
const EmptyWorkbench = React.memo(function EmptyWorkbench({
  onNewChat,
  onNewTerminal,
}: {
  onNewChat: () => void;
  onNewTerminal: () => void;
}) {
  const buttonStyle: React.CSSProperties = {
    appearance: "none",
    background: "transparent",
    border: "1px solid var(--rule-strong)",
    borderRadius: 6,
    boxShadow: "var(--lift-hi)",
    color: "var(--ink-dim)",
    padding: "10px 18px",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    letterSpacing: "0.04em",
    fontWeight: 600,
    cursor: "default",
    transition:
      "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
  };
  const onEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = "var(--accent-soft)";
    e.currentTarget.style.borderColor = "var(--accent-edge)";
    e.currentTarget.style.color = "var(--ink)";
  };
  const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = "transparent";
    e.currentTarget.style.borderColor = "var(--rule-strong)";
    e.currentTarget.style.color = "var(--ink-dim)";
  };
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // Above the (null-or-hidden) tab stacks so the buttons are always
        // clickable even if a worker terminal pane stays mounted-but-hidden.
        zIndex: 2,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        background: "var(--bg)",
        backgroundImage:
          "radial-gradient(circle, var(--rule-soft) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        color: "var(--muted)",
        padding: 32,
        textAlign: "center",
      }}
    >
      <div className="spark-eyebrow" style={{ marginBottom: 2 }}>
        No tabs open
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 24,
          fontWeight: 700,
          color: "var(--ink)",
          letterSpacing: "-0.005em",
        }}
      >
        Nothing open here
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 400,
          color: "var(--ink-dim)",
          marginBottom: 8,
        }}
      >
        Start a new chat with Cora, or open a terminal. Past chats are still in
        the history popover.
      </div>
      <div style={{ display: "inline-flex", gap: 10 }}>
        <button
          type="button"
          onClick={onNewChat}
          style={{ ...buttonStyle, color: "var(--accent)", borderColor: "var(--accent-edge)" }}
          onMouseEnter={onEnter}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "var(--accent-edge)";
            e.currentTarget.style.color = "var(--accent)";
          }}
        >
          + New chat
        </button>
        <button
          type="button"
          onClick={onNewTerminal}
          style={buttonStyle}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          + New terminal
        </button>
      </div>
    </div>
  );
});
