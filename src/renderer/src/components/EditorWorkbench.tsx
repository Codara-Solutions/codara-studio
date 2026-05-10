import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@shared/types";
import EditorPane from "./EditorPane";
import { CloseIcon, FileIcon } from "./icons";

// ── Layout tree ─────────────────────────────────────────────────────────────
type Layout = LeafGroup | SplitNode;

interface LeafGroup {
  kind: "leaf";
  id: string;
  fileIds: string[];
  activeFileId: string | null;
}

interface SplitNode {
  kind: "split";
  id: string;
  dir: "h" | "v";
  sizes: [number, number];
  children: [Layout, Layout];
}

type DropSide = "left" | "right" | "top" | "bottom" | "center";

interface DragState {
  fileId: string;
  fromGroupId: string;
}

interface Props {
  files: FsEntry[];
  activePath: string | null;
  onActivateFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}

let _idCounter = 0;
const newId = (prefix: string) => `${prefix}_${++_idCounter}`;

export default function EditorWorkbench({
  files,
  activePath,
  onActivateFile,
  onCloseFile,
}: Props) {
  const fileMap = useMemo(() => {
    const m = new Map<string, FsEntry>();
    for (const f of files) m.set(f.path, f);
    return m;
  }, [files]);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set());

  const onDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const has = prev.has(path);
      if (dirty === has) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  // Reconcile layout against the global openFiles list.
  useEffect(() => {
    setLayout((current) => reconcile(current, files, activePath, focusedGroupId));
  }, [files, activePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure a focused group exists; default to the first leaf.
  useEffect(() => {
    if (!layout) {
      if (focusedGroupId !== null) setFocusedGroupId(null);
      return;
    }
    const leaves = collectLeaves(layout);
    if (leaves.length === 0) return;
    if (!focusedGroupId || !leaves.some((l) => l.id === focusedGroupId)) {
      setFocusedGroupId(leaves[0].id);
    }
  }, [layout, focusedGroupId]);

  // When the parent's activePath points at a file living in a different group,
  // shift focus to whichever leaf already holds it (preserves "single source
  // of truth" between FileTree clicks and group focus).
  useEffect(() => {
    if (!layout || !activePath) return;
    const leaves = collectLeaves(layout);
    const leafWithFile = leaves.find((l) => l.fileIds.includes(activePath));
    if (!leafWithFile) return;
    if (focusedGroupId !== leafWithFile.id) {
      setFocusedGroupId(leafWithFile.id);
    }
    if (leafWithFile.activeFileId !== activePath) {
      setLayout((current) => (current ? mapLeaves(current, (l) =>
        l.id === leafWithFile.id ? { ...l, activeFileId: activePath } : l,
      ) : current));
    }
  }, [activePath, layout, focusedGroupId]);

  const handleTabActivate = useCallback(
    (groupId: string, fileId: string) => {
      setFocusedGroupId(groupId);
      setLayout((current) => (current ? mapLeaves(current, (l) =>
        l.id === groupId ? { ...l, activeFileId: fileId } : l,
      ) : current));
      onActivateFile(fileId);
    },
    [onActivateFile],
  );

  const handleTabClose = useCallback(
    (_groupId: string, fileId: string) => {
      // Closing a tab maps to closing the file globally — VSCode behavior when
      // a file lives in exactly one group at a time.
      onCloseFile(fileId);
    },
    [onCloseFile],
  );

  const handleDrop = useCallback(
    (targetGroupId: string, side: DropSide, dragged: DragState) => {
      setLayout((current) => {
        if (!current) return current;
        const next = applyDrop(current, targetGroupId, side, dragged);
        return next;
      });
      // Keep the dragged file as the active and focused after the move.
      const newGroupId = side === "center" ? targetGroupId : `__split_target_${targetGroupId}`;
      // The applyDrop result decides the actual new group id; we re-resolve on next tick.
      setTimeout(() => {
        setLayout((current) => {
          if (!current) return current;
          const leaves = collectLeaves(current);
          const owner = leaves.find((l) => l.fileIds.includes(dragged.fileId));
          if (!owner) return current;
          setFocusedGroupId(owner.id);
          return mapLeaves(current, (l) =>
            l.id === owner.id ? { ...l, activeFileId: dragged.fileId } : l,
          );
        });
        onActivateFile(dragged.fileId);
      }, 0);
      void newGroupId; // intentionally unused
    },
    [onActivateFile],
  );

  const updateSplitSizes = useCallback((splitId: string, sizes: [number, number]) => {
    setLayout((current) => (current ? mapSplits(current, (s) =>
      s.id === splitId ? { ...s, sizes } : s,
    ) : current));
  }, []);

  if (!layout || files.length === 0) {
    return <EmptyEditor />;
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
      }}
      onDragEnd={() => setDrag(null)}
    >
      <RenderLayout
        layout={layout}
        fileMap={fileMap}
        focusedGroupId={focusedGroupId}
        drag={drag}
        dirtyFiles={dirtyFiles}
        onActivate={handleTabActivate}
        onClose={handleTabClose}
        onDirtyChange={onDirtyChange}
        onDragStart={(d) => setDrag(d)}
        onDragEnd={() => setDrag(null)}
        onDrop={handleDrop}
        onResize={updateSplitSizes}
      />
    </div>
  );
}

// ── Reconciliation ──────────────────────────────────────────────────────────

function reconcile(
  current: Layout | null,
  files: FsEntry[],
  activePath: string | null,
  focusedGroupId: string | null,
): Layout | null {
  const openSet = new Set(files.map((f) => f.path));

  // Strip gone files from leaves; collapse empty leaves.
  let next = current;
  if (next) {
    next = pruneLayout(next, (id) => openSet.has(id));
  }

  // Compute the set of file ids already covered by leaves.
  const covered = new Set<string>();
  if (next) {
    for (const leaf of collectLeaves(next)) {
      for (const id of leaf.fileIds) covered.add(id);
    }
  }

  const newFiles = files.filter((f) => !covered.has(f.path));
  if (newFiles.length === 0) {
    return next;
  }

  if (!next) {
    // Initial population: one leaf with all files.
    return {
      kind: "leaf",
      id: newId("g"),
      fileIds: newFiles.map((f) => f.path),
      activeFileId: activePath && openSet.has(activePath) ? activePath : newFiles[newFiles.length - 1].path,
    };
  }

  // Append new files to the focused leaf if any, else first leaf.
  const leaves = collectLeaves(next);
  const target = leaves.find((l) => l.id === focusedGroupId) ?? leaves[0];
  return mapLeaves(next, (l) => {
    if (l.id !== target.id) return l;
    const fileIds = [...l.fileIds, ...newFiles.map((f) => f.path)];
    const activeFileId = activePath && openSet.has(activePath) && fileIds.includes(activePath)
      ? activePath
      : newFiles[newFiles.length - 1].path;
    return { ...l, fileIds, activeFileId };
  });
}

function pruneLayout(node: Layout, keep: (fileId: string) => boolean): Layout | null {
  if (node.kind === "leaf") {
    const fileIds = node.fileIds.filter(keep);
    if (fileIds.length === 0) return null;
    const activeFileId = node.activeFileId && fileIds.includes(node.activeFileId)
      ? node.activeFileId
      : fileIds[fileIds.length - 1];
    return { ...node, fileIds, activeFileId };
  }
  const left = pruneLayout(node.children[0], keep);
  const right = pruneLayout(node.children[1], keep);
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

function collectLeaves(node: Layout): LeafGroup[] {
  if (node.kind === "leaf") return [node];
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])];
}

function mapLeaves(node: Layout, fn: (l: LeafGroup) => LeafGroup): Layout {
  if (node.kind === "leaf") return fn(node);
  return {
    ...node,
    children: [mapLeaves(node.children[0], fn), mapLeaves(node.children[1], fn)] as [Layout, Layout],
  };
}

function mapSplits(node: Layout, fn: (s: SplitNode) => SplitNode): Layout {
  if (node.kind === "leaf") return node;
  const replaced = fn(node);
  return {
    ...replaced,
    children: [mapSplits(replaced.children[0], fn), mapSplits(replaced.children[1], fn)] as [Layout, Layout],
  };
}

function applyDrop(
  node: Layout,
  targetGroupId: string,
  side: DropSide,
  dragged: DragState,
): Layout {
  // Remove the dragged file from its source group first (with collapse).
  const removed = mapLeaves(node, (l) => {
    if (l.id !== dragged.fromGroupId) return l;
    const fileIds = l.fileIds.filter((id) => id !== dragged.fileId);
    const activeFileId = l.activeFileId === dragged.fileId
      ? (fileIds[fileIds.length - 1] ?? null)
      : l.activeFileId;
    return { ...l, fileIds, activeFileId };
  });
  // After removal a leaf may be empty. Don't drop empty leaves yet — we may
  // be dropping back into the same group. Handle empties post-insertion.

  // Insert into target.
  let inserted = removed;
  if (side === "center") {
    inserted = mapLeaves(removed, (l) => {
      if (l.id !== targetGroupId) return l;
      if (l.fileIds.includes(dragged.fileId)) {
        return { ...l, activeFileId: dragged.fileId };
      }
      return {
        ...l,
        fileIds: [...l.fileIds, dragged.fileId],
        activeFileId: dragged.fileId,
      };
    });
  } else {
    // Split the target leaf.
    inserted = transformLeaf(removed, targetGroupId, (target) => {
      const newLeaf: LeafGroup = {
        kind: "leaf",
        id: newId("g"),
        fileIds: [dragged.fileId],
        activeFileId: dragged.fileId,
      };
      const dir: "h" | "v" = side === "left" || side === "right" ? "h" : "v";
      const draggedFirst = side === "left" || side === "top";
      const split: SplitNode = {
        kind: "split",
        id: newId("s"),
        dir,
        sizes: [0.5, 0.5],
        children: draggedFirst ? [newLeaf, target] : [target, newLeaf],
      };
      return split;
    });
  }

  // Collapse any empty leaves left behind (source side).
  const cleaned = pruneLayout(inserted, () => true); // pruneLayout drops nothing since keep is true; we need a different sweep.
  return cleaned ? collapseEmpty(cleaned) : inserted;
}

function transformLeaf(
  node: Layout,
  targetId: string,
  fn: (leaf: LeafGroup) => Layout,
): Layout {
  if (node.kind === "leaf") {
    if (node.id === targetId) return fn(node);
    return node;
  }
  return {
    ...node,
    children: [
      transformLeaf(node.children[0], targetId, fn),
      transformLeaf(node.children[1], targetId, fn),
    ] as [Layout, Layout],
  };
}

function collapseEmpty(node: Layout): Layout {
  if (node.kind === "leaf") return node;
  const left = collapseEmpty(node.children[0]);
  const right = collapseEmpty(node.children[1]);
  const leftEmpty = left.kind === "leaf" && left.fileIds.length === 0;
  const rightEmpty = right.kind === "leaf" && right.fileIds.length === 0;
  if (leftEmpty && rightEmpty) {
    // Both empty — return one of the empty leaves; outer pass will remove.
    return left;
  }
  if (leftEmpty) return right;
  if (rightEmpty) return left;
  return { ...node, children: [left, right] };
}

// ── Rendering ───────────────────────────────────────────────────────────────

interface RenderProps {
  layout: Layout;
  fileMap: Map<string, FsEntry>;
  focusedGroupId: string | null;
  drag: DragState | null;
  dirtyFiles: Set<string>;
  onActivate: (groupId: string, fileId: string) => void;
  onClose: (groupId: string, fileId: string) => void;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onDragStart: (d: DragState) => void;
  onDragEnd: () => void;
  onDrop: (targetGroupId: string, side: DropSide, dragged: DragState) => void;
  onResize: (splitId: string, sizes: [number, number]) => void;
}

function RenderLayout(props: RenderProps) {
  const { layout } = props;
  if (layout.kind === "leaf") {
    return <Group group={layout} {...props} />;
  }
  return <Split node={layout} {...props} />;
}

function Split(props: RenderProps & { node: SplitNode }) {
  const { node, onResize } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const isHorizontal = node.dir === "h";

  const onSplitterDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = ref.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = isHorizontal ? rect.width : rect.height;
      const start = isHorizontal ? rect.left : rect.top;
      const onMove = (ev: MouseEvent) => {
        const pos = (isHorizontal ? ev.clientX : ev.clientY) - start;
        let frac = pos / total;
        frac = Math.max(0.1, Math.min(0.9, frac));
        onResize(node.id, [frac, 1 - frac]);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [isHorizontal, node.id, onResize],
  );

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: `${node.sizes[0]} 1 0`,
          display: "flex",
          minWidth: 0,
          minHeight: 0,
          flexDirection: "column",
        }}
      >
        <RenderLayout {...props} layout={node.children[0]} />
      </div>
      <div
        onMouseDown={onSplitterDown}
        style={{
          flex: "0 0 1px",
          background: "var(--rule)",
          cursor: isHorizontal ? "col-resize" : "row-resize",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: isHorizontal ? "0 -3px" : "-3px 0",
          }}
        />
      </div>
      <div
        style={{
          flex: `${node.sizes[1]} 1 0`,
          display: "flex",
          minWidth: 0,
          minHeight: 0,
          flexDirection: "column",
        }}
      >
        <RenderLayout {...props} layout={node.children[1]} />
      </div>
    </div>
  );
}

function Group(props: RenderProps & { group: LeafGroup }) {
  const {
    group,
    fileMap,
    focusedGroupId,
    drag,
    dirtyFiles,
    onActivate,
    onClose,
    onDirtyChange,
    onDragStart,
    onDragEnd,
    onDrop,
  } = props;
  const isFocused = focusedGroupId === group.id;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverSide, setHoverSide] = useState<DropSide | null>(null);

  const onContainerDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const margin = 0.25;
      let side: DropSide = "center";
      // Use the closest edge, but only if within the margin.
      const dl = x;
      const dr = 1 - x;
      const dt = y;
      const db = 1 - y;
      const min = Math.min(dl, dr, dt, db);
      if (min < margin) {
        if (min === dl) side = "left";
        else if (min === dr) side = "right";
        else if (min === dt) side = "top";
        else side = "bottom";
      }
      setHoverSide(side);
    },
    [drag],
  );

  const onContainerDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the group container itself, not nested children.
    if (e.currentTarget === e.target) setHoverSide(null);
  }, []);

  const onContainerDrop = useCallback(
    (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      const side = hoverSide ?? "center";
      setHoverSide(null);
      onDrop(group.id, side, drag);
    },
    [drag, group.id, hoverSide, onDrop],
  );

  return (
    <div
      ref={containerRef}
      onDragOver={onContainerDragOver}
      onDragLeave={onContainerDragLeave}
      onDrop={onContainerDrop}
      onMouseDown={() => {
        // Focus group on click in body.
      }}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
        background: "var(--bg)",
      }}
    >
      <TabBar
        group={group}
        fileMap={fileMap}
        isFocused={isFocused}
        dirtyFiles={dirtyFiles}
        onActivate={(fileId) => onActivate(group.id, fileId)}
        onClose={(fileId) => onClose(group.id, fileId)}
        onDragStart={(fileId) => onDragStart({ fileId, fromGroupId: group.id })}
        onDragEnd={onDragEnd}
      />

      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {group.fileIds.map((fileId) => {
          const file = fileMap.get(fileId);
          if (!file) return null;
          const visible = fileId === group.activeFileId;
          return (
            <div
              key={fileId}
              style={{
                position: "absolute",
                inset: 0,
                display: visible ? "flex" : "none",
                flexDirection: "column",
                minHeight: 0,
              }}
              onMouseDown={() => onActivate(group.id, fileId)}
            >
              <EditorPane file={file} onDirtyChange={onDirtyChange} />
            </div>
          );
        })}
      </div>

      {drag && hoverSide && <DropOverlay side={hoverSide} />}
    </div>
  );
}

function TabBar({
  group,
  fileMap,
  isFocused,
  dirtyFiles,
  onActivate,
  onClose,
  onDragStart,
  onDragEnd,
}: {
  group: LeafGroup;
  fileMap: Map<string, FsEntry>;
  isFocused: boolean;
  dirtyFiles: Set<string>;
  onActivate: (fileId: string) => void;
  onClose: (fileId: string) => void;
  onDragStart: (fileId: string) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      style={{
        height: 35,
        flex: "0 0 35px",
        display: "flex",
        alignItems: "stretch",
        background: "var(--panel)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          overflowX: "auto",
          overflowY: "hidden",
          flex: 1,
          minWidth: 0,
        }}
      >
        {group.fileIds.map((fileId) => {
          const file = fileMap.get(fileId);
          if (!file) return null;
          return (
            <Tab
              key={fileId}
              file={file}
              isActive={fileId === group.activeFileId}
              isPaneFocused={isFocused}
              isDirty={dirtyFiles.has(fileId)}
              onActivate={() => onActivate(fileId)}
              onClose={() => onClose(fileId)}
              onDragStart={() => onDragStart(fileId)}
              onDragEnd={onDragEnd}
            />
          );
        })}
      </div>
    </div>
  );
}

function Tab({
  file,
  isActive,
  isPaneFocused,
  isDirty,
  onActivate,
  onClose,
  onDragStart,
  onDragEnd,
}: {
  file: FsEntry;
  isActive: boolean;
  isPaneFocused: boolean;
  isDirty: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [closeHover, setCloseHover] = useState(false);

  const background = isActive
    ? "var(--bg)"
    : hover
      ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
      : "var(--panel)";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", file.path);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        e.stopPropagation();
        onActivate();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      title={file.path}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 35,
        padding: "0 10px 0 12px",
        background,
        color: isActive ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        fontWeight: 400,
        cursor: "default",
        borderRight: "1px solid var(--rule-soft)",
        flex: "0 0 auto",
        maxWidth: 240,
        minWidth: 0,
      }}
    >
      {isActive && isPaneFocused && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: "var(--accent)",
          }}
        />
      )}
      <span style={{ display: "inline-flex", alignItems: "center", color: "var(--ink-dim)", flex: "0 0 auto" }}>
        <FileIcon ext={file.ext} />
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {file.name}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onMouseEnter={() => setCloseHover(true)}
        onMouseLeave={() => setCloseHover(false)}
        title="Close"
        style={{
          appearance: "none",
          width: 18,
          height: 18,
          border: "none",
          borderRadius: 3,
          background: closeHover ? "var(--hover)" : "transparent",
          color: closeHover ? "var(--ink)" : isActive || hover ? "var(--ink-dim)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          flex: "0 0 18px",
        }}
      >
        {isDirty && !closeHover ? (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: "var(--ink-dim)",
              display: "inline-block",
            }}
          />
        ) : (
          <CloseIcon size={11} />
        )}
      </button>
    </div>
  );
}

function DropOverlay({ side }: { side: DropSide }) {
  const base: React.CSSProperties = {
    position: "absolute",
    background: "color-mix(in oklch, var(--accent) 18%, transparent)",
    border: "1px solid color-mix(in oklch, var(--accent) 45%, transparent)",
    pointerEvents: "none",
    transition: "all 80ms var(--ease-out)",
    zIndex: 3,
  };
  switch (side) {
    case "left":
      return <div style={{ ...base, top: 0, left: 0, bottom: 0, width: "50%" }} />;
    case "right":
      return <div style={{ ...base, top: 0, right: 0, bottom: 0, width: "50%" }} />;
    case "top":
      return <div style={{ ...base, top: 0, left: 0, right: 0, height: "50%" }} />;
    case "bottom":
      return <div style={{ ...base, bottom: 0, left: 0, right: 0, height: "50%" }} />;
    case "center":
    default:
      return <div style={{ ...base, inset: 0 }} />;
  }
}

function EmptyEditor() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        fontWeight: 400,
      }}
    >
      No file open
    </div>
  );
}
