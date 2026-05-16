import React from "react";
import type { GitDiff, GitDiffLineKind } from "@shared/types";
import { BackIcon, IconButton, OpenFileIcon, Spinner, splitPath } from "./git-ui";

interface Props {
  path: string;
  staged: boolean;
  diff: GitDiff | null;
  loading: boolean;
  onBack: () => void;
  onOpenFile: () => void;
}

// Per-line treatment. Adds / deletes get a faint tinted band the full width of
// the (horizontally scrollable) row; hunks and metadata stay quiet.
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

export default function DiffView({
  path,
  staged,
  diff,
  loading,
  onBack,
  onOpenFile,
}: Props): React.ReactElement {
  const { dir, name } = splitPath(path);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          flex: "0 0 auto",
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px 0 4px",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <IconButton title="Back to changes" onClick={onBack} size={22}>
          <BackIcon />
        </IconButton>
        <span
          title={path}
          style={{
            minWidth: 0,
            flex: 1,
            display: "flex",
            alignItems: "baseline",
            gap: 5,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {dir}
          </span>
        </span>
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            letterSpacing: "0.1em",
            fontWeight: 700,
            textTransform: "uppercase",
            color: staged ? "var(--ok)" : "var(--muted)",
          }}
        >
          {staged ? "Staged" : "Working"}
        </span>
        <IconButton title="Open file in editor" onClick={onOpenFile} size={22}>
          <OpenFileIcon />
        </IconButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {loading ? (
          <DiffHint>
            <Spinner /> <span style={{ marginLeft: 8 }}>Loading diff…</span>
          </DiffHint>
        ) : !diff || diff.error ? (
          <DiffHint danger>{diff?.error ?? "Could not load this diff."}</DiffHint>
        ) : diff.binary ? (
          <DiffHint>Binary file — no inline preview.</DiffHint>
        ) : diff.lines.length === 0 ? (
          <DiffHint>No textual changes to show.</DiffHint>
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
    </div>
  );
}

function DiffHint({
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
        padding: "14px 14px",
        fontSize: 11,
        color: danger ? "var(--danger)" : "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}
