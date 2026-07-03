import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppState,
  ChatBackendKind,
  FsEntry,
  InAppNotificationKind,
  RunState,
  RuntimeState,
  ShellInfo,
  SparkEvent,
  TerminalAgentTarget,
  Workspace,
} from "@shared/types";
import {
  DEFAULT_COPY_BRANCH_SETUP_COMMAND,
  TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { backendPtySessionId } from "@shared/backend-pty";
import WindowChrome from "./components/WindowChrome";
import WorkspaceRail, { WORKSPACE_COLORS } from "./components/WorkspaceRail";
import StatusBar from "./components/StatusBar";
import SettingsDialog from "./components/SettingsDialog";
import SessionInspector from "./components/SessionInspector";
import AgentCapabilitiesDialog from "./components/AgentCapabilitiesDialog";
import UpdateBanner from "./components/UpdateBanner";
import SearchPanel from "./components/Search/SearchPanel";
import FileSearchPanel from "./components/Search/FileSearchPanel";
import ToastHost from "./components/Toast";
import RunSwitcher from "./components/RunSwitcher";
import { CopyBranchDeleteDialog, CopyBranchErrorToast } from "./components/CopyBranchDialogs";
import { playNotificationSound } from "./components/notification-sounds";
import TabBar, { type PickerHints } from "./tabs/TabBar";
import ChatStack from "./tabs/ChatStack";
import InnerTabStrip from "./tabs/InnerTabStrip";
import EditorStack from "./tabs/EditorStack";
import TerminalStack from "./tabs/TerminalStack";
import PreviewStack from "./tabs/PreviewStack";
import { setOpenPreviewTabFn } from "./components/Preview/registry";
import RunsStack from "./tabs/RunsStack";
import AutomationsStack from "./tabs/AutomationsStack";
import { useTabs, isDraftChatTabId } from "./tabs/useTabs";
import { createNavigateTo, useNotifyFocusRouting } from "./notifications/routing";
import type { TerminalPaneDragPayload } from "./tabs/terminalDrag";
import type {
  PaneNode,
  PreviewTab,
  RunsTab,
  Tab,
  TabId,
  TerminalLeaf,
  TerminalTab,
} from "./tabs/types";
import { basename } from "./path-utils";
import ShortcutsDialog from "./shortcuts/ShortcutsDialog";
import { useGlobalShortcuts, type ShortcutHandlers } from "./shortcuts/useGlobalShortcuts";
import { buildBindingTable, type BindingTable } from "./shortcuts/bindings";
import { chordToHint } from "./shortcuts/chord";
import type { CommandId } from "./shortcuts/commands";
import { isRecording } from "./shortcuts/recording";
import { usePreferences } from "./preferences/usePreferences";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
  CURSOR_LAUNCH_COMMAND,
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
import {
  buildAwayDigest,
  compareRunsByAttention,
  describeRunStatus,
  findOpenQuestion,
  statusToneColor,
  type AwayDigest,
  type ChatStatusTone,
} from "./components/chat/timeline";

// Stable brand label for every chat tab in the top strip. The first-message-
// derived run.title is kept on the RunState for the chat panel header and the
// history popover; only the workspace tab strip is forced to this constant so
// short prompts ("hello") don't surface as truncated "He..." labels.
const CHAT_TAB_LABEL = "Cora";

const DEFAULT_SETTINGS: AppSettings = {
  defaultShellId: null,
  terminalScrollbackLineLimit: TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  openRouterApiKey: "",
  openRouterModel: "google/gemini-flash-latest",
  agentRuntimeSelection: "auto",
  agentMcpSyncEnabled: true,
  agentSkillSyncEnabled: true,
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
  playwrightMcpAutoInstall: true,
  workerStuckDetectEnabled: true,
  workerStuckIdleSeconds: 180,
  workerStuckMaxAutoRetries: 2,
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

// A run only needs a workbench tab once it has actual orchestrated work to
// show: at least one step or worker task. Pure chat-mode answers (e.g.
// "what is X?") leave both arrays empty and live entirely in the right-side
// chat conversation — no node graph tab for them.
function runHasWorkbench(run: RunState): boolean {
  return run.steps.length > 0 || run.workerTasks.length > 0;
}

function collectTerminalPaneIds(node: PaneNode, ids: Set<string>): void {
  if (node.kind === "leaf") {
    ids.add(node.paneId);
    return;
  }
  collectTerminalPaneIds(node.a, ids);
  collectTerminalPaneIds(node.b, ids);
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

export default function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [copyBranchError, setCopyBranchError] = useState<string | null>(null);
  const [pendingCopyDelete, setPendingCopyDelete] = useState<Workspace | null>(null);
  const [copyDeleteBusy, setCopyDeleteBusy] = useState(false);
  const [copyDeleteError, setCopyDeleteError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  // Runs for the currently active workspace, plus the user's selection. Lifted
  // here so the workbench RunsView and Spark chat tab both read from the same
  // source of truth: picking a chat updates the graph, deleting a chat removes
  // it everywhere.
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Each workspace has its own Spark chat selection. The visible state stays
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
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  // Pure renderer overlay — reads the active run, displays cost / events /
  // context-window / failure tabs. Toggled via the `session.openInspector`
  // shortcut (Mod+Shift+I).
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Cmd/Ctrl-K command-palette switcher over every run across all workspaces.
  // Sourced from the separate global-runs feed (useGlobalRuns) since the
  // lifted `runs` state above is active-workspace-only.
  const [runSwitcherOpen, setRunSwitcherOpen] = useState(false);
  // Single "While you were away" digest surfaced on window focus-after-away.
  // Holds the snapshot computed at focus time; null when nothing landed or the
  // user dismissed it.
  const [awayDigest, setAwayDigest] = useState<AwayDigest | null>(null);
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
  const processedSpawnTerminalEventsRef = useRef<Set<string>>(new Set());
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
  const tabs = useTabs(activeId, activeWorkspace?.cwd, settings.terminalScrollbackLineLimit);

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

  // Mirror the runs list through a ref so run-selection callbacks can read
  // the latest chat titles without taking `runs` as a dependency.
  const runsRef = useRef(runs);
  runsRef.current = runs;

  // Cross-workspace runs feed for the walk-away cockpit surfaces (run
  // switcher, rail tone dots, focus digest). Independent of the lifted `runs`
  // state above, which is scoped to the active workspace only.
  const globalRuns = useGlobalRuns(booted);

  const handleRunSnapshot = useCallback(
    (
      run: RunState,
      options?: { select?: boolean; focusRuns?: boolean },
    ) => {
      // Loom-owned runs never enter the lifted chat state (defensive — the
      // listRuns filter is the primary gate).
      if (run.automationId) return;
      setRuns((current) => {
        if (run.workspaceId !== activeIdRef.current) return current;
        const withoutRun = current.filter((item) => item.id !== run.id);
        const next = [run, ...withoutRun];
        next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return next;
      });

      if (!options?.select) return;
      const workspaceId = run.workspaceId;
      activeRunIdsByWorkspaceRef.current[workspaceId] = run.id;
      activeRunIdRef.current = run.id;
      setActiveRunId(run.id);
      if (workspaceId !== activeIdRef.current) return;
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
      const targetWorkspaceId = workspaceId ?? activeIdRef.current;
      if (targetWorkspaceId) {
        activeRunIdsByWorkspaceRef.current[targetWorkspaceId] = runId;
      }
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      if (targetWorkspaceId !== activeIdRef.current) return;
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
    [],
  );

  // Cross-workspace run selection used by the global RunSwitcher and the
  // focus-after-away digest. handleSelectRun is scoped to the active workspace
  // (it early-returns when the target lives elsewhere), so switch the active
  // workspace first when the chosen run belongs to another project. The
  // per-workspace remembered-selection plumbing then restores this run once the
  // new workspace's runs load.
  const handleSelectRunAnywhere = useCallback(
    (runId: string, workspaceId?: string) => {
      if (workspaceId && workspaceId !== activeIdRef.current) {
        const currentWorkspaceId = activeIdRef.current;
        if (currentWorkspaceId) {
          activeRunIdsByWorkspaceRef.current[currentWorkspaceId] = activeRunIdRef.current;
        }
        setActiveId(workspaceId);
      }
      // Loom-owned runs have no chat surface anywhere (the lifted list filters
      // them, so handleSelectRun would dead-end in an empty chat tab) — their
      // home is the Automations Hub. Route a blocked-loom toast/digest click
      // there instead.
      const target = globalRuns.runsRef.current.find((r) => r.id === runId);
      if (target?.automationId) {
        tabsRef.current.openAutomationsTab();
        return;
      }
      handleSelectRun(runId, workspaceId);
    },
    [handleSelectRun, globalRuns.runsRef],
  );

  // Unseen terminal-agent alerts, keyed workspace → pane. Set when main
  // fires a terminal alert (event arrives even with all notification
  // channels muted); cleared when the user visits the pane's tab. This is
  // what keeps the workspace rail showing "something in there wants you"
  // after the transient toast/native notification is gone.
  const [terminalAttention, setTerminalAttention] = useState<
    Record<string, Record<string, { tabId: string; kind: InAppNotificationKind }>>
  >({});

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

  // Keep the active chat's node-graph tab in existence without stealing
  // focus. Chat-only runs (no steps, no worker tasks) intentionally have NO
  // workbench tab — the answer lives in the right-panel conversation only.
  // When such a run later sprouts steps (e.g. user follows up with "do it"),
  // this effect lazily opens the tab on the next runs update.
  useEffect(() => {
    if (!activeRunId) {
      tabsRef.current.hideRunsTabs();
      return;
    }
    const target = runsRef.current.find((r) => r.id === activeRunId) ?? null;
    if (target && runHasWorkbench(target)) {
      tabsRef.current.openRunsTab(activeRunId, "Runs", false);
    } else {
      tabsRef.current.hideRunsTabs();
    }
  }, [activeRunId, runs]);

  // Mirror the workbench selection back into the active chat: clicking a
  // chat's node-graph tab makes the Spark chat tab follow along.
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
    // All chat tabs in the top strip render as "Spark Agent" — see
    // CHAT_TAB_LABEL above. Run.title is preserved on the RunState for the
    // chat panel header and history popover; only the tab label is forced
    // to a stable brand so short prompts don't surface as "He...".
    tabsRef.current.syncChatTabsToRuns(
      runs.map((run) => ({ id: run.id, title: CHAT_TAB_LABEL })),
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
        setWorkspaces(state.workspaces);
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
      const state: AppState = { workspaces, activeWorkspaceId: activeId };
      void window.spark.state.save(state);
    }, 200);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [workspaces, activeId, booted]);

  // Close editor when rail hidden — kept for parity with old behaviour.
  useEffect(() => {
    if (!showLeft) setEditingId(null);
  }, [showLeft]);

  // Comma-joined sorted list of workspace cwds. Used as a stable dep for the
  // setAllowedRoots push so we only re-send when the actual cwd set changes
  // (renaming a workspace's color, for instance, must not re-fire the IPC).
  const workspaceCwdsKey = useMemo(
    () =>
      workspaces
        .map((w) => w.cwd)
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
    if (!workspaceId) {
      setRuns([]);
      return;
    }
    try {
      const next = await window.spark.orchestration.listRuns(workspaceId);
      if (activeIdRef.current !== workspaceId) return;
      // Loom-owned runs live inside the Automations tab (Workers sub-tab +
      // per-loom history) — keeping them out of the lifted list is what keeps
      // chat tabs / RunsStack rows from materializing for them.
      setRuns(next.filter((run) => !run.automationId));
    } catch {
      /* Surface details elsewhere; this is opportunistic. */
    }
  }, []);

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
      const live = runs.find((run) =>
        ["planning", "running", "reviewing", "blocked", "paused"].includes(run.status),
      );
      const fallback = live?.id ?? runs[0]?.id ?? null;
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

    // Drain the pending-workspace set: refresh the run count for every
    // workspace that saw an event, and the lifted runs list if the currently
    // active workspace was among them. Reads activeId via the ref so this is
    // always against the workspace on screen *now*, not whenever the listener
    // was registered.
    const flushRunRefresh = (): void => {
      runRefreshTimer.current = null;
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

    return window.spark.orchestration.onEvent((event) => {
      if (!event.workspaceId) return;
      // Record the affected workspace and (re)arm the trailing timer. The
      // active workspace's runs/counts still update — just batched into one
      // refresh per burst rather than one per event.
      runRefreshPendingRef.current.add(event.workspaceId);
      if (runRefreshTimer.current !== null) {
        window.clearTimeout(runRefreshTimer.current);
      }
      runRefreshTimer.current = window.setTimeout(flushRunRefresh, RUN_REFRESH_DEBOUNCE_MS);

      // A deletion can race with the orchestration runner still flushing the
      // run file; a delayed second pass picks up the settled state. We just
      // re-mark the workspace ~500ms later so the regular debounced flush
      // re-lists it once things have quiesced.
      if (event.type === "run.deleted") {
        if (event.runId) {
          tabsRef.current.closeRunsTabFor(event.runId);
          tabsRef.current.closeWorkerTerminalTabFor(event.runId);
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
        }
        const deletedWorkspaceId = event.workspaceId;
        window.setTimeout(() => {
          runRefreshPendingRef.current.add(deletedWorkspaceId);
          if (runRefreshTimer.current !== null) {
            window.clearTimeout(runRefreshTimer.current);
          }
          runRefreshTimer.current = window.setTimeout(flushRunRefresh, RUN_REFRESH_DEBOUNCE_MS);
        }, 500);
      }

      // A spawn_terminals decision: Spark opened interactive terminals for
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

    const onBlur = () => {
      awayAtRef.current = Date.now();
    };
    const onFocus = () => {
      const awayAt = awayAtRef.current;
      awayAtRef.current = null;
      if (awayAt === null || Date.now() - awayAt < AWAY_THRESHOLD_MS) return;
      // Same cockpit rule as the rail dots: loom runs surface only while
      // blocked (clicks route to the Automations Hub); their per-pass
      // completions never enter done-unseen.
      const digest = buildAwayDigest(
        globalRuns.runsRef.current.filter((r) => !r.automationId || r.status === "blocked"),
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
    return () => off();
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
      setSettingsOpen(true);
    };
    window.addEventListener("spark:open-settings", handler);
    return () => window.removeEventListener("spark:open-settings", handler);
  }, []);

  // Mirror the workspaces list through a ref so the orchestration listener
  // doesn't re-subscribe on every workspace state change (which is often
  // — runs trigger updates).
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  // When the orchestration runner emits `envelope_prepared`, the worker is
  // about to start and is waiting for a renderer-side PTY at sessionId =
  // attemptId. Spark workers live in one run-scoped terminal tab titled
  // "workers" instead of claiming arbitrary user shells. The tab stays mounted
  // across chat switches so PTYs continue running, but the tab strip only
  // reveals it while its run is the active chat.
  useEffect(() => {
    if (!booted) return;

    const handleEnvelopePrepared = async (event: SparkEvent) => {
      if (event.type !== "worker_task.envelope_prepared") return;
      if (!event.runId || !event.workerTaskId || !event.attemptId) return;
      if (!event.workspaceId) return;
      // Loom workers: main owns their pty (direct-worker.ts) and the
      // Automations Hub renders them — never open a workers terminal tab.
      // Payload check is synchronous; a missing stamp falls through (fail-open
      // to the visible tab rather than an invisible worker).
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.automationId) return;

      const ws = workspacesRef.current.find((w) => w.id === event.workspaceId);
      if (!ws) return;
      const workspaceCwd = ws.cwd;

      // Pull the runtime so the worker chip shows CLAUDE/CODEX. Best-effort —
      // the chip is decoration; the PTY claim itself doesn't depend on it.
      let runtime: "claude" | "codex" | undefined;
      try {
        const run = await window.spark.orchestration.getRun(event.runId);
        const task = run?.workerTasks.find((item) => item.id === event.workerTaskId);
        if (
          task?.runtimePreference === "claude" ||
          task?.runtimePreference === "codex"
        ) {
          runtime = task.runtimePreference;
        }
      } catch {
        /* runtime is decorative */
      }

      const workerMeta = {
        runtime,
        runId: event.runId,
        workerTaskId: event.workerTaskId,
        attemptId: event.attemptId,
        source: "spark" as const,
        state: "running" as const,
      };

      const t = tabsRef.current;
      if (!t) return;
      const tabId = t.ensureWorkerTerminalTab(event.runId, workspaceCwd, event.attemptId, workerMeta, {
        focus: false,
      });
      t.setLeafCwd(tabId, event.attemptId, workspaceCwd);
      t.setActiveTerminalPane(tabId, event.attemptId);
    };

    // Mark the worker pane "done" on attempt finish — keeps the xterm
    // visible (so the user can read the report) but releases the leaf so
    // the next worker can claim it.
    const handleAttemptFinished = (event: SparkEvent) => {
      if (event.type !== "worker_attempt.finished") return;
      const attemptId = event.attemptId;
      if (!attemptId) return;
      const t = tabsRef.current;
      if (!t) return;
      for (const tab of t.tabs) {
        if (tab.kind !== "terminal") continue;
        const leaf = findLeafByPaneId(tab.root, attemptId);
        if (leaf) {
          const prior = leaf.worker;
          t.setLeafWorker(tab.id, attemptId, {
            runtime: prior?.runtime,
            runId: event.runId ?? prior?.runId ?? "",
            workerTaskId: event.workerTaskId ?? prior?.workerTaskId ?? "",
            attemptId,
            source: "spark",
            state: "done",
            agentRunning: prior?.agentRunning,
          });
          break;
        }
      }
    };

    return window.spark.orchestration.onEvent((event) => {
      void handleEnvelopePrepared(event);
      handleAttemptFinished(event);
    });
  }, [booted]);

  // ── Terminal-agent notifications (manual claude/codex panes) ──────────────
  //
  // The main-process watcher (terminal-agent-notify.ts) taps the raw pty
  // streams of user-facing terminal panes and alerts when a Claude/Codex/
  // Cursor CLI finishes a turn or stops for permission while the user isn't
  // looking at that tab. The renderer owns three pieces of the loop:
  //
  //   1. The pane registry — which pty sessions are user terminal panes, and
  //      which workspace/tab each lives in (for routing the click back).
  //      Spark-orchestrated worker panes register excluded: run-store events
  //      already alert for those.
  //   2. The active context — which workspace + tab is on screen, so main
  //      can apply the "never ping me about the tab I'm watching" rule.
  //   3. Click navigation — native-notification and toast clicks both land
  //      in focusTerminalTarget, which switches workspace if needed (queue +
  //      replay, same pattern as pendingSpawnTerminalsRef) and then activates
  //      the tab + pane.
  useEffect(() => {
    if (!booted) return;
    const workspaceId = tabs.tabsWorkspaceId;
    if (!workspaceId) return;
    const panes: Array<{ paneId: string; tabId: string; tabTitle: string; excluded: boolean }> =
      [];
    for (const tab of tabs.tabs) {
      if (tab.kind !== "terminal") continue;
      const workersTab = tab.scope?.kind === "workers";
      forEachTerminalLeaf(tab.root, (leaf) => {
        panes.push({
          paneId: leaf.paneId,
          tabId: tab.id,
          tabTitle: tab.title,
          // Spark-orchestrated panes are excluded only while their worker is
          // RUNNING (run-store events already alert that lifecycle). Once the
          // attempt is done the pane is an ordinary terminal again — a manual
          // `claude` run in it must notify like any other pane.
          excluded:
            workersTab ||
            (leaf.worker?.source === "spark" && leaf.worker.state === "running"),
        });
      });
    }
    // Optional chaining: during dev HMR the renderer can be newer than the
    // preload of a long-lived instance; degrade to no-op instead of throwing
    // inside the effect.
    const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? "";
    window.spark.terminalNotify
      ?.sync?.({ workspaceId, workspaceName, panes })
      ?.catch(() => {
        /* registry sync is best-effort; the next layout change retries */
      });
  }, [booted, tabs.tabs, tabs.tabsWorkspaceId, workspaces]);

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
          runId: activeRunId,
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
  }, [booted, tabs.tabs, tabs.tabsWorkspaceId, tabs.activeId, activeRunId]);

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
  // onto the matching leaf.worker.runtimeState the same way
  // onTerminalPaneRuntimeState does, with two differences:
  //   1. We accept EVERY RuntimeState (incl. "idle"/"done"/"launching"). Unlike
  //      the synchronous poller path, this is a separate IPC turn — it is not in
  //      the resurrection-hazard stack onTerminalPaneRuntimeState guards against
  //      (where a same-tick "done" would re-mint a just-removed chip).
  //   2. We NEVER mint a worker (guard `if (!existing) return`). A late
  //      "done"/"idle" arriving after the manual chip was already removed (by
  //      onTerminalPaneAgentState running:false, or onTerminalPaneExit) must
  //      no-op rather than resurrect a dead chip.
  // Reconciliation with the visible poller: both writers just set runtimeState.
  // When the pane is visible the fast poller dominates (300ms ticks); when
  // hidden these notifier events are the only updates arriving. Neither
  // resurrects a removed worker, so they coexist without precedence logic.
  useEffect(() => {
    const off = window.spark.terminalNotify?.onState?.((payload) => {
      if (!payload?.tabId || !payload.paneId || !payload.state) return;
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === payload.tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, payload.paneId);
      const existing = leaf?.worker;
      // Never mint a worker — a late event after the chip was removed no-ops.
      if (!existing) return;
      // A pane already flipped to "error" is showing a crash (non-zero pty
      // exit, set by onTerminalPaneExit, which owns the pty-death case because
      // it has the exit code). That red "exited" chip must persist until the
      // user closes the pane, so ignore ANY later notifier state event for it —
      // a notifier "exited"-block "done" arriving on the same teardown must not
      // race in and tear the error chip back down.
      if (existing.runtimeState === "error") return;
      // "done" = the foreground TUI exited. Mirror onTerminalPaneAgentState's
      // running:false teardown rather than writing runtimeState:"done" onto a
      // live chip (which `visibleWorkerChip` would keep showing as a stale grey
      // badge while the lifecycle `state` is still "running"). Manual chips have
      // no lifecycle outside the pane → clear them; Spark chips keep their run
      // metadata but drop agentRunning so the run store owns completion.
      if (payload.state === "done") {
        if (existing.source === "spark") {
          if (existing.agentRunning === false) return;
          t.setLeafWorker(payload.tabId, payload.paneId, {
            ...existing,
            agentRunning: false,
          });
        } else {
          t.setLeafWorker(payload.tabId, payload.paneId, null);
        }
        return;
      }
      if (existing.runtimeState === payload.state) return;
      t.setLeafWorker(payload.tabId, payload.paneId, {
        ...existing,
        runtimeState: payload.state,
      });
    });
    return () => off?.();
  }, []);

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

  // Shared by the toast cards and the notification center: resolve a blocked
  // run's open-question options for inline answers, and decide whether an
  // answer should resumeRun (loom-owned runs must not — the loop driver's
  // answer seam consumes the recorded message). runsRef is a stable ref, so
  // both callbacks stay referentially stable for WindowChrome's memo.
  const resolveRunQuestion = useCallback(
    (runId: string) => {
      const run = globalRuns.runsRef.current.find((r) => r.id === runId);
      const question = run ? findOpenQuestion(run) : null;
      return question?.questionOptions ?? [];
    },
    [globalRuns.runsRef],
  );
  const shouldResumeOnAnswer = useCallback(
    (runId: string) =>
      !globalRuns.runsRef.current.find((r) => r.id === runId)?.automationId,
    [globalRuns.runsRef],
  );

  // WorkspaceRail prop callbacks. `setActiveId` / `setEditingId` are stable
  // React setters, so these can carry empty dep arrays and stay referentially
  // stable for the lifetime of the component — which lets the React.memo on
  // WorkspaceRail actually skip renders.
  const handleActivateWorkspace = useCallback((id: string) => {
    const currentWorkspaceId = activeIdRef.current;
    if (currentWorkspaceId) {
      activeRunIdsByWorkspaceRef.current[currentWorkspaceId] = activeRunIdRef.current;
    }
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
    setShowLeft((v) => !v);
  }, []);

  const handleToggleRight = useCallback(() => {
    setShowRight((v) => !v);
  }, []);

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
    setSettingsOpen(true);
  }, []);

  const handleOpenCapabilities = useCallback(() => {
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
      setDefaultShell(resolveDefaultShell(shells, saved, detectedDefaultShell));
    },
    [shells, detectedDefaultShell],
  );
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
    setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

  const reorderWs = useCallback((fromIndex: number, toIndex: number) => {
    setWorkspaces((list) => {
      if (
        fromIndex < 0 ||
        fromIndex >= list.length ||
        toIndex < 0 ||
        toIndex > list.length
      ) {
        return list;
      }
      const next = list.slice();
      const [moved] = next.splice(fromIndex, 1);
      const adjusted = toIndex > fromIndex ? toIndex - 1 : toIndex;
      next.splice(adjusted, 0, moved);
      // No-op if nothing actually moved (preserve referential equality so memoized
      // children don't re-render).
      let changed = false;
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].id !== next[i].id) {
          changed = true;
          break;
        }
      }
      return changed ? next : list;
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
      const next = ws.filter((w) => w.id !== id);
      const removed = ws.find((w) => w.id === id);
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
    const usedColors = new Set(workspaces.map((w) => w.color.toLowerCase()));
    const color = WORKSPACE_COLORS.find((c) => !usedColors.has(c.toLowerCase())) ?? WORKSPACE_COLORS[0];
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

  const createCopyBranchWs = useCallback(
    async (sourceWs: Workspace) => {
      const res = await window.spark.git.createCopyWorktree(sourceWs.cwd);
      if (!res.ok) {
        setCopyBranchError(res.error);
        return;
      }
      setWorkspaces((list) => {
        const ws: Workspace = {
          id: makeId("ws"),
          name: res.city,
          cwd: res.path,
          // Inherit the parent's color so the copy reads as a branch of it.
          color: sourceWs.color,
          workers: [],
          copyBranch: {
            repoCwd: sourceWs.cwd,
            branch: res.branch,
            baseBranch: res.baseBranch,
            city: res.city,
            createdAt: new Date().toISOString(),
            fileCount: res.fileCount,
          },
        };
        activeRunIdsByWorkspaceRef.current[ws.id] = null;
        setActiveId(ws.id);
        // Run the per-repo setup command live in a terminal in the new worktree.
        // Default is empty (opt-in) — nothing runs unless this repo has one set.
        void window.spark.preferences.load().then((prefs) => {
          const cmd = (
            prefs.copyBranchSetupCommandByRepo?.[sourceWs.cwd] ??
            DEFAULT_COPY_BRANCH_SETUP_COMMAND
          ).trim();
          if (cmd) tabs.newTerminalTab(res.path, cmd);
        });
        // Insert directly below the source workspace (and any existing copy
        // branches of it) so it reads as an indented child of its parent.
        const parentIdx = list.findIndex((w) => w.id === sourceWs.id);
        if (parentIdx === -1) return [...list, ws];
        let insertAt = parentIdx + 1;
        while (
          insertAt < list.length &&
          list[insertAt].copyBranch?.repoCwd === sourceWs.cwd
        ) {
          insertAt += 1;
        }
        const next = list.slice();
        next.splice(insertAt, 0, ws);
        return next;
      });
    },
    [tabs],
  );

  const handleCreateCopyBranch = useCallback(
    (id: string) => {
      const ws = workspaces.find((w) => w.id === id);
      if (ws) void createCopyBranchWs(ws);
    },
    [workspaces, createCopyBranchWs],
  );

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
      tabs.openEditorTab(entry, options);
    },
    [tabs],
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
  // now-stable `tabs` object) so the memoized side panels can skip re-renders
  // when only unrelated App state changed.
  const handleDeleteFile = useCallback(
    (path: string) => {
      tabs.closeEditorByPath(path);
    },
    [tabs],
  );

  const handleRenameFile = useCallback(
    (oldPath: string, entry: FsEntry) => {
      tabs.setEditorEntry(oldPath, entry);
    },
    [tabs],
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
          // Engine picked from the explorer's Run plan flyout (undefined = the
          // default Spark / OpenRouter manager).
          chatBackend: backend,
        });
        handleSelectRun(run.id);
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
    (tabId: string, paneId: string, url: string) => {
      tabs.setDetectedUrl(tabId, paneId, url);
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

      // Part C — auto-open is opt-in. When the user hasn't enabled it, stop
      // here: the detected-URL chip above already ran (setDetectedUrl +
      // broadcast), so the user can click to open the preview, but Spark never
      // yanks a preview tab open on its own.
      if (preferencesRef.current.autoOpenPreview !== true) return;

      // Belt-and-suspenders (Part C3): never auto-open from an agent/worker
      // pane, even with the pref on — an agent's own dev server must not spawn a
      // preview. A pane is "agent-owned" if its tab is a Spark workers-scoped
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
      lastOpenedUrlByTerminalRef.current.set(paneId, url);

      // If a preview tab already shows the same origin, do nothing — it's
      // already in the strip. A passive stdout sniff must never reassign the
      // active tab, or a dev server printing its URL would yank the user off
      // their chat onto the browser (and hide the composer).
      const existing = tabs.tabs.find(
        (t) => t.kind === "preview" && sameOrigin(t.url, url),
      );
      if (existing) return;
      // Inherit the worker's runId so the chat panel can render this preview
      // inside its inner tab strip; URLs detected on a plain (non-worker)
      // terminal stay top-level by leaving runId undefined. (Worker panes are
      // excluded above, so ownerRunId is always null here today — kept for the
      // shape the chat panel expects.)
      const ownerRunId =
        sourceTab?.kind === "terminal" && sourceTab.scope?.kind === "workers"
          ? sourceTab.scope.runId
          : null;
      // focus:false — an auto-detected preview opens in the background so it
      // doesn't steal the active tab from a chat the user is working in.
      tabs.newPreviewTab(url, { runId: ownerRunId, focus: false });
    },
    [AUTO_PREVIEW_PORTS, tabs],
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
  const handleNewWorkerTab = useCallback(
    (autorun: string) => {
      const active = tabs.tabs.find((t) => t.id === tabs.activeId);
      const target =
        active?.kind === "terminal"
          ? active
          : // Skip run-scoped worker tabs (hidden unless their run is active)
            // so the worker pane lands in a visible top-strip terminal.
            tabs.tabs.find((t) => t.kind === "terminal" && t.scope?.kind !== "workers");
      if (!target || target.kind !== "terminal") {
        tabs.newTerminalTab(activeWorkspace?.cwd ?? undefined, autorun);
        return;
      }

      const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
      const runtime = paneRuntimeRef.current.get(target.activePaneId);
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
        !runtime?.userInputAt &&
        !runtime?.altScreenActive;
      if (isUnusedPane) {
        tabs.setActiveTab(target.id);
        tabs.setActiveTerminalPane(target.id, target.activePaneId);
        // Inject as a bracketed paste + submit so the existing pwsh/bash/zsh
        // prompt receives the autorun as if the user had typed it. pty.inject
        // is async but fire-and-forget is fine — failures (pane disposed,
        // PTY exited) just mean nothing runs, which is recoverable by
        // pressing the keybind again.
        void window.spark.pty.inject(target.activePaneId, autorun, { submit: true });
        return;
      }

      const paneId = makeId("pane");
      const cwd =
        runtime?.cwd ??
        activeLeaf?.cwd ??
        activeWorkspace?.cwd ??
        undefined;
      const added = tabs.addPaneInTab(target.id, paneId, { cwd, autorun });
      if (added) {
        tabs.setActiveTab(target.id);
        tabs.setActiveTerminalPane(target.id, paneId);
        return;
      }

      tabs.newTerminalTab(cwd, autorun);
    },
    [tabs, activeWorkspace?.cwd],
  );

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
    tabs.newPreviewTab("");
  }, [tabs]);

  // Top tab strip "+" — append a fresh draft chat tab and focus it. The
  // composer renders in "new chat" mode; the first message will promote the
  // draft to a real run-backed chat tab via handleRunSnapshot.
  const handleNewChat = useCallback(() => {
    tabs.addDraftChatTab();
  }, [tabs]);

  // Top tab strip "+" → "New automations" — focus the workspace's single
  // Automations tab (scheduler + overnight queue), creating it if absent.
  const handleNewAutomations = useCallback(() => {
    tabs.openAutomationsTab();
  }, [tabs]);

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
        tabs.hideRunsTabs();
      }
      tabs.closeChatTabForRun(id);
    },
    [tabs],
  );

  // Chat-tab "✎" — rename via IPC; update the tab title locally as well so
  // the strip reflects the change before the run snapshot round-trips.
  const handleRenameChatTab = useCallback(
    (id: TabId, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      tabs.renameChatTab(id, trimmed);
      if (isDraftChatTabId(id)) return; // drafts have no backing run yet
      void window.spark.orchestration
        .renameRun({ runId: id, title: trimmed })
        .catch(() => {
          /* IPC failure — the local title may diverge until the next snapshot */
        });
    },
    [tabs],
  );

  const openInSparkBrowser = useCallback(
    (url: string) => {
      if (!isBrowserUrl(url)) return;
      const existing = tabs.tabs.find(
        (t) => t.kind === "preview" && (t.url === url || sameOrigin(t.url, url)),
      );
      if (existing) {
        tabs.setPreviewUrl(existing.id, url);
        tabs.setActiveTab(existing.id);
        return;
      }
      tabs.newPreviewTab(url);
    },
    [tabs],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const url = (event as CustomEvent<{ url?: unknown }>).detail?.url;
      if (typeof url === "string") openInSparkBrowser(url);
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
    // MCP-driven preview spawns happen during orchestration, so the new tab
    // inherits whichever run is currently active. Reading the ref at call
    // time avoids rebinding the registry hook on every activeRunId change.
    // focus:false — an agent-driven preview spawns in the background (it
    // surfaces in the active run's inner tab strip) instead of pulling the
    // user off their chat mid-run. The bridge drives navigation by tab id, so
    // the preview need not be the active tab.
    setOpenPreviewTabFn((url: string) =>
      tabs.newPreviewTab(url, { runId: activeRunIdRef.current, focus: false }),
    );
    return () => setOpenPreviewTabFn(null);
  }, [tabs]);

  const handleTerminalPaneDropToTab = useCallback(
    (payload: TerminalPaneDragPayload, targetTabId?: string) => {
      if (targetTabId) {
        tabs.moveTerminalPane(payload.tabId, payload.paneId, targetTabId);
        return;
      }
      tabs.detachTerminalPaneToNewTab(payload.tabId, payload.paneId);
    },
    [tabs],
  );

  const handlePreviewUrlChange = useCallback(
    (id: string, url: string) => {
      // Reflect navigation back into the persisted tab state so a reload
      // restores the user where they were.
      tabs.setPreviewUrl(id, url);
    },
    [tabs],
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
      "composer.focus": () => {
        // Composer shortcut focuses the active chat if any, otherwise opens
        // (or creates) a draft so the user has somewhere to type.
        tabs.openChatTab({ runId: activeRunIdRef.current, focus: true });
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent("spark:focus-composer"));
        });
      },
      "sidebar.toggleLeft": () => {
        setShowLeft((visible) => !visible);
        window.dispatchEvent(new CustomEvent("spark:toggle-left-sidebar"));
      },
      "sidebar.toggleRight": () => {
        setShowRight((visible) => !visible);
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
      "worker.newClaude": () => handleNewWorkerTab(CLAUDE_LAUNCH_COMMAND),
      "worker.newCodex": () => handleNewWorkerTab(CODEX_LAUNCH_COMMAND),
      "worker.newCursor": () => handleNewWorkerTab(CURSOR_LAUNCH_COMMAND),
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
        if (active?.kind === "chat") {
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
      handleNewWorkerTab,
      handleCloseChatTab,
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
    isDisabled: () => isRecording(),
  });

  // Resolved keybind hints for the tab-strip "+" picker. Derived from the
  // effective binding table so the menu always shows the user's actual chord
  // (rebinds included) with the right platform glyphs, and shows nothing when
  // a command is unbound. Memoized on bindingTable so TabBar's React.memo
  // identity holds across unrelated App renders. Each picker row maps to the
  // command that performs the SAME action as its onNew* handler.
  const pickerHints = useMemo<PickerHints>(
    () => ({
      newChat: hintForCommand(bindingTable, "chat.new"),
      terminal: hintForCommand(bindingTable, "tab.newTerminal"),
      openFile: hintForCommand(bindingTable, "tab.newEditor"),
      preview: hintForCommand(bindingTable, "tab.newPreview"),
      automations: hintForCommand(bindingTable, "automations.open"),
    }),
    [bindingTable],
  );

  // Dispose PTYs when terminal panes exit. The renderer-side TerminalPane
  // already calls pty.dispose on unmount, so this handler is intentionally
  // a no-op for unmount cases — but we keep the seam so future "exited
  // pane → auto-close" UX can hook in here without touching every call site.
  const onTerminalPaneExit = useCallback(
    (tabId: string, paneId: string, info?: { exitCode: number; signal?: number }) => {
      paneRuntimeRef.current.delete(paneId);
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      if (!leaf?.worker) return;
      // D5 (error). A non-zero pty exit is a crash, not a clean finish. Keep
      // the chip visible so the user sees "exited(N)" in red rather than the
      // pane silently dropping its badge. Applies to manual chips (a Spark-owned
      // attempt that crashed is surfaced through the run-store lifecycle, so we
      // only flip its agentRunning bit below as before). Treat a non-zero code
      // OR a terminating signal as a crash; exit code 0 is a normal teardown.
      const crashed =
        !!info && (info.exitCode !== 0 || (typeof info.signal === "number" && info.signal !== 0));
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
      // A PTY exit is not the worker completion signal. Spark-owned panes move
      // to "done" only when orchestration emits worker_attempt.finished. A crash
      // still surfaces "error" on the chip so the pane doesn't read as healthy.
      t.setLeafWorker(tabId, paneId, {
        ...leaf.worker,
        agentRunning: false,
        ...(crashed ? { runtimeState: "error" as const } : {}),
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
  // Spark-orchestrated workers (source="spark") keep their completion
  // lifecycle in the run store, but the terminal chip still follows the
  // foreground process: when Claude/Codex returns to the shell prompt, the
  // pane stops advertising an active agent.
  const onTerminalPaneAgentState = useCallback(
    (
      tabId: string,
      paneId: string,
      state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean },
    ) => {
      // Mirror alt-screen / TUI activity into the pane runtime tracker so
      // the worker keybind has a foolproof "do not take over" signal even
      // when banner detection didn't recognise the runtime. Updated for
      // both known (claude/codex/cursor) and unknown (runtime=null)
      // TUIs — the moment the PTY enters alt-screen mode it's no longer
      // safe to inject the launch command.
      const runtimeEntry =
        paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
      runtimeEntry.altScreenActive = state.running;
      paneRuntimeRef.current.set(paneId, runtimeEntry);
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      if (!leaf) return;
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
      // outright; for Spark-owned panes, keep the run metadata but mark the
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
  // manual chip / clears agentRunning on a Spark chip — and that callback runs
  // FIRST in the same synchronous stack. Writing runtimeState:"done" afterward
  // would resurrect the just-removed manual worker (a stale DONE chip), since
  // both setLeafWorker updaters are queued against the same pre-removal tab
  // tree. The chip's "done" look is already driven by the worker lifecycle.
  const onTerminalPaneRuntimeState = useCallback(
    (tabId: string, paneId: string, state: RuntimeState) => {
      if (state === "done") return;
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      const existing = leaf?.worker;
      if (!existing) return;
      if (existing.runtimeState === state) return;
      t.setLeafWorker(tabId, paneId, { ...existing, runtimeState: state });
    },
    [],
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
  //   - a brand-new Spark chat (startAutopilot with the payload pre-filled)
  //   - the currently-focused Spark chat (addRunMessage)
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
      const t = tabsRef.current;
      const active = t.tabs.find((tab) => tab.id === t.activeId);
      const target =
        active?.kind === "terminal"
          ? active
          : // Skip run-scoped worker tabs (hidden unless their run is active).
            t.tabs.find((tab) => tab.kind === "terminal" && tab.scope?.kind !== "workers");
      if (!target || target.kind !== "terminal") {
        t.newTerminalTab(activeWorkspace?.cwd ?? undefined, autorun);
        return null;
      }
      const paneId = makeId("pane");
      const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
      const cwd =
        paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
        activeLeaf?.cwd ??
        activeWorkspace?.cwd ??
        undefined;
      const added = t.addPaneInTab(target.id, paneId, { cwd, autorun });
      if (!added) {
        t.newTerminalTab(cwd, autorun);
        return null;
      }
      t.setActiveTab(target.id);
      t.setActiveTerminalPane(target.id, paneId);
      return paneId;
    },
    [activeWorkspace?.cwd],
  );

  // Wait for a freshly-spawned worker pane's CLI agent to enter its REPL
  // before typing our prompt at it. We watch the leaf's `worker.agentRunning`
  // bit which `onTerminalPaneAgentState` flips on alt-screen detection. If
  // it never flips (very slow boot, agent crashed) we time out and inject
  // anyway — at worst the text lands at the shell, which is recoverable.
  const waitForAgentReady = useCallback(
    (paneId: string, timeoutMs = 30000): Promise<void> =>
      new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          for (const tab of tabsRef.current.tabs) {
            if (tab.kind !== "terminal") continue;
            const leaf = findLeafByPaneId(tab.root, paneId);
            if (leaf?.worker?.agentRunning) {
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
    const openWorkers = enumerateOpenWorkers(visibleWorkbenchTabs, runs);
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
        handleSelectRun(run.id);
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
        leftOn={showLeft}
        rightOn={showRight}
        onToggleLeft={handleToggleLeft}
        onToggleRight={handleToggleRight}
        onOpenSettings={handleOpenSettings}
        notifyNavigateTo={navigateToNotifyTarget}
        notifyResolveQuestion={resolveRunQuestion}
        notifyShouldResumeOnAnswer={shouldResumeOnAnswer}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {showLeft && (
          <WorkspaceRail
            side="left"
            toneByWorkspaceId={toneByWorkspaceId}
            sections={panels.sections.left}
            draggingSection={draggingPanelSection}
            workspaces={workspaces}
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
            onReorder={reorderWs}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onCreateCopyBranch={handleCreateCopyBranch}
            onSplitChange={panels.setLeftSplit}
            onToggleSection={togglePanelSection}
            onMoveSection={movePanelSection}
            onSectionDragStart={handlePanelSectionDragStart}
            onSectionDragEnd={handlePanelSectionDragEnd}
            onRunSnapshot={handleRunSnapshot}
            onOpenFile={openFileByPath}
            onOpenFileEntry={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRunPlan={handleRunPlan}
          />
        )}
        {showLeft && (
          <ResizeHandle
            orientation="col"
            accent={activeWorkspace?.color}
            ariaLabel="Resize the workspaces panel"
            onResizeStart={handleLeftWidthStart}
            onResize={handleLeftWidthResize}
          />
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
              activeRunId={activeRunId}
              onSelectRun={handleSelectRun}
              onRunSnapshot={handleRunSnapshot}
              onDetectedUrl={handleDetectedUrl}
              onSparkOpenFile={openFileByPath}
              onTerminalPaneExit={onTerminalPaneExit}
              onPreviewUrlChange={handlePreviewUrlChange}
              onPaneCwd={handlePaneCwd}
              onPaneActivity={handlePaneActivity}
              onPaneUserInput={handlePaneUserInput}
              onPaneScrollback={handlePaneScrollback}
              onTerminalPaneAgentState={onTerminalPaneAgentState}
              onTerminalPaneRuntimeState={onTerminalPaneRuntimeState}
              onNewTerminalTab={handleNewTerminalTab}
              onNewEditorTab={handleNewEditorTab}
              onNewPreviewTab={handleNewPreviewTab}
              onNewChat={handleNewChat}
              onNewAutomations={handleNewAutomations}
              onRenameChat={handleRenameChatTab}
              onCloseChat={handleCloseChatTab}
              onTerminalPaneDrop={handleTerminalPaneDropToTab}
              onReorderTab={tabs.reorderTab}
              onPinEditorTab={tabs.pinEditorTab}
              pickerHints={pickerHints}
            />
          )}
        </main>

        {showRight && (
          <ResizeHandle
            orientation="col"
            accent={activeWorkspace?.color}
            ariaLabel="Resize the right panel"
            onResizeStart={handleRightWidthStart}
            onResize={handleRightWidthResize}
          />
        )}
        {showRight && (
          <WorkspaceRail
            side="right"
            toneByWorkspaceId={toneByWorkspaceId}
            sections={panels.sections.right}
            draggingSection={draggingPanelSection}
            workspaces={workspaces}
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
            onReorder={reorderWs}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onCreateCopyBranch={handleCreateCopyBranch}
            onSplitChange={panels.setRightSplit}
            onToggleSection={togglePanelSection}
            onMoveSection={movePanelSection}
            onSectionDragStart={handlePanelSectionDragStart}
            onSectionDragEnd={handlePanelSectionDragEnd}
            onRunSnapshot={handleRunSnapshot}
            onOpenFile={openFileByPath}
            onOpenFileEntry={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRunPlan={handleRunPlan}
          />
        )}

        {settingsOpen && (
          <SettingsDialog
            settings={settings}
            shells={shells}
            defaultShell={defaultShell}
            workspaceCwd={activeWorkspace?.copyBranch?.repoCwd ?? activeWorkspace?.cwd ?? null}
            onClose={closeSettings}
            onSave={handleSaveSettings}
            onOpenRun={handleSettingsOpenRun}
          />
        )}

        {inspectorOpen && (
          <SessionInspector
            run={runs.find((r) => r.id === activeRunId) ?? null}
            onClose={closeInspector}
          />
        )}

        {capabilitiesOpen && (
          <AgentCapabilitiesDialog
            settings={settings}
            workspaceCwd={activeWorkspace?.cwd ?? null}
            onClose={closeCapabilities}
            onSave={handleSaveSettings}
          />
        )}

        <ShortcutsDialog
          open={shortcutsOpen}
          onClose={closeShortcuts}
        />

        <RunSwitcher
          open={runSwitcherOpen}
          runs={globalRuns.runs.filter((r) => !r.automationId || r.status === "blocked")}
          workspaces={workspaces}
          onClose={() => setRunSwitcherOpen(false)}
          onSelectRun={handleSelectRunAnywhere}
          onAnswered={(run) => handleRunSnapshot(run)}
        />

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
          shouldResumeOnAnswer={shouldResumeOnAnswer}
        />
        {awayDigest && (
          <AwayDigestCard
            digest={awayDigest}
            workspaces={workspaces}
            onSelectRun={(runId, workspaceId) => {
              handleSelectRunAnywhere(runId, workspaceId);
              setAwayDigest(null);
            }}
            onDismiss={() => setAwayDigest(null)}
          />
        )}
        <CopyBranchErrorToast
          message={copyBranchError}
          onDismiss={() => setCopyBranchError(null)}
        />
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
  if (digest.working > 0) {
    summaryBits.push(`${digest.working} still working`);
  }

  return (
    <div
      className="spark-fade-in"
      role="status"
      style={{
        position: "fixed",
        top: 48,
        // Sit to the left of the toast column (which pins to right:16) so a
        // needs-you toast and this digest don't overlap when both are up.
        right: 16,
        zIndex: 1001,
        width: "min(360px, calc(100vw - 32px))",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        borderRadius: 8,
        border: "1px solid color-mix(in oklch, var(--info) 48%, var(--rule-strong))",
        background: "color-mix(in oklch, var(--info) 12%, var(--panel))",
        boxShadow: "var(--shadow-2)",
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
  );
}

// ── Workspace pane (tab strip + stacks) ──────────────────────────────────────

function isTabVisibleForRun(tab: Tab, activeRunId: string | null): boolean {
  return !(
    tab.kind === "terminal" &&
    tab.scope?.kind === "workers" &&
    tab.scope.runId !== activeRunId
  );
}

// True when a tab represents content owned by an orchestration run (worker
// terminal, Runs canvas, orchestration-spawned preview). These render inside
// the chat panel's inner tab strip instead of the top tab bar.
function isRunOwnedTab(tab: Tab): boolean {
  if (tab.kind === "terminal" && tab.scope?.kind === "workers") return true;
  if (tab.kind === "runs") return true;
  if (tab.kind === "preview" && tab.runId) return true;
  return false;
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
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  onDetectedUrl: (tabId: string, paneId: string, url: string) => void;
  onSparkOpenFile: (path: string) => void;
  onTerminalPaneExit: (
    tabId: string,
    paneId: string,
    info?: { exitCode: number; signal?: number },
  ) => void;
  onPreviewUrlChange: (id: string, url: string) => void;
  onPaneCwd: (tabId: string, paneId: string, cwd: string) => void;
  onPaneActivity: (tabId: string, paneId: string) => void;
  onPaneUserInput: (tabId: string, paneId: string) => void;
  onPaneScrollback: (tabId: string, paneId: string, scrollback: string) => void;
  onTerminalPaneAgentState: (
    tabId: string,
    paneId: string,
    state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean },
  ) => void;
  onTerminalPaneRuntimeState: (tabId: string, paneId: string, state: RuntimeState) => void;
  onNewTerminalTab: () => void;
  onNewEditorTab: () => void;
  onNewPreviewTab: () => void;
  onNewChat: () => void;
  onNewAutomations: () => void;
  onRenameChat: (id: TabId, title: string) => void;
  onCloseChat: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId?: string) => void;
  onReorderTab: (fromId: string, toId: string, position: "before" | "after") => void;
  onPinEditorTab: (id: TabId) => void;
  // Resolved "+" picker keybind hints, memoized in App so this stays
  // referentially stable across unrelated renders (keeps the memo intact).
  pickerHints: PickerHints;
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
  activeRunId,
  onSelectRun,
  onRunSnapshot,
  onDetectedUrl,
  onSparkOpenFile,
  onTerminalPaneExit,
  onPreviewUrlChange,
  onPaneCwd,
  onPaneActivity,
  onPaneUserInput,
  onPaneScrollback,
  onTerminalPaneAgentState,
  onTerminalPaneRuntimeState,
  onNewTerminalTab,
  onNewEditorTab,
  onNewPreviewTab,
  onNewChat,
  onNewAutomations,
  onRenameChat,
  onCloseChat,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
  pickerHints,
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
    setActiveTerminalPane,
    setTerminalSplitRatio,
    splitTerminalPane,
    moveTerminalPane,
    closeTerminalPane,
    toggleTerminalPaneZoom,
  } = tabs;
  const visibleTabs = useMemo(
    () => tabs.tabs.filter((tab) => isTabVisibleForRun(tab, activeRunId)),
    [tabs.tabs, activeRunId],
  );
  const effectiveActiveId = useMemo(() => {
    if (tabs.activeId && visibleTabs.some((tab) => tab.id === tabs.activeId)) {
      return tabs.activeId;
    }
    return visibleTabs[0]?.id ?? null;
  }, [tabs.activeId, visibleTabs]);
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
  // the live tab store, plus every visited-but-inactive workspace driven by its
  // frozen layout. Rendering them all mounted (only the active one visible) is
  // what keeps each workspace's xterm — colors, alt-screen TUI frame, real
  // scrollback — alive across a switch, instead of disposing it and replaying a
  // lossy gray text snapshot. Keyed AND sorted by workspaceId so React
  // preserves each stack's instance (and its live PTYs) as it moves between the
  // active and hidden roles. The active layer is keyed off `tabsWorkspaceId`
  // (not App's activeId) so its key always agrees with `tabs.tabs`, which lags
  // by one render during a switch.
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
  const topStripTabs = useMemo(
    () => visibleTabs.filter(isTopStripTab),
    [visibleTabs],
  );

  // Lifted from ChatPanel so the hoisted inner tab strip can drive the chat /
  // backend-PTY view toggle without ChatPanel keeping a separate state.
  // Resets when the active run changes (a fresh chat starts in "chat" view).
  const [chatView, setChatView] = useState<"chat" | "terminal">("chat");
  useEffect(() => {
    setChatView("chat");
  }, [activeRunId]);

  // Tabs owned by the active run, grouped by kind. These power the inner tab
  // strip: workers section, Runs section, preview entries.
  const runOwnedTabs = useMemo(() => {
    if (!activeRunId) {
      return { workers: [] as TerminalTab[], runs: null as RunsTab | null, previews: [] as PreviewTab[] };
    }
    const workers: TerminalTab[] = [];
    let runsTab: RunsTab | null = null;
    const previews: PreviewTab[] = [];
    for (const tab of tabs.tabs) {
      if (tab.kind === "terminal" && tab.scope?.kind === "workers" && tab.scope.runId === activeRunId) {
        workers.push(tab);
      } else if (tab.kind === "runs" && tab.runId === activeRunId) {
        runsTab = tab;
      } else if (tab.kind === "preview" && tab.runId === activeRunId) {
        previews.push(tab);
      }
    }
    return { workers, runs: runsTab, previews };
  }, [tabs.tabs, activeRunId]);

  // Is there anything to show in the inner tab strip? The Chat / Terminal
  // toggle appears once the chat has at least one message (its backend PTY
  // session id is known). Workers / Runs / preview pills appear when the
  // active run has spawned that artifact. When none of these is true the
  // inner strip stays hidden.
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
  const backendSessionId = activeRunForStrip
    ? backendPtySessionId(activeRunForStrip.id, activeRunForStrip.chatBackend)
    : null;
  // backendPtySessionId is a deterministic string derived from the run id
  // and backend, so it goes truthy the moment a Claude/Codex run exists —
  // *before* the backend has actually spawned the CLI PTY. If we showed the
  // Terminal pill on that signal alone, clicking it would mount xterm on a
  // ghost session and the user sees a black canvas. Poll the real existence
  // bit so the pill (and downstream TerminalPane mount) only fire when
  // there's a PTY to attach to.
  const [backendPtyExists, setBackendPtyExists] = useState(false);
  useEffect(() => {
    if (!backendSessionId) {
      setBackendPtyExists(false);
      return;
    }
    let disposed = false;
    const check = async () => {
      try {
        const exists = await window.spark.pty.exists(backendSessionId);
        if (!disposed) setBackendPtyExists(exists);
      } catch {
        if (!disposed) setBackendPtyExists(false);
      }
    };
    void check();
    const interval = window.setInterval(check, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [backendSessionId]);
  // Escape a dead Terminal view: if the backend PTY is gone (or never
  // existed) while chatView is "terminal", the chat panel renders neither the
  // terminal nor the composer. Fall back to the chat view so the composer is
  // always reachable.
  useEffect(() => {
    if (chatView === "terminal" && (!backendSessionId || !backendPtyExists)) {
      setChatView("chat");
    }
  }, [chatView, backendSessionId, backendPtyExists]);
  const innerStripVisible =
    Boolean(activeRunId) &&
    (backendPtyExists ||
      runOwnedTabs.workers.length > 0 ||
      runOwnedTabs.runs !== null ||
      runOwnedTabs.previews.length > 0);
  const handleInnerChatClick = useCallback(() => {
    if (activeChatTabId) setActiveTab(activeChatTabId);
    setChatView("chat");
  }, [activeChatTabId, setActiveTab]);
  const handleInnerTerminalClick = useCallback(() => {
    if (activeChatTabId) setActiveTab(activeChatTabId);
    setChatView("terminal");
  }, [activeChatTabId, setActiveTab]);
  const handleInnerSelectTab = useCallback(
    (id: TabId) => setActiveTab(id),
    [setActiveTab],
  );
  // When the underlying active tab is run-owned, the top strip should still
  // highlight the chat that owns it so the user keeps a "you're inside this
  // chat" anchor while viewing a worker / Runs / preview.
  const topStripActiveId = useMemo(() => {
    if (!effectiveActiveId) return null;
    const active = visibleTabs.find((tab) => tab.id === effectiveActiveId);
    if (active && isRunOwnedTab(active)) {
      const chatTab = topStripTabs.find((tab) => tab.kind === "chat");
      return chatTab?.id ?? null;
    }
    return effectiveActiveId;
  }, [effectiveActiveId, visibleTabs, topStripTabs]);

  const handleTabSelect = useCallback(
    (id: TabId) => setActiveTab(id),
    [setActiveTab],
  );
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
    (tabId: string, paneId: string, info: { exitCode: number; signal?: number }) =>
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
    ) => splitTerminalPane(tabId, paneId, direction, autorun),
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
        onNewEditor={onNewEditorTab}
        onNewPreview={onNewPreviewTab}
        onNewChat={onNewChat}
        onNewAutomations={onNewAutomations}
        onRenameChat={onRenameChat}
        onCloseChat={onCloseChat}
        onTerminalPaneDrop={onTerminalPaneDrop}
        onReorderTab={onReorderTab}
        onPinEditorTab={onPinEditorTab}
        pickerHints={pickerHints}
      />
      {innerStripVisible && (
        <InnerTabStrip
          activeId={effectiveActiveId}
          activeChatTabId={activeChatTabId}
          chatView={chatView}
          backendPtyExists={backendPtyExists}
          workers={runOwnedTabs.workers}
          runsTab={runOwnedTabs.runs}
          previews={runOwnedTabs.previews}
          onChatClick={handleInnerChatClick}
          onTerminalClick={handleInnerTerminalClick}
          onSelectTab={handleInnerSelectTab}
        />
      )}
      <div style={{ flex: 1, position: "relative", minWidth: 0, minHeight: 0 }}>
        {visibleTabs.length === 0 && (
          <EmptyWorkbench onNewChat={onNewChat} onNewTerminal={onNewTerminalTab} />
        )}
        <ChatStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          workspace={workspace}
          runs={runs}
          activeRunId={activeRunId}
          terminalScrollbackLineLimit={terminalScrollbackLineLimit}
          chatView={chatView}
          onChatViewChange={setChatView}
          onSelectRun={onSelectRun}
          onRunSnapshot={onRunSnapshot}
        />
        <EditorStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          onDirtyChange={handleEditorDirty}
          onClose={handleTabClose}
        />
        {/* One mounted TerminalStack per kept-alive workspace. Only the active
            one is visible/interactive; the rest stay mounted-but-hidden so
            their live xterms + PTYs survive a workspace switch (no dispose, no
            lossy gray snapshot/replay). Hidden stacks get null activeId (every
            pane hidden → buffering) and no-op write-backs so they can't corrupt
            the active workspace's tab store. */}
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
                onTabZoomToggle={isActive ? handlePaneZoomToggle : noopTerminalCb}
                onPaneCwd={isActive ? onPaneCwd : noopTerminalCb}
                onPaneActivity={isActive ? onPaneActivity : noopTerminalCb}
                onPaneUserInput={isActive ? onPaneUserInput : noopTerminalCb}
                onPaneScrollback={isActive ? onPaneScrollback : noopTerminalCb}
                onFlushScrollback={isActive ? tabs.flushScrollbackNow : noopTerminalCb}
                onPaneAgentState={isActive ? onTerminalPaneAgentState : noopTerminalCb}
                onPaneRuntimeState={isActive ? onTerminalPaneRuntimeState : noopTerminalCb}
              />
            </div>
          );
        })}
        <PreviewStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          onUrlChange={onPreviewUrlChange}
        />
        <RunsStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          workspace={workspace}
          runs={runs}
          activeRunId={activeRunId}
          onSelectRun={onSelectRun}
        />
        <AutomationsStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          workspace={workspace}
          terminalScrollbackLineLimit={terminalScrollbackLineLimit}
        />
        {/* The legacy hidden orchestration TerminalGrid was removed: worker
            PTYs now spawn inside the user-visible TerminalStack via the
            envelope_prepared claim flow in App.tsx. This means worker
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
        <span>Cora stores its data in</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--ink-dim)",
          }}
        >
          ~/.Cora
        </span>
      </div>
    </div>
  );
});

// Centered empty state for a workspace whose tab strip has been emptied — e.g.
// the user closed the Spark Agent chat and every terminal. The close STICKS
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
