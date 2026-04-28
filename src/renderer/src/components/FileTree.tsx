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
}

export default function FileTree({ cwd }: Props) {
  const [root, setRoot] = useState<DirNode & { kind: "dir" }>(() => makeDir({ name: basename(cwd), path: cwd, isDir: true }, true));
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
        flex: "1 1 0",
      }}
    >
      <PanelHeader title="EXPLORER" right={<span style={{ color: "var(--muted)" }}>{basename(cwd)}</span>} />
      <div style={{ padding: "6px 0", overflow: "auto", flex: 1 }}>
        {flatRef.current.map((row, i) => (
          <Row
            key={row.node.entry.path + i}
            node={row.node}
            depth={row.depth}
            onToggle={() => toggleDir(row.node as DirNode & { kind: "dir" })}
          />
        ))}
      </div>
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

async function loadDir(path: string): Promise<Node[]> {
  const entries = await window.spark.fs.list(path);
  return entries.map((e): Node =>
    e.isDir ? makeDir(e, false) : { kind: "file", entry: e },
  );
}

function Row({ node, depth, onToggle }: { node: Node; depth: number; onToggle: () => void }) {
  const isDir = node.kind === "dir";
  return (
    <div
      onClick={isDir ? onToggle : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 12px 3px 0",
        paddingLeft: 12 + depth * 14,
        color: "var(--ink-dim)",
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
