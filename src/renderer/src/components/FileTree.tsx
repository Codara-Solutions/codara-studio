import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import { ChevronIcon } from "./icons";
import { FileNodeIcon } from "./file-icons/FileNodeIcon";
import { InlineInput } from "./file-icons/InlineInput";
import { basename } from "../path-utils";

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

  const flat = useMemo(() => {
    // Re-flatten on every render. We mutate root.children in place and bump
    // `force()`, so we deliberately use rootRef.current (not the captured
    // `root` reference) to read the freshest tree.
    const rows = flatten(rootRef.current, 0);
    // Insert a "pending create" placeholder under its parent dir (or at root).
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
        // Root not in the rows? Shouldn't happen, but fall through to a leading row.
        rows.unshift({
          kind: "placeholder",
          depth: 0,
          parentPath: pendingCreate.parentPath,
          entryKind: pendingCreate.kind,
        });
      }
    }
    return rows;
  }, [root, pendingCreate]);

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
      <div style={{ padding: "2px 0 8px", overflow: "auto", flex: 1 }}>
        {flat.map((row, i) => {
          if (row.kind === "placeholder") {
            return (
              <PlaceholderRow
                key={`__pending__${i}`}
                depth={row.depth}
                kind={row.entryKind}
                onCommit={commitCreate}
                onCancel={cancelCreate}
              />
            );
          }
          const isRenaming = renamingPath === row.node.entry.path;
          return (
            <Row
              key={row.node.entry.path + i}
              node={row.node}
              depth={row.depth}
              active={row.node.entry.path === activePath}
              renaming={isRenaming}
              onToggle={() => toggleDir(row.node as DirNode & { kind: "dir" })}
              onOpenFile={onOpenFile}
              onContextMenu={(entry, x, y) => setContextMenu({ entry, x, y })}
              onCommitRename={(value) => void commitRename(row.node.entry.path, value)}
              onCancelRename={cancelRename}
            />
          );
        })}
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

function PlaceholderRow({
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
  const indentStep = 8;
  const baseLeft = 6;
  const rowPaddingLeft = baseLeft + depth * indentStep;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 22,
        padding: `0 8px 0 ${rowPaddingLeft}px`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 12px",
        }}
      />
      <FileNodeIcon name={kind === "dir" ? "" : "untitled"} isDir={kind === "dir"} opacity={0.7} />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

function Row({
  node,
  depth,
  active,
  renaming,
  onToggle,
  onOpenFile,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  node: Node;
  depth: number;
  active: boolean;
  renaming: boolean;
  onToggle: () => void;
  onOpenFile: (entry: FsEntry) => void;
  onContextMenu: (entry: FsEntry, x: number, y: number) => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
}) {
  const isDir = node.kind === "dir";
  const [hover, setHover] = useState(false);
  const dirNode = isDir ? (node as DirNode & { kind: "dir" }) : null;
  const indentStep = 8;
  const baseLeft = 6;
  const rowPaddingLeft = baseLeft + depth * indentStep;
  const background = active
    ? "color-mix(in oklch, var(--ink) 9%, transparent)"
    : hover
      ? "color-mix(in oklch, var(--ink) 4%, transparent)"
      : "transparent";

  return (
    <div
      onClick={
        renaming
          ? undefined
          : isDir
            ? onToggle
            : () => onOpenFile(node.entry)
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(node.entry, e.clientX, e.clientY);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 22,
        padding: `0 8px 0 ${rowPaddingLeft}px`,
        background,
        color: active ? "var(--ink)" : "var(--ink-dim)",
        cursor: "default",
      }}
    >
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: baseLeft + i * indentStep + 4,
            width: 1,
            background: "var(--rule-soft)",
            opacity: 0.6,
          }}
        />
      ))}

      <span
        aria-hidden
        style={{
          width: 12,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 12px",
          color: "var(--muted)",
        }}
      >
        {isDir && <ChevronIcon open={Boolean(dirNode?.open)} />}
      </span>

      <FileNodeIcon name={node.entry.name} isDir={isDir} isOpen={Boolean(dirNode?.open)} />

      {renaming ? (
        <InlineInput
          initial={node.entry.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 400,
            color: active ? "var(--ink)" : "var(--ink-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            flex: 1,
          }}
          title={node.entry.path}
        >
          {node.entry.name}
        </span>
      )}
      {isDir && dirNode?.loading && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>…</span>
      )}
    </div>
  );
}

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
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (idx === 2 && path[1] === ":") return path.slice(0, 3);
  return idx > 0 ? path.slice(0, idx) : path;
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
