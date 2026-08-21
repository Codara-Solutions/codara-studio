import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChatBackendKind, FsEntry, GitFileStatus, GitStatus } from "@shared/types";
import { statusColor, statusGlyph } from "./git/git-ui";
import { type EngineOption, useEngineOptions } from "./engine/engineOptions";
import { ChevronIcon } from "./icons";
import FileNodeIcon from "./file-icons/LazyFileNodeIcon";
import { InlineInput } from "./file-icons/InlineInput";
import { basename, dirname } from "../path-utils";
import { pathToFileUrl } from "../lib/pathToFileUrl";
import { isRemotePath } from "@shared/remote";
import {
  getExplorerClipboard,
  isSameFileSet,
  setExplorerClipboard,
  subscribeExplorerClipboard,
} from "../lib/explorerClipboard";
import SectionHeader, { type SectionHeaderDragProps } from "../panels/SectionHeader";

// Tree row geometry. Hoisted to module scope so the values are shared by
// `Row` and `PlaceholderRow` and never re-allocated per render.
const INDENT_STEP = 8;
const BASE_LEFT = 6;
const ROW_HEIGHT = 22;
// Small and medium trees are cheaper and more reliable as plain DOM: they
// avoid a ResizeObserver/compositor turn entirely, which matters when an
// Electron window is occluded during a workspace switch. Large expanded
// trees still use Virtuoso so genuinely huge repositories stay bounded.
const DIRECT_TREE_RENDER_LIMIT = 240;

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

// Platform-appropriate name for "show this in the OS file manager".
const REVEAL_IN_OS_LABEL = navigator.platform.startsWith("Mac")
  ? "Reveal in Finder"
  : navigator.platform.startsWith("Win")
    ? "Reveal in File Explorer"
    : "Reveal in File Manager";

// Undo history for Explorer deletes. Deletes move entries into a main-process
// stash (not the OS trash) so Ctrl+Z can restore them; a batch evicted off the
// end of this stack has its stash payload moved on to the real OS trash.
// Module-level so the history survives the FileTree remount on workspace
// switch; batches remember their workspace so restores land correctly even
// when undone from another workspace's tree.
interface DeleteUndoBatch {
  cwd: string;
  items: Array<{ token: string; originalPath: string }>;
}
const deleteUndoStack: DeleteUndoBatch[] = [];
const DELETE_UNDO_LIMIT = 20;

// File extensions Codara can run as a plan via the explorer's right-click
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

// file:// URL building lives in lib/pathToFileUrl.ts — one shared
// implementation for the browser preview, the previewers, and this menu.
const filePathToBrowserUrl = pathToFileUrl;

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

// Switching workspaces remounts FileTree to reset Virtuoso's DOM/scroll state,
// but rebuilding the entire expanded tree made larger projects visibly lag
// behind the workspace click. Retain a small LRU of the in-memory tree models:
// returning to a recent workspace paints its files immediately, then the normal
// async reload/watch path reconciles the snapshot with disk.
const FILE_TREE_CACHE_LIMIT = 12;
const fileTreeCache = new Map<string, DirNode & { kind: "dir" }>();
const expandedPathsByWorkspace = new Map<string, Set<string>>();

function restoreExpandedPaths(cwd: string, node: Node): void {
  if (node.kind !== "dir") return;
  if (node.entry.path !== cwd) {
    node.open = expandedPathsByWorkspace.get(cwd)?.has(node.entry.path) ?? node.open;
  }
  for (const child of node.children) restoreExpandedPaths(cwd, child);
}

function rememberExpandedPath(cwd: string, path: string, expanded: boolean): void {
  let paths = expandedPathsByWorkspace.get(cwd);
  if (!paths) {
    paths = new Set<string>();
    expandedPathsByWorkspace.set(cwd, paths);
  }
  if (expanded) paths.add(path);
  else paths.delete(path);
}

function cachedFileTree(cwd: string): (DirNode & { kind: "dir" }) | null {
  const cached = fileTreeCache.get(cwd);
  if (!cached) return null;
  fileTreeCache.delete(cwd);
  fileTreeCache.set(cwd, cached);
  restoreExpandedPaths(cwd, cached);
  return cached;
}

function rememberFileTree(cwd: string, root: DirNode & { kind: "dir" }): void {
  fileTreeCache.delete(cwd);
  fileTreeCache.set(cwd, root);
  while (fileTreeCache.size > FILE_TREE_CACHE_LIMIT) {
    const oldest = fileTreeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    fileTreeCache.delete(oldest);
    expandedPathsByWorkspace.delete(oldest);
  }
}

interface Props {
  cwd: string;
  activePath?: string | null;
  onOpenFile: (entry: FsEntry, options?: { preview?: boolean }) => void;
  onDeleteFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, entry: FsEntry) => void;
  // Right-click a .md/.html file to hand it to the orchestrator as a plan.
  // `backend` is the engine chosen from the Run plan flyout; Pi is the default
  // and Claude/Codex/API remain explicit alternatives.
  onRunPlan?: (entry: FsEntry, backend?: ChatBackendKind) => void;
  // Shared git status (App-owned poll) — drives VS Code-style changed-file
  // decorations: colored filename + trailing status glyph on leaf rows.
  gitStatus?: GitStatus | null;
  // "Open Changes" context-menu action for a git-changed file.
  onOpenChanges?: (absolutePath: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  headerDrag?: SectionHeaderDragProps;
  // "primary" (default) renders the workspace tree with the Explorer section
  // header. "external" renders an extra attached folder: no header, and the
  // folder itself appears as an expandable root row so it stays identifiable.
  variant?: "primary" | "external";
  // Primary variant only: header button that attaches an external folder to
  // the active workspace.
  onAddExternalFolder?: () => void;
  // External variant only: detach this folder from the workspace (reference
  // removal — never deletes anything on disk).
  onRemoveExternalFolder?: () => void;
  // External variant only: user-chosen height in px (dragged via the rail's
  // ResizeHandle). Overrides the content-based auto height when set.
  heightPx?: number | null;
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
  gitStatus,
  onOpenChanges,
  collapsed,
  onToggleCollapse,
  headerDrag,
  variant = "primary",
  onAddExternalFolder,
  onRemoveExternalFolder,
  heightPx,
}: Props) {
  const [root, setRoot] = useState<DirNode & { kind: "dir" }>(() => {
    const cached = cachedFileTree(cwd);
    if (cached) return cached;
    const initial = makeDir({ name: basename(cwd), path: cwd, isDir: true }, true);
    rememberFileTree(cwd, initial);
    return initial;
  });
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  // Minimal right-click menu for blank Explorer space (no row under the
  // pointer): a single Paste action. Row right-clicks use `contextMenu`
  // (FileMenu) instead — the two are mutually exclusive.
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(() => new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  // The directory an in-flight external-file drag would copy into, or null when
  // no file drag is hovering the Explorer. Equal to `cwd` for a drop onto empty
  // space (highlights the whole list); a subfolder path highlights that row.
  const [externalDropDir, setExternalDropDir] = useState<string | null>(null);
  // A drag-drop that would MOVE one or more folders, parked while the user
  // confirms it (folder moves relocate whole subtrees, so they're easy to do
  // by accident mid-drag). Confirm runs the held transfer; cancel drops it.
  const [pendingMove, setPendingMove] = useState<{
    destDir: string;
    copySources: string[];
    moveSources: string[];
    folderNames: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  // Engines offered by the Run plan flyout (Codara always; Claude / Codex when
  // their CLI is installed). One entry (just Codara) → plain single action.
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
  // Paste destination anchor: the last row the user clicked or right-clicked.
  // Clicking a folder clears the file selection (so the selection can't carry
  // the destination), and a Finder→tree paste has no selection at all — this
  // ref preserves "paste into the folder I just clicked". A directory anchor
  // pastes INTO itself; a file anchor pastes into its parent. Nulled when the
  // press lands on blank space or the anchored row is moved/deleted.
  const pasteAnchorRef = useRef<{ path: string; isDir: boolean } | null>(null);
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
    } else if (marquee && !marquee.additive) {
      // A plain press on blank space that never became a drag: clear the
      // selection (Finder behavior). Additive (Ctrl/Cmd) presses keep it.
      setSelectedFilePaths((prev) => (prev.size > 0 ? new Set<string>() : prev));
      setSelectionAnchorPath(null);
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
    const next =
      cachedFileTree(cwd) ??
      makeDir(
        { name: basename(cwd), path: cwd, isDir: true },
        true,
      );
    rememberFileTree(cwd, next);
    setRoot(next);
    setContextMenu(null);
    setRenamingPath(null);
    setPendingCreate(null);
    setSelectedFilePaths(new Set());
    setSelectionAnchorPath(null);
    setSelectionRect(null);
    marqueeSelectionRef.current = null;
    rowElementsRef.current.clear();
    void (async () => {
      if (next.loaded) {
        // Paint the retained tree now; reconcile it in the background. The
        // watcher effect below performs another safe reconciliation once the
        // main-process watch root is armed, covering changes made while away.
        try {
          await reloadExpandedTreeInPlace(next);
          if (!cancelled) {
            restoreExpandedPaths(cwd, next);
            force((n) => n + 1);
          }
        } catch {
          // Keep the usable cached tree; the watcher/retry path can heal it.
        }
        return;
      }
      // A freshly-created workspace can race the main-process read sandbox:
      // this effect runs before App finishes registering `cwd` as an allowed
      // root, so the first `fs:list` may reject with "Path not allowed". Retry
      // with a short bounded backoff so the panel self-heals once the root
      // lands in the allowlist a tick later, instead of sitting at "Loading…".
      const children = await loadDirWithRetry(cwd, () => cancelled);
      if (cancelled || children === null) return;
      // The watcher-arm reconciliation can finish before this initial read.
      // Preserve any directory nodes it already installed (including a folder
      // the user expanded meanwhile) instead of replacing them with closed
      // nodes from the slower request.
      const currentDirs = new Map(
        next.children
          .filter((child): child is DirNode & { kind: "dir" } => child.kind === "dir")
          .map((child) => [child.entry.path, child]),
      );
      next.children = children.map((child) =>
        child.kind === "dir" ? currentDirs.get(child.entry.path) ?? child : child,
      );
      restoreExpandedPaths(cwd, next);
      next.loaded = true;
      next.loading = false;
      force((n) => n + 1);
    })();
    return () => {
      cancelled = true;
      rememberFileTree(cwd, next);
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
    rememberExpandedPath(cwd, node.entry.path, node.open);
    force((n) => n + 1);
  }, [cwd]);

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
    // Arm the watcher with the same bounded backoff as the initial list: a
    // freshly-created workspace can reach this effect before its root is in
    // the main-process sandbox allowlist, so `addWatchRoot` may reject with
    // "Path not allowed" — without a retry NO watcher would ever be installed
    // for that workspace. Once it resolves, do ONE reconciling reload of the
    // root: the first paint came from loadDir and the macOS FSEvents recursive
    // watcher has a warm-up window where early changes are missed, so this
    // makes the visible tree match on-disk state once watching is actually
    // live. Both steps bail if the cwd changed / the component unmounted.
    void (async () => {
      // `addWatchRoot` resolves to `undefined` on success; `callWithRetry`
      // returns `null` only when cancelled or every attempt failed, so test
      // against `null` (not falsiness) to detect a genuine failure.
      const armed = await callWithRetry(
        () => window.spark.fs.addWatchRoot(cwd),
        () => cancelled,
      );
      if (cancelled || armed === null) return;
      try {
        await reloadExpandedTreeInPlace(rootRef.current);
        if (!cancelled) {
          restoreExpandedPaths(cwd, rootRef.current);
          force((n) => n + 1);
        }
      } catch {
        // Non-fatal: the watcher is armed, so subsequent changes still refresh.
      }
    })();
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
        if (!cancelled) {
          restoreExpandedPaths(cwd, rootRef.current);
          force((n) => n + 1);
        }
      });
    });
    return () => {
      cancelled = true;
      unsub();
      // Remove only THIS tree's root: with external folders, several FileTree
      // instances watch different roots in the same window, so a blanket
      // "clear all watchers" here would kill the siblings' live refresh.
      void window.spark.fs.removeWatchRoot(cwd);
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

  useEffect(() => {
    if (!blankMenu) return;
    const close = () => setBlankMenu(null);
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
  }, [blankMenu]);

  // Rename ----------------------------------------------------------------
  const beginRename = useCallback((entry: FsEntry) => {
    setContextMenu(null);
    setPendingCreate(null);
    setSelectedFilePaths(new Set([entry.path]));
    setSelectionAnchorPath(entry.path);
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
          next.add(renamed.path);
          return next;
        });
        setSelectionAnchorPath((anchor) => (anchor === path ? renamed.path : anchor));
        // Repoint the paste anchor if it pointed at the renamed entry — a
        // renamed directory would otherwise resolve to a path that's gone.
        if (pasteAnchorRef.current?.path === path) {
          pasteAnchorRef.current = { path: renamed.path, isDir: renamed.isDir };
        }
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
      // De-dupe, then prune entries nested under a selected ancestor folder:
      // trashing the folder removes its children, so deleting a child
      // afterwards would fail on an already-gone path.
      const dedupedEntries = Array.from(
        new Map(entries.map((entry) => [entry.path, entry])).values(),
      );
      const keptPaths = new Set(pruneNestedPaths(dedupedEntries.map((entry) => entry.path)));
      const uniqueEntries = dedupedEntries.filter((entry) => keptPaths.has(entry.path));
      const deletedPaths: string[] = [];
      const parentPaths = new Set(uniqueEntries.map((entry) => parentPath(entry.path)));
      setContextMenu(null);
      // Local deletes go through the undoable stash (Ctrl+Z restores); remote
      // entries have no local stash and keep the direct delete.
      const stashed: DeleteUndoBatch["items"] = [];
      try {
        for (const entry of uniqueEntries) {
          if (isRemotePath(entry.path)) {
            await window.spark.fs.deleteFile(entry.path);
          } else {
            const s = await window.spark.fs.deleteToStash(entry.path);
            stashed.push({ token: s.token, originalPath: s.originalPath });
          }
          deletedPaths.push(entry.path);
          onDeleteFile?.(entry.path);
        }
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (stashed.length > 0) {
          deleteUndoStack.push({ cwd, items: stashed });
          while (deleteUndoStack.length > DELETE_UNDO_LIMIT) {
            const evicted = deleteUndoStack.shift();
            if (evicted) {
              // Off the undo horizon → the payload moves on to the OS trash.
              void window.spark.fs
                .purgeDeleteStash(evicted.items.map((i) => i.token))
                .catch(() => undefined);
            }
          }
        }
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
          // Drop the paste anchor if the row it pointed at was deleted.
          if (pasteAnchorRef.current && deletedPaths.includes(pasteAnchorRef.current.path)) {
            pasteAnchorRef.current = null;
          }
        }
      }
    },
    [cwd, onDeleteFile, refreshDir],
  );

  // Undo delete (Ctrl+Z) ---------------------------------------------------
  const undoLastDelete = useCallback(async () => {
    const batch = deleteUndoStack.pop();
    if (!batch) return;
    const restoredPaths: string[] = [];
    const parents = new Set<string>();
    for (const item of batch.items) {
      try {
        const entry = await window.spark.fs.undoDelete(item);
        restoredPaths.push(entry.path);
        parents.add(parentPath(entry.path));
      } catch (err) {
        setError((err as Error).message);
      }
    }
    // refreshDir is a no-op for parents outside this tree (a batch restored
    // into another workspace converges via that workspace's watcher instead).
    await Promise.allSettled(Array.from(parents).map((p) => refreshDir(p)));
    if (batch.cwd === cwd && restoredPaths.length > 0) {
      setSelectedFilePaths(new Set(restoredPaths));
      setSelectionAnchorPath(restoredPaths[0]);
    }
  }, [cwd, refreshDir]);

  // Ctrl/Cmd+Z restores the most recent Explorer delete. Registered by the
  // primary tree only (one per window) so external-folder trees never race it;
  // the shared stack still covers their deletes. Editors, terminals, inline
  // inputs, and the whiteboard keep their own undo — those targets are all
  // editable or covered by the board guard below.
  useEffect(() => {
    if (variant === "external") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (document.activeElement?.closest(".cora-board-editor")) return;
      if (deleteUndoStack.length === 0) return;
      e.preventDefault();
      void undoLastDelete();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, undoLastDelete]);

  // File drag-and-drop onto the Explorer -----------------------------------
  // A drop arrives as real OS File objects whether it came from Finder or from
  // an internal row drag (rows drag natively via webContents.startDrag), so the
  // two are indistinguishable by type. We decide MOVE vs COPY by provenance:
  // sources already inside the workspace root are MOVED; sources from outside
  // are COPIED via the unchanged import path. A single drop can mix both.
  //
  // Electron 32 removed `File.path`, so each File's real path comes from the
  // preload-exposed `getPathForFile`. After the drop we reveal the destination
  // (expand it if it's a subfolder) and refresh the destination plus every
  // moved source's old parent, so moved rows both appear at the destination and
  // vanish from where they came from.
  // Shared transfer core for drag-drop AND clipboard paste: copy `copySources`
  // into destDir (recursive, auto-suffixing collisions), move `moveSources`
  // there (throws on collision — surfaced via the error banner, nothing is
  // silently overwritten), then do the post-op bookkeeping: reveal the
  // destination, refresh affected dirs, repoint open editor tabs for moves,
  // and drop moved paths from the selection.
  const transferEntriesInto = useCallback(
    async (destDir: string, copySources: string[], moveSources: string[]) => {
      let movedEntries: FsEntry[] = [];
      let dropError: string | null = null;
      const insideSources = moveSources;
      try {
        if (copySources.length > 0) {
          await window.spark.fs.importEntries({ destDir, sourcePaths: copySources });
        }
        if (insideSources.length > 0) {
          movedEntries = await window.spark.fs.moveEntries({ destDir, sourcePaths: insideSources });
        }
      } catch (err) {
        dropError = (err as Error).message;
      }

      // Reveal a subfolder target so the newly-arrived entries are visible.
      if (destDir !== cwd) {
        const node = findDir(rootRef.current, destDir);
        if (node) await expandDir(node);
      }
      // Re-list the destination AND every moved source's old parent: a copy
      // only touches the destination, but a move empties the source dir too.
      const dirsToRefresh = new Set<string>([destDir]);
      for (const p of insideSources) dirsToRefresh.add(parentPath(p));
      await Promise.allSettled(Array.from(dirsToRefresh).map((d) => refreshDir(d)));

      // Reconcile app state for the entries that ACTUALLY moved (a no-op or
      // failed source is absent from the return). Match each old source path to
      // its new entry by basename — successfully-moved entries have unique names
      // within `destDir` (a name collision throws, so never two of the same).
      if (movedEntries.length > 0) {
        const movedByName = new Map(movedEntries.map((e) => [e.name, e]));
        const movedOldPaths: string[] = [];
        for (const src of insideSources) {
          const newEntry = movedByName.get(basename(src));
          if (!newEntry) continue;
          movedOldPaths.push(src);
          // A move is a rename in disguise: repoint any open editor tab at the
          // file's new location so a later save doesn't recreate it at the old
          // path (mirrors commitRename → onRenameFile; a no-op for unopened
          // files and directories).
          onRenameFile?.(src, newEntry);
        }
        // Moved paths no longer exist where they were — drop them from the
        // selection so no stale ghost row stays highlighted.
        if (movedOldPaths.length > 0) {
          const movedSet = new Set(movedOldPaths);
          setSelectedFilePaths((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const p of movedSet) if (next.delete(p)) changed = true;
            return changed ? next : prev;
          });
          setSelectionAnchorPath((anchor) => (anchor && movedSet.has(anchor) ? null : anchor));
          // A moved source no longer exists at its old path — drop it as the
          // paste anchor so a later Cmd+V doesn't target a vanished row.
          if (pasteAnchorRef.current && movedSet.has(pasteAnchorRef.current.path)) {
            pasteAnchorRef.current = null;
          }
        }
      }

      // refreshDir clears the banner on success; re-surface the drop error (if
      // any) so a failed move/copy still reports its message.
      if (dropError) setError(dropError);
      return dropError === null;
    },
    [cwd, expandDir, refreshDir, onRenameFile],
  );

  const dropEntriesInto = useCallback(
    async (destDir: string, fileList: FileList) => {
      const sourcePaths: string[] = [];
      for (const file of Array.from(fileList)) {
        try {
          const resolved = window.spark.fs.getPathForFile(file);
          if (resolved) sourcePaths.push(resolved);
        } catch {
          // Non-file drag payloads (text, internal MIME) have no path — skip.
        }
      }
      if (sourcePaths.length === 0) return;
      // Drag provenance decides MOVE vs COPY: sources already inside the
      // workspace root are moved; outside sources are copied.
      const insideSources = sourcePaths.filter((p) => isInsideWorkspace(p, cwd));
      const outsideSources = sourcePaths.filter((p) => !isInsideWorkspace(p, cwd));
      // Moving a FOLDER relocates its whole subtree — hold the drop for an
      // explicit confirm. (File moves and copies stay immediate; a folder
      // dropped where it already lives is main-side a no-op, so skip those.)
      const movedFolders = insideSources.filter((p) => {
        if (parentPath(p) === destDir || p === destDir) return false;
        return findEntry(rootRef.current, p)?.entry.isDir ?? false;
      });
      if (movedFolders.length > 0) {
        setPendingMove({
          destDir,
          copySources: outsideSources,
          moveSources: insideSources,
          folderNames: movedFolders.map((p) => basename(p)),
        });
        return;
      }
      await transferEntriesInto(destDir, outsideSources, insideSources);
    },
    [cwd, transferEntriesInto],
  );

  const confirmPendingMove = useCallback(() => {
    setPendingMove((pm) => {
      if (pm) void transferEntriesInto(pm.destDir, pm.copySources, pm.moveSources);
      return null;
    });
  }, [transferEntriesInto]);

  // Enter confirms / Escape cancels the held folder move.
  useEffect(() => {
    if (!pendingMove) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmPendingMove();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPendingMove(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingMove, confirmPendingMove]);

  // Resolve which directory a pointer position would drop into. Uses the live
  // DOM (every row carries `data-fs-path`; directory rows also carry
  // `data-fs-dir-path`) so it works with the virtualized list:
  //   * over a directory row → that directory (drop INTO the folder);
  //   * over a FILE row → the file's parent directory, so dropping onto a file
  //     targets its containing folder rather than the workspace root — this is
  //     what makes "drop a file back onto its own row" a no-op for a MOVE
  //     (dest === the source's current parent) instead of relocating it to root;
  //   * over empty space → the workspace root.
  const dropDirForPoint = useCallback(
    (clientX: number, clientY: number): string => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const row = el?.closest<HTMLElement>("[data-fs-row]");
      if (row) {
        const dirPath = row.dataset.fsDirPath;
        if (dirPath && dirPath.length > 0) return dirPath;
        const filePath = row.dataset.fsPath;
        if (filePath && filePath.length > 0) return parentPath(filePath);
      }
      return cwd;
    },
    [cwd],
  );

  const handleExternalDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      // preventDefault marks the Explorer as a valid drop target; without it the
      // browser refuses the drop and shows a "no-drop" cursor.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const dir = dropDirForPoint(event.clientX, event.clientY);
      setExternalDropDir((prev) => (prev === dir ? prev : dir));
    },
    [dropDirForPoint],
  );

  const handleExternalDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // dragleave fires when moving across child rows too; only clear the
      // highlight when the cursor actually leaves the viewport.
      const viewport = listViewportRef.current;
      // `Node` is shadowed by this module's tree-node type, so cast to the DOM
      // element type for the containment check.
      const next = event.relatedTarget as HTMLElement | null;
      if (viewport && next && viewport.contains(next)) return;
      setExternalDropDir(null);
    },
    [],
  );

  const handleExternalDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      const dir = dropDirForPoint(event.clientX, event.clientY);
      setExternalDropDir(null);
      void dropEntriesInto(dir, event.dataTransfer.files);
    },
    [dropDirForPoint, dropEntriesInto],
  );

  // Native OS drag-OUT of a row. If the grabbed row is part of a multi-file
  // selection, drag the whole selection; otherwise just this entry. We
  // preventDefault to suppress the default HTML5 drag and let the main process
  // own the drag via webContents.startDrag.
  const handleRowDragStart = useCallback((node: Node, event: React.DragEvent) => {
    // OS drag-out is a local-filesystem gesture (webContents.startDrag needs
    // real local paths). Remote entries live on the VPS — suppress it.
    if (isRemotePath(node.entry.path)) {
      event.preventDefault();
      return;
    }
    const path = node.entry.path;
    const selected = selectedFilePathsRef.current;
    // Nested-path pruning: a selected folder already drags its subtree, so a
    // simultaneously-selected child must not ride along as a second copy.
    const paths =
      selected.has(path) && selected.size > 1
        ? pruneNestedPaths(Array.from(selected))
        : [path];
    event.preventDefault();
    // Draw a drag badge (icon + name + count chip on a shadowed card) so the
    // grabbed entry reads clearly under the cursor; falls back to the main
    // process's stock glyph when canvas rendering fails.
    const badge = renderDragBadge(
      paths.length > 1 ? `${paths.length} items` : node.entry.name,
      node.entry.isDir,
      paths.length,
    );
    window.spark.fs.startDrag(paths, badge ?? undefined);
  }, []);

  // Explorer file clipboard ---------------------------------------------------
  // Module-singleton state (survives the key={cwd} remount on workspace
  // switch); OS interop is best-effort CF_HDROP via main. See explorerClipboard.ts.
  const explorerClipboard = useSyncExternalStore(subscribeExplorerClipboard, getExplorerClipboard);
  const cutSet = React.useMemo(
    () =>
      explorerClipboard?.mode === "cut" ? new Set(explorerClipboard.paths) : null,
    [explorerClipboard],
  );

  // Git decorations: absolute path → status for every changed file, derived
  // from the shared status. Unstaged wins when a file appears in both lists
  // (matches VS Code's single-decoration-per-file behavior).
  const statusByPath = React.useMemo(() => {
    if (!gitStatus?.isRepo) return null;
    const sep = cwd.includes("\\") ? "\\" : "/";
    const base = cwd.replace(/[\\/]+$/, "");
    const toAbs = (rel: string) => base + sep + rel.replace(/\//g, sep);
    const m = new Map<string, GitFileStatus>();
    for (const f of gitStatus.staged) m.set(toAbs(f.path), f.status);
    for (const f of gitStatus.unstaged) m.set(toAbs(f.path), f.status);
    return m.size > 0 ? m : null;
  }, [gitStatus, cwd]);

  const copyToClipboard = useCallback((rawPaths: string[], mode: "copy" | "cut") => {
    // A selected folder already carries its subtree through the recursive
    // copy/move; keeping a simultaneously-selected child would duplicate it on
    // copy and break the move (its source vanishes with the parent).
    const paths = pruneNestedPaths(rawPaths);
    if (paths.length === 0) return;
    setExplorerClipboard({ mode, paths });
    // Real CF_HDROP so Windows Explorer can paste these files. The text
    // fallback only runs when file interop is unavailable — writing text
    // AFTER a successful file write would clear the CF_HDROP formats again
    // (Windows clipboard formats only coexist when set in one operation).
    void window.spark.clipboard
      .writeFilePaths(paths)
      .then((ok) => {
        if (!ok) return navigator.clipboard.writeText(paths.join("\n"));
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  const pasteFromClipboard = useCallback(
    async (destOverride?: string) => {
      // Destination priority: explicit override (context-menu Paste on a row or
      // blank space) → the last-clicked paste anchor (folder → into it, file →
      // into its parent) → the selection anchor's parent → the workspace root.
      // The paste anchor is what makes "click a destination folder, then Cmd+V"
      // work even though clicking a folder clears the file selection.
      let destDir = destOverride ?? null;
      if (!destDir) {
        const anchor = pasteAnchorRef.current;
        if (anchor) destDir = anchor.isDir ? anchor.path : parentPath(anchor.path);
      }
      if (!destDir) {
        const selected = selectedFilePathsRef.current;
        const selAnchor =
          selectionAnchorPathRef.current ??
          (selected.size > 0 ? Array.from(selected)[0] : null);
        destDir = selAnchor ? parentPath(selAnchor) : cwd;
      }
      const local = getExplorerClipboard();
      let sources: string[] | null = null;
      try {
        sources = await window.spark.clipboard.readFilePaths();
      } catch {
        sources = null;
      }
      if (!sources || sources.length === 0) sources = local?.paths ?? [];
      if (sources.length === 0) return; // nothing to paste — quiet no-op
      // Cut (move) semantics apply only when the OS clipboard still holds our
      // own cut set (or interop is unavailable and we fell back to it). If the
      // user copied something else in the file manager since, it's a plain copy.
      const sameAsLocal = local !== null && isSameFileSet(sources, local.paths);
      // On a same-set match, run the transfer against the in-app paths, not the
      // clipboard readback: the OS round-trip can change unicode normalization
      // form (macOS returns file URLs as NFD), and the in-app paths are what the
      // tree, open editor tabs, and selection are keyed by — so the move's
      // editor-tab repoint and selection cleanup line up. Cross-app pastes
      // (Finder → tree) keep the readback paths and stay a copy.
      if (sameAsLocal && local) sources = local.paths;
      const isCut = local?.mode === "cut" && sameAsLocal;
      const ok = await transferEntriesInto(
        destDir,
        isCut ? [] : sources,
        isCut ? sources : [],
      );
      // A paste consumes a cut (Explorer/VS Code behavior); a copy persists
      // for repeated pastes.
      if (isCut && ok) setExplorerClipboard(null);
    },
    [cwd, transferEntriesInto],
  );

  // Ctrl/Cmd+C / X / V, scoped to the explorer WITHOUT the global shortcut
  // registry (its capture-phase dispatcher would steal copy from CodeMirror
  // and the terminals). Same bubble-phase pattern as the F2 rename handler:
  // never fires from editable targets, never fires while text is selected
  // (that's a text copy), and requires an explorer selection as the signal
  // that the user is acting on the tree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "x" && key !== "v") return;
      const target = e.target as HTMLElement | null;
      // Focus inside the tree means the user engaged the Explorer (a tree
      // mousedown focuses the list container), so these keys act on the tree
      // rather than on whatever editor/terminal previously held focus. When
      // focus is NOT in the tree the editable-target guard stays verbatim:
      // Cmd+C/X/V typed into an editor or terminal keep their native behavior.
      // The one in-tree exception is the inline rename INPUT, which must keep
      // native text editing.
      const inTree = listViewportRef.current?.contains(document.activeElement) ?? false;
      // A whiteboard canvas holding focus owns these chords (board-card
      // clipboard) — a lingering tree selection must not also act on files.
      if (!inTree && document.activeElement?.closest(".cora-board-editor")) return;
      const targetIsTreeInput =
        !!target &&
        target.tagName === "INPUT" &&
        (listViewportRef.current?.contains(target) ?? false);
      if (!inTree || targetIsTreeInput) {
        if (
          target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
      }
      if ((key === "c" || key === "x") && (window.getSelection()?.toString() ?? "") !== "") return;
      const selected = selectedFilePathsRef.current;
      if (key === "c" || key === "x") {
        // Copy/cut act on the current selection — nothing selected, nothing to do.
        if (selected.size === 0) return;
        e.preventDefault();
        copyToClipboard(Array.from(selected), key === "c" ? "copy" : "cut");
        return;
      }
      // Paste ("v") deliberately does NOT require a selection: clicking a
      // destination folder clears the file selection, and a Finder→tree paste
      // has no in-app selection — the destination comes from the paste anchor /
      // cwd fallback instead. Gate it so Cmd+V is only claimed by the Explorer
      // once the user has actually engaged the tree (focus-within), armed a
      // paste anchor, or has a selection — never when the tree was never touched.
      if (!inTree && pasteAnchorRef.current === null && selected.size === 0) return;
      e.preventDefault();
      void pasteFromClipboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copyToClipboard, pasteFromClipboard]);

  // Stable per-row handlers --------------------------------------------------
  // Every visible node renders one `<Row>`. `Row` is wrapped in `React.memo`,
  // but memo only pays off if its props are referentially stable across
  // renders. Previously each `Row` received fresh inline arrows, so memo could
  // never skip a render and unrelated App state changes repainted the entire
  // tree. These `useCallback`s take the node / path as an argument instead, so
  // the function identities stay stable and `Row` invokes them with its node.
  const handleContextMenu = useCallback((entry: FsEntry, x: number, y: number) => {
    // Right-clicking a row anchors paste at it (folder → into it; file → into
    // its parent), matching the FileMenu Paste destination below.
    pasteAnchorRef.current = { path: entry.path, isDir: entry.isDir };
    // A row already inside the selection keeps the whole selection (the menu
    // then acts on all of it, folders included). An unselected row — file or
    // folder — becomes the sole selection, so the menu's target is visibly
    // highlighted while the menu is up.
    if (!selectedFilePathsRef.current.has(entry.path)) {
      setSelectedFilePaths(new Set([entry.path]));
      setSelectionAnchorPath(entry.path);
    }
    setBlankMenu(null);
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

      const path = node.entry.path;
      // Any row anchors paste: a folder pastes INTO itself, a file into its
      // parent (all click variants below).
      pasteAnchorRef.current = { path, isDir: node.entry.isDir };
      // Modified clicks (Ctrl/Cmd toggle, Shift range) treat folder rows and
      // file rows identically — a folder is one selectable entry, and a
      // modified click never expands/collapses it. This matches the marquee,
      // which hit-tests every visible row regardless of kind.
      const toggleSelection = event.ctrlKey || event.metaKey;
      if (event.shiftKey) {
        const anchorPath = selectionAnchorPathRef.current ?? path;
        const range = rowRange(flatRef.current, anchorPath, path);
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

      if (node.kind === "dir") {
        // Plain click on a folder keeps its historical role: expand/collapse
        // and clear the selection (the paste anchor above still remembers it
        // as the destination).
        void toggleDir(node);
        setSelectedFilePaths(new Set());
        setSelectionAnchorPath(null);
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
      const target = event.target as HTMLElement | null;
      // Focus the list container on any tree press (a row or blank space) so
      // keyboard clipboard shortcuts target the Explorer instead of whatever
      // editor/terminal previously held focus — the keydown handler's `inTree`
      // check reads document.activeElement. mousedown (not click) so it lands
      // before native drag-out and any editor-open focus side effects. The
      // inline rename/create input keeps its own focus (it also stops mousedown
      // propagation, so this never sees it — belt-and-suspenders).
      const targetEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (!targetEditable) listViewportRef.current?.focus({ preventScroll: true });
      if (event.button !== 0 || renamingPath) return;
      if (
        target?.closest("button, input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      // Pressing on a row begins a potential native drag-out (rows are
      // `draggable`); starting a marquee here would both fight the drag and
      // leak its window listeners (a native drag fires `dragend`, not the
      // `mouseup` the marquee waits for). Rubber-band selection starts from
      // empty space only — clicks on rows still select via the row's onClick.
      if (target?.closest("[data-fs-row]")) return;
      // Blank-space press: no destination row under the pointer, so clear the
      // paste anchor (a later Cmd+V then falls back to selection anchor / cwd).
      pasteAnchorRef.current = null;
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

  const handleListContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Row right-clicks call stopPropagation before reaching here (see Row's
      // onContextMenu), so this only fires on blank Explorer space. Blank space
      // targets the workspace root: clear the row paste anchor and offer a
      // minimal Paste menu pointed at cwd.
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-fs-row]")) return;
      event.preventDefault();
      pasteAnchorRef.current = null;
      setContextMenu(null);
      setBlankMenu({ x: event.clientX, y: event.clientY });
    },
    [],
  );

  // Re-flatten on every render. We mutate root.children in place and bump
  // `force()` to re-render — memoising would cache a stale row list because
  // the `root` reference doesn't change across mutations. The traversal is
  // a single linear walk over the open subtree, so the cost is negligible.
  const flat: FlatRow[] = (() => {
    // Primary variant: skip the root node row itself — its name is already
    // shown in the SectionHeader's `meta` slot, so rendering it again would
    // duplicate the workspace folder name. We still flatten its children at
    // depth 0. External variant: there is no header, so the attached folder
    // itself is the row users see, expand, and right-click.
    const root = rootRef.current;
    const rows: FlatRow[] = [];
    if (variant === "external") {
      rows.push(...flatten(root, 0));
    } else if (root.open) {
      for (const child of root.children) {
        flatten(child, 0, rows);
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
  const selectedEntries = entriesForPaths(flat, selectedFilePaths);
  // Right-clicking a row that is part of the selection acts on the WHOLE
  // selection (files and folders alike); an unselected row acts on itself only.
  const contextMenuEntries =
    contextMenu && selectedFilePaths.has(contextMenu.entry.path)
      ? selectedEntries.length > 0
        ? selectedEntries
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

  // Escape clears the selection (after a marquee or click selection). Menus,
  // rename/create inputs, and the move confirm all own Escape while open —
  // their handlers close them and this effect's guards skip the clear. Only
  // fires while the Explorer holds focus so an editor Esc never reaches it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (renamingPath || pendingCreate || contextMenu || blankMenu || pendingMove) return;
      const inTree = listViewportRef.current?.contains(document.activeElement) ?? false;
      if (!inTree) return;
      setSelectedFilePaths((prev) => (prev.size > 0 ? new Set<string>() : prev));
      setSelectionAnchorPath(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renamingPath, pendingCreate, contextMenu, blankMenu, pendingMove]);

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
    const directRow = rowElementsRef.current.get(activePath);
    if (directRow) {
      directRow.scrollIntoView({ block: "nearest", behavior: "auto" });
      return;
    }
    virtuosoRef.current?.scrollIntoView({ index, behavior: "auto" });
    // `flat` is rebuilt every render; depending on `activePath` alone keeps
    // this from firing on unrelated re-renders while still re-running when
    // the selection changes (the only time we want to scroll).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  const renderFlatRow = (row: FlatRow): React.ReactNode => {
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
        externalRoot={variant === "external" && row.node.entry.path === cwd}
        active={row.node.entry.path === activePath}
        selected={selectedFilePaths.has(row.node.entry.path)}
        dirOpen={Boolean(dirNode?.open)}
        dirLoading={Boolean(dirNode?.loading)}
        dirLoaded={Boolean(dirNode?.loaded)}
        dirError={dirNode?.error}
        renaming={renamingPath === row.node.entry.path}
        isDropTarget={dirNode != null && externalDropDir === row.node.entry.path}
        cut={cutSet?.has(row.node.entry.path) ?? false}
        gitFileStatus={
          row.node.entry.isDir ? undefined : statusByPath?.get(row.node.entry.path)
        }
        onRowClick={handleRowClick}
        onRowElement={updateRowElement}
        onContextMenu={handleContextMenu}
        onCommitRename={handleCommitRename}
        onCancelRename={cancelRename}
        onRowDragStart={handleRowDragStart}
      />
    );
  };

  return (
    <div
      // Lets the rail measure this tree's current height when a resize drag
      // starts before any explicit height exists.
      data-external-tree={variant === "external" ? cwd : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        // Primary fills the Explorer section. External trees stack below it:
        // a user-dragged height wins outright; otherwise they size to their
        // visible rows (floor keeps error/empty states legible), capped so a
        // large attached folder cannot crush the workspace tree — past either
        // limit the tree scrolls internally.
        // Attached folders read as a separate linked block: hairline rule on
        // top plus a whisper of accent wash behind the whole subtree.
        ...(variant === "external"
          ? {
              borderTop: "1px solid var(--rule-soft)",
              background: "color-mix(in oklch, var(--accent) 2%, transparent)",
            }
          : null),
        ...(variant === "external"
          ? collapsed
            ? { flex: "0 0 auto" }
            : heightPx != null
              ? { flex: `0 0 ${heightPx}px`, height: heightPx }
              : {
                  flex: "0 1 auto",
                  height: Math.max(flat.length * ROW_HEIGHT + 12, error ? 80 : ROW_HEIGHT + 12),
                  maxHeight: "40%",
                }
          : { height: "100%" }),
        overflow: "hidden",
      }}
    >
      {variant !== "external" && (
      <SectionHeader
        label="Explorer"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        {...headerDrag}
        meta={
          <span
            title={
              selectedEntries.length > 1
                ? `${selectedEntries.length} items selected`
                : cwd
            }
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: selectedEntries.length > 1 ? "var(--accent-text)" : "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 132,
            }}
          >
            {selectedEntries.length > 1
              ? `${selectedEntries.length} selected`
              : basename(cwd)}
          </span>
        }
        actions={
          <>
            {/* One "+" button for everything additive (dropdown: new file /
                new folder / attach folder). Refresh is gone — the fs watcher
                keeps the tree live — and Reveal moved into the blank-space
                right-click menu. */}
            <NewEntryButton
              onNewFile={() => void newFileAtRoot()}
              onNewFolder={() => void newFolderAtRoot()}
              onAddExternalFolder={onAddExternalFolder}
            />
          </>
        }
      />
      )}
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
        data-fs-row-count={flat.length}
        // Programmatically focusable (not tab-reachable) so a tree press can
        // move keyboard focus here — that's what lets Cmd+C/X/V act on the
        // Explorer even when an editor/terminal had focus. `outline: none`
        // hides the resulting focus ring on the scroll container.
        tabIndex={-1}
        onMouseDown={handleListMouseDown}
        onContextMenu={handleListContextMenu}
        onDragOver={handleExternalDragOver}
        onDragLeave={handleExternalDragLeave}
        onDrop={handleExternalDrop}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          outline: "none",
          userSelect: selectionRect ? "none" : undefined,
          // Whole-list ring when an external drag targets the workspace root
          // (a subfolder target highlights its own row instead).
          boxShadow:
            externalDropDir === cwd
              ? "inset 0 0 0 2px color-mix(in oklch, var(--accent) 55%, transparent)"
              : undefined,
          background:
            externalDropDir === cwd
              ? "color-mix(in oklch, var(--accent) 6%, transparent)"
              : undefined,
          transition: "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
      >
        {flat.length <= DIRECT_TREE_RENDER_LIMIT ? (
          <div style={{ height: "100%", width: "100%", overflow: "auto", padding: "2px 0 8px" }}>
            {flat.map((row) => (
              <React.Fragment
                key={
                  row.kind === "node"
                    ? row.node.entry.path
                    : `placeholder:${row.parentPath}:${row.entryKind}`
                }
              >
                {renderFlatRow(row)}
              </React.Fragment>
            ))}
          </div>
        ) : (
          <Virtuoso<FlatRow>
            ref={virtuosoRef}
            style={{ height: "100%", width: "100%" }}
            // Supplying the rows as data (instead of closing over `flat` plus
            // totalCount) gives Virtuoso an explicit structural update when a
            // folder expands or a watcher adds a file.
            data={flat}
            fixedItemHeight={ROW_HEIGHT}
            initialItemCount={Math.min(flat.length, 24)}
            overscan={400}
            components={LIST_COMPONENTS}
            computeItemKey={(_index, row) =>
              row.kind === "node"
                ? row.node.entry.path
                : `placeholder:${row.parentPath}:${row.entryKind}`
            }
            itemContent={(_index, row) => renderFlatRow(row)}
          />
        )}
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
        {externalDropDir && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              bottom: 8,
              zIndex: 25,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              borderRadius: 6,
              background: "var(--accent)",
              color: "var(--on-accent, #fff)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              fontWeight: 700,
              boxShadow: "var(--shadow-2)",
              pointerEvents: "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <DropIcon />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              Copy to {externalDropDir === cwd ? basename(cwd) : basename(externalDropDir)}
            </span>
          </div>
        )}
      </div>
        </>
      )}
      {contextMenu && (() => {
        // The attached folder's own row: "Delete" becomes "Remove from
        // workspace" (drops the reference, never touches disk) and renaming
        // the root is disallowed — same restriction the primary workspace
        // root has, since an on-disk rename would orphan the stored path.
        const isExternalRoot = variant === "external" && contextMenu.entry.path === cwd;
        return (
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
              : contextMenu.entry.name.toLowerCase().endsWith(".coraboard")
                ? "Open Whiteboard"
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
            contextMenuEntries.length === 1 && !isExternalRoot
              ? () => beginRename(contextMenu.entry)
              : null
          }
          onReveal={
            contextMenuEntries.length === 1
              ? async () => {
                  const entry = contextMenu.entry;
                  const path = entry.path;
                  setContextMenu(null);
                  try {
                    if (isPreviewFile(entry)) {
                      await window.spark.openInNewPreview(filePathToBrowserUrl(path));
                    } else {
                      await window.spark.fs.revealInOS(path);
                    }
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }
              : null
          }
          revealLabel={isPreviewFile(contextMenu.entry) ? "Open in Browser" : REVEAL_IN_OS_LABEL}
          onOpenChanges={
            onOpenChanges &&
            contextMenuEntries.length === 1 &&
            !contextMenu.entry.isDir &&
            statusByPath?.has(contextMenu.entry.path)
              ? () => {
                  const path = contextMenu.entry.path;
                  setContextMenu(null);
                  onOpenChanges(path);
                }
              : null
          }
          onCopy={() => {
            const paths = contextMenuEntries.map((entry) => entry.path);
            setContextMenu(null);
            copyToClipboard(paths, "copy");
          }}
          onCut={() => {
            const paths = contextMenuEntries.map((entry) => entry.path);
            setContextMenu(null);
            copyToClipboard(paths, "cut");
          }}
          onPaste={() => {
            const entry = contextMenu.entry;
            setContextMenu(null);
            void pasteFromClipboard(entry.isDir ? entry.path : parentPath(entry.path));
          }}
          onCopyPath={() => {
            const text = contextMenuEntries.map((entry) => entry.path).join("\n");
            setContextMenu(null);
            void navigator.clipboard.writeText(text).catch((err) => setError((err as Error).message));
          }}
          onCopyRelativePath={() => {
            const text = contextMenuEntries
              .map((entry) => workspaceRelativePath(cwd, entry.path))
              .join("\n");
            setContextMenu(null);
            void navigator.clipboard.writeText(text).catch((err) => setError((err as Error).message));
          }}
          onDelete={
            isExternalRoot
              ? () => {
                  setContextMenu(null);
                  onRemoveExternalFolder?.();
                }
              : () => void deleteEntries(contextMenuEntries)
          }
          deleteLabel={
            isExternalRoot
              ? "Remove from workspace"
              : contextMenuEntries.length > 1
                ? `Delete ${contextMenuEntries.length} ${
                    contextMenuEntries.some((entry) => entry.isDir) ? "items" : "files"
                  }`
                : "Delete"
          }
        />
        );
      })()}
      {blankMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="spark-glass"
          style={{
            position: "fixed",
            zIndex: 100,
            left: Math.max(8, Math.min(blankMenu.x, window.innerWidth - 196)),
            top: Math.max(8, Math.min(blankMenu.y, window.innerHeight - 212)),
            width: 188,
            borderRadius: 8,
            padding: 6,
          }}
        >
          <MenuButton
            onClick={() => {
              setBlankMenu(null);
              void newFileAtRoot();
            }}
          >
            New File
          </MenuButton>
          <MenuButton
            onClick={() => {
              setBlankMenu(null);
              void newFolderAtRoot();
            }}
          >
            New Folder
          </MenuButton>
          <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
          <MenuButton
            hint="Ctrl+V"
            onClick={() => {
              setBlankMenu(null);
              void pasteFromClipboard(cwd);
            }}
          >
            Paste
          </MenuButton>
          <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
          <MenuButton
            onClick={() => {
              setBlankMenu(null);
              void window.spark.fs
                .revealInOS(cwd)
                .catch((err) => setError((err as Error).message));
            }}
          >
            {REVEAL_IN_OS_LABEL}
          </MenuButton>
        </div>
      )}
      {pendingMove && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPendingMove(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 120,
            background: "color-mix(in oklab, black 30%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            role="alertdialog"
            aria-label="Confirm folder move"
            className="spark-glass--strong"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 320,
              borderRadius: 10,
              padding: "16px 16px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              fontFamily: "var(--font-sans)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
              {pendingMove.folderNames.length > 1
                ? `Move ${pendingMove.folderNames.length} folders?`
                : "Move folder?"}
            </span>
            <span style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5 }}>
              {pendingMove.folderNames.length > 1
                ? `Move ${pendingMove.folderNames.length} folders (${pendingMove.folderNames
                    .slice(0, 3)
                    .join(", ")}${pendingMove.folderNames.length > 3 ? ", …" : ""}) into `
                : (
                    <>
                      Move <strong>{pendingMove.folderNames[0]}</strong> and everything inside it
                      into{" "}
                    </>
                  )}
              <strong>
                {pendingMove.destDir === cwd ? basename(cwd) : basename(pendingMove.destDir)}
              </strong>
              ?
            </span>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setPendingMove(null)}
                style={{
                  appearance: "none",
                  border: "1px solid var(--rule-strong)",
                  background: "transparent",
                  color: "var(--ink-dim)",
                  borderRadius: 6,
                  padding: "5px 12px",
                  fontFamily: "inherit",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "default",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={confirmPendingMove}
                style={{
                  appearance: "none",
                  border: "none",
                  background: "var(--accent)",
                  color: "var(--on-accent, #fff)",
                  borderRadius: 6,
                  padding: "5px 14px",
                  fontFamily: "inherit",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "default",
                }}
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type FlatRow =
  | { kind: "node"; node: Node; depth: number }
  | { kind: "placeholder"; depth: number; parentPath: string; entryKind: "file" | "dir" };

// Appends into a single caller-owned array — spreading a fresh array per node
// copies the whole subtree once per level and can blow the spread arity limit
// on very large directories.
function flatten(node: Node, depth: number, out: FlatRow[] = []): FlatRow[] {
  out.push({ kind: "node", node, depth });
  if (node.kind === "dir" && node.open) {
    for (const child of node.children) {
      flatten(child, depth + 1, out);
    }
  }
  return out;
}

// Every visible row — files AND directories — in display order. Selection is
// per visible row (a collapsed folder is ONE entry; its hidden children are
// not part of the selection), so range/marquee helpers walk this list.
// Exported (with rowRange / entriesForPaths / pruneNestedPaths) for
// scripts/test-file-tree-marquee.cjs.
export function visibleNodeRows(rows: FlatRow[]): Array<{ path: string; entry: FsEntry }> {
  return rows.flatMap((row) =>
    row.kind === "node" ? [{ path: row.node.entry.path, entry: row.node.entry }] : [],
  );
}

export function rowRange(rows: FlatRow[], anchorPath: string, targetPath: string): string[] {
  const paths = visibleNodeRows(rows).map((row) => row.path);
  const anchorIndex = paths.indexOf(anchorPath);
  const targetIndex = paths.indexOf(targetPath);
  if (anchorIndex === -1 || targetIndex === -1) return [targetPath];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return paths.slice(start, end + 1);
}

export function entriesForPaths(rows: FlatRow[], paths: Set<string>): FsEntry[] {
  if (paths.size === 0) return [];
  return visibleNodeRows(rows)
    .filter((row) => paths.has(row.path))
    .map((row) => row.entry);
}

// Drop every path whose ancestor directory is also in the list. A marquee over
// an EXPANDED folder selects the folder and its visible children as separate
// entries; acting on that set verbatim would double-handle the children —
// delete/trash the folder then fail on its already-gone child, or move the
// folder then hit a missing source for the child. The ancestor alone already
// carries its subtree through every recursive operation (trash, move, copy,
// OS drag).
export function pruneNestedPaths(paths: string[]): string[] {
  const set = new Set(paths);
  return paths.filter((path) => {
    // `dirname` is a fixed point at a filesystem root ("/x" → "/x"), so stop
    // as soon as it stops shrinking — including on the FIRST step, where the
    // fixed point would otherwise make a top-level path prune itself.
    for (let prev = path, dir = parentPath(path); dir !== prev; prev = dir, dir = parentPath(dir)) {
      if (set.has(dir)) return false;
    }
    return true;
  });
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

// Bounded retry/backoff shared by the workspace-switch reload and the watcher
// arming. A brand-new workspace's root lands in the main-process read sandbox a
// React tick after FileTree's child effects run, so the first IPC call can
// reject with "Path not allowed". We retry over ~1-2s (6 attempts, 150→900ms)
// so the panel self-heals once the root is allowed, but stop immediately when
// `isCancelled` flips (cwd change / unmount) so a stale retry never writes.
const RETRY_DELAYS_MS = [150, 250, 350, 500, 700, 900];

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Run an IPC call with bounded retries. Returns the resolved value, or null if
// every attempt failed or the caller cancelled mid-flight.
async function callWithRetry<T>(
  fn: () => Promise<T>,
  isCancelled: () => boolean,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    if (isCancelled()) return null;
    try {
      return await fn();
    } catch {
      if (attempt >= RETRY_DELAYS_MS.length) return null;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Load a directory's children with the bounded backoff above. Returns null when
// cancelled or after exhausting retries (the panel then stays at "Loading…",
// the same terminal state as before, rather than throwing uncaught).
function loadDirWithRetry(
  path: string,
  isCancelled: () => boolean,
): Promise<Node[] | null> {
  return callWithRetry(() => loadDir(path), isCancelled);
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

// Reconcile everything the user can currently see, not just the root. Cached
// expanded folders may have changed while another workspace owned the single
// filesystem watcher; refreshing the open subtree makes the instant cached
// paint converge without forcing the user to collapse/reopen each directory.
async function reloadExpandedTreeInPlace(dir: DirNode & { kind: "dir" }): Promise<void> {
  await reloadDirInPlace(dir);
  const visibleChildren = dir.children.filter(
    (child): child is DirNode & { kind: "dir" } =>
      child.kind === "dir" && child.open && child.loaded,
  );
  await Promise.all(visibleChildren.map((child) => reloadExpandedTreeInPlace(child)));
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
  // The root row of an ATTACHED external folder — styled as a linked source
  // (accent tint + LINKED chip) so it never reads as part of the workspace
  // tree proper.
  externalRoot?: boolean;
  active: boolean;
  selected: boolean;
  dirOpen: boolean;
  dirLoading: boolean;
  dirLoaded: boolean;
  dirError?: string;
  renaming: boolean;
  // True when an in-flight external file drag is hovering this (directory) row,
  // so it should paint the drop-target ring.
  isDropTarget: boolean;
  // True while this entry sits on the file clipboard in "cut" mode — the row
  // dims (Explorer/VS Code convention) until the cut is pasted or replaced.
  cut: boolean;
  // Git status for changed leaf files (undefined = unchanged/untracked-clean):
  // colors the filename + renders a trailing status glyph, VS Code-style.
  gitFileStatus?: GitFileStatus;
  onRowClick: (node: Node, event: React.MouseEvent) => void;
  onRowElement: (path: string, element: HTMLDivElement | null) => void;
  onContextMenu: (entry: FsEntry, x: number, y: number) => void;
  onCommitRename: (path: string, value: string) => void;
  onCancelRename: () => void;
  onRowDragStart: (node: Node, event: React.DragEvent) => void;
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
    prev.externalRoot !== next.externalRoot ||
    prev.active !== next.active ||
    prev.selected !== next.selected ||
    prev.dirOpen !== next.dirOpen ||
    prev.dirLoading !== next.dirLoading ||
    prev.dirLoaded !== next.dirLoaded ||
    prev.dirError !== next.dirError ||
    prev.renaming !== next.renaming ||
    prev.isDropTarget !== next.isDropTarget ||
    prev.cut !== next.cut ||
    prev.gitFileStatus !== next.gitFileStatus ||
    prev.onRowClick !== next.onRowClick ||
    prev.onRowElement !== next.onRowElement ||
    prev.onContextMenu !== next.onContextMenu ||
    prev.onCommitRename !== next.onCommitRename ||
    prev.onCancelRename !== next.onCancelRename ||
    prev.onRowDragStart !== next.onRowDragStart
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
  externalRoot = false,
  active,
  selected,
  dirOpen,
  dirLoading,
  renaming,
  isDropTarget,
  cut,
  gitFileStatus,
  onRowClick,
  onRowElement,
  onContextMenu,
  onCommitRename,
  onCancelRename,
  onRowDragStart,
}: RowProps) {
  const isDir = node.kind === "dir";
  const [hover, setHover] = useState(false);
  const rowPaddingLeft = BASE_LEFT + depth * INDENT_STEP;
  const background = isDropTarget
    ? "color-mix(in oklch, var(--accent) 16%, transparent)"
    : selected
      ? active
        ? "color-mix(in oklch, var(--accent) 18%, transparent)"
        : "color-mix(in oklch, var(--accent) 12%, transparent)"
      : active
        ? "color-mix(in oklab, var(--ink) 9%, transparent)"
        : hover
          ? "color-mix(in oklab, var(--ink) 4%, transparent)"
          : externalRoot
            ? "color-mix(in oklch, var(--accent) 6%, transparent)"
            : "transparent";
  const rowShadow = isDropTarget
    ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 55%, transparent)"
    : selected
      ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 38%, transparent)"
      : active
        ? "inset 0 0 0 1px color-mix(in oklab, var(--ink) 10%, transparent)"
        : externalRoot
          ? "inset 2px 0 0 color-mix(in oklch, var(--accent) 70%, transparent)"
          : "none";

  // Stable wrappers so this row invokes the shared parent handlers with its
  // own node / path. These close over `node`, so they change only when this
  // row's own data changes, which is also the only time `React.memo` lets the
  // row re-render.
  const handleClick = renaming ? undefined : (event: React.MouseEvent) => onRowClick(node, event);
  const handleMouseEnter = () => setHover(true);
  const handleRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      onRowElement(node.entry.path, element);
    },
    [node.entry.path, onRowElement],
  );
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(node.entry, e.clientX, e.clientY);
  };
  const handleCommitRename = (value: string) => onCommitRename(node.entry.path, value);

  const handleDragStart = renaming
    ? undefined
    : (event: React.DragEvent) => onRowDragStart(node, event);

  return (
    <div
      ref={handleRowRef}
      data-fs-row=""
      data-fs-path={node.entry.path}
      data-fs-dir-path={isDir ? node.entry.path : undefined}
      draggable={!renaming}
      onDragStart={handleDragStart}
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
        opacity: cut ? 0.55 : undefined,
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
            fontWeight: externalRoot ? 600 : ROW_LABEL_STYLE.fontWeight,
            color:
              selected || active
                ? "var(--ink)"
                : gitFileStatus
                  ? statusColor(gitFileStatus)
                  : externalRoot
                    ? "var(--ink)"
                    : "var(--ink-dim)",
          }}
          title={node.entry.path}
        >
          {node.entry.name}
        </span>
      )}
      {externalRoot && !renaming && (
        <span
          aria-hidden
          title="Attached folder (outside the workspace)"
          style={{
            flex: "0 0 auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "1px 5px",
            borderRadius: 999,
            fontFamily: "var(--font-sans)",
            fontSize: 8,
            fontWeight: 800,
            letterSpacing: "0.1em",
            color: "var(--accent-text)",
            background: "color-mix(in oklch, var(--accent) 13%, transparent)",
            boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
            <path
              d="M5 7 L7 5 M4.2 5.4 L5.8 3.8 a1.7 1.7 0 0 1 2.4 2.4 L6.6 7.8 M7.8 6.6 L6.2 8.2 a1.7 1.7 0 0 1 -2.4 -2.4 L5.4 4.2"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
          LINKED
        </span>
      )}
      {!renaming && gitFileStatus && (
        <span
          aria-hidden
          title={gitFileStatus}
          style={{
            flex: "0 0 auto",
            marginLeft: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            fontWeight: 800,
            color: statusColor(gitFileStatus),
          }}
        >
          {statusGlyph(gitFileStatus)}
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
  onOpenChanges,
  onCopy,
  onCut,
  onPaste,
  onCopyPath,
  onCopyRelativePath,
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
  onOpenChanges: (() => void) | null;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onDelete: () => void;
  deleteLabel: string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Clamp against the menu's REAL rendered height, not a constant — the item
  // set varies per entry kind and grows over time (a stale constant left the
  // bottom rows unclickable off-screen). First paint uses the previous/none
  // measurement; the layout effect corrects before the frame is shown.
  const menuElRef = useRef<HTMLDivElement | null>(null);
  const [menuHeight, setMenuHeight] = useState(280);
  useLayoutEffect(() => {
    const h = menuElRef.current?.offsetHeight;
    if (h && h !== menuHeight) setMenuHeight(h);
  });
  const x = Math.min(menu.x, window.innerWidth - 236);
  const y = Math.min(menu.y, window.innerHeight - 8 - menuHeight);
  // The Run plan engine flyout opens to the right by default, flipping left
  // when the menu sits too close to the viewport's right edge to fit it.
  const engineFlyoutOpensLeft = Math.max(8, x) + 228 + ENGINE_FLYOUT_WIDTH > window.innerWidth - 8;
  const multiple = entries.length > 1;
  const headerTitle = multiple
    ? `${entries.length} ${entries.some((entry) => entry.isDir) ? "items" : "files"} selected`
    : menu.entry.name;
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
      ref={menuElRef}
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => {
        if (confirmDelete) setTimeout(() => setConfirmDelete(false), 1500);
      }}
      className="spark-glass"
      style={{
        position: "fixed",
        zIndex: 100,
        left: Math.max(8, x),
        top: Math.max(8, y),
        width: 228,
        borderRadius: 8,
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
        <MenuButton onClick={onOpen} hint={multiple ? undefined : "Enter"}>
          {openLabel}
        </MenuButton>
      )}
      {onOpenChanges && (
        <MenuButton onClick={onOpenChanges}>
          Open Changes
        </MenuButton>
      )}
      <MenuButton onClick={onNewFile}>New File</MenuButton>
      <MenuButton onClick={onNewFolder}>New Folder</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      <MenuButton onClick={onCopy} hint="Ctrl+C">Copy</MenuButton>
      <MenuButton onClick={onCut} hint="Ctrl+X">Cut</MenuButton>
      <MenuButton onClick={onPaste} hint="Ctrl+V">Paste</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      {onRename && <MenuButton onClick={onRename}>Rename</MenuButton>}
      {onReveal && <MenuButton onClick={onReveal}>{revealLabel}</MenuButton>}
      <MenuButton onClick={onCopyPath}>Copy Path</MenuButton>
      <MenuButton onClick={onCopyRelativePath}>Copy Relative Path</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      <MenuButton
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

// The "Run plan" entry. Cora · Pi leads the list and clicking the row itself
// runs it; Claude and Codex remain explicit flyout choices.
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
      <MenuButton accent onClick={() => onPick(engines[0]?.backend)}>
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
          color: "var(--accent-text)",
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
            color: "var(--accent-text)",
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
            // Deliberately NOT glass: this flyout is a descendant of the
            // backdrop-filtered FileMenu, and a filtered ancestor forms a
            // backdrop root — the part of the flyout that overhangs the menu
            // would sample an EMPTY backdrop and render as an unfrosted film
            // over the file tree. Opaque panel instead (see styles.css
            // "one level of glass only").
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
  // Optional leading glyph. Only menus whose EVERY row carries one should use
  // it (the engine picker) — a mixed menu would misalign its labels.
  icon?: string;
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
        gridTemplateColumns: icon ? "22px minmax(0, 1fr) auto" : "minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 8,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {icon && (
        <span
          style={{
            width: 18,
            height: 18,
            border: "1px solid transparent",
            borderRadius: 999,
            color: danger ? "var(--danger)" : accent ? "var(--accent-text)" : "var(--muted)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            fontWeight: 900,
          }}
        >
          {icon}
        </span>
      )}
      <span>{children}</span>
      {hint && <span style={{ color: "var(--muted)", fontSize: 9 }}>{hint}</span>}
    </button>
  );
}

function parentPath(path: string): string {
  return dirname(path);
}

// Draw the OS drag image for a row drag: a rounded card with a folder/file
// glyph, the entry name (or "N items"), a count chip for multi-drags, and a
// soft drop shadow. Rendered at devicePixelRatio and registered main-side at
// that scale factor so it stays crisp on retina. Returns null on any canvas
// failure — the caller then falls back to the stock drag glyph.
function renderDragBadge(
  label: string,
  isDir: boolean,
  count: number,
): { dataUrl: string; scaleFactor: number } | null {
  try {
    const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const font = `600 12px ${getComputedStyle(document.body).fontFamily || "system-ui, sans-serif"}`;
    ctx.font = font;
    const maxTextW = 180;
    const textW = Math.min(ctx.measureText(label).width, maxTextW);
    const showChip = count > 1;
    const chipLabel = String(count);
    const chipW = showChip ? Math.max(18, ctx.measureText(chipLabel).width + 12) : 0;

    const padX = 10;
    const iconW = 16;
    const gap = 7;
    const cardH = 30;
    const cardW = Math.ceil(
      padX + iconW + gap + textW + (showChip ? gap + chipW : 0) + padX,
    );
    // Bleed room around the card so the shadow isn't clipped.
    const bleed = 14;
    canvas.width = (cardW + bleed * 2) * scale;
    canvas.height = (cardH + bleed * 2) * scale;
    ctx.scale(scale, scale);
    ctx.translate(bleed, bleed);

    // Card with drop shadow.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "rgba(34, 37, 51, 0.96)";
    ctx.beginPath();
    ctx.roundRect(0, 0, cardW, cardH, 8);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, cardW - 1, cardH - 1, 8);
    ctx.stroke();

    // Glyph: folder or file outline.
    ctx.strokeStyle = "rgba(178, 186, 210, 0.95)";
    ctx.lineWidth = 1.3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const gx = padX;
    const gy = (cardH - 14) / 2;
    ctx.beginPath();
    if (isDir) {
      // Folder: tabbed top edge, rounded body.
      ctx.roundRect(gx, gy + 2.5, 14, 10.5, 2);
      ctx.moveTo(gx, gy + 4.5);
      ctx.lineTo(gx + 0.5, gy + 1.5);
      ctx.arcTo(gx + 1, gy + 0.5, gx + 2.5, gy + 0.5, 1.5);
      ctx.lineTo(gx + 5.5, gy + 0.5);
      ctx.lineTo(gx + 7, gy + 2.5);
    } else {
      // Document: page with a folded corner.
      ctx.moveTo(gx + 2, gy);
      ctx.lineTo(gx + 8.5, gy);
      ctx.lineTo(gx + 12, gy + 3.5);
      ctx.lineTo(gx + 12, gy + 14);
      ctx.lineTo(gx + 2, gy + 14);
      ctx.closePath();
      ctx.moveTo(gx + 8.5, gy);
      ctx.lineTo(gx + 8.5, gy + 3.5);
      ctx.lineTo(gx + 12, gy + 3.5);
    }
    ctx.stroke();

    // Name.
    ctx.font = font;
    ctx.fillStyle = "rgba(233, 236, 246, 0.98)";
    ctx.textBaseline = "middle";
    const textX = padX + iconW + gap;
    if (ctx.measureText(label).width > maxTextW) {
      let clipped = label;
      while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxTextW) {
        clipped = clipped.slice(0, -1);
      }
      ctx.fillText(`${clipped}…`, textX, cardH / 2 + 0.5);
    } else {
      ctx.fillText(label, textX, cardH / 2 + 0.5);
    }

    // Count chip.
    if (showChip) {
      const chipX = cardW - padX - chipW;
      const chipH = 16;
      const chipY = (cardH - chipH) / 2;
      let accent = "#7c8cff";
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        if (v) accent = v;
      } catch {
        // Keep the fallback accent.
      }
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, chipW, chipH, chipH / 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
      ctx.font = `700 10px ${getComputedStyle(document.body).fontFamily || "system-ui, sans-serif"}`;
      const cw = ctx.measureText(chipLabel).width;
      ctx.fillText(chipLabel, chipX + (chipW - cw) / 2, cardH / 2 + 0.5);
    }

    return { dataUrl: canvas.toDataURL("image/png"), scaleFactor: scale };
  } catch {
    return null;
  }
}

// True when `path` is the workspace root itself or sits somewhere beneath it.
// Slash- and case-normalized like `workspaceRelativePath` (macOS/Windows
// filesystems are case-insensitive; watcher/OS paths can carry mixed
// separators) so a source resolved via `getPathForFile` still matches `cwd`.
// This is the drop rule's discriminator: inside → move, outside → copy.
function isInsideWorkspace(path: string, cwd: string): boolean {
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normPath = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normPath === normCwd || normPath.startsWith(`${normCwd}/`);
}

// Path relative to the workspace root for the "Copy Relative Path" action.
// Prefix-matches case-insensitively (macOS/Windows filesystems) but returns the
// segment with its original casing. Falls back to the absolute path when the
// entry somehow sits outside the workspace root.
function workspaceRelativePath(cwd: string, path: string): string {
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normPath = path.replace(/\\/g, "/");
  if (normPath.toLowerCase() === normCwd.toLowerCase()) return ".";
  if (normPath.toLowerCase().startsWith(`${normCwd.toLowerCase()}/`)) {
    return normPath.slice(normCwd.length + 1);
  }
  return normPath;
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

// "+" — the header's single create affordance (opens the New File / New
// Folder dropdown). Rounded caps at 1.4px so it reads crisply at 15px.
function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3.75 V12.25 M3.75 8 H12.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NewFileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.75 2.75 a1 1 0 0 1 1 -1 H9.25 L12.25 4.75 V13.25 a1 1 0 0 1 -1 1 H4.75 a1 1 0 0 1 -1 -1 Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9.25 1.75 V4.75 H12.25" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path
        d="M8 7.5 V11.5 M6 9.5 H10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.75 4 a1 1 0 0 1 1 -1 H5.9 L7.4 4.75 H13.25 a1 1 0 0 1 1 1 V12 a1 1 0 0 1 -1 1 H2.75 a1 1 0 0 1 -1 -1 Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.9 V10.9 M6 8.9 H10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Folder with an inward arrow: attach an existing outside folder to the
// workspace (distinct from NewFolderIcon's plus, which means "create").
function AddFolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.75 4 a1 1 0 0 1 1 -1 H5.9 L7.4 4.75 H13.25 a1 1 0 0 1 1 1 V12 a1 1 0 0 1 -1 1 H2.75 a1 1 0 0 1 -1 -1 Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M10.6 7 L7.6 10 M7.6 10 H10.1 M7.6 10 V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Header "+" button plus its dropdown: New File / New Folder / Add Folder to
// Workspace. The dropdown is a fixed-position panel anchored under the button;
// it closes on click-away, resize, or Escape (same pattern as the row context
// menus).
function NewEntryButton({
  onNewFile,
  onNewFolder,
  onAddExternalFolder,
}: {
  onNewFile: () => void;
  onNewFolder: () => void;
  onAddExternalFolder?: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const MENU_WIDTH = 196;

  useEffect(() => {
    if (!menuPos) return;
    const close = () => setMenuPos(null);
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
  }, [menuPos]);

  return (
    <span
      ref={anchorRef}
      style={{ display: "inline-flex" }}
      // Keep the opening click from reaching the window click-away listener
      // registered by the effect above: React flushes that effect synchronously
      // for discrete events, so without this the same click that opens the
      // menu bubbles on to window and instantly closes it again.
      onClick={(e) => e.stopPropagation()}
    >
      <HeaderIconButton
        title="New file, folder, or attached folder"
        onClick={() => {
          if (menuPos) {
            setMenuPos(null);
            return;
          }
          const rect = anchorRef.current?.getBoundingClientRect();
          if (!rect) return;
          setMenuPos({
            x: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
            y: rect.bottom + 4,
          });
        }}
      >
        <PlusIcon />
      </HeaderIconButton>
      {menuPos && (
        <div
          className="spark-glass"
          style={{
            position: "fixed",
            zIndex: 100,
            left: menuPos.x,
            top: menuPos.y,
            width: MENU_WIDTH,
            borderRadius: 8,
            padding: 6,
          }}
        >
          <NewEntryMenuItem
            icon={<NewFileIcon />}
            label="New File"
            onClick={() => {
              setMenuPos(null);
              onNewFile();
            }}
          />
          <NewEntryMenuItem
            icon={<NewFolderIcon />}
            label="New Folder"
            onClick={() => {
              setMenuPos(null);
              onNewFolder();
            }}
          />
          {onAddExternalFolder && (
            <>
              <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
              <NewEntryMenuItem
                icon={<AddFolderIcon />}
                label="Add Folder to Workspace"
                onClick={() => {
                  setMenuPos(null);
                  onAddExternalFolder();
                }}
              />
            </>
          )}
        </div>
      )}
    </span>
  );
}

// A dropdown row with a leading SVG icon (MenuButton's `icon` slot only takes
// a text glyph, and these two rows read better with the real pictograms).
function NewEntryMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        background: hovered ? "var(--panel)" : "transparent",
        color: hovered ? "var(--ink)" : "var(--ink-dim)",
        borderRadius: 6,
        padding: "7px 8px",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: 700,
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr)",
        alignItems: "center",
        gap: 8,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: hovered ? "var(--ink)" : "var(--muted)",
        }}
      >
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function DropIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M7 1.5 V8.5 M4 5.5 L7 8.5 L10 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 10.5 V12 H11.5 V10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
