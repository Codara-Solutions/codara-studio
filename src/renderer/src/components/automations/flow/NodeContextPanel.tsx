import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentEffortLevel,
  AutomationTrigger,
  FolderTriggerEvent,
  GuardPredicate,
  LoomScriptLanguage,
  LoomStepAction,
  LoomStepNode,
  LoomStepResult,
  LoomWorkerConfig,
  ScheduledJob,
} from "@shared/types";
import { DEFAULT_ITERATION_TIMEOUT_MINUTES } from "@shared/types";
import { Check, Field, Segmented } from "../FormKit";
import { EFFORT_LABELS, WORKER_MODELS, workerEffortsFor } from "../worker-models";
import { LoomIcon } from "./FlowNodes";
import {
  upstreamNodeIds,
  TRIGGER_ID,
  type FlowEdge,
  type FlowNode,
  type FlowNodeData,
  type TriggerDraft,
} from "./model";
import { STEP_META, STEP_TONE, STEP_TYPES, defaultStepAction, stepTitle, validateStepAction } from "./step-meta";

// The per-selected-node config panel — a fill-height column DOCKED beside the
// canvas (mirrors LoopInspector). Dispatches on node kind: the trigger
// node edits job.trigger; worker/guard/merge nodes edit their graph data. The
// panel owns its header (kind glyph + label + close) and a footer Delete for
// non-trigger nodes.

const TRIGGER_KINDS: { value: AutomationTrigger["kind"]; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "cron", label: "Cron" },
  { value: "interval", label: "Interval" },
  { value: "folder", label: "Folder" },
  { value: "continuous", label: "Continuous" },
  { value: "onFinishOf", label: "After automation" },
];

const FOLDER_EVENTS: FolderTriggerEvent[] = ["add", "change", "unlink"];
// Prompt variables display uppercase (spark-badge's text-transform) but insert
// the literal lowercase token — the executor's substitution is case-sensitive.
const BASE_VARIABLES: { token: string; tip: string }[] = [
  { token: "{{iteration}}", tip: "The current loop pass number, starting at 0." },
  { token: "{{lastOutput}}", tip: "The previous pass's final summary. It is empty on the first pass." },
  { token: "{{file}}", tip: "The path that fired a folder trigger. It is empty for non-folder triggers." },
  { token: "{{date}}", tip: "Today's local date in YYYY-MM-DD format." },
  { token: "{{name}}", tip: "The name of this automation." },
  { token: "{{incoming}}", tip: "Output from upstream workers in this pass, labeled by branch." },
];

function PromptVariableChip({
  token,
  tip,
  onInsert,
}: {
  token: string;
  tip: string;
  onInsert: () => void;
}): React.ReactElement {
  const tooltipId = `automation-variable-${token.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <span className="automation-variable-chip">
      <button
        type="button"
        className="spark-badge is-accent"
        aria-describedby={tooltipId}
        onClick={onInsert}
      >
        {token}
      </button>
      <span id={tooltipId} role="tooltip" className="automation-variable-chip__tooltip">
        <span className="automation-variable-chip__token">{token}</span>
        <span>{tip}</span>
        <span className="automation-variable-chip__action">Click to insert into the prompt.</span>
      </span>
    </span>
  );
}

export interface NodeContextPanelProps {
  node: FlowNode | null;
  edges: FlowEdge[];
  /** Patch the selected node's data (worker/guard/merge). */
  onPatchNodeData: (id: string, patch: Partial<FlowNodeData & Record<string, unknown>>) => void;
  /** Delete the selected node. */
  onDeleteNode: (id: string) => void;
  /** Close (deselect) the panel. */
  onClose: () => void;
  // Trigger editing surface.
  trigger: TriggerDraft;
  onTriggerChange: (next: TriggerDraft) => void;
  cwd: string;
  chainableJobs: ScheduledJob[];
  /** Looms v3: the most recent pass's per-node outputs (what each node
   *  printed / returned last time). Feeds the step panel's "Last output" and
   *  its test-run's {{node:<id>}} samples. Empty for a new loom. */
  lastOutputs?: Record<string, string>;
  /** The automation's name ({{name}} in a step test-run). */
  automationName?: string;
}

// Kind → glyph + amber/accent/mixed/info tint for the header chip.
function kindGlyph(node: FlowNode): { glyph: React.ReactNode; eyebrow: string; color: string; tint: string } {
  const d = node.data;
  switch (d.kind) {
    case "step":
      return {
        glyph: <LoomIcon kind="step" stepType={d.action.type} tone={STEP_TONE} size={14} />,
        eyebrow: STEP_META[d.action.type].eyebrow,
        color: STEP_TONE,
        tint: "color-mix(in oklch, var(--automation) 14%, var(--panel-2))",
      };
    case "trigger":
      return { glyph: "⚡", eyebrow: "Trigger", color: "var(--warn)", tint: "color-mix(in oklch, var(--warn) 16%, var(--panel-2))" };
    case "worker":
      return {
        glyph: "◇",
        eyebrow: "Worker",
        color: "var(--accent-text)",
        tint: "color-mix(in oklch, var(--accent) 14%, var(--panel-2))",
      };
    case "guard":
      return { glyph: "◈", eyebrow: "Guard", color: "var(--ok)", tint: "color-mix(in oklch, var(--ok) 14%, var(--panel-2))" };
    case "merge":
      return { glyph: "⊕", eyebrow: "Merge", color: "var(--info)", tint: "color-mix(in oklch, var(--info) 16%, var(--panel-2))" };
  }
}

export default function NodeContextPanel(props: NodeContextPanelProps): React.ReactElement | null {
  const { node, onClose, onDeleteNode } = props;
  if (!node) return null;
  const kind = node.data.kind;
  const meta = kindGlyph(node);
  const title =
    kind === "trigger"
      ? "Trigger"
      : node.data.kind === "step"
        ? stepTitle(node.data)
        : ((node.data.label as string) || meta.eyebrow);
  const deletable = node.id !== TRIGGER_ID;

  return (
    <div
      key={node.id}
      className="spark-fade-in"
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Head glyph={meta.glyph} glyphColor={meta.color} tint={meta.tint} eyebrow={meta.eyebrow} title={title} onClose={onClose} />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
        {kind === "trigger" ? (
          <TriggerForm
            trigger={props.trigger}
            onChange={props.onTriggerChange}
            cwd={props.cwd}
            chainableJobs={props.chainableJobs}
          />
        ) : kind === "worker" ? (
          <WorkerForm {...props} node={node} />
        ) : kind === "guard" ? (
          <GuardForm {...props} node={node} />
        ) : kind === "step" ? (
          <StepForm {...props} node={node} />
        ) : (
          <MergeForm {...props} node={node} />
        )}
      </div>

      {deletable && (
        <div
          style={{
            flex: "0 0 auto",
            borderTop: "1px solid var(--rule-soft)",
            padding: "10px 18px",
            background: "var(--panel)",
          }}
        >
          <button
            type="button"
            className="spark-btn is-danger"
            style={{ width: "100%", height: 30, fontSize: 12 }}
            onClick={() => onDeleteNode(node.id)}
          >
            Delete node
          </button>
        </div>
      )}
    </div>
  );
}

// ── layout atoms (mirror LoopInspector) ──────────────────────────────────────

function Head({
  glyph,
  glyphColor,
  tint,
  eyebrow,
  title,
  onClose,
}: {
  glyph: React.ReactNode;
  glyphColor: string;
  tint: string;
  eyebrow: string;
  title: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px 12px 18px",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 7, background: tint, color: glyphColor, fontSize: 14 }}>
        {glyph}
      </span>
      <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <span className="spark-eyebrow">{eyebrow}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
      </span>
      <button
        type="button"
        className="spark-btn"
        style={{ height: 26, width: 26, padding: 0, fontSize: 14 }}
        title="Close"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

function Group({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {label && <span className="spark-eyebrow">{label}</span>}
      {hint && <span style={{ fontSize: 10.5, lineHeight: 1.5, color: "var(--muted)", marginTop: -2 }}>{hint}</span>}
      {children}
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--muted)",
        lineHeight: 1.5,
        background: "var(--panel-2)",
        borderRadius: "var(--radius-control)",
        padding: "8px 10px",
      }}
    >
      {children}
    </div>
  );
}

// ── trigger ──────────────────────────────────────────────────────────────────

function TriggerForm({
  trigger,
  onChange,
  cwd,
  chainableJobs,
}: {
  trigger: TriggerDraft;
  onChange: (next: TriggerDraft) => void;
  cwd: string;
  chainableJobs: ScheduledJob[];
}): React.ReactElement {
  const t = trigger;
  const set = (patch: Partial<TriggerDraft>): void => onChange({ ...t, ...patch });
  return (
    <>
      <Group label="When to start">
        <Segmented options={TRIGGER_KINDS} value={t.kind} onChange={(v) => set({ kind: v })} wrap />
      </Group>
      {t.kind === "manual" && (
        <Hint>Fires only when you press Run now, or when another automation chains into it.</Hint>
      )}
      {t.kind === "cron" && (
        <Group>
          <Field label="Cron expression" grow>
            <input
              className="spark-input spark-mono"
              value={t.cronExpr}
              onChange={(e) => set({ cronExpr: e.target.value })}
              placeholder="0 2 * * *"
            />
          </Field>
          <Field label="Timezone (optional)" grow>
            <input
              className="spark-input spark-mono"
              value={t.cronTz}
              onChange={(e) => set({ cronTz: e.target.value })}
              placeholder="America/New_York"
            />
          </Field>
        </Group>
      )}
      {t.kind === "interval" && (
        <Field label="Every (minutes)">
          <input
            className="spark-input spark-mono"
            type="number"
            min={1}
            value={t.intervalMin}
            onChange={(e) => set({ intervalMin: e.target.value })}
            style={{ maxWidth: 140 }}
          />
        </Field>
      )}
      {t.kind === "folder" && (
        <Group>
          <Field label="Folder path">
            <input
              className="spark-input spark-mono"
              value={t.folderPath}
              onChange={(e) => set({ folderPath: e.target.value })}
              placeholder={cwd}
            />
          </Field>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span className="spark-eyebrow">Events</span>
            {FOLDER_EVENTS.map((e) => (
              <Check
                key={e}
                label={e}
                checked={t.folderEvents[e]}
                onToggle={() => set({ folderEvents: { ...t.folderEvents, [e]: !t.folderEvents[e] } })}
              />
            ))}
          </div>
          <Field label="Glob (optional)">
            <input
              className="spark-input spark-mono"
              value={t.folderGlob}
              onChange={(e) => set({ folderGlob: e.target.value })}
              placeholder="*.md"
              style={{ maxWidth: 200 }}
            />
          </Field>
        </Group>
      )}
      {t.kind === "continuous" && (
        <Hint>Starts looping the moment the automation is armed. Bound it with the Loop caps.</Hint>
      )}
      {t.kind === "onFinishOf" && (
        <Field label="Start after this automation finishes">
          {chainableJobs.length === 0 ? (
            <span style={{ fontSize: 11, color: "var(--muted-2)" }}>
              No other automations in this workspace to chain off yet.
            </span>
          ) : (
            <select
              className="spark-select"
              value={t.chainSourceId}
              onChange={(e) => set({ chainSourceId: e.target.value })}
            >
              <option value="">Choose an automation…</option>
              {chainableJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
    </>
  );
}

// ── worker ───────────────────────────────────────────────────────────────────

function WorkerForm({
  node,
  edges,
  onPatchNodeData,
}: NodeContextPanelProps & { node: FlowNode }): React.ReactElement {
  const d = node.data;
  if (d.kind !== "worker") return <></>;
  const w = d.worker;
  const setWorker = (patch: Partial<LoomWorkerConfig>): void =>
    onPatchNodeData(node.id, { worker: { ...w, ...patch } });

  // {{node:<id>}} chips come from UPSTREAM nodes only.
  const upstream = useMemo(() => upstreamNodeIds(node.id, edges), [node.id, edges]);

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const insertVariable = useCallback(
    (v: string) => {
      const el = promptRef.current;
      const cur = d.prompt;
      if (!el) {
        onPatchNodeData(node.id, { prompt: cur + v });
        return;
      }
      const start = el.selectionStart ?? cur.length;
      const end = el.selectionEnd ?? cur.length;
      onPatchNodeData(node.id, { prompt: cur.slice(0, start) + v + cur.slice(end) });
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + v.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [d.prompt, node.id, onPatchNodeData],
  );

  return (
    <>
      <Field label="Label">
        <input
          className="spark-input"
          value={d.label}
          onChange={(e) => onPatchNodeData(node.id, { label: e.target.value })}
          placeholder="Worker"
        />
      </Field>

      <Group hint="Workers run on Cora's bundled runtime with your connected subscriptions.">
        {/* Model + effort are required — every worker carries a concrete value.
            A stored model outside the current roster renders as an explicit
            "(unavailable)" option instead of silently showing the wrong pick. */}
        <div style={{ display: "flex", gap: 10 }}>
          <Field label="Model" grow>
            <select className="spark-select" value={w.model ?? ""} onChange={(e) => setWorker({ model: e.target.value })}>
              {w.model && !WORKER_MODELS.some((m) => m.id === w.model) && (
                <option value={w.model}>{w.model} (unavailable)</option>
              )}
              {WORKER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.note})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort" grow>
            {/* Ladder gated per model (no GPT-5.6 variant takes minimal). A stored effort
                outside the current model's ladder renders as an explicit
                "(unavailable)" option rather than silently moving the pick. */}
            <select className="spark-select" value={w.effort ?? ""} onChange={(e) => setWorker({ effort: e.target.value as AgentEffortLevel })}>
              {w.effort && !workerEffortsFor(w.model).includes(w.effort) && (
                <option value={w.effort}>{w.effort} (unavailable)</option>
              )}
              {workerEffortsFor(w.model).map((lvl) => (
                <option key={lvl} value={lvl}>
                  {EFFORT_LABELS[lvl]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Per-pass timeout (minutes)">
          <input
            className="spark-input spark-mono"
            type="number"
            min={1}
            value={w.timeoutMinutes !== undefined ? String(w.timeoutMinutes) : ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              setWorker({ timeoutMinutes: e.target.value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined });
            }}
            placeholder={String(DEFAULT_ITERATION_TIMEOUT_MINUTES)}
            style={{ maxWidth: 140 }}
          />
        </Field>
      </Group>

      <Group label="Prompt">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {BASE_VARIABLES.map((v) => (
            <PromptVariableChip
              key={v.token}
              token={v.token}
              tip={v.tip}
              onInsert={() => insertVariable(v.token)}
            />
          ))}
          {upstream.map((nid) => (
            <PromptVariableChip
              key={nid}
              token={`{{node:${nid}}}`}
              tip={`Output from upstream node ${nid} in the current pass.`}
              onInsert={() => insertVariable(`{{node:${nid}}}`)}
            />
          ))}
        </div>
        {upstream.length > 0 && (
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: "var(--muted)", marginTop: -2 }}>
            This node automatically receives its upstream output: place {"{{incoming}}"} in the
            prompt to control where it appears, or {"{{node:…}}"} to pull ONE specific parent
            (other parents are then omitted).
          </span>
        )}
        <textarea
          ref={promptRef}
          className="spark-input"
          value={d.prompt}
          onChange={(e) => onPatchNodeData(node.id, { prompt: e.target.value })}
          placeholder="What should this node's worker do? Use the variables above to reference loop state and upstream node outputs."
          rows={6}
          style={{ height: "auto", minHeight: 120, padding: "8px 10px", resize: "vertical", lineHeight: 1.5 }}
        />
      </Group>

      <Group label="Run lineage">
        <Check
          label="Run this node in a fresh sandbox/run lineage (isolate)"
          checked={Boolean(d.isolate)}
          onToggle={() => onPatchNodeData(node.id, { isolate: !d.isolate })}
        />
      </Group>

      <Group
        label="Collaboration"
        hint="Only matters when 2+ workers run in the same parallel wave."
      >
        <Check
          label="Knows its siblings: peers listed in the prompt"
          checked={Boolean(d.collab?.awareness)}
          onToggle={() =>
            onPatchNodeData(node.id, {
              collab: { ...d.collab, awareness: !d.collab?.awareness },
            })
          }
        />
        <Check
          label="Can message siblings: shared board in the run folder"
          checked={Boolean(d.collab?.chat)}
          onToggle={() =>
            onPatchNodeData(node.id, {
              collab: { ...d.collab, chat: !d.collab?.chat },
            })
          }
        />
      </Group>

      {/* Retry */}
      <Group label="Retry (optional)">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)" }}>
          max attempts
          <input
            className="spark-input spark-mono"
            type="number"
            min={0}
            value={d.retry?.maxAttempts ?? ""}
            placeholder="0"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!e.target.value.trim() || !Number.isFinite(n) || n <= 0) {
                onPatchNodeData(node.id, { retry: undefined });
              } else {
                onPatchNodeData(node.id, { retry: { maxAttempts: Math.round(n), until: d.retry?.until } });
              }
            }}
            style={{ width: 72, height: 26 }}
          />
        </label>
        {d.retry && d.retry.maxAttempts > 0 && (
          <PredicatePicker
            compact
            value={d.retry.until ?? { type: "tests", command: "npm test" }}
            onChange={(p) => onPatchNodeData(node.id, { retry: { maxAttempts: d.retry!.maxAttempts, until: p } })}
            label="until"
          />
        )}
      </Group>
    </>
  );
}

// ── guard ────────────────────────────────────────────────────────────────────

function GuardForm({
  node,
  onPatchNodeData,
}: NodeContextPanelProps & { node: FlowNode }): React.ReactElement {
  const d = node.data;
  if (d.kind !== "guard") return <></>;
  return (
    <>
      <Field label="Label">
        <input
          className="spark-input"
          value={d.label}
          onChange={(e) => onPatchNodeData(node.id, { label: e.target.value })}
          placeholder="Guard"
        />
      </Field>
      <Group label="Condition: routes to pass or fail">
        <PredicatePicker value={d.predicate} onChange={(p) => onPatchNodeData(node.id, { predicate: p })} />
      </Group>
      <Hint>
        The <span style={{ color: "var(--ok)" }}>pass</span> handle (top) fires when the condition holds;
        the <span style={{ color: "var(--danger)" }}>fail</span> handle (bottom) otherwise. Wire both.
      </Hint>
    </>
  );
}

const PREDICATE_KINDS: { value: GuardPredicate["type"]; label: string }[] = [
  { value: "phrase", label: "Phrase" },
  { value: "tests", label: "Tests" },
  { value: "gitClean", label: "Git clean" },
  { value: "command", label: "Command" },
  { value: "agentSignal", label: "Agent signal" },
];

function PredicatePicker({
  value,
  onChange,
  compact,
  label,
}: {
  value: GuardPredicate;
  onChange: (p: GuardPredicate) => void;
  compact?: boolean;
  label?: string;
}): React.ReactElement {
  const setType = (type: GuardPredicate["type"]): void => {
    switch (type) {
      case "phrase":
        onChange({ type: "phrase", phrase: "" });
        break;
      case "tests":
        onChange({ type: "tests", command: "npm test" });
        break;
      case "gitClean":
        onChange({ type: "gitClean" });
        break;
      case "command":
        onChange({ type: "command", command: "" });
        break;
      case "agentSignal":
        onChange({ type: "agentSignal", want: "done" });
        break;
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {label && <span className="spark-eyebrow">{label}</span>}
      <Segmented options={PREDICATE_KINDS} value={value.type} onChange={setType} wrap />
      {value.type === "phrase" && (
        <input
          className="spark-input"
          value={value.phrase}
          onChange={(e) => onChange({ type: "phrase", phrase: e.target.value, source: value.source })}
          placeholder="Summary contains this phrase…"
          style={{ maxWidth: compact ? 220 : undefined, height: 28 }}
        />
      )}
      {value.type === "tests" && (
        <input
          className="spark-input spark-mono"
          value={value.command ?? ""}
          onChange={(e) => onChange({ type: "tests", command: e.target.value || undefined })}
          placeholder="npm test"
          style={{ maxWidth: compact ? 220 : undefined, height: 28 }}
        />
      )}
      {value.type === "command" && (
        <input
          className="spark-input spark-mono"
          value={value.command}
          onChange={(e) => onChange({ type: "command", command: e.target.value })}
          placeholder="./check.sh (exit 0 = pass)"
          style={{ maxWidth: compact ? 220 : undefined, height: 28 }}
        />
      )}
      {value.type === "agentSignal" && (
        <Segmented
          options={[
            { value: "continue" as const, label: "continue" },
            { value: "done" as const, label: "done" },
          ]}
          value={value.want}
          onChange={(want) => onChange({ type: "agentSignal", want })}
        />
      )}
      {value.type === "gitClean" && (
        <span style={{ fontSize: 11, color: "var(--muted)" }}>Passes when the working tree has no changes.</span>
      )}
    </div>
  );
}

// ── merge ────────────────────────────────────────────────────────────────────

function MergeForm({
  node,
  onPatchNodeData,
}: NodeContextPanelProps & { node: FlowNode }): React.ReactElement {
  const d = node.data;
  if (d.kind !== "merge") return <></>;
  return (
    <>
      <Field label="Label">
        <input
          className="spark-input"
          value={d.label}
          onChange={(e) => onPatchNodeData(node.id, { label: e.target.value })}
          placeholder="Merge"
        />
      </Field>
      <Group label="Join mode">
        <Segmented
          options={[
            { value: "all" as const, label: "All branches" },
            { value: "any" as const, label: "Any branch" },
          ]}
          value={d.joinMode}
          onChange={(joinMode) => onPatchNodeData(node.id, { joinMode })}
        />
      </Group>
      <Hint>
        {d.joinMode === "all"
          ? "Waits for every inbound branch to finish before continuing."
          : "Continues as soon as the first inbound branch finishes."}
      </Hint>
    </>
  );
}


// ── step (Looms v3) ──────────────────────────────────────────────────────────
// A deterministic action. The form is the action's fields plus the shared
// knobs (timeout, soft-fail); below it, a "Run step" console executes the node
// right now with the same executor a pass uses and shows stdout / stderr /
// exit code / duration — so you never wire a command blind. "Last output"
// shows what the node produced on the most recent pass.

const STEP_KIND_OPTIONS = STEP_TYPES.map((t) => ({ value: t, label: STEP_META[t].eyebrow }));
const SCRIPT_LANGS: { value: LoomScriptLanguage; label: string }[] = [
  { value: "python", label: "Python" },
  { value: "node", label: "Node" },
  { value: "bash", label: "Bash" },
];
const HTTP_METHODS: { value: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; label: string }[] = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
];

// What a blank "Run with" means per language, and the runners people reach
// for most — one click each; anything else is typed in.
const INTERPRETER_DEFAULT: Record<LoomScriptLanguage, string> = {
  python: "python3 (or python)",
  node: "bundled node runtime",
  bash: "bash",
};
const INTERPRETER_PRESETS: Record<LoomScriptLanguage, string[]> = {
  python: ["", "uv run python", "uv run --script", ".venv/bin/python", "python3.12", "conda run -n base python", "pipenv run python", "poetry run python"],
  node: ["", "node", "bun", "deno run -A", "npx tsx"],
  bash: ["", "zsh", "sh", "bash -e"],
};

const STEP_VARIABLES: { token: string; tip: string }[] = [
  { token: "{{incoming}}", tip: "Output from the node(s) wired into this one." },
  { token: "{{date}}", tip: "Today's local date, YYYY-MM-DD." },
  { token: "{{iteration}}", tip: "The current loop pass number, starting at 0." },
  { token: "{{lastOutput}}", tip: "The previous pass's final output." },
  { token: "{{file}}", tip: "The path that fired a folder trigger." },
  { token: "{{name}}", tip: "The name of this automation." },
];

function StepForm({
  node,
  edges,
  onPatchNodeData,
  cwd,
  lastOutputs,
  automationName,
}: NodeContextPanelProps & { node: FlowNode }): React.ReactElement {
  const d = node.data;
  if (d.kind !== "step") return <></>;
  const action = d.action;
  const setAction = (next: LoomStepAction): void => onPatchNodeData(node.id, { action: next });
  const patchAction = (patch: Partial<LoomStepAction>): void =>
    setAction({ ...action, ...patch } as LoomStepAction);
  const upstream = useMemo(() => upstreamNodeIds(node.id, edges), [node.id, edges]);

  // Variable insertion targets the field that was last focused.
  const focusedRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const insertVariable = (v: string): void => {
    const el = focusedRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + v + el.value.slice(end);
    const field = el.dataset.field as keyof LoomStepAction | undefined;
    if (!field) return;
    patchAction({ [field]: next } as Partial<LoomStepAction>);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + v.length;
      el.setSelectionRange(pos, pos);
    });
  };
  const track = (e: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    focusedRef.current = e.currentTarget;
  };

  // ── Run step console ──
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LoomStepResult | null>(null);
  const runNow = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const testNode: LoomStepNode = {
        id: node.id,
        kind: "step",
        label: d.label || undefined,
        action: d.action,
        timeoutSec: d.timeoutSec,
        continueOnError: d.continueOnError,
      };
      const samples: Record<string, string> = {};
      for (const id of upstream) if (lastOutputs?.[id] !== undefined) samples[id] = lastOutputs[id];
      const r = await window.spark.scheduler.testStep({
        cwd,
        node: testNode,
        nodeOutputs: samples,
        vars: { name: automationName?.trim() || "automation" },
      });
      setResult(r);
    } catch (e) {
      setResult({ ok: false, output: "", durationMs: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }, [running, node.id, d, upstream, lastOutputs, cwd, automationName]);
  // A new node (or a changed action kind) starts with a clean console.
  useEffect(() => {
    setResult(null);
  }, [node.id, action.type]);

  const problem = validateStepAction(action);
  const lastOutput = lastOutputs?.[node.id];
  const mono: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, width: "100%", maxWidth: "100%", boxSizing: "border-box" };

  return (
    <>
      <Field label="Label">
        <input
          className="spark-input"
          value={d.label}
          onChange={(e) => onPatchNodeData(node.id, { label: e.target.value })}
          placeholder={STEP_META[action.type].title}
        />
      </Field>

      <Group label="What it does" hint={STEP_META[action.type].blurb}>
        <Segmented
          options={STEP_KIND_OPTIONS}
          value={action.type}
          onChange={(t) => setAction(defaultStepAction(t))}
          wrap
        />
      </Group>

      <Group label="Variables" hint="Click to insert into the field you were editing. Add |json to any token to get a quoted JSON string (safe inside an HTTP body), |line for its first line. Inside a command or script, upstream output is also available as $NODE_OUTPUT_<ID>, $INCOMING, $DATE.">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STEP_VARIABLES.map((v) => (
            <PromptVariableChip key={v.token} token={v.token} tip={v.tip} onInsert={() => insertVariable(v.token)} />
          ))}
          {upstream.map((nid) => (
            <PromptVariableChip
              key={nid}
              token={`{{node:${nid}}}`}
              tip={`Output from upstream node ${nid} in the current pass.`}
              onInsert={() => insertVariable(`{{node:${nid}}}`)}
            />
          ))}
        </div>
      </Group>

      {action.type === "command" && (
        <Group label="Command">
          <textarea
            className="spark-input"
            data-field="command"
            data-testid="step-command"
            value={action.command}
            onFocus={track}
            onChange={(e) => patchAction({ command: e.target.value })}
            placeholder={"npm test 2>&1 | tail -n 20"}
            rows={4}
            spellCheck={false}
            style={{ ...mono, height: "auto", minHeight: 88, padding: "8px 10px", resize: "vertical" }}
          />
          <Field label="Working directory (optional)">
            <input
              className="spark-input spark-mono"
              data-field="cwd"
              value={action.cwd ?? ""}
              onFocus={track}
              onChange={(e) => patchAction({ cwd: e.target.value || undefined })}
              placeholder={cwd}
            />
          </Field>
          <EnvEditor value={action.env} onChange={(env) => patchAction({ env })} />
        </Group>
      )}

      {action.type === "script" && (
        <Group label="Script">
          <Segmented options={SCRIPT_LANGS} value={action.language} onChange={(language) => patchAction({ language })} />
          <textarea
            className="spark-input"
            data-field="code"
            data-testid="step-code"
            value={action.code}
            onFocus={track}
            onChange={(e) => patchAction({ code: e.target.value })}
            placeholder={
              action.language === "python"
                ? "import os\nprint(os.environ.get('INCOMING', ''))"
                : action.language === "node"
                  ? "console.log(process.env.INCOMING ?? '')"
                  : 'echo "$INCOMING"'
            }
            rows={10}
            spellCheck={false}
            style={{ ...mono, height: "auto", minHeight: 180, padding: "8px 10px", resize: "vertical", tabSize: 2 }}
            onKeyDown={(e) => {
              // Tab indents inside a script instead of leaving the field.
              if (e.key === "Tab") {
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart;
                const end = el.selectionEnd;
                const next = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
                patchAction({ code: next });
                requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
              }
            }}
          />
          <Field label="Run with">
            <input
              className="spark-input spark-mono"
              data-field="interpreter"
              data-testid="step-interpreter"
              value={action.interpreter ?? ""}
              onFocus={track}
              onChange={(e) => patchAction({ interpreter: e.target.value || undefined })}
              placeholder={INTERPRETER_DEFAULT[action.language]}
            />
          </Field>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: -4 }}>
            {INTERPRETER_PRESETS[action.language].map((preset) => (
              <button
                key={preset}
                type="button"
                className={`spark-badge${(action.interpreter ?? "") === preset ? " is-accent" : ""}`}
                title={`Run the script with: ${preset || INTERPRETER_DEFAULT[action.language]}`}
                onClick={() => patchAction({ interpreter: preset || undefined })}
              >
                {preset || "default"}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: "var(--muted)", marginTop: -4 }}>
            The script file is appended to this command. Tools on your login-shell PATH (uv, pyenv, nvm,
            conda) and paths relative to the working directory both work.
          </span>
          <Field label="Working directory (optional)">
            <input
              className="spark-input spark-mono"
              data-field="cwd"
              value={action.cwd ?? ""}
              onFocus={track}
              onChange={(e) => patchAction({ cwd: e.target.value || undefined })}
              placeholder={cwd}
            />
          </Field>
          <EnvEditor value={action.env} onChange={(env) => patchAction({ env })} />
        </Group>
      )}

      {action.type === "http" && (
        <Group label="Request">
          <Segmented options={HTTP_METHODS} value={action.method} onChange={(method) => patchAction({ method })} wrap />
          <input
            className="spark-input spark-mono"
            data-field="url"
            data-testid="step-url"
            value={action.url}
            onFocus={track}
            onChange={(e) => patchAction({ url: e.target.value })}
            placeholder="https://hooks.slack.com/services/…"
          />
          <EnvEditor
            label="Headers"
            keyPlaceholder="Content-Type"
            valuePlaceholder="application/json"
            value={action.headers}
            onChange={(headers) => patchAction({ headers })}
          />
          {action.method !== "GET" && action.method !== "DELETE" && (
            <Field label="Body">
              <textarea
                className="spark-input"
                data-field="body"
                value={action.body ?? ""}
                onFocus={track}
                onChange={(e) => patchAction({ body: e.target.value || undefined })}
                placeholder={'{"text": "{{incoming}}"}'}
                rows={5}
                spellCheck={false}
                style={{ ...mono, height: "auto", minHeight: 96, padding: "8px 10px", resize: "vertical" }}
              />
            </Field>
          )}
        </Group>
      )}

      {action.type === "writeFile" && (
        <Group label="File">
          <Segmented
            options={[
              { value: "append" as const, label: "Append" },
              { value: "overwrite" as const, label: "Overwrite" },
            ]}
            value={action.mode}
            onChange={(mode) => patchAction({ mode })}
          />
          <Field label="Path (absolute, or relative to the workspace)">
            <input
              className="spark-input spark-mono"
              data-field="path"
              data-testid="step-path"
              value={action.path}
              onFocus={track}
              onChange={(e) => patchAction({ path: e.target.value })}
              placeholder="notes/{{date}}.md"
            />
          </Field>
          <Field label="Content">
            <textarea
              className="spark-input"
              data-field="content"
              value={action.content}
              onFocus={track}
              onChange={(e) => patchAction({ content: e.target.value })}
              rows={6}
              spellCheck={false}
              style={{ ...mono, height: "auto", minHeight: 110, padding: "8px 10px", resize: "vertical" }}
            />
          </Field>
        </Group>
      )}

      {action.type === "notify" && (
        <Group label="Notification">
          <Field label="Title (optional)">
            <input
              className="spark-input"
              data-field="title"
              value={action.title ?? ""}
              onFocus={track}
              onChange={(e) => patchAction({ title: e.target.value || undefined })}
              placeholder="{{name}} · {{date}}"
            />
          </Field>
          <Field label="Message">
            <textarea
              className="spark-input"
              data-field="message"
              data-testid="step-message"
              value={action.message}
              onFocus={track}
              onChange={(e) => patchAction({ message: e.target.value })}
              placeholder="{{incoming}}"
              rows={4}
              style={{ height: "auto", minHeight: 80, padding: "8px 10px", resize: "vertical", lineHeight: 1.5 }}
            />
          </Field>
        </Group>
      )}

      <Group label="Limits">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)" }}>
            timeout (s)
            <input
              className="spark-input spark-mono"
              type="number"
              min={1}
              value={d.timeoutSec ?? ""}
              placeholder="120"
              onChange={(e) => {
                const n = Number(e.target.value);
                onPatchNodeData(node.id, {
                  timeoutSec: e.target.value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined,
                });
              }}
              style={{ width: 80, height: 26 }}
            />
          </label>
          <Check
            label="Keep going if it fails"
            checked={Boolean(d.continueOnError)}
            onToggle={() => onPatchNodeData(node.id, { continueOnError: !d.continueOnError })}
          />
        </div>
        <span style={{ fontSize: 10.5, lineHeight: 1.5, color: "var(--muted)" }}>
          {d.continueOnError
            ? "A failure (non-zero exit, non-2xx) still settles this node; the error text becomes its output."
            : "A failure (non-zero exit, non-2xx) fails the whole pass."}
        </span>
      </Group>

      {/* Run step console */}
      <Group label="Try it">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="spark-btn is-primary"
            data-testid="step-run"
            disabled={running || Boolean(problem)}
            onClick={() => void runNow()}
            title={problem ? `Fix first: ${problem}` : "Run this node now, with the last pass's upstream outputs as samples"}
            style={{ height: 28, fontSize: 12 }}
          >
            {running ? "Running…" : "▶ Run step"}
          </button>
          {result && (
            <span
              className="spark-mono"
              data-testid="step-run-status"
              style={{ fontSize: 10.5, color: result.ok ? "var(--ok)" : "var(--danger)" }}
            >
              {runStatusLine(result)}
            </span>
          )}
        </div>
        {problem && !result && (
          <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
            {stepTitle(d)} {problem}
          </span>
        )}
        {result && (
          <StepConsole
            output={result.stdout !== undefined ? result.stdout : result.output}
            stderr={result.stderr}
            emptyText={result.ok ? "(no output)" : (result.error ?? "failed")}
          />
        )}
      </Group>

      {lastOutput !== undefined && (
        <Group label="Last pass output" hint="What this node produced the last time the automation ran.">
          <StepConsole output={lastOutput} emptyText="(no output)" />
        </Group>
      )}
    </>
  );
}

/** "ok · exit 0 · 99ms" / "failed · exit 1 · 99ms" / "failed · timed out after 2s". */
function runStatusLine(r: LoomStepResult): string {
  const parts: string[] = [r.ok ? "ok" : "failed"];
  if (r.exitCode !== undefined && r.exitCode !== null) parts.push(`exit ${r.exitCode}`);
  else if (!r.ok && r.error) parts.push(r.error);
  if (r.statusCode !== undefined) parts.push(`HTTP ${r.statusCode}`);
  if (r.timedOut && r.error && !parts.includes(r.error)) parts.push(r.error);
  parts.push(formatMs(r.durationMs));
  return parts.join(" · ");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** The console block: stdout (and, when present, stderr under its own rule). */
function StepConsole({
  output,
  stderr,
  emptyText,
}: {
  output: string;
  stderr?: string;
  emptyText: string;
}): React.ReactElement {
  const hasOut = output.trim().length > 0;
  const hasErr = Boolean(stderr && stderr.trim().length > 0);
  return (
    <div className="loom-console" data-testid="step-console">
      <pre className="loom-console__out">{hasOut ? output : emptyText}</pre>
      {hasErr && (
        <>
          <div className="loom-console__rule spark-eyebrow">stderr</div>
          <pre className="loom-console__out is-err">{stderr}</pre>
        </>
      )}
    </div>
  );
}

/** Key/value rows for env vars or HTTP headers. */
function EnvEditor({
  value,
  onChange,
  label = "Environment (optional)",
  keyPlaceholder = "API_TOKEN",
  valuePlaceholder = "value or {{node:…}}",
}: {
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
  label?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}): React.ReactElement {
  const rows = Object.entries(value ?? {});
  const commit = (next: Array<[string, string]>): void => {
    const obj: Record<string, string> = {};
    for (const [k, v] of next) if (k.trim()) obj[k.trim()] = v;
    onChange(Object.keys(obj).length > 0 ? obj : undefined);
  };
  // A draft row lets you type a key before it exists in the record.
  const [draft, setDraft] = useState<[string, string]>(["", ""]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="spark-eyebrow">{label}</span>
      {rows.map(([k, v], i) => (
        <div key={`${i}-${k}`} style={{ display: "flex", gap: 6 }}>
          <input
            className="spark-input spark-mono"
            value={k}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
            style={{ flex: "0 0 40%", height: 26 }}
          />
          <input
            className="spark-input spark-mono"
            value={v}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
            style={{ flex: 1, height: 26 }}
          />
          <button
            type="button"
            className="spark-btn"
            title="Remove"
            onClick={() => commit(rows.filter((_r, j) => j !== i))}
            style={{ height: 26, width: 26, padding: 0 }}
          >
            ×
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="spark-input spark-mono"
          value={draft[0]}
          placeholder={keyPlaceholder}
          onChange={(e) => setDraft([e.target.value, draft[1]])}
          style={{ flex: "0 0 40%", height: 26 }}
        />
        <input
          className="spark-input spark-mono"
          value={draft[1]}
          placeholder={valuePlaceholder}
          onChange={(e) => setDraft([draft[0], e.target.value])}
          onBlur={() => {
            if (draft[0].trim()) {
              commit([...rows, draft]);
              setDraft(["", ""]);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft[0].trim()) {
              e.preventDefault();
              commit([...rows, draft]);
              setDraft(["", ""]);
            }
          }}
          style={{ flex: 1, height: 26 }}
        />
        <span style={{ width: 26 }} />
      </div>
    </div>
  );
}
