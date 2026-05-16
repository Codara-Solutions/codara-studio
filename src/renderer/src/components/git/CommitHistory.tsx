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
const LANE_W = 11;
const LANE_H = 22;
const NODE_R = 4;
const GRAPH_COLORS = ["#FFB000", "#DC267F", "#5BA8FF", "#40B0A6", "#B66DFF"];
const LOCAL_REF_COLOR = "#7FB3FF";
const REMOTE_REF_COLOR = "#C99BFF";

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
        minHeight: 24,
        paddingRight: 8,
        cursor: "default",
        background:
          isCommit && hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <GraphLane graph={row.graph} refs={refs} />
      {isCommit && (
        <span
          style={{
            minWidth: 0,
            display: "inline-flex",
            alignItems: "baseline",
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
              color: row.isHead ? "var(--ink)" : "var(--ink-dim)",
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
              color: "var(--muted)",
            }}
          >
            {row.shortHash}
          </span>
          <span
            style={{
              flex: "0 0 auto",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted-2)",
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

function GraphLane({ graph, refs }: { graph: string; refs: string[] }): React.ReactElement {
  const tokens = (graph.trimEnd() || "*").split("");
  return (
    <span aria-hidden style={{ height: LANE_H, display: "inline-flex", alignItems: "stretch" }}>
      {tokens.map((token, index) => (
        <GraphToken
          key={`${index}-${token}`}
          token={token}
          color={tokenColor(tokens, index, refs)}
          featured={token === "*" && refs.length > 0}
        />
      ))}
    </span>
  );
}

function GraphToken({
  token,
  color,
  featured,
}: {
  token: string;
  color: string;
  featured: boolean;
}): React.ReactElement {
  if (token === "*") {
    const r = featured ? NODE_R : NODE_R - 1;
    return (
      <span style={{ width: LANE_W, height: "100%", position: "relative", flex: `0 0 ${LANE_W}px` }}>
        <Rail color={color} />
        <span
          style={{
            position: "absolute",
            left: Math.floor(LANE_W / 2) - r,
            top: "50%",
            width: r * 2,
            height: r * 2,
            marginTop: -r,
            borderRadius: 999,
            border: `1px solid ${color}`,
            background: featured ? color : "var(--panel)",
            boxShadow: featured
              ? `0 0 7px color-mix(in oklch, ${color} 44%, transparent)`
              : "none",
          }}
        />
      </span>
    );
  }
  if (token === "|") {
    return (
      <span style={{ width: LANE_W, height: "100%", position: "relative", flex: `0 0 ${LANE_W}px` }}>
        <Rail color={color} />
      </span>
    );
  }
  if (token === "/" || token === "\\") {
    return (
      <span style={{ width: LANE_W, height: "100%", position: "relative", flex: `0 0 ${LANE_W}px` }}>
        <span
          style={{
            position: "absolute",
            left: Math.floor(LANE_W / 2),
            top: 2,
            width: 2,
            height: LANE_H - 4,
            background: railColor(color),
            transform: token === "/" ? "rotate(28deg)" : "rotate(-28deg)",
            transformOrigin: "center",
          }}
        />
      </span>
    );
  }
  if (token === "_" || token === "-") {
    return (
      <span style={{ width: LANE_W, height: "100%", position: "relative", flex: `0 0 ${LANE_W}px` }}>
        <span
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: 2,
            background: railColor(color),
          }}
        />
      </span>
    );
  }
  return <span style={{ width: LANE_W, flex: `0 0 ${LANE_W}px` }} />;
}

function Rail({ color }: { color: string }): React.ReactElement {
  return (
    <span
      style={{
        position: "absolute",
        left: Math.floor(LANE_W / 2),
        top: 0,
        bottom: 0,
        width: 2,
        background: railColor(color),
      }}
    />
  );
}

function RefBadge({ refName }: { refName: string }): React.ReactElement {
  const remote = refName.includes("/");
  const fg = remote ? REMOTE_REF_COLOR : LOCAL_REF_COLOR;
  return (
    <span
      title={refName}
      style={{
        flex: "0 0 auto",
        maxWidth: 96,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: "1px 6px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: 600,
        color: fg,
        border: `1px solid color-mix(in oklch, ${fg} 56%, var(--rule-soft))`,
        background: `color-mix(in oklch, ${fg} 14%, transparent)`,
      }}
    >
      {refName}
    </span>
  );
}

function railColor(color: string): string {
  return `color-mix(in oklch, ${color} 42%, var(--rule-soft))`;
}

function laneColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

// Position of a token among the non-space lanes — drives its palette color.
function laneIndex(tokens: string[], tokenIndex: number): number {
  let lane = 0;
  for (let i = 0; i < tokenIndex; i++) {
    if (tokens[i] !== " ") lane++;
  }
  return lane;
}

function tokenColor(tokens: string[], tokenIndex: number, refs: string[]): string {
  if (tokens[tokenIndex] === "*" && refs.length > 0) {
    return refs.some((r) => r.includes("/")) ? REMOTE_REF_COLOR : LOCAL_REF_COLOR;
  }
  return laneColor(laneIndex(tokens, tokenIndex));
}
