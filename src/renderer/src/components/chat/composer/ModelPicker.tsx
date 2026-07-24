import { useEffect, useRef, useState } from "react";
import type { AgentRuntimeDiagnostic, ChatBackendKind, PiCatalogModel } from "@shared/types";
import {
  buildVisibleGroups,
  composeModelId,
  findOptionInCatalog,
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
// configured in settings (matching vienna's behavior). Claude rows are 1M-only
// and carry a "1M" badge; selecting one sets chat1mContext=true.
export default function ModelPicker({
  activeBackend,
  activeModelId,
  activeOneMillion,
  onPick,
}: Props) {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AgentRuntimeDiagnostic[]>([]);
  const [openRouterModel, setOpenRouterModel] = useState<string>("");
  const [piCatalog, setPiCatalog] = useState<PiCatalogModel[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // One-shot load of runtimes + the configured OpenRouter model. Settings
  // can change while the user is in the bar (they hit Settings, change the
  // OR model, come back), so we refresh on every open. Pi's live model
  // catalog rides along on the same cadence — the main process caches it, so
  // reopening the menu is cheap, and a newly released model shows up on the
  // next open rather than requiring a restart.
  useEffect(() => {
    void window.spark.agents.runtimes().then((rs) => setDiagnostics(rs ?? []));
    void window.spark.settings
      .load()
      .then((s) => setOpenRouterModel((s.openRouterModel ?? "").trim()));
    void window.spark.piSubscriptions.catalog().then((models) => setPiCatalog(models ?? []));
  }, []);
  useEffect(() => {
    if (!open) return;
    void window.spark.agents.runtimes().then((rs) => setDiagnostics(rs ?? []));
    void window.spark.settings
      .load()
      .then((s) => setOpenRouterModel((s.openRouterModel ?? "").trim()));
    void window.spark.piSubscriptions.catalog().then((models) => setPiCatalog(models ?? []));
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

  const groups: ChatBackendGroup[] = buildVisibleGroups({
    diagnostics,
    openRouterModel,
    piCatalog,
  });
  const activeCompoundId = composeModelId(activeModelId, activeOneMillion);
  // Claude/Codex labels come from the static catalog immediately. Waiting for
  // runtime diagnostics made the pill first paint a raw/default id and then
  // replace it with the friendly saved-model label a moment later.
  const activeLabel =
    findOptionInCatalog(activeBackend, activeModelId, activeOneMillion)?.label ??
    labelFor(groups, activeBackend, activeCompoundId, activeModelId);

  const select = (model: ChatModelOption) => {
    onPick(model);
    setOpen(false);
  };

  return (
    <div className="composer-model" ref={rootRef}>
      <button
        type="button"
        className={`composer-pill${open ? " is-active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Chat model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {/* Crisp SVG spark mark at currentColor instead of the unicode ☀
            (which rode the text baseline and rendered heavier per OS font). */}
        <span
          aria-hidden
          style={{ display: "inline-flex", marginRight: 4, flex: "0 0 auto" }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
              fill="currentColor"
            />
          </svg>
        </span>
        {activeLabel}
      </button>
      {open && (
        <div className="composer-model-menu spark-menu" role="listbox">
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
                    role="option"
                    aria-selected={active}
                    className={`composer-model-row${active ? " is-active" : ""}`}
                    onClick={() => select(model)}
                  >
                    <span className="composer-model-row-copy">
                      <span className="composer-model-row-label">{model.label}</span>
                      {model.description && (
                        <span className="composer-model-row-description">
                          {model.description}
                        </span>
                      )}
                    </span>
                    <span className="composer-model-row-badges">
                      {model.badge && (
                        <span className="composer-badge is-family">{model.badge}</span>
                      )}
                      {model.isOneMillion && (
                        <span className="composer-badge is-onem">1M</span>
                      )}
                      {group.backend === "openrouter" && (
                        <span className="composer-badge">API</span>
                      )}
                    </span>
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
