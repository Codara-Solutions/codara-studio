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

interface GraphLaneNode {
  id: string;
  color: string;
}

interface CommitGraphViewModel {
  row: GitLogRow;
  inputLanes: GraphLaneNode[];
  outputLanes: GraphLaneNode[];
}

// The commit history: a VS Code-style parent-hash lane graph plus per-commit
// metadata, each commit row opening a "safe time-travel" context menu.
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
  const graphRows = buildCommitGraphViewModels(rows);

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
            {graphRows.map((viewModel, index) => (
              <CommitRowView
                key={viewModel.row.hash ?? `connector-${index}`}
                viewModel={viewModel}
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
  viewModel,
  onOpenMenu,
}: {
  viewModel: CommitGraphViewModel;
  onOpenMenu: (row: GitLogRow, x: number, y: number) => void;
}) {
  const row = viewModel.row;
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
      <GraphLane viewModel={viewModel} refs={refs} isHead={row.isHead === true} />
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

// VS Code's Source Control Graph renders from per-commit input/output
// swimlanes, not from the literal `git log --graph` slash characters. Spark now
// follows that same shape: parent hashes define the lane state, then each row
// draws one continuous path through the 22px swimlane.
const STROKE_W = 1.35;
const SWIMLANE_CURVE_R = 5;

function buildCommitGraphViewModels(rows: GitLogRow[]): CommitGraphViewModel[] {
  let colorIndex = -1;
  const viewModels: CommitGraphViewModel[] = [];
  let previousOutput: GraphLaneNode[] = [];

  const nextColor = (): string => {
    colorIndex = (colorIndex + 1) % (LANE_TINTS.length + 1);
    return laneColor(colorIndex);
  };

  const colorForRow = (row: GitLogRow): string | undefined => {
    if (row.isHead) return "var(--accent)";
    if ((row.refs ?? []).some((ref) => !ref.includes("/"))) return LOCAL_REF_COLOR;
    if ((row.refs ?? []).some((ref) => ref.includes("/"))) return REMOTE_REF_COLOR;
    return undefined;
  };

  for (const row of rows) {
    if (!row.hash) {
      viewModels.push({ row, inputLanes: previousOutput, outputLanes: previousOutput });
      continue;
    }

    const inputLanes = previousOutput.map((node) => ({ ...node }));
    const outputLanes: GraphLaneNode[] = [];
    const parents = row.parentHashes ?? [];
    let firstParentAdded = false;

    if (parents.length > 0) {
      for (const node of inputLanes) {
        if (node.id === row.hash) {
          if (!firstParentAdded) {
            outputLanes.push({ id: parents[0], color: colorForRow(row) ?? node.color });
            firstParentAdded = true;
          }
          continue;
        }
        outputLanes.push({ ...node });
      }
    } else {
      for (const node of inputLanes) {
        if (node.id !== row.hash) outputLanes.push({ ...node });
      }
    }

    for (let i = firstParentAdded ? 1 : 0; i < parents.length; i++) {
      outputLanes.push({ id: parents[i], color: colorForRow(row) ?? nextColor() });
    }

    viewModels.push({ row, inputLanes, outputLanes });
    previousOutput = outputLanes;
  }

  return viewModels;
}

function GraphLane({
  viewModel,
  refs,
  isHead,
}: {
  viewModel: CommitGraphViewModel;
  refs: string[];
  isHead: boolean;
}): React.ReactElement {
  const { row, inputLanes, outputLanes } = viewModel;
  const parents = row.parentHashes ?? [];
  const inputIndex = inputLanes.findIndex((node) => node.id === row.hash);
  const circleIndex = inputIndex !== -1 ? inputIndex : inputLanes.length;
  const laneCount = Math.max(inputLanes.length, outputLanes.length, circleIndex + 1, 1);
  const width = LANE_W * (laneCount + 1);
  const height = LANE_H;
  const circleColor =
    (circleIndex < outputLanes.length
      ? outputLanes[circleIndex].color
      : circleIndex < inputLanes.length
        ? inputLanes[circleIndex].color
        : row.isHead
          ? "var(--accent)"
          : laneColor(0));
  const filled = isHead || refs.length > 0 || parents.length > 1;
  const r = isHead ? NODE_R + 0.5 : parents.length > 1 ? NODE_R + 0.75 : NODE_R;

  const x = (index: number): number => LANE_W * (index + 1);
  const path = (d: string, color: string, key: string, strokeWidth = STROKE_W) => (
    <path
      key={key}
      d={d}
      stroke={railColor(color)}
      strokeWidth={strokeWidth}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );

  const paths: React.ReactNode[] = [];
  let outputIndex = 0;

  for (let index = 0; index < inputLanes.length; index++) {
    const lane = inputLanes[index];

    if (lane.id === row.hash) {
      if (index !== circleIndex) {
        paths.push(
          path(
            `M ${x(index)} 0 A ${LANE_W} ${LANE_W} 0 0 1 ${x(index) - LANE_W} ${height / 2} H ${x(circleIndex)}`,
            lane.color,
            `base-${index}`,
          ),
        );
      } else {
        outputIndex++;
      }
      continue;
    }

    if (outputIndex < outputLanes.length && lane.id === outputLanes[outputIndex].id) {
      if (index === outputIndex) {
        paths.push(path(`M ${x(index)} 0 V ${height}`, lane.color, `rail-${index}`));
      } else {
        const startX = x(index);
        const endX = x(outputIndex);
        const direction = endX < startX ? -1 : 1;
        paths.push(
          path(
            [
              `M ${startX} 0`,
              "V 6",
              `A ${SWIMLANE_CURVE_R} ${SWIMLANE_CURVE_R} 0 0 ${direction < 0 ? 1 : 0} ${startX + direction * SWIMLANE_CURVE_R} ${height / 2}`,
              `H ${endX - direction * SWIMLANE_CURVE_R}`,
              `A ${SWIMLANE_CURVE_R} ${SWIMLANE_CURVE_R} 0 0 ${direction < 0 ? 0 : 1} ${endX} ${height / 2 + SWIMLANE_CURVE_R}`,
              `V ${height}`,
            ].join(" "),
            lane.color,
            `move-${index}-${outputIndex}`,
          ),
        );
      }
      outputIndex++;
    }
  }

  for (let i = 1; i < parents.length; i++) {
    const parentOutputIndex = findLastLaneIndex(outputLanes, parents[i]);
    if (parentOutputIndex === -1) continue;
    const color = outputLanes[parentOutputIndex].color;
    const bendX = LANE_W * parentOutputIndex;
    paths.push(
      path(
        [
          `M ${bendX} ${height / 2}`,
          `A ${LANE_W} ${LANE_W} 0 0 1 ${x(parentOutputIndex)} ${height}`,
          `M ${bendX} ${height / 2}`,
          `H ${x(circleIndex)}`,
        ].join(" "),
        color,
        `parent-${i}`,
      ),
    );
  }

  if (inputIndex !== -1) {
    paths.push(path(`M ${x(circleIndex)} 0 V ${height / 2}`, inputLanes[inputIndex].color, "into-node"));
  }
  if (parents.length > 0) {
    paths.push(path(`M ${x(circleIndex)} ${height / 2} V ${height}`, circleColor, "out-node"));
  }

  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      style={{ display: "block", flex: `0 0 ${width}px`, overflow: "visible" }}
    >
      {paths}
      <g>
        {isHead && (
          <>
            <circle
              cx={x(circleIndex)}
              cy={height / 2}
              r={r + 3}
              style={{ fill: "color-mix(in oklch, var(--accent) 14%, transparent)" }}
            />
            <circle
              cx={x(circleIndex)}
              cy={height / 2}
              r={r + 1.5}
              style={{ fill: "color-mix(in oklch, var(--accent) 26%, transparent)" }}
            />
          </>
        )}
        <circle
          cx={x(circleIndex)}
          cy={height / 2}
          r={r}
          style={{
            fill: filled ? circleColor : "var(--panel)",
            stroke: filled ? "none" : circleColor,
            strokeWidth: 1.25,
          }}
        />
      </g>
    </svg>
  );
}

function findLastLaneIndex(nodes: GraphLaneNode[], id: string): number {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].id === id) return i;
  }
  return -1;
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
