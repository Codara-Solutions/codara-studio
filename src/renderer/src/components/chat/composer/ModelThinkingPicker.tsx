import { useEffect, useRef, useState } from "react";
import type { AgentEffortLevel, ChatBackendKind, PiCatalogModel } from "@shared/types";
import {
  EFFORT_LABELS,
  buildVisibleGroups,
  composeModelId,
  effortsFor,
  findOptionInCatalog,
  type ChatBackendGroup,
  type ChatModelOption,
} from "./types";
import AnchoredMenu from "./AnchoredMenu";

interface Props {
  activeBackend: ChatBackendKind;
  activeModelId: string;
  effort: AgentEffortLevel;
  availableEfforts: AgentEffortLevel[];
  onPickModel: (model: ChatModelOption) => void;
  onPickEffort: (effort: AgentEffortLevel) => void;
  openModelSignal?: number;
  openEffortSignal?: number;
}

interface EffortStep {
  model: ChatModelOption;
  efforts: AgentEffortLevel[];
}

const EFFORT_DESCRIPTIONS: Partial<Record<AgentEffortLevel, string>> = {
  minimal: "Quickest",
  low: "Fast",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Deep",
  max: "Maximum",
};

// Grok Build's /model flow is the useful idea here: one small picker, in two
// steps. Choose a model first; if it supports reasoning levels, the same panel
// advances to effort. That keeps the composer to one button without cramming
// two unrelated lists into one oversized settings sheet.
export default function ModelThinkingPicker({
  activeBackend,
  activeModelId,
  effort,
  availableEfforts,
  onPickModel,
  onPickEffort,
  openModelSignal = 0,
  openEffortSignal = 0,
}: Props) {
  const [open, setOpen] = useState(false);
  const [effortStep, setEffortStep] = useState<EffortStep | null>(null);
  const [piCatalog, setPiCatalog] = useState<PiCatalogModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groups: ChatBackendGroup[] = buildVisibleGroups({ piCatalog, openRouterModels });
  const activeCompoundId = composeModelId(activeModelId, false);
  const activeOption = groups
    .filter((group) => group.backend === activeBackend)
    .flatMap((group) => group.models)
    .find((model) => model.id === activeCompoundId);

  useEffect(() => {
    void window.spark.piSubscriptions.catalog().then((models) => setPiCatalog(models ?? []));
    void window.spark.openRouter.coraModels().then((models) => setOpenRouterModels(models ?? []));
  }, []);
  useEffect(() => {
    if (!open) return;
    void window.spark.piSubscriptions.catalog().then((models) => setPiCatalog(models ?? []));
    void window.spark.openRouter.coraModels().then((models) => setOpenRouterModels(models ?? []));
  }, [open]);
  useEffect(() => {
    if (!openModelSignal) return;
    setEffortStep(null);
    setOpen(true);
  }, [openModelSignal]);
  useEffect(() => {
    if (!openEffortSignal) return;
    const efforts = activeOption ? effortsFor(activeOption) : [];
    setEffortStep(activeOption && efforts.length > 0 ? { model: activeOption, efforts } : null);
    setOpen(true);
    // The signal is the event. Catalog refreshes while open must not reset the
    // user's current step or focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openEffortSignal]);

  const activeLabel =
    findOptionInCatalog(activeBackend, activeModelId, false)?.label ??
    labelFor(groups, activeBackend, activeCompoundId, activeModelId);
  const effortLabel = EFFORT_LABELS[effort] ?? effort;

  const close = () => {
    setOpen(false);
    setEffortStep(null);
  };

  const chooseModel = (model: ChatModelOption) => {
    const nextEfforts = effortsFor(model);
    if (nextEfforts.length === 0) {
      onPickModel(model);
      close();
      return;
    }
    setEffortStep({ model, efforts: nextEfforts });
  };

  return (
    <div className="composer-model">
      <button
        type="button"
        ref={triggerRef}
        className={`composer-pill composer-model-thinking-trigger${open ? " is-active" : ""}`}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        title={`${activeLabel} · ${effortLabel} reasoning`}
        aria-label={`Model and thinking: ${activeLabel}, ${effortLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SparkGlyph />
        <span className="composer-pill-label">{activeLabel}</span>
        {availableEfforts.length > 0 ? (
          <>
            <span className="composer-model-thinking-dot" aria-hidden>·</span>
            <span className="composer-thinking-label">{effortLabel}</span>
          </>
        ) : null}
        <span aria-hidden className="composer-chevron">⌄</span>
      </button>

      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        className="composer-model-thinking-menu spark-menu"
        role="dialog"
        ariaLabel="Model and thinking"
        focusSignal={effortStep?.model.id ?? "models"}
      >
        {effortStep ? (
          <EffortPicker
            step={effortStep}
            effort={effort}
            onBack={() => setEffortStep(null)}
            onPick={(next) => {
              onPickModel(effortStep.model);
              onPickEffort(next);
              close();
            }}
          />
        ) : (
          <ModelPicker
            groups={groups}
            activeBackend={activeBackend}
            activeCompoundId={activeCompoundId}
            onPick={chooseModel}
          />
        )}
      </AnchoredMenu>
    </div>
  );
}

function ModelPicker({
  groups,
  activeBackend,
  activeCompoundId,
  onPick,
}: {
  groups: ChatBackendGroup[];
  activeBackend: ChatBackendKind;
  activeCompoundId: string;
  onPick: (model: ChatModelOption) => void;
}) {
  const hasModels = groups.some((group) => group.models.length > 0);
  return (
    <>
      <div className="composer-picker-title">Choose model</div>
      <div className="composer-model-thinking-list" role="listbox" aria-label="Model">
        {!hasModels ? (
          <div className="composer-model-empty">
            No models available. Connect a subscription or OpenRouter in Settings.
          </div>
        ) : null}
        {groups.map((group) => (
          <div key={group.key} className="composer-model-group">
            <div className="composer-model-group-label">{group.label}</div>
            {group.models.map((model) => {
              const active = model.id === activeCompoundId && model.backend === activeBackend;
              return (
                <button
                  key={`${model.backend}:${model.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`composer-picker-row${active ? " is-active" : ""}`}
                  onClick={() => onPick(model)}
                >
                  <span>{model.label}</span>
                  <span className="composer-picker-row-tail" aria-hidden>{active ? "Current" : "›"}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

function EffortPicker({
  step,
  effort,
  onBack,
  onPick,
}: {
  step: EffortStep;
  effort: AgentEffortLevel;
  onBack: () => void;
  onPick: (effort: AgentEffortLevel) => void;
}) {
  return (
    <>
      <button type="button" className="composer-picker-back" onClick={onBack}>
        <span aria-hidden>‹</span>
        <span>{step.model.label}</span>
      </button>
      <div className="composer-picker-title is-substep">Choose thinking depth</div>
      <div className="composer-effort-list" role="listbox" aria-label="Thinking depth">
        {step.efforts.map((option) => {
          const active = option === effort;
          return (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={active}
              className={`composer-picker-row${active ? " is-active" : ""}`}
              onClick={() => onPick(option)}
            >
              <span>{EFFORT_LABELS[option] ?? option}</span>
              <span className="composer-picker-row-tail">
                {active ? "Current" : EFFORT_DESCRIPTIONS[option]}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function SparkGlyph() {
  return (
    <span aria-hidden className="composer-model-spark">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function labelFor(
  groups: ChatBackendGroup[],
  backend: ChatBackendKind,
  compoundId: string,
  rawModelId: string,
): string {
  for (const group of groups) {
    if (group.backend !== backend) continue;
    const hit = group.models.find((model) => model.id === compoundId);
    if (hit) return hit.label;
  }
  return rawModelId || "Pick a model";
}
