import React, { useEffect, useMemo, useState } from "react";
import type { GitBranch, GitBranchList, Workspace } from "@shared/types";
import {
  BranchIcon,
  Caret,
  Count,
  Empty,
  GroupLabel,
  IconButton,
  Spinner,
  shortenRelative,
} from "./git/git-ui";

// Branch picker for the "Create copy" workspace action. Lists the source
// repo's local + remote branches; a row click opens that exact branch as a new
// worktree workspace, the hover action forks a fresh auto-named copy from it,
// and the top button keeps the classic behavior (fork from the default
// branch). Renders immediately from local refs, then re-reads once after a
// background `git fetch --prune` so remote rows reflect the actual remote.

export default function CreateCopyDialog({
  workspace,
  busy,
  error,
  onDismissError,
  onClose,
  onCreateDefault,
  onOpenBranch,
  onForkFromBranch,
}: {
  workspace: Workspace;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onClose: () => void;
  onCreateDefault: () => void;
  onOpenBranch: (branch: GitBranch) => void;
  onForkFromBranch: (branch: GitBranch) => void;
}): React.ReactElement {
  const [list, setList] = useState<GitBranchList | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [filter, setFilter] = useState("");
  const [remotesOpen, setRemotesOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const cwd = workspace.cwd;
    void window.spark.git.branches(cwd).then((next) => {
      if (!cancelled) setList(next);
    });
    // Freshness pass: remote-tracking refs are only as new as the last fetch,
    // so kick one off and re-read. Failures (offline, no remote) are fine —
    // the local-refs snapshot above already rendered.
    setRefreshing(true);
    void window.spark.git
      .fetch(cwd)
      .catch(() => undefined)
      .then(() => window.spark.git.branches(cwd))
      .then((next) => {
        if (!cancelled && next) setList(next);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.cwd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const local = list?.local ?? [];
  const remote = list?.remote ?? [];

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (b: GitBranch): boolean => !q || b.name.toLowerCase().includes(q);
    return { local: local.filter(match), remote: remote.filter(match) };
  }, [filter, local, remote]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Create copy of ${workspace.name}`}
      style={{
        position: "absolute",
        inset: 0,
        background: "color-mix(in oklch, var(--bg) 70%, transparent)",
        display: "grid",
        placeItems: "center",
        zIndex: 1200,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          width: "min(460px, calc(100vw - 48px))",
          maxHeight: "min(560px, calc(100vh - 96px))",
          background: "var(--panel-2)",
          border: "1px solid var(--rule)",
          borderRadius: 10,
          boxShadow: "var(--shadow-2)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ padding: "16px 18px 0", display: "grid", gap: 4 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
              fontWeight: 700,
              color: "var(--ink)",
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>Create copy of “{workspace.name}”</span>
            {busy && <Spinner size={12} />}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5 }}>
            Open an existing branch as a workspace, or start a fresh copy.
          </div>
        </div>

        {/* Classic behavior, promoted to the top */}
        <div style={{ padding: "12px 18px 0" }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCreateDefault}
            title="Create a new auto-named branch from the repo's default branch"
            style={{
              appearance: "none",
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 10px",
              border: "1px solid var(--accent-edge)",
              borderRadius: 8,
              background: "color-mix(in oklch, var(--accent) 10%, transparent)",
              color: "var(--ink)",
              cursor: "default",
              textAlign: "left",
              opacity: busy ? 0.6 : 1,
            }}
          >
            <span style={{ display: "inline-flex", color: "var(--accent)" }}>
              <BranchIcon />
            </span>
            <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>New copy on a fresh branch</span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                Auto-named, branched from the default branch
              </span>
            </span>
          </button>
        </div>

        {/* Filter */}
        <div style={{ padding: "10px 18px 8px" }}>
          <input
            autoFocus
            value={filter}
            placeholder="Filter branches…"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter) {
                e.stopPropagation();
                setFilter("");
              }
            }}
            style={{
              appearance: "none",
              width: "100%",
              height: 26,
              padding: "0 8px",
              background: "var(--bg)",
              border: "1px solid var(--rule)",
              borderRadius: 6,
              boxShadow: "var(--well)",
              color: "var(--ink)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              outline: "none",
            }}
          />
        </div>

        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              margin: "0 18px 8px",
              padding: "8px 10px",
              fontSize: 12,
              color: "var(--danger)",
              background: "color-mix(in oklch, var(--danger) 12%, transparent)",
              border: "1px solid color-mix(in oklch, var(--danger) 40%, var(--rule))",
              borderRadius: 6,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{error}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismissError}
              style={{
                appearance: "none",
                border: "none",
                background: "transparent",
                color: "var(--danger)",
                cursor: "default",
                fontSize: 12,
                lineHeight: 1,
                padding: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Branch list */}
        <div
          style={{
            overflowY: "auto",
            overflowX: "hidden",
            flex: 1,
            minHeight: 0,
            borderTop: "1px solid var(--rule-soft)",
            paddingBottom: 6,
          }}
        >
          {list === null ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
              <Spinner size={11} />
              <span style={{ fontSize: 11, color: "var(--muted)" }}>Reading branches…</span>
            </div>
          ) : !list.isRepo ? (
            <Empty text="Not a git repository." />
          ) : (
            <>
              <GroupLabel text="Local" count={local.length} />
              {filtered.local.length === 0 ? (
                <Empty text={filter ? "No matches." : "No local branches."} />
              ) : (
                filtered.local.map((branch) => (
                  <CopyBranchRow
                    key={`l:${branch.name}`}
                    branch={branch}
                    locked={busy}
                    onOpen={onOpenBranch}
                    onFork={onForkFromBranch}
                  />
                ))
              )}

              <button
                type="button"
                onClick={() => setRemotesOpen((v) => !v)}
                style={{
                  appearance: "none",
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  height: 24,
                  padding: "0 10px",
                  marginTop: 2,
                  border: "none",
                  borderTop: "1px solid var(--rule)",
                  background: "transparent",
                  color: "var(--muted)",
                  cursor: "default",
                  textAlign: "left",
                }}
              >
                <Caret open={remotesOpen} />
                <span
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    fontWeight: 800,
                    textTransform: "uppercase",
                  }}
                >
                  Remote
                </span>
                {refreshing && <Spinner size={9} />}
                <span style={{ flex: 1 }} />
                <Count value={remote.length} />
              </button>
              {remotesOpen &&
                (filtered.remote.length === 0 ? (
                  <Empty
                    text={
                      filter ? "No matches." : refreshing ? "Fetching…" : "No remote branches."
                    }
                  />
                ) : (
                  filtered.remote.map((branch) => (
                    <CopyBranchRow
                      key={`r:${branch.name}`}
                      branch={branch}
                      locked={busy}
                      onOpen={onOpenBranch}
                      onFork={onForkFromBranch}
                    />
                  ))
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── One branch row ───────────────────────────────────────────────────────────
// Click = open the branch itself as a new workspace; hover action = fork a new
// auto-named copy from it. Branches that are already checked out somewhere
// (branch.worktreePath — git forbids a second checkout) keep only the fork
// action.

const CopyBranchRow = React.memo(function CopyBranchRow({
  branch,
  locked,
  onOpen,
  onFork,
}: {
  branch: GitBranch;
  locked: boolean;
  onOpen: (b: GitBranch) => void;
  onFork: (b: GitBranch) => void;
}) {
  const [hover, setHover] = useState(false);
  const inUse = Boolean(branch.worktreePath);
  const short = branch.isRemote ? branch.name.replace(/^[^/]+\//, "") : branch.name;
  const remotePrefix = branch.isRemote
    ? branch.name.slice(0, branch.name.length - short.length)
    : "";

  const title = inUse
    ? `Already checked out at ${branch.worktreePath} — fork a copy instead`
    : branch.isRemote
      ? `Open ${branch.name} as a new workspace (creates local branch ${short})${
          branch.lastCommitSubject ? `\n${branch.lastCommitSubject}` : ""
        }`
      : `Open ${branch.name} as a new workspace${
          branch.lastCommitSubject ? `\n${branch.lastCommitSubject}` : ""
        }`;

  return (
    <div
      onClick={() => {
        if (!locked && !inUse) onOpen(branch);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minHeight: 26,
        padding: "0 10px 0 14px",
        cursor: "default",
        background:
          hover && !inUse ? "color-mix(in oklch, var(--ink) 5%, transparent)" : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          width: 14,
          color: inUse ? "var(--muted-2)" : "var(--muted)",
        }}
      >
        <BranchIcon />
      </span>

      <span
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          alignItems: "baseline",
          gap: 4,
          overflow: "hidden",
          opacity: inUse ? 0.55 : 1,
        }}
      >
        {remotePrefix && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted-2)",
              flex: "0 0 auto",
            }}
          >
            {remotePrefix}
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--ink-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {short}
        </span>
      </span>

      {inUse && !hover && (
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--muted-2)",
          }}
        >
          in use
        </span>
      )}

      {!hover && branch.lastCommitRelativeDate && (
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
            color: "var(--muted-2)",
          }}
        >
          {shortenRelative(branch.lastCommitRelativeDate)}
        </span>
      )}

      <span
        onClick={(e) => e.stopPropagation()}
        style={{ display: "inline-flex", alignItems: "center", flex: "0 0 auto" }}
      >
        {hover && !locked ? (
          <IconButton
            title={`Fork a new auto-named copy from ${branch.name}`}
            size={20}
            onClick={() => onFork(branch)}
          >
            <ForkGlyph />
          </IconButton>
        ) : null}
      </span>
    </div>
  );
});

// Fork glyph: a commit splitting into two heads — distinct from BranchIcon so
// the row's two actions read differently at a glance.
function ForkGlyph(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7" cy="11" r="1.5" />
      <circle cx="3.5" cy="3.5" r="1.5" />
      <circle cx="10.5" cy="3.5" r="1.5" />
      <path d="M3.5 5c0 2 1.4 2.8 3.5 3 2.1-.2 3.5-1 3.5-3" />
      <path d="M7 8v1.5" />
    </svg>
  );
}
