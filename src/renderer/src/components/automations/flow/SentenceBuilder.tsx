import React, { useEffect, useMemo, useState } from "react";
import type { CreateScheduledJobInput, ScheduledJob } from "@shared/types";
import { costForecast } from "../cost-forecast";
import { fmtWhen } from "../inbox-model";
import { WORKER_MODELS } from "../worker-models";
import { PRESETS, type LoomPreset } from "./presets";
import {
  emptySentence,
  nextStarts,
  sentenceBudget,
  sentenceProblem,
  sentenceToInput,
  sentenceToSeed,
  sentenceTrigger,
  type SentenceDraft,
  type StopKind,
  type ThenKind,
  type WhenKind,
} from "./sentence-model";

// New automation, written as a sentence: When, Do, Stop, Then, with what it will
// do and cost beside it. The flow editor stays for branches, steps and other
// triggers, and a sentence can be carried on there.

const WHEN_OPTIONS: Array<{ value: WhenKind; label: string }> = [
  { value: "manual", label: "only when you run it" },
  { value: "daily", label: "every day at" },
  { value: "weekdays", label: "every weekday at" },
  { value: "every", label: "every so many minutes" },
  { value: "prOpened", label: "when a pull request opens" },
  { value: "ciFailed", label: "when CI fails on a pull request" },
];

const STOP_OPTIONS: Array<{ value: StopKind; label: string }> = [
  { value: "once", label: "after one run" },
  { value: "tests", label: "when the tests pass" },
  { value: "agent", label: "when it says it is done" },
];

const THEN_OPTIONS: Array<{ value: ThenKind; label: string }> = [
  { value: "folder", label: "leave its changes in this folder" },
  { value: "branch", label: "keep its changes on their own branch" },
  { value: "draftPr", label: "open a draft pull request" },
];

export default function SentenceBuilder({
  workspaceId,
  workspaceName,
  cwd,
  onCreate,
  onCancel,
  onOpenFlow,
}: {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  onCreate: (input: CreateScheduledJobInput) => void;
  onCancel: () => void;
  onOpenFlow: (from: { seed?: ScheduledJob; preset?: LoomPreset; name?: string }) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<SentenceDraft>(emptySentence);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const set = (patch: Partial<SentenceDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const ctx = { workspaceId, workspaceName, cwd };
  const problem = sentenceProblem(draft);
  const trigger = useMemo(() => sentenceTrigger(draft), [draft]);
  const nowMs = useMemo(() => Date.now(), [trigger]);
  const starts = useMemo(() => nextStarts(trigger, nowMs, 3), [trigger, nowMs]);
  const forecast = useMemo(
    () =>
      costForecast(
        {
          trigger,
          stepsOnly: false,
          budgetUsd: sentenceBudget(draft),
          monthlyCapUsd: draft.monthlyCap.trim() && Number(draft.monthlyCap) > 0 ? Number(draft.monthlyCap) : undefined,
        },
        nowMs,
      ),
    [trigger, draft, nowMs],
  );
  const dirty = Boolean(draft.name.trim() || draft.prompt.trim());
  const usesTime = draft.when === "daily" || draft.when === "weekdays";

  const submit = (): void => {
    if (problem) return;
    const input = sentenceToInput(draft, ctx);
    if (input) onCreate(input);
  };
  const cancel = (): void => {
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onCancel();
  };
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = window.setTimeout(() => setConfirmDiscard(false), 2500);
    return () => window.clearTimeout(t);
  }, [confirmDiscard]);

  return (
    <div
      className="automation-builder"
      data-testid="automation-builder"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
      }}
    >
      <div className="automation-builder__main">
        <div className="automation-builder__eyebrow">New automation</div>
        <input
          className="spark-input automation-builder__name"
          aria-label="Name"
          placeholder="What is this automation for?"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />

        <section className="automation-builder__part">
          <h3>When</h3>
          <div className="automation-builder__line">
            <span>Start</span>
            <Choice label="When it starts" value={draft.when} options={WHEN_OPTIONS} onChange={(when) => set({ when })} />
            {usesTime && <Typed label="Time" value={draft.time} width={64} onChange={(time) => set({ time })} />}
            {draft.when === "every" && (
              <>
                <Typed label="Minutes between runs" value={draft.everyMin} width={56} onChange={(everyMin) => set({ everyMin })} />
                <span>minutes</span>
              </>
            )}
          </div>
          {draft.when !== "manual" && (
            <div className="automation-builder__line">
              <span>but only if this command passes</span>
              <Typed label="Only if" mono value={draft.onlyIf} placeholder="optional" grow onChange={(onlyIf) => set({ onlyIf })} />
            </div>
          )}
        </section>

        <section className="automation-builder__part">
          <h3>Do</h3>
          <div className="automation-builder__line">
            <Choice
              label="Who works on it"
              value={draft.model}
              options={WORKER_MODELS.map((m) => ({ value: m.id, label: m.label }))}
              onChange={(model) => set({ model })}
            />
            <span>
              works in <b>{workspaceName}</b> on this:
            </span>
          </div>
          <textarea
            className="spark-input automation-builder__prompt"
            aria-label="What it should do"
            rows={4}
            placeholder="Say what it should do, as you would to a colleague."
            value={draft.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        </section>

        <section className="automation-builder__part">
          <h3>Stop</h3>
          <div className="automation-builder__line">
            <span>Stop</span>
            <Choice label="When it stops" value={draft.stop} options={STOP_OPTIONS} onChange={(stop) => set({ stop })} />
            {draft.stop === "tests" && <Typed label="Test command" mono value={draft.testCommand} width={120} onChange={(testCommand) => set({ testCommand })} />}
            {draft.stop !== "once" && (
              <>
                <span>or after</span>
                <Typed label="Tries" value={draft.maxTries} width={48} onChange={(maxTries) => set({ maxTries })} />
                <span>tries</span>
              </>
            )}
            <span>or at $</span>
            <Typed label="Budget" value={draft.budget} width={56} placeholder="none" onChange={(budget) => set({ budget })} />
          </div>
          <div className="automation-builder__line">
            <span>No new run past $</span>
            <Typed label="Monthly cap" value={draft.monthlyCap} width={56} placeholder="none" onChange={(monthlyCap) => set({ monthlyCap })} />
            <span>a month, and pause after</span>
            <Typed label="Pause after" value={draft.pauseAfter} width={48} placeholder="none" onChange={(pauseAfter) => set({ pauseAfter })} />
            <span>failed runs in a row.</span>
          </div>
        </section>

        <section className="automation-builder__part">
          <h3>Then</h3>
          <div className="automation-builder__line">
            <span>Then</span>
            <Choice label="What happens to its work" value={draft.then} options={THEN_OPTIONS} onChange={(then) => set({ then })} />
          </div>
        </section>

        <div className="automation-builder__foot">
          <button type="button" className="spark-btn is-primary" disabled={Boolean(problem)} onClick={submit} title="Cmd/Ctrl+Enter">
            Create automation
          </button>
          <button type="button" className="spark-btn" onClick={cancel}>
            {confirmDiscard ? "Discard changes?" : "Cancel"}
          </button>
          {problem && <span className="automation-builder__problem">{problem}</span>}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="spark-btn"
            title="For branches, steps and other triggers"
            onClick={() => onOpenFlow({ seed: sentenceToSeed(draft, ctx) })}
          >
            Open in flow editor
          </button>
        </div>

        <div className="automation-builder__presets">
          <span className="automation-builder__presets-title">Start from a proven workflow</span>
          <div className="automation-builder__preset-list">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="spark-btn"
                title={preset.blurb}
                aria-label={`${preset.title}. ${preset.blurb}`}
                onClick={() => onOpenFlow({ preset, name: draft.name })}
              >
                {preset.title}
              </button>
            ))}
          </div>
        </div>
      </div>

      <aside className="automation-builder__preview" data-testid="automation-builder-preview">
        <div className="automation-builder__eyebrow">What will happen</div>
        <h4>Next runs</h4>
        {starts.length > 0 ? (
          <div className="spark-mono automation-builder__times">
            {starts.map((at) => (
              <div key={at}>{fmtWhen(at, nowMs)}</div>
            ))}
          </div>
        ) : (
          <p>{draft.when === "manual" ? "Only when you run it." : trigger ? "Whenever that happens, while Codara is open." : "Finish the schedule to see them."}</p>
        )}
        <h4>Cost</h4>
        <p className={forecast.open ? "is-open" : undefined}>
          <b>{forecast.headline}</b>
        </p>
        {forecast.detail && <p>{forecast.detail}</p>}
        <h4>It can</h4>
        <p>
          Edit files and run commands in {draft.then === "folder" ? <b>{workspaceName}</b> : <>a separate copy of <b>{workspaceName}</b></>}.
          {draft.then === "draftPr" ? " When a run goes well it pushes a new branch and opens a draft pull request." : ""}
        </p>
      </aside>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): React.ReactElement {
  return (
    <select className="spark-select automation-builder__choice" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Typed({
  label,
  value,
  onChange,
  width,
  grow,
  mono,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  width?: number;
  grow?: boolean;
  mono?: boolean;
  placeholder?: string;
}): React.ReactElement {
  return (
    <input
      className={`spark-input automation-builder__typed${mono ? " spark-mono" : ""}`}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      style={grow ? { flex: 1, minWidth: 120 } : { width }}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
