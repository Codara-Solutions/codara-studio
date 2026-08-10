import React, { useEffect, useMemo, useState } from "react";
import type { GitLogRow } from "@shared/types";
import ChangeSection from "./ChangeSection";
import CommitMenu from "./CommitMenu";
import { shortenRelative } from "./git-ui";

interface Props {
  /** Repo cwd — for the inspection agent to fetch commit detail / file diffs. */
  cwd: string;
  rows: GitLogRow[];
  loading: boolean;
  collapsed: boolean;
  onToggle: () => void;
  disabled: boolean;
  onCheckout: (ref: string) => void;
  onRevert: (hash: string) => void;
  onUndoLastCommit: () => void;
  /** Open a commit in the inspection view (built by the inspection agent). */
  onOpenCommit: (hash: string) => void;
  /** The commit just returned from — its row flashes once, then fades. */
  highlightHash: string | null;
}

// Graph lane geometry + palette. The graph is a VS Code-style swimlane drawing
// computed from each commit's parent hashes (not from `git log --graph` ASCII):
// one lane per in-flight commit, reused as branches fork and merge.
const LANE_W = 12;
const LANE_H = 22;
const NODE_R = 3.5;
// Quiet, cohesive lane palette tuned for the dark amber theme. The trunk lane
// stays neutral so the rail recedes into the panel; subsequent lanes get cool
// hues so merges/forks still read distinctly without competing with the
// accent-colored HEAD node.
const LANE_NEUTRAL = "#5a5754";
const LANE_TINTS = ["#7da5cc", "#a890c4", "#7fb6a6", "#c79090", "#b9a36b"];
const LOCAL_REF_COLOR = "var(--accent)";
const REMOTE_REF_COLOR = "#a7c0e0";
const HEAD_COLOR = "var(--accent)";

interface MenuState {
  row: GitLogRow;
  x: number;
  y: number;
}

// A single output lane: the commit it is currently routing toward, plus the
// stable color it carries down the column. `null` is a reserved-but-empty slot
// kept so later lanes keep their column (avoids the whole graph reflowing left
// every time a branch ends).
interface Lane {
  hash: string;
  color: string;
}
type LaneSlot = Lane | null;

// One drawn edge segment inside a row's 22px swimlane.
type EdgeType = "pass" | "merge-in" | "into-node" | "out-parent" | "out-merge";
interface Edge {
  from: number;
  to: number;
  type: EdgeType;
  color: string;
}

interface CommitGraphViewModel {
  row: GitLogRow;
  inputLanes: LaneSlot[];
  outputLanes: LaneSlot[];
  /** Column the commit node sits in. */
  commitLane: number;
  /** Color of the commit node + its first-parent rail. */
  commitColor: string;
  edges: Edge[];
  /** Lane count needed to size the SVG (max of in/out plus the node column). */
  laneSpan: number;
}

// The commit history: a VS Code-style parent-hash lane graph plus per-commit
// metadata. Left-clicking a commit opens it in the inspector; right-click opens
// a "safe time-travel" context menu.
export default function CommitHistory({
  rows,
  loading,
  collapsed,
  onToggle,
  disabled,
  onCheckout,
  onRevert,
  onUndoLastCommit,
  onOpenCommit,
  highlightHash,
}: Props): React.ReactElement {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const commitCount = rows.filter((r) => r.hash).length;
  // Keep view-model identity stable across renders when `rows` itself didn't
  // change — GitPanel's shallow-compare keeps `rows` stable for no-op polls,
  // so this memo lets the memoized commit rows actually skip re-rendering.
  const graphRows = useMemo(() => buildCommitGraphViewModels(rows), [rows]);

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
                highlighted={Boolean(viewModel.row.hash) && viewModel.row.hash === highlightHash}
                onOpen={onOpenCommit}
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
          onView={onOpenCommit}
          onCheckout={onCheckout}
          onRevert={onRevert}
          onUndoLastCommit={onUndoLastCommit}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

// One history row. `React.memo`'d on `viewModel` — a status poll that leaves
// history untouched hands back the same row objects (and so the same view
// model), so the rows skip re-rendering. Left-click opens the commit in the
// inspector; right-click opens the context menu.
const CommitRowView = React.memo(function CommitRowView({
  viewModel,
  highlighted,
  onOpen,
  onOpenMenu,
}: {
  viewModel: CommitGraphViewModel;
  highlighted: boolean;
  onOpen: (hash: string) => void;
  onOpenMenu: (row: GitLogRow, x: number, y: number) => void;
}) {
  const row = viewModel.row;
  const [hover, setHover] = useState(false);
  const refs = row.refs ?? [];
  const isCommit = Boolean(row.hash);

  // The return flash: the tint lands with no transition, then the very next
  // frame drops it with a one-second fade, so the row catches the eye and
  // releases it without ever looking selected.
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!highlighted) return;
    setFading(false);
    const frame = requestAnimationFrame(() => setFading(true));
    return () => {
      cancelAnimationFrame(frame);
      setFading(false);
    };
  }, [highlighted]);

  const restingBackground =
    isCommit && hover ? "color-mix(in oklab, var(--ink) 4%, transparent)" : "transparent";

  const open = (e: React.MouseEvent): void => {
    if (!isCommit || !row.hash) return;
    e.preventDefault();
    e.stopPropagation();
    onOpen(row.hash);
  };
  const contextMenu = (e: React.MouseEvent): void => {
    if (!isCommit) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenMenu(row, e.clientX, e.clientY);
  };

  return (
    <div
      data-commit-hash={row.hash || undefined}
      onClick={open}
      onContextMenu={contextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        isCommit
          ? `${row.shortHash}  ·  ${row.author ?? ""}  ·  ${row.relativeDate ?? ""}\n${row.subject ?? ""}\nClick to inspect · right-click for actions`
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
          highlighted && !fading
            ? "color-mix(in oklab, var(--ink) 11%, transparent)"
            : restingBackground,
        transition: highlighted
          ? fading
            ? "background 1000ms var(--ease-out)"
            : "none"
          : "background var(--motion-fast) var(--ease-out)",
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

// ── Graph lane model ─────────────────────────────────────────────────────────

// VS Code's Source Control Graph renders from per-commit input/output
// swimlanes, not from the literal `git log --graph` slash characters. We follow
// that shape: parent hashes define the lane state, then each row draws one
// continuous path through the 22px swimlane.
//
// The log is `--topo-order`, so a commit is always processed before its
// parents. We keep an array of "lanes", each routing toward some not-yet-seen
// commit. Processing a commit:
//   • every input lane pointing at it is an incoming edge (the leftmost is the
//     commit's own lane; the rest are branches/merges converging on it);
//   • its first parent continues straight down the commit's lane;
//   • each extra parent (a merge) reuses an existing lane already heading to
//     that parent, or claims a free/new lane — that's the fork curve.
// Lane *colors* are assigned once when a lane is created and ride the whole
// column, which is what gives a branch a single continuous hue.
const STROKE_W = 1.35;
const SWIMLANE_CURVE_R = 5;

function buildCommitGraphViewModels(rows: GitLogRow[]): CommitGraphViewModel[] {
  let colorCursor = 0;
  const viewModels: CommitGraphViewModel[] = [];
  let lanes: LaneSlot[] = [];

  // A fresh lane color. The trunk column (0) stays neutral so the main rail
  // recedes; everything else cycles the tint palette. HEAD's lane is forced to
  // the accent color regardless of column.
  const laneColor = (index: number, isHead: boolean): string => {
    if (isHead) return HEAD_COLOR;
    if (index === 0) return LANE_NEUTRAL;
    const c = LANE_TINTS[colorCursor % LANE_TINTS.length];
    colorCursor++;
    return c;
  };

  const firstFree = (): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
    return lanes.length;
  };
  const laneOf = (hash: string): number => {
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (l && l.hash === hash) return i;
    }
    return -1;
  };

  for (const row of rows) {
    // Pure connector lines (legacy ASCII rows) carry no commit — pass the lane
    // state straight through so the column stays continuous.
    if (!row.hash) {
      const slot = lanes.map((l) => (l ? { ...l } : null));
      viewModels.push({
        row,
        inputLanes: slot,
        outputLanes: slot,
        commitLane: 0,
        commitColor: LANE_NEUTRAL,
        edges: [],
        laneSpan: Math.max(lanes.length, 1),
      });
      continue;
    }

    const hash = row.hash;
    const isHead = row.isHead === true;
    const parents = row.parentHashes ?? [];
    const inputLanes: LaneSlot[] = lanes.map((l) => (l ? { ...l } : null));

    // Every lane already pointing at this commit is an incoming edge.
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (l && l.hash === hash) incoming.push(i);
    }

    let commitLane: number;
    let commitColor: string;
    if (incoming.length > 0) {
      commitLane = incoming[0];
      const existing = lanes[commitLane] as Lane;
      commitColor = isHead ? HEAD_COLOR : existing.color;
    } else {
      // A branch tip nothing points at yet: take the first free column.
      commitLane = firstFree();
      commitColor = laneColor(commitLane, isHead);
    }
    while (lanes.length <= commitLane) lanes.push(null);

    // Clear every incoming lane — they all converge into the node.
    for (const idx of incoming) lanes[idx] = null;

    // First parent rides the commit's own lane straight down. A root commit
    // (no parents) ends the lane here.
    lanes[commitLane] = parents.length > 0 ? { hash: parents[0], color: commitColor } : null;

    // Extra parents (merges) each need a lane: reuse one already heading to
    // that parent, else claim a free/new column.
    for (let p = 1; p < parents.length; p++) {
      const ph = parents[p];
      if (laneOf(ph) !== -1) continue;
      const li = firstFree();
      while (lanes.length <= li) lanes.push(null);
      lanes[li] = { hash: ph, color: laneColor(li, false) };
    }

    // Trim trailing empty columns so the graph stays compact.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const outputLanes: LaneSlot[] = lanes.map((l) => (l ? { ...l } : null));
    const edges = deriveEdges(inputLanes, outputLanes, commitLane, commitColor, hash, parents);
    const laneSpan = Math.max(inputLanes.length, outputLanes.length, commitLane + 1, 1);

    viewModels.push({ row, inputLanes, outputLanes, commitLane, commitColor, edges, laneSpan });
  }

  return viewModels;
}

// Resolve which input lane connects to which output lane for one row. A
// position-aware match keeps a lane in its own column when possible (so two
// branches both heading to the same parent don't both collapse to the first
// column), and reserves the commit's lane for its first-parent edge.
function deriveEdges(
  inputLanes: LaneSlot[],
  outputLanes: LaneSlot[],
  commitLane: number,
  commitColor: string,
  hash: string,
  parents: string[],
): Edge[] {
  const edges: Edge[] = [];
  const claimed = new Set<number>();
  // The first-parent edge owns the commit lane; passthroughs must not steal it.
  if (parents.length > 0) claimed.add(commitLane);

  const pending: { from: number; lane: Lane }[] = [];
  for (let i = 0; i < inputLanes.length; i++) {
    const l = inputLanes[i];
    if (!l) continue;
    if (l.hash === hash) {
      edges.push({
        from: i,
        to: commitLane,
        type: i === commitLane ? "into-node" : "merge-in",
        color: l.color,
      });
      continue;
    }
    // Prefer keeping the same column.
    const sameCol = outputLanes[i];
    if (sameCol && sameCol.hash === l.hash && !claimed.has(i)) {
      claimed.add(i);
      edges.push({ from: i, to: i, type: "pass", color: l.color });
    } else {
      pending.push({ from: i, lane: l });
    }
  }
  // Shifted passthroughs claim the nearest unclaimed output column with the
  // same hash (a lane sliding left to fill a gap a finished branch left).
  for (const { from, lane } of pending) {
    let to = -1;
    for (let o = 0; o < outputLanes.length; o++) {
      const out = outputLanes[o];
      if (out && out.hash === lane.hash && !claimed.has(o)) {
        to = o;
        break;
      }
    }
    if (to === -1) to = from;
    claimed.add(to);
    edges.push({ from, to, type: "pass", color: lane.color });
  }

  if (parents.length > 0) {
    edges.push({ from: commitLane, to: commitLane, type: "out-parent", color: commitColor });
    for (let p = 1; p < parents.length; p++) {
      const to = laneIndexOf(outputLanes, parents[p]);
      if (to === -1) continue;
      const out = outputLanes[to] as Lane;
      edges.push({ from: commitLane, to, type: "out-merge", color: out.color });
    }
  }
  return edges;
}

function laneIndexOf(lanes: LaneSlot[], hash: string): number {
  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i];
    if (l && l.hash === hash) return i;
  }
  return -1;
}

// ── Graph lane rendering ─────────────────────────────────────────────────────

function GraphLane({
  viewModel,
  refs,
  isHead,
}: {
  viewModel: CommitGraphViewModel;
  refs: string[];
  isHead: boolean;
}): React.ReactElement {
  const { row, commitLane, commitColor, edges, laneSpan } = viewModel;
  const parents = row.parentHashes ?? [];
  const isMerge = parents.length > 1;
  const isCommit = Boolean(row.hash);

  const height = LANE_H;
  const mid = height / 2;
  const width = LANE_W * (laneSpan + 1);
  const x = (index: number): number => LANE_W * (index + 1);

  const r = isHead ? NODE_R + 0.5 : isMerge ? NODE_R + 0.75 : NODE_R;
  const filled = isHead || refs.length > 0 || isMerge;

  const drawPath = (
    d: string,
    color: string,
    key: string,
    strokeWidth = STROKE_W,
  ): React.ReactElement => (
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
  edges.forEach((edge, i) => {
    const fromX = x(edge.from);
    const toX = x(edge.to);
    const key = `${edge.type}-${edge.from}-${edge.to}-${i}`;
    switch (edge.type) {
      case "pass": {
        if (fromX === toX) {
          paths.push(drawPath(`M ${fromX} 0 V ${height}`, edge.color, key));
        } else {
          // A lane sliding columns: vertical, S-curve across the midline, vertical.
          const dir = toX < fromX ? -1 : 1;
          paths.push(
            drawPath(
              [
                `M ${fromX} 0`,
                `V ${mid - SWIMLANE_CURVE_R}`,
                `A ${SWIMLANE_CURVE_R} ${SWIMLANE_CURVE_R} 0 0 ${dir < 0 ? 1 : 0} ${fromX + dir * SWIMLANE_CURVE_R} ${mid}`,
                `H ${toX - dir * SWIMLANE_CURVE_R}`,
                `A ${SWIMLANE_CURVE_R} ${SWIMLANE_CURVE_R} 0 0 ${dir < 0 ? 0 : 1} ${toX} ${mid + SWIMLANE_CURVE_R}`,
                `V ${height}`,
              ].join(" "),
              edge.color,
              key,
            ),
          );
        }
        break;
      }
      case "into-node":
        // The commit's own lane entering from above.
        paths.push(drawPath(`M ${fromX} 0 V ${mid}`, edge.color, key));
        break;
      case "merge-in": {
        // A lane from a higher column curving down into the node at commitLane.
        const dir = toX < fromX ? -1 : 1;
        paths.push(
          drawPath(
            [
              `M ${fromX} 0`,
              `V ${mid - SWIMLANE_CURVE_R}`,
              `A ${SWIMLANE_CURVE_R} ${SWIMLANE_CURVE_R} 0 0 ${dir < 0 ? 1 : 0} ${fromX + dir * SWIMLANE_CURVE_R} ${mid}`,
              `H ${toX}`,
            ].join(" "),
            edge.color,
            key,
          ),
        );
        break;
      }
      case "out-parent":
        // First-parent rail leaving the node downward.
        paths.push(drawPath(`M ${fromX} ${mid} V ${height}`, edge.color, key));
        break;
      case "out-merge": {
        // Merge fork: from the node, curve out to the extra parent's column.
        const dir = toX < fromX ? -1 : 1;
        paths.push(
          drawPath(
            [
              `M ${fromX} ${mid}`,
              `H ${toX - dir * SWIMLANE_CURVE_R}`,
              `A ${SWIMLANE_CURVE_R} ${SWIMLANE_CURVE_R} 0 0 ${dir < 0 ? 0 : 1} ${toX} ${mid + SWIMLANE_CURVE_R}`,
              `V ${height}`,
            ].join(" "),
            edge.color,
            key,
          ),
        );
        break;
      }
    }
  });

  const cx = x(commitLane);
  const nodeColor = isHead ? HEAD_COLOR : commitColor;

  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      style={{ display: "block", flex: `0 0 ${width}px`, overflow: "visible" }}
    >
      {paths}
      {isCommit && (
        <g>
          {isHead && (
            <>
              <circle
                cx={cx}
                cy={mid}
                r={r + 3}
                style={{ fill: "color-mix(in oklch, var(--accent) 14%, transparent)" }}
              />
              <circle
                cx={cx}
                cy={mid}
                r={r + 1.5}
                style={{ fill: "color-mix(in oklch, var(--accent) 26%, transparent)" }}
              />
            </>
          )}
          <circle
            cx={cx}
            cy={mid}
            r={r}
            style={{
              fill: filled ? nodeColor : "var(--panel)",
              stroke: filled ? "none" : nodeColor,
              strokeWidth: 1.25,
            }}
          />
        </g>
      )}
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
