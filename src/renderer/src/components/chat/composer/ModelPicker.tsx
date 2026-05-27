import { useEffect, useRef, useState } from "react";
import type { AgentRuntimeDiagnostic, ChatBackendKind } from "@shared/types";
import {
  buildVisibleGroups,
  composeModelId,
  type ChatBackendGroup,
  type ChatModelOption,
} from "./types";

interface Props {
  activeBackend: ChatBackendKind;
  activeModelId: string;
  activeOneMillion: boolean;
  onPick: (model: ChatModelOption) => void;
}

// The model pill + grouped dropdown menu. Reads agents.runtimes() and
// settings.openRouterModel to decide what to show: only enabled CLI
// runtimes appear, and the "API" group surfaces just the single model
// configured in settings (matching vienna's behavior). 1M-context variants
// ride as separate dropdown rows with a "1M" badge; selecting one fires
// onPick with isOneMillion:true so the composer can flip chat1mContext.
export default function ModelPicker({
  activeBackend,
  activeModelId,
  activeOneMillion,
  onPick,
}: Props) {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AgentRuntimeDiagnostic[]>([]);
  const [openRouterModel, setOpenRouterModel] = useState<string>("");
  const rootRef = useRef<HTMLDivElement>(null);

  // One-shot load of runtimes + the configured OpenRouter model. Settings
  // can change while the user is in the bar (they hit Settings, change the
  // OR model, come back), so we refresh on every open.
  useEffect(() => {
    void window.spark.agents.runtimes().then((rs) => setDiagnostics(rs ?? []));
    void window.spark.settings
      .load()
      .then((s) => setOpenRouterModel((s.openRouterModel ?? "").trim()));
  }, []);
  useEffect(() => {
    if (!open) return;
    void window.spark.agents.runtimes().then((rs) => setDiagnostics(rs ?? []));
    void window.spark.settings
      .load()
      .then((s) => setOpenRouterModel((s.openRouterModel ?? "").trim()));
  }, [open]);

  // Click-outside / Escape to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups: ChatBackendGroup[] = buildVisibleGroups({ diagnostics, openRouterModel });
  const activeCompoundId = composeModelId(activeModelId, activeOneMillion);
  const activeLabel = labelFor(groups, activeBackend, activeCompoundId, activeModelId);

  const select = (model: ChatModelOption) => {
    onPick(model);
    setOpen(false);
  };

  return (
    <div className="composer-model" ref={rootRef}>
      <button
        type="button"
        className="composer-pill"
        onClick={() => setOpen((value) => !value)}
        title="Chat model"
      >
        <span aria-hidden style={{ marginRight: 4 }}>☀</span>
        {activeLabel}
      </button>
      {open && (
        <div className="composer-model-menu" role="listbox">
          {groups.length === 0 && (
            <div className="composer-model-empty">
              No models available — install Claude/Codex CLI or set an OpenRouter model in Settings.
            </div>
          )}
          {groups.map((group) => (
            <div key={group.backend} className="composer-model-group">
              <div className="composer-model-group-label">{group.label}</div>
              {group.models.map((model) => {
                const active =
                  model.id === activeCompoundId && model.backend === activeBackend;
                return (
                  <button
                    key={`${model.backend}:${model.id}`}
                    type="button"
                    className={`composer-model-row${active ? " is-active" : ""}`}
                    onClick={() => select(model)}
                  >
                    <span className="composer-model-row-label">{model.label}</span>
                    {model.isOneMillion && (
                      <span className="composer-badge is-onem">1M</span>
                    )}
                    {group.backend === "openrouter" && (
                      <span className="composer-badge">API</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
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
    const hit = group.models.find((m) => m.id === compoundId);
    if (hit) return hit.label;
  }
  // No match in the current visible groups — show the raw id so the pill is
  // still informative (typical when the configured OpenRouter model was
  // changed since the run was created).
  return rawModelId || "Pick a model";
}
