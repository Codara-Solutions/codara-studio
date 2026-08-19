import React from "react";
import { BaseEdge, getBezierPath, Handle, Position } from "@xyflow/react";
import type { EdgeProps, NodeProps } from "@xyflow/react";
import type { GuardPredicate, LoomWorkerConfig } from "@shared/types";
import { workerModelLabel } from "../worker-models";
import type { FlowNodeData } from "./model";

// Custom ReactFlow node + edge renderers for the loom canvas, painted with
// Codara's CSS variables. Design language: precision instrument — every role
// is a quiet card with a crisp line-icon tile and a restrained role-toned top
// hairline; the silhouette carries meaning without theatrics (a trigger's
// left edge is fully rounded — flow starts here; a guard exposes labelled
// pass/fail ports). Each node exposes a '+' affordance on its source
// handle(s) via an `onAddFrom` callback threaded through node data.

export interface NodeCallbacks {
  /** Open the add-node palette anchored on a node's source handle. */
  onAddFrom?: (nodeId: string, branch?: "pass" | "fail", anchor?: DOMRect) => void;
}

// The trigger summary text is injected via data.summary to avoid importing
// presentation into every node; the editor stamps it.
type NodeData = FlowNodeData & { summary?: string; onAddFrom?: NodeCallbacks["onAddFrom"] } & Record<
    string,
    unknown
  >;

// Role identity: every worker runs on the same bundled Pi runtime now, so
// worker cards wear the house accent (role tone) rather than a per-engine hue.
export const WORKER_TONE = "var(--accent)";

// ── crisp 16px line icons (stroke 1.5, round caps) ──────────────────────────

function Icon({ d, tone, size = 17 }: { d: React.ReactNode; tone: string; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={tone}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d}
    </svg>
  );
}

const BOLT = <path d="M8.7 1.6 4 9h3.4l-.9 5.4L11.9 7H8.4l.3-5.4Z" />;
const CPU = (
  <>
    <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" />
    <path d="M6.5 1.2v2.2M9.5 1.2v2.2M6.5 12.6v2.2M9.5 12.6v2.2M1.2 6.5h2.2M1.2 9.5h2.2M12.6 6.5h2.2M12.6 9.5h2.2" />
  </>
);
const SPLIT = (
  <>
    <path d="M1.8 8h4.4M6.2 8c2.8 0 2.6-3.8 5.4-3.8M6.2 8c2.8 0 2.6 3.8 5.4 3.8" />
    <circle cx="13.4" cy="4.2" r="1.1" />
    <circle cx="13.4" cy="11.8" r="1.1" />
  </>
);
const JOIN = (
  <>
    <path d="M14.2 8H9.8M9.8 8C7 8 7.2 4.2 4.4 4.2M9.8 8C7 8 7.2 11.8 4.4 11.8" />
    <circle cx="2.6" cy="4.2" r="1.1" />
    <circle cx="2.6" cy="11.8" r="1.1" />
  </>
);

/** Role → line icon, for surfaces that dispatch on node kind (LiveBoard). */
export function LoomIcon({
  kind,
  tone,
  size,
}: {
  kind: "trigger" | "worker" | "guard" | "merge";
  tone: string;
  size?: number;
}): React.ReactElement {
  const d = kind === "trigger" ? BOLT : kind === "guard" ? SPLIT : kind === "merge" ? JOIN : CPU;
  return <Icon d={d} tone={tone} size={size} />;
}

/** Role icon tile (styles.css .loom-medallion); tone via --md-tone. */
export function Medallion({
  icon,
  tone,
  size = 34,
}: {
  icon: React.ReactNode;
  tone: string;
  size?: number;
}): React.ReactElement {
  return (
    <span
      className="loom-medallion"
      style={{ "--md-tone": tone, width: size, height: size } as React.CSSProperties}
    >
      {icon}
    </span>
  );
}

// ── shared card anatomy ──────────────────────────────────────────────────────

function Eyebrow({ text }: { text: string }): React.ReactElement {
  return (
    <span
      className="spark-mono"
      style={{
        fontSize: 8.5,
        fontWeight: 600,
        letterSpacing: "0.13em",
        textTransform: "uppercase",
        color: "var(--muted)",
      }}
    >
      {text}
    </span>
  );
}

function Title({ text }: { text: string }): React.ReactElement {
  return (
    <span
      title={text}
      style={{
        fontSize: 12.5,
        fontWeight: 600,
        color: "var(--ink)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </span>
  );
}

function Meta({ text, title }: { text: string; title?: string }): React.ReactElement {
  return (
    <span
      className="spark-mono"
      title={title ?? text}
      style={{
        fontSize: 10,
        color: "var(--muted)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </span>
  );
}

// Role-toned top hairline: its own element (not a border / box-shadow) so the
// .loom-node CSS hover lift keeps owning the card's real border and shadow.
// Inset from both corners (the cards deliberately do NOT clip overflow — the
// '+' buttons and handles live outside the right edge — so a full-width bar
// would overhang the corner curves; on the trigger's pill-rounded left edge
// the caller passes a wider inset to clear the semicircle). Exported — the
// LiveBoard's status-bearing cards wear the same rule.
export function TopRule({
  tone,
  left = 10,
  right = 10,
}: {
  tone: string;
  left?: number;
  right?: number;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        left,
        right,
        height: 2,
        borderRadius: 999,
        background: `linear-gradient(90deg, color-mix(in oklch, ${tone} 62%, transparent), color-mix(in oklch, ${tone} 14%, transparent))`,
      }}
    />
  );
}

// Selection must always win, including over .loom-node:hover — inline only.
const SELECTED: React.CSSProperties = {
  border: "1px solid var(--accent-edge)",
  boxShadow: "var(--lift-hi), 0 0 0 2.5px var(--accent-soft), var(--shadow-2)",
};

function cardStyle(selected: boolean | undefined, extra?: React.CSSProperties): React.CSSProperties {
  return {
    // NO overflow:hidden here: the card is the positioned containing block
    // for its '+' buttons and handles, which sit OUTSIDE the right edge —
    // clipping would swallow them. Backgrounds clip to the border-radius on
    // their own, and TopRule carries its own matching radius.
    position: "relative",
    borderRadius: "var(--radius-surface)",
    fontFamily: "var(--font-sans)",
    cursor: "default",
    display: "flex",
    alignItems: "center",
    gap: 11,
    padding: "11px 13px",
    boxSizing: "border-box",
    ...extra,
    ...(selected ? SELECTED : null),
  };
}

const HANDLE_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  background: "var(--panel-3)",
  border: "1.5px solid var(--rule-strong)",
};

// The '+' button that rides a source handle.
function PlusButton({
  onClick,
  title,
  style,
}: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  style: React.CSSProperties;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="nodrag nopan"
      title={title}
      onClick={onClick}
      style={{
        position: "absolute",
        width: 21,
        height: 21,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 999,
        border: "1px solid var(--rule)",
        background: "var(--panel-2)",
        color: "var(--muted)",
        fontSize: 13,
        lineHeight: 1,
        cursor: "default",
        boxShadow: "var(--lift-hi), var(--shadow-1)",
        zIndex: 5,
        transition:
          "color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--accent-text)";
        e.currentTarget.style.borderColor = "var(--accent-edge)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--muted)";
        e.currentTarget.style.borderColor = "var(--rule)";
      }}
    >
      +
    </button>
  );
}

// ── trigger node — rounded left edge: flow starts here ──────────────────────

const TRIGGER_RADIUS = "999px var(--radius-surface) var(--radius-surface) 999px";

export function TriggerNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  return (
    <div
      className="loom-node"
      style={cardStyle(selected, { width: 208, borderRadius: TRIGGER_RADIUS, paddingLeft: 15 })}
    >
      <TopRule tone="var(--warn)" left={32} />
      <Medallion icon={<Icon d={BOLT} tone="var(--warn)" />} tone="var(--warn)" />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <Eyebrow text="Trigger" />
        <Title text={d.summary ?? "manual"} />
      </div>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      {d.onAddFrom && (
        <PlusButton
          title="Add first step"
          style={{ top: "50%", right: -31, transform: "translateY(-50%)" }}
          onClick={(e) => {
            e.stopPropagation();
            d.onAddFrom?.(id, undefined, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        />
      )}
    </div>
  );
}

// ── worker node — one agent pass ─────────────────────────────────────────────

function workerLine(w: LoomWorkerConfig): string {
  const parts = [workerModelLabel(w.model)];
  if (w.effort) parts.push(w.effort);
  return parts.join(" · ");
}

export function WorkerNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  if (d.kind !== "worker") return <div />;
  const tone = WORKER_TONE;
  const promptPreview = d.prompt.trim() || "no prompt yet";
  return (
    <div className="loom-node" style={cardStyle(selected, { width: 248, alignItems: "flex-start" })}>
      <TopRule tone={tone} />
      <Medallion icon={<Icon d={CPU} tone={tone} />} tone={tone} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Eyebrow text="Worker" />
          {d.retry && d.retry.maxAttempts > 0 && (
            <span
              className="spark-mono"
              title={`retries up to ${d.retry.maxAttempts}×`}
              style={{ marginLeft: "auto", fontSize: 8.5, color: "var(--muted)" }}
            >
              retry ×{d.retry.maxAttempts}
            </span>
          )}
        </div>
        <Title text={d.label || "Worker"} />
        <Meta text={workerLine(d.worker)} />
        <span
          title={d.prompt}
          style={{
            fontSize: 10,
            lineHeight: 1.5,
            color: "color-mix(in oklch, var(--muted) 78%, transparent)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {promptPreview}
        </span>
      </div>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      {d.onAddFrom && (
        <PlusButton
          title="Add next step"
          style={{ top: "50%", right: -31, transform: "translateY(-50%)" }}
          onClick={(e) => {
            e.stopPropagation();
            d.onAddFrom?.(id, undefined, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        />
      )}
    </div>
  );
}

// ── guard node — a decision with labelled pass / fail ports ─────────────────

const GUARD_PASS_TOP = "32%";
const GUARD_FAIL_TOP = "68%";

function predicateLine(p: GuardPredicate): string {
  switch (p.type) {
    case "phrase":
      return `phrase "${p.phrase || "…"}"`;
    case "tests":
      return `tests · ${p.command || "npm test"}`;
    case "gitClean":
      return "git clean";
    case "command":
      return `cmd · ${p.command || "…"}`;
    case "agentSignal":
      return `agent says ${p.want}`;
  }
}

function PortLabel({
  text,
  tone,
  top,
}: {
  text: string;
  tone: string;
  top: string;
}): React.ReactElement {
  return (
    <span
      className="spark-mono"
      aria-hidden
      style={{
        position: "absolute",
        right: 9,
        top,
        transform: "translateY(-50%)",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 8,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: `color-mix(in oklch, ${tone} 75%, var(--muted))`,
      }}
    >
      {text}
    </span>
  );
}

export function GuardNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  if (d.kind !== "guard") return <div />;
  return (
    <div className="loom-node" style={cardStyle(selected, { width: 232, paddingRight: 44 })}>
      <TopRule tone="var(--ok)" />
      <Medallion icon={<Icon d={SPLIT} tone="var(--ok)" />} tone="var(--ok)" />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <Eyebrow text="Guard" />
        <Title text={d.label || "Guard"} />
        <Meta text={predicateLine(d.predicate)} />
      </div>
      <PortLabel text="pass" tone="var(--ok)" top={GUARD_PASS_TOP} />
      <PortLabel text="fail" tone="var(--danger)" top={GUARD_FAIL_TOP} />
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      {/* pass = upper port (green), fail = lower port (red) */}
      <Handle
        id="pass"
        type="source"
        position={Position.Right}
        style={{
          ...HANDLE_STYLE,
          top: GUARD_PASS_TOP,
          borderColor: "var(--ok)",
          background: "color-mix(in oklch, var(--ok) 40%, var(--panel-3))",
        }}
      />
      <Handle
        id="fail"
        type="source"
        position={Position.Right}
        style={{
          ...HANDLE_STYLE,
          top: GUARD_FAIL_TOP,
          borderColor: "var(--danger)",
          background: "color-mix(in oklch, var(--danger) 40%, var(--panel-3))",
        }}
      />
      {d.onAddFrom && (
        <>
          <PlusButton
            title="Add pass branch"
            style={{ top: GUARD_PASS_TOP, right: -31, transform: "translateY(-50%)" }}
            onClick={(e) => {
              e.stopPropagation();
              d.onAddFrom?.(id, "pass", (e.currentTarget as HTMLElement).getBoundingClientRect());
            }}
          />
          <PlusButton
            title="Add fail branch"
            style={{ top: GUARD_FAIL_TOP, right: -31, transform: "translateY(-50%)" }}
            onClick={(e) => {
              e.stopPropagation();
              d.onAddFrom?.(id, "fail", (e.currentTarget as HTMLElement).getBoundingClientRect());
            }}
          />
        </>
      )}
    </div>
  );
}

// ── merge node — branches come back together ────────────────────────────────

export function MergeNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  if (d.kind !== "merge") return <div />;
  return (
    <div className="loom-node" style={cardStyle(selected, { width: 196 })}>
      <TopRule tone="var(--info)" />
      <Medallion icon={<Icon d={JOIN} tone="var(--info)" />} tone="var(--info)" />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <Eyebrow text="Merge" />
        <Title text={d.label || "Merge"} />
        <Meta text={d.joinMode === "all" ? "waits for all branches" : "first branch wins"} />
      </div>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      {d.onAddFrom && (
        <PlusButton
          title="Add next step"
          style={{ top: "50%", right: -31, transform: "translateY(-50%)" }}
          onClick={(e) => {
            e.stopPropagation();
            d.onAddFrom?.(id, undefined, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        />
      )}
    </div>
  );
}

// ── custom edge: bezier, branch-colored, back-edge dashed ────────────────────

export function LoomEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps): React.ReactElement {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const branch = (data as { branch?: "pass" | "fail"; backEdge?: boolean } | undefined)?.branch;
  const backEdge = (data as { backEdge?: boolean } | undefined)?.backEdge;
  let stroke = "var(--rule-strong)";
  if (branch === "pass") stroke = "color-mix(in oklch, var(--ok) 60%, var(--rule-strong))";
  else if (branch === "fail") stroke = "color-mix(in oklch, var(--danger) 60%, var(--rule-strong))";
  if (selected) stroke = "var(--accent)";
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke,
        strokeWidth: selected ? 2.25 : 1.75,
        strokeLinecap: "round",
        strokeDasharray: backEdge ? "6 6" : undefined,
      }}
    />
  );
}

export const nodeTypes = {
  trigger: TriggerNode,
  worker: WorkerNode,
  guard: GuardNode,
  merge: MergeNode,
};

export const edgeTypes = {
  loom: LoomEdge,
};
