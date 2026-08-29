import React from "react";
import type { AutomationLoopKind } from "@shared/types";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "@shared/types";
import { Check, Segmented } from "../FormKit";
import type { LoopDraft } from "./model";

// The "Loop & stops" side inspector — REDESIGN of the old cramped loop form.
// The loop lives OFF the canvas (it governs whole-graph repetition), so it
// gets its own clean, well-spaced panel: a captioned segmented control for the
// repeat kind, grouped Safety caps with helper text, stop-condition rows, and
// the isolate toggle.

const LOOP_KINDS: { value: AutomationLoopKind; label: string; blurb: string }[] = [
  { value: "once", label: "Once", blurb: "Run the graph a single time." },
  { value: "count", label: "N times", blurb: "Repeat a fixed number of times." },
  { value: "cadence", label: "Cadence", blurb: "Repeat on a timed interval." },
  { value: "until", label: "Until", blurb: "Repeat until a stop condition is met." },
  { value: "continuous", label: "Continuous", blurb: "Repeat back-to-back until a cap." },
  { value: "agent", label: "Agent", blurb: "The model decides whether to continue." },
];

export default function LoopInspector({
  loop,
  onChange,
  onClose,
}: {
  loop: LoopDraft;
  onChange: (next: LoopDraft) => void;
  onClose: () => void;
}): React.ReactElement {
  const set = (patch: Partial<LoopDraft>): void => onChange({ ...loop, ...patch });
  const kindMeta = LOOP_KINDS.find((k) => k.value === loop.kind);
  const showStops =
    loop.kind === "until" ||
    loop.kind === "agent" ||
    loop.kind === "continuous" ||
    loop.kind === "cadence";

  return (
    <div
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
      <Head title="Loop & stops" subtitle="How the whole graph repeats" onClose={onClose} />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Repeat kind */}
        <Group label="Repeat" hint={kindMeta?.blurb}>
          <Segmented
            options={LOOP_KINDS.map((k) => ({ value: k.value, label: k.label }))}
            value={loop.kind}
            onChange={(v) => set({ kind: v })}
            wrap
          />
          {loop.kind === "count" && (
            <NumberRow
              label="Number of iterations"
              value={loop.countN}
              min={1}
              onChange={(v) => set({ countN: v })}
            />
          )}
          {loop.kind === "cadence" && (
            <NumberRow
              label="Every (minutes)"
              value={loop.cadenceMin}
              min={1}
              onChange={(v) => set({ cadenceMin: v })}
            />
          )}
        </Group>

        {/* Safety caps */}
        <Group
          label="Safety caps"
          hint="Always enforced: even agent/continuous loops stop here. Leave blank to use the default."
        >
          <div style={{ display: "flex", gap: 12 }}>
            <CapBox
              label="Max iterations"
              suffix=""
              value={loop.maxIters}
              placeholder={String(DEFAULT_AGENT_MAX_ITERATIONS)}
              onChange={(v) => set({ maxIters: v })}
              hint="hard stop"
            />
            <CapBox
              label="Budget cap"
              suffix="$"
              value={loop.budget}
              placeholder="—"
              step={0.5}
              onChange={(v) => set({ budget: v })}
              hint="AI spend hard stop · blank or 0 = no cap"
            />
          </div>
        </Group>

        {/* Stop conditions */}
        {showStops && (
          <Group label="Stop when" hint="The first satisfied condition ends the loop (any of these).">
            <StopRow
              checked={loop.untilTests}
              onToggle={() => set({ untilTests: !loop.untilTests })}
              label="Tests pass"
            >
              {loop.untilTests && (
                <input
                  className="spark-input spark-mono"
                  value={loop.testCommand}
                  onChange={(e) => set({ testCommand: e.target.value })}
                  placeholder="npm test"
                  style={{ height: 28, marginTop: 6 }}
                />
              )}
            </StopRow>
            <StopRow
              checked={loop.untilGit}
              onToggle={() => set({ untilGit: !loop.untilGit })}
              label="Working tree is clean (git)"
            />
            <LabeledInput
              label="Summary contains phrase"
              value={loop.untilPhrase}
              placeholder="e.g. DONE"
              onChange={(v) => set({ untilPhrase: v })}
            />
            <LabeledInput
              label="Shell command exits 0"
              mono
              value={loop.untilCommand}
              placeholder="e.g. ./check.sh"
              onChange={(v) => set({ untilCommand: v })}
            />
          </Group>
        )}

        {loop.kind === "agent" && (
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.55, color: "var(--muted)" }}>
            The worker decides whether to continue each pass, via the{" "}
            <span className="spark-mono">codara_request_next_iteration</span> tool, or by ending its
            summary with <span className="spark-mono">SPARK_LOOP_CONTINUE</span> /{" "}
            <span className="spark-mono">SPARK_LOOP_DONE</span>. Your caps above always stop it.
          </p>
        )}

        {/* Isolation */}
        <Group label="Run lineage">
          <Check
            label="Fresh run each iteration (isolate)"
            checked={loop.isolate}
            onToggle={() => set({ isolate: !loop.isolate })}
          />
          <p style={{ margin: "4px 0 0 22px", fontSize: 10.5, lineHeight: 1.5, color: "var(--muted-2)" }}>
            {loop.isolate
              ? "Each pass starts a clean run with no carried transcript."
              : "Iterations share one run's transcript (carry context)."}
          </p>
        </Group>
      </div>
    </div>
  );
}

// ── layout atoms ─────────────────────────────────────────────────────────────

function Head({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
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
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 7, background: "color-mix(in oklch, var(--accent) 14%, var(--panel-2))", color: "var(--accent-text)", fontSize: 14 }}>
        ↻
      </span>
      <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{title}</span>
        <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{subtitle}</span>
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
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="spark-eyebrow">{label}</span>
      {hint && <span style={{ fontSize: 10.5, lineHeight: 1.5, color: "var(--muted)", marginTop: -2 }}>{hint}</span>}
      {children}
    </section>
  );
}

function NumberRow({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 4 }}>
      <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>{label}</span>
      <input
        className="spark-input spark-mono"
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 90, height: 28 }}
      />
    </label>
  );
}

function CapBox({
  label,
  suffix,
  value,
  placeholder,
  step,
  onChange,
  hint,
}: {
  label: string;
  suffix: string;
  value: string;
  placeholder: string;
  step?: number;
  onChange: (v: string) => void;
  hint: string;
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "9px 10px",
        borderRadius: "var(--radius-surface)",
        border: "1px solid var(--rule-soft)",
        background: "var(--panel-2)",
      }}
    >
      <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--ink-dim)" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {suffix && <span className="spark-mono" style={{ fontSize: 12, color: "var(--muted)" }}>{suffix}</span>}
        <input
          className="spark-input spark-mono"
          type="number"
          min={0}
          step={step}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, height: 26, minWidth: 0 }}
        />
      </div>
      <span style={{ fontSize: 9.5, color: "var(--muted-2)" }}>{hint}</span>
    </div>
  );
}

function StopRow({
  checked,
  onToggle,
  label,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: "var(--radius-surface)",
        border: `1px solid ${checked ? "var(--accent-edge)" : "var(--rule-soft)"}`,
        background: checked ? "color-mix(in oklch, var(--accent) 7%, var(--panel-2))" : "var(--panel-2)",
        transition: "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
      }}
    >
      <Check label={label} checked={checked} onToggle={onToggle} />
      {children}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  mono,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  mono?: boolean;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, color: "var(--ink-dim)" }}>{label}</span>
      <input
        className={`spark-input${mono ? " spark-mono" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ height: 28 }}
      />
    </label>
  );
}
