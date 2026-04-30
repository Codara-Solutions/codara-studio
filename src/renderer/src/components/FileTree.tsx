import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon } from "./icons";
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
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
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

  const beginRename = (entry: FsEntry) => {
    setContextMenu(null);
    setDeleteTarget(null);
    setRenameTarget(entry);
    setRenameValue(entry.name);
  };

  const renameEntry = async () => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName || nextName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    try {
      const renamed = await window.spark.fs.renameFile({ path: renameTarget.path, newName: nextName });
      await refreshDir(parentPath(renameTarget.path));
      onRenameFile?.(renameTarget.path, renamed);
      setRenameTarget(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const beginDelete = (entry: FsEntry) => {
    setContextMenu(null);
    setRenameTarget(null);
    setDeleteTarget(entry);
  };

  const deleteEntry = async () => {
    if (!deleteTarget) return;
    try {
      await window.spark.fs.deleteFile(deleteTarget.path);
      await refreshDir(parentPath(deleteTarget.path));
      onDeleteFile?.(deleteTarget.path);
      setDeleteTarget(null);
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
          onOpen={() => {
            setContextMenu(null);
            onOpenFile(contextMenu.entry);
          }}
          onRename={() => beginRename(contextMenu.entry)}
          onDelete={() => beginDelete(contextMenu.entry)}
        />
      )}
      {renameTarget && (
        <RenameDialog
          entry={renameTarget}
          value={renameValue}
          onChange={setRenameValue}
          onClose={() => setRenameTarget(null)}
          onSubmit={() => void renameEntry()}
        />
      )}
      {deleteTarget && (
        <DeleteDialog
          entry={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteEntry()}
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
  const [hover, setHover] = useState(false);
  const indentBoxes = Array.from({ length: depth }, (_, i) => i);
  const activeBg = "color-mix(in oklch, var(--accent) 12%, var(--panel))";
  return (
    <div
      onClick={isDir ? onToggle : () => onOpenFile(node.entry)}
      onContextMenu={(e) => {
        if (isDir) return;
        e.preventDefault();
        e.stopPropagation();
        onFileContextMenu(node.entry, e.clientX, e.clientY);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 12px 0 0",
        background: active ? activeBg : hover ? "var(--hover)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {indentBoxes.map((i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 14,
            height: "100%",
            marginLeft: i === 0 ? 8 : 0,
            borderLeft: "1px solid var(--rule-soft)",
            flex: "0 0 14px",
          }}
        />
      ))}
      <span style={{ display: "inline-flex", marginLeft: depth === 0 ? 8 : 0, gap: 6, alignItems: "center", minWidth: 0, flex: 1 }}>
        {isDir ? <ChevronIcon open={(node as DirNode).open} /> : <span style={{ display: "inline-block", width: 12 }} />}
        {isDir ? <FolderIcon open={(node as DirNode).open} /> : <FileIcon ext={node.entry.ext} />}
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: isDir ? 600 : 400,
            color: active ? "var(--ink)" : isDir ? "var(--ink)" : "var(--ink-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
          title={node.entry.path}
        >
          {node.entry.name}
        </span>
      </span>
      {isDir && (node as DirNode).loading && (
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>…</span>
      )}
    </div>
  );
}

function FileMenu({
  menu,
  onOpen,
  onRename,
  onDelete,
}: {
  menu: FileContextMenu;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const x = Math.min(menu.x, window.innerWidth - 236);
  const y = Math.min(menu.y, window.innerHeight - 226);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        zIndex: 100,
        left: Math.max(8, x),
        top: Math.max(8, y),
        width: 228,
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        boxShadow: "0 18px 50px rgba(0,0,0,0.48)",
        padding: 6,
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
        <FileIcon ext={menu.entry.ext} />
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
            {menu.entry.ext ? `${menu.entry.ext.toUpperCase()} file` : "file"}
          </span>
        </div>
      </div>
      <MenuButton icon="O" onClick={onOpen} hint="Enter">Open</MenuButton>
      <MenuButton icon="R" onClick={onRename}>Rename</MenuButton>
      <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
      <MenuButton icon="D" danger onClick={onDelete}>Delete</MenuButton>
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
          border: "1px solid var(--rule)",
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

function RenameDialog({
  entry,
  value,
  onChange,
  onClose,
  onSubmit,
}: {
  entry: FsEntry;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <DialogShell title="Rename file" onClose={onClose}>
      <div style={{ color: "var(--muted)", fontSize: 10, marginBottom: 8 }}>
        Update the file name in the current folder.
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape") onClose();
        }}
        style={{
          width: "100%",
          height: 30,
          background: "var(--bg)",
          color: "var(--ink)",
          border: "1px solid var(--accent-edge)",
          outline: "none",
          padding: "5px 8px",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      />
      <div style={{ color: "var(--muted)", fontSize: 9, marginTop: 7, overflowWrap: "anywhere" }}>
        {entry.path}
      </div>
      <DialogActions>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary onClick={onSubmit}>Rename</DialogButton>
      </DialogActions>
    </DialogShell>
  );
}

function DeleteDialog({
  entry,
  onClose,
  onConfirm,
}: {
  entry: FsEntry;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell title="Delete file" onClose={onClose}>
      <div style={{ color: "var(--ink-dim)", fontSize: 11, lineHeight: 1.45 }}>
        Move <b style={{ color: "var(--ink)" }}>{entry.name}</b> to the system trash?
      </div>
      <div style={{ color: "var(--muted)", fontSize: 9, marginTop: 8, overflowWrap: "anywhere" }}>
        {entry.path}
      </div>
      <DialogActions>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton danger onClick={onConfirm}>Delete</DialogButton>
      </DialogActions>
    </DialogShell>
  );
}

function DialogShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        background: "rgba(0,0,0,0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <section
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(360px, 100%)",
          background: "var(--panel-2)",
          border: "1px solid var(--rule-strong)",
          boxShadow: "0 20px 70px rgba(0,0,0,0.55)",
        }}
      >
        <div
          style={{
            height: 36,
            padding: "0 10px 0 12px",
            borderBottom: "1px solid var(--rule)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ color: "var(--ink)", fontSize: 11, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {title}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            title="Close"
            onClick={onClose}
            style={{
              appearance: "none",
              width: 22,
              height: 22,
              border: "1px solid var(--rule)",
              background: "var(--bg)",
              color: "var(--muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              cursor: "default",
            }}
          >
            <CloseIcon size={9} />
          </button>
        </div>
        <div style={{ padding: 12 }}>
          {children}
        </div>
      </section>
    </div>
  );
}

function DialogActions({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
      {children}
    </div>
  );
}

function DialogButton({
  children,
  primary,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        minWidth: 78,
        height: 28,
        border: `1px solid ${primary ? "var(--accent)" : danger ? "var(--danger)" : "var(--rule-strong)"}`,
        background: primary ? "var(--accent)" : "transparent",
        color: primary ? "var(--accent-ink)" : danger ? "var(--danger)" : "var(--ink-dim)",
        padding: "0 10px",
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 900,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "default",
      }}
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
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flex: "0 0 auto",
        color: "var(--ink)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        {title}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 400, color: "var(--muted)" }}>{right}</span>
    </div>
  );
}
