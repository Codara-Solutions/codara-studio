import React from "react";
import { BaseEdge, getBezierPath, Handle, Position } from "@xyflow/react";
import type { EdgeProps, NodeProps } from "@xyflow/react";
import type { GuardPredicate, LoomWorkerConfig } from "@shared/types";
import type { FlowNodeData } from "./model";

// Custom ReactFlow node + edge renderers for the loom canvas. They paint with
// Spark's CSS variables (no n8n purple). Each node exposes a '+' affordance on
// its source handle(s) via an `onAddFrom` callback threaded through node data.

export interface NodeCallbacks {
  /** Open the add-node palette anchored on a node's source handle. */
  onAddFrom?: (nodeId: string, branch?: "pass" | "fail", anchor?: DOMRect) => void;
}

// The trigger summary text is injected via data.label2 to avoid importing
// presentation into every node; the editor stamps it.
type NodeData = FlowNodeData & { summary?: string; onAddFrom?: NodeCallbacks["onAddFrom"] } & Record<
    string,
    unknown
  >;

const SHELL: React.CSSProperties = {
  width: 230,
  borderRadius: "var(--radius-surface)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
  cursor: "default",
};

// The base (unselected) border/shadow/hover live in CSS (.loom-node) so :hover
// can lift them — inline styles would win over CSS and freeze hover. Selection
// styling is applied inline (it must always win, including over :hover).
function shellStyle(selected: boolean | undefined): React.CSSProperties {
  if (!selected) return SHELL;
  return {
    ...SHELL,
    border: "1px solid var(--accent-edge)",
    boxShadow: "var(--lift-hi), 0 0 0 2px var(--accent-soft)",
    background: "color-mix(in oklch, var(--accent) 9%, var(--panel))",
  };
}

function Header({
  glyph,
  eyebrow,
  glyphColor,
  glyphTint,
}: {
  glyph: string;
  eyebrow: string;
  glyphColor?: string;
  glyphTint?: string;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px 6px" }}>
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 6,
          fontSize: 12,
          background: glyphTint ?? "color-mix(in oklch, var(--accent) 14%, var(--panel-2))",
          color: glyphColor ?? "var(--accent)",
          flex: "0 0 auto",
        }}
      >
        {glyph}
      </span>
      <span className="spark-eyebrow">{eyebrow}</span>
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        padding: "0 10px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

function Line({
  text,
  strong,
  title,
}: {
  text: string;
  strong?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <span
      className={strong ? undefined : "spark-mono"}
      title={title ?? text}
      style={{
        fontSize: strong ? 12.5 : 10.5,
        fontWeight: strong ? 600 : undefined,
        color: strong ? "var(--ink)" : "var(--muted)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
      }}
    >
      {text}
    </span>
  );
}

const HANDLE_STYLE: React.CSSProperties = {
  width: 11,
  height: 11,
  background: "var(--panel-3)",
  border: "1.5px solid var(--rule-strong)",
};

// The '+' button that rides a source handle. Positioned just outside the node.
function PlusButton({
  onClick,
  top,
  title,
}: {
  onClick: (e: React.MouseEvent) => void;
  top: string;
  title: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="nodrag nopan"
      title={title}
      onClick={onClick}
      style={{
        position: "absolute",
        right: -34,
        top,
        transform: "translateY(-50%)",
        width: 20,
        height: 20,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        border: "1px solid var(--rule)",
        background: "var(--panel-2)",
        color: "var(--muted)",
        fontSize: 14,
        lineHeight: 1,
        cursor: "default",
        boxShadow: "var(--lift-hi)",
        zIndex: 5,
        transition: "color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--accent)";
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

// ── trigger node (read-only root) ────────────────────────────────────────────

export function TriggerNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  return (
    <div className="loom-node" style={shellStyle(selected)}>
      <Header
        glyph="⚡"
        eyebrow="Trigger"
        glyphColor="var(--warn)"
        glyphTint="color-mix(in oklch, var(--warn) 16%, var(--panel-2))"
      />
      <Body>
        <Line text={d.summary ?? "manual"} strong />
        <Line text="when this fires, the loom runs" />
      </Body>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      {d.onAddFrom && (
        <PlusButton
          title="Add first step"
          top="50%"
          onClick={(e) => {
            e.stopPropagation();
            d.onAddFrom?.(id, undefined, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        />
      )}
    </div>
  );
}

// ── worker node ──────────────────────────────────────────────────────────────

function engineGlyph(engine: LoomWorkerConfig["engine"]): string {
  if (engine === "codex") return "◆";
  if (engine === "claude") return "◇";
  return "⟲";
}

function workerLine(w: LoomWorkerConfig): string {
  if (w.engine === "auto") return "Auto · agent picks";
  const parts = [w.engine === "claude" ? "Claude" : "Codex"];
  if (w.model) parts.push(w.model);
  if (w.effort) parts.push(w.effort);
  return parts.join(" · ");
}

export function WorkerNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  if (d.kind !== "worker") return <div />;
  const promptPreview = d.prompt.trim() || "no prompt yet";
  return (
    <div className="loom-node" style={shellStyle(selected)}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Header glyph={engineGlyph(d.worker.engine)} eyebrow="Worker" />
      <Body>
        <Line text={d.label || "Worker"} strong />
        <Line text={workerLine(d.worker)} />
        <Line
          text={promptPreview.length > 38 ? promptPreview.slice(0, 38) + "…" : promptPreview}
          title={d.prompt}
        />
        {d.retry && d.retry.maxAttempts > 0 && (
          <span className="spark-badge is-info" style={{ alignSelf: "flex-start", marginTop: 2 }}>
            retry ×{d.retry.maxAttempts}
          </span>
        )}
      </Body>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      {d.onAddFrom && (
        <PlusButton
          title="Add next step"
          top="50%"
          onClick={(e) => {
            e.stopPropagation();
            d.onAddFrom?.(id, undefined, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        />
      )}
    </div>
  );
}

// ── guard node (two source handles) ──────────────────────────────────────────

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

export function GuardNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  if (d.kind !== "guard") return <div />;
  return (
    <div className="loom-node" style={shellStyle(selected)}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Header
        glyph="◈"
        eyebrow="Guard"
        glyphColor="var(--ok)"
        glyphTint="color-mix(in oklch, var(--ok) 14%, var(--panel-2))"
      />
      <Body>
        <Line text={d.label || "Guard"} strong />
        <Line text={predicateLine(d.predicate)} />
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <span
            className="spark-badge"
            style={{ color: "var(--ok)", borderColor: "color-mix(in oklch, var(--ok) 35%, transparent)" }}
          >
            pass
          </span>
          <span className="spark-badge is-danger">fail</span>
        </div>
      </Body>
      {/* pass = top-right (green), fail = bottom-right (red) */}
      <Handle
        id="pass"
        type="source"
        position={Position.Right}
        style={{ ...HANDLE_STYLE, top: "34%", borderColor: "var(--ok)", background: "color-mix(in oklch, var(--ok) 40%, var(--panel-3))" }}
      />
      <Handle
        id="fail"
        type="source"
        position={Position.Right}
        style={{ ...HANDLE_STYLE, top: "66%", borderColor: "var(--danger)", background: "color-mix(in oklch, var(--danger) 40%, var(--panel-3))" }}
      />
      {d.onAddFrom && (
        <>
          <PlusButton
            title="Add pass branch"
            top="34%"
            onClick={(e) => {
              e.stopPropagation();
              d.onAddFrom?.(id, "pass", (e.currentTarget as HTMLElement).getBoundingClientRect());
            }}
          />
          <PlusButton
            title="Add fail branch"
            top="66%"
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

// ── merge node ───────────────────────────────────────────────────────────────

export function MergeNode({ id, data, selected }: NodeProps): React.ReactElement {
  const d = data as NodeData;
  if (d.kind !== "merge") return <div />;
  return (
    <div className="loom-node" style={{ ...shellStyle(selected), width: 190 }}>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Header
        glyph="⊕"
        eyebrow="Merge"
        glyphColor="var(--info)"
        glyphTint="color-mix(in oklch, var(--info) 16%, var(--panel-2))"
      />
      <Body>
        <Line text={d.label || "Merge"} strong />
        <Line text={d.joinMode === "all" ? "wait for ALL branches" : "first branch wins"} />
      </Body>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      {d.onAddFrom && (
        <PlusButton
          title="Add next step"
          top="50%"
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
  if (branch === "pass") stroke = "var(--ok)";
  else if (branch === "fail") stroke = "var(--danger)";
  if (selected) stroke = "var(--accent)";
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke,
        strokeWidth: selected ? 2.25 : 1.75,
        strokeDasharray: backEdge ? "5 4" : undefined,
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
