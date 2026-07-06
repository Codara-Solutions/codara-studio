import React, { useCallback, useMemo, useRef } from "react";
import type {
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  AutomationTrigger,
  FolderTriggerEvent,
  GuardPredicate,
  LoomEngine,
  LoomWorkerConfig,
  ScheduledJob,
} from "@shared/types";
import { DEFAULT_ITERATION_TIMEOUT_MINUTES } from "@shared/types";
import { usePreferences } from "../../../preferences/usePreferences";
import { Check, Field, Segmented } from "../FormKit";
import {
  DEFAULT_ENGINE_MODEL,
  DEFAULT_WORKER_EFFORT,
  installedEngines,
  upstreamNodeIds,
  TRIGGER_ID,
  type FlowEdge,
  type FlowNode,
  type FlowNodeData,
  type TriggerDraft,
} from "./model";

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
  { value: "onFinishOf", label: "After loom" },
];

const FOLDER_EVENTS: FolderTriggerEvent[] = ["add", "change", "unlink"];
const BASE_VARIABLES = [
  "{{iteration}}",
  "{{lastOutput}}",
  "{{file}}",
  "{{date}}",
  "{{name}}",
  "{{incoming}}",
];

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
  runtimes: AgentRuntimeDiagnostic[];
}

// Kind → glyph + amber/accent/mixed/info tint for the header chip.
function kindGlyph(node: FlowNode): { glyph: string; eyebrow: string; color: string; tint: string } {
  const d = node.data;
  switch (d.kind) {
    case "trigger":
      return { glyph: "⚡", eyebrow: "Trigger", color: "var(--warn)", tint: "color-mix(in oklch, var(--warn) 16%, var(--panel-2))" };
    case "worker":
      return {
        glyph: d.worker.engine === "codex" ? "◆" : d.worker.engine === "claude" ? "◇" : "⟲",
        eyebrow: "Worker",
        color: "var(--accent)",
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
    kind === "trigger" ? "Trigger" : ((node.data.label as string) || meta.eyebrow);
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

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
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
  glyph: string;
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
        <Hint>Fires only when you press Run now — or when another loom chains into it.</Hint>
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
        <Hint>Starts looping the moment the loom is enabled — bound it with the Loop caps.</Hint>
      )}
      {t.kind === "onFinishOf" && (
        <Field label="Start after this loom finishes">
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
  runtimes,
}: NodeContextPanelProps & { node: FlowNode }): React.ReactElement {
  const d = node.data;
  if (d.kind !== "worker") return <></>;
  const w = d.worker;
  const setWorker = (patch: Partial<LoomWorkerConfig>): void =>
    onPatchNodeData(node.id, { worker: { ...w, ...patch } });

  const installed = installedEngines(runtimes);
  // Engine is claude|codex only — "auto" is gone. Always offer both so an
  // uninstalled engine can still be selected (a badge warns it isn't installed).
  const engineOptions: { value: LoomEngine; label: string }[] = (["claude", "codex"] as LoomEngine[]).map(
    (e) => ({ value: e, label: e === "claude" ? "Claude" : "Codex" }),
  );
  const { preferences } = usePreferences();
  const runtime = runtimes.find((r) => r.kind === w.engine);
  // Fable 5 gate (default off): hide it from the loom worker model dropdown
  // unless opted in via Settings, matching the chat composer picker. With the
  // pref off, launchWorkerAttempt downgrades any lingering fable hint to Opus.
  const models = (runtime?.models ?? []).filter(
    (m) => preferences.fableEnabled === true || !/fable/i.test(m.id),
  );
  const selectedModel = models.find((m) => m.id === w.model);
  const effortLevels: AgentEffortLevel[] = selectedModel?.effortLevels ?? ["low", "medium", "high", "xhigh"];

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

      <Group label="Engine — who runs this node">
        <Segmented
          options={engineOptions}
          // Node data is concretized on load, so engine is always claude|codex
          // here; the cast just drops the vestigial "auto" from the stored type.
          value={w.engine as LoomEngine}
          onChange={(v) =>
            setWorker({ engine: v, model: DEFAULT_ENGINE_MODEL[v], effort: w.effort ?? DEFAULT_WORKER_EFFORT })
          }
        />
        {installed.size === 0 ? (
          <span className="spark-badge is-danger" style={{ alignSelf: "flex-start" }}>
            Install Claude Code or Codex to run looms
          </span>
        ) : !installed.has(w.engine as LoomEngine) ? (
          // The engine picked for THIS node isn't on this machine — the loom
          // would die with engine-missing at run time. Warn here, at selection.
          <span className="spark-badge is-danger" style={{ alignSelf: "flex-start" }}>
            {w.engine === "claude" ? "Claude Code" : "Codex"} isn't installed — this node can't run
          </span>
        ) : null}
        {/* Model + effort are required — every worker carries a concrete value,
            never blank ("CLI default"/"default" no longer exist). A stored
            value the current catalog doesn't offer (fable with the pref off,
            an effort the model lacks) renders as an explicit "(unavailable)"
            option instead of silently displaying the wrong selection. */}
        <div style={{ display: "flex", gap: 10 }}>
          <Field label="Model" grow>
            <select className="spark-select" value={w.model ?? ""} onChange={(e) => setWorker({ model: e.target.value })}>
              {w.model && !models.some((m) => m.id === w.model) && (
                <option value={w.model}>{w.model} (unavailable)</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort" grow>
            <select className="spark-select" value={w.effort ?? ""} onChange={(e) => setWorker({ effort: e.target.value as AgentEffortLevel })}>
              {w.effort && !effortLevels.includes(w.effort) && (
                <option value={w.effort}>{w.effort} (unavailable)</option>
              )}
              {effortLevels.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl}
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
            <button key={v} type="button" className="spark-badge is-accent" style={{ cursor: "default" }} onClick={() => insertVariable(v)}>
              {v}
            </button>
          ))}
          {upstream.map((nid) => (
            <button
              key={nid}
              type="button"
              className="spark-badge"
              style={{ cursor: "default" }}
              title={`Reference output of upstream node ${nid}`}
              onClick={() => insertVariable(`{{node:${nid}}}`)}
            >
              {`{{node:${nid}}}`}
            </button>
          ))}
        </div>
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
      <Group label="Condition — routes to pass or fail">
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
          placeholder="./check.sh — exit 0 = pass"
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
