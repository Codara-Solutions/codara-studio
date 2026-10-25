import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TerminalAgentTarget, Workspace } from "@shared/types";
import { emitLocalToast } from "../../notifications/local-toast";
import type { Tab } from "../../tabs/types";
import type { JumpTarget } from "./jump-model";
import { focusJumpTargetWhenReady } from "./focus-target";
import {
  EMPTY_WORKSPACE_HISTORY,
  parseRecency,
  RECENCY_STORAGE_ITEM,
  recordRecency,
  stepWorkspaceHistory,
  visitWorkspace,
  type RecencyMap,
  type WorkspaceHistory,
} from "./workspace-history";

export interface UseWorkspaceJumpOptions {
  activeWorkspaceId: string | null;
  workspaces: readonly Workspace[];
  /** The workspace the loaded tab layout belongs to; lags a switch by a render. */
  tabsWorkspaceId: string | null;
  /** The loaded layout's tabs (those of `tabsWorkspaceId`). */
  layoutTabs: readonly Tab[];
  activeTabId: string | null;
  /** The active terminal tab's selected pane, if the active tab is a terminal. */
  activePaneId: string | null;
  activateWorkspace: (id: string) => void;
  setActiveTab: (tabId: string) => void;
  focusTerminalTarget: (target: TerminalAgentTarget) => void;
}

export interface WorkspaceJump {
  jumpTo: (target: JumpTarget) => void;
  back: () => boolean;
  forward: () => boolean;
  /** When each workspace, tab and agent pane was last on screen. */
  recency: () => RecencyMap;
}

function loadRecency(): RecencyMap {
  try {
    return parseRecency(window.localStorage.getItem(RECENCY_STORAGE_ITEM));
  } catch {
    return {};
  }
}

function saveRecency(map: RecencyMap): void {
  try {
    window.localStorage.setItem(RECENCY_STORAGE_ITEM, JSON.stringify(map));
  } catch {
    /* recency only orders the palette; a full or blocked store loses that alone */
  }
}

// The workspace history behind back and forward, the recency the jump
// palette ranks by, and the jump itself: switch workspace, then select and
// focus the tab or pane once that workspace's layout is loaded.
export function useWorkspaceJump(options: UseWorkspaceJumpOptions): WorkspaceJump {
  const latest = useRef(options);
  latest.current = options;
  const recencyRef = useRef<RecencyMap | null>(null);
  if (recencyRef.current === null) recencyRef.current = loadRecency();
  const historyRef = useRef<WorkspaceHistory>(EMPTY_WORKSPACE_HISTORY);
  const saveTimerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveRecency(recencyRef.current ?? {});
  }, []);

  const record = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    recencyRef.current = recordRecency(recencyRef.current ?? {}, ids, Date.now());
    if (saveTimerRef.current !== null) return;
    saveTimerRef.current = window.setTimeout(flush, 1_000);
  }, [flush]);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      if (saveTimerRef.current !== null) flush();
    };
  }, [flush]);

  // A workspace counts as used both when it comes on screen and when it
  // leaves, so the one just left ranks first in the palette.
  const lastWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastWorkspaceRef.current;
    const next = options.activeWorkspaceId;
    lastWorkspaceRef.current = next;
    const ids: string[] = [];
    if (previous && previous !== next) ids.push(`ws:${previous}`);
    if (next) ids.push(`ws:${next}`);
    record(ids);
    historyRef.current = visitWorkspace(historyRef.current, next);
  }, [options.activeWorkspaceId, record]);

  // Same for the tab and pane on screen, read only once the layout on screen
  // is the active workspace's (it trails a switch by one render).
  const lastTabKeysRef = useRef<string[]>([]);
  useEffect(() => {
    if (!options.tabsWorkspaceId || options.tabsWorkspaceId !== options.activeWorkspaceId) return;
    const current: string[] = [];
    if (options.activeTabId) current.push(`tab:${options.activeTabId}`);
    if (options.activePaneId) current.push(`pane:${options.activePaneId}`);
    record([...lastTabKeysRef.current, ...current]);
    lastTabKeysRef.current = current;
  }, [
    options.tabsWorkspaceId,
    options.activeWorkspaceId,
    options.activeTabId,
    options.activePaneId,
    record,
  ]);

  // The palette's rows are read when it opens, so a tab can close before
  // its row is chosen; selecting a missing id would leave the stage empty.
  const selectTab = useCallback((target: JumpTarget & { tabId: string }) => {
    const current = latest.current;
    if (!current.layoutTabs.some((tab) => tab.id === target.tabId)) {
      emitLocalToast("That tab was closed", "", "warning");
      return;
    }
    current.setActiveTab(target.tabId);
    focusJumpTargetWhenReady(target);
  }, []);

  const pendingTabRef = useRef<JumpTarget | null>(null);
  useEffect(() => {
    const pending = pendingTabRef.current;
    if (!pending?.tabId) return;
    // Another workspace came on screen before this one's layout loaded: that
    // jump is over, and a later visit must not select its tab out of the blue.
    if (pending.workspaceId !== options.activeWorkspaceId) {
      pendingTabRef.current = null;
      return;
    }
    if (pending.workspaceId !== options.tabsWorkspaceId) return;
    pendingTabRef.current = null;
    selectTab({ ...pending, tabId: pending.tabId });
  }, [options.activeWorkspaceId, options.tabsWorkspaceId, selectTab]);

  const jumpTo = useCallback((target: JumpTarget) => {
    const current = latest.current;
    if (!current.workspaces.some((workspace) => workspace.id === target.workspaceId)) return;
    pendingTabRef.current = null;
    const switching = target.workspaceId !== current.activeWorkspaceId;
    // The rail's own activation path, so the switch badge shows and the
    // workspace's chat selection is saved, before any tab or pane focus.
    if (switching) current.activateWorkspace(target.workspaceId);
    if (target.tabId && target.paneId) {
      // Queues itself until the workspace's layout is loaded.
      current.focusTerminalTarget({
        workspaceId: target.workspaceId,
        tabId: target.tabId,
        paneId: target.paneId,
      });
      focusJumpTargetWhenReady(target);
      return;
    }
    if (!target.tabId) return;
    if (!switching && current.tabsWorkspaceId === target.workspaceId) {
      selectTab({ ...target, tabId: target.tabId });
      return;
    }
    pendingTabRef.current = target;
  }, [selectTab]);

  const step = useCallback((direction: -1 | 1): boolean => {
    const current = latest.current;
    const result = stepWorkspaceHistory(
      historyRef.current,
      direction,
      (id) => current.workspaces.some((workspace) => workspace.id === id),
      current.activeWorkspaceId,
    );
    if (!result) return false;
    // Moving the cursor first makes the activation's own visit a no-op, so
    // stepping back keeps the entries ahead for forward.
    historyRef.current = result.history;
    current.activateWorkspace(result.target);
    return true;
  }, []);

  const back = useCallback(() => step(-1), [step]);
  const forward = useCallback(() => step(1), [step]);
  const recency = useCallback(() => recencyRef.current ?? {}, []);

  // Stable, so App's shortcut handler table keeps its identity.
  return useMemo(() => ({ jumpTo, back, forward, recency }), [jumpTo, back, forward, recency]);
}
