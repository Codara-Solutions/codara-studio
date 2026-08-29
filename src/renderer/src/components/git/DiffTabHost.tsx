import React, { useEffect, useMemo, useState } from "react";
import type { GitDiff, GitFileChange, GitStatus } from "@shared/types";
import DiffView from "./DiffView";

interface Props {
  cwd: string;
  /** Repo-relative path (forward slashes) — the DiffTab identity. */
  path: string;
  staged: boolean;
  /** Set = show this file's diff inside that commit (read-only). */
  commitHash?: string;
  /** Live shared status — untracked/renamed/gone are derived per render. */
  status: GitStatus | null;
  /** Bumped after every app-side git mutation; triggers a diff refetch. */
  gitVersion: number;
  onOpenFile: (absolutePath: string) => void;
  onChanged: () => void;
  onClose: () => void;
}

// Hosts one diff tab: what used to be GitPanel's inline diff-loading state,
// now per-tab so several diffs stay open at once (VS Code-style). Two modes:
//
// Working-tree mode — identity is (path, staged); everything else is looked
// up live in the shared GitStatus, so a file that gets committed, discarded
// or renamed while its tab is open degrades to DiffView's calm "No changes"
// state (plus a rename note) instead of crashing or freezing stale content.
//
// Commit mode (commitHash set) — identity is (path, commitHash); the diff is
// immutable history fetched once via git.commitFileDiff, rendered read-only
// (no hunk staging; a commit's diff has no working/staged side to act on).
export default function DiffTabHost({
  cwd,
  path,
  staged,
  commitHash,
  status,
  gitVersion,
  onOpenFile,
  onChanged,
  onClose,
}: Props): React.ReactElement {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(false);

  // Live lookup: is this (path, staged) still a change? A rename shows up as
  // a change whose oldPath is our path. Commit tabs skip this — history is
  // immutable, so there is nothing to reconcile against the working tree.
  const { change, renamedTo } = useMemo((): {
    change: GitFileChange | null;
    renamedTo: string | null;
  } => {
    if (commitHash) return { change: null, renamedTo: null };
    const list = staged ? status?.staged : status?.unstaged;
    if (!list) return { change: null, renamedTo: null };
    const direct = list.find((f) => f.path === path) ?? null;
    if (direct) return { change: direct, renamedTo: null };
    const renamed = list.find((f) => f.oldPath === path) ?? null;
    return { change: null, renamedTo: renamed?.path ?? null };
  }, [status, path, staged, commitHash]);
  const untracked = change?.untracked ?? false;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (commitHash
      ? window.spark.git.commitFileDiff(cwd, commitHash, path)
      : window.spark.git.diff(cwd, path, staged, untracked)
    )
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setDiff({ path, binary: false, lines: [], error: err.message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // gitVersion in deps so the open diff reloads after a partial stage /
    // unstage / discard (the working or staged side changed underneath it).
    // Harmless for commit tabs: the refetch returns identical content.
  }, [cwd, path, staged, untracked, gitVersion, commitHash]);

  const openFileInEditor = () => {
    const sep = cwd.includes("\\") ? "\\" : "/";
    const base = cwd.replace(/[\\/]+$/, "");
    onOpenFile(base + sep + path.replace(/\//g, sep));
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "auto",
        background: "var(--bg)",
      }}
    >
      {renamedTo && (
        <div
          style={{
            flex: "0 0 auto",
            padding: "5px 12px",
            fontSize: 11,
            color: "var(--muted)",
            background: "color-mix(in oklch, var(--info) 8%, var(--panel))",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          This file was renamed to <span style={{ color: "var(--ink-dim)" }}>{renamedTo}</span> —
          open its diff from Source Control.
        </div>
      )}
      <DiffView
        path={path}
        staged={staged}
        untracked={untracked}
        commitHash={commitHash}
        cwd={cwd}
        diff={diff}
        loading={loading}
        onBack={onClose}
        onOpenFile={openFileInEditor}
        onChanged={onChanged}
      />
    </div>
  );
}
