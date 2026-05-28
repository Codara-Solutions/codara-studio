import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import { makeId } from "@shared/ids";
import { basename } from "../path-utils";
import {
  collectLeaves,
  findLeaf,
  insertLeafAtLeaf,
  leaf,
  nextLeafAfter,
  removeLeaf,
  setLeafField,
  setRatioAtPath,
  smartAddTarget,
  splitAtLeaf,
  type PanePath,
} from "./paneTree";
import type {
  ChatTab,
  EditorTab,
  PaneNode,
  PreviewTab,
  RunsTab,
  Tab,
  TabId,
  TerminalLeaf,
  TerminalLeafWorker,
  TerminalSplit,
  TerminalTab,
} from "./types";

// useTabs is the in-memory tabs store for the workspace pane. We keep it as
// a plain React hook (no zustand dependency) since the rest of Spark uses
// React state for everything else; a context provider in App.tsx hands it
// down to TabBar and the per-kind stacks.
//
// Persistence: tabs are persisted per-workspace through localStorage. The
// shape is intentionally simple — JSON-encoded list + active id keyed on
// the workspace id. Reloading the app restores the user's last layout.
//
// Always-have-one-tab: closing the last tab is a no-op so the workspace
// never renders an empty stack with no tab strip context. Callers can
// still spawn a new tab and close the old one in a single action via the
// store's open + close pair.

const STORAGE_KEY_PREFIX = "spark.tabs:";
// Draft chat tabs (clicked "+", no first message yet) carry a runtime-only id
// with this prefix so the App-level sync effect can leave them alone while it
// reconciles run-backed chat tabs.
const DRAFT_CHAT_PREFIX = "draft:";
// v5: chat tabs are now derived from the run store rather than persisted as a
// singleton "spark-chat" tab. Loading v4 layouts forces a chat-tab rebuild
// by the App sync effect — editor/terminal/preview tabs survive. v4
// introduced chat-scoped Runs tabs. v3 dropped the removed "project"/CRM
// tab kind. v2 introduced the recursive PaneNode tree on TerminalTab.
const TAB_VERSION = 5;
const MAX_TERMINAL_SCROLLBACK_CHARS = 40_000;

interface PersistedShape {
  v: number;
  tabs: Tab[];
  activeId: TabId | null;
}

function storageKey(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  return `${STORAGE_KEY_PREFIX}${workspaceId}`;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "preview";
  }
}

// Build a readable row-major grid for batches of agent terminals. The old
// recursive split kept equal area but produced awkward mixed columns for
// counts like 5; rows keep the scan path predictable (5 -> 3 over 2).
function buildPaneGrid(leaves: TerminalLeaf[]): PaneNode {
  if (leaves.length <= 1) return leaves[0];
  const columns = Math.ceil(Math.sqrt(leaves.length));
  const rows = Math.ceil(leaves.length / columns);
  const rowSizes = distributeGridRows(leaves.length, rows);
  let index = 0;
  const rowItems = rowSizes.map((size) => {
    const rowLeaves = leaves.slice(index, index + size);
    index += size;
    return {
      node: buildWeightedPaneLine(
        rowLeaves.map((item) => ({ node: item, weight: 1 })),
        "horizontal",
      ),
      weight: size,
    };
  });
  return buildWeightedPaneLine(rowItems, "vertical");
}

function distributeGridRows(count: number, rows: number): number[] {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, index) => base + (index < extra ? 1 : 0));
}

function buildWeightedPaneLine(
  items: Array<{ node: PaneNode; weight: number }>,
  direction: TerminalSplit["direction"],
): PaneNode {
  if (items.length === 0) {
    throw new Error("Cannot build an empty terminal pane grid.");
  }
  if (items.length === 1) return items[0].node;
  const head = Math.ceil(items.length / 2);
  const aItems = items.slice(0, head);
  const bItems = items.slice(head);
  const aWeight = aItems.reduce((sum, item) => sum + item.weight, 0);
  const total = aWeight + bItems.reduce((sum, item) => sum + item.weight, 0);
  return {
    kind: "split",
    direction,
    ratio: aWeight / total,
    a: buildWeightedPaneLine(aItems, direction),
    b: buildWeightedPaneLine(bItems, direction),
  };
}

function terminalTitleForIndex(index: number): string {
  return index === 0 ? "terminals" : `terminals ${index + 1}`;
}

function terminalTitleKey(title: string): string {
  return title.trim().toLowerCase();
}

function reserveNextTerminalTitle(used: Set<string>): string {
  for (let index = 0; ; index += 1) {
    const title = terminalTitleForIndex(index);
    const key = terminalTitleKey(title);
    if (!used.has(key)) {
      used.add(key);
      return title;
    }
  }
}

function normalizeTerminalTitles(tabs: Tab[]): Tab[] {
  const used = new Set<string>();
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.kind !== "terminal") return tab;
    if (tab.scope?.kind === "workers") return tab;
    const key = terminalTitleKey(tab.title);
    if (key && !used.has(key)) {
      used.add(key);
      return tab;
    }
    const title = reserveNextTerminalTitle(used);
    changed = true;
    return { ...tab, title };
  });
  return changed ? next : tabs;
}

function createTerminalTab(cwd?: string, autorun?: string, title = "terminals"): TerminalTab {
  const id = makeId("term");
  const paneId = makeId("pane");
  const root = leaf(paneId, cwd, autorun);
  return {
    id,
    kind: "terminal",
    title,
    root,
    activePaneId: paneId,
  };
}

function createDraftChatTab(): ChatTab {
  return {
    id: `${DRAFT_CHAT_PREFIX}${makeId("chat")}`,
    kind: "chat",
    title: "New chat",
  };
}

function createChatTabForRun(runId: string, title: string): ChatTab {
  return {
    id: runId,
    kind: "chat",
    title: title?.trim() || "Spark",
  };
}

export function isDraftChatTabId(id: TabId): boolean {
  return id.startsWith(DRAFT_CHAT_PREFIX);
}

// Guarantee at least one chat tab exists. Used after persistence load and
// after destructive ops that could leave the strip without any chat — the
// workspace's chat-first UX assumes one is always available.
function ensureAnyChatTab(tabs: Tab[]): Tab[] {
  if (tabs.some((tab) => tab.kind === "chat")) return tabs;
  return [createDraftChatTab(), ...tabs];
}

function defaultTabs(cwd?: string): Tab[] {
  return [createDraftChatTab(), createTerminalTab(cwd)];
}

function loadPersisted(workspaceId: string | null): PersistedShape | null {
  const key = storageKey(workspaceId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || parsed.v !== TAB_VERSION || !Array.isArray(parsed.tabs)) {
      return null;
    }
    // Drop terminal-worker metadata from persisted layouts. Worker chips are
    // live-session state: manual Claude/Codex chips disappear as soon as the
    // agent returns to the shell, and Spark-owned "done" chips are shown only
    // right after a real worker attempt finishes in this app session. Restored
    // panes are fresh shells, so carrying old badges forward makes idle panes
    // look like they still belong to Claude/Codex.
    // Runs tabs are derived from the selected chat, not durable workspace
    // layout. Keep persisted editor/terminal/preview tabs, then recreate the
    // Runs tab only when App selects a chat.
    // Chat tabs are now derived from the run store by the App-level sync
    // effect. Stripping them on load means the workspace always starts with
    // at least one fresh draft chat tab (via ensureAnyChatTab) until the
    // effect rebuilds run-backed chat tabs.
    parsed.tabs = ensureAnyChatTab(
      normalizeTerminalTitles(
        parsed.tabs.filter(
          (tab) =>
            tab.kind !== "runs" &&
            tab.kind !== "chat" &&
            !(tab.kind === "terminal" && tab.scope?.kind === "workers"),
        ),
      ),
    );
    for (const tab of parsed.tabs) {
      if (tab.kind === "terminal") cleanupTransientTerminalState(tab.root);
      if (tab.kind === "runs" && (tab.title === "Runs" || tab.title === "Ops")) tab.title = "Runs";
    }
    return parsed;
  } catch {
    return null;
  }
}

function cleanupTransientTerminalState(node: PaneNode): void {
  if (node.kind === "leaf") {
    delete node.worker;
    delete node.autorun;
    return;
  }
  cleanupTransientTerminalState(node.a);
  cleanupTransientTerminalState(node.b);
}

function persist(workspaceId: string | null, tabs: Tab[], activeId: TabId | null): void {
  const key = storageKey(workspaceId);
  if (!key) return;
  try {
    const payload: PersistedShape = {
      v: TAB_VERSION,
      tabs: stripTransientTerminalState(normalizeTerminalTitles(tabs)),
      activeId,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable; persistence is best-effort.
  }
}

function stripTransientTerminalState(tabs: Tab[]): Tab[] {
  let changed = false;
  const next = tabs.flatMap((tab): Tab[] => {
    if (tab.kind === "terminal" && tab.scope?.kind === "workers") {
      changed = true;
      return [];
    }
    if (tab.kind !== "terminal") return [tab];
    const root = stripTransientPaneState(tab.root);
    if (root === tab.root) return [tab];
    changed = true;
    return [{ ...tab, root }];
  });
  return changed ? next : tabs;
}

function stripTransientPaneState(node: PaneNode): PaneNode {
  if (node.kind === "leaf") {
    if (!("worker" in node) && !("autorun" in node)) return node;
    const { worker: _worker, autorun: _autorun, ...rest } = node;
    return rest;
  }
  const a = stripTransientPaneState(node.a);
  const b = stripTransientPaneState(node.b);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function disposeTerminalTabPanes(tab: Tab): void {
  if (tab.kind !== "terminal") return;
  for (const pane of collectLeaves(tab.root)) {
    void window.spark.pty.dispose(pane.paneId).catch(() => undefined);
  }
}

// Resolve the initial tabs + activeId for a workspace in a SINGLE
// localStorage read. Both the lazy useState initializer and the
// workspace-switch effect funnel through here so loadPersisted (a
// JSON.parse + a recursive transient-terminal cleanup walk) only runs once per
// mount/switch instead of three times. Falls back to the default tab set
// when nothing is persisted (or the persisted blob is a stale version).
function initialTabsState(workspaceId: string | null, defaultCwd?: string): {
  tabs: Tab[];
  activeId: TabId | null;
} {
  const loaded = loadPersisted(workspaceId);
  if (loaded && loaded.tabs.length > 0) {
    const activeId =
      loaded.activeId && loaded.tabs.some((t) => t.id === loaded.activeId)
        ? loaded.activeId
        : loaded.tabs[0].id;
    return { tabs: loaded.tabs, activeId };
  }
  const seed = defaultTabs(defaultCwd);
  return { tabs: seed, activeId: seed[0].id };
}

export interface UseTabsApi {
  tabs: Tab[];
  activeId: TabId | null;
  activeTab: Tab | null;
  setActiveTab: (id: TabId) => void;
  closeTab: (id: TabId) => void;
  closeOthers: (id: TabId) => void;
  cycleNext: () => void;
  cyclePrev: () => void;
  selectByIndex: (idx: number) => void;
  // Reorder tabs in the strip. `position` decides whether the dragged tab
  // lands BEFORE or AFTER the target. No-op when source and target are the
  // same tab or the move resolves to the existing position.
  reorderTab: (fromId: TabId, toId: TabId, position: "before" | "after") => void;
  setDirty: (id: TabId, dirty: boolean) => void;
  setDetectedUrl: (tabId: TabId, paneId: string, url: string) => void;
  newTerminalTab: (cwd?: string, autorun?: string, options?: { focus?: boolean }) => TabId;
  // Open ONE terminal tab whose panes are split into a grid — used when Spark
  // spawns a batch of standing agent terminals, so the user sees them all at
  // once. One pane per spec, each autorunning its agent command.
  newTerminalGrid: (
    cwd: string | undefined,
    specs: Array<{ command: string; runtime?: string }>,
  ) => TabId;
  // Add a batch of agent panes into an EXISTING terminal tab as a grid,
  // alongside whatever panes that tab already holds. Used when Spark spawns
  // standing terminals and the user already has a terminal tab open.
  addAgentGridToTab: (
    tabId: TabId,
    cwd: string | undefined,
    specs: Array<{ command: string; runtime?: string }>,
  ) => void;
  addBalancedPaneToTab: (
    tabId: TabId,
    paneId: string,
    options?: {
      cwd?: string;
      autorun?: string;
      worker?: TerminalLeafWorker | null;
    },
  ) => boolean;
  ensureWorkerTerminalTab: (
    runId: string,
    cwd: string | undefined,
    paneId: string,
    worker: TerminalLeafWorker,
    options?: { focus?: boolean },
  ) => TabId;
  detachTerminalPaneToNewTab: (tabId: TabId, paneId: string) => TabId | null;
  moveTerminalPane: (
    sourceTabId: TabId,
    paneId: string,
    targetTabId: TabId,
    target?: {
      paneId: string;
      direction: TerminalSplit["direction"];
      position: "before" | "after";
      mode?: "split" | "line";
    },
  ) => boolean;
  splitTerminalPane: (
    tabId: TabId,
    paneId: string,
    direction: TerminalSplit["direction"],
    autorun?: string,
  ) => string | null;
  closeTerminalPane: (tabId: TabId, paneId: string) => void;
  // Flip `zoomedPaneId` for a tab: sets it to `paneId` if currently null or a
  // different pane, clears it if `paneId` is already the zoomed one. Stored
  // on the tab so it persists across tab switches.
  toggleTerminalPaneZoom: (tabId: TabId, paneId: string) => void;
  setActiveTerminalPane: (tabId: TabId, paneId: string) => void;
  setTerminalSplitRatio: (tabId: TabId, path: PanePath, ratio: number) => void;
  setLeafCwd: (tabId: TabId, paneId: string, cwd: string) => void;
  setLeafScrollback: (tabId: TabId, paneId: string, scrollback: string) => void;
  setLeafWorker: (tabId: TabId, paneId: string, worker: TerminalLeafWorker | null) => void;
  // Rename a leaf's paneId. The caller must dispose the old PTY when it is
  // intentionally replacing a live shell. The new TerminalPane mounts at the
  // new id and spawns/attaches there. Used by orchestration to take over an
  // existing user pane so worker output appears where the user can see it.
  renameLeaf: (tabId: TabId, oldPaneId: string, newPaneId: string) => boolean;
  // Smart-add a leaf in a specific tab using a caller-supplied paneId. Picks
  // the largest existing leaf as the split anchor; useful for orchestration
  // when no idle leaf is available to claim.
  addPaneInTab: (
    tabId: TabId,
    paneId: string,
    options?: {
      rootWidth?: number;
      rootHeight?: number;
      cwd?: string;
      autorun?: string;
      worker?: TerminalLeafWorker | null;
    },
  ) => boolean;
  // Focus (or create) the chat tab for a specific run. Pass `null` to focus
  // the most recent draft chat tab, creating a fresh one if none exists.
  openChatTab: (input: { runId: string | null; focus?: boolean }) => TabId;
  // Sync the chat tab set to the current run list. Adds missing run-backed
  // chat tabs, updates titles, and removes chat tabs whose run was deleted.
  // Drafts are left alone — they live until the user closes them or sends
  // their first message (then promoteDraftToRun rekeys the tab).
  syncChatTabsToRuns: (runs: Array<{ id: string; title: string }>) => void;
  // Append a fresh draft chat tab and focus it. Used by the top tab strip's
  // "+" affordance for "start a new chat" — the composer then drives the
  // promote-to-run swap on first message.
  addDraftChatTab: () => TabId;
  // Convert a draft chat tab into a run-backed one by rekeying its id to
  // the new run id and updating the title. If activeId was the draft, it
  // follows the rename. No-op if `draftTabId` doesn't exist or isn't a
  // draft.
  promoteDraftChatTab: (draftTabId: TabId, runId: string, title: string) => void;
  // Remove the chat tab for `runId`. If activeId was that tab, fall back to
  // another chat tab (creating a draft if none remain).
  closeChatTabForRun: (runId: string) => void;
  // Rename a chat tab's title in the local store. The renderer also calls
  // the renameRun IPC so the backend persists the new title; this method
  // gives an immediate visual update without waiting for the run snapshot
  // to round-trip back.
  renameChatTab: (id: TabId, title: string) => void;
  newPreviewTab: (url: string, options?: { runId?: string | null }) => TabId;
  // Open (or relabel) the runs tab bound to a chat. Each chat owns exactly
  // one runs tab. `focus` selects it too — true for explicit navigation,
  // false for the background "ensure the active chat has a tab" effect.
  openRunsTab: (runId: string, title: string, focus: boolean) => TabId;
  hideRunsTabs: () => void;
  // Close the runs tab bound to a chat (used when the chat is deleted).
  closeRunsTabFor: (runId: string) => void;
  closeWorkerTerminalTabFor: (runId: string) => void;
  openEditorTab: (entry: FsEntry, options?: { preview?: boolean }) => TabId;
  pinEditorTab: (id: TabId) => void;
  setEditorEntry: (oldPath: string, entry: FsEntry) => void;
  closeEditorByPath: (path: string) => void;
  setActiveEditorPath: (path: string) => void;
  setActiveRunId: (runId: string | null) => void;
  setPreviewUrl: (id: TabId, url: string) => void;
  registerDispose: (id: TabId, fn: () => void) => void;
}

export function useTabs(workspaceId: string | null, defaultCwd?: string): UseTabsApi {
  // Parse the persisted layout ONCE for the initial mount. The previous
  // implementation called loadPersisted from both useState initializers,
  // re-doing the JSON.parse + recursive transient-terminal cleanup walk twice; a
  // single lazy initializer holding the {tabs, activeId} pair collapses
  // that to one parse. We keep `tabs` and `activeId` as separate useState
  // cells (so the many mutating callbacks below stay untouched) and just
  // seed both from one computed snapshot.
  const initial = useState(() => initialTabsState(workspaceId, defaultCwd))[0];
  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeId, setActiveId] = useState<TabId | null>(initial.activeId);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const liveWorkspaceTabsRef = useRef(new Map<string, { tabs: Tab[]; activeId: TabId | null }>());
  const tabsWorkspaceIdRef = useRef(workspaceId);
  if (tabsWorkspaceIdRef.current) {
    liveWorkspaceTabsRef.current.set(tabsWorkspaceIdRef.current, { tabs, activeId });
  }
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // When the workspace switches, swap tabs to that workspace's live in-memory
  // snapshot first, then fall back to its persisted layout. Persistence strips
  // derived Runs tabs; the live snapshot keeps them so switching away from a
  // workspace and back restores the exact workbench tab the user was on.
  //
  // initialTabsState parses localStorage exactly once (was three reads
  // before: two initializers + this effect). The `firstRun` guard skips the
  // redundant re-parse on mount — the lazy initializer above already
  // produced this exact value, so re-running it here would be wasted work.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      tabsWorkspaceIdRef.current = workspaceId;
      return;
    }
    const previousWorkspaceId = tabsWorkspaceIdRef.current;
    if (previousWorkspaceId) {
      liveWorkspaceTabsRef.current.set(previousWorkspaceId, { tabs, activeId });
    }
    const live = workspaceId ? liveWorkspaceTabsRef.current.get(workspaceId) : null;
    const next = live ?? initialTabsState(workspaceId, defaultCwdRef.current);
    tabsWorkspaceIdRef.current = workspaceId;
    setTabs(next.tabs);
    setActiveId(next.activeId);
  }, [workspaceId]);

  useEffect(() => {
    setTabs((curr) => normalizeTerminalTitles(curr));
  }, [workspaceId]);

  // Persist on every change, but DEBOUNCED. A synchronous JSON.stringify +
  // localStorage.setItem on every `tabs` mutation is fine for clicks, but a
  // split-handle drag mutates `tabs` continuously (one setRatioAtPath per
  // pointermove) — that would block the main thread on a localStorage write
  // dozens of times a second. A 300ms trailing timer coalesces the burst
  // into a single write once the drag settles. Persistence is best-effort,
  // so dropping intermediate states is fine.
  //
  // workspaceId is in the dep array (and captured lexically below) so a
  // workspace switch clears any timer the OLD workspace armed — otherwise a
  // pending write could land the old workspace's tabs under the new
  // workspace's storage key. The latest payload is also mirrored into a ref
  // so the unmount flush can write without forcing the flush effect to
  // re-arm on every tab change.
  const persistTimer = useRef<number | null>(null);
  const persistPayloadRef = useRef<{
    workspaceId: string | null;
    tabs: Tab[];
    activeId: TabId | null;
  }>({ workspaceId, tabs, activeId });
  persistPayloadRef.current = { workspaceId, tabs, activeId };
  useEffect(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      persist(workspaceId, tabs, activeId);
    }, 300);
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    };
  }, [tabs, activeId, workspaceId]);

  // Flush any pending persist on unmount so a layout change made just
  // before the component tears down isn't lost. Empty deps → runs only on
  // final unmount; reads the latest payload (including workspaceId) through
  // the ref so the write targets the correct storage key.
  useEffect(() => {
    return () => {
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
        const { workspaceId: ws, tabs: t, activeId: a } = persistPayloadRef.current;
        persist(ws, t, a);
      }
    };
  }, []);

  // Per-tab dispose callbacks (PTY teardown, etc.). We hold them in a ref
  // so registration can happen at any time without forcing a re-render.
  const disposers = useRef(new Map<TabId, () => void>());
  const registerDispose = useCallback((id: TabId, fn: () => void) => {
    disposers.current.set(id, fn);
  }, []);

  const fireDispose = useCallback((id: TabId) => {
    const fn = disposers.current.get(id);
    if (fn) {
      try {
        fn();
      } catch {
        /* dispose is best-effort */
      }
      disposers.current.delete(id);
    }
  }, []);

  const setActiveTab = useCallback((id: TabId) => {
    setActiveId((current) => (current === id ? current : id));
  }, []);

  const closeTab = useCallback(
    (id: TabId) => {
      setTabs((curr) => {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((t) => t.id === id);
        if (idx === -1) return curr;
        if (curr[idx].kind === "chat") return curr;
        disposeTerminalTabPanes(curr[idx]);
        const next = curr.filter((t) => t.id !== id);
        setActiveId((active) => {
          if (active !== id) return active;
          // Prefer the tab to the left, fall back to the first.
          return next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null;
        });
        fireDispose(id);
        return normalizeTerminalTitles(next);
      });
    },
    [fireDispose],
  );

  const closeOthers = useCallback(
    (keepId: TabId) => {
      setTabs((curr) => {
        const target = curr.find((t) => t.id === keepId);
        if (!target) return curr;
        const next = curr.filter(
          (t) =>
            t.id === keepId ||
            t.kind === "chat" ||
            (t.kind === "terminal" && t.scope?.kind === "workers"),
        );
        const removed = curr.filter((t) => !next.some((kept) => kept.id === t.id));
        for (const t of removed) {
          disposeTerminalTabPanes(t);
          fireDispose(t.id);
        }
        setActiveId(keepId);
        return normalizeTerminalTitles(next);
      });
    },
    [fireDispose],
  );

  // Read the latest tabs through a ref so cycleBy keeps a stable identity
  // and shortcut wiring doesn't rebind on every list mutation.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const cycleBy = useCallback((delta: number) => {
    setActiveId((active) => {
      const list = tabsRef.current;
      if (!active || list.length === 0) return active;
      const idx = list.findIndex((t) => t.id === active);
      if (idx === -1) return active;
      const nextIdx = (idx + delta + list.length) % list.length;
      return list[nextIdx].id;
    });
  }, []);

  const cycleNext = useCallback(() => cycleBy(1), [cycleBy]);
  const cyclePrev = useCallback(() => cycleBy(-1), [cycleBy]);

  const reorderTab = useCallback(
    (fromId: TabId, toId: TabId, position: "before" | "after") => {
      if (fromId === toId) return;
      setTabs((curr) => {
        const fromIdx = curr.findIndex((t) => t.id === fromId);
        const toIdx = curr.findIndex((t) => t.id === toId);
        if (fromIdx === -1 || toIdx === -1) return curr;
        const next = curr.slice();
        const [moving] = next.splice(fromIdx, 1);
        // After the splice, indices to the right of fromIdx shifted left by 1.
        const adjustedToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
        const insertIdx = position === "after" ? adjustedToIdx + 1 : adjustedToIdx;
        if (insertIdx === fromIdx) return curr;
        next.splice(insertIdx, 0, moving);
        return normalizeTerminalTitles(next);
      });
    },
    [],
  );

  const selectByIndex = useCallback((idx: number) => {
    setTabs((curr) => {
      const target = curr[idx];
      if (target) setActiveId(target.id);
      return curr;
    });
  }, []);

  const setDirty = useCallback((id: TabId, dirty: boolean) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "editor"
          ? { ...t, dirty, preview: dirty ? false : t.preview }
          : t,
      ),
    );
  }, []);

  const setDetectedUrl = useCallback(
    (tabId: TabId, paneId: string, url: string) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const root = setLeafField(t.root, paneId, "detectedUrl", url);
          return root === t.root ? t : { ...t, root };
        }),
      );
    },
    [],
  );

  const newTerminalTab = useCallback(
    (cwd?: string, autorun?: string, options?: { focus?: boolean }): TabId => {
      const id = makeId("term");
      const paneId = makeId("pane");
      const root = leaf(paneId, cwd, autorun);
      setTabs((curr) => {
        const tab: TerminalTab = {
          id,
          kind: "terminal",
          title: "terminals",
          root,
          activePaneId: paneId,
        };
        return normalizeTerminalTitles([...curr, tab]);
      });
      if (options?.focus !== false) setActiveId(id);
      return id;
    },
    [],
  );

  const newTerminalGrid = useCallback(
    (
      cwd: string | undefined,
      specs: Array<{ command: string; runtime?: string }>,
    ): TabId => {
      const id = makeId("term");
      const entries = specs.length > 0 ? specs : [{ command: "", runtime: "" }];
      const leaves: TerminalLeaf[] = entries.map((spec) => {
        const paneId = makeId("pane");
        return leaf(paneId, cwd, spec.command || undefined);
      });
      setTabs((curr) => {
        const tab: TerminalTab = {
          id,
          kind: "terminal",
          title: "terminals",
          root: buildPaneGrid(leaves),
          activePaneId: leaves[0].paneId,
        };
        return normalizeTerminalTitles([...curr, tab]);
      });
      setActiveId(id);
      return id;
    },
    [],
  );

  const addAgentGridToTab = useCallback(
    (
      tabId: TabId,
      cwd: string | undefined,
      specs: Array<{ command: string; runtime?: string }>,
    ): void => {
      if (specs.length === 0) return;
      const newLeaves: TerminalLeaf[] = specs.map((spec) => {
        const paneId = makeId("pane");
        return leaf(paneId, cwd, spec.command || undefined);
      });
      const newGrid = buildPaneGrid(newLeaves);
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          // Combine the tab's current panes and the new agent grid side by
          // side; ratio by leaf count so every pane stays roughly equal-area.
          const existingCount = collectLeaves(t.root).length;
          const total = existingCount + newLeaves.length;
          const root: PaneNode = {
            kind: "split",
            direction: "horizontal",
            ratio: existingCount / total,
            a: t.root,
            b: newGrid,
          };
          return { ...t, root, activePaneId: newLeaves[0].paneId };
        }),
      );
      setActiveId(tabId);
    },
    [],
  );

  const addBalancedPaneToTab = useCallback(
    (
      tabId: TabId,
      paneId: string,
      options?: {
        cwd?: string;
        autorun?: string;
        worker?: TerminalLeafWorker | null;
      },
    ): boolean => {
      let added = false;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (findLeaf(t.root, paneId)) {
            added = true;
            return t;
          }
          const newLeaf = leaf(paneId, options?.cwd, options?.autorun);
          if (options?.worker !== undefined) newLeaf.worker = options.worker;
          const root = buildPaneGrid([...collectLeaves(t.root), newLeaf]);
          added = true;
          return { ...t, root, activePaneId: paneId };
        }),
      );
      return added;
    },
    [],
  );

  const ensureWorkerTerminalTab = useCallback(
    (
      runId: string,
      cwd: string | undefined,
      paneId: string,
      worker: TerminalLeafWorker,
      options?: { focus?: boolean },
    ): TabId => {
      const existingId = tabsRef.current.find(
        (t): t is TerminalTab =>
          t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId,
      )?.id;
      const resultId = existingId ?? makeId("term");
      setTabs((curr) => {
        const existing = curr.find(
          (t): t is TerminalTab =>
            t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId,
        );
        if (existing) {
          const hasPane = Boolean(findLeaf(existing.root, paneId));
          const newLeaf = leaf(paneId, cwd);
          newLeaf.worker = worker;
          const root = hasPane
            ? setLeafField(
                cwd
                  ? setLeafField(existing.root, paneId, "cwd", cwd)
                  : existing.root,
                paneId,
                "worker",
                worker,
              )
            : buildPaneGrid([
                ...collectLeaves(existing.root),
                newLeaf,
              ]);
          return curr.map((tab) =>
            tab.id === existing.id && tab.kind === "terminal"
              ? {
                  ...tab,
                  title: "workers",
                  scope: { kind: "workers", runId },
                  root,
                  activePaneId: paneId,
                }
              : tab,
          );
        }
        const firstLeaf = leaf(paneId, cwd);
        firstLeaf.worker = worker;
        const tab: TerminalTab = {
          id: resultId,
          kind: "terminal",
          title: "workers",
          scope: { kind: "workers", runId },
          root: firstLeaf,
          activePaneId: paneId,
        };
        return [...curr, tab];
      });
      if (options?.focus === true) setActiveId(resultId);
      return resultId;
    },
    [],
  );

  const detachTerminalPaneToNewTab = useCallback(
    (tabId: TabId, paneId: string): TabId | null => {
      const currentSource = tabsRef.current.find(
        (t): t is TerminalTab => t.id === tabId && t.kind === "terminal",
      );
      if (!currentSource) return null;
      const currentLeaves = collectLeaves(currentSource.root);
      if (currentLeaves.length <= 1 || !currentLeaves.some((item) => item.paneId === paneId)) {
        return null;
      }
      const newTabId = makeId("term");
      setTabs((curr) => {
        const source = curr.find((t): t is TerminalTab => t.id === tabId && t.kind === "terminal");
        if (!source) return curr;
        const sourceLeaves = collectLeaves(source.root);
        if (sourceLeaves.length <= 1) return curr;
        const movingLeaf = sourceLeaves.find((item) => item.paneId === paneId);
        if (!movingLeaf) return curr;
        const nextRoot = removeLeaf(source.root, paneId);
        if (!nextRoot) return curr;
        const remainingLeaves = collectLeaves(nextRoot);
        const newTab: TerminalTab = {
          id: newTabId,
          kind: "terminal",
          title: "terminals",
          root: movingLeaf,
          activePaneId: movingLeaf.paneId,
        };
        return normalizeTerminalTitles([
          ...curr.map((t) => {
            if (t.id !== tabId || t.kind !== "terminal") return t;
            const activePaneId =
              t.activePaneId === paneId
                ? remainingLeaves[0]?.paneId ?? t.activePaneId
                : t.activePaneId;
            return { ...t, root: nextRoot, activePaneId };
          }),
          newTab,
        ]);
      });
      setActiveId(newTabId);
      return newTabId;
    },
    [],
  );

  const moveTerminalPane = useCallback(
    (
      sourceTabId: TabId,
      paneId: string,
      targetTabId: TabId,
      target?: {
        paneId: string;
        direction: TerminalSplit["direction"];
        position: "before" | "after";
        mode?: "split" | "line";
      },
    ): boolean => {
      if (sourceTabId === targetTabId && target?.paneId === paneId) return false;
      if (sourceTabId === targetTabId && !target) return false;
      const sourceSnapshot = tabsRef.current.find(
        (t): t is TerminalTab => t.id === sourceTabId && t.kind === "terminal",
      );
      const targetSnapshot = tabsRef.current.find(
        (t): t is TerminalTab => t.id === targetTabId && t.kind === "terminal",
      );
      if (!sourceSnapshot || !targetSnapshot) return false;
      const sourceLeaves = collectLeaves(sourceSnapshot.root);
      const movingLeaf = sourceLeaves.find((item) => item.paneId === paneId);
      if (!movingLeaf) return false;
      if (sourceTabId === targetTabId && sourceLeaves.length <= 1) return false;
      if (target && !findLeaf(targetSnapshot.root, target.paneId)) return false;

      setTabs((curr) => {
        const source = curr.find(
          (t): t is TerminalTab => t.id === sourceTabId && t.kind === "terminal",
        );
        const destination = curr.find(
          (t): t is TerminalTab => t.id === targetTabId && t.kind === "terminal",
        );
        if (!source || !destination) return curr;
        const liveSourceLeaves = collectLeaves(source.root);
        const liveMovingLeaf = liveSourceLeaves.find((item) => item.paneId === paneId);
        if (!liveMovingLeaf) return curr;
        if (sourceTabId === targetTabId && target?.paneId === paneId) return curr;
        if (sourceTabId === targetTabId && !target) return curr;
        if (sourceTabId === targetTabId && liveSourceLeaves.length <= 1) return curr;
        if (target && !findLeaf(destination.root, target.paneId)) return curr;

        const sourceRoot = removeLeaf(source.root, paneId);
        if (!sourceRoot && sourceTabId === targetTabId) return curr;
        let destinationRoot: PaneNode;
        if (target) {
          const insertBase = sourceTabId === targetTabId ? sourceRoot : destination.root;
          if (!insertBase) return curr;
          destinationRoot = insertLeafAtLeaf(
            insertBase,
            target.paneId,
            target.direction,
            liveMovingLeaf,
            target.position,
            { rebalanceLine: target.mode === "line" },
          );
          if (destinationRoot === insertBase) return curr;
        } else {
          const existingCount = collectLeaves(destination.root).length;
          destinationRoot = {
            kind: "split",
            direction: "horizontal",
            ratio: existingCount / (existingCount + 1),
            a: destination.root,
            b: liveMovingLeaf,
          };
        }

        const next = curr.flatMap((tab): Tab[] => {
          if (tab.id === sourceTabId && tab.kind === "terminal") {
            if (!sourceRoot) return [];
            const remainingLeaves = collectLeaves(sourceRoot);
            const activePaneId =
              tab.activePaneId === paneId
                ? remainingLeaves[0]?.paneId ?? tab.activePaneId
                : tab.activePaneId;
            const root = sourceTabId === targetTabId ? destinationRoot : sourceRoot;
            return [{ ...tab, root, activePaneId: sourceTabId === targetTabId ? paneId : activePaneId }];
          }
          if (tab.id === targetTabId && tab.kind === "terminal") {
            return [{ ...tab, root: destinationRoot, activePaneId: paneId }];
          }
          return [tab];
        });
        return normalizeTerminalTitles(next);
      });
      setActiveId(targetTabId);
      return true;
    },
    [],
  );

  const splitTerminalPane = useCallback(
    (
      tabId: TabId,
      paneId: string,
      direction: TerminalSplit["direction"],
      autorun?: string,
    ): string | null => {
      let newPaneId: string | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const target = findLeaf(t.root, paneId);
          if (!target) return t;
          const fresh = makeId("pane");
          newPaneId = fresh;
          const newLeaf = leaf(fresh, target.cwd, autorun);
          const root = splitAtLeaf(
            t.root,
            paneId,
            direction,
            // Inherit cwd from the source pane so a split reflects the user's
            // current shell directory rather than dropping back to project root.
            newLeaf,
          );
          // Splitting a zoomed pane unzooms (the other panes need to be
          // visible again so the new split is meaningful).
          return { ...t, root, activePaneId: fresh, zoomedPaneId: null };
        }),
      );
      return newPaneId;
    },
    [],
  );

  const closeTerminalPane = useCallback(
    (tabId: TabId, paneId: string) => {
      // Best-effort PTY teardown — the renderer-side TerminalPane already
      // calls dispose on unmount, but we call it here too so a programmatic
      // close (split with one child) reaps the conpty even if the React tree
      // is still in the middle of unmounting.
      void window.spark.pty.dispose(paneId).catch(() => undefined);
      setTabs((curr) => {
        const next: Tab[] = [];
        let dropped = false;
        for (const t of curr) {
          if (t.id !== tabId || t.kind !== "terminal") {
            next.push(t);
            continue;
          }
          const root = removeLeaf(t.root, paneId);
          if (root === null) {
            // Last pane closed — drop the tab. Same UX as the close button on
            // the tab strip; we mirror closeTab's "always-keep-one" guard
            // below to never let the workbench end up with zero tabs.
            dropped = true;
            continue;
          }
          let activePaneId = t.activePaneId;
          if (activePaneId === paneId) {
            const fallback = nextLeafAfter(root, paneId);
            activePaneId = fallback?.paneId ?? activePaneId;
          }
          // If the closing pane was the zoomed one, drop the zoom so the
          // restored layout shows everything. (Closing a non-zoomed pane
          // while another is zoomed leaves the zoom intact.)
          const zoomedPaneId = t.zoomedPaneId === paneId ? null : t.zoomedPaneId;
          next.push({ ...t, root, activePaneId, zoomedPaneId });
        }
        if (next.length === 0) {
          // Restoring the seed tab keeps the workbench from rendering an
          // empty stack; matches closeTab's invariant.
          const seed = defaultTabs(defaultCwdRef.current);
          setActiveId(seed[0].id);
          return seed;
        }
        if (dropped) {
          setActiveId((active) => {
            if (active !== tabId) return active;
            return next[next.length - 1]?.id ?? null;
          });
        }
        return normalizeTerminalTitles(next);
      });
    },
    [],
  );

  const setActiveTerminalPane = useCallback(
    (tabId: TabId, paneId: string) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (t.activePaneId === paneId) return t;
          if (!findLeaf(t.root, paneId)) return t;
          return { ...t, activePaneId: paneId };
        }),
      );
    },
    [],
  );

  // Toggle the per-tab zoom: a second click on the same pane unzooms;
  // pressing zoom on a different pane re-zooms onto that pane. The split
  // tree and its ratios are untouched, so unzoom restores the exact layout.
  const toggleTerminalPaneZoom = useCallback(
    (tabId: TabId, paneId: string) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (!findLeaf(t.root, paneId)) return t;
          const next = t.zoomedPaneId === paneId ? null : paneId;
          if ((t.zoomedPaneId ?? null) === next) return t;
          return { ...t, zoomedPaneId: next, activePaneId: paneId };
        }),
      );
    },
    [],
  );

  const setTerminalSplitRatio = useCallback(
    (tabId: TabId, path: PanePath, ratio: number) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const root = setRatioAtPath(t.root, path, ratio);
          return root === t.root ? t : { ...t, root };
        }),
      );
    },
    [],
  );

  const setLeafCwd = useCallback(
    (tabId: TabId, paneId: string, cwd: string) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const existing = findLeaf(t.root, paneId);
          if (!existing || existing.cwd === cwd) return t;
          const root = setLeafField(t.root, paneId, "cwd", cwd);
          return root === t.root ? t : { ...t, root };
        }),
      );
    },
    [],
  );

  const setLeafWorker = useCallback(
    (tabId: TabId, paneId: string, worker: TerminalLeafWorker | null) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const root = setLeafField(t.root, paneId, "worker", worker);
          return root === t.root ? t : { ...t, root };
        }),
      );
    },
    [],
  );

  // Rename a leaf's paneId. Walks the tree, swaps the id, and bumps the
  // tab's activePaneId to point at the new id if it used to point at the
  // old one. Returns true if the leaf was found, false otherwise.
  const renameLeaf = useCallback(
    (tabId: TabId, oldPaneId: string, newPaneId: string): boolean => {
      let found = false;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const existing = findLeaf(t.root, oldPaneId);
          if (!existing) return t;
          found = true;
          const root = setLeafField(t.root, oldPaneId, "paneId", newPaneId);
          const activePaneId = t.activePaneId === oldPaneId ? newPaneId : t.activePaneId;
          return { ...t, root, activePaneId };
        }),
      );
      return found;
    },
    [],
  );

  // Add a leaf with a caller-supplied paneId to `tabId`. If the tab already
  // has at least one leaf, smart-splits the largest one (so the new pane
  // lands where there's the most room). If the tab is empty/missing, we
  // can't recover here — caller should have created the tab first.
  const addPaneInTab = useCallback(
    (
      tabId: TabId,
      paneId: string,
      options?: {
        rootWidth?: number;
        rootHeight?: number;
        cwd?: string;
        autorun?: string;
        worker?: TerminalLeafWorker | null;
      },
    ): boolean => {
      let added = false;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (findLeaf(t.root, paneId)) {
            // already present; nothing to do but treat as success
            added = true;
            return t;
          }
          const target = smartAddTarget(
            t.root,
            options?.rootWidth ?? 1600,
            options?.rootHeight ?? 900,
          );
          if (!target) return t;
          const newLeaf = leaf(paneId, options?.cwd, options?.autorun);
          if (options?.worker !== undefined) newLeaf.worker = options.worker;
          const root = splitAtLeaf(t.root, target.paneId, target.direction, newLeaf);
          added = true;
          return { ...t, root, activePaneId: paneId };
        }),
      );
      return added;
    },
    [],
  );

  const openChatTab = useCallback(
    (input: { runId: string | null; focus?: boolean }): TabId => {
      const focus = input.focus !== false;
      // Pre-batch tabsRef is stale when this runs in the same event as a
      // preceding promoteDraftChatTab or syncChatTabsToRuns — we'd miss the
      // just-added tab and create a duplicate. Run the existence check
      // INSIDE setTabs's updater so we see the latest committed state, and
      // queue setActiveId from within the same updater so the active id
      // matches whatever the updater decided to add or reuse.
      if (input.runId === null) {
        const fallback = `${DRAFT_CHAT_PREFIX}${makeId("chat")}`;
        setTabs((curr) => {
          const existingDraft = curr.find(
            (t): t is ChatTab => t.kind === "chat" && isDraftChatTabId(t.id),
          );
          if (existingDraft) {
            if (focus) setActiveId(existingDraft.id);
            return curr;
          }
          const draft: ChatTab = { id: fallback, kind: "chat", title: "New chat" };
          if (focus) setActiveId(draft.id);
          return [...curr, draft];
        });
        return fallback;
      }
      const runId = input.runId;
      setTabs((curr) => {
        const existing = curr.find(
          (t): t is ChatTab => t.kind === "chat" && t.id === runId,
        );
        if (existing) {
          if (focus) setActiveId(existing.id);
          return curr;
        }
        // Run id is known but the chat tab hasn't been added yet — happens
        // when handleSelectRun fires before the runs[]-sync effect catches
        // up. Seed a placeholder tab; the sync effect will refresh the
        // title.
        const placeholder = createChatTabForRun(runId, "Spark");
        if (focus) setActiveId(placeholder.id);
        return [...curr, placeholder];
      });
      return runId;
    },
    [],
  );

  const syncChatTabsToRuns = useCallback(
    (runList: Array<{ id: string; title: string }>) => {
      setTabs((curr) => {
        const runIds = new Set(runList.map((r) => r.id));
        const titleByRun = new Map(runList.map((r) => [r.id, r.title?.trim() || "Spark"]));
        let changed = false;
        // Drop chat tabs whose run has been deleted; keep drafts.
        const filtered = curr.filter((tab) => {
          if (tab.kind !== "chat") return true;
          if (isDraftChatTabId(tab.id)) return true;
          if (runIds.has(tab.id)) return true;
          changed = true;
          return false;
        });
        // Rename in place when run titles change.
        const renamed = filtered.map((tab) => {
          if (tab.kind !== "chat" || isDraftChatTabId(tab.id)) return tab;
          const nextTitle = titleByRun.get(tab.id);
          if (!nextTitle || nextTitle === tab.title) return tab;
          changed = true;
          return { ...tab, title: nextTitle };
        });
        // Append chat tabs for runs that aren't represented yet. New runs
        // are placed at the end so existing tab positions stay stable.
        const have = new Set(
          renamed.filter((t): t is ChatTab => t.kind === "chat" && !isDraftChatTabId(t.id)).map((t) => t.id),
        );
        const additions: ChatTab[] = [];
        for (const run of runList) {
          if (!have.has(run.id)) {
            additions.push(createChatTabForRun(run.id, run.title));
            changed = true;
          }
        }
        const next = additions.length ? [...renamed, ...additions] : renamed;
        // Workspace always shows at least one chat tab — re-seed a draft if
        // the sync emptied them out (e.g. last run deleted on a fresh
        // workspace with no draft).
        const withChat = ensureAnyChatTab(next);
        if (withChat !== next) changed = true;
        return changed ? withChat : curr;
      });
    },
    [],
  );

  const addDraftChatTab = useCallback((): TabId => {
    const draft = createDraftChatTab();
    setTabs((curr) => [...curr, draft]);
    setActiveId(draft.id);
    return draft.id;
  }, []);

  const promoteDraftChatTab = useCallback(
    (draftTabId: TabId, runId: string, title: string) => {
      setTabs((curr) => {
        const target = curr.find(
          (t): t is ChatTab => t.kind === "chat" && t.id === draftTabId && isDraftChatTabId(t.id),
        );
        if (!target) return curr;
        // If a chat tab for this run already exists (sync effect raced
        // ahead), drop the draft and let the existing tab represent the run.
        const existingForRun = curr.find(
          (t): t is ChatTab => t.kind === "chat" && t.id === runId && !isDraftChatTabId(t.id),
        );
        if (existingForRun) {
          const next = curr.filter((t) => t.id !== draftTabId);
          setActiveId((active) => (active === draftTabId ? existingForRun.id : active));
          return next;
        }
        const renamedTitle = title?.trim() || target.title;
        const next = curr.map((t) =>
          t.id === draftTabId ? { ...(t as ChatTab), id: runId, title: renamedTitle } : t,
        );
        setActiveId((active) => (active === draftTabId ? runId : active));
        return next;
      });
    },
    [],
  );

  const closeChatTabForRun = useCallback((runId: string) => {
    setTabs((curr) => {
      const target = curr.find((t) => t.kind === "chat" && t.id === runId);
      if (!target) return curr;
      const next = curr.filter((t) => t.id !== runId);
      const withChat = ensureAnyChatTab(next);
      // Reroute active selection if the closed tab was active.
      setActiveId((active) => {
        if (active !== runId) return active;
        const fallbackChat = withChat.find((t) => t.kind === "chat");
        return fallbackChat?.id ?? withChat[0]?.id ?? null;
      });
      return withChat;
    });
  }, []);

  const renameChatTab = useCallback((id: TabId, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTabs((curr) => {
      const target = curr.find((t) => t.id === id && t.kind === "chat");
      if (!target || target.title === trimmed) return curr;
      return curr.map((t) => (t.id === id ? { ...t, title: trimmed } : t));
    });
  }, []);

  const newPreviewTab = useCallback(
    (url: string, options?: { runId?: string | null }): TabId => {
      const id = makeId("preview");
      const tab: PreviewTab = {
        id,
        kind: "preview",
        title: titleFromUrl(url),
        url,
        ...(options?.runId ? { runId: options.runId } : {}),
      };
      setTabs((curr) => [...curr, tab]);
      setActiveId(id);
      return id;
    },
    [],
  );

  // Open (or relabel) the Runs tab for the selected chat. Runs tabs are
  // chat-scoped and ephemeral in the workbench: switching chats removes the
  // previous chat's Runs tab from the visible tab strip.
  const openRunsTab = useCallback(
    (runId: string, title: string, focus: boolean): TabId => {
      const existingId = tabsRef.current.find(
        (t): t is RunsTab => t.kind === "runs" && t.runId === runId,
      )?.id;
      const resultId = existingId ?? makeId("runs");
      setTabs((curr) => {
        const scoped = curr.filter((t) => t.kind !== "runs" || t.runId === runId);
        const existing = scoped.find(
          (t): t is RunsTab => t.kind === "runs" && t.runId === runId,
        );
        if (existing) {
          if (existing.title === title && scoped.length === curr.length) return curr;
          const next = scoped.map((t) => (t.id === existing.id ? { ...t, title } : t));
          setActiveId((active) =>
            focus || !active || !next.some((tab) => tab.id === active) ? resultId : active,
          );
          return next;
        }
        const tab: RunsTab = { id: resultId, kind: "runs", title, runId };
        const next = [...scoped, tab];
        setActiveId((active) =>
          focus || !active || !next.some((item) => item.id === active) ? resultId : active,
        );
        return next;
      });
      return resultId;
    },
    [],
  );

  const setLeafScrollback = useCallback(
    (tabId: TabId, paneId: string, scrollback: string) => {
      const trimmed =
        scrollback.length > MAX_TERMINAL_SCROLLBACK_CHARS
          ? scrollback.slice(scrollback.length - MAX_TERMINAL_SCROLLBACK_CHARS)
          : scrollback;
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const existing = findLeaf(t.root, paneId);
          if (!existing || existing.scrollback === trimmed) return t;
          const root = setLeafField(t.root, paneId, "scrollback", trimmed);
          if (root === t.root) return t;
          changed = true;
          return { ...t, root };
        });
        if (changed) persist(workspaceIdRef.current, next, activeIdRef.current);
        return changed ? next : curr;
      });
    },
    [],
  );

  const hideRunsTabs = useCallback(() => {
    setTabs((curr) => {
      const next = curr.filter((t) => t.kind !== "runs");
      if (next.length === curr.length) return curr;
      if (next.length === 0) {
        const seed = defaultTabs(defaultCwdRef.current);
        setActiveId(seed[0].id);
        return seed;
      }
      setActiveId((active) =>
        active && next.some((tab) => tab.id === active) ? active : next[0]?.id ?? null,
      );
      return next;
    });
  }, []);

  // Close the runs tab bound to `runId` (called when a chat is deleted). If
  // it is the only tab, seed a terminal tab instead — the workbench never
  // shows an empty global Runs placeholder.
  const closeRunsTabFor = useCallback(
    (runId: string) => {
      setTabs((curr) => {
        const idx = curr.findIndex(
          (t) => t.kind === "runs" && t.runId === runId,
        );
        if (idx === -1) return curr;
        const tabId = curr[idx].id;
        if (curr.length <= 1) {
          const seed = defaultTabs(defaultCwdRef.current);
          setActiveId(seed[0].id);
          fireDispose(tabId);
          return seed;
        }
        const next = curr.filter((_, i) => i !== idx);
        setActiveId((active) =>
          active === tabId
            ? next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null
            : active,
        );
        fireDispose(tabId);
        return next;
      });
    },
    [fireDispose],
  );

  const closeWorkerTerminalTabFor = useCallback((runId: string) => {
    setTabs((curr) => {
      const idx = curr.findIndex(
        (t) => t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId,
      );
      if (idx === -1) return curr;
      const tabId = curr[idx].id;
      disposeTerminalTabPanes(curr[idx]);
      if (curr.length <= 1) {
        const seed = defaultTabs(defaultCwdRef.current);
        setActiveId(seed[0].id);
        return seed;
      }
      const next = curr.filter((_, i) => i !== idx);
      setActiveId((active) =>
        active === tabId
          ? next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null
          : active,
      );
      return normalizeTerminalTitles(next);
    });
  }, []);

  const openEditorTab = useCallback((entry: FsEntry, options?: { preview?: boolean }): TabId => {
    // The setter is invoked synchronously by React, so reading `outId`
    // back after `setTabs` returns is safe. TypeScript can't see through
    // the closure on its own, hence the unknown-cast at the end.
    let outId: TabId | null = null;
    const usePreview = options?.preview !== false;
    setTabs((curr) => {
      const existing = curr.find(
        (t): t is EditorTab => t.kind === "editor" && t.path === entry.path,
      );
      if (existing) {
        outId = existing.id;
        if (usePreview || !existing.preview) return curr;
        return curr.map((t) =>
          t.id === existing.id && t.kind === "editor"
            ? { ...t, preview: false }
            : t,
        );
      }
      const reusablePreview = usePreview
        ? curr.find(
            (t): t is EditorTab => t.kind === "editor" && Boolean(t.preview) && !t.dirty,
          )
        : null;
      if (reusablePreview) {
        outId = reusablePreview.id;
        return curr.map((t) =>
          t.id === reusablePreview.id && t.kind === "editor"
            ? {
                ...t,
                title: basename(entry.path),
                path: entry.path,
                entry,
                dirty: false,
                preview: true,
              }
            : t,
        );
      }
      const id = makeId("editor");
      outId = id;
      const tab: EditorTab = {
        id,
        kind: "editor",
        title: basename(entry.path),
        path: entry.path,
        entry,
        dirty: false,
        preview: usePreview,
      };
      return [...curr, tab];
    });
    if (outId) setActiveId(outId);
    return (outId ?? makeId("editor")) as TabId;
  }, []);

  const pinEditorTab = useCallback((id: TabId) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "editor" && t.preview
          ? { ...t, preview: false }
          : t,
      ),
    );
  }, []);

  const setEditorEntry = useCallback((oldPath: string, entry: FsEntry) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.kind === "editor" && t.path === oldPath
          ? { ...t, path: entry.path, entry, title: basename(entry.path) }
          : t,
      ),
    );
  }, []);

  const closeEditorByPath = useCallback(
    (path: string) => {
      const target = tabsRef.current.find(
        (t) => t.kind === "editor" && t.path === path,
      );
      if (target) closeTab(target.id);
    },
    [closeTab],
  );

  const setActiveEditorPath = useCallback((path: string) => {
    setTabs((curr) => {
      const target = curr.find((t) => t.kind === "editor" && t.path === path);
      if (target) setActiveId(target.id);
      return curr;
    });
  }, []);

  const setPreviewUrl = useCallback((id: TabId, url: string) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "preview"
          ? { ...t, url, title: titleFromUrl(url) }
          : t,
      ),
    );
  }, []);

  // Compatibility helper for older callers: null hides Runs entirely; an id
  // shows the one chat-scoped Runs tab.
  const setActiveRunId = useCallback((runId: string | null) => {
    if (!runId) {
      hideRunsTabs();
      return;
    }
    openRunsTab(runId, "Runs", false);
  }, [hideRunsTabs, openRunsTab]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // Memoize the public API object so its identity is STABLE across renders
  // that don't touch the tab list. Without this, useTabs handed App.tsx a
  // brand-new object literal every render, invalidating every downstream
  // memo/effect that depends on it (and forcing the whole tabs+stacks
  // workbench to re-render on any unrelated App state change).
  //
  // The dependency array is intentionally just [tabs, activeId, activeTab]:
  // every callback below is already useCallback-stable (empty or ref-backed
  // deps), so it never changes identity and need not be a dependency. The
  // object's identity therefore changes ONLY when the data fields actually
  // change — which is exactly the contract App.tsx's memos want. The object
  // SHAPE is byte-identical to the previous plain return, so App.tsx (which
  // consumes these as named fields) needs no changes.
  return useMemo<UseTabsApi>(
    () => ({
      tabs,
      activeId,
      activeTab,
      setActiveTab,
      closeTab,
      closeOthers,
      cycleNext,
      cyclePrev,
      selectByIndex,
      reorderTab,
      setDirty,
      setDetectedUrl,
      newTerminalTab,
      newTerminalGrid,
      addAgentGridToTab,
      addBalancedPaneToTab,
      ensureWorkerTerminalTab,
      detachTerminalPaneToNewTab,
      moveTerminalPane,
      splitTerminalPane,
      closeTerminalPane,
      toggleTerminalPaneZoom,
      setActiveTerminalPane,
      setTerminalSplitRatio,
      setLeafCwd,
      setLeafScrollback,
      setLeafWorker,
      renameLeaf,
      addPaneInTab,
      openChatTab,
      syncChatTabsToRuns,
      addDraftChatTab,
      promoteDraftChatTab,
      closeChatTabForRun,
      renameChatTab,
      newPreviewTab,
      openRunsTab,
      hideRunsTabs,
      closeRunsTabFor,
      closeWorkerTerminalTabFor,
      openEditorTab,
      pinEditorTab,
      setEditorEntry,
      closeEditorByPath,
      setActiveEditorPath,
      setActiveRunId,
      setPreviewUrl,
      registerDispose,
    }),
    // The callbacks are stable for this hook instance's lifetime; only the
    // three data fields can change, so they're the sole real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, activeId, activeTab],
  );
}
