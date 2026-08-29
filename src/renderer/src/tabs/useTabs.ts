import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  normalizeTerminalScrollbackLineLimit,
  trimTerminalScrollbackLines,
  type FsEntry,
} from "@shared/types";
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
  AutomationsTab,
  ChatTab,
  DiffTab,
  DockableTabKind,
  EditorTab,
  PaneNode,
  PreviewTab,
  RunsTab,
  Tab,
  TabId,
  TerminalAgentSession,
  TerminalLeaf,
  TerminalLeafOrigin,
  TerminalLeafWorker,
  TerminalSplit,
  TerminalTab,
  UsageTab,
  WhiteboardTab,
} from "./types";
import { isRunOwnedTab } from "./types";
import { createManualAgentLaunchWorker } from "./terminalAgentState";
import { moveTabInList } from "./tabReorder";
import { resolveBootActiveTabId } from "./bootSelection";
import { runtimeFromAgentSessionLaunchCommand } from "../workers/launch-commands";
import {
  DOCKABLE_KINDS,
  buildDockIndex,
  canDockTab,
  collectDockLeaves,
  collectTerminalLeaves,
  dockLeaf,
  isDockLeaf,
  planOpenInSplit,
} from "./dock";

// useTabs is the in-memory tabs store for the workspace pane. We keep it as
// a plain React hook (no zustand dependency) since the rest of Codara uses
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
// v6: terminal leaves may carry a durable `agentSession` pointer (Claude/Codex
// session id) and scrollback that survive restart so a reopened pane can
// `--resume`. Persisting that process state is gated on the
// `restoreAgentSessions` preference (default off = fresh shells on relaunch).
// Cold hydration reads whatever the last persist kept: pointers are
// re-validated, and sessions that were active at quit derive a one-shot boot
// resume marker.
// v7 added TerminalLeaf.content (dock cells). An absent `content` already
// means "terminal", so v6 blobs are structurally valid v7.
const TAB_VERSION = 7;
const MAX_TERMINAL_SCROLLBACK_CHARS = 40_000;

interface PersistedShape {
  v: number;
  tabs: Tab[];
  activeId: TabId | null;
  // Run ids the user explicitly closed from the top strip. syncChatTabsToRuns
  // skips re-adding a chat tab for these, so a close survives the ~250ms runs
  // refresh and app reloads (instead of being silently re-appended). Pruned to
  // the live run set during sync so it can't grow forever.
  closedChatRunIds?: string[];
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
    return url || "Browser";
  }
}

// Build a readable row-major grid for batches of agent terminals. The old
// recursive split kept equal area but produced awkward mixed columns for
// counts like 5; rows keep the scan path predictable (5 -> 3 over 2).
function buildPaneGrid(leaves: TerminalLeaf[]): PaneNode {
  if (leaves.length === 0) {
    throw new Error("Cannot build an empty terminal pane grid.");
  }
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

// A terminal tab holding no shells at all is a SPLIT CONTAINER: the grid
// exists only to lay two docked surfaces (a chat next to an editor, say) side
// by side. Calling that "terminals" in the strip would be a lie, so the two
// families are numbered separately — and a container that later gains a shell
// keeps whatever unique title it already has rather than churning.
const TERMINAL_TITLE_BASE = "terminals";
const SPLIT_TITLE_BASE = "split";

function terminalTitleBaseFor(tab: TerminalTab): string {
  return collectTerminalLeaves(tab.root).length > 0 ? TERMINAL_TITLE_BASE : SPLIT_TITLE_BASE;
}

function terminalTitleForIndex(index: number, base = TERMINAL_TITLE_BASE): string {
  return index === 0 ? base : `${base} ${index + 1}`;
}

function terminalTitleKey(title: string): string {
  return title.trim().toLowerCase();
}

function reserveNextTerminalTitle(used: Set<string>, base = TERMINAL_TITLE_BASE): string {
  for (let index = 0; ; index += 1) {
    const title = terminalTitleForIndex(index, base);
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
    const title = reserveNextTerminalTitle(used, terminalTitleBaseFor(tab));
    changed = true;
    return { ...tab, title };
  });
  return changed ? next : tabs;
}

// Which tab inherits the active slot when the active tab at index `idx`
// closes: the nearest neighbor to the left, then to the right — skipping
// run-owned tabs (worker terminal grid / Runs canvas / run previews). Those
// surfaces are entered only by an explicit click (see isRunOwnedTab in
// types.ts); the raw left neighbor of a closed editor is often the run's
// worker grid, and promoting it silently dropped the user into the multi-pane
// worker terminals when they closed a file to get back to their chat.
function nearestFreeTabId(next: Tab[], idx: number): TabId | null {
  for (let i = Math.min(idx - 1, next.length - 1); i >= 0; i -= 1) {
    if (!isRunOwnedTab(next[i])) return next[i].id;
  }
  for (let i = Math.max(idx, 0); i < next.length; i += 1) {
    if (!isRunOwnedTab(next[i])) return next[i].id;
  }
  return null;
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

// A terminal tab that starts with no shell — just a cell holding `partner`.
// "Open in split" mints one when the two surfaces the user wants side by side
// are both non-terminal: the split grid lives on terminal tabs, so pairing a
// chat with an editor needs a grid, but emphatically not a spare shell in it.
function createSplitContainerTab(partnerTabId: TabId, partnerKind: DockableTabKind): TerminalTab {
  const cell = dockLeaf(makeId("dock"), partnerTabId, partnerKind);
  return {
    id: makeId("term"),
    kind: "terminal",
    title: SPLIT_TITLE_BASE,
    root: cell,
    activePaneId: cell.paneId,
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
    title: title?.trim() || "Cora",
  };
}

export function isDraftChatTabId(id: TabId): boolean {
  return id.startsWith(DRAFT_CHAT_PREFIX);
}

// First-run seed for a brand-new workspace (nothing persisted): one draft
// Cora chat tab plus one terminal. Chat tabs are otherwise derived from
// the run store, so this seed only ever applies on the very first launch of a
// workspace — once any tab state is persisted, restores honor exactly what was
// saved (including zero chat tabs after the user closes them).
function defaultTabs(cwd?: string): Tab[] {
  return [createDraftChatTab(), createTerminalTab(cwd)];
}

// Run ids of the chat tabs found in each workspace's persisted blob, captured
// as loadPersisted strips them. Chat tabs are rebuilt from the run store, but
// SESSION-scoped state that depended on those tabs existing needs a seed after
// a relaunch — concretely, a board-card chat the user had explicitly opened
// must stay exempt from App's board-run suppression, or its restored tab
// renders empty and gets pruned. Pure derivation from the existing blob; the
// persistence format is unchanged.
const restoredChatRunIdsByWorkspace = new Map<string, Set<string>>();

export function restoredChatRunIds(workspaceId: string | null): ReadonlySet<string> {
  return (workspaceId && restoredChatRunIdsByWorkspace.get(workspaceId)) || EMPTY_RUN_ID_SET;
}
const EMPTY_RUN_ID_SET: ReadonlySet<string> = new Set();

// Version chain rather than an equality check: bumping TAB_VERSION without one
// silently discards every user's saved layout on first launch. Each step is
// responsible for making the previous shape valid at the next version.
// Exported for tests (scripts/test-dock-layout.cjs).
export function migratePersisted(parsed: PersistedShape | null): PersistedShape | null {
  if (!parsed || !Array.isArray(parsed.tabs)) return null;
  let version = parsed.v;
  // 6 -> 7: dock cells are additive; nothing to rewrite.
  if (version === 6) version = 7;
  if (version !== TAB_VERSION) return null;
  return { ...parsed, v: version };
}

// A dock leaf points at another tab by id. Drop references that can't resolve,
// so a partial or hand-edited blob can never leave an invisible cell holding
// grid space. Exported for tests (scripts/test-dock-layout.cjs).
export function validateDockLeaves(tabs: Tab[]): Tab[] {
  const known = new Set(tabs.map((t) => t.id));
  const claimed = new Set<TabId>();
  const out: Tab[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "terminal") {
      out.push(tab);
      continue;
    }
    let root: PaneNode | null = tab.root;
    for (const dockCell of collectDockLeaves(tab.root)) {
      const { tabId, tabKind } = dockCell.content;
      const resolvable =
        isSafePersistedString(tabId, 256) &&
        DOCKABLE_KINDS.has(tabKind) &&
        // First occurrence wins: one tab can only occupy one cell.
        !claimed.has(tabId) &&
        // Chat tabs are stripped above and re-derived from the run store a
        // beat later (syncChatTabsToRuns mints them with id === runId), so a
        // chat reference is held pending rather than pruned on sight. App's
        // reconcile effect clears it if that run never comes back.
        (known.has(tabId) || tabKind === "chat");
      if (resolvable) {
        claimed.add(tabId);
        continue;
      }
      root = root === null ? null : removeLeaf(root, dockCell.paneId);
      if (root === null) break;
    }
    if (root === null) continue;
    if (root === tab.root) {
      out.push(tab);
      continue;
    }
    // Pruning can orphan the ids the tab points at.
    const leaves = collectLeaves(root);
    const activePaneId = leaves.some((l) => l.paneId === tab.activePaneId)
      ? tab.activePaneId
      : leaves[0].paneId;
    const zoomedPaneId =
      tab.zoomedPaneId && leaves.some((l) => l.paneId === tab.zoomedPaneId)
        ? tab.zoomedPaneId
        : null;
    out.push({ ...tab, root, activePaneId, zoomedPaneId });
  }
  return out;
}

function loadPersisted(workspaceId: string | null, scrollbackLineLimit: number): PersistedShape | null {
  const key = storageKey(workspaceId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = migratePersisted(JSON.parse(raw) as PersistedShape);
    if (!parsed) return null;
    // Record run-backed chat tabs before they are stripped below (a chat tab's
    // id IS its run id; drafts are session-local and excluded). Additive so a
    // re-hydration never forgets ids from an earlier load this session.
    if (workspaceId) {
      const chatRunIds = parsed.tabs
        .filter((tab) => tab.kind === "chat" && !isDraftChatTabId(tab.id))
        .map((tab) => tab.id);
      if (chatRunIds.length > 0) {
        const set = restoredChatRunIdsByWorkspace.get(workspaceId) ?? new Set<string>();
        for (const id of chatRunIds) set.add(id);
        restoredChatRunIdsByWorkspace.set(workspaceId, set);
      }
    }
    // Terminal processes are session-local. Preserve tabs, splits, and cwd, but
    // never replay output or resume an agent after a full app relaunch.
    // Workspace switches within this app run use the live in-memory layouts and
    // mounted PTYs instead of this cold-hydration path.
    // Runs tabs are derived from the selected chat, not durable workspace
    // layout. Keep persisted editor/terminal/preview tabs, then recreate the
    // Runs tab only when App selects a chat.
    // Chat tabs are now derived from the run store by the App-level sync
    // effect (syncChatTabsToRuns), so they are stripped here and rebuilt for
    // every run NOT in closedChatRunIds once the runs load. We deliberately do
    // NOT force-seed a chat tab on restore: a workspace whose user closed the
    // Cora tab restores with zero chat tabs and stays that way (the
    // closed run stays reachable via the chat-history popover). First-run
    // seeding of a draft chat tab happens only when there is NO persisted
    // state at all — see initialTabsState's defaultTabs fallback.
    parsed.tabs = normalizeTerminalTitles(
      parsed.tabs
        .filter(
          (tab) =>
            tab.kind !== "runs" &&
            // Automations tabs are workspace-scoped derived surfaces (like
            // Runs), not durable layout — they re-open on demand via the "+"
            // picker rather than restoring from a persisted blob.
            tab.kind !== "automations" &&
            // Usage is likewise derived, and restoring it would kick off a
            // multi-second cold transcript scan during boot for a tab the
            // user may not be coming back to. It reopens on demand.
            tab.kind !== "usage" &&
            // Stale shells from the short-lived Cora Hub tab: the kind no
            // longer exists (the ✦ Cora button opens a draft chat now), but
            // blobs persisted by builds that had it may still carry one — drop
            // it rather than restore a ghost tab no stack renders.
            (tab.kind as string) !== "cora" &&
            // Stale shells from the short-lived top-level Cora Board tab: the
            // kind no longer exists (the board is a chat sub-view now), but
            // blobs persisted by builds that had it may still carry one — drop
            // it rather than restore a ghost tab no stack renders.
            (tab.kind as string) !== "board" &&
            // Untitled whiteboard drafts hold their board in renderer memory
            // only; restoring the tab shell after a relaunch would open an
            // empty husk. Saved boards come back as editor tabs instead.
            tab.kind !== "whiteboard" &&
            tab.kind !== "chat" &&
            // A Cora-owned browser is a live tool surface, not durable
            // workspace furniture. If the renderer reloads mid-run, Cora can
            // reopen it through the preview bridge; if the run already ended,
            // restoring it would promote an orphaned inner tab into a normal
            // top-level browser and keep a Chromium process alive forever.
            !(tab.kind === "preview" && Boolean(tab.runId)) &&
            !(tab.kind === "terminal" && tab.scope?.kind === "workers"),
        ),
    );
    parsed.tabs = validateDockLeaves(parsed.tabs);
    for (const tab of parsed.tabs) {
      if (tab.kind === "terminal") cleanupTransientTerminalState(tab.root);
      if (tab.kind === "runs" && (tab.title === "Runs" || tab.title === "Ops")) tab.title = "Runs";
    }
    parsed.tabs = trimTabsScrollback(parsed.tabs, scrollbackLineLimit);
    return parsed;
  } catch {
    return null;
  }
}

// Exported for tests (scripts/test-session-restore.cjs); only loadPersisted
// calls it in production.
export function cleanupTransientTerminalState(node: PaneNode): void {
  if (node.kind === "leaf") {
    delete node.worker;
    delete node.autorun;
    delete node.origin;
    delete node.nativeClaudeProfileId;
    delete node.nativeCliLoginToken;
    // Scrollback is durable here: when the restore preference is off,
    // persist() already stripped it, so whatever survived to hydration is
    // meant to replay.
    // Boot-once restore marker: minted here, at hydration, once per workspace
    // per app run, and nowhere else. Only a validated pointer whose agent was
    // RUNNING at quit (active===true) earns it; anything else (old blobs
    // without `active`, idle panes, malformed or pending captures) hydrates
    // without one and never auto-resumes. When the restore preference is off,
    // persist() already stripped the pointer, so nothing mints here.
    const session = validatedTerminalAgentSession(node.agentSession);
    if (session) {
      node.agentSession = session;
      if (session.active === true) node.bootResume = true;
      else delete node.bootResume;
    } else {
      delete node.agentSession;
      delete node.bootResume;
    }
    return;
  }
  cleanupTransientTerminalState(node.a);
  cleanupTransientTerminalState(node.b);
}

function persist(
  workspaceId: string | null,
  tabs: Tab[],
  activeId: TabId | null,
  scrollbackLineLimit: number,
  persistAgentState: boolean,
  closedChatRunIds?: string[],
): void {
  const key = storageKey(workspaceId);
  if (!key) return;
  try {
    const payload: PersistedShape = {
      v: TAB_VERSION,
      tabs: trimTabsScrollback(
        stripTransientTerminalState(normalizeTerminalTitles(tabs), persistAgentState),
        scrollbackLineLimit,
      ),
      activeId,
      ...(closedChatRunIds && closedChatRunIds.length
        ? { closedChatRunIds }
        : {}),
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable; persistence is best-effort.
  }
}

function stripTransientTerminalState(tabs: Tab[], persistAgentState: boolean): Tab[] {
  let changed = false;
  const next = tabs.flatMap((tab): Tab[] => {
    if (tab.kind === "terminal" && tab.scope?.kind === "workers") {
      changed = true;
      return [];
    }
    if (tab.kind !== "terminal") return [tab];
    const root = stripTransientPaneState(tab.root, persistAgentState);
    if (root === tab.root) return [tab];
    changed = true;
    return [{ ...tab, root }];
  });
  return changed ? next : tabs;
}

// Exported for tests (scripts/test-session-restore.cjs); only persist calls it
// in production. `keepAgentState` mirrors the restoreAgentSessions preference:
// worker chips, autorun, phone origin, and the boot-once marker are ALWAYS
// process-local and stripped, but the durable resume pointer + scrollback
// survive persist only when the user opted into resume-on-relaunch. Off keeps
// the fresh-shell contract: a relaunch restores layout and cwd, never process
// state.
export function stripTransientPaneState(node: PaneNode, keepAgentState = false): PaneNode {
  if (node.kind === "leaf") {
    const session = keepAgentState ? validatedTerminalAgentSession(node.agentSession) : null;
    // Process state is dirty when the preference says strip it, or when a
    // kept pointer fails validation and must be dropped from the payload.
    const dropProcessState = keepAgentState
      ? "agentSession" in node && !session
      : "scrollback" in node || "agentSession" in node;
    if (
      !("worker" in node) &&
      !("autorun" in node) &&
      !("origin" in node) &&
      !("nativeClaudeProfileId" in node) &&
      !("nativeCliLoginToken" in node) &&
      !("bootResume" in node) &&
      !dropProcessState
    ) {
      return node;
    }
    const {
      worker: _worker,
      autorun: _autorun,
      origin: _origin,
      nativeClaudeProfileId: _nativeClaudeProfileId,
      nativeCliLoginToken: _nativeCliLoginToken,
      bootResume: _bootResume,
      ...rest
    } = node;
    if (!keepAgentState) {
      delete rest.scrollback;
      delete rest.agentSession;
    } else if (!session) {
      delete rest.agentSession;
    }
    return rest;
  }
  const a = stripTransientPaneState(node.a, keepAgentState);
  const b = stripTransientPaneState(node.b, keepAgentState);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

// localStorage is user-editable and older builds wrote partially captured
// pointers, so never let an arbitrary blob reach the resume command builder.
// Keep validation deliberately provider-agnostic: both CLIs currently use UUIDs,
// but their public session-id formats may grow without requiring a layout bump.
export function validatedTerminalAgentSession(value: unknown): TerminalAgentSession | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TerminalAgentSession>;
  if (
    candidate.runtime !== "claude" &&
    candidate.runtime !== "codex" &&
    candidate.runtime !== "grok"
  ) {
    return null;
  }
  if (!isSafePersistedString(candidate.sessionId, 256)) return null;
  if (!isSafePersistedString(candidate.cwd, 8192)) return null;
  if (!isSafePersistedString(candidate.capturedAt, 128)) return null;
  if (
    candidate.transcriptPath !== undefined &&
    !isSafePersistedString(candidate.transcriptPath, 8192)
  ) {
    return null;
  }
  if (candidate.active !== undefined && typeof candidate.active !== "boolean") return null;
  if (
    candidate.nativeCodexProfileId !== undefined &&
    !(
      candidate.nativeCodexProfileId === "personal" ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        candidate.nativeCodexProfileId,
      )
    )
  ) {
    return null;
  }
  if (candidate.runtime !== "codex" && candidate.nativeCodexProfileId !== undefined) {
    return null;
  }
  if (
    candidate.nativeClaudeProfileId !== undefined &&
    !(
      candidate.nativeClaudeProfileId === "personal" ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        candidate.nativeClaudeProfileId,
      )
    )
  ) {
    return null;
  }
  if (candidate.runtime !== "claude" && candidate.nativeClaudeProfileId !== undefined) {
    return null;
  }
  if (
    candidate.nativeGrokProfileId !== undefined &&
    !(
      candidate.nativeGrokProfileId === "personal" ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        candidate.nativeGrokProfileId,
      )
    )
  ) {
    return null;
  }
  if (candidate.runtime !== "grok" && candidate.nativeGrokProfileId !== undefined) {
    return null;
  }
  return candidate as TerminalAgentSession;
}

function isSafePersistedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

// Promote only explicitly identified live panes. Used by the main-process
// raw-stream watcher at quit time to correct a visibility-poller false negative
// before the layout is synchronously persisted.
export function markTerminalAgentSessionsActive(
  node: PaneNode,
  paneIds: ReadonlySet<string>,
): PaneNode {
  if (node.kind === "leaf") {
    const session = validatedTerminalAgentSession(node.agentSession);
    if (!paneIds.has(node.paneId) || !session || session.active === true) return node;
    return { ...node, agentSession: { ...session, active: true } };
  }
  const a = markTerminalAgentSessionsActive(node.a, paneIds);
  const b = markTerminalAgentSessionsActive(node.b, paneIds);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function markTabAgentSessionsActive(tabs: Tab[], paneIds: ReadonlySet<string>): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.kind !== "terminal") return tab;
    const root = markTerminalAgentSessionsActive(tab.root, paneIds);
    if (root === tab.root) return tab;
    changed = true;
    return { ...tab, root };
  });
  return changed ? next : tabs;
}

function trimTabsScrollback(tabs: Tab[], scrollbackLineLimit: number): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.kind !== "terminal") return tab;
    const root = trimPaneScrollback(tab.root, scrollbackLineLimit);
    if (root === tab.root) return tab;
    changed = true;
    return { ...tab, root };
  });
  return changed ? next : tabs;
}

function trimPaneScrollback(node: PaneNode, scrollbackLineLimit: number): PaneNode {
  if (node.kind === "leaf") {
    if (!node.scrollback) return node;
    const trimmed = trimPersistedTerminalScrollback(node.scrollback, scrollbackLineLimit);
    return trimmed === node.scrollback ? node : { ...node, scrollback: trimmed };
  }
  const a = trimPaneScrollback(node.a, scrollbackLineLimit);
  const b = trimPaneScrollback(node.b, scrollbackLineLimit);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function trimPersistedTerminalScrollback(scrollback: string, scrollbackLineLimit: number): string {
  const lineTrimmed = trimTerminalScrollbackLines(scrollback, scrollbackLineLimit);
  const charTrimmed =
    lineTrimmed.length > MAX_TERMINAL_SCROLLBACK_CHARS
      ? lineTrimmed.slice(lineTrimmed.length - MAX_TERMINAL_SCROLLBACK_CHARS)
      : lineTrimmed;
  return trimTerminalScrollbackLines(charTrimmed, scrollbackLineLimit);
}

// View teardown for a pane's pty. Cora (the main-process orchestrator) is the
// only authority allowed to kill its own workers — closing UI around a live
// spark attempt must leave the session running so Cora can reuse it for
// follow-ups. So a running spark worker's pty is only detached (renderer sink
// dropped, process untouched; the reconcile loop can re-attach later), while
// every other pane is disposed as before. Main's pty:dispose handler enforces
// the same rule for callers that bypass this helper.
function releaseTerminalPanePty(leaf: TerminalLeaf | null | undefined, paneId: string): void {
  const worker = leaf?.worker;
  if (worker?.source === "spark" && worker.state === "running") {
    void window.spark.pty.detach(paneId).catch(() => undefined);
    return;
  }
  void window.spark.pty.dispose(paneId).catch(() => undefined);
}

// After a cell is pruned from a tab's tree, the tab may still point at it.
// Re-aims activePaneId at the next surviving cell and clears a zoom held by
// the removed one.
// Drop the cell holding `dockedTabId` from every terminal tab, collapsing any
// host left with nothing. Hosts that collapse held no terminal cells, so there
// is never a PTY to reap here.
function pruneDockCellsFor(tabs: Tab[], dockedTabId: TabId): Tab[] {
  const out: Tab[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "terminal") {
      out.push(tab);
      continue;
    }
    const cell = collectDockLeaves(tab.root).find((l) => l.content.tabId === dockedTabId);
    if (!cell) {
      out.push(tab);
      continue;
    }
    const root = removeLeaf(tab.root, cell.paneId);
    if (root === null) continue;
    out.push(repairTerminalTabPointers(tab, root, cell.paneId));
  }
  return out;
}

function repairTerminalTabPointers(
  tab: TerminalTab,
  root: PaneNode,
  removedPaneId: string,
): TerminalTab {
  const leaves = collectLeaves(root);
  const activePaneId =
    tab.activePaneId === removedPaneId || !leaves.some((l) => l.paneId === tab.activePaneId)
      ? (nextLeafAfter(root, removedPaneId)?.paneId ?? leaves[0]?.paneId ?? tab.activePaneId)
      : tab.activePaneId;
  const zoomedPaneId = tab.zoomedPaneId === removedPaneId ? null : tab.zoomedPaneId;
  return { ...tab, root, activePaneId, zoomedPaneId };
}

function disposeTerminalTabPanes(tab: Tab): void {
  if (tab.kind !== "terminal") return;
  // Terminal cells only — a dock cell's id was never a PTY.
  for (const pane of collectTerminalLeaves(tab.root)) {
    releaseTerminalPanePty(pane, pane.paneId);
  }
}

// The finished pane of an earlier attempt for the same task — the grid slot a
// retry should take over instead of tiling a sibling. Running predecessors are
// never matched (each live attempt keeps its own pane).
function findRetiredPredecessorLeaf(
  root: PaneNode,
  worker: TerminalLeafWorker,
): TerminalLeaf | null {
  return (
    collectLeaves(root).find(
      (item) =>
        item.worker?.workerTaskId === worker.workerTaskId &&
        item.worker.attemptId !== worker.attemptId &&
        item.worker.state === "done",
    ) ?? null
  );
}

// Value-equality for worker chip meta. The 1s reconcile loop in App passes a
// freshly built literal on every tick, so Object.is inside setLeafField never
// bails on its own — this is what lets a no-op re-ensure keep the previous
// state reference (and skip the app-wide re-render it would otherwise cause).
export function sameWorkerMeta(a: TerminalLeafWorker, b: TerminalLeafWorker): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<
    keyof TerminalLeafWorker
  >;
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

// Swap the leaf `paneId` for `next`, preserving the surrounding split
// structure so the replacement inherits the exact grid slot.
function replaceLeafNode(node: PaneNode, paneId: string, next: TerminalLeaf): PaneNode {
  if (node.kind === "leaf") return node.paneId === paneId ? next : node;
  const a = replaceLeafNode(node.a, paneId, next);
  const b = replaceLeafNode(node.b, paneId, next);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

// Resolve the initial tabs + activeId for a workspace in a SINGLE
// localStorage read. Both the lazy useState initializer and the
// workspace-switch effect funnel through here so loadPersisted (a
// JSON.parse + a recursive transient-terminal cleanup walk) only runs once per
// mount/switch instead of three times. Falls back to the default tab set
// when nothing is persisted (or the persisted blob is a stale version).
interface InitialTabsStateSnapshot {
  tabs: Tab[];
  activeId: TabId | null;
  closedChatRunIds: string[];
}

function initialTabsStateFromPersisted(loaded: PersistedShape): InitialTabsStateSnapshot {
  // This workspace HAS persisted tab state — even
  // when its stripped tab list is empty (the user closed every tab, including
  // the Cora chat). Restore exactly that, with no forced chat tab: the
  // App-level sync effect re-derives chat tabs for runs not in
  // closedChatRunIds, and an intentionally empty workspace stays empty. Only a
  // genuine FIRST RUN — loadPersisted returned null (nothing persisted, or a
  // stale-version blob) — gets the defaultTabs seed (draft chat + terminal).
  // Honor the persisted selection when it survived hydration, never land on a
  // restored preview (dead dev server → blank page hiding the composer). See
  // resolveBootActiveTabId for why the chat tab can't be the fallback here.
  const activeId = resolveBootActiveTabId(loaded.tabs, loaded.activeId);
  return {
    tabs: loaded.tabs,
    activeId,
    closedChatRunIds: Array.isArray(loaded.closedChatRunIds)
      ? loaded.closedChatRunIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function initialTabsState(
  workspaceId: string | null,
  defaultCwd: string | undefined,
  scrollbackLineLimit: number,
): InitialTabsStateSnapshot {
  const loaded = loadPersisted(workspaceId, scrollbackLineLimit);
  if (loaded) return initialTabsStateFromPersisted(loaded);
  const seed = defaultTabs(defaultCwd);
  return { tabs: seed, activeId: seed[0].id, closedChatRunIds: [] };
}

// One workspace's retained tab layout. The workbench mounts a small MRU subset
// and keeps the rest here without their expensive xterm/WebGL views. See App's
// terminalWorkspaceLayers.
export interface WorkspaceTerminalLayout {
  workspaceId: string;
  tabs: Tab[];
  activeId: TabId | null;
}

export interface AgentTerminalTabOptions {
  cwd?: string;
  autorun?: string;
  title?: string;
  color?: string;
  origin?: TerminalLeafOrigin;
  nativeClaudeProfileId?: string;
  nativeGrokProfileId?: string;
  nativeCliLoginToken?: string;
}

// Pure helpers shared by the hook and the session-layout regression harness.
// A bridge-created background layout starts deliberately empty: mounting a
// never-visited workspace solely to host a phone pane must not also spawn the
// workspace's unrelated default/restored shells. On the user's first visit,
// mergeDeferredWorkspaceTerminalLayout folds those live bridge panes into the
// normal cold layout while preserving its prior/default selection.
export function appendAgentTerminalToWorkspaceLayout(
  layout: WorkspaceTerminalLayout,
  options?: AgentTerminalTabOptions,
): {
  layout: WorkspaceTerminalLayout;
  tabId: TabId;
  paneId: string;
} {
  const tabId = makeId("term");
  const paneId = makeId("pane");
  const tab: TerminalTab = {
    id: tabId,
    kind: "terminal",
    title: options?.title?.trim() || "terminals",
    root: {
      ...leaf(paneId, options?.cwd, options?.autorun, options?.origin),
      ...(options?.nativeClaudeProfileId
        ? { nativeClaudeProfileId: options.nativeClaudeProfileId }
        : {}),
      ...(options?.nativeGrokProfileId
        ? { nativeGrokProfileId: options.nativeGrokProfileId }
        : {}),
      ...(options?.nativeCliLoginToken
        ? { nativeCliLoginToken: options.nativeCliLoginToken }
        : {}),
    },
    activePaneId: paneId,
    ...(options?.origin?.kind === "phone"
      ? {}
      : { color: options?.color ?? "var(--agent-tab-accent)" }),
  };
  return {
    layout: {
      ...layout,
      // Keep the frozen activeId untouched: bridge-created terminals never
      // steal focus, including when their workspace is hidden.
      tabs: normalizeTerminalTitles([...layout.tabs, tab]),
    },
    tabId,
    paneId,
  };
}

export function mergeDeferredWorkspaceTerminalLayout(
  cold: WorkspaceTerminalLayout,
  deferred: WorkspaceTerminalLayout,
): WorkspaceTerminalLayout {
  return {
    workspaceId: cold.workspaceId,
    tabs: normalizeTerminalTitles([...cold.tabs, ...deferred.tabs]),
    activeId: cold.activeId,
  };
}

export function upsertInactiveWorkspaceLayout(
  current: ReadonlyArray<WorkspaceTerminalLayout>,
  nextLayout: WorkspaceTerminalLayout,
): ReadonlyArray<WorkspaceTerminalLayout> {
  const index = current.findIndex(
    (layout) => layout.workspaceId === nextLayout.workspaceId,
  );
  if (index < 0) return [...current, nextLayout];
  const existing = current[index];
  if (
    existing.tabs === nextLayout.tabs &&
    existing.activeId === nextLayout.activeId
  ) {
    return current;
  }
  const next = [...current];
  next[index] = nextLayout;
  return next;
}

// Bridge teardown is keyed by the tab that originally hosted a pane, but the
// desktop user may move/detach that pane before main asks to destroy it. Prefer
// the supplied tab when it still owns the pane, then locate the pane by its
// stable PTY id across the rest of the workspace.
export function terminalTabIdForPane(
  tabs: ReadonlyArray<Tab>,
  preferredTabId: TabId,
  paneId: string,
): TabId | null {
  const preferred = tabs.find(
    (tab): tab is TerminalTab =>
      tab.id === preferredTabId &&
      tab.kind === "terminal" &&
      findLeaf(tab.root, paneId) !== null,
  );
  if (preferred) return preferred.id;
  return (
    tabs.find(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" && findLeaf(tab.root, paneId) !== null,
    )?.id ?? null
  );
}

export interface UseTabsApi {
  tabs: Tab[];
  activeId: TabId | null;
  activeTab: Tab | null;
  // Workspace id the current `tabs` array belongs to. Lags App's activeId by
  // one render during a workspace switch — see the note at the useMemo.
  tabsWorkspaceId: string | null;
  // Frozen layouts for every visited or bridge-initialized workspace that is
  // not currently active. The workbench keeps a bounded MRU subset mounted;
  // the rest retain their tab model here while their PTYs live in main.
  inactiveWorkspaceLayouts: ReadonlyArray<WorkspaceTerminalLayout>;
  // Drop frozen layouts for workspaces that no longer exist (see the callback
  // for why the switch effect alone can't catch every deletion).
  pruneWorkspaceLayouts: (validWorkspaceIds: ReadonlySet<string>) => void;
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
  newTerminalTab: (
    cwd?: string,
    autorun?: string,
    options?: {
      focus?: boolean;
      agentSession?: TerminalAgentSession | null;
      nativeCliLoginToken?: string;
      nativeCodexProfileId?: string;
      nativeClaudeProfileId?: string;
      nativeGrokProfileId?: string;
      title?: string;
      color?: string;
      manualAgentRuntime?: TerminalAgentSession["runtime"];
    },
  ) => TabId;
  // Create a terminal tab owned by a bridge caller (agent-socket
  // terminal.create or a trusted paired phone). Agent tabs carry a compact
  // runtime/fallback glyph; phone tabs carry an origin badge. Neither is EVER
  // focused automatically.
  // Returns BOTH ids: the paneId is the PTY session id the agent then drives
  // via terminal.write / terminal.read.
  newAgentTerminalTab: (
    options?: AgentTerminalTabOptions,
  ) => { tabId: TabId; paneId: string };
  // Cross-workspace variant of newAgentTerminalTab: mint the agent tab into a
  // BACKGROUND workspace's frozen layout so a run's terminal.create never lands
  // in whichever workspace is on screen. The hidden mounted stack picks the new
  // pane up and spawns its PTY, so the returned paneId still comes online for
  // terminal.write/read. A never-visited target gets a minimal frozen layout
  // containing only bridge-created panes; its regular restored/default tabs
  // are merged in on the first real visit.
  newAgentTerminalTabInWorkspace: (
    workspaceId: string,
    options?: AgentTerminalTabOptions,
  ) => { tabId: TabId; paneId: string };
  // Open ONE terminal tab whose panes are split into a grid — used when Cora
  // spawns a batch of standing agent terminals, so the user sees them all at
  // once. One pane per spec, each autorunning its agent command.
  newTerminalGrid: (
    cwd: string | undefined,
    specs: Array<{ command: string; runtime?: string }>,
  ) => TabId;
  // Add a batch of agent panes into an EXISTING terminal tab as a grid,
  // alongside whatever panes that tab already holds. Used when Cora spawns
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
  // Idempotently host a worker attempt in the run's workers-scoped terminal
  // tab. A newly materialized pane becomes the tab's active pane; re-ensures
  // never move the user's selection unless `activate` is passed explicitly.
  ensureWorkerTerminalTab: (
    runId: string,
    cwd: string | undefined,
    paneId: string,
    worker: TerminalLeafWorker,
    options?: { focus?: boolean; activate?: boolean },
  ) => TabId;
  detachTerminalPaneToNewTab: (tabId: TabId, paneId: string) => TabId | null;
  // "Open in split": put a tab beside whatever surface is on screen, whatever
  // the two of them are. Resolves the host itself (see planOpenInSplit) —
  // minting a split container, or a shell to pair with, when the workspace has
  // no grid to dock into. Returns false only when the tab cannot be docked at
  // all (not dockable, or a second chat while one is already docked).
  openTabInSplit: (tabId: TabId) => boolean;
  // Give a dockable tab a cell inside a terminal tab's split grid.
  // Returns false when rejected (not dockable, unknown host, a second chat).
  dockTabInTerminal: (
    tabId: TabId,
    hostTabId: TabId,
    target?: {
      paneId: string;
      direction: TerminalSplit["direction"];
      position: "before" | "after";
      mode: "split" | "line";
    },
  ) => boolean;
  // Send a docked tab back to the strip, keeping its content alive.
  undockTab: (tabId: TabId, options?: { focus?: boolean }) => boolean;
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
    agentSession?: TerminalAgentSession | null,
  ) => string | null;
  closeTerminalPane: (tabId: TabId, paneId: string) => void;
  // closeTerminalPane for a pane living in either the active workspace or an
  // inactive retained layout (worker_attempt.finished / failed agent creates
  // keep firing while their workspace is in the background). Dropping the tab's last
  // pane removes the tab from the frozen layout, rerouting a stranded frozen
  // activeId the same way pruneDeletedRunTabsFromInactiveWorkspaces does.
  closeTerminalPaneInWorkspace: (workspaceId: string, tabId: TabId, paneId: string) => void;
  // Locate a terminal pane in the inactive workspace layouts (the
  // active store is searched by callers directly). Returns the owning
  // workspace/tab so cross-workspace cleanup can target the right layout.
  findTerminalPaneInInactiveWorkspaces: (
    paneId: string,
  ) => { workspaceId: string; tabId: TabId } | null;
  // Flip `zoomedPaneId` for a tab: sets it to `paneId` if currently null or a
  // different pane, clears it if `paneId` is already the zoomed one. Stored
  // on the tab so it persists across tab switches.
  toggleTerminalPaneZoom: (tabId: TabId, paneId: string) => void;
  setActiveTerminalPane: (tabId: TabId, paneId: string) => void;
  setTerminalSplitRatio: (tabId: TabId, path: PanePath, ratio: number) => void;
  setLeafCwd: (tabId: TabId, paneId: string, cwd: string) => void;
  setLeafScrollback: (tabId: TabId, paneId: string, scrollback: string) => void;
  // Synchronously persist a batch of final pane scrollback snapshots to
  // localStorage in one write, bypassing the debounce. For the quit path
  // (beforeunload/pagehide) where deferred updaters never get a render.
  flushScrollbackNow: (entries: Array<{ tabId: TabId; paneId: string; text: string }>) => void;
  flushWorkspaceScrollbackNow: (
    workspaceId: string,
    entries: Array<{ tabId: TabId; paneId: string; text: string }>,
  ) => void;
  // Main's raw-PTY watcher reports which panes still host an agent at quit.
  // Promote their pointers to active and synchronously persist every visited
  // workspace before PTY teardown can erase that evidence.
  flushAgentSessionsNow: (activePaneIds: string[]) => void;
  setLeafWorker: (tabId: TabId, paneId: string, worker: TerminalLeafWorker | null) => void;
  // Update a worker chip in either the active workspace or one of the mounted
  // hidden workspace layouts. Main-process terminal notifications keep flowing
  // while a project is hidden, so routing through this workspace-aware helper
  // prevents a chip from freezing on its pre-switch state.
  updateLeafWorkerInWorkspace: (
    workspaceId: string,
    tabId: TabId,
    paneId: string,
    updater: (worker: TerminalLeafWorker | null) => TerminalLeafWorker | null,
  ) => void;
  // Set (or clear, with null) the durable Claude/Codex session pointer on a
  // leaf. Written at launch (capture) and cleared when a restore finds the
  // transcript gone. Unlike setLeafWorker's transient chip, this survives quit.
  setLeafAgentSession: (
    tabId: TabId,
    paneId: string,
    session: TerminalAgentSession | null,
  ) => void;
  // One-shot boot-restore marker consumed: clear the leaf's hydration-minted
  // `bootResume` flag once the pane's first mount has made its restore attempt
  // (whatever the outcome), so no later remount can auto-resume again.
  setLeafBootResumeConsumed: (tabId: TabId, paneId: string) => void;
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
      agentSession?: TerminalAgentSession | null;
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
  // Open a preview tab. `focus` defaults to true so explicit user opens
  // ("+ New preview", openInSparkBrowser) select the new tab. Automated
  // openers (dev-server URL auto-detect, the MCP preview bridge) pass
  // focus:false so a preview never yanks the user off their chat — the tab
  // still appears in the strip / inner strip to click into.
  newPreviewTab: (url: string, options?: { runId?: string | null; focus?: boolean }) => TabId;
  // Open (or relabel) the runs tab bound to a chat. Each chat owns exactly
  // one runs tab. `focus` selects it too — true for explicit navigation,
  // false for the background "ensure the active chat has a tab" effect.
  openRunsTab: (runId: string, title: string, focus: boolean) => TabId;
  hideRunsTabs: () => void;
  // Focus the workspace's single Automations tab if one already exists, else
  // append a fresh one and focus it. Singleton-ish like the Runs tab — there
  // is only ever one Automations surface per workspace.
  openAutomationsTab: () => TabId;
  // Focus the single Usage tab if one is open, else append a fresh one and
  // focus it. Singleton like Automations — the analytics it shows are
  // machine-wide, so a second copy would show the same thing twice.
  openUsageTab: () => TabId;
  // Append a fresh untitled whiteboard tab and focus it (one draft per call,
  // not a singleton). See WhiteboardTab in types.ts for the draft contract.
  newWhiteboardTab: () => TabId;
  // Open (or focus) the diff tab for a changed file. Identity is
  // (path, staged) — the same file can have a Working Tree tab and a Staged
  // tab open side by side, exactly like VS Code's separate diff editors.
  openDiffTab: (path: string, staged: boolean, options?: { focus?: boolean }) => TabId;
  // Close the runs tab bound to a chat (used when the chat is deleted).
  closeRunsTabFor: (runId: string) => void;
  closeWorkerTerminalTabFor: (runId: string) => void;
  // Close every preview tab spawned by a run (used when the run is deleted —
  // a deleted run can never re-surface them via its inner tab strip, so
  // leaving them would strand invisible, uncloseable browser tabs).
  closePreviewTabsFor: (runId: string) => void;
  /** Close Cora-owned browsers even when their workspace is in the background. */
  closePreviewTabsForInWorkspace: (workspaceId: string, runId: string) => void;
  // run.deleted cleanup for background workspaces: purge the dead run's owned
  // tabs from the frozen live-snapshot map and the inactive-layout mirror so
  // switching back can't restore a stranded (pill-less) active tab.
  pruneDeletedRunTabsFromInactiveWorkspaces: (runId: string) => void;
  openEditorTab: (entry: FsEntry, options?: { preview?: boolean }) => TabId;
  pinEditorTab: (id: TabId) => void;
  setEditorEntry: (oldPath: string, entry: FsEntry) => void;
  closeEditorByPath: (path: string) => void;
  setActiveEditorPath: (path: string) => void;
  setActiveRunId: (runId: string | null) => void;
  setPreviewUrl: (id: TabId, url: string) => void;
  registerDispose: (id: TabId, fn: () => void) => void;
}

export function useTabs(
  workspaceId: string | null,
  defaultCwd?: string,
  terminalScrollbackLineLimit = TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  // Mirrors the restoreAgentSessions preference: when true, persisted layouts
  // keep each pane's scrollback + agent-session pointer so a relaunch can
  // replay output and `--resume`. False (default, and pre-preferences-load)
  // persists layout/cwd only — the fresh-shell contract.
  persistAgentState = false,
): UseTabsApi {
  const normalizedTerminalScrollbackLineLimit = normalizeTerminalScrollbackLineLimit(
    terminalScrollbackLineLimit,
  );
  // Parse the persisted layout ONCE for the initial mount. The previous
  // implementation called loadPersisted from both useState initializers,
  // re-doing the JSON.parse + recursive transient-terminal cleanup walk twice; a
  // single lazy initializer holding the {tabs, activeId} pair collapses
  // that to one parse. We keep `tabs` and `activeId` as separate useState
  // cells (so the many mutating callbacks below stay untouched) and just
  // seed both from one computed snapshot.
  const initial = useState(() =>
    initialTabsState(workspaceId, defaultCwd, normalizedTerminalScrollbackLineLimit),
  )[0];
  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeId, setActiveId] = useState<TabId | null>(initial.activeId);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const liveWorkspaceTabsRef = useRef(new Map<string, { tabs: Tab[]; activeId: TabId | null }>());
  // Persisted layouts can be large enough that JSON.parse + terminal-tree
  // cleanup is noticeable on the first visit. Warm those blobs one at a time
  // during browser idle time, then consume the prepared snapshot on click.
  // Live workspace state remains authoritative once a workspace has been
  // visited; this cache only covers cold, persisted layouts.
  const preloadedWorkspaceTabsRef = useRef(new Map<
    string,
    { scrollbackLineLimit: number; state: InitialTabsStateSnapshot }
  >());
  // A background bridge request can be the first touch of a workspace this
  // renderer session. Its hidden layout contains only the live bridge panes so
  // mounting it does not eagerly spawn unrelated default/restored terminals.
  // The first actual workspace visit consumes this marker and merges those
  // panes into the normal cold layout.
  const deferredColdWorkspaceIdsRef = useRef(new Set<string>());
  const tabsWorkspaceIdRef = useRef(workspaceId);
  if (tabsWorkspaceIdRef.current) {
    liveWorkspaceTabsRef.current.set(tabsWorkspaceIdRef.current, { tabs, activeId });
  }
  // Render-driving mirror of the inactive-workspace layouts (the ref above
  // can't trigger a render). Updated ONLY on a workspace switch — low frequency
  // — so the active workspace's per-keystroke tab edits never churn it. The
  // active workspace is intentionally excluded (it's driven by live `tabs`).
  const [inactiveWorkspaceLayouts, setInactiveWorkspaceLayouts] = useState<
    ReadonlyArray<WorkspaceTerminalLayout>
  >([]);
  // Drop frozen layouts for workspaces that no longer exist. The switch effect
  // only ever removes the entering/leaving workspaces, so a workspace deleted
  // while it is neither (an inactive workspace closed with no subsequent
  // switch) would otherwise keep its frozen tabs — including retained
  // scrollback — in this array for the rest of the session. The workbench calls
  // this when the workspace set changes. No-ops when nothing is stale so it
  // can't drive a render loop.
  const pruneWorkspaceLayouts = useCallback((validWorkspaceIds: ReadonlySet<string>) => {
    for (const workspaceId of liveWorkspaceTabsRef.current.keys()) {
      if (!validWorkspaceIds.has(workspaceId)) {
        liveWorkspaceTabsRef.current.delete(workspaceId);
        closedChatRunIdsByWorkspaceRef.current.delete(workspaceId);
        deferredColdWorkspaceIdsRef.current.delete(workspaceId);
        restoredChatRunIdsByWorkspace.delete(workspaceId);
      }
    }
    setInactiveWorkspaceLayouts((prev) => {
      const next = prev.filter((layout) => validWorkspaceIds.has(layout.workspaceId));
      return next.length === prev.length ? prev : next;
    });
  }, []);
  // Run ids the user explicitly closed from the top strip, per workspace.
  // syncChatTabsToRuns skips re-adding chat tabs for ids in this set so a close
  // isn't undone by the ~250ms runs refresh. Kept in a ref (not state) so
  // updating it never triggers a render; persisted inside each workspace's tab
  // payload and reloaded by initialTabsState.
  const closedChatRunIdsByWorkspaceRef = useRef(new Map<string, Set<string>>());
  if (tabsWorkspaceIdRef.current && !closedChatRunIdsByWorkspaceRef.current.has(tabsWorkspaceIdRef.current)) {
    closedChatRunIdsByWorkspaceRef.current.set(
      tabsWorkspaceIdRef.current,
      new Set(initial.closedChatRunIds),
    );
  }
  // The closed set for whichever workspace `tabs` currently belongs to.
  const currentClosedChatRunIds = (): Set<string> => {
    const ws = tabsWorkspaceIdRef.current;
    if (!ws) return new Set();
    let set = closedChatRunIdsByWorkspaceRef.current.get(ws);
    if (!set) {
      set = new Set();
      closedChatRunIdsByWorkspaceRef.current.set(ws, set);
    }
    return set;
  };
  const closedChatRunIdsArray = (): string[] => Array.from(currentClosedChatRunIds());
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const terminalScrollbackLineLimitRef = useRef(normalizedTerminalScrollbackLineLimit);
  terminalScrollbackLineLimitRef.current = normalizedTerminalScrollbackLineLimit;
  const persistAgentStateRef = useRef(persistAgentState);
  persistAgentStateRef.current = persistAgentState;
  const quitActiveAgentPaneIdsRef = useRef<ReadonlySet<string>>(new Set());

  // Cold-layout prefetch. Enumerating keys is cheap; each JSON parse is placed
  // in its own idle callback so warming several large workspaces never becomes
  // a single long main-thread task. Invalid/stale blobs are intentionally not
  // cached, preserving initialTabsState's cwd-aware first-run fallback.
  useEffect(() => {
    preloadedWorkspaceTabsRef.current.clear();
    const pendingWorkspaceIds: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue;
      const candidate = key.slice(STORAGE_KEY_PREFIX.length);
      if (candidate) pendingWorkspaceIds.push(candidate);
    }

    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    const scheduleNext = () => {
      if (cancelled || pendingWorkspaceIds.length === 0) return;
      const warmOne = () => {
        idleHandle = null;
        timeoutHandle = null;
        if (cancelled) return;
        while (pendingWorkspaceIds.length > 0) {
          const candidate = pendingWorkspaceIds.shift();
          if (!candidate) continue;
          if (
            candidate === tabsWorkspaceIdRef.current ||
            liveWorkspaceTabsRef.current.has(candidate) ||
            preloadedWorkspaceTabsRef.current.has(candidate)
          ) {
            continue;
          }
          const loaded = loadPersisted(candidate, normalizedTerminalScrollbackLineLimit);
          if (loaded) {
            preloadedWorkspaceTabsRef.current.set(candidate, {
              scrollbackLineLimit: normalizedTerminalScrollbackLineLimit,
              state: initialTabsStateFromPersisted(loaded),
            });
          }
          break;
        }
        scheduleNext();
      };

      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(warmOne, { timeout: 1_000 });
      } else {
        timeoutHandle = window.setTimeout(warmOne, 50);
      }
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (idleHandle !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    };
  }, [normalizedTerminalScrollbackLineLimit]);

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
  useLayoutEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      tabsWorkspaceIdRef.current = workspaceId;
      return;
    }
    const previousWorkspaceId = tabsWorkspaceIdRef.current;
    if (previousWorkspaceId) {
      liveWorkspaceTabsRef.current.set(previousWorkspaceId, { tabs, activeId });
    }
    // Capture (don't drop) the previous workspace's pending write, but perform
    // JSON serialization/localStorage I/O only after the entering workspace has
    // painted. Large terminal scrollback made this synchronous flush the main
    // source of click-to-content latency. The in-memory snapshot below is
    // authoritative immediately; quit-time flushing still persists every live
    // workspace if the app closes before this deferred write runs.
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
      const { workspaceId: ws, tabs: t, activeId: a } = persistPayloadRef.current;
      const closed = ws ? closedChatRunIdsByWorkspaceRef.current.get(ws) : null;
      const closedIds = closed ? Array.from(closed) : undefined;
      const limit = terminalScrollbackLineLimitRef.current;
      window.requestAnimationFrame(() => {
        window.setTimeout(
          () => persist(ws, t, a, limit, persistAgentStateRef.current, closedIds),
          0,
        );
      });
    }
    // Keep the inactive-layout mirror in sync with this switch: the workspace
    // we're LEAVING (with its final live tabs) becomes an inactive retained
    // layout, and the workspace we're ENTERING becomes the active live layout —
    // so drop any entry for it. `tabs`/`activeId` here still hold the leaving
    // workspace's layout (the swap happens below), which is exactly what we
    // want to freeze.
    setInactiveWorkspaceLayouts((prev) => {
      const filtered = prev.filter(
        (layout) =>
          layout.workspaceId !== workspaceId &&
          layout.workspaceId !== previousWorkspaceId,
      );
      if (previousWorkspaceId && previousWorkspaceId !== workspaceId) {
        return [...filtered, { workspaceId: previousWorkspaceId, tabs, activeId }];
      }
      return filtered;
    });
    const live = workspaceId ? liveWorkspaceTabsRef.current.get(workspaceId) : null;
    const hasDeferredColdLayout = workspaceId
      ? deferredColdWorkspaceIdsRef.current.has(workspaceId)
      : false;
    const preloaded = workspaceId
      ? preloadedWorkspaceTabsRef.current.get(workspaceId)
      : null;
    if (workspaceId && preloaded) preloadedWorkspaceTabsRef.current.delete(workspaceId);
    const cold = live && !hasDeferredColdLayout
      ? null
      : preloaded?.scrollbackLineLimit === terminalScrollbackLineLimitRef.current
        ? preloaded.state
        : initialTabsState(
            workspaceId,
            defaultCwdRef.current,
            terminalScrollbackLineLimitRef.current,
          );
    const next =
      workspaceId && live && cold && hasDeferredColdLayout
        ? mergeDeferredWorkspaceTerminalLayout(
            { workspaceId, tabs: cold.tabs, activeId: cold.activeId },
            { workspaceId, tabs: live.tabs, activeId: live.activeId },
          )
        : live ?? cold!;
    if (workspaceId && hasDeferredColdLayout) {
      deferredColdWorkspaceIdsRef.current.delete(workspaceId);
      // Publish the merged layout before React's state update so a second
      // bridge call arriving in the same turn composes with it.
      liveWorkspaceTabsRef.current.set(workspaceId, {
        tabs: next.tabs,
        activeId: next.activeId,
      });
    }
    if (workspaceId && !closedChatRunIdsByWorkspaceRef.current.has(workspaceId)) {
      // First time entering this workspace this session: restore its persisted
      // closed-run set alongside the preloaded or freshly parsed layout.
      closedChatRunIdsByWorkspaceRef.current.set(
        workspaceId,
        new Set(cold?.closedChatRunIds ?? []),
      );
    }
    tabsWorkspaceIdRef.current = workspaceId;
    setTabs(next.tabs);
    setActiveId(next.activeId);
  }, [workspaceId]);

  useEffect(() => {
    setTabs((curr) => normalizeTerminalTitles(curr));
  }, [workspaceId]);

  useEffect(() => {
    setTabs((curr) => trimTabsScrollback(curr, normalizedTerminalScrollbackLineLimit));
  }, [normalizedTerminalScrollbackLineLimit]);

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
  // Key the mirrored payload to the workspace the CURRENT `tabs` state
  // actually belongs to, NOT the incoming `workspaceId` prop. On the render
  // where workspaceId flips, `tabs` still holds the PREVIOUS workspace's
  // layout (the swap happens later, in the workspace-switch effect below), so
  // pairing the new id with the old tabs would let the unmount flush write
  // workspace A's layout under workspace B's storage key.
  persistPayloadRef.current = { workspaceId: tabsWorkspaceIdRef.current, tabs, activeId };
  useEffect(() => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      // Write through the workspace-keyed payload ref, not the lexically
      // captured `workspaceId`: at the render where the workspace flips, this
      // effect closes over the NEW id but the OLD `tabs`, so persisting the
      // captured pair would land the old layout under the new key. The ref
      // pairs `tabs` with the workspace they actually belong to.
      const { workspaceId: ws, tabs: t, activeId: a } = persistPayloadRef.current;
      const closed = ws ? closedChatRunIdsByWorkspaceRef.current.get(ws) : null;
      persist(ws, t, a, normalizedTerminalScrollbackLineLimit, persistAgentStateRef.current, closed ? Array.from(closed) : undefined);
    }, 300);
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    };
    // persistAgentState in the deps: flipping the Settings toggle re-persists
    // promptly, so turning restore OFF scrubs pointers/scrollback from storage
    // instead of leaving them until the next layout change.
  }, [tabs, activeId, workspaceId, normalizedTerminalScrollbackLineLimit, persistAgentState]);

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
        const closed = ws ? closedChatRunIdsByWorkspaceRef.current.get(ws) : null;
        persist(ws, t, a, terminalScrollbackLineLimitRef.current, persistAgentStateRef.current, closed ? Array.from(closed) : undefined);
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

  // The single choke point for "focus this tab". A docked tab has no pill and
  // filling the workbench with it would hide the grid it lives in, so focusing
  // one reveals its host tab and makes its cell the active pane instead. Every
  // programmatic reveal (openEditorTab's dedupe, file-tree clicks, run
  // selection) inherits that for free.
  const setActiveTab = useCallback((id: TabId) => {
    const ref = buildDockIndex(tabsRef.current).get(id);
    if (ref) {
      setTabs((curr) =>
        curr.map((t) =>
          t.id === ref.hostTabId && t.kind === "terminal" && t.activePaneId !== ref.leafId
            ? { ...t, activePaneId: ref.leafId }
            : t,
        ),
      );
      setActiveId((current) => (current === ref.hostTabId ? current : ref.hostTabId));
      return;
    }
    setActiveId((current) => (current === id ? current : id));
  }, []);

  const closeTab = useCallback(
    (id: TabId) => {
      setTabs((curr) => {
        const idx = curr.findIndex((t) => t.id === id);
        if (idx === -1) return curr;
        // Chat tabs are NEVER closed through here. Their × routes through
        // closeChatTabForRun, which is the only path that records the
        // closedChatRunIds marker — without that marker syncChatTabsToRuns
        // would resurrect the tab on the next runs refresh. closeTab removing a
        // chat tab would silently break "close sticks", so it stays a no-op.
        if (curr[idx].kind === "chat") return curr;
        // No length<=1 floor: a workspace is allowed to be emptied to zero
        // tabs (the content area then renders the empty-workspace state with
        // New chat / New terminal actions). The seed-a-tab fallbacks for
        // worker/runs/pane closures elsewhere are intentional UX for those
        // run-owned surfaces; the user-driven generic close honors the user.
        disposeTerminalTabPanes(curr[idx]);
        // Closing a docked tab must also drop the cell lending it geometry, or
        // the grid keeps an empty hole. (Closing a HOST needs nothing: its
        // cells vanish with it and the tabs they referenced return to the
        // strip on their own, since the tree is the only reference.)
        const next = pruneDockCellsFor(
          curr.filter((t) => t.id !== id),
          id,
        );
        setActiveId((active) => {
          if (active !== id) return active;
          // Nearest free (non-run-owned) neighbor, else null (no eligible
          // tabs left → empty-workspace state). See nearestFreeTabId.
          return nearestFreeTabId(next, idx);
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
        // Index math lives in tabReorder.ts so the strip previews exactly the
        // move the model commits (and both are covered by the same tests).
        // Null = no-op or unknown id: keep the array identity so the strip
        // doesn't repaint for nothing.
        const next = moveTabInList(curr, fromId, toId, position);
        return next ? normalizeTerminalTitles(next) : curr;
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
    (
      cwd?: string,
      autorun?: string,
      options?: {
        focus?: boolean;
        agentSession?: TerminalAgentSession | null;
        nativeCliLoginToken?: string;
        nativeCodexProfileId?: string;
        nativeClaudeProfileId?: string;
        nativeGrokProfileId?: string;
        title?: string;
        color?: string;
        manualAgentRuntime?: TerminalAgentSession["runtime"];
      },
    ): TabId => {
      const id = makeId("term");
      const paneId = makeId("pane");
      const root = leaf(paneId, cwd, autorun);
      // Durable resume pointer (Claude launches only) — set at creation so it is
      // persisted immediately, independent of post-hoc discovery.
      if (options?.agentSession) root.agentSession = options.agentSession;
      if (options?.manualAgentRuntime) {
        root.worker = createManualAgentLaunchWorker(options.manualAgentRuntime, paneId);
      }
      if (options?.nativeCliLoginToken) {
        root.nativeCliLoginToken = options.nativeCliLoginToken;
      }
      if (root.worker && options?.nativeCodexProfileId) {
        root.worker.nativeCodexProfileId = options.nativeCodexProfileId;
      }
      if (root.worker && options?.nativeClaudeProfileId) {
        root.worker.nativeClaudeProfileId = options.nativeClaudeProfileId;
      }
      if (root.worker && options?.nativeGrokProfileId) {
        root.worker.nativeGrokProfileId = options.nativeGrokProfileId;
      }
      setTabs((curr) => {
        const tab: TerminalTab = {
          id,
          kind: "terminal",
          title: options?.title?.trim() || "terminals",
          root,
          activePaneId: paneId,
          ...(options?.color ? { color: options.color } : {}),
        };
        return normalizeTerminalTitles([...curr, tab]);
      });
      if (options?.focus !== false) setActiveId(id);
      return id;
    },
    [],
  );

  const newAgentTerminalTab = useCallback(
    (options?: AgentTerminalTabOptions): { tabId: TabId; paneId: string } => {
      const id = makeId("term");
      const paneId = makeId("pane");
      const root = {
        ...leaf(paneId, options?.cwd, options?.autorun, options?.origin),
        ...(options?.nativeClaudeProfileId
          ? { nativeClaudeProfileId: options.nativeClaudeProfileId }
          : {}),
        ...(options?.nativeGrokProfileId
          ? { nativeGrokProfileId: options.nativeGrokProfileId }
          : {}),
        ...(options?.nativeCliLoginToken
          ? { nativeCliLoginToken: options.nativeCliLoginToken }
          : {}),
      };
      const title = options?.title?.trim() || "terminals";
      const color =
        options?.origin?.kind === "phone"
          ? undefined
          : options?.color ?? "var(--agent-tab-accent)";
      setTabs((curr) => {
        const tab: TerminalTab = {
          id,
          kind: "terminal",
          title,
          root,
          activePaneId: paneId,
          ...(color ? { color } : {}),
        };
        return normalizeTerminalTitles([...curr, tab]);
      });
      // Deliberately NOT setActiveId: an agent-spawned terminal appears in the
      // strip tinted but does not steal focus from the user's current tab.
      return { tabId: id, paneId };
    },
    [],
  );

  // See UseTabsApi: agent tab minted into a background workspace's frozen
  // layout. Mirrors updateLeafWorkerInWorkspace's write pattern — ref first so
  // back-to-back bridge calls compose, then the render-driving mirror so the
  // bridge-pinned background stack mounts the pane (which spawns its PTY).
  const newAgentTerminalTabInWorkspace = useCallback(
    (
      targetWorkspaceId: string,
      options?: AgentTerminalTabOptions,
    ): { tabId: TabId; paneId: string } => {
      if (tabsWorkspaceIdRef.current === targetWorkspaceId) {
        return newAgentTerminalTab(options);
      }
      let live = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
      if (!live) {
        // Minimal live shell: only the bridge-created pane mounts now. Loading
        // the workspace's persisted/default layout is deferred until the user
        // actually enters it, avoiding surprise background PTYs.
        live = { tabs: [], activeId: null };
        deferredColdWorkspaceIdsRef.current.add(targetWorkspaceId);
      }
      const created = appendAgentTerminalToWorkspaceLayout(
        { workspaceId: targetWorkspaceId, tabs: live.tabs, activeId: live.activeId },
        options,
      );
      liveWorkspaceTabsRef.current.set(targetWorkspaceId, {
        tabs: created.layout.tabs,
        activeId: created.layout.activeId,
      });
      setInactiveWorkspaceLayouts((current) =>
        upsertInactiveWorkspaceLayout(current, created.layout),
      );
      return { tabId: created.tabId, paneId: created.paneId };
    },
    [newAgentTerminalTab],
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
      options?: { focus?: boolean; activate?: boolean },
    ): TabId => {
      const snapshotTab = tabsRef.current.find(
        (t): t is TerminalTab =>
          t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId,
      );
      const resultId = snapshotTab?.id ?? makeId("term");
      // A retry attempt (same task, new attemptId) whose predecessor pane
      // finished cleanly takes over that pane's grid slot instead of tiling a
      // sibling, so pane count keeps matching logical workers. Resolve the
      // predecessor from the ref snapshot — the setTabs updater runs during
      // render, so an assignment inside it would not be visible below.
      const replacedPaneId =
        snapshotTab && !findLeaf(snapshotTab.root, paneId)
          ? (findRetiredPredecessorLeaf(snapshotTab.root, worker)?.paneId ?? null)
          : null;
      setTabs((curr) => {
        const existing = curr.find(
          (t): t is TerminalTab =>
            t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId,
        );
        if (existing) {
          const existingLeaf = findLeaf(existing.root, paneId);
          const hasPane = Boolean(existingLeaf);
          let root: PaneNode;
          if (existingLeaf) {
            const rootWithCwd = cwd
              ? setLeafField(existing.root, paneId, "cwd", cwd)
              : existing.root;
            // Skip the worker write when the meta is value-identical: the
            // reconcile loop re-ensures every second with a fresh literal, and
            // writing it through would republish the whole tab tree each tick.
            root =
              existingLeaf.worker && sameWorkerMeta(existingLeaf.worker, worker)
                ? rootWithCwd
                : setLeafField(rootWithCwd, paneId, "worker", worker);
          } else {
            const newLeaf = leaf(paneId, cwd);
            newLeaf.worker = worker;
            const predecessor = findRetiredPredecessorLeaf(existing.root, worker);
            root = predecessor
              ? replaceLeafNode(existing.root, predecessor.paneId, newLeaf)
              : buildPaneGrid([...collectLeaves(existing.root), newLeaf]);
          }
          // Only a NEWLY materialized pane (or an explicit request) may steal
          // the tab's pane selection — re-ensures from the 1s reconcile loop
          // and repeat envelope events must leave the user's click alone.
          const activate = options?.activate === true || !hasPane;
          let changed = false;
          const next = curr.map((tab) => {
            if (tab.id !== existing.id || tab.kind !== "terminal") return tab;
            const activePaneId = activate
              ? paneId
              : findLeaf(root, tab.activePaneId)
                ? tab.activePaneId
                : paneId;
            // A steady-state re-ensure (same tree, same selection, already a
            // workers tab) must keep the prior state reference so React can
            // skip the commit entirely.
            if (
              root === tab.root &&
              activePaneId === tab.activePaneId &&
              tab.title === "workers"
            ) {
              return tab;
            }
            changed = true;
            return {
              ...tab,
              title: "workers",
              scope: { kind: "workers" as const, runId },
              root,
              activePaneId,
            };
          });
          return changed ? next : curr;
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
      if (replacedPaneId) {
        // The predecessor attempt is done and its leaf just left the tree, so
        // this is evidence cleanup, not a kill (main refuses disposes of live
        // attempts anyway).
        void window.spark.pty.dispose(replacedPaneId).catch(() => undefined);
      }
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
      // Dragging a dock cell out to the strip means "undock" — the tab already
      // exists, so it goes back to being a pill rather than spawning a shell.
      const dragged = findLeaf(currentSource.root, paneId);
      if (dragged && isDockLeaf(dragged)) {
        undockTab(dragged.content.tabId, { focus: true });
        return null;
      }
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
      agentSession?: TerminalAgentSession | null,
    ): string | null => {
      let newPaneId: string | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const target = findLeaf(t.root, paneId);
          if (!target) return t;
          const fresh = makeId("pane");
          newPaneId = fresh;
          // Splitting off a dock cell has no shell directory to inherit — fall
          // back to a sibling terminal's cwd rather than dropping to root.
          const inheritedCwd = isDockLeaf(target)
            ? collectTerminalLeaves(t.root).find((l) => l.cwd)?.cwd
            : target.cwd;
          const newLeaf = leaf(fresh, inheritedCwd, autorun);
          if (agentSession) newLeaf.agentSession = agentSession;
          const launchRuntime =
            agentSession?.runtime ?? runtimeFromAgentSessionLaunchCommand(autorun);
          if (launchRuntime) {
            newLeaf.worker = createManualAgentLaunchWorker(launchRuntime, fresh);
          }
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

  // Lend a tab's content a cell in a terminal tab's split grid. The tab keeps
  // living in the tabs array and stays mounted by its own Stack — only its rect
  // comes from here (see dockGeometry.ts). Returns false when the dock was
  // rejected, so callers can leave the drag/menu state untouched.
  const dockTabInTerminal = useCallback(
    (
      tabId: TabId,
      hostTabId: TabId,
      target?: {
        paneId: string;
        direction: TerminalSplit["direction"];
        position: "before" | "after";
        mode: "split" | "line";
      },
    ): boolean => {
      if (tabId === hostTabId) return false;
      let docked = false;
      // Every guard reads `curr`, not a pre-update snapshot: callers routinely
      // create a tab and dock it in the same batch (the "+ → Browser pane"
      // menu does), and that tab does not exist yet in tabsRef.
      setTabs((curr) => {
        const tab = curr.find((t) => t.id === tabId);
        const host = curr.find(
          (t): t is TerminalTab => t.id === hostTabId && t.kind === "terminal",
        );
        if (!tab || !host || !canDockTab(tab)) return curr;
        // One docked chat per workspace: ChatStack retains a single chat panel
        // per workspace, and `suspendGlobalEvents` assumes at most one chat
        // surface is on screen.
        if (tab.kind === "chat") {
          for (const [dockedId] of buildDockIndex(curr)) {
            if (dockedId === tabId) continue;
            if (curr.find((t) => t.id === dockedId)?.kind === "chat") return curr;
          }
        }
        const cell = dockLeaf(makeId("dock"), tabId, tab.kind as DockableTabKind);
        const existing = buildDockIndex(curr).get(tabId);
        // Dropping a cell onto itself is a no-op, not a move.
        if (existing && target && existing.leafId === target.paneId) return curr;

        // Re-docking moves the cell rather than duplicating it.
        let working = curr;
        if (existing) {
          const stripped: Tab[] = [];
          for (const t of curr) {
            if (t.id !== existing.hostTabId || t.kind !== "terminal") {
              stripped.push(t);
              continue;
            }
            const root = removeLeaf(t.root, existing.leafId);
            if (root === null) {
              // The old host held nothing else. If it is also the destination
              // there is no longer anything to position against.
              if (t.id === hostTabId) return curr;
              continue;
            }
            stripped.push(repairTerminalTabPointers(t, root, existing.leafId));
          }
          working = stripped;
        }

        const destination = working.find(
          (t): t is TerminalTab => t.id === hostTabId && t.kind === "terminal",
        );
        if (!destination) return curr;
        const root =
          target && findLeaf(destination.root, target.paneId)
            ? insertLeafAtLeaf(
                destination.root,
                target.paneId,
                target.direction,
                cell,
                target.position,
                { rebalanceLine: target.mode === "line" },
              )
            : (() => {
                const add = smartAddTarget(destination.root, 1600, 900);
                return add ? splitAtLeaf(destination.root, add.paneId, add.direction, cell) : null;
              })();
        if (!root || root === destination.root) return curr;
        docked = true;
        // Reveal the grid the content just moved into. Same in-updater
        // setActiveId pattern the pane close/reseed paths already use.
        setActiveId(hostTabId);
        return normalizeTerminalTitles(
          working.map((t) =>
            t.id === hostTabId && t.kind === "terminal"
              ? { ...t, root, activePaneId: cell.paneId, zoomedPaneId: null }
              : t,
          ),
        );
      });
      return docked;
    },
    [],
  );

  // The terminal tab the user was in most recently. "Open in split" falls back
  // to it when there is no partner on screen ("split the tab I right-clicked,
  // which is also the one I'm looking at"), because "the grid I was just in"
  // is a far better guess than "the last terminal tab in strip order" — the
  // rule that used to send a docked tab into whichever grid happened to sit
  // rightmost, hidden worker grids included.
  const lastTerminalTabIdRef = useRef<TabId | null>(null);
  useEffect(() => {
    const active = tabsRef.current.find((t) => t.id === activeId);
    if (active?.kind === "terminal" && !isRunOwnedTab(active)) {
      lastTerminalTabIdRef.current = active.id;
    }
  }, [activeId]);

  // "Open in split" — see planOpenInSplit for the rule this implements.
  const openTabInSplit = useCallback(
    (tabId: TabId): boolean => {
      const tabs = tabsRef.current;
      const plan = planOpenInSplit(
        tabs,
        activeIdRef.current,
        tabId,
        lastTerminalTabIdRef.current,
      );
      if (!plan) return false;
      if (plan.kind === "dock") return dockTabInTerminal(tabId, plan.hostTabId);

      // Both remaining plans need a host that does not exist yet. Mint it, then
      // dock into it in the same batch — dockTabInTerminal resolves the host
      // from the updater's `curr`, so it sees a tab this render has not
      // committed yet (the "+ → Browser pane" path relies on the same thing).
      let hostId: TabId;
      if (plan.kind === "container") {
        const partner = tabs.find((t) => t.id === plan.partnerTabId);
        if (!partner || !canDockTab(partner)) return false;
        const container = createSplitContainerTab(partner.id, partner.kind as DockableTabKind);
        hostId = container.id;
        // Placed where the partner sat, so the split appears where the user was
        // already looking instead of jumping to the end of the strip.
        setTabs((curr) => {
          const at = curr.findIndex((t) => t.id === partner.id);
          const next = [...curr];
          next.splice(at < 0 ? next.length : at, 0, container);
          return normalizeTerminalTitles(next);
        });
      } else {
        const shell = createTerminalTab(defaultCwdRef.current);
        hostId = shell.id;
        setTabs((curr) => normalizeTerminalTitles([...curr, shell]));
      }
      const docked = dockTabInTerminal(tabId, hostId);
      if (!docked) {
        // Nothing landed in the host we just minted — drop it rather than leave
        // an empty container (or an unasked-for shell) behind.
        setTabs((curr) => {
          const host = curr.find((t) => t.id === hostId);
          if (!host || host.kind !== "terminal") return curr;
          if (collectLeaves(host.root).length > 1) return curr;
          return curr.filter((t) => t.id !== hostId);
        });
      }
      return docked;
    },
    [dockTabInTerminal],
  );

  // Return a docked tab to the strip. The content is never destroyed — this is
  // the non-destructive counterpart to closing the tab outright.
  const undockTab = useCallback((tabId: TabId, options?: { focus?: boolean }): boolean => {
    const ref = buildDockIndex(tabsRef.current).get(tabId);
    if (!ref) return false;
    setTabs((curr) => {
      const next: Tab[] = [];
      let hostDropped = false;
      for (const t of curr) {
        if (t.id !== ref.hostTabId || t.kind !== "terminal") {
          next.push(t);
          continue;
        }
        const root = removeLeaf(t.root, ref.leafId);
        if (root === null) {
          // The cell was the host's only content — the host goes with it.
          hostDropped = true;
          continue;
        }
        next.push(repairTerminalTabPointers(t, root, ref.leafId));
      }
      if (hostDropped) {
        setActiveId((active) => (active === ref.hostTabId ? tabId : active));
      }
      return normalizeTerminalTitles(next);
    });
    if (options?.focus) setActiveId(tabId);
    return true;
  }, []);

  const closeTerminalPane = useCallback(
    (tabId: TabId, paneId: string) => {
      // A dock cell has no PTY and its content outlives the grid: Ctrl+W on one
      // returns the tab to the strip instead of destroying it. The destructive
      // variant is the × on the cell's chrome, which closes the tab itself.
      const hostTab = tabsRef.current.find(
        (t): t is TerminalTab => t.id === tabId && t.kind === "terminal",
      );
      const targetLeaf = hostTab ? findLeaf(hostTab.root, paneId) : null;
      if (targetLeaf && isDockLeaf(targetLeaf)) {
        undockTab(targetLeaf.content.tabId, { focus: false });
        return;
      }
      // Best-effort PTY teardown so a programmatic close (split with one
      // child) reaps the conpty even if the React tree is still in the middle
      // of unmounting. Live spark workers are only detached — see
      // releaseTerminalPanePty.
      const committedTabId =
        terminalTabIdForPane(tabsRef.current, tabId, paneId) ?? tabId;
      const owner = tabsRef.current.find(
        (t): t is TerminalTab => t.id === committedTabId && t.kind === "terminal",
      );
      releaseTerminalPanePty(owner ? findLeaf(owner.root, paneId) : null, paneId);
      setTabs((curr) => {
        // Resolve again inside the updater. If a move and teardown were queued
        // in the same React batch, `curr` already contains the moved pane even
        // though tabsRef still described its former tab above.
        const targetTabId = terminalTabIdForPane(curr, tabId, paneId);
        if (!targetTabId) return curr;
        const next: Tab[] = [];
        let dropped = false;
        for (const t of curr) {
          if (t.id !== targetTabId || t.kind !== "terminal") {
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
          // Closing the last pane of the workspace's last tab: reseed a single
          // FRESH TERMINAL (not defaultTabs, which would also resurrect a chat
          // tab the user may have deliberately closed). "Close the last pane →
          // get a fresh shell" is the expected terminal UX, and it keeps the
          // no-forced-chat invariant intact. The user can still empty fully to
          // the empty-workspace state by closing tabs via the tab strip.
          const seed = createTerminalTab(defaultCwdRef.current);
          setActiveId(seed.id);
          return [seed];
        }
        if (dropped) {
          setActiveId((active) => {
            if (active !== targetTabId) return active;
            // Prefer a top-strip (non-run-owned) tab so closing a worker tab's
            // last pane doesn't strand the active id on a hidden worker/runs tab.
            const isRunOwned = (t: Tab) =>
              (t.kind === "terminal" && t.scope?.kind === "workers") ||
              t.kind === "runs" ||
              (t.kind === "preview" && Boolean(t.runId));
            const topStrip = next.filter((t) => !isRunOwned(t));
            return topStrip[topStrip.length - 1]?.id ?? next[next.length - 1]?.id ?? null;
          });
        }
        return normalizeTerminalTitles(next);
      });
    },
    [],
  );

  // See UseTabsApi: close a pane inside an inactive workspace's frozen
  // layout. Mirrors pruneDeletedRunTabsFromInactiveWorkspaces' write pattern
  // (ref first, then the render-driving mirror). No reseed on an emptied
  // layout — hidden layouts are allowed to go empty, same contract as the run
  // pruner.
  const closeTerminalPaneInWorkspace = useCallback(
    (targetWorkspaceId: string, tabId: TabId, paneId: string) => {
      if (tabsWorkspaceIdRef.current === targetWorkspaceId) {
        closeTerminalPane(tabId, paneId);
        return;
      }
      // Same best-effort PTY teardown as closeTerminalPane (dispose/detach is
      // idempotent for already-dead sessions).
      const live = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
      const targetTabId = live
        ? terminalTabIdForPane(live.tabs, tabId, paneId)
        : null;
      const frozenTab = live?.tabs.find(
        (t): t is TerminalTab => t.id === targetTabId && t.kind === "terminal",
      );
      releaseTerminalPanePty(frozenTab ? findLeaf(frozenTab.root, paneId) : null, paneId);
      if (!live || !targetTabId) return;
      let changed = false;
      let droppedTabId: TabId | null = null;
      const nextTabs: Tab[] = [];
      for (const t of live.tabs) {
        if (t.id !== targetTabId || t.kind !== "terminal" || !findLeaf(t.root, paneId)) {
          nextTabs.push(t);
          continue;
        }
        changed = true;
        const root = removeLeaf(t.root, paneId);
        if (root === null) {
          // Last pane — drop the tab from the frozen layout entirely.
          droppedTabId = t.id;
          continue;
        }
        let activePaneId = t.activePaneId;
        if (activePaneId === paneId) {
          const fallback = nextLeafAfter(root, paneId);
          activePaneId = fallback?.paneId ?? activePaneId;
        }
        const zoomedPaneId = t.zoomedPaneId === paneId ? null : t.zoomedPaneId;
        nextTabs.push({ ...t, root, activePaneId, zoomedPaneId });
      }
      if (!changed) return;
      let nextActive = live.activeId;
      if (droppedTabId && nextActive === droppedTabId) {
        const fallbackChat = nextTabs.find((t) => t.kind === "chat");
        const fallbackFree = nextTabs.find((t) => !isRunOwnedTab(t));
        nextActive = fallbackChat?.id ?? fallbackFree?.id ?? null;
      }
      const pruned = { tabs: normalizeTerminalTitles(nextTabs), activeId: nextActive };
      liveWorkspaceTabsRef.current.set(targetWorkspaceId, pruned);
      setInactiveWorkspaceLayouts((current) => {
        const latest = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
        if (!latest) return current;
        let mirrorChanged = false;
        const next = current.map((layout) => {
          if (layout.workspaceId !== targetWorkspaceId || layout.tabs === latest.tabs) {
            return layout;
          }
          mirrorChanged = true;
          return { ...layout, tabs: latest.tabs, activeId: latest.activeId };
        });
        return mirrorChanged ? next : current;
      });
    },
    [closeTerminalPane],
  );

  // See UseTabsApi: resolve which hidden workspace/tab owns a pane id.
  const findTerminalPaneInInactiveWorkspaces = useCallback(
    (paneId: string): { workspaceId: string; tabId: TabId } | null => {
      for (const [workspaceId, layout] of liveWorkspaceTabsRef.current) {
        if (workspaceId === tabsWorkspaceIdRef.current) continue;
        for (const t of layout.tabs) {
          if (t.kind !== "terminal") continue;
          if (findLeaf(t.root, paneId)) return { workspaceId, tabId: t.id };
        }
      }
      return null;
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
      setTabs((curr) => {
        // Per-tab identity alone is not enough — the map itself allocates, so
        // a no-op call (the 1s reconcile re-sends the same cwd) must hand back
        // the prior array or every consumer of `tabs` re-renders anyway.
        let changed = false;
        const next = curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const existing = findLeaf(t.root, paneId);
          if (!existing || existing.cwd === cwd) return t;
          const root = setLeafField(t.root, paneId, "cwd", cwd);
          if (root === t.root) return t;
          changed = true;
          return { ...t, root };
        });
        return changed ? next : curr;
      });
    },
    [],
  );

  const setLeafWorker = useCallback(
    (tabId: TabId, paneId: string, worker: TerminalLeafWorker | null) => {
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const root = setLeafField(t.root, paneId, "worker", worker);
          if (root === t.root) return t;
          changed = true;
          return { ...t, root };
        });
        return changed ? next : curr;
      });
    },
    [],
  );

  const updateLeafWorkerInWorkspace = useCallback(
    (
      targetWorkspaceId: string,
      tabId: TabId,
      paneId: string,
      updater: (worker: TerminalLeafWorker | null) => TerminalLeafWorker | null,
    ) => {
      const updateTabs = (currentTabs: Tab[]): Tab[] => {
        let changed = false;
        const nextTabs = currentTabs.map((tab) => {
          if (tab.id !== tabId || tab.kind !== "terminal") return tab;
          const leaf = findLeaf(tab.root, paneId);
          if (!leaf) return tab;
          const currentWorker = leaf.worker ?? null;
          const nextWorker = updater(currentWorker);
          if (nextWorker === currentWorker) return tab;
          const root = setLeafField(tab.root, paneId, "worker", nextWorker);
          if (root === tab.root) return tab;
          changed = true;
          return { ...tab, root };
        });
        return changed ? nextTabs : currentTabs;
      };

      if (tabsWorkspaceIdRef.current === targetWorkspaceId) {
        setTabs(updateTabs);
        return;
      }

      const live = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
      if (!live) return;
      const nextTabs = updateTabs(live.tabs);
      if (nextTabs === live.tabs) return;

      // Update the ref immediately so back-to-back notifier events compose on
      // the latest hidden state even before React flushes this render.
      liveWorkspaceTabsRef.current.set(targetWorkspaceId, { ...live, tabs: nextTabs });
      setInactiveWorkspaceLayouts((current) => {
        const latest = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
        if (!latest) return current;
        let changed = false;
        const next = current.map((layout) => {
          if (layout.workspaceId !== targetWorkspaceId || layout.tabs === latest.tabs) {
            return layout;
          }
          changed = true;
          return { ...layout, tabs: latest.tabs };
        });
        return changed ? next : current;
      });
    },
    [],
  );

  const setLeafAgentSession = useCallback(
    (tabId: TabId, paneId: string, session: TerminalAgentSession | null) => {
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const root = setLeafField(t.root, paneId, "agentSession", session);
          if (root === t.root) return t;
          changed = true;
          return { ...t, root };
        });
        return changed ? next : curr;
      });
    },
    [],
  );

  const setLeafBootResumeConsumed = useCallback(
    (tabId: TabId, paneId: string) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const existing = findLeaf(t.root, paneId);
          if (!existing || existing.bootResume !== true) return t;
          const root = setLeafField(t.root, paneId, "bootResume", false);
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
        agentSession?: TerminalAgentSession | null;
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
          if (options?.agentSession) newLeaf.agentSession = options.agentSession;
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
        // Return the id actually used: the reused draft's id when one already
        // exists, else the freshly-created draft. Resolved INSIDE the updater
        // (tabsRef is stale in the same event as promote/sync — see comment
        // above), so the caller never gets a phantom id that was never added.
        let resolvedId = fallback;
        setTabs((curr) => {
          const existingDraft = curr.find(
            (t): t is ChatTab => t.kind === "chat" && isDraftChatTabId(t.id),
          );
          if (existingDraft) {
            resolvedId = existingDraft.id;
            if (focus) setActiveId(existingDraft.id);
            return curr;
          }
          // "Cora" matches the stable label App.tsx forces onto every
          // run-backed chat tab (CHAT_TAB_LABEL), so the user never sees the
          // "New chat" → first-message truncation when a draft promotes.
          const draft: ChatTab = { id: fallback, kind: "chat", title: "Cora" };
          if (focus) setActiveId(draft.id);
          return [...curr, draft];
        });
        return resolvedId;
      }
      const runId = input.runId;
      // Explicitly (re)opening a run clears any prior user-close, so the sync
      // effect is free to keep its tab around again.
      currentClosedChatRunIds().delete(runId);
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
        const placeholder = createChatTabForRun(runId, "Cora");
        if (focus) setActiveId(placeholder.id);
        return [...curr, placeholder];
      });
      return runId;
    },
    [],
  );

  const syncChatTabsToRuns = useCallback(
    (runList: Array<{ id: string; title: string }>) => {
      const runIds = new Set(runList.map((r) => r.id));
      // Prune closed-run ids no longer in the run list so the set can't grow
      // unbounded (deleted runs will never reappear, so their marker is dead
      // weight). Done outside the updater since it mutates a ref, not state.
      //
      // CRITICAL: only prune against a NON-EMPTY run list. The App sync effect
      // fires with runs=[] on the very first render (before refreshRunsFor
      // resolves) and on workspace switches. An empty list can't distinguish
      // "this workspace genuinely has no runs" from "runs haven't loaded yet",
      // so pruning then would wipe the closed markers and let the next
      // non-empty sync resurrect a chat tab the user closed — defeating
      // "close survives restart". Keeping a stale marker is harmless (worst
      // case a few dead ids in the persisted array, cleared on the next
      // non-empty sync); resurrecting a dismissed tab is not.
      const closed = currentClosedChatRunIds();
      if (closed.size && runList.length > 0) {
        for (const id of Array.from(closed)) {
          if (!runIds.has(id)) closed.delete(id);
        }
      }
      setTabs((curr) => {
        const titleByRun = new Map(runList.map((r) => [r.id, r.title?.trim() || "Cora"]));
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
          // Skip runs the user explicitly closed: their tab stays gone until
          // they reopen the run (openChatTab/promoteDraftChatTab clear the id).
          if (!have.has(run.id) && !closed.has(run.id)) {
            additions.push(createChatTabForRun(run.id, run.title));
            changed = true;
          }
        }
        // No forced chat tab here: a workspace whose chat tabs were all closed
        // (or whose only runs are in the closed set) legitimately syncs to zero
        // chat tabs and stays that way. The empty-workspace state + the "New
        // chat" affordance in the top strip's "+" picker are the reopen path.
        const next = additions.length ? [...renamed, ...additions] : renamed;
        return changed ? next : curr;
      });
    },
    [],
  );

  const addDraftChatTab = useCallback((): TabId => {
    // Reuse an existing empty draft rather than stacking another "New chat"
    // orphan. Dedup INSIDE the updater (tabsRef is stale in the same event as
    // promote/sync), matching openChatTab's null branch.
    let resultId: TabId = "";
    setTabs((curr) => {
      const existingDraft = curr.find(
        (t): t is ChatTab => t.kind === "chat" && isDraftChatTabId(t.id),
      );
      if (existingDraft) {
        resultId = existingDraft.id;
        setActiveId(existingDraft.id);
        return curr;
      }
      const draft = createDraftChatTab();
      resultId = draft.id;
      setActiveId(draft.id);
      return [...curr, draft];
    });
    return resultId;
  }, []);

  const promoteDraftChatTab = useCallback(
    (draftTabId: TabId, runId: string, title: string) => {
      // A freshly-promoted run is, by definition, open — clear any stale
      // closed marker (e.g. a reused run id) so sync won't suppress it.
      currentClosedChatRunIds().delete(runId);
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
    // Remember this close so syncChatTabsToRuns doesn't re-add the tab on the
    // next runs refresh (the close contract: the run stays reachable via the
    // history popover, the tab stays gone). Drafts have no run to re-derive,
    // so they need no tracking.
    if (!isDraftChatTabId(runId)) {
      currentClosedChatRunIds().add(runId);
      // Persist the dismissed-run marker SYNCHRONOUSLY, not just via the 300ms
      // debounce. The debounced write (and the unmount flush) can be lost if
      // the user closes the chat and immediately quits — React doesn't unmount
      // on a hard quit, and the beforeunload scrollback flush early-returns
      // when no pane scrollback changed, so it would never carry this marker.
      // Writing here (tabs deliberately UNCHANGED — chat tabs are stripped on
      // load regardless; the debounce re-persists the filtered list shortly)
      // guarantees the close survives an instant relaunch. Best-effort: persist
      // swallows storage errors internally.
      persist(
        tabsWorkspaceIdRef.current,
        tabsRef.current,
        activeIdRef.current,
        terminalScrollbackLineLimitRef.current,
        persistAgentStateRef.current,
        closedChatRunIdsArray(),
      );
    }
    setTabs((curr) => {
      const target = curr.find((t) => t.kind === "chat" && t.id === runId);
      if (!target) return curr;
      // Close-only for the RUN and it STICKS: no ensureAnyChatTab re-seed.
      // Closing the last chat tab leaves the workspace with only its other
      // tabs (terminals, editors, previews) — or zero tabs, which renders the
      // empty-workspace state. The run stays on disk and reachable via the
      // chat-history popover; the closedChatRunIds marker added above keeps
      // syncChatTabsToRuns from resurrecting the tab on the next runs refresh.
      //
      // The run's PREVIEW tabs close WITH the chat tab: their only pills live
      // in this chat's inner strip, so once the chat is gone each one is an
      // invisible, uncloseable <webview> whose Chromium renderer (~40-80MB,
      // background throttling off) keeps running forever — and if one was (or
      // later became) the active tab, the user stared at a fullscreen browser
      // with no tab anywhere (the reported leak). The run's ephemeral Runs tab
      // goes the same way; both re-materialize when the run is reopened from
      // history (openRunsTab / Cora reopening its preview). Worker TERMINAL
      // tabs stay: they host live PTYs of possibly still-running workers, are
      // hidden by the run-visibility filter, and resurface on reopen.
      const doomedIds = new Set<TabId>(
        curr
          .filter(
            (t) =>
              (t.kind === "preview" && t.runId === runId) ||
              (t.kind === "runs" && t.runId === runId),
          )
          .map((t) => t.id),
      );
      const next = curr.filter((t) => t.id !== runId && !doomedIds.has(t.id));
      for (const id of doomedIds) fireDispose(id);
      // Reroute the active selection away from anything this close just made
      // unreachable — the closed tabs themselves, or the run's remaining
      // worker terminals (pill-less once the owning chat is gone). NEVER fall
      // back onto a run-owned tab either; empty state beats a stranding.
      // Scoped to THIS run's tabs: closing an unrelated chat while viewing
      // another (still-open) run's worker/preview must not yank the view.
      const ownedByClosedRun = (t: Tab) =>
        (t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId) ||
        (t.kind === "runs" && t.runId === runId) ||
        (t.kind === "preview" && t.runId === runId);
      setActiveId((active) => {
        if (!active) return active;
        const activeTab = next.find((t) => t.id === active);
        const stranded = !activeTab || ownedByClosedRun(activeTab);
        if (!stranded) return active;
        const fallbackChat = next.find((t) => t.kind === "chat");
        const fallbackFree = next.find((t) => !isRunOwnedTab(t));
        return fallbackChat?.id ?? fallbackFree?.id ?? null;
      });
      return next;
    });
  }, [fireDispose]);

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
    (url: string, options?: { runId?: string | null; focus?: boolean }): TabId => {
      const id = makeId("preview");
      const tab: PreviewTab = {
        id,
        kind: "preview",
        title: titleFromUrl(url),
        url,
        ...(options?.runId ? { runId: options.runId } : {}),
      };
      setTabs((curr) => [...curr, tab]);
      // Only steal the active tab for explicit user opens. Automated openers
      // (auto-detect, MCP bridge) pass focus:false so the preview appears in
      // the background instead of hiding the chat composer.
      if (options?.focus !== false) setActiveId(id);
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

  // Open the workspace's single Automations tab. Like the Runs tab it is a
  // singleton: focus the existing one if present, otherwise append a fresh
  // tab. The existence check + setActiveId both run INSIDE the updater so a
  // double-click on "+ New automations" never stacks two tabs (tabsRef can be
  // stale in the same event as a preceding tab mutation).
  const openAutomationsTab = useCallback((): TabId => {
    const existingId = tabsRef.current.find(
      (t): t is AutomationsTab => t.kind === "automations",
    )?.id;
    const resultId = existingId ?? makeId("automations");
    setTabs((curr) => {
      const existing = curr.find(
        (t): t is AutomationsTab => t.kind === "automations",
      );
      if (existing) {
        setActiveId(existing.id);
        return curr;
      }
      const tab: AutomationsTab = { id: resultId, kind: "automations", title: "Automations" };
      setActiveId(resultId);
      return [...curr, tab];
    });
    return resultId;
  }, []);

  // Open the single Usage tab. Same singleton shape as openAutomationsTab,
  // including the existence check inside the updater so a double click never
  // stacks two.
  const openUsageTab = useCallback((): TabId => {
    const existingId = tabsRef.current.find((t): t is UsageTab => t.kind === "usage")?.id;
    const resultId = existingId ?? makeId("usage");
    setTabs((curr) => {
      const existing = curr.find((t): t is UsageTab => t.kind === "usage");
      if (existing) {
        setActiveId(existing.id);
        return curr;
      }
      const tab: UsageTab = { id: resultId, kind: "usage", title: "Usage" };
      setActiveId(resultId);
      return [...curr, tab];
    });
    return resultId;
  }, []);

  // Append a fresh untitled whiteboard tab and focus it. NOT a singleton:
  // each "+ New whiteboard" starts its own draft board. The board content is
  // owned by the WhiteboardFilePreview draft map (keyed by this tab id); the
  // first save-as swaps the tab for an editor tab bound to the file.
  const newWhiteboardTab = useCallback((): TabId => {
    const id = makeId("board");
    const tab: WhiteboardTab = { id, kind: "whiteboard", title: "Untitled whiteboard" };
    setTabs((curr) => [...curr, tab]);
    setActiveId(id);
    return id;
  }, []);

  // Open (or focus) a changed file's diff tab. Existence check + setActiveId
  // both run INSIDE the updater (same double-click race note as
  // openAutomationsTab above).
  const openDiffTab = useCallback(
    (path: string, staged: boolean, options?: { focus?: boolean }): TabId => {
      const existingId = tabsRef.current.find(
        (t): t is DiffTab => t.kind === "diff" && t.path === path && t.staged === staged,
      )?.id;
      const resultId = existingId ?? makeId("diff");
      setTabs((curr) => {
        const existing = curr.find(
          (t): t is DiffTab => t.kind === "diff" && t.path === path && t.staged === staged,
        );
        if (existing) {
          if (options?.focus !== false) setActiveId(existing.id);
          return curr;
        }
        const tab: DiffTab = {
          id: resultId,
          kind: "diff",
          title: basename(path),
          path,
          staged,
        };
        if (options?.focus !== false) setActiveId(resultId);
        return [...curr, tab];
      });
      return resultId;
    },
    [],
  );

  const setLeafScrollback = useCallback(
    (tabId: TabId, paneId: string, scrollback: string) => {
      const trimmed = trimPersistedTerminalScrollback(
        scrollback,
        terminalScrollbackLineLimitRef.current,
      );
      // No inline persist here: writing localStorage from inside the updater
      // double-wrote alongside the 300ms debounced effect (and double-fired
      // under StrictMode), and React's eager-updater optimization runs only
      // the FIRST queued updater synchronously — so a quit-time burst of
      // per-pane setLeafScrollback calls would persist only one pane. Steady
      // state is handled by the debounced effect; the synchronous quit path is
      // flushScrollbackNow below.
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
        return changed ? next : curr;
      });
    },
    [],
  );

  // Synchronous quit-time flush: fold a batch of final pane scrollback
  // snapshots into the current tab tree and write localStorage ONCE, outside
  // any state updater, so a beforeunload/pagehide handler can persist every
  // pane before the window tears down. Computes the next tabs from
  // tabsRef.current (the latest committed tree), writes to the workspace the
  // current tabs belong to, then reconciles React state so an interrupted
  // quit leaves the in-memory tree consistent with what was persisted.
  const flushScrollbackNow = useCallback(
    (entries: Array<{ tabId: TabId; paneId: string; text: string }>) => {
      const limit = terminalScrollbackLineLimitRef.current;
      let scrollbackChanged = false;
      const mappedTabs = tabsRef.current.map((t) => {
        if (t.kind !== "terminal") return t;
        let root = t.root;
        for (const entry of entries) {
          if (entry.tabId !== t.id) continue;
          const trimmed = trimPersistedTerminalScrollback(entry.text, limit);
          const existing = findLeaf(root, entry.paneId);
          if (!existing || existing.scrollback === trimmed) continue;
          const nextRoot = setLeafField(root, entry.paneId, "scrollback", trimmed);
          if (nextRoot !== root) root = nextRoot;
        }
        if (root === t.root) return t;
        scrollbackChanged = true;
        return { ...t, root };
      });
      const withScrollback = scrollbackChanged ? mappedTabs : tabsRef.current;
      const next = markTabAgentSessionsActive(
        withScrollback,
        quitActiveAgentPaneIdsRef.current,
      );
      persist(tabsWorkspaceIdRef.current, next, activeIdRef.current, limit, persistAgentStateRef.current, closedChatRunIdsArray());
      if (next !== tabsRef.current) setTabs(next);
    },
    [],
  );

  // Mounted warm/bridge workspace stacks own live xterms too. Persist their final buffers
  // directly into that workspace's frozen layout instead of routing through the
  // active tab store (which would corrupt the wrong workspace). This path is
  // used only for explicit final/unload flushing; periodic snapshots remain
  // visibility-gated so hidden workspaces stay cheap while their PTYs run.
  const flushWorkspaceScrollbackNow = useCallback(
    (
      targetWorkspaceId: string,
      entries: Array<{ tabId: TabId; paneId: string; text: string }>,
    ) => {
      if (tabsWorkspaceIdRef.current === targetWorkspaceId) {
        flushScrollbackNow(entries);
        return;
      }
      const live = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
      if (!live) return;
      const limit = terminalScrollbackLineLimitRef.current;
      let scrollbackChanged = false;
      const mappedTabs = live.tabs.map((tab) => {
        if (tab.kind !== "terminal") return tab;
        let root = tab.root;
        for (const entry of entries) {
          if (entry.tabId !== tab.id) continue;
          const trimmed = trimPersistedTerminalScrollback(entry.text, limit);
          const leaf = findLeaf(root, entry.paneId);
          if (!leaf || leaf.scrollback === trimmed) continue;
          const nextRoot = setLeafField(root, entry.paneId, "scrollback", trimmed);
          if (nextRoot !== root) root = nextRoot;
        }
        if (root === tab.root) return tab;
        scrollbackChanged = true;
        return { ...tab, root };
      });
      const withScrollback = scrollbackChanged ? mappedTabs : live.tabs;
      const nextTabs = markTabAgentSessionsActive(
        withScrollback,
        quitActiveAgentPaneIdsRef.current,
      );
      const next = { ...live, tabs: nextTabs };
      liveWorkspaceTabsRef.current.set(targetWorkspaceId, next);
      // A never-visited bridge-only layout is intentionally incomplete. Do not
      // overwrite that workspace's saved/default layout with this minimal
      // runtime shell during disconnect or quit; if the user visits, the
      // switch effect first merges the two and clears the marker.
      if (!deferredColdWorkspaceIdsRef.current.has(targetWorkspaceId)) {
        const closed = closedChatRunIdsByWorkspaceRef.current.get(targetWorkspaceId);
        persist(targetWorkspaceId, nextTabs, next.activeId, limit, persistAgentStateRef.current, closed ? Array.from(closed) : undefined);
      }
      if (nextTabs !== live.tabs) {
        setInactiveWorkspaceLayouts((current) =>
          current.map((layout) =>
            layout.workspaceId === targetWorkspaceId ? { ...layout, tabs: nextTabs } : layout,
          ),
        );
      }
    },
    [flushScrollbackNow],
  );

  const flushAgentSessionsNow = useCallback((activePaneIds: string[]) => {
    const paneIds = new Set(activePaneIds);
    quitActiveAgentPaneIdsRef.current = paneIds;
    const limit = terminalScrollbackLineLimitRef.current;
    const currentWorkspaceId = tabsWorkspaceIdRef.current;

    if (currentWorkspaceId) {
      const currentTabs = tabsRef.current;
      const nextTabs = markTabAgentSessionsActive(currentTabs, paneIds);
      const closed = closedChatRunIdsByWorkspaceRef.current.get(currentWorkspaceId);
      persist(
        currentWorkspaceId,
        nextTabs,
        activeIdRef.current,
        limit,
        persistAgentStateRef.current,
        closed ? Array.from(closed) : undefined,
      );
      liveWorkspaceTabsRef.current.set(currentWorkspaceId, {
        tabs: nextTabs,
        activeId: activeIdRef.current,
      });
      if (nextTabs !== currentTabs) {
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
    }

    let inactiveChanged = false;
    for (const [workspace, layout] of liveWorkspaceTabsRef.current) {
      if (workspace === currentWorkspaceId) continue;
      const nextTabs = markTabAgentSessionsActive(layout.tabs, paneIds);
      if (!deferredColdWorkspaceIdsRef.current.has(workspace)) {
        const closed = closedChatRunIdsByWorkspaceRef.current.get(workspace);
        persist(
          workspace,
          nextTabs,
          layout.activeId,
          limit,
          persistAgentStateRef.current,
          closed ? Array.from(closed) : undefined,
        );
      }
      if (nextTabs !== layout.tabs) {
        inactiveChanged = true;
        liveWorkspaceTabsRef.current.set(workspace, { ...layout, tabs: nextTabs });
      }
    }
    if (inactiveChanged) {
      setInactiveWorkspaceLayouts((current) =>
        current.map((layout) => {
          const latest = liveWorkspaceTabsRef.current.get(layout.workspaceId);
          return latest && latest.tabs !== layout.tabs
            ? { ...layout, tabs: latest.tabs }
            : layout;
        }),
      );
    }
  }, []);

  const hideRunsTabs = useCallback(() => {
    setTabs((curr) => {
      const next = curr.filter((t) => t.kind !== "runs");
      if (next.length === curr.length) return curr;
      if (next.length === 0) {
        // Reseed a bare terminal, NOT defaultTabs (chat + terminal): a chat tab
        // here could resurrect one the user deliberately closed. (Reaching this
        // branch requires a workspace holding only runs tabs, which is rare.)
        const seed = createTerminalTab(defaultCwdRef.current);
        setActiveId(seed.id);
        return [seed];
      }
      setActiveId((active) => {
        if (active && next.some((tab) => tab.id === active)) return active;
        // Prefer a chat tab when the active runs tab goes away, rather than
        // next[0] (often a terminal/preview) which would strand the user
        // off-chat.
        const chat = next.find((tab) => tab.kind === "chat");
        return chat?.id ?? next[0]?.id ?? null;
      });
      return next;
    });
  }, []);

  // Close the runs tab bound to `runId` (called when a chat is deleted). If
  // it is the only tab, seed a bare terminal tab instead — the workbench never
  // shows an empty global Runs placeholder, but we must NOT reseed a chat tab
  // (defaultTabs) here, which would resurrect one the user closed.
  const closeRunsTabFor = useCallback(
    (runId: string) => {
      setTabs((curr) => {
        const idx = curr.findIndex(
          (t) => t.kind === "runs" && t.runId === runId,
        );
        if (idx === -1) return curr;
        const tabId = curr[idx].id;
        if (curr.length <= 1) {
          const seed = createTerminalTab(defaultCwdRef.current);
          setActiveId(seed.id);
          fireDispose(tabId);
          return [seed];
        }
        const next = curr.filter((_, i) => i !== idx);
        setActiveId((active) =>
          active === tabId ? nearestFreeTabId(next, idx) : active,
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
        // Reseed a bare terminal, NOT defaultTabs (chat + terminal): on a run
        // deletion that empties the workspace, a reseeded chat tab would
        // resurrect one the user previously closed.
        const seed = createTerminalTab(defaultCwdRef.current);
        setActiveId(seed.id);
        return [seed];
      }
      const next = curr.filter((_, i) => i !== idx);
      setActiveId((active) =>
        active === tabId ? nearestFreeTabId(next, idx) : active,
      );
      return normalizeTerminalTitles(next);
    });
  }, []);

  // Close every preview tab a run spawned (run.deleted cleanup, alongside
  // closeRunsTabFor/closeWorkerTerminalTabFor). Run-tagged previews are listed
  // only in the deleted run's inner tab strip, so any left behind would be
  // invisible and uncloseable forever. A run can own several previews, hence
  // the filter (unlike the single runs/workers tabs). No PTYs to dispose —
  // fireDispose covers any registered per-tab teardown. Same reseed contract
  // as the sibling closers: never reseed a chat tab on an emptied workspace.
  const closePreviewTabsFor = useCallback(
    (runId: string) => {
      setTabs((curr) => {
        const doomed = curr.filter(
          (t): t is PreviewTab => t.kind === "preview" && t.runId === runId,
        );
        if (doomed.length === 0) return curr;
        const doomedIds = new Set<TabId>(doomed.map((t) => t.id));
        const next = curr.filter((t) => !doomedIds.has(t.id));
        for (const id of doomedIds) fireDispose(id);
        if (next.length === 0) {
          const seed = createTerminalTab(defaultCwdRef.current);
          setActiveId(seed.id);
          return [seed];
        }
        setActiveId((active) => {
          if (!active || !doomedIds.has(active)) return active;
          const fallbackChat = next.find((t) => t.kind === "chat");
          const fallbackFree = next.find((t) => !isRunOwnedTab(t));
          // Same rule as closeChatTabForRun: NEVER fall back onto a run-owned
          // tab (it may itself be pill-less) — empty state beats a stranding.
          return fallbackChat?.id ?? fallbackFree?.id ?? null;
        });
        return next;
      });
    },
    [fireDispose],
  );

  const closePreviewTabsForInWorkspace = useCallback(
    (targetWorkspaceId: string, runId: string) => {
      if (tabsWorkspaceIdRef.current === targetWorkspaceId) {
        closePreviewTabsFor(runId);
        return;
      }
      const live = liveWorkspaceTabsRef.current.get(targetWorkspaceId);
      if (!live) return;
      const doomed = live.tabs.filter(
        (tab): tab is PreviewTab => tab.kind === "preview" && tab.runId === runId,
      );
      if (doomed.length === 0) return;
      const doomedIds = new Set(doomed.map((tab) => tab.id));
      const nextTabs = live.tabs.filter((tab) => !doomedIds.has(tab.id));
      let nextActiveId = live.activeId;
      if (nextActiveId && doomedIds.has(nextActiveId)) {
        nextActiveId =
          nextTabs.find((tab) => tab.kind === "chat" && tab.id === runId)?.id
          ?? nextTabs.find((tab) => !isRunOwnedTab(tab))?.id
          ?? null;
      }
      const next = { tabs: nextTabs, activeId: nextActiveId };
      liveWorkspaceTabsRef.current.set(targetWorkspaceId, next);
      setInactiveWorkspaceLayouts((current) => {
        let changed = false;
        const layouts = current.map((layout) => {
          if (layout.workspaceId !== targetWorkspaceId) return layout;
          changed = true;
          return { ...layout, ...next };
        });
        return changed ? layouts : current;
      });
    },
    [closePreviewTabsFor],
  );

  // run.deleted cleanup for workspaces that are NOT the active one. The
  // closers above only mutate the active workspace's tab store; a run living
  // in a background workspace keeps its owned tabs (chat, workers terminal,
  // Runs canvas, previews) frozen inside the live in-memory snapshot and the
  // inactive-layout mirror. Switching back restores that snapshot VERBATIM —
  // the loadPersisted runId-strip only runs on boot / first entry — so a
  // deleted run's preview could come back as a fullscreen active tab with no
  // pill anywhere (the stranded-browser bug, via the Settings run manager's
  // cross-workspace delete). Prune every tab the dead run owned from both
  // stores, rerouting a stranded frozen activeId the same way the closers do.
  // The chat tab is pruned too (its run no longer exists; the sync effect
  // would drop it on switch-in anyway, but without any activeId reroute) —
  // closedChatRunIds is deliberately NOT touched: that set belongs to
  // explicit user closes, and a deleted run can never re-sync regardless.
  const pruneDeletedRunTabsFromInactiveWorkspaces = useCallback((runId: string) => {
    const ownedByRun = (t: Tab) =>
      (t.kind === "chat" && t.id === runId) ||
      (t.kind === "terminal" && t.scope?.kind === "workers" && t.scope.runId === runId) ||
      (t.kind === "runs" && t.runId === runId) ||
      (t.kind === "preview" && t.runId === runId);
    const prune = (
      layout: { tabs: Tab[]; activeId: TabId | null },
    ): { tabs: Tab[]; activeId: TabId | null } | null => {
      const doomed = layout.tabs.filter(ownedByRun);
      if (doomed.length === 0) return null;
      const next = layout.tabs.filter((t) => !ownedByRun(t));
      let nextActive = layout.activeId;
      if (nextActive && doomed.some((t) => t.id === nextActive)) {
        const fallbackChat = next.find((t) => t.kind === "chat");
        const fallbackFree = next.find((t) => !isRunOwnedTab(t));
        nextActive = fallbackChat?.id ?? fallbackFree?.id ?? null;
      }
      return { tabs: next, activeId: nextActive };
    };
    // The ref loop also handles pty teardown for pruned worker tabs (dispose
    // is idempotent / no-op for already-dead sessions). Kept OUT of the state
    // updater below so the updater stays pure under StrictMode double-invoke.
    for (const [ws, layout] of liveWorkspaceTabsRef.current) {
      if (ws === tabsWorkspaceIdRef.current) continue; // active store: closers own it
      const pruned = prune(layout);
      if (!pruned) continue;
      for (const t of layout.tabs) {
        if (ownedByRun(t)) disposeTerminalTabPanes(t);
      }
      liveWorkspaceTabsRef.current.set(ws, pruned);
    }
    setInactiveWorkspaceLayouts((prev) => {
      let changed = false;
      const next = prev.map((layout) => {
        const pruned = prune(layout);
        if (!pruned) return layout;
        changed = true;
        return { ...layout, ...pruned };
      });
      return changed ? next : prev;
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
      // The workspace the CURRENT `tabs` state belongs to. On the render
      // where the workspaceId prop flips, `tabs` still holds the previous
      // workspace's layout (the swap happens in the workspace-switch effect),
      // so consumers that pair tabs with a workspace id (e.g. the
      // terminal-agent notify registry sync in App) must read this instead
      // of App's activeId.
      tabsWorkspaceId: tabsWorkspaceIdRef.current,
      inactiveWorkspaceLayouts,
      pruneWorkspaceLayouts,
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
      newAgentTerminalTab,
      newAgentTerminalTabInWorkspace,
      newTerminalGrid,
      addAgentGridToTab,
      addBalancedPaneToTab,
      ensureWorkerTerminalTab,
      detachTerminalPaneToNewTab,
      openTabInSplit,
      dockTabInTerminal,
      undockTab,
      moveTerminalPane,
      splitTerminalPane,
      closeTerminalPane,
      closeTerminalPaneInWorkspace,
      findTerminalPaneInInactiveWorkspaces,
      toggleTerminalPaneZoom,
      setActiveTerminalPane,
      setTerminalSplitRatio,
      setLeafCwd,
      setLeafScrollback,
      flushScrollbackNow,
      flushWorkspaceScrollbackNow,
      flushAgentSessionsNow,
      setLeafWorker,
      updateLeafWorkerInWorkspace,
      setLeafAgentSession,
      setLeafBootResumeConsumed,
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
      openAutomationsTab,
      openUsageTab,
      newWhiteboardTab,
      openDiffTab,
      closeRunsTabFor,
      closeWorkerTerminalTabFor,
      closePreviewTabsFor,
      closePreviewTabsForInWorkspace,
      pruneDeletedRunTabsFromInactiveWorkspaces,
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
    // data fields can change, so they're the sole real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, activeId, activeTab, inactiveWorkspaceLayouts],
  );
}
