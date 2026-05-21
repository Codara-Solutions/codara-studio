import React, { useEffect, useState } from "react";
import type { GitLogRow } from "@shared/types";
import ChangeSection from "./ChangeSection";
import CommitMenu from "./CommitMenu";
import { shortenRelative } from "./git-ui";

interface Props {
  rows: GitLogRow[];
  loading: boolean;
  collapsed: boolean;
  onToggle: () => void;
  disabled: boolean;
  onCheckout: (ref: string) => void;
  onRevert: (hash: string) => void;
  onUndoLastCommit: () => void;
}

// Graph lane geometry + palette. The lanes are drawn from the ASCII that
// `git log --graph` emits, one row per output line (commit rows and the pure
// connector rows between them).
const LANE_W = 12;
const LANE_H = 22;
const NODE_R = 3.5;
// Quiet, cohesive lane palette tuned for the dark amber theme. The trunk lane
// stays neutral so the rail recedes into the panel; subsequent lanes get cool
// hues so merges/forks still read distinctly without competing with the
// accent-colored HEAD node.
const LANE_NEUTRAL = "#5a5754";
const LANE_TINTS = ["#7da5cc", "#a890c4", "#7fb6a6", "#c79090"];
const LOCAL_REF_COLOR = "var(--accent)";
const REMOTE_REF_COLOR = "#a7c0e0";

interface MenuState {
  row: GitLogRow;
  x: number;
  y: number;
}

// The commit history: the `git log --graph` lanes plus per-commit metadata,
// each commit row opening a "safe time-travel" context menu.
export default function CommitHistory({
  rows,
  loading,
  collapsed,
  onToggle,
  disabled,
  onCheckout,
  onRevert,
  onUndoLastCommit,
}: Props): React.ReactElement {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const commitCount = rows.filter((r) => r.hash).length;

  // Dismiss the context menu on any outside interaction. The opening click is
  // stopped at the row, so it never reaches this listener.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (row: GitLogRow, x: number, y: number): void => {
    if (!row.hash) return;
    setMenu({ row, x, y });
  };

  return (
    <>
      <ChangeSection
        title="History"
        count={commitCount}
        collapsed={collapsed}
        onToggle={onToggle}
        disabled={disabled}
      >
        {loading && rows.length === 0 ? (
          <Hint text="Reading history…" />
        ) : rows.length === 0 ? (
          <Hint text="No commits yet." />
        ) : (
          <div style={{ padding: "1px 6px 2px 0" }}>
            {rows.map((row, index) => (
              <CommitRowView
                key={row.hash ?? `connector-${index}`}
                row={row}
                onOpenMenu={openMenu}
              />
            ))}
          </div>
        )}
      </ChangeSection>

      {menu && (
        <CommitMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          onCheckout={onCheckout}
          onRevert={onRevert}
          onUndoLastCommit={onUndoLastCommit}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

// One history row. `React.memo`'d on `row` — a status poll that leaves history
// untouched hands back the same row objects, so the rows skip re-rendering.
const CommitRowView = React.memo(function CommitRowView({
  row,
  onOpenMenu,
}: {
  row: GitLogRow;
  onOpenMenu: (row: GitLogRow, x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const refs = row.refs ?? [];
  const isCommit = Boolean(row.hash);

  const open = (e: React.MouseEvent): void => {
    if (!isCommit) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenMenu(row, e.clientX, e.clientY);
  };

  return (
    <div
      onClick={open}
      onContextMenu={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        isCommit
          ? `${row.shortHash}  ·  ${row.author ?? ""}  ·  ${row.relativeDate ?? ""}\n${row.subject ?? ""}`
          : undefined
      }
      style={{
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        gap: 8,
        alignItems: "center",
        minHeight: 22,
        paddingRight: 10,
        cursor: "default",
        background:
          isCommit && hover
            ? "color-mix(in oklch, var(--ink) 4%, transparent)"
            : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <GraphLane graph={row.graph} refs={refs} isHead={row.isHead === true} />
      {isCommit && (
        <span
          style={{
            minWidth: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              minWidth: 0,
              flex: "0 1 auto",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: row.isHead ? 500 : 400,
              color: row.isHead ? "var(--ink)" : "var(--ink-dim)",
              letterSpacing: "0.005em",
            }}
          >
            {row.subject || "(no message)"}
          </span>
          {refs.map((ref) => (
            <RefBadge key={ref} refName={ref} />
          ))}
          <span style={{ flex: 1 }} />
          <span
            style={{
              flex: "0 0 auto",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted-2)",
              opacity: hover ? 1 : 0.85,
              transition: "opacity var(--motion-fast) var(--ease-out)",
            }}
          >
            {row.shortHash}
          </span>
          <span
            style={{
              flex: "0 0 auto",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted-2)",
              opacity: 0.75,
              minWidth: 22,
              textAlign: "right",
            }}
          >
            {shortenRelative(row.relativeDate ?? "")}
          </span>
        </span>
      )}
    </div>
  );
});

function Hint({ text }: { text: string }): React.ReactElement {
  return (
    <div style={{ padding: "8px 14px", color: "var(--muted)", fontSize: 11 }}>{text}</div>
  );
}

// ── Graph lane rendering ─────────────────────────────────────────────────────

// Each row is rendered as one inline SVG so cross-lane connectors are real
// curved paths that flow into the vertical rails. With separate per-cell <div>s
// the diagonals can't reach into adjacent cells, so they read as detached
// toothpicks; with a single SVG the curves can start at one lane's bottom and
// land tangent-vertical at the neighbouring lane's top.
const STROKE_W = 1.5;

function GraphLane({
  graph,
  refs,
  isHead,
}: {
  graph: string;
  refs: string[];
  isHead: boolean;
}): React.ReactElement {
  const tokens = (graph.trimEnd() || "*").split("");
  const width = tokens.length * LANE_W;
  const height = LANE_H;
  const tokenColors = tokens.map((_, i) => tokenColor(tokens, i));
  const hasRefs = refs.length > 0;

  const centerOf = (i: number): number => i * LANE_W + LANE_W / 2;

  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      style={{ display: "block", flex: `0 0 ${width}px`, overflow: "visible" }}
    >
      {/* Pass 1: rails, diagonals, horizontals. Drawn first so nodes sit on top. */}
      {tokens.map((token, i) => {
        const color = tokenColors[i];
        const stroke = railColor(color);
        const xC = centerOf(i);

        if (token === "|") {
          return (
            <line
              key={`s-${i}`}
              x1={xC}
              y1={0}
              x2={xC}
              y2={height}
              stroke={stroke}
              strokeWidth={STROKE_W}
              strokeLinecap="square"
            />
          );
        }
        if (token === "*") {
          // The rail continues through the node so merges of length 1 read as a
          // single rail with a dot, not a dot floating between two stubs.
          return (
            <line
              key={`s-${i}`}
              x1={xC}
              y1={0}
              x2={xC}
              y2={height}
              stroke={stroke}
              strokeWidth={STROKE_W}
              strokeLinecap="square"
            />
          );
        }
        if (token === "/") {
          // Lane joining upward to the left: enter at this cell's bottom-right
          // (where the source lane was) and exit at the top-left (where the
          // destination lane is in the row above). The cubic control points
          // are set so the curve is vertical-tangent at both endpoints.
          const xRight = (i + 1) * LANE_W;
          const xLeft = i * LANE_W;
          const d = `M ${xRight} ${height} C ${xRight} ${height * 0.45}, ${xLeft} ${height * 0.55}, ${xLeft} 0`;
          return (
            <path
              key={`s-${i}`}
              d={d}
              stroke={stroke}
              strokeWidth={STROKE_W}
              fill="none"
              strokeLinecap="round"
            />
          );
        }
        if (token === "\\") {
          const xRight = (i + 1) * LANE_W;
          const xLeft = i * LANE_W;
          const d = `M ${xLeft} ${height} C ${xLeft} ${height * 0.45}, ${xRight} ${height * 0.55}, ${xRight} 0`;
          return (
            <path
              key={`s-${i}`}
              d={d}
              stroke={stroke}
              strokeWidth={STROKE_W}
              fill="none"
              strokeLinecap="round"
            />
          );
        }
        if (token === "_" || token === "-") {
          const xLeft = i * LANE_W;
          const xRight = (i + 1) * LANE_W;
          const y = token === "_" ? STROKE_W : height / 2;
          return (
            <line
              key={`s-${i}`}
              x1={xLeft}
              y1={y}
              x2={xRight}
              y2={y}
              stroke={stroke}
              strokeWidth={STROKE_W}
              strokeLinecap="round"
            />
          );
        }
        return null;
      })}

      {/* Pass 2: nodes drawn over the rails. */}
      {tokens.map((token, i) => {
        if (token !== "*") return null;
        const xC = centerOf(i);
        const yC = height / 2;
        const color = tokenColors[i];
        const isHeadNode = isHead;
        const filled = isHeadNode || hasRefs;
        const r = isHeadNode ? NODE_R + 0.5 : NODE_R;
        const dotColor = isHeadNode ? "var(--accent)" : color;
        return (
          <g key={`n-${i}`}>
            {isHeadNode && (
              <>
                <circle
                  cx={xC}
                  cy={yC}
                  r={r + 3}
                  style={{
                    fill: "color-mix(in oklch, var(--accent) 14%, transparent)",
                  }}
                />
                <circle
                  cx={xC}
                  cy={yC}
                  r={r + 1.5}
                  style={{
                    fill: "color-mix(in oklch, var(--accent) 26%, transparent)",
                  }}
                />
              </>
            )}
            <circle
              cx={xC}
              cy={yC}
              r={r}
              style={{
                fill: filled ? dotColor : "var(--panel)",
                stroke: filled ? "none" : dotColor,
                strokeWidth: 1.25,
              }}
            />
          </g>
        );
      })}
    </svg>
  );
}

function RefBadge({ refName }: { refName: string }): React.ReactElement {
  const remote = refName.includes("/");
  const fg = remote ? REMOTE_REF_COLOR : LOCAL_REF_COLOR;
  // Strip noisy prefixes: "origin/HEAD" → "origin", "origin/main" → "main".
  const label =
    refName === "origin/HEAD"
      ? "origin"
      : remote
        ? refName.split("/").slice(1).join("/") || refName
        : refName;
  return (
    <span
      title={refName}
      style={{
        flex: "0 0 auto",
        maxWidth: 110,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: "1px 6px",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: fg,
        background: `color-mix(in oklch, ${fg} 14%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

function railColor(color: string): string {
  // Pull the lane color toward the panel background so rails recede instead of
  // dominating the row. The neutral trunk lane stays as-is.
  if (color === LANE_NEUTRAL) return color;
  return `color-mix(in oklch, ${color} 55%, var(--panel))`;
}

function laneColor(index: number): string {
  // The trunk lane (index 0) is neutral; tinted hues only appear when the
  // history actually branches.
  if (index === 0) return LANE_NEUTRAL;
  return LANE_TINTS[(index - 1) % LANE_TINTS.length];
}

// Position of a token among the non-space lanes — drives its palette color.
function laneIndex(tokens: string[], tokenIndex: number): number {
  let lane = 0;
  for (let i = 0; i < tokenIndex; i++) {
    if (tokens[i] !== " ") lane++;
  }
  return lane;
}

function tokenColor(tokens: string[], tokenIndex: number): string {
  return laneColor(laneIndex(tokens, tokenIndex));
}
