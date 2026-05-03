import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon } from "./icons";
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
      await reloadDirInPlace(dir);
      setError(null);
    } catch (err) {
      dir.error = (err as Error).message;
      setError((err as Error).message);
    } finally {
      dir.loading = false;
      force((n) => n + 1);
    }
  }, [root]);

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
            branches={row.branches}
            isLast={row.isLast}
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
  branches: boolean[];
  isLast: boolean;
}

function flatten(node: Node, depth: number, branches: boolean[] = [], isLast = true): FlatRow[] {
  const out: FlatRow[] = [{ node, depth, branches, isLast }];
  if (node.kind === "dir" && node.open) {
    const childBranches = depth === 0 ? [] : [...branches, !isLast];
    node.children.forEach((child, index) => {
      out.push(...flatten(child, depth + 1, childBranches, index === node.children.length - 1));
    });
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

function Row({
  node,
  depth,
  branches,
  isLast,
  active,
  onToggle,
  onOpenFile,
  onFileContextMenu,
}: {
  node: Node;
  depth: number;
  branches: boolean[];
  isLast: boolean;
  active: boolean;
  onToggle: () => void;
  onOpenFile: (entry: FsEntry) => void;
  onFileContextMenu: (entry: FsEntry, x: number, y: number) => void;
}) {
  const isDir = node.kind === "dir";
  const [hover, setHover] = useState(false);
  const activeBg = "color-mix(in oklch, var(--ink) 4%, var(--panel))";
  const dirNode = isDir ? (node as DirNode & { kind: "dir" }) : null;
  const connectorColor = active
    ? "color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
    : "var(--rule-soft)";
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
        gap: 0,
        minHeight: 29,
        padding: "0 9px 0 0",
        margin: "0 8px 3px",
        background: active
          ? activeBg
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "transparent",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 45%, var(--rule-strong))"
          : "1px solid transparent",
        borderRadius: 7,
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 14%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : hover
            ? "inset 0 1px 0 rgba(255, 255, 255, 0.03)"
            : "none",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "stretch",
          height: 29,
          marginLeft: depth === 0 ? 7 : 2,
          flex: "0 0 auto",
        }}
      >
        {branches.map((continues, index) => (
          <TreeGuide key={index} continues={continues} color="var(--rule-soft)" />
        ))}
        {depth > 0 && <TreeElbow isLast={isLast} color={connectorColor} />}
      </span>

      <button
        type="button"
        onClick={(event) => {
          if (!isDir) return;
          event.stopPropagation();
          onToggle();
        }}
        title={isDir ? (dirNode?.open ? "Collapse folder" : "Expand folder") : undefined}
        tabIndex={isDir ? 0 : -1}
        style={{
          appearance: "none",
          width: 16,
          height: 22,
          border: "none",
          background: "transparent",
          color: isDir ? "var(--muted)" : "transparent",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          marginRight: 4,
          cursor: "default",
          flex: "0 0 16px",
        }}
      >
        {isDir && <ChevronIcon open={Boolean(dirNode?.open)} />}
      </button>

      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0, flex: 1 }}>
        {isDir ? <FolderIcon open={Boolean(dirNode?.open)} /> : <FileIcon ext={node.entry.ext} />}
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 12,
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
      {isDir && dirNode?.loading && (
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>…</span>
      )}
    </div>
  );
}

function TreeGuide({ continues, color }: { continues: boolean; color: string }) {
  return (
    <span
      style={{
        width: 16,
        height: "100%",
        position: "relative",
        flex: "0 0 16px",
      }}
    >
      {continues && (
        <span
          style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: 0,
            width: 1,
            background: color,
            opacity: 0.82,
          }}
        />
      )}
    </span>
  );
}

function TreeElbow({ isLast, color }: { isLast: boolean; color: string }) {
  return (
    <span
      style={{
        width: 17,
        height: "100%",
        position: "relative",
        flex: "0 0 17px",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 7,
          top: 0,
          bottom: isLast ? "50%" : 0,
          width: 1,
          background: color,
          opacity: 0.9,
        }}
      />
      <span
        style={{
          position: "absolute",
          left: 7,
          top: "50%",
          width: 10,
          height: 1,
          background: color,
          opacity: 0.9,
        }}
      />
    </span>
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
          borderRadius: 7,
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
          borderRadius: 10,
          boxShadow: "0 20px 70px rgba(0,0,0,0.55)",
          overflow: "hidden",
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
              borderRadius: 999,
              background: "transparent",
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
        borderRadius: 999,
        background: "transparent",
        color: primary ? "var(--ink)" : danger ? "var(--danger)" : "var(--ink-dim)",
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
        padding: "10px 10px 8px 14px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: 7,
        flex: "0 0 auto",
        color: "var(--muted)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontWeight: 700,
        }}
      >
        {title}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
      <span
        style={{
          maxWidth: 128,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 400,
          color: "var(--muted)",
        }}
      >
        {right}
      </span>
    </div>
  );
}
