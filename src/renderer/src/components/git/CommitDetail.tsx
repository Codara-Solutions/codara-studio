import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommitDetail, GitCommitFile, GitDiff, GitDiffLineKind } from "@shared/types";
import {
  BackIcon,
  CopyIcon,
  IconButton,
  Spinner,
  splitPath,
  statusColor,
  statusGlyph,
  statusLabel,
} from "./git-ui";

interface Props {
  cwd: string;
  hash: string;
  onClose: () => void;
}

// Per-line treatment for a diff line — mirrors DiffView's palette so a commit's
// diffs read identically to working-tree diffs. (DiffView is another agent's
// file, so the model is duplicated rather than imported.)
const LINE_STYLE: Record<GitDiffLineKind, React.CSSProperties> = {
  add: {
    background: "color-mix(in oklch, var(--ok) 13%, transparent)",
    color: "color-mix(in oklch, var(--ok) 64%, var(--ink))",
  },
  del: {
    background: "color-mix(in oklch, var(--danger) 13%, transparent)",
    color: "color-mix(in oklch, var(--danger) 70%, var(--ink))",
  },
  hunk: {
    background: "color-mix(in oklch, var(--info) 9%, transparent)",
    color: "var(--info)",
  },
  meta: { color: "var(--muted-2)" },
  context: { color: "var(--ink-dim)" },
};

// Commit inspection view. Loads the commit's metadata + changed-file list via
// window.spark.git.commitDetail, then lazily fetches each file's diff via
// window.spark.git.commitFileDiff as the file is expanded. Mounted inline by
// GitPanel (replacing the panel body) when a commit is opened from the History
// section's row click / "View Changes" menu item.
export default function CommitDetail({ cwd, hash, onClose }: Props): React.ReactElement {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Which file rows are expanded to show their diff.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setExpanded(new Set());
    window.spark.git
      .commitDetail(cwd, hash)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDetail(result.detail);
        else setError(result.error);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, hash]);

  const files = detail?.files ?? [];
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { additions, deletions };
  }, [files]);

  const allExpanded = files.length > 0 && expanded.size === files.length;

  const toggleFile = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setExpanded((prev) =>
      prev.size === files.length ? new Set() : new Set(files.map((f) => f.path)),
    );
  }, [files]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          flex: "0 0 auto",
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 6px 0 4px",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <IconButton title="Back to history" onClick={onClose} size={22}>
          <BackIcon />
        </IconButton>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)" }}>
          {detail?.shortHash ?? hash.slice(0, 7)}
        </span>
        <span
          title={detail?.subject}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            color: "var(--ink-dim)",
          }}
        >
          {detail?.subject ?? ""}
        </span>
        {loading && <Spinner size={11} />}
        {detail && files.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            title={allExpanded ? "Collapse all files" : "Expand all files"}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--ink-dim)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--muted)";
            }}
            style={{
              appearance: "none",
              flex: "0 0 auto",
              border: "none",
              background: "transparent",
              cursor: "default",
              padding: "2px 5px",
              borderRadius: 5,
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--muted)",
              transition: "color var(--motion-fast) var(--ease-out)",
            }}
          >
            {allExpanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        {error ? (
          <div style={{ padding: "14px", color: "var(--danger)", fontSize: 11 }}>{error}</div>
        ) : detail ? (
          <>
            <CommitMeta detail={detail} totals={totals} />
            <div style={{ padding: "4px 0 8px" }}>
              {files.length === 0 ? (
                <div style={{ padding: "8px 14px", color: "var(--muted)", fontSize: 11 }}>
                  No file changes in this commit.
                </div>
              ) : (
                files.map((file) => (
                  <FileEntry
                    key={file.path}
                    cwd={cwd}
                    hash={hash}
                    file={file}
                    expanded={expanded.has(file.path)}
                    onToggle={() => toggleFile(file.path)}
                  />
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// Metadata block: author / date / parents, plus the full (multi-line) message
// body and a total +/- tally.
function CommitMeta({
  detail,
  totals,
}: {
  detail: GitCommitDetail;
  totals: { additions: number; deletions: number };
}): React.ReactElement {
  const isMerge = detail.parentHashes.length > 1;
  const [copied, setCopied] = useState(false);

  const copyHash = (): void => {
    void navigator.clipboard?.writeText(detail.hash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      style={{
        padding: "10px 12px 8px",
        borderBottom: "1px solid var(--rule-soft)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          lineHeight: 1.35,
          wordBreak: "break-word",
        }}
      >
        {detail.subject || "(no message)"}
      </div>

      {detail.body && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            lineHeight: 1.5,
            color: "var(--ink-dim)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          {detail.body}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "2px 8px",
          fontSize: 10.5,
          color: "var(--muted)",
        }}
      >
        <span style={{ color: "var(--ink-dim)" }} title={detail.authorEmail}>
          {detail.author || "unknown"}
        </span>
        <Dot />
        <span title={detail.isoDate}>{detail.relativeDate}</span>
        <Dot />
        <span>
          {detail.files.length} file{detail.files.length === 1 ? "" : "s"}
        </span>
        {(totals.additions > 0 || totals.deletions > 0) && (
          <>
            <Dot />
            <span style={{ fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--ok)" }}>+{totals.additions}</span>{" "}
              <span style={{ color: "var(--danger)" }}>-{totals.deletions}</span>
            </span>
          </>
        )}
        {isMerge && (
          <>
            <Dot />
            <span
              title={detail.parentHashes.join("  ")}
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--info)",
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Merge · {detail.parentHashes.length} parents
            </span>
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          title={detail.hash}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--muted-2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {detail.hash}
        </span>
        <IconButton
          title={copied ? "Copied" : "Copy full hash"}
          onClick={copyHash}
          active={copied}
          size={18}
        >
          <CopyIcon />
        </IconButton>
      </div>
    </div>
  );
}

function Dot(): React.ReactElement {
  return <span style={{ color: "var(--muted-2)", opacity: 0.7 }}>·</span>;
}

// One changed file: a clickable header (status glyph + name + dir + counts)
// that drills down into the file's diff, fetched lazily on first expand.
const FileEntry = React.memo(function FileEntry({
  cwd,
  hash,
  file,
  expanded,
  onToggle,
}: {
  cwd: string;
  hash: string;
  file: GitCommitFile;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  // Remember if we've already kicked off the fetch so re-expanding is instant.
  const requested = useRef(false);
  const { dir, name } = splitPath(file.path);
  const color = statusColor(file.status);

  useEffect(() => {
    if (!expanded || requested.current) return;
    requested.current = true;
    let cancelled = false;
    setLoading(true);
    window.spark.git
      .commitFileDiff(cwd, hash, file.path)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setDiff({ path: file.path, binary: false, lines: [], error: err.message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, cwd, hash, file.path]);

  return (
    <div>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={`${statusLabel(file.status)} — ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 24,
          padding: "0 10px 0 12px",
          cursor: "default",
          background: hover
            ? "color-mix(in oklab, var(--ink) 5%, transparent)"
            : "transparent",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        <Chevron open={expanded} />
        <span
          aria-hidden
          style={{
            flex: "0 0 auto",
            width: 12,
            textAlign: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 700,
            color,
          }}
        >
          {statusGlyph(file.status)}
        </span>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            display: "flex",
            alignItems: "baseline",
            gap: 5,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              color: "var(--ink-dim)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              flex: "0 1 auto",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
          <span
            style={{
              color: "var(--muted-2)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {file.oldPath ? renameHint(file.oldPath, file.path) : dir}
          </span>
        </span>
        <span
          style={{
            flex: "0 0 auto",
            display: "inline-flex",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {file.additions > 0 && <span style={{ color: "var(--ok)" }}>+{file.additions}</span>}
          {file.deletions > 0 && <span style={{ color: "var(--danger)" }}>-{file.deletions}</span>}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--rule-soft)",
            borderBottom: "1px solid var(--rule-soft)",
            margin: "2px 0 4px",
            maxHeight: 420,
            overflow: "auto",
            background: "color-mix(in oklab, var(--ink) 2%, transparent)",
            boxShadow: "var(--well)",
          }}
        >
          {loading ? (
            <DiffNote>
              <Spinner /> <span style={{ marginLeft: 8 }}>Loading diff…</span>
            </DiffNote>
          ) : !diff || diff.error ? (
            <DiffNote danger>{diff?.error ?? "Could not load this diff."}</DiffNote>
          ) : diff.binary ? (
            <DiffNote>Binary file — no inline preview.</DiffNote>
          ) : diff.lines.length === 0 ? (
            <DiffNote>No textual changes to show.</DiffNote>
          ) : (
            <div style={{ padding: "4px 0", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {diff.lines.map((line, index) => (
                <div
                  key={index}
                  style={{
                    ...LINE_STYLE[line.kind],
                    display: "block",
                    width: "max-content",
                    minWidth: "100%",
                    padding: "0 10px",
                    minHeight: 16,
                    lineHeight: "16px",
                    whiteSpace: "pre",
                  }}
                >
                  {line.text === "" ? " " : line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// Build a compact "old/dir → new/name" hint for a rename, dimming shared parts.
function renameHint(oldPath: string, newPath: string): string {
  return `${oldPath} → ${newPath}`;
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="var(--muted)"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        flex: "0 0 auto",
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <path d="M3.5 2.5 6.5 5 3.5 7.5" />
    </svg>
  );
}

function DiffNote({
  children,
  danger = false,
}: {
  children: React.ReactNode;
  danger?: boolean;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "12px 14px",
        fontSize: 11,
        color: danger ? "var(--danger)" : "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}
