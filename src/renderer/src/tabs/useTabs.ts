import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import { makeId } from "@shared/ids";
import { basename } from "../path-utils";
import {
  findLeaf,
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
  EditorTab,
  PreviewTab,
  RunsTab,
  Tab,
  TabId,
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
// v3 drops the removed "project"/CRM tab kind. v2 introduced the recursive
// PaneNode tree on TerminalTab. Bumping the version discards older layouts
// on load — the user just loses their tab strip, not any code.
const TAB_VERSION = 3;

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

function manualWorkerForCommand(command: string | undefined, paneId: string): TerminalLeafWorker | null {
  const executable = command?.trim().split(/\s+/)[0]?.toLowerCase();
  const runtime =
    executable === "claude" || executable?.endsWith("/claude") || executable?.endsWith("\\claude")
      ? "claude"
      : executable === "codex" || executable?.endsWith("/codex") || executable?.endsWith("\\codex")
        ? "codex"
        : executable === "opencode" || executable?.endsWith("/opencode") || executable?.endsWith("\\opencode")
          ? "opencode"
          : undefined;
  if (!runtime) return null;
  return {
    runtime,
    runId: "manual",
    workerTaskId: `manual-${paneId}`,
    attemptId: paneId,
    source: "manual",
    state: "running",
  };
}

function defaultRunsTab(): RunsTab {
  return {
    id: makeId("runs"),
    kind: "runs",
    title: "Runs",
    runId: null,
  };
}

function defaultTabs(): Tab[] {
  return [defaultRunsTab()];
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
    // Reset any persisted worker.state="running" markers — the PTY they
    // pointed at died when the app closed, so the leaf is actually idle.
    // Without this, a leaf that hosted a worker at shutdown would be stuck
    // visually showing a running chip and would never be claimed again.
    for (const tab of parsed.tabs) {
      if (tab.kind === "terminal") cleanupStaleWorkers(tab.root);
      if (tab.kind === "runs" && (tab.title === "Runs" || tab.title === "Ops")) tab.title = "Runs";
    }
    return parsed;
  } catch {
    return null;
  }
}

function cleanupStaleWorkers(node: import("./types").PaneNode): void {
  if (node.kind === "leaf") {
    // Autorun panes (Claude/Codex worker entries from the AddPane menu)
    // re-launch on mount, so set the manual worker fresh — useTerminalSession
    // will re-fire running=true once the banner is detected anyway, but this
    // keeps the chip visible during the 1500ms autorun delay.
    const manualWorker = manualWorkerForCommand(node.autorun, node.paneId);
    if (manualWorker) {
      node.worker = manualWorker;
      return;
    }
    if (!node.worker) return;
    // Manual workers (user-typed agent) have no lifecycle outside the live
    // PTY, so a manual worker persisted from a previous session is by
    // definition stale — wipe it. The sniffer will re-add a chip if the
    // pane has the agent's banner still on screen after re-mount.
    if (node.worker.source === "manual") {
      node.worker = null;
      return;
    }
    if (node.worker.state === "running") {
      node.worker = { ...node.worker, state: "done" };
    }
    return;
  }
  cleanupStaleWorkers(node.a);
  cleanupStaleWorkers(node.b);
}

function persist(workspaceId: string | null, tabs: Tab[], activeId: TabId | null): void {
  const key = storageKey(workspaceId);
  if (!key) return;
  try {
    const payload: PersistedShape = { v: TAB_VERSION, tabs, activeId };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable; persistence is best-effort.
  }
}

// Resolve the initial tabs + activeId for a workspace in a SINGLE
// localStorage read. Both the lazy useState initializer and the
// workspace-switch effect funnel through here so loadPersisted (a
// JSON.parse + a recursive cleanupStaleWorkers walk) only runs once per
// mount/switch instead of three times. Falls back to the default tab set
// when nothing is persisted (or the persisted blob is a stale version).
function initialTabsState(workspaceId: string | null): {
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
  const seed = defaultTabs();
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
  setDirty: (id: TabId, dirty: boolean) => void;
  setDetectedUrl: (tabId: TabId, paneId: string, url: string) => void;
  newTerminalTab: (cwd?: string, autorun?: string, title?: string) => TabId;
  splitTerminalPane: (
    tabId: TabId,
    paneId: string,
    direction: TerminalSplit["direction"],
    autorun?: string,
  ) => string | null;
  closeTerminalPane: (tabId: TabId, paneId: string) => void;
  setActiveTerminalPane: (tabId: TabId, paneId: string) => void;
  setTerminalSplitRatio: (tabId: TabId, path: PanePath, ratio: number) => void;
  setLeafCwd: (tabId: TabId, paneId: string, cwd: string) => void;
  setLeafWorker: (tabId: TabId, paneId: string, worker: TerminalLeafWorker | null) => void;
  // Rename a leaf's paneId. The old TerminalPane unmounts (which dispose()s
  // the old PTY); a new one mounts at the new id and spawns at it. Used by
  // orchestration to take over an existing user pane (so worker output
  // appears where the user can see it).
  renameLeaf: (tabId: TabId, oldPaneId: string, newPaneId: string) => boolean;
  // Smart-add a leaf in a specific tab using a caller-supplied paneId. Picks
  // the largest existing leaf as the split anchor; useful for orchestration
  // when no idle leaf is available to claim.
  addPaneInTab: (
    tabId: TabId,
    paneId: string,
    options?: { rootWidth?: number; rootHeight?: number; cwd?: string; worker?: TerminalLeafWorker | null },
  ) => boolean;
  newPreviewTab: (url: string) => TabId;
  newRunsTab: (runId: string | null) => TabId;
  openEditorTab: (entry: FsEntry) => TabId;
  setEditorEntry: (oldPath: string, entry: FsEntry) => void;
  closeEditorByPath: (path: string) => void;
  setActiveEditorPath: (path: string) => void;
  setActiveRunId: (runId: string | null) => void;
  setPreviewUrl: (id: TabId, url: string) => void;
  registerDispose: (id: TabId, fn: () => void) => void;
}

export function useTabs(workspaceId: string | null): UseTabsApi {
  // Parse the persisted layout ONCE for the initial mount. The previous
  // implementation called loadPersisted from both useState initializers,
  // re-doing the JSON.parse + recursive cleanupStaleWorkers walk twice; a
  // single lazy initializer holding the {tabs, activeId} pair collapses
  // that to one parse. We keep `tabs` and `activeId` as separate useState
  // cells (so the many mutating callbacks below stay untouched) and just
  // seed both from one computed snapshot.
  const initial = useState(() => initialTabsState(workspaceId))[0];
  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeId, setActiveId] = useState<TabId | null>(initial.activeId);

  // When the workspace switches, swap tabs to the new workspace's persisted
  // set (or seed a default Runs tab). We deliberately reset rather than
  // merge: a workspace switch should feel like opening a new project.
  //
  // initialTabsState parses localStorage exactly once (was three reads
  // before: two initializers + this effect). The `firstRun` guard skips the
  // redundant re-parse on mount — the lazy initializer above already
  // produced this exact value, so re-running it here would be wasted work.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    const next = initialTabsState(workspaceId);
    setTabs(next.tabs);
    setActiveId(next.activeId);
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
        const next = curr.filter((t) => t.id !== id);
        setActiveId((active) => {
          if (active !== id) return active;
          // Prefer the tab to the left, fall back to the first.
          return next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null;
        });
        fireDispose(id);
        return next;
      });
    },
    [fireDispose],
  );

  const closeOthers = useCallback(
    (keepId: TabId) => {
      setTabs((curr) => {
        const target = curr.find((t) => t.id === keepId);
        if (!target) return curr;
        const removed = curr.filter((t) => t.id !== keepId);
        for (const t of removed) fireDispose(t.id);
        setActiveId(keepId);
        return [target];
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

  const selectByIndex = useCallback((idx: number) => {
    setTabs((curr) => {
      const target = curr[idx];
      if (target) setActiveId(target.id);
      return curr;
    });
  }, []);

  const setDirty = useCallback((id: TabId, dirty: boolean) => {
    setTabs((curr) =>
      curr.map((t) => (t.id === id && t.kind === "editor" ? { ...t, dirty } : t)),
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
    (cwd?: string, autorun?: string, title?: string): TabId => {
      const id = makeId("term");
      const paneId = makeId("pane");
      const root = leaf(paneId, cwd, autorun);
      const worker = manualWorkerForCommand(autorun, paneId);
      if (worker) root.worker = worker;
      const tab: TerminalTab = {
        id,
        kind: "terminal",
        title: title ?? "terminals",
        root,
        activePaneId: paneId,
      };
      setTabs((curr) => [...curr, tab]);
      setActiveId(id);
      return id;
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
          const worker = manualWorkerForCommand(autorun, fresh);
          if (worker) newLeaf.worker = worker;
          const root = splitAtLeaf(
            t.root,
            paneId,
            direction,
            // Inherit cwd from the source pane so a split reflects the user's
            // current shell directory rather than dropping back to project root.
            newLeaf,
          );
          return { ...t, root, activePaneId: fresh };
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
          next.push({ ...t, root, activePaneId });
        }
        if (next.length === 0) {
          // Restoring the seed tab keeps the workbench from rendering an
          // empty stack; matches closeTab's invariant.
          const seed = defaultTabs();
          setActiveId(seed[0].id);
          return seed;
        }
        if (dropped) {
          setActiveId((active) => {
            if (active !== tabId) return active;
            return next[next.length - 1]?.id ?? null;
          });
        }
        return next;
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
      options?: { rootWidth?: number; rootHeight?: number; cwd?: string; worker?: TerminalLeafWorker | null },
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
          const newLeaf = leaf(paneId, options?.cwd);
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

  const newPreviewTab = useCallback((url: string): TabId => {
    const id = makeId("preview");
    const tab: PreviewTab = {
      id,
      kind: "preview",
      title: titleFromUrl(url),
      url,
    };
    setTabs((curr) => [...curr, tab]);
    setActiveId(id);
    return id;
  }, []);

  const newRunsTab = useCallback((runId: string | null): TabId => {
    const id = makeId("runs");
    const tab: RunsTab = {
      id,
      kind: "runs",
      title: runId ? `Run ${runId.slice(-6)}` : "Runs",
      runId,
    };
    setTabs((curr) => [...curr, tab]);
    setActiveId(id);
    return id;
  }, []);

  const openEditorTab = useCallback((entry: FsEntry): TabId => {
    // The setter is invoked synchronously by React, so reading `outId`
    // back after `setTabs` returns is safe. TypeScript can't see through
    // the closure on its own, hence the unknown-cast at the end.
    let outId: TabId | null = null;
    setTabs((curr) => {
      const existing = curr.find(
        (t) => t.kind === "editor" && t.path === entry.path,
      );
      if (existing) {
        outId = existing.id;
        return curr;
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
      };
      return [...curr, tab];
    });
    if (outId) setActiveId(outId);
    return (outId ?? makeId("editor")) as TabId;
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

  // Update the first runs tab's pinned runId so the RunsStack re-renders
  // the correct canvas. Most workspaces have exactly one runs tab; if the
  // user pinned several, we leave the others alone so each pin sticks.
  const setActiveRunId = useCallback((runId: string | null) => {
    setTabs((curr) => {
      const idx = curr.findIndex((t) => t.kind === "runs");
      if (idx === -1) return curr;
      const target = curr[idx];
      if (target.kind !== "runs") return curr;
      if (target.runId === runId) return curr;
      const next = [...curr];
      next[idx] = { ...target, runId };
      return next;
    });
  }, []);

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
      setDirty,
      setDetectedUrl,
      newTerminalTab,
      splitTerminalPane,
      closeTerminalPane,
      setActiveTerminalPane,
      setTerminalSplitRatio,
      setLeafCwd,
      setLeafWorker,
      renameLeaf,
      addPaneInTab,
      newPreviewTab,
      newRunsTab,
      openEditorTab,
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
