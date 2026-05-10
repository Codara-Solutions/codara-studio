import { useCallback, useEffect, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import type {
  EditorTab,
  PreviewTab,
  RunsTab,
  Tab,
  TabId,
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
const TAB_VERSION = 1;

interface PersistedShape {
  v: number;
  tabs: Tab[];
  activeId: TabId | null;
}

function storageKey(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  return `${STORAGE_KEY_PREFIX}${workspaceId}`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "preview";
  }
}

function defaultRunsTab(): RunsTab {
  return {
    id: uid("runs"),
    kind: "runs",
    title: "Runs",
    runId: null,
  };
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
    return parsed;
  } catch {
    return null;
  }
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
  setDetectedUrl: (id: TabId, url: string) => void;
  newTerminalTab: (cwd?: string) => TabId;
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
  // Keep the workspaceId handy in a ref so persistence helpers can read
  // the current id without re-binding the callbacks every render.
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;

  const [tabs, setTabs] = useState<Tab[]>(() => {
    const loaded = loadPersisted(workspaceId);
    if (loaded && loaded.tabs.length > 0) return loaded.tabs;
    return [defaultRunsTab()];
  });
  const [activeId, setActiveId] = useState<TabId | null>(() => {
    const loaded = loadPersisted(workspaceId);
    if (loaded && loaded.tabs.length > 0) {
      return loaded.activeId && loaded.tabs.some((t) => t.id === loaded.activeId)
        ? loaded.activeId
        : loaded.tabs[0].id;
    }
    return null;
  });

  // When the workspace switches, swap tabs to the new workspace's persisted
  // set (or seed a default Runs tab). We deliberately reset rather than
  // merge: a workspace switch should feel like opening a new project.
  useEffect(() => {
    const loaded = loadPersisted(workspaceId);
    if (loaded && loaded.tabs.length > 0) {
      setTabs(loaded.tabs);
      setActiveId(
        loaded.activeId && loaded.tabs.some((t) => t.id === loaded.activeId)
          ? loaded.activeId
          : loaded.tabs[0].id,
      );
      return;
    }
    const seed = defaultRunsTab();
    setTabs([seed]);
    setActiveId(seed.id);
  }, [workspaceId]);

  // Persist on every change. Cheap enough to do synchronously; the JSON
  // payload stays small (a few hundred bytes for a typical layout).
  useEffect(() => {
    persist(wsRef.current, tabs, activeId);
  }, [tabs, activeId]);

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

  const setDetectedUrl = useCallback((id: TabId, url: string) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "terminal" ? { ...t, detectedUrl: url } : t,
      ),
    );
  }, []);

  const newTerminalTab = useCallback((cwd?: string): TabId => {
    const id = uid("term");
    const tab: TerminalTab = {
      id,
      kind: "terminal",
      title: "shell",
      cwd,
    };
    setTabs((curr) => [...curr, tab]);
    setActiveId(id);
    return id;
  }, []);

  const newPreviewTab = useCallback((url: string): TabId => {
    const id = uid("preview");
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
    const id = uid("runs");
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
      const id = uid("editor");
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
    return (outId ?? uid("editor")) as TabId;
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

  return {
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
    newPreviewTab,
    newRunsTab,
    openEditorTab,
    setEditorEntry,
    closeEditorByPath,
    setActiveEditorPath,
    setActiveRunId,
    setPreviewUrl,
    registerDispose,
  };
}
