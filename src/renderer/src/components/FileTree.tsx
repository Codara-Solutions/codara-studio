import React, { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { FsEntry } from "@shared/types";
import { ChevronIcon } from "./icons";
import { FileNodeIcon } from "./file-icons/FileNodeIcon";
import { InlineInput } from "./file-icons/InlineInput";
import { basename, dirname } from "../path-utils";

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
  onOpenFile: (entry: FsEntry) => void;
  onDeleteFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, entry: FsEntry) => void;
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

export default function FileTree({
  cwd,
  activePath,
  onOpenFile,
  onDeleteFile,
  onRenameFile,
}: Props) {
  const [root, setRoot] = useState<DirNode & { kind: "dir" }>(() => makeDir({ name: basename(cwd), path: cwd, isDir: true }, true));
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  const rootRef = useRef(root);
  rootRef.current = root;
  // Imperative handle on the virtualized list. Used to scroll the active node
  // back into view when `activePath` changes from outside the visible window
  // (e.g. opening a file via search, or F2 rename on an off-screen node).
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  // Reload when cwd changes
  useEffect(() => {
    let cancelled = false;
    const next: DirNode & { kind: "dir" } = makeDir(
      { name: basename(cwd), path: cwd, isDir: true },
      true,
    );
    setRoot(next);
    setRenamingPath(null);
    setPendingCreate(null);
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
  const deleteEntry = useCallback(
    async (entry: FsEntry) => {
      setContextMenu(null);
      try {
        await window.spark.fs.deleteFile(entry.path);
        await refreshDir(parentPath(entry.path));
        onDeleteFile?.(entry.path);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [onDeleteFile, refreshDir],
  );

  // Stable per-row handlers --------------------------------------------------
  // Every visible node renders one `<Row>`. `Row` is wrapped in `React.memo`,
  // but memo only pays off if its props are referentially stable across
  // renders. Previously each `Row` received fresh inline arrows
  // (`onToggle`, `onCommitRename`, `onContextMenu`), so memo could never skip
  // a render and an unrelated App state change (workspace color edit, run
  // event) re-rendered the entire tree. These `useCallback`s take the node /
  // path as an argument instead, so the function identities never change and
  // `Row` invokes them itself with its own node.
  const handleToggle = useCallback(
    (node: Node) => {
      if (node.kind === "dir") void toggleDir(node);
    },
    [toggleDir],
  );

  const handleContextMenu = useCallback((entry: FsEntry, x: number, y: number) => {
    setContextMenu({ entry, x, y });
  }, []);

  const handleCommitRename = useCallback(
    (path: string, value: string) => {
      void commitRename(path, value);
    },
    [commitRename],
  );

  // Re-flatten on every render. We mutate root.children in place and bump
  // `force()` to re-render — memoising would cache a stale row list because
  // the `root` reference doesn't change across mutations. The traversal is
  // a single linear walk over the open subtree, so the cost is negligible.
  const flat: FlatRow[] = (() => {
    const rows = flatten(rootRef.current, 0);
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
      } else if (pendingCreate.parentPath === rootRef.current.entry.path) {
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

  // Workspace-level actions
  const newFileAtRoot = useCallback(async () => {
    setRenamingPath(null);
    setPendingCreate({ parentPath: cwd, kind: "file" });
  }, [cwd]);
  const newFolderAtRoot = useCallback(async () => {
    setRenamingPath(null);
    setPendingCreate({ parentPath: cwd, kind: "dir" });
  }, [cwd]);

  // Handle F2 (rename) when an entry is "active"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2" || !activePath) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const entry = findEntry(rootRef.current, activePath);
      if (entry) {
        e.preventDefault();
        beginRename(entry.entry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePath, beginRename]);

  // Keep the active node scrolled into view. With the list virtualized the
  // selected row may not be mounted at all (it scrolled off, or was opened
  // from search), so we drive Virtuoso's imperative API. `scrollIntoView`
  // is a no-op when the row is already on screen, so this stays cheap.
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
        flex: "0 0 30%",
      }}
    >
      <PanelHeader
        title="Explorer"
        right={<span style={{ color: "var(--muted)" }}>{basename(cwd)}</span>}
        actions={
          <>
            <HeaderIconButton title="New file" onClick={() => void newFileAtRoot()}>
              <NewFileIcon />
            </HeaderIconButton>
            <HeaderIconButton title="New folder" onClick={() => void newFolderAtRoot()}>
              <NewFolderIcon />
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
      {error && (
        <div style={{ padding: "6px 16px", color: "var(--danger)", fontSize: 11 }}>
          {error}
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
      <div style={{ flex: 1, minHeight: 0 }}>
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
            return (
              <Row
                node={row.node}
                depth={row.depth}
                active={row.node.entry.path === activePath}
                renaming={renamingPath === row.node.entry.path}
                onToggle={handleToggle}
                onOpenFile={onOpenFile}
                onContextMenu={handleContextMenu}
                onCommitRename={handleCommitRename}
                onCancelRename={cancelRename}
              />
            );
          }}
        />
      </div>
      {contextMenu && (
        <FileMenu
          menu={contextMenu}
          onOpen={
            contextMenu.entry.isDir
              ? null
              : () => {
                  setContextMenu(null);
                  onOpenFile(contextMenu.entry);
                }
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
          onRename={() => beginRename(contextMenu.entry)}
          onReveal={async () => {
            const path = contextMenu.entry.path;
            setContextMenu(null);
            try {
              await window.spark.fs.revealInOS(path);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          onDelete={() => void deleteEntry(contextMenu.entry)}
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
  renaming: boolean;
  onToggle: (node: Node) => void;
  onOpenFile: (entry: FsEntry) => void;
  onContextMenu: (entry: FsEntry, x: number, y: number) => void;
  onCommitRename: (path: string, value: string) => void;
  onCancelRename: () => void;
}

// Custom equality for `Row`'s `React.memo`.
//
// A plain shallow compare is NOT enough here: the tree mutates `DirNode`
// objects *in place* (`open`, `loading`, `loaded`, `error` flip on the same
// reference) and only bumps a `force()` counter to re-render. A shallow
// `prevProps.node === nextProps.node` would therefore be `true` after a
// folder is expanded and the row's own chevron / spinner would never update.
// So we compare the mutable directory fields explicitly. Everything else
// (callbacks, `onOpenFile`) is referentially stable by construction.
function rowPropsEqual(prev: RowProps, next: RowProps): boolean {
  if (
    prev.node !== next.node ||
    prev.depth !== next.depth ||
    prev.active !== next.active ||
    prev.renaming !== next.renaming ||
    prev.onToggle !== next.onToggle ||
    prev.onOpenFile !== next.onOpenFile ||
    prev.onContextMenu !== next.onContextMenu ||
    prev.onCommitRename !== next.onCommitRename ||
    prev.onCancelRename !== next.onCancelRename
  ) {
    return false;
  }
  // Same node reference — re-check the fields that get mutated in place so an
  // expand / collapse / load still re-renders this row.
  if (next.node.kind === "dir") {
    const p = prev.node as DirNode;
    const n = next.node as DirNode;
    if (p.open !== n.open || p.loading !== n.loading || p.loaded !== n.loaded || p.error !== n.error) {
      return false;
    }
  }
  return true;
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
  renaming,
  onToggle,
  onOpenFile,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: RowProps) {
  const isDir = node.kind === "dir";
  const [hover, setHover] = useState(false);
  const dirNode = isDir ? (node as DirNode & { kind: "dir" }) : null;
  const rowPaddingLeft = BASE_LEFT + depth * INDENT_STEP;
  const background = active
    ? "color-mix(in oklch, var(--ink) 9%, transparent)"
    : hover
      ? "color-mix(in oklch, var(--ink) 4%, transparent)"
      : "transparent";

  // Stable wrappers so this row invokes the shared parent handlers with its
  // own node / path. These close over `node` (and `onToggle` etc.), so they
  // change only when this row's own data changes — which is also the only
  // time `React.memo` lets the row re-render.
  const handleClick = renaming
    ? undefined
    : isDir
      ? () => onToggle(node)
      : () => onOpenFile(node.entry);
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(node.entry, e.clientX, e.clientY);
  };
  const handleCommitRename = (value: string) => onCommitRename(node.entry.path, value);

  return (
    <div
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...ROW_STYLE_BASE,
        padding: `0 8px 0 ${rowPaddingLeft}px`,
        background,
        color: active ? "var(--ink)" : "var(--ink-dim)",
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
        {isDir && <ChevronIcon open={Boolean(dirNode?.open)} />}
      </span>

      <FileNodeIcon name={node.entry.name} isDir={isDir} isOpen={Boolean(dirNode?.open)} />

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
            color: active ? "var(--ink)" : "var(--ink-dim)",
          }}
          title={node.entry.path}
        >
          {node.entry.name}
        </span>
      )}
      {isDir && dirNode?.loading && <span style={ROW_LOADING_STYLE}>…</span>}
    </div>
  );
}, rowPropsEqual);

function FileMenu({
  menu,
  onOpen,
  onNewFile,
  onNewFolder,
  onRename,
  onReveal,
  onDelete,
}: {
  menu: FileContextMenu;
  onOpen: (() => void) | null;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const x = Math.min(menu.x, window.innerWidth - 236);
  const y = Math.min(menu.y, window.innerHeight - 280);

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
        boxShadow: "0 18px 50px rgba(0,0,0,0.48)",
        padding: 6,
        overflow: "hidden",
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
        <FileNodeIcon name={menu.entry.name} isDir={menu.entry.isDir} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            title={menu.entry.name}
            style={{
              color: "var(--ink)",
              fontSize: 11,
              fontWeight: 800,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {menu.entry.name}
          </span>
          <span style={{ color: "var(--muted)", fontSize: 9 }}>
            {menu.entry.isDir ? "folder" : menu.entry.ext ? `${menu.entry.ext.toUpperCase()} file` : "file"}
          </span>
        </div>
      </div>
      {onOpen && <MenuButton icon="O" onClick={onOpen} hint="Enter">Open</MenuButton>}
      <MenuButton icon="N" onClick={onNewFile}>New File</MenuButton>
      <MenuButton icon="F" onClick={onNewFolder}>New Folder</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      <MenuButton icon="R" onClick={onRename}>Rename</MenuButton>
      <MenuButton icon="V" onClick={onReveal}>Reveal in OS</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      <MenuButton
        icon="D"
        danger
        onClick={() => {
          if (confirmDelete) onDelete();
          else setConfirmDelete(true);
        }}
      >
        {confirmDelete ? "Click again to confirm" : "Delete"}
      </MenuButton>
    </div>
  );
}

function MenuButton({
  children,
  icon,
  hint,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  icon: string;
  hint?: string;
  danger?: boolean;
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
        color: danger ? "var(--danger)" : hovered ? "var(--ink)" : "var(--ink-dim)",
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
          color: danger ? "var(--danger)" : "var(--muted)",
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

function PanelHeader({
  title,
  right,
  actions,
}: {
  title: string;
  right?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: 22,
        padding: "0 6px 0 14px",
        background: "transparent",
        display: "flex",
        alignItems: "center",
        gap: 4,
        flex: "0 0 22px",
        color: "var(--muted)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: "var(--ink-dim)",
        }}
      >
        {title}
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          maxWidth: 128,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 400,
          color: "var(--muted)",
        }}
      >
        {right}
      </span>
      {actions}
    </div>
  );
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
