import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import { ChevronIcon, FileIcon, FolderIcon } from "./icons";
import { basename } from "../path-utils";

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

export default function FileTree({
  cwd,
  activePath,
  onOpenFile,
  onDeleteFile,
  onRenameFile,
}: Props) {
  const [root, setRoot] = useState<DirNode & { kind: "dir" }>(() => makeDir({ name: basename(cwd), path: cwd, isDir: true }, true));
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);

  // Reload when cwd changes
  useEffect(() => {
    let cancelled = false;
    const next: DirNode & { kind: "dir" } = makeDir(
      { name: basename(cwd), path: cwd, isDir: true },
      true,
    );
    setRoot(next);
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

  const refreshDir = useCallback(async (dirPath: string) => {
    const dir = findDir(root, dirPath);
    if (!dir) return;
    dir.loading = true;
    force((n) => n + 1);
    try {
      dir.children = await loadDir(dir.entry.path);
      dir.loaded = true;
      dir.error = undefined;
      setError(null);
    } catch (err) {
      dir.error = (err as Error).message;
      setError((err as Error).message);
    } finally {
      dir.loading = false;
      force((n) => n + 1);
    }
  }, [root]);

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

  const renameEntry = async (entry: FsEntry) => {
    setContextMenu(null);
    const nextName = window.prompt("Rename file", entry.name);
    if (nextName === null || nextName.trim() === entry.name) return;
    try {
      const renamed = await window.spark.fs.renameFile({ path: entry.path, newName: nextName });
      await refreshDir(parentPath(entry.path));
      onRenameFile?.(entry.path, renamed);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deleteEntry = async (entry: FsEntry) => {
    setContextMenu(null);
    const ok = window.confirm(`Delete ${entry.name}?`);
    if (!ok) return;
    try {
      await window.spark.fs.deleteFile(entry.path);
      await refreshDir(parentPath(entry.path));
      onDeleteFile?.(entry.path);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const flat = useMemo(() => flatten(root, 0), [root]);
  // we re-flatten on every render via this memo dep on root identity, but since
  // we mutate root.children we also bump via force(). Ensure flat is recomputed:
  const flatRef = useRef(flat);
  flatRef.current = flatten(root, 0);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: "0 0 30%",
      }}
    >
      <PanelHeader title="EXPLORER" right={<span style={{ color: "var(--muted)" }}>{basename(cwd)}</span>} />
      {error && (
        <div style={{ padding: "7px 12px", color: "var(--danger)", fontSize: 11, borderBottom: "1px solid var(--rule)" }}>
          {error}
        </div>
      )}
      <div style={{ padding: "6px 0", overflow: "auto", flex: 1 }}>
        {flatRef.current.map((row, i) => (
          <Row
            key={row.node.entry.path + i}
            node={row.node}
            depth={row.depth}
            active={row.node.entry.path === activePath}
            onToggle={() => toggleDir(row.node as DirNode & { kind: "dir" })}
            onOpenFile={onOpenFile}
            onFileContextMenu={(entry, x, y) => setContextMenu({ entry, x, y })}
          />
        ))}
      </div>
      {contextMenu && (
        <FileMenu
          menu={contextMenu}
          onRename={() => void renameEntry(contextMenu.entry)}
          onDelete={() => void deleteEntry(contextMenu.entry)}
        />
      )}
    </div>
  );
}

interface FlatRow {
  node: Node;
  depth: number;
}

function flatten(node: Node, depth: number): FlatRow[] {
  const out: FlatRow[] = [{ node, depth }];
  if (node.kind === "dir" && node.open) {
    for (const c of node.children) out.push(...flatten(c, depth + 1));
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

async function loadDir(path: string): Promise<Node[]> {
  const entries = await window.spark.fs.list(path);
  return entries.map((e): Node =>
    e.isDir ? makeDir(e, false) : { kind: "file", entry: e },
  );
}

function Row({
  node,
  depth,
  active,
  onToggle,
  onOpenFile,
  onFileContextMenu,
}: {
  node: Node;
  depth: number;
  active: boolean;
  onToggle: () => void;
  onOpenFile: (entry: FsEntry) => void;
  onFileContextMenu: (entry: FsEntry, x: number, y: number) => void;
}) {
  const isDir = node.kind === "dir";
  return (
    <div
      onClick={isDir ? onToggle : () => onOpenFile(node.entry)}
      onContextMenu={(e) => {
        if (isDir) return;
        e.preventDefault();
        e.stopPropagation();
        onFileContextMenu(node.entry, e.clientX, e.clientY);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 12px 3px 0",
        paddingLeft: 12 + depth * 14,
        background: active ? "var(--panel-2)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        fontSize: 12,
        cursor: isDir ? "default" : "default",
      }}
    >
      {isDir ? <ChevronIcon open={(node as DirNode).open} /> : <span style={{ display: "inline-block", width: 12 }} />}
      {isDir ? <FolderIcon open={(node as DirNode).open} /> : <FileIcon ext={node.entry.ext} />}
      <span
        style={{
          fontWeight: isDir ? 700 : 500,
          color: isDir ? "var(--ink)" : "var(--ink-dim)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={node.entry.path}
      >
        {node.entry.name}
      </span>
      {isDir && (node as DirNode).loading && (
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>…</span>
      )}
    </div>
  );
}

function FileMenu({
  menu,
  onRename,
  onDelete,
}: {
  menu: FileContextMenu;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        zIndex: 100,
        left: menu.x,
        top: menu.y,
        minWidth: 152,
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.42)",
        padding: "4px 0",
      }}
    >
      <MenuButton onClick={onRename}>RENAME</MenuButton>
      <MenuButton danger onClick={onDelete}>DELETE</MenuButton>
    </div>
  );
}

function MenuButton({
  children,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        background: "transparent",
        color: danger ? "var(--danger)" : "var(--ink-dim)",
        padding: "7px 10px",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.08em",
        cursor: "default",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}

function parentPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (idx === 2 && path[1] === ":") return path.slice(0, 3);
  return idx > 0 ? path.slice(0, idx) : path;
}

function PanelHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--rule)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flex: "0 0 auto",
        fontSize: 10,
        letterSpacing: "0.14em",
        fontWeight: 700,
        color: "var(--ink)",
      }}
    >
      <span>{title}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontWeight: 500, letterSpacing: "0.04em", color: "var(--muted)" }}>{right}</span>
    </div>
  );
}
