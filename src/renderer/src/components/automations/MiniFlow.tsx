import React, { useMemo } from "react";
import type { LoomNodeDef, LoomStepAction, ScheduledJob } from "@shared/types";
import { triggerSummary } from "./presentation";
import { graphForJob } from "./flow/model";
import { LoomIcon, WORKER_TONE } from "./flow/FlowNodes";
import { workerModelLabel } from "./worker-models";
import { STEP_META, STEP_TONE, stepTitle } from "./flow/step-meta";

// Read-only miniature of the loom's GRAPH for the detail view: the trigger
// pinned at the left, then the worker/guard/merge nodes laid out left-to-right
// with their edges, in the same silhouette language as the editor (role icon +
// tone; the trigger chip's left edge is rounded). Clicking anywhere opens the
// editor. Live worker chips hold a steady accent border — never a pulse.

const NODE_W = 116;
const NODE_H = 38;
const COL_DX = 150;
const ROW_DY = 50;
const PAD_X = 12;
const PAD_Y = 10;

interface Placed {
  id: string;
  col: number;
  row: number;
  kind: "trigger" | "worker" | "guard" | "merge" | "step";
  stepType?: LoomStepAction["type"];
  tone: string;
  eyebrow: string;
  text: string;
}

export default function MiniFlow({
  job,
  onOpenEditor,
}: {
  job: ScheduledJob;
  onOpenEditor: () => void;
}): React.ReactElement {
  const live = job.state.status === "running";
  const graph = useMemo(() => graphForJob(job), [job]);

  const { placed, edges, cols, rows } = useMemo(() => {
    // Longest-path columns from the trigger; rows split nodes that share a col.
    const incoming = new Map<string, string[]>();
    for (const n of graph.nodes) incoming.set(n.id, []);
    for (const e of graph.edges) {
      if (e.backEdge) continue;
      incoming.get(e.to)?.push(e.from);
    }
    const colOf = new Map<string, number>();
    const seen = new Set<string>();
    const depth = (id: string): number => {
      if (colOf.has(id)) return colOf.get(id)!;
      if (seen.has(id)) return 1;
      seen.add(id);
      const preds = incoming.get(id) ?? [];
      let d = graph.entryNodeIds.includes(id) ? 1 : 1;
      for (const p of preds) d = Math.max(d, depth(p) + 1);
      colOf.set(id, d);
      seen.delete(id);
      return d;
    };
    const rowCounter = new Map<number, number>();
    const placedNodes: Placed[] = [
      {
        id: "__trigger__",
        col: 0,
        row: 0,
        kind: "trigger",
        tone: "var(--warn)",
        eyebrow: "Trigger",
        text: triggerSummary(job.trigger),
      },
    ];
    for (const n of graph.nodes) {
      const col = depth(n.id);
      const row = rowCounter.get(col) ?? 0;
      rowCounter.set(col, row + 1);
      placedNodes.push({
        id: n.id,
        col,
        row,
        kind: n.kind,
        stepType: n.kind === "step" ? n.action.type : undefined,
        tone: toneFor(n),
        eyebrow: eyebrowFor(n),
        text: textFor(n),
      });
    }
    const maxCol = Math.max(0, ...placedNodes.map((p) => p.col));
    const maxRow = Math.max(0, ...placedNodes.map((p) => p.row));
    const edgeList = [
      ...graph.entryNodeIds.map((to) => ({ from: "__trigger__", to, branch: undefined as undefined | "pass" | "fail", back: false })),
      ...graph.edges.map((e) => ({ from: e.from, to: e.to, branch: e.branch, back: Boolean(e.backEdge) })),
    ];
    return { placed: placedNodes, edges: edgeList, cols: maxCol + 1, rows: maxRow + 1 };
  }, [graph, job.trigger]);

  const posOf = (id: string): { x: number; y: number } | null => {
    const p = placed.find((n) => n.id === id);
    if (!p) return null;
    return { x: PAD_X + p.col * COL_DX, y: PAD_Y + p.row * ROW_DY };
  };

  const width = PAD_X * 2 + (cols - 1) * COL_DX + NODE_W;
  const height = PAD_Y * 2 + (rows - 1) * ROW_DY + NODE_H;

  return (
    <div style={{ position: "relative", width, height, maxWidth: "100%", overflowX: "auto" }}>
      <svg aria-hidden width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {edges.map((e, i) => {
          const a = posOf(e.from);
          const b = posOf(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const dx = Math.max(18, (x2 - x1) / 2);
          const stroke = e.branch === "pass" ? "var(--ok)" : e.branch === "fail" ? "var(--danger)" : "var(--rule-strong)";
          const d = `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
          return (
            <g key={i}>
              <path
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={1.4}
                strokeDasharray={e.back ? "4 3" : undefined}
                vectorEffect="non-scaling-stroke"
              />
              {/* While the loom runs, its forward wires carry the house
                  electricity — the same travelling dash as the LiveBoard. */}
              {live && !e.back && (
                <path
                  className="spark-wire-flow"
                  d={d}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}
      </svg>
      {placed.map((p) => {
        const liveChip = live && p.id !== "__trigger__" && graph.nodes.find((n) => n.id === p.id)?.kind === "worker";
        const pos = { x: PAD_X + p.col * COL_DX, y: PAD_Y + p.row * ROW_DY };
        const radius =
          p.kind === "trigger"
            ? "999px var(--radius-control) var(--radius-control) 999px"
            : "var(--radius-control)";
        return (
          <button
            key={p.id}
            type="button"
            onClick={onOpenEditor}
            title={`${p.eyebrow}: ${p.text} — click to edit`}
            style={{
              position: "absolute",
              left: pos.x,
              top: pos.y,
              width: NODE_W,
              height: NODE_H,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: p.kind === "trigger" ? "0 8px 0 10px" : "0 8px",
              textAlign: "left",
              cursor: "default",
              borderRadius: radius,
              border: `1px solid ${liveChip ? "var(--accent-edge)" : "var(--rule-soft)"}`,
              background: liveChip ? "color-mix(in oklch, var(--accent) 10%, var(--panel))" : "var(--panel)",
              boxShadow: liveChip ? "0 0 10px var(--accent-glow)" : undefined,
              transition: "border-color var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--rule-strong)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = liveChip ? "var(--accent-edge)" : "var(--rule-soft)")}
          >
            <span aria-hidden style={{ display: "inline-flex", flex: "0 0 auto" }}>
              <LoomIcon kind={p.kind} stepType={p.stepType} tone={p.tone} size={12} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 0, minWidth: 0 }}>
              <span className="spark-eyebrow" style={{ fontSize: 7.5 }}>{p.eyebrow}</span>
              <span className="spark-mono" style={{ fontSize: 9.5, color: "var(--ink-dim)", maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {p.text}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function toneFor(n: LoomNodeDef): string {
  if (n.kind === "worker") return WORKER_TONE;
  if (n.kind === "guard") return "var(--ok)";
  if (n.kind === "step") return STEP_TONE;
  return "var(--info)";
}
function eyebrowFor(n: LoomNodeDef): string {
  if (n.kind === "step") return STEP_META[n.action.type].eyebrow;
  return n.kind.charAt(0).toUpperCase() + n.kind.slice(1);
}
function textFor(n: LoomNodeDef): string {
  if (n.kind === "worker") return n.label ?? workerModelLabel(n.worker.model);
  if (n.kind === "guard") return n.label ?? n.predicate.type;
  if (n.kind === "step") return stepTitle(n);
  return n.label ?? n.joinMode;
}
