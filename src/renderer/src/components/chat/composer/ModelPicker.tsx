import { useEffect, useRef, useState } from "react";
import type { ChatBackendKind, PiCatalogModel } from "@shared/types";
import {
  buildVisibleGroups,
  composeModelId,
  findOptionInCatalog,
  type ChatBackendGroup,
  type ChatModelOption,
} from "./types";
import AnchoredMenu from "./AnchoredMenu";

interface Props {
  activeBackend: ChatBackendKind;
  activeModelId: string;
  activeOneMillion: boolean;
  onPick: (model: ChatModelOption) => void;
}

// The model pill + grouped dropdown menu. Reads agents.runtimes() to decide
// what to show: Pi always, plus each CLI runtime that is installed and not
// disabled in settings. Claude rows are 1M-only, so selecting one sets
// chat1mContext=true.
export default function ModelPicker({
  activeBackend,
  activeModelId,
  activeOneMillion,
  onPick,
}: Props) {
  const [open, setOpen] = useState(false);
  const [piCatalog, setPiCatalog] = useState<PiCatalogModel[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Pi's live model catalog, refreshed on every open. The main process caches
  // it, so reopening is cheap, and a model released after this build shows up
  // on the next open rather than needing a restart. Runtime diagnostics are no
  // longer read here: they gated the Claude Code / Codex CLI groups, and Cora
  // runs only on Pi now.
  useEffect(() => {
    void window.spark.piSubscriptions.catalog().then((models) => setPiCatalog(models ?? []));
  }, []);
  useEffect(() => {
    if (!open) return;
    void window.spark.piSubscriptions.catalog().then((models) => setPiCatalog(models ?? []));
  }, [open]);

  // Dismissal lives in AnchoredMenu now, it owns the portal, so it is the only
  // thing that can tell "outside" from "inside" once the menu is no longer a
  // DOM descendant of this component.

  const groups: ChatBackendGroup[] = buildVisibleGroups({ piCatalog });
  // Both groups are always pushed, so an empty menu means every group came
  // back with no rows (no Pi subscription connected).
  const hasModels = groups.some((group) => group.models.length > 0);
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
    <div className="composer-model">
      <button
        type="button"
        ref={triggerRef}
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
        {/* Wrapped rather than left as a bare text node: a text node cannot be
            ellipsized inside a flex container, and this is the only pill whose
            text has no upper bound (model names come from the vendor). */}
        <span className="composer-pill-label">{activeLabel}</span>
      </button>
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        className="composer-model-menu spark-menu"
        role="listbox"
      >
        {!hasModels && (
          <div className="composer-model-empty">
            No models available. Connect a Pi subscription in Settings.
          </div>
        )}
        {groups.map((group, index) => (
          <div key={group.key} className="composer-model-group">
            {/* The harness heading prints once for the whole run of groups that
                share it. Every row here runs on Pi, so repeating it per vendor
                would read as two different backends, which is exactly the
                confusion the vendor split is meant to remove. */}
            {group.section !== groups[index - 1]?.section && (
              <div className="composer-model-section-label">{group.section}</div>
            )}
            <div className="composer-model-group-label is-vendor">{group.label}</div>
            {group.models.map((model) => {
              const active =
                model.id === activeCompoundId && model.backend === activeBackend;
              return (
                <button
                  key={`${model.backend}:${model.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`composer-model-row is-compact${active ? " is-active" : ""}`}
                  onClick={() => select(model)}
                >
                  {/* The name, and nothing else. No tier cards, no blurb, no
                      1M tag, the label already ends in "1M" where it applies.
                      `isOneMillion` still drives chat1mContext on pick; it is
                      only the visual tag that is gone. */}
                  <span className="composer-model-row-label">{model.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </AnchoredMenu>
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
  // still informative (typical when the run's model has since dropped out of
  // the live catalog, or its runtime was disabled).
  return rawModelId || "Pick a model";
}
