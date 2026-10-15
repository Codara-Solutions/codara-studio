import React, { useEffect, useRef, useState } from "react";
import type { AutomationLoopKind, AutomationPrecheckResult, AutomationTrigger } from "@shared/types";
import {
  MAX_PRECHECK_TIMEOUT_SECONDS,
  MISSED_GRACE_CHOICES,
  formatGraceMinutes,
  precheckVerdict,
  triggerHasSchedule,
  triggerUsesPrecheck,
} from "@shared/automation-catchup";
import { Field, Segmented } from "../FormKit";
import { buildPrecheck, type GateDraft } from "./gate-model";

// The trigger panel's two gates: a precheck command that can skip a pass
// before any agent starts, and what to do about a scheduled time Codara
// missed. Rendered under the trigger's own fields.

const IS_WINDOWS = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");

const MISSED_OPTIONS: { value: GateDraft["missedPolicy"]; label: string }[] = [
  { value: "skip", label: "Skip it" },
  { value: "runOnce", label: "Run once when back" },
];

export default function TriggerGateFields({
  gate,
  onChange,
  trigger,
  loopKind,
  cwd,
}: {
  gate: GateDraft;
  onChange: (next: GateDraft) => void;
  /** The trigger as it would be saved (null while it is incomplete). */
  trigger: AutomationTrigger | null;
  /** A cadence loop's later passes are checked too, whatever the trigger. */
  loopKind?: AutomationLoopKind;
  cwd: string;
}): React.ReactElement | null {
  const set = (patch: Partial<GateDraft>): void => onChange({ ...gate, ...patch });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AutomationPrecheckResult | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // A result describes the command it ran; editing the command clears it.
  useEffect(() => setResult(null), [gate.precheckCommand, gate.precheckShell]);

  const showPrecheck = trigger ? triggerUsesPrecheck(trigger, loopKind) : false;
  const startsOnItsOwn = trigger ? triggerUsesPrecheck(trigger) : false;
  const checkedPasses =
    loopKind !== "cadence"
      ? "this trigger starts"
      : startsOnItsOwn
        ? "this trigger or the cadence loop starts"
        : "the cadence loop starts";
  const showMissed = trigger ? triggerHasSchedule(trigger) : false;
  if (!showPrecheck && !showMissed) return null;

  const showShell = IS_WINDOWS || gate.precheckShell === "powershell";
  const precheck = buildPrecheck(gate);
  const graceChoices = MISSED_GRACE_CHOICES.includes(gate.missedGraceMin)
    ? MISSED_GRACE_CHOICES
    : [...MISSED_GRACE_CHOICES, gate.missedGraceMin].sort((a, b) => a - b);

  const runTest = async (): Promise<void> => {
    if (!precheck || testing) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await window.spark.scheduler.testPrecheck({ cwd, precheck });
      if (mounted.current) setResult(r);
    } catch (err) {
      if (mounted.current) {
        setResult({
          passed: false,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (mounted.current) setTesting(false);
    }
  };

  return (
    <>
      {showPrecheck && (
        <section style={sectionStyle} data-testid="precheck-section">
          <span className="spark-eyebrow">Before each run</span>
          <span style={hintStyle}>
            {`Optional. A shell command that runs in the workspace folder before each pass ${checkedPasses}. `}
            Exit code 0 runs the pass. Anything else skips it: no agent starts and no tokens are spent.
            Run now always runs.
          </span>
          <Field label="Check first command">
            <textarea
              className="spark-input spark-mono"
              data-testid="precheck-command"
              rows={2}
              value={gate.precheckCommand}
              onChange={(e) => set({ precheckCommand: e.target.value })}
              placeholder={
                gate.precheckShell === "powershell"
                  ? "if (Test-Path TODO.md) { exit 0 } else { exit 1 }"
                  : IS_WINDOWS
                    ? "if exist TODO.md (exit 0) else (exit 1)"
                    : 'test -n "$(git status --porcelain)"'
              }
              spellCheck={false}
              style={{ resize: "vertical", minHeight: 44, fontSize: 11.5, lineHeight: 1.45 }}
            />
          </Field>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label="Timeout (seconds)">
              <input
                className="spark-input spark-mono"
                data-testid="precheck-timeout"
                type="number"
                min={1}
                max={MAX_PRECHECK_TIMEOUT_SECONDS}
                value={gate.precheckTimeoutSec}
                onChange={(e) => set({ precheckTimeoutSec: e.target.value })}
                style={{ width: 90 }}
              />
            </Field>
            {showShell && (
              <Field label="Shell">
                <select
                  className="spark-select"
                  data-testid="precheck-shell"
                  value={gate.precheckShell}
                  onChange={(e) => set({ precheckShell: e.target.value === "powershell" ? "powershell" : "default" })}
                >
                  <option value="default">{IS_WINDOWS ? "Command Prompt" : "Login shell"}</option>
                  <option value="powershell">PowerShell</option>
                </select>
              </Field>
            )}
            <button
              type="button"
              className="spark-btn"
              data-testid="precheck-test"
              style={{ height: 28, fontSize: 11.5 }}
              disabled={!precheck || testing}
              onClick={() => void runTest()}
              title="Run the command once now, in the workspace folder"
            >
              {testing ? "Checking…" : "Test check"}
            </button>
          </div>
          <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {result && (
              <span
                data-testid="precheck-result"
                style={{ fontSize: 11, color: result.passed ? "var(--ok)" : "var(--warn, var(--danger))" }}
              >
                {precheckVerdict(result)}
              </span>
            )}
            {result?.outputTail ? (
              <pre data-testid="precheck-output" className="spark-mono" style={outputStyle}>
                {result.outputTail}
              </pre>
            ) : null}
          </div>
        </section>
      )}
      {showMissed && (
        <section style={sectionStyle} data-testid="missed-section">
          <span className="spark-eyebrow">If a run was missed</span>
          <span style={hintStyle}>
            A run is missed when Codara is closed or the computer is asleep at the scheduled time.
            Codara checks when it starts and when the computer wakes up, and never runs more than once
            to catch up. Skipped times are listed in the history.
          </span>
          <Segmented options={MISSED_OPTIONS} value={gate.missedPolicy} onChange={(v) => set({ missedPolicy: v })} />
          {gate.missedPolicy === "runOnce" && (
            <Field label="Only if it was missed less than">
              <select
                className="spark-select"
                data-testid="missed-grace"
                value={String(gate.missedGraceMin)}
                onChange={(e) => set({ missedGraceMin: Number(e.target.value) })}
                style={{ maxWidth: 160 }}
              >
                {graceChoices.map((m) => (
                  <option key={m} value={String(m)}>
                    {formatGraceMinutes(m)} ago
                  </option>
                ))}
              </select>
            </Field>
          )}
        </section>
      )}
    </>
  );
}

const sectionStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const hintStyle: React.CSSProperties = {
  fontSize: 10.5,
  lineHeight: 1.5,
  color: "var(--muted)",
  marginTop: -2,
};

const outputStyle: React.CSSProperties = {
  margin: 0,
  maxHeight: 120,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: 10.5,
  lineHeight: 1.45,
  color: "var(--ink-dim)",
  background: "var(--panel-2)",
  borderRadius: "var(--radius-control)",
  padding: "6px 8px",
};
