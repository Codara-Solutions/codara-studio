import React, { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChatBackendKind, FsEntry } from "@shared/types";
import { type EngineOption, useEngineOptions } from "./engine/engineOptions";
import { ChevronIcon } from "./icons";
import { FileNodeIcon } from "./file-icons/FileNodeIcon";
import { InlineInput } from "./file-icons/InlineInput";
import { basename, dirname } from "../path-utils";
import SectionHeader, { type SectionHeaderDragProps } from "../panels/SectionHeader";

// Tree row geometry. Hoisted to module scope so the values are shared by
// `Row` and `PlaceholderRow` and never re-allocated per render.
const INDENT_STEP = 8;
const BASE_LEFT = 6;
const ROW_HEIGHT = 22;

// Static parts of the row container `style`. The per-row bits that actually
// change (padding-left from depth, background/color from active|hover) are
// spread on top of this in the component, so this object is allocated exactly
// once for the whole module rather than once per row per render.
const ROW_STYLE_BASE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 4,
  height: ROW_HEIGHT,
  cursor: "default",
};

// Fixed-width chevron gutter shared by every row.
const CHEVRON_CELL_STYLE: React.CSSProperties = {
  width: 12,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 12px",
  color: "var(--muted)",
};

// The name label style. `color` is the only dynamic property (active vs not),
// so it is overridden inline; everything else is constant.
const ROW_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 400,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
  flex: 1,
};

// Indent-guide vertical rule. `left` is computed per guide from its depth
// index, so it is overridden inline; the rest is constant.
const INDENT_GUIDE_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 1,
  background: "var(--rule-soft)",
  opacity: 0.6,
};

// Loading "…" affordance shown on a directory row while its children load.
const ROW_LOADING_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--muted)",
};

// Virtuoso's inner list element. We give it the 2px-top / 8px-bottom padding
// the plain `overflow: auto` scroll container used to have, so virtualizing
// the list does not change the tree's vertical spacing. `forwardRef` is
// required: Virtuoso attaches a ref to whatever component is passed here.
// Defined once at module scope so the `components` prop identity is stable
// (a fresh object there would otherwise remount the scroller every render).
const VirtuosoList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function VirtuosoList({ style, children, ...rest }, ref) {
  return (
    <div ref={ref} style={{ ...style, paddingTop: 2, paddingBottom: 8 }} {...rest}>
      {children}
    </div>
  );
});

const LIST_COMPONENTS = { List: VirtuosoList };

function normalizePath(path: string): string {
  // fs.watch on Windows can produce mixed separators; normalize for set lookups.
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// File extensions Spark can run as a plan via the explorer's right-click
// "Run plan" action. A plan is just text handed to the manager, so markdown
// and rendered HTML docs both qualify.
const PLAN_FILE_EXTS = new Set(["md", "markdown", "html", "htm"]);
const PREVIEW_FILE_EXTS = new Set(["html", "htm"]);

// Width of the Run plan engine flyout, shared by the edge-flip math (does it
// fit to the right of the menu?) and the flyout panel's own style.
const ENGINE_FLYOUT_WIDTH = 184;

function isRunnablePlan(entry: FsEntry): boolean {
  return !entry.isDir && PLAN_FILE_EXTS.has((entry.ext ?? "").toLowerCase());
}

function isPreviewFile(entry: FsEntry): boolean {
  return !entry.isDir && PREVIEW_FILE_EXTS.has((entry.ext ?? "").toLowerCase());
}

function filePathToBrowserUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const encoded = absolute
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join("/");
  return `file://${encoded}`;
}

interface DirNode {
  entry: FsEntry;
  open: boolean;
  loaded: boolean;
  loading: boolean;
  children: Node[];
  error?: string;
}

interface FileNode {
  entry: FsEntry;
}

type Node = (DirNode & { kind: "dir" }) | (FileNode & { kind: "file" });

interface Props {
  cwd: string;
  activePath?: string | null;
  onOpenFile: (entry: FsEntry, options?: { preview?: boolean }) => void;
  onDeleteFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, entry: FsEntry) => void;
  // Right-click a .md/.html file to hand it to the orchestrator as a plan.
  // `backend` is the engine chosen from the Run plan flyout (undefined = the
  // default Spark / OpenRouter manager; "claude" / "codex" route to that CLI).
  onRunPlan?: (entry: FsEntry, backend?: ChatBackendKind) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  headerDrag?: SectionHeaderDragProps;
}

interface FileContextMenu {
  x: number;
  y: number;
  entry: FsEntry;
}

interface PendingCreate {
  parentPath: string;
  kind: "file" | "dir";
}

interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MarqueeSelection {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
  baseSelection: Set<string>;
  active: boolean;
}

export default function FileTree({
  cwd,
  activePath,
  onOpenFile,
  onDeleteFile,
  onRenameFile,
  onRunPlan,
  collapsed,
  onToggleCollapse,
  headerDrag,
}: Props) {
  const [root, setRoot] = useState<DirNode & { kind: "dir" }>(() => makeDir({ name: basename(cwd), path: cwd, isDir: true }, true));
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(() => new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  // Engines offered by the Run plan flyout (Spark always; Claude / Codex when
  // their CLI is installed). One entry (just Spark) → plain single action.
  const engines = useEngineOptions();
  const rootRef = useRef(root);
  rootRef.current = root;
  const flatRef = useRef<FlatRow[]>([]);
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const selectedFilePathsRef = useRef(selectedFilePaths);
  selectedFilePathsRef.current = selectedFilePaths;
  const selectionAnchorPathRef = useRef(selectionAnchorPath);
  selectionAnchorPathRef.current = selectionAnchorPath;
  const marqueeSelectionRef = useRef<MarqueeSelection | null>(null);
  const suppressNextClickRef = useRef(false);
  // Imperative handle on the virtualized list. Used to scroll the active node
  // back into view when `activePath` changes from outside the visible window
  // (e.g. opening a file via search, or F2 rename on an off-screen node).
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  const updateRowElement = useCallback((path: string, element: HTMLDivElement | null) => {
    if (element) rowElementsRef.current.set(path, element);
    else rowElementsRef.current.delete(path);
  }, []);

  const updateMarqueeSelection = useCallback((event: MouseEvent) => {
    const marquee = marqueeSelectionRef.current;
    const viewport = listViewportRef.current;
    if (!marquee || !viewport) return;
    marquee.currentX = event.clientX;
    marquee.currentY = event.clientY;

    const moved =
      Math.abs(marquee.currentX - marquee.startX) >= 4 ||
      Math.abs(marquee.currentY - marquee.startY) >= 4;
    if (!moved && !marquee.active) return;

    event.preventDefault();
    marquee.active = true;
    const clientRect = rectFromPoints(
      marquee.startX,
      marquee.startY,
      marquee.currentX,
      marquee.currentY,
    );
    const viewportRect = viewport.getBoundingClientRect();
    setSelectionRect(rectRelativeToViewport(clientRect, viewportRect));

    const next = marquee.additive ? new Set(marquee.baseSelection) : new Set<string>();
    let firstSelected: string | null = null;
    for (const [path, element] of rowElementsRef.current) {
      if (!rectsIntersect(clientRect, element.getBoundingClientRect())) continue;
      next.add(path);
      firstSelected ??= path;
    }
    setSelectedFilePaths(next);
    if (firstSelected) setSelectionAnchorPath(firstSelected);
  }, []);

  const finishMarqueeSelection = useCallback(() => {
    const marquee = marqueeSelectionRef.current;
    if (marquee?.active) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    }
    marqueeSelectionRef.current = null;
    setSelectionRect(null);
    window.removeEventListener("mousemove", updateMarqueeSelection);
    window.removeEventListener("mouseup", finishMarqueeSelection);
  }, [updateMarqueeSelection]);

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", updateMarqueeSelection);
      window.removeEventListener("mouseup", finishMarqueeSelection);
    };
  }, [finishMarqueeSelection, updateMarqueeSelection]);

  // Reload when cwd changes
  useEffect(() => {
    let cancelled = false;
    const next: DirNode & { kind: "dir" } = makeDir(
      { name: basename(cwd), path: cwd, isDir: true },
      true,
    );
    setRoot(next);
    setContextMenu(null);
    setRenamingPath(null);
    setPendingCreate(null);
    setSelectedFilePaths(new Set());
    setSelectionAnchorPath(null);
    setSelectionRect(null);
    marqueeSelectionRef.current = null;
    rowElementsRef.current.clear();
    (async () => {
      const children = await loadDir(cwd);
      if (cancelled) return;
      next.children = children;
      next.loaded = true;
      next.loading = false;
      force((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const toggleDir = useCallback(async (node: DirNode & { kind: "dir" }) => {
    if (!node.loaded) {
      node.loading = true;
      force((n) => n + 1);
      try {
        node.children = await loadDir(node.entry.path);
        node.loaded = true;
        node.error = undefined;
      } catch (err) {
        node.error = (err as Error).message;
      }
      node.loading = false;
    }
    node.open = !node.open;
    force((n) => n + 1);
  }, []);

  const expandDir = useCallback(async (node: DirNode & { kind: "dir" }) => {
    if (node.open && node.loaded) return;
    if (!node.loaded) {
      node.loading = true;
      force((n) => n + 1);
      try {
        node.children = await loadDir(node.entry.path);
        node.loaded = true;
        node.error = undefined;
      } catch (err) {
        node.error = (err as Error).message;
      }
      node.loading = false;
    }
    node.open = true;
    force((n) => n + 1);
  }, []);

  const refreshDir = useCallback(async (dirPath: string) => {
    const dir = findDir(rootRef.current, dirPath);
    if (!dir) return;
    dir.loading = true;
    force((n) => n + 1);
    try {
      await reloadDirInPlace(dir);
      setError(null);
    } catch (err) {
      dir.error = (err as Error).message;
      setError((err as Error).message);
    } finally {
      dir.loading = false;
      force((n) => n + 1);
    }
  }, []);

  // Watch the workspace for filesystem changes and refresh affected dirs.
  useEffect(() => {
    let cancelled = false;
    void window.spark.fs.setWatchRoot(cwd);
    const unsub = window.spark.fs.onChanged((event) => {
      if (cancelled || event.root !== cwd) return;
      const changed = new Set(event.dirs.map(normalizePath));
      const matches: (DirNode & { kind: "dir" })[] = [];
      collectMatchingDirs(rootRef.current, changed, matches);
      if (matches.length === 0) {
        const normalizedRoot = normalizePath(cwd);
        const relevant = Array.from(changed).some(
          (dir) => dir === normalizedRoot || dir.startsWith(`${normalizedRoot}/`),
        );
        if (relevant) matches.push(rootRef.current);
      }
      if (matches.length === 0) return;
      void Promise.all(matches.map((d) => reloadDirInPlace(d))).then(() => {
        if (!cancelled) force((n) => n + 1);
      });
    });
    return () => {
      cancelled = true;
      unsub();
      void window.spark.fs.setWatchRoot(null);
    };
  }, [cwd]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // Rename ----------------------------------------------------------------
  const beginRename = useCallback((entry: FsEntry) => {
    setContextMenu(null);
    setPendingCreate(null);
    if (!entry.isDir) {
      setSelectedFilePaths(new Set([entry.path]));
      setSelectionAnchorPath(entry.path);
    }
    setRenamingPath(entry.path);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const commitRename = useCallback(
    async (path: string, value: string) => {
      const nextName = value.trim();
      const target = findEntry(rootRef.current, path);
      if (!target) {
        setRenamingPath(null);
        return;
      }
      if (!nextName || nextName === target.entry.name) {
        setRenamingPath(null);
        return;
      }
      try {
        const renamed = await window.spark.fs.renameFile({ path, newName: nextName });
        await refreshDir(parentPath(path));
        onRenameFile?.(path, renamed);
        setSelectedFilePaths((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Set(prev);
          next.delete(path);
          if (!renamed.isDir) next.add(renamed.path);
          return next;
        });
        setSelectionAnchorPath((anchor) => (anchor === path ? renamed.path : anchor));
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRenamingPath(null);
      }
    },
    [onRenameFile, refreshDir],
  );

  // Create ----------------------------------------------------------------
  const beginCreate = useCallback(
    async (parentEntry: FsEntry, kind: "file" | "dir") => {
      setContextMenu(null);
      setRenamingPath(null);
      setSelectedFilePaths(new Set());
      setSelectionAnchorPath(null);
      // If user invoked from a dir, expand it so the placeholder is visible.
      if (parentEntry.isDir) {
        const node = findDir(rootRef.current, parentEntry.path);
        if (node) await expandDir(node);
      }
      const parentPathStr = parentEntry.isDir ? parentEntry.path : parentPath(parentEntry.path);
      setPendingCreate({ parentPath: parentPathStr, kind });
    },
    [expandDir],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (value: string) => {
      const create = pendingCreate;
      if (!create) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      try {
        if (create.kind === "file") {
          await window.spark.fs.createFile({ parentPath: create.parentPath, name: trimmed });
        } else {
          await window.spark.fs.createFolder({ parentPath: create.parentPath, name: trimmed });
        }
        await refreshDir(create.parentPath);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingCreate(null);
      }
    },
    [pendingCreate, refreshDir],
  );

  // Delete ----------------------------------------------------------------
  const deleteEntries = useCallback(
    async (entries: FsEntry[]) => {
      const uniqueEntries = Array.from(
        new Map(entries.map((entry) => [entry.path, entry])).values(),
      );
      const deletedPaths: string[] = [];
      const parentPaths = new Set(uniqueEntries.map((entry) => parentPath(entry.path)));
      setContextMenu(null);
      try {
        for (const entry of uniqueEntries) {
          await window.spark.fs.deleteFile(entry.path);
          deletedPaths.push(entry.path);
          onDeleteFile?.(entry.path);
        }
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        await Promise.allSettled(Array.from(parentPaths).map((path) => refreshDir(path)));
        if (deletedPaths.length > 0) {
          setSelectedFilePaths((prev) => {
            const next = new Set(prev);
            for (const path of deletedPaths) next.delete(path);
            return next;
          });
          setSelectionAnchorPath((anchor) =>
            anchor && deletedPaths.includes(anchor) ? null : anchor,
          );
        }
      }
    },
    [onDeleteFile, refreshDir],
  );

  // Stable per-row handlers --------------------------------------------------
  // Every visible node renders one `<Row>`. `Row` is wrapped in `React.memo`,
  // but memo only pays off if its props are referentially stable across
  // renders. Previously each `Row` received fresh inline arrows, so memo could
  // never skip a render and unrelated App state changes repainted the entire
  // tree. These `useCallback`s take the node / path as an argument instead, so
  // the function identities stay stable and `Row` invokes them with its node.
  const handleContextMenu = useCallback((entry: FsEntry, x: number, y: number) => {
    if (entry.isDir) {
      setSelectedFilePaths(new Set());
      setSelectionAnchorPath(null);
    } else if (!selectedFilePathsRef.current.has(entry.path)) {
      setSelectedFilePaths(new Set([entry.path]));
      setSelectionAnchorPath(entry.path);
    }
    setContextMenu({ entry, x, y });
  }, []);

  const handleCommitRename = useCallback(
    (path: string, value: string) => {
      void commitRename(path, value);
    },
    [commitRename],
  );

  const handleRowClick = useCallback(
    (node: Node, event: React.MouseEvent) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        event.preventDefault();
        return;
      }

      if (node.kind === "dir") {
        void toggleDir(node);
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
          setSelectedFilePaths(new Set());
          setSelectionAnchorPath(null);
        }
        return;
      }

      const path = node.entry.path;
      const toggleSelection = event.ctrlKey || event.metaKey;
      if (event.shiftKey) {
        const anchorPath = selectionAnchorPathRef.current ?? path;
        const range = fileRange(flatRef.current, anchorPath, path);
        setSelectedFilePaths((prev) => {
          const next = toggleSelection ? new Set(prev) : new Set<string>();
          for (const selectedPath of range) next.add(selectedPath);
          return next;
        });
        if (!selectionAnchorPathRef.current) setSelectionAnchorPath(path);
        return;
      }

      if (toggleSelection) {
        setSelectedFilePaths((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        setSelectionAnchorPath(path);
        return;
      }

      setSelectedFilePaths(new Set([path]));
      setSelectionAnchorPath(path);
      onOpenFile(node.entry);
    },
    [onOpenFile, toggleDir],
  );

  const handleListMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || renamingPath) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("button, input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      setContextMenu(null);
      marqueeSelectionRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        additive: event.ctrlKey || event.metaKey,
        baseSelection: new Set(selectedFilePathsRef.current),
        active: false,
      };
      window.removeEventListener("mousemove", updateMarqueeSelection);
      window.removeEventListener("mouseup", finishMarqueeSelection);
      window.addEventListener("mousemove", updateMarqueeSelection);
      window.addEventListener("mouseup", finishMarqueeSelection, { once: true });
    },
    [finishMarqueeSelection, renamingPath, updateMarqueeSelection],
  );

  // Re-flatten on every render. We mutate root.children in place and bump
  // `force()` to re-render — memoising would cache a stale row list because
  // the `root` reference doesn't change across mutations. The traversal is
  // a single linear walk over the open subtree, so the cost is negligible.
  const flat: FlatRow[] = (() => {
    // Skip the root node row itself — its name is already shown in the
    // SectionHeader's `meta` slot, so rendering it again would duplicate
    // the workspace folder name. We still flatten its children at depth 0.
    const root = rootRef.current;
    const rows: FlatRow[] = [];
    if (root.open) {
      for (const child of root.children) {
        rows.push(...flatten(child, 0));
      }
    }
    if (pendingCreate) {
      const insertIdx = rows.findIndex(
        (r) => r.kind === "node" && r.node.entry.path === pendingCreate.parentPath,
      );
      if (insertIdx !== -1) {
        const parentDepth = rows[insertIdx].depth;
        rows.splice(insertIdx + 1, 0, {
          kind: "placeholder",
          depth: parentDepth + 1,
          parentPath: pendingCreate.parentPath,
          entryKind: pendingCreate.kind,
        });
      } else if (pendingCreate.parentPath === root.entry.path) {
        rows.unshift({
          kind: "placeholder",
          depth: 0,
          parentPath: pendingCreate.parentPath,
          entryKind: pendingCreate.kind,
        });
      }
    }
    return rows;
  })();
  flatRef.current = flat;
  const selectedFileEntries = fileEntriesForPaths(flat, selectedFilePaths);
  const contextMenuEntries =
    contextMenu && !contextMenu.entry.isDir && selectedFilePaths.has(contextMenu.entry.path)
      ? selectedFileEntries.length > 0
        ? selectedFileEntries
        : [contextMenu.entry]
      : contextMenu
        ? [contextMenu.entry]
        : [];

  // Workspace-level actions
  const newFileAtRoot = useCallback(async () => {
    setRenamingPath(null);
    setSelectedFilePaths(new Set());
    setSelectionAnchorPath(null);
    setPendingCreate({ parentPath: cwd, kind: "file" });
  }, [cwd]);
  const newFolderAtRoot = useCallback(async () => {
    setRenamingPath(null);
    setSelectedFilePaths(new Set());
    setSelectionAnchorPath(null);
    setPendingCreate({ parentPath: cwd, kind: "dir" });
  }, [cwd]);
  const refreshWorkspace = useCallback(async () => {
    await refreshDir(cwd);
  }, [cwd, refreshDir]);

  // Handle F2 (rename) when a single file is selected, otherwise the active entry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const selectedPath =
        selectedFilePaths.size === 1 ? Array.from(selectedFilePaths)[0] : null;
      const renamePath = selectedPath ?? activePath;
      if (!renamePath) return;
      const entry = findEntry(rootRef.current, renamePath);
      if (entry) {
        e.preventDefault();
        beginRename(entry.entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePath, beginRename, selectedFilePaths]);

  // Keep the active node scrolled into view. With the list virtualized the
  // active row may not be mounted at all (it scrolled off, or was opened from
  // search), so we drive Virtuoso's imperative API. `scrollIntoView` is a no-op
  // when the row is already on screen, so this stays cheap.
  useEffect(() => {
    if (!activePath) return;
    const index = flat.findIndex(
      (r) => r.kind === "node" && r.node.entry.path === activePath,
    );
    if (index === -1) return;
    virtuosoRef.current?.scrollIntoView({ index, behavior: "auto" });
    // `flat` is rebuilt every render; depending on `activePath` alone keeps
    // this from firing on unrelated re-renders while still re-running when
    // the selection changes (the only time we want to scroll).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
      }}
    >
      <SectionHeader
        label="Explorer"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        {...headerDrag}
        meta={
          <span
            title={
              selectedFileEntries.length > 1
                ? `${selectedFileEntries.length} files selected`
                : cwd
            }
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: selectedFileEntries.length > 1 ? "var(--accent)" : "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 132,
            }}
          >
            {selectedFileEntries.length > 1
              ? `${selectedFileEntries.length} selected`
              : basename(cwd)}
          </span>
        }
        actions={
          <>
            <HeaderIconButton title="New file" onClick={() => void newFileAtRoot()}>
              <NewFileIcon />
            </HeaderIconButton>
            <HeaderIconButton title="New folder" onClick={() => void newFolderAtRoot()}>
              <NewFolderIcon />
            </HeaderIconButton>
            <HeaderIconButton
              title="Refresh Explorer"
              onClick={async () => {
                try {
                  await refreshWorkspace();
                  setError(null);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <RefreshIcon />
            </HeaderIconButton>
            <HeaderIconButton
              title="Reveal in File Explorer"
              onClick={async () => {
                try {
                  await window.spark.fs.revealInOS(cwd);
                  setError(null);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <RevealIcon />
            </HeaderIconButton>
          </>
        }
      />
      {!collapsed && (
        <>
      {error && (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: "6px 16px",
            margin: "4px 8px",
            borderRadius: 6,
            background: "var(--danger-soft)",
            boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--danger) 32%, transparent)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--danger)",
            }}
          >
            Error
          </span>
          <span style={{ color: "var(--danger)", fontSize: 11, wordBreak: "break-word" }}>
            {error}
          </span>
        </div>
      )}
      {/*
        The visible-row list is virtualized with `react-virtuoso` (same
        pattern as SearchPanel.tsx), so only on-screen rows mount. Rows have
        a fixed `ROW_HEIGHT`, so Virtuoso sizes the scroller without
        measuring every item. `itemContent` closes over the freshly-rebuilt
        `flat` array each render, so in-place tree mutations (expand /
        collapse / fs-watch refresh) surface immediately. The per-row props
        passed to `Row` are all referentially stable, so `Row`'s
        `React.memo` skips re-rendering rows whose own data did not change.
      */}
      <div
        ref={listViewportRef}
        onMouseDown={handleListMouseDown}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          userSelect: selectionRect ? "none" : undefined,
        }}
      >
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: "100%", width: "100%" }}
          totalCount={flat.length}
          overscan={400}
          // Preserve the original 2px top / 8px bottom breathing room the
          // plain scroll container had via padding.
          components={LIST_COMPONENTS}
          itemContent={(i) => {
            const row = flat[i];
            if (!row) return null;
            if (row.kind === "placeholder") {
              return (
                <PlaceholderRow
                  depth={row.depth}
                  kind={row.entryKind}
                  onCommit={commitCreate}
                  onCancel={cancelCreate}
                />
              );
            }
            const dirNode = row.node.kind === "dir" ? row.node : null;
            return (
              <Row
                node={row.node}
                depth={row.depth}
                active={row.node.entry.path === activePath}
                selected={!row.node.entry.isDir && selectedFilePaths.has(row.node.entry.path)}
                dirOpen={Boolean(dirNode?.open)}
                dirLoading={Boolean(dirNode?.loading)}
                dirLoaded={Boolean(dirNode?.loaded)}
                dirError={dirNode?.error}
                renaming={renamingPath === row.node.entry.path}
                onRowClick={handleRowClick}
                onRowElement={updateRowElement}
                onContextMenu={handleContextMenu}
                onCommitRename={handleCommitRename}
                onCancelRename={cancelRename}
              />
            );
          }}
        />
        {flat.length === 0 && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 20px",
              pointerEvents: "none",
              textAlign: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--muted)",
              }}
            >
              {root.loaded ? "Empty folder" : "Loading…"}
            </span>
            {root.loaded && (
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  color: "var(--muted-2)",
                  lineHeight: 1.4,
                }}
              >
                Create a file or folder to get started.
              </span>
            )}
          </div>
        )}
        {selectionRect && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              zIndex: 20,
              left: selectionRect.left,
              top: selectionRect.top,
              width: selectionRect.width,
              height: selectionRect.height,
              border: "1px solid var(--accent-edge)",
              borderRadius: 3,
              background: "color-mix(in oklch, var(--accent) 11%, transparent)",
              boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--accent) 18%, transparent)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
        </>
      )}
      {contextMenu && (
        <FileMenu
          menu={contextMenu}
          entries={contextMenuEntries}
          runPlan={
            onRunPlan && contextMenuEntries.length === 1 && isRunnablePlan(contextMenu.entry)
              ? {
                  engines,
                  onPick: (backend) => {
                    const entry = contextMenu.entry;
                    setContextMenu(null);
                    onRunPlan(entry, backend);
                  },
                }
              : null
          }
          onOpen={
            contextMenuEntries.some((entry) => entry.isDir)
              ? null
              : () => {
                  setContextMenu(null);
                  const preview = contextMenuEntries.length === 1;
                  for (const entry of contextMenuEntries) onOpenFile(entry, { preview });
                }
          }
          openLabel={
            contextMenuEntries.length > 1
              ? `Open ${contextMenuEntries.length} files`
              : "Open"
          }
          onNewFile={() => {
            const entry = contextMenu.entry;
            setContextMenu(null);
            void beginCreate(entry, "file");
          }}
          onNewFolder={() => {
            const entry = contextMenu.entry;
            setContextMenu(null);
            void beginCreate(entry, "dir");
          }}
          onRename={
            contextMenuEntries.length === 1 ? () => beginRename(contextMenu.entry) : null
          }
          onReveal={
            contextMenuEntries.length === 1
              ? async () => {
                  const entry = contextMenu.entry;
                  const path = entry.path;
                  setContextMenu(null);
                  try {
                    if (isPreviewFile(entry)) {
                      await window.spark.openExternal(filePathToBrowserUrl(path));
                    } else {
                      await window.spark.fs.revealInOS(path);
                    }
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }
              : null
          }
          revealLabel={isPreviewFile(contextMenu.entry) ? "Open in Preview" : "Reveal in OS"}
          onDelete={() => void deleteEntries(contextMenuEntries)}
          deleteLabel={
            contextMenuEntries.length > 1
              ? `Delete ${contextMenuEntries.length} files`
              : "Delete"
          }
        />
      )}
    </div>
  );
}

type FlatRow =
  | { kind: "node"; node: Node; depth: number }
  | { kind: "placeholder"; depth: number; parentPath: string; entryKind: "file" | "dir" };

function flatten(node: Node, depth: number): FlatRow[] {
  const out: FlatRow[] = [{ kind: "node", node, depth }];
  if (node.kind === "dir" && node.open) {
    for (const child of node.children) {
      out.push(...flatten(child, depth + 1));
    }
  }
  return out;
}

function visibleFileRows(rows: FlatRow[]): Array<{ path: string; entry: FsEntry }> {
  return rows.flatMap((row) =>
    row.kind === "node" && row.node.kind === "file"
      ? [{ path: row.node.entry.path, entry: row.node.entry }]
      : [],
  );
}

function fileRange(rows: FlatRow[], anchorPath: string, targetPath: string): string[] {
  const paths = visibleFileRows(rows).map((row) => row.path);
  const anchorIndex = paths.indexOf(anchorPath);
  const targetIndex = paths.indexOf(targetPath);
  if (anchorIndex === -1 || targetIndex === -1) return [targetPath];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return paths.slice(start, end + 1);
}

function fileEntriesForPaths(rows: FlatRow[], paths: Set<string>): FsEntry[] {
  if (paths.size === 0) return [];
  return visibleFileRows(rows)
    .filter((row) => paths.has(row.path))
    .map((row) => row.entry);
}

function rectFromPoints(x1: number, y1: number, x2: number, y2: number): SelectionRect {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    left,
    top,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function rectRelativeToViewport(rect: SelectionRect, viewport: DOMRect): SelectionRect {
  const left = Math.max(0, rect.left - viewport.left);
  const top = Math.max(0, rect.top - viewport.top);
  const right = Math.min(viewport.width, rect.left + rect.width - viewport.left);
  const bottom = Math.min(viewport.height, rect.top + rect.height - viewport.top);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function rectsIntersect(a: SelectionRect, b: DOMRect): boolean {
  const aRight = a.left + a.width;
  const aBottom = a.top + a.height;
  return a.left <= b.right && aRight >= b.left && a.top <= b.bottom && aBottom >= b.top;
}

function makeDir(entry: FsEntry, open = false): DirNode & { kind: "dir" } {
  return {
    kind: "dir",
    entry,
    open,
    loaded: false,
    loading: false,
    children: [],
  };
}

function findDir(node: Node, path: string): (DirNode & { kind: "dir" }) | null {
  if (node.kind !== "dir") return null;
  if (node.entry.path === path) return node;
  for (const child of node.children) {
    const found = findDir(child, path);
    if (found) return found;
  }
  return null;
}

function findEntry(node: Node, path: string): Node | null {
  if (node.entry.path === path) return node;
  if (node.kind !== "dir") return null;
  for (const child of node.children) {
    const found = findEntry(child, path);
    if (found) return found;
  }
  return null;
}

async function loadDir(path: string): Promise<Node[]> {
  const entries = await window.spark.fs.list(path);
  return entries.map((e): Node =>
    e.isDir ? makeDir(e, false) : { kind: "file", entry: e },
  );
}

// Re-list a directory while preserving DirNode identity (and thus `open` /
// `loaded` / `children` state) for children that still exist.
async function reloadDirInPlace(dir: DirNode & { kind: "dir" }): Promise<void> {
  const entries = await window.spark.fs.list(dir.entry.path);
  const oldByPath = new Map<string, Node>();
  for (const child of dir.children) oldByPath.set(child.entry.path, child);
  dir.children = entries.map((e): Node => {
    if (e.isDir) {
      const old = oldByPath.get(e.path);
      if (old?.kind === "dir") return old;
      return makeDir(e, false);
    }
    return { kind: "file", entry: e };
  });
  dir.loaded = true;
  dir.error = undefined;
}

function collectMatchingDirs(
  node: Node,
  matches: Set<string>,
  out: (DirNode & { kind: "dir" })[],
): void {
  if (node.kind !== "dir") return;
  if (node.loaded && matches.has(normalizePath(node.entry.path))) out.push(node);
  for (const child of node.children) collectMatchingDirs(child, matches, out);
}

// `React.memo`: at most one placeholder row exists at a time, but memoising
// keeps it from re-rendering (and re-mounting its self-focusing `InlineInput`)
// when an unrelated tree re-render flows through Virtuoso's `itemContent`.
const PlaceholderRow = React.memo(function PlaceholderRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const rowPaddingLeft = BASE_LEFT + depth * INDENT_STEP;
  return (
    <div
      style={{
        ...ROW_STYLE_BASE,
        padding: `0 8px 0 ${rowPaddingLeft}px`,
      }}
    >
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            ...INDENT_GUIDE_STYLE,
            left: BASE_LEFT + i * INDENT_STEP + 4,
          }}
        />
      ))}
      <span aria-hidden style={CHEVRON_CELL_STYLE} />
      <FileNodeIcon name={kind === "dir" ? "" : "untitled"} isDir={kind === "dir"} opacity={0.7} />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
});

// Props for a single tree row. Declared as a named type so the custom
// `React.memo` comparator below can be typed against it.
interface RowProps {
  node: Node;
  depth: number;
  active: boolean;
  selected: boolean;
  dirOpen: boolean;
  dirLoading: boolean;
  dirLoaded: boolean;
  dirError?: string;
  renaming: boolean;
  onRowClick: (node: Node, event: React.MouseEvent) => void;
  onRowElement: (path: string, element: HTMLDivElement | null) => void;
  onContextMenu: (entry: FsEntry, x: number, y: number) => void;
  onCommitRename: (path: string, value: string) => void;
  onCancelRename: () => void;
}

// Custom equality for `Row`'s `React.memo`.
//
// A plain shallow compare is NOT enough here: the tree mutates `DirNode`
// objects in place and only bumps a `force()` counter to re-render. The scalar
// directory props below snapshot the mutable fields so expand / load state
// changes still pierce memoization. Everything else is referentially stable by
// construction.
function rowPropsEqual(prev: RowProps, next: RowProps): boolean {
  return !(
    prev.node !== next.node ||
    prev.depth !== next.depth ||
    prev.active !== next.active ||
    prev.selected !== next.selected ||
    prev.dirOpen !== next.dirOpen ||
    prev.dirLoading !== next.dirLoading ||
    prev.dirLoaded !== next.dirLoaded ||
    prev.dirError !== next.dirError ||
    prev.renaming !== next.renaming ||
    prev.onRowClick !== next.onRowClick ||
    prev.onRowElement !== next.onRowElement ||
    prev.onContextMenu !== next.onContextMenu ||
    prev.onCommitRename !== next.onCommitRename ||
    prev.onCancelRename !== next.onCancelRename
  );
}

// `React.memo`: the tree renders one `Row` per visible node, so without
// memoisation any App-level state change that re-renders the sidebar
// (workspace color edit, run events) re-rendered every row. The callback
// props below all take the node / path as an argument and are created with
// `useCallback` in the parent, so their identities are stable and memo can
// actually skip rows whose own `node` / `active` / `renaming` did not change.
const Row = React.memo(function Row({
  node,
  depth,
  active,
  selected,
  dirOpen,
  dirLoading,
  renaming,
  onRowClick,
  onRowElement,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: RowProps) {
  const isDir = node.kind === "dir";
  const [hover, setHover] = useState(false);
  const rowPaddingLeft = BASE_LEFT + depth * INDENT_STEP;
  const background = selected
    ? active
      ? "color-mix(in oklch, var(--accent) 18%, transparent)"
      : "color-mix(in oklch, var(--accent) 12%, transparent)"
    : active
      ? "color-mix(in oklch, var(--ink) 9%, transparent)"
      : hover
        ? "color-mix(in oklch, var(--ink) 4%, transparent)"
        : "transparent";
  const rowShadow = selected
    ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 38%, transparent)"
    : active
      ? "inset 0 0 0 1px color-mix(in oklch, var(--ink) 10%, transparent)"
      : "none";

  // Stable wrappers so this row invokes the shared parent handlers with its
  // own node / path. These close over `node`, so they change only when this
  // row's own data changes, which is also the only time `React.memo` lets the
  // row re-render.
  const handleClick = renaming ? undefined : (event: React.MouseEvent) => onRowClick(node, event);
  const handleMouseEnter = () => setHover(true);
  const handleRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!isDir) onRowElement(node.entry.path, element);
    },
    [isDir, node.entry.path, onRowElement],
  );
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(node.entry, e.clientX, e.clientY);
  };
  const handleCommitRename = (value: string) => onCommitRename(node.entry.path, value);

  return (
    <div
      ref={handleRowRef}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setHover(false)}
      aria-selected={selected || active}
      style={{
        ...ROW_STYLE_BASE,
        padding: `0 8px 0 ${rowPaddingLeft}px`,
        background,
        color: selected || active ? "var(--ink)" : "var(--ink-dim)",
        boxShadow: rowShadow,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            ...INDENT_GUIDE_STYLE,
            left: BASE_LEFT + i * INDENT_STEP + 4,
          }}
        />
      ))}

      <span aria-hidden style={CHEVRON_CELL_STYLE}>
        {isDir && <ChevronIcon open={dirOpen} />}
      </span>

      <FileNodeIcon name={node.entry.name} isDir={isDir} isOpen={dirOpen} />

      {renaming ? (
        <InlineInput
          initial={node.entry.name}
          onCommit={handleCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span
          style={{
            ...ROW_LABEL_STYLE,
            color: selected || active ? "var(--ink)" : "var(--ink-dim)",
          }}
          title={node.entry.path}
        >
          {node.entry.name}
        </span>
      )}
      {isDir && dirLoading && <span style={ROW_LOADING_STYLE}>…</span>}
    </div>
  );
}, rowPropsEqual);

function FileMenu({
  menu,
  entries,
  runPlan,
  onOpen,
  openLabel,
  onNewFile,
  onNewFolder,
  onRename,
  onReveal,
  revealLabel,
  onDelete,
  deleteLabel,
}: {
  menu: FileContextMenu;
  entries: FsEntry[];
  runPlan: { engines: EngineOption[]; onPick: (backend?: ChatBackendKind) => void } | null;
  onOpen: (() => void) | null;
  openLabel: string;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: (() => void) | null;
  onReveal: (() => void) | null;
  revealLabel: string;
  onDelete: () => void;
  deleteLabel: string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const x = Math.min(menu.x, window.innerWidth - 236);
  const y = Math.min(menu.y, window.innerHeight - 280);
  // The Run plan engine flyout opens to the right by default, flipping left
  // when the menu sits too close to the viewport's right edge to fit it.
  const engineFlyoutOpensLeft = Math.max(8, x) + 228 + ENGINE_FLYOUT_WIDTH > window.innerWidth - 8;
  const multiple = entries.length > 1;
  const headerTitle = multiple ? `${entries.length} files selected` : menu.entry.name;
  const headerMeta = multiple
    ? "multiple selection"
    : menu.entry.isDir
      ? "folder"
      : menu.entry.ext
        ? `${menu.entry.ext.toUpperCase()} file`
        : "file";

  // Reset confirm state if user mouse-leaves the menu briefly.
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => {
        if (confirmDelete) setTimeout(() => setConfirmDelete(false), 1500);
      }}
      style={{
        position: "fixed",
        zIndex: 100,
        left: Math.max(8, x),
        top: Math.max(8, y),
        width: 228,
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        boxShadow: "var(--shadow-2)",
        padding: 6,
        // No `overflow: hidden` here — the Run plan engine flyout is an
        // absolutely-positioned child that extends past this menu's edge.
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "22px minmax(0, 1fr)",
          gap: 8,
          alignItems: "center",
          padding: "8px 8px 10px",
          borderBottom: "1px solid var(--rule)",
          marginBottom: 4,
        }}
      >
        <FileNodeIcon
          name={multiple ? "" : menu.entry.name}
          isDir={!multiple && menu.entry.isDir}
        />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            title={headerTitle}
            style={{
              color: "var(--ink)",
              fontSize: 11,
              fontWeight: 800,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {headerTitle}
          </span>
          <span style={{ color: "var(--muted)", fontSize: 9 }}>
            {headerMeta}
          </span>
        </div>
      </div>
      {runPlan && (
        <>
          <RunPlanMenuItem
            engines={runPlan.engines}
            onPick={runPlan.onPick}
            openLeft={engineFlyoutOpensLeft}
          />
          <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
        </>
      )}
      {onOpen && (
        <MenuButton icon="O" onClick={onOpen} hint={multiple ? undefined : "Enter"}>
          {openLabel}
        </MenuButton>
      )}
      <MenuButton icon="N" onClick={onNewFile}>New File</MenuButton>
      <MenuButton icon="F" onClick={onNewFolder}>New Folder</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      {onRename && <MenuButton icon="R" onClick={onRename}>Rename</MenuButton>}
      {onReveal && <MenuButton icon="V" onClick={onReveal}>{revealLabel}</MenuButton>}
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      <MenuButton
        icon="D"
        danger
        onClick={() => {
          if (confirmDelete) onDelete();
          else setConfirmDelete(true);
        }}
      >
        {confirmDelete ? "Click again to confirm" : deleteLabel}
      </MenuButton>
    </div>
  );
}

// The "Run plan" entry. With one engine (just API) it's a plain accent
// MenuButton that runs it. With Claude / Codex installed they LEAD the list
// and clicking the row itself runs the first (recommended) engine — the
// demoted API manager only runs when picked explicitly from the flyout.
function RunPlanMenuItem({
  engines,
  onPick,
  openLeft,
}: {
  engines: EngineOption[];
  onPick: (backend?: ChatBackendKind) => void;
  openLeft: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (engines.length <= 1) {
    return (
      <MenuButton icon="▶" accent onClick={() => onPick(undefined)}>
        Run plan
      </MenuButton>
    );
  }

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => onPick(engines[0]?.backend)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          appearance: "none",
          width: "100%",
          border: "none",
          background: hovered || open ? "var(--panel)" : "transparent",
          color: "var(--accent)",
          borderRadius: 6,
          padding: "7px 8px",
          textAlign: "left",
          fontFamily: "inherit",
          fontSize: 11,
          fontWeight: 700,
          cursor: "default",
          display: "grid",
          gridTemplateColumns: "22px minmax(0, 1fr) auto",
          alignItems: "center",
          gap: 8,
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 999,
            color: "var(--accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            fontWeight: 900,
          }}
        >
          ▶
        </span>
        <span>Run plan</span>
        <span style={{ color: "var(--muted)", fontSize: 10, fontWeight: 900 }}>▸</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: -6,
            [openLeft ? "right" : "left"]: "100%",
            width: ENGINE_FLYOUT_WIDTH,
            background: "var(--panel-2)",
            border: "1px solid var(--rule-strong)",
            borderRadius: 8,
            boxShadow: "var(--shadow-2)",
            padding: 6,
            zIndex: 1,
          }}
        >
          {engines.map((engine, index) => (
            <MenuButton
              key={engine.key}
              icon={engine.glyph}
              // The CLI agents lead; the first row is the recommended pick.
              accent={index === 0}
              onClick={() => onPick(engine.backend)}
            >
              {engine.label}
            </MenuButton>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuButton({
  children,
  icon,
  hint,
  danger,
  accent,
  onClick,
}: {
  children: React.ReactNode;
  icon: string;
  hint?: string;
  danger?: boolean;
  accent?: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        background: hovered ? "var(--panel)" : "transparent",
        color: danger
          ? "var(--danger)"
          : accent
            ? "var(--accent)"
            : hovered
              ? "var(--ink)"
              : "var(--ink-dim)",
        borderRadius: 6,
        padding: "7px 8px",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: 700,
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 8,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        style={{
          width: 18,
          height: 18,
          border: "1px solid transparent",
          borderRadius: 999,
          color: danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          fontWeight: 900,
        }}
      >
        {icon}
      </span>
      <span>{children}</span>
      {hint && <span style={{ color: "var(--muted)", fontSize: 9 }}>{hint}</span>}
    </button>
  );
}

function parentPath(path: string): string {
  return dirname(path);
}

function HeaderIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        appearance: "none",
        width: 20,
        height: 20,
        border: "none",
        borderRadius: 3,
        background: hover ? "var(--hover)" : "transparent",
        color: hover ? "var(--ink)" : "var(--ink-dim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function NewFileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 1.5 H8 L11 4.5 V12.5 H3 Z" stroke="currentColor" strokeWidth="1" />
      <path d="M8 1.5 V4.5 H11" stroke="currentColor" strokeWidth="1" />
      <path d="M7 7 V11 M5 9 H9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 4 H5.5 L7 5.5 H13 V12 H1 Z" stroke="currentColor" strokeWidth="1" />
      <path d="M7 7.5 V10.5 M5.5 9 H8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function RevealIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 4 H5 L6.5 5.5 H12 V11 H2 Z" stroke="currentColor" strokeWidth="1" fill="none" />
      <path
        d="M8.5 7.5 L11 7.5 L11 10 M11 7.5 L7.5 11"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M11.5 5.25 A4.25 4.25 0 0 0 3.55 3.2 L2.25 4.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 8.75 A4.25 4.25 0 0 0 10.45 10.8 L11.75 9.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.25 2.25 V4.5 H4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M11.75 11.75 V9.5 H9.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
