import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  AgentRuntimeDiagnostic,
  CreateScheduledJobInput,
  ScheduledJob,
  UpdateScheduledJobInput,
} from "@shared/types";
import { loopSummary, triggerSummary } from "../presentation";
import NodeContextPanel from "./NodeContextPanel";
import LoopInspector from "./LoopInspector";
import AddNodePalette, { type PaletteState } from "./AddNodePalette";
import { edgeTypes, nodeTypes } from "./FlowNodes";
import { PRESETS, type LoomPreset } from "./presets";
import {
  TRIGGER_ID,
  buildLoop,
  buildTrigger,
  buildWorker,
  concreteWorker,
  defaultNodeData,
  draftFromJob,
  emptyDraft,
  flowFromGraph,
  freshId,
  graphForJob,
  graphFromFlow,
  installedEngines,
  sinkWorkerNode,
  validateGraph,
  type FlowEdge,
  type FlowNode,
  type FlowNodeData,
  type LoomDraft,
  type LoomGraphNodeKind,
} from "./model";

export interface NodeFlowEditorProps {
  initial?: ScheduledJob;
  jobs: ScheduledJob[];
  runtimes: AgentRuntimeDiagnostic[];
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  onCreate?: (input: CreateScheduledJobInput) => void;
  onSave?: (input: UpdateScheduledJobInput) => void;
  onCancel: () => void;
}

export default function NodeFlowEditor(props: NodeFlowEditorProps): React.ReactElement {
  // ReactFlowProvider gives the inner editor access to useReactFlow() (project,
  // fitView) — required for viewport-centered add-node and coordinate mapping.
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({
  initial,
  jobs,
  runtimes,
  workspaceId,
  workspaceName,
  cwd,
  onCreate,
  onSave,
  onCancel,
}: NodeFlowEditorProps): React.ReactElement {
  const editing = Boolean(initial);

  // Installed engines drive every worker's concrete engine/model/effort defaults
  // (a fresh node, a legacy "auto"/blank one loaded for editing, or a preset all
  // resolve against this). "auto" and blank no longer exist as worker choices.
  const installed = useMemo(() => installedEngines(runtimes), [runtimes]);

  // The draft holds name + trigger + loop + (worker defaults). The GRAPH lives
  // in ReactFlow state. Worker node data carries its own LoomWorkerConfig.
  const [draft, setDraft] = useState<LoomDraft>(() =>
    initial ? draftFromJob(initial, installed) : emptyDraft(installed),
  );

  const initialFlow = useMemo(() => {
    if (initial) {
      const flow = flowFromGraph(initial, installed);
      // Open with the trigger selected so its config panel is showing.
      flow.nodes = flow.nodes.map((n) => ({ ...n, selected: n.id === TRIGGER_ID }));
      return flow;
    }
    // New loom: trigger + one empty worker, pre-wired.
    const wid = "w0";
    const nodes: FlowNode[] = [
      {
        id: TRIGGER_ID,
        type: "trigger",
        position: { x: 40, y: 120 },
        data: { kind: "trigger", label: "Trigger" },
        deletable: false,
        selected: true,
      },
      {
        id: wid,
        type: "worker",
        position: { x: 340, y: 120 },
        data: defaultNodeData("worker", installed) as FlowNodeData & Record<string, unknown>,
      },
    ];
    const edges: FlowEdge[] = [{ id: `e-trigger-${wid}`, source: TRIGGER_ID, target: wid, type: "loom" }];
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initialFlow.edges);
  const [selectedId, setSelectedId] = useState<string | null>(TRIGGER_ID);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(!editing);
  const [loopOpen, setLoopOpen] = useState(false);
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);

  const rf = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const markDirty = useCallback(() => setDirty(true), []);

  // Selection source of truth is React Flow's own node.selected flags. This
  // helper writes the flags INTO the nodes state for programmatic selection
  // (initial trigger, after add, presets, focus-problem, pane click) and mirrors
  // the id into selectedId. Never re-derive node.selected from selectedId.
  const selectNode = useCallback(
    (id: string | null) => {
      setNodes((ns) =>
        ns.map((n) => ((!!n.selected) !== (n.id === id) ? { ...n, selected: n.id === id } : n)),
      );
      setSelectedId(id);
    },
    [setNodes],
  );

  // ── change handlers (wrap the state hooks so edits mark dirty) ─────────────
  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      onNodesChange(changes);
      if (changes.some((c) => c.type === "position" || c.type === "remove")) markDirty();
    },
    [onNodesChange, markDirty],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type === "remove")) markDirty();
    },
    [onEdgesChange, markDirty],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      // Carry guard branch from the source handle id.
      const branch = conn.sourceHandle === "pass" || conn.sourceHandle === "fail" ? conn.sourceHandle : undefined;
      setEdges((eds) =>
        addEdge(
          {
            ...conn,
            id: freshId("e"),
            type: "loom",
            data: { branch },
          } as FlowEdge,
          eds,
        ),
      );
      markDirty();
    },
    [setEdges, markDirty],
  );

  // ── node data patch / delete ───────────────────────────────────────────────
  const patchNodeData = useCallback(
    (id: string, patch: Partial<FlowNodeData & Record<string, unknown>>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id
            ? ({ ...n, data: { ...n.data, ...patch } as FlowNode["data"] } as FlowNode)
            : n,
        ),
      );
      markDirty();
    },
    [setNodes, markDirty],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (id === TRIGGER_ID) return;
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      selectNode(null);
      markDirty();
    },
    [setNodes, setEdges, selectNode, markDirty],
  );

  // ── add-node ────────────────────────────────────────────────────────────────
  const openPaletteFrom = useCallback(
    (nodeId: string, branch?: "pass" | "fail", anchor?: DOMRect) => {
      const base = containerRef.current?.getBoundingClientRect();
      if (anchor && base) {
        setPalette({ x: anchor.left - base.left + 26, y: anchor.top - base.top, from: { nodeId, branch } });
      } else {
        setPalette({ x: 80, y: 80, from: { nodeId, branch } });
      }
    },
    [],
  );
  const openPaletteToolbar = useCallback(() => {
    const base = containerRef.current?.getBoundingClientRect();
    setPalette({ x: (base?.width ?? 400) / 2 - 110, y: 64, from: null });
  }, []);

  // Stamp onAddFrom onto every node's data so the '+' buttons can call back.
  // NOTE: do NOT override `selected` here — React Flow owns selection via its
  // own node.selected flags (mirrored to selectedId by onSelectionChange and
  // written programmatically by selectNode). Overriding it here was the bug
  // that made nodes un-clickable.
  const nodesWithCallbacks = useMemo<FlowNode[]>(
    () =>
      nodes.map(
        (n) =>
          ({
            ...n,
            data: {
              ...n.data,
              onAddFrom: openPaletteFrom,
              ...(n.id === TRIGGER_ID
                ? { summary: triggerSummary(buildTrigger(draft.trigger) ?? { kind: "manual" }) }
                : {}),
            } as FlowNode["data"],
          }) as FlowNode,
      ),
    [nodes, openPaletteFrom, draft.trigger],
  );

  const pickNodeKind = useCallback(
    (kind: LoomGraphNodeKind) => {
      const from = palette?.from ?? null;
      const newId = freshId(kind[0]);
      // Position: to the right of the originating node, else viewport center.
      let pos = { x: 0, y: 0 };
      const fromNode = from ? nodes.find((n) => n.id === from.nodeId) : null;
      if (fromNode) {
        pos = { x: fromNode.position.x + 280, y: fromNode.position.y + (from?.branch === "fail" ? 110 : 0) };
        // Fanning out twice from the same node would stack the new card exactly
        // on top of the previous one — nudge down until the slot is free.
        const occupied = (p: { x: number; y: number }): boolean =>
          nodes.some((n) => Math.abs(n.position.x - p.x) < 120 && Math.abs(n.position.y - p.y) < 90);
        while (occupied(pos)) pos = { x: pos.x, y: pos.y + 130 };
      } else {
        const center = rf.screenToFlowPosition
          ? rf.screenToFlowPosition({
              x: (containerRef.current?.getBoundingClientRect().left ?? 0) + (containerRef.current?.clientWidth ?? 600) / 2,
              y: (containerRef.current?.getBoundingClientRect().top ?? 0) + (containerRef.current?.clientHeight ?? 400) / 2,
            })
          : { x: 360, y: 200 };
        pos = center;
      }
      const newNode: FlowNode = {
        id: newId,
        type: kind,
        position: pos,
        data: defaultNodeData(kind, installed) as FlowNodeData & Record<string, unknown>,
        selected: true,
      };
      // Append the new node selected; clear selection from everything else so
      // its config panel opens immediately.
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), newNode]);
      if (from) {
        setEdges((es) =>
          addEdge(
            {
              id: freshId("e"),
              source: from.nodeId,
              target: newId,
              sourceHandle: from.branch,
              type: "loom",
              data: { branch: from.branch },
            } as FlowEdge,
            es,
          ),
        );
      }
      setSelectedId(newId);
      setLoopOpen(false);
      setPalette(null);
      markDirty();
    },
    [palette, nodes, rf, setNodes, setEdges, markDirty, installed],
  );

  // ── presets ──────────────────────────────────────────────────────────────────
  const applyPreset = useCallback(
    (preset: LoomPreset) => {
      // Stamp trigger + loop into the draft, and the graph into the canvas.
      const pw = concreteWorker(preset.worker, installed);
      setDraft((d) => {
        const next: LoomDraft = {
          ...d,
          trigger: { ...d.trigger, kind: preset.trigger.kind },
          loop: { ...d.loop, kind: preset.loop.kind },
          worker: {
            engine: pw.engine,
            model: pw.model,
            effort: pw.effort,
            timeoutMin: preset.worker.timeoutMinutes !== undefined ? String(preset.worker.timeoutMinutes) : "",
          },
        };
        if (preset.trigger.kind === "cron") {
          next.trigger.cronExpr = preset.trigger.expr;
          next.trigger.cronTz = preset.trigger.tz ?? "";
        }
        if (preset.trigger.kind === "folder") next.trigger.folderPath = preset.trigger.path || cwd;
        if (typeof preset.loop.stop.maxIterations === "number") next.loop.maxIters = String(preset.loop.stop.maxIterations);
        if (typeof preset.loop.stop.budgetUsd === "number") next.loop.budget = String(preset.loop.stop.budgetUsd);
        next.loop.untilTests = Boolean(preset.loop.stop.untilTestsPass);
        if (preset.loop.stop.testCommand) next.loop.testCommand = preset.loop.stop.testCommand;
        next.loop.untilGit = Boolean(preset.loop.stop.untilGitClean);
        return next;
      });
      // Build the graph: preset graph if present, else a single worker carrying promptHint.
      const presetJob = {
        graph: preset.graph,
        worker: preset.worker,
        prompt: { template: preset.promptHint },
        input: { initialUserNote: preset.promptHint },
      } as unknown as ScheduledJob;
      const flow = flowFromGraph(presetJob, installed);
      setNodes(flow.nodes.map((n) => ({ ...n, selected: n.id === TRIGGER_ID })));
      setEdges(flow.edges);
      setPresetsOpen(false);
      setDirty(true);
      setSelectedId(TRIGGER_ID);
      setLoopOpen(false);
      requestAnimationFrame(() => rf.fitView?.({ padding: 0.2, duration: 200 }));
    },
    [cwd, rf, setNodes, setEdges, installed],
  );

  // ── validation ────────────────────────────────────────────────────────────
  const triggerBuilt = buildTrigger(draft.trigger);
  const nameMissing = draft.name.trim().length === 0;
  const graphProblem = useMemo(() => validateGraph(nodes, edges), [nodes, edges]);
  const triggerInvalid = !triggerBuilt;
  const firstProblem: { message: string; focusNodeId?: string } | null = nameMissing
    ? { message: "Name the loom." }
    : triggerInvalid
      ? { message: "Finish the trigger setup.", focusNodeId: TRIGGER_ID }
      : graphProblem;
  const canSubmit = !nameMissing && !triggerInvalid && !graphProblem;

  // ── save ────────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const trigger = buildTrigger(draft.trigger);
    if (!trigger) return;
    const loop = buildLoop(draft.loop);
    const graph = graphFromFlow(nodes, edges);

    // Legacy flat fields for rollback safety, mirrored from the SINK worker.
    const sink = sinkWorkerNode(nodes, edges);
    const sinkData = sink && sink.data.kind === "worker" ? sink.data : null;
    const worker = sinkData ? sinkData.worker : buildWorker(draft.worker);
    const template = sinkData ? sinkData.prompt.trim() : draft.loop.template.trim();

    const input = {
      ...(initial?.input ?? {}),
      workspaceId,
      workspaceName,
      cwd,
      planTitle: draft.name.trim(),
      initialUserNote: template,
      chatMode: "execute" as const,
    };

    if (editing && initial && onSave) {
      onSave({
        id: initial.id,
        name: draft.name.trim(),
        trigger,
        input,
        loop,
        prompt: { template },
        worker,
        graph,
      });
    } else if (onCreate) {
      onCreate({
        name: draft.name.trim(),
        trigger,
        input,
        loop,
        prompt: { template },
        worker,
        graph,
        enabled: true,
      });
    }
  }, [canSubmit, draft, nodes, edges, editing, initial, onCreate, onSave, workspaceId, workspaceName, cwd]);

  const handleCancel = useCallback(() => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
  }, [dirty, confirmDiscard, onCancel]);

  useEffect(() => {
    if (!confirmDiscard) return;
    const t = window.setTimeout(() => setConfirmDiscard(false), 2500);
    return () => window.clearTimeout(t);
  }, [confirmDiscard]);

  // Cmd/Ctrl+Enter saves; Escape cancels (two-step when dirty). Backspace/Delete
  // deletes the selected node/edges — but SCOPED to the React Flow canvas (see
  // below) so it can't leak the way ReactFlow's document-level deleteKeyCode
  // does (it would delete from the hidden draft on any keypress app-wide, or
  // delete the node being edited when a right-panel <button> has focus).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        const target = e.target as HTMLElement;
        // Never hijack text editing.
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
        // Only act when focus is genuinely INSIDE the React Flow canvas (a node,
        // edge, the pane, or an edge label). The overlay panels are siblings of
        // <ReactFlow>, so their buttons never match — that's what stops the leak.
        const inCanvas = target.closest(
          ".react-flow__node, .react-flow__edge, .react-flow__pane, .react-flow__edgelabel-renderer",
        );
        if (!inCanvas) return;
        const hasSelectedEdges = edges.some((ed) => ed.selected);
        const deletableNode = selectedId && selectedId !== TRIGGER_ID;
        if (!hasSelectedEdges && !deletableNode) return;
        e.preventDefault();
        if (hasSelectedEdges) {
          setEdges((es) => es.filter((ed) => !ed.selected));
          markDirty();
        }
        if (deletableNode) {
          // deleteNode guards TRIGGER_ID, clears selection, prunes touching
          // edges, and marks dirty.
          deleteNode(selectedId);
        }
      } else if (e.key === "Escape") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
          target.blur();
          return;
        }
        // Escape unwinds the right-side surfaces first: palette > loop panel >
        // node panel (deselect) > then cancel (two-step when dirty).
        if (palette) {
          setPalette(null);
          return;
        }
        if (loopOpen) {
          setLoopOpen(false);
          return;
        }
        if (selectedId) {
          selectNode(null);
          return;
        }
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSubmit, handleCancel, palette, loopOpen, selectedId, selectNode, edges, setEdges, deleteNode, markDirty],
  );

  // Mirror React Flow's selection into selectedId. Selecting a node takes the
  // right panel from the Loop inspector (panel exclusivity).
  const onSelectionChange = useCallback((params: { nodes: FlowNode[] }) => {
    if (params.nodes.length > 0) {
      setSelectedId(params.nodes[0].id);
      setLoopOpen(false);
    } else {
      setSelectedId(null);
    }
  }, []);

  const selectedNode = useMemo(
    () => (selectedId ? (nodes.find((n) => n.id === selectedId) ?? null) : null),
    [nodes, selectedId],
  );

  const focusProblem = useCallback(() => {
    if (firstProblem?.focusNodeId) {
      selectNode(firstProblem.focusNodeId);
      setLoopOpen(false);
    }
  }, [firstProblem, selectNode]);

  const onlyTrigger = nodes.filter((n) => n.id !== TRIGGER_ID).length === 0;

  // The right panel (Loop inspector OR node config, 360px) is shown when the
  // loop is open or a node is selected. It DOCKS as a flex sibling beside the
  // canvas (see body below), so the canvas simply shrinks — nodes stay clickable.
  const rightPanelOpen = loopOpen || Boolean(selectedNode);

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} onKeyDown={handleKeyDown}>
      {/* Header band */}
      <div
        style={{
          flex: "0 0 48px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 16px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--panel)",
        }}
      >
        <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>
          {editing ? "Edit loom" : "New loom"}
        </span>
        <input
          className="spark-input"
          value={draft.name}
          onChange={(e) => {
            setDraft((d) => ({ ...d, name: e.target.value }));
            markDirty();
          }}
          placeholder="What is this loom for?"
          style={{ flex: 1, maxWidth: 360, height: 28 }}
        />
        <span style={{ flex: 1 }} />
        <button type="button" className="spark-btn" style={{ height: 28, fontSize: 12 }} onClick={handleCancel}>
          {confirmDiscard ? "Discard changes?" : "Cancel"}
        </button>
        <button
          type="button"
          className="spark-btn is-primary"
          style={{ height: 28, fontSize: 12 }}
          disabled={!canSubmit}
          onClick={handleSubmit}
          title="Cmd/Ctrl+Enter"
        >
          {editing ? "Save loom" : "Create loom"}
        </button>
      </div>

      {/* Presets band (create flow; collapsible) */}
      {!editing && (
        <div className="loom-template-band">
          <button
            type="button"
            className="loom-template-band__toggle"
            onClick={() => setPresetsOpen((v) => !v)}
            aria-expanded={presetsOpen}
          >
            <span aria-hidden>{presetsOpen ? "▾" : "▸"}</span>
            <span>Start from a proven workflow</span>
            <span className="loom-template-band__hint">Pick one, then change only what matters</span>
          </button>
          {presetsOpen && (
            <div className="loom-template-list">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="loom-template-card"
                  onClick={() => applyPreset(p)}
                  title={p.blurb}
                >
                  <span className="loom-template-card__topline">
                    <span className="loom-template-card__icon" aria-hidden>
                      {presetIcon(p.id)}
                    </span>
                    <span className="loom-template-card__title">{p.title}</span>
                  </span>
                  <span className="loom-template-card__blurb">{p.blurb}</span>
                  <span className="loom-template-card__meta spark-mono">
                    {triggerSummary(p.trigger)} · {loopSummary(p.loop)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Editor body: a flex ROW. The canvas wrapper flexes to fill the space
          left of the right panel; the panel DOCKS as a normal flex sibling
          (n8n behavior) instead of overlaying — so nodes under it stay
          clickable. React Flow auto-resizes (ResizeObserver) as the wrapper
          width changes; the editor mounts with the trigger pre-selected, so the
          initial fitView already measures the narrowed canvas. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
        {/* LEFT — canvas wrapper. containerRef stays here so palette anchoring
            and screenToFlowPosition math read the canvas, not the panel. */}
        <div
          ref={containerRef}
          className="loom-flow"
          style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
        >
        {/* Canvas toolbar */}
        <div style={{ position: "absolute", top: 10, left: 10, zIndex: 10, display: "flex", gap: 6 }}>
          <button type="button" className="spark-btn" style={{ height: 26, fontSize: 11 }} onClick={openPaletteToolbar}>
            + Add node
          </button>
          <button type="button" className="spark-btn" style={{ height: 26, fontSize: 11 }} onClick={() => rf.fitView?.({ padding: 0.2, duration: 200 })}>
            Fit
          </button>
          <button
            type="button"
            className={`spark-btn${showMiniMap ? " is-primary" : ""}`}
            style={{ height: 26, fontSize: 11 }}
            onClick={() => setShowMiniMap((v) => !v)}
            title="Toggle minimap"
          >
            Map
          </button>
        </div>

        {/* Loop chip (pinned, read-only; opens the inspector). Opening the loop
            panel deselects any node so only one right panel shows at a time. */}
        <button
          type="button"
          onClick={() => {
            selectNode(null);
            setLoopOpen(true);
          }}
          title="Loop & stops — how the whole graph repeats"
          style={{
            position: "absolute",
            top: 10,
            // Lives inside the canvas wrapper now (the panel docks beside it),
            // so it never needs to slide clear of the right panel.
            right: 10,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: 7,
            height: 30,
            padding: "0 11px",
            borderRadius: "var(--radius-surface)",
            border: `1px solid ${loopOpen ? "var(--accent-edge)" : "var(--rule)"}`,
            background: "var(--panel)",
            boxShadow: "var(--shadow-1)",
            cursor: "default",
          }}
        >
          <span aria-hidden style={{ color: "var(--accent)", fontSize: 13 }}>↻</span>
          <span className="spark-eyebrow">Loop</span>
          <span className="spark-mono" style={{ fontSize: 10.5, color: "var(--ink-dim)" }}>
            {loopSummary(buildLoop(draft.loop))}
          </span>
        </button>

        <ReactFlow
          nodes={nodesWithCallbacks}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.3}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
          // Delete is handled by the root onKeyDown (handleKeyDown), scoped to
          // the canvas — ReactFlow's deleteKeyCode is a document-level listener
          // that would leak into the hidden draft and into right-panel buttons.
          deleteKeyCode={null}
          onPaneClick={() => {
            selectNode(null);
            setPalette(null);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--rule)" />
          <Controls showInteractive={false} />
          {showMiniMap && (
            <MiniMap
              pannable
              zoomable
              nodeColor={() => "color-mix(in oklch, var(--accent) 40%, var(--panel-3))"}
              maskColor="color-mix(in oklch, var(--bg) 62%, transparent)"
            />
          )}
        </ReactFlow>

        {/* Empty-state placeholder when only the trigger is present. */}
        {onlyTrigger && !palette && (
          <button
            type="button"
            onClick={openPaletteToolbar}
            style={{
              position: "absolute",
              top: "50%",
              // Centers within the canvas wrapper (the panel is a sibling now,
              // so no panel-width compensation is needed).
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 8,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              width: 200,
              padding: "18px 16px",
              borderRadius: "var(--radius-surface)",
              border: "1.5px dashed var(--rule-strong)",
              background: "color-mix(in oklch, var(--panel) 70%, transparent)",
              color: "var(--muted)",
              cursor: "default",
            }}
          >
            <span style={{ fontSize: 20, color: "var(--accent)" }}>+</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-dim)" }}>Add first step</span>
            <span style={{ fontSize: 10.5, color: "var(--muted-2)", textAlign: "center" }}>
              Wire a Worker, Guard, or Merge after the trigger.
            </span>
          </button>
        )}

        {/* Add-node palette popover (anchored to the canvas wrapper) */}
        {palette && <AddNodePalette state={palette} onPick={pickNodeKind} onClose={() => setPalette(null)} />}
        </div>

        {/* RIGHT — docked panel (flex sibling, not an overlay). Exclusive: Loop
            inspector wins when open, else the selected node's config panel. */}
        {rightPanelOpen && (
          <div
            style={{
              flex: "0 0 360px",
              minWidth: 0,
              height: "100%",
              borderLeft: "1px solid var(--rule)",
              background: "var(--panel)",
            }}
          >
            {loopOpen ? (
              <LoopInspector
                loop={draft.loop}
                onChange={(loop) => {
                  setDraft((d) => ({ ...d, loop }));
                  markDirty();
                }}
                onClose={() => setLoopOpen(false)}
              />
            ) : (
              selectedNode && (
                <NodeContextPanel
                  node={selectedNode}
                  edges={edges}
                  onPatchNodeData={patchNodeData}
                  onDeleteNode={deleteNode}
                  onClose={() => selectNode(null)}
                  trigger={draft.trigger}
                  onTriggerChange={(trigger) => {
                    setDraft((d) => ({ ...d, trigger }));
                    markDirty();
                  }}
                  cwd={cwd}
                  chainableJobs={jobs.filter((j) => j.id !== initial?.id)}
                  runtimes={runtimes}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* Validation footer */}
      <div
        style={{
          flex: "0 0 36px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 16px",
          borderTop: "1px solid var(--rule-soft)",
          background: "var(--panel)",
        }}
      >
        {firstProblem ? (
          <button
            type="button"
            onClick={focusProblem}
            style={{ appearance: "none", background: "transparent", border: "none", padding: 0, cursor: "default", fontSize: 11, color: "var(--warn, var(--danger))" }}
          >
            ⚠ {firstProblem.message}
          </button>
        ) : (
          <span className="spark-mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>
            Ready — Cmd/Ctrl+Enter to {editing ? "save" : "create"}.
          </span>
        )}
      </div>
    </div>
  );
}

// graphForJob is re-exported for callers that want the resolved graph shape.
export { graphForJob };

function presetIcon(id: string): string {
  if (id === "until-tests") return "✓";
  if (id === "fanout-review") return "⑂";
  if (id === "nightly") return "◷";
  if (id === "watch") return "◉";
  if (id === "continuous") return "∞";
  if (id === "agent") return "✦";
  return "+";
}
