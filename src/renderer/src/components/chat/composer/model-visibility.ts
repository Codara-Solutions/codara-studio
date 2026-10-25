import type { PiCatalogModel } from "@shared/types";
import { buildVisibleGroups, type ChatBackendGroup, type ChatModelOption } from "./types";

// Which models the picker lists. By default it is the current lineup
// (buildVisibleGroups trims superseded generations); the user's Edit list
// choices override that per model in both directions, so an older model a
// subscription still serves can be added and a current one removed.

const VISIBILITY_KEY = "codara.modelPicker.visibility";
const LEGACY_HIDDEN_KEY = "codara.modelPicker.hidden";

export type ModelVisibility = Record<string, boolean>;

export const modelVisibilityKey = (model: Pick<ChatModelOption, "backend" | "id">) =>
  `${model.backend}:${model.id}`;

export function readModelVisibility(): ModelVisibility {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VISIBILITY_KEY) ?? "null");
    const prefs: ModelVisibility = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "boolean") prefs[key] = value;
      }
      return prefs;
    }
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_HIDDEN_KEY) ?? "[]");
    if (Array.isArray(legacy)) {
      for (const key of legacy) if (typeof key === "string") prefs[key] = false;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function writeModelVisibility(prefs: ModelVisibility): void {
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(prefs));
    localStorage.removeItem(LEGACY_HIDDEN_KEY);
  } catch {
    // Storage can be unavailable; the choice then lasts for this window only.
  }
}

/** Every model the subscriptions serve, grouped by provider. */
export function allModelGroups(piCatalog: PiCatalogModel[], openRouterModels: string[]): ChatBackendGroup[] {
  return buildVisibleGroups({ piCatalog, openRouterModels, allGenerations: true });
}

export function isModelShown(
  model: ChatModelOption,
  defaults: ReadonlySet<string>,
  prefs: ModelVisibility,
): boolean {
  const key = modelVisibilityKey(model);
  return prefs[key] ?? defaults.has(key);
}

/**
 * The groups the picker and the model cycle offer: the full catalog filtered
 * by the user's choices, falling back to the current lineup for models the
 * user never touched. `keep` (the current model) is always included.
 */
export function shownModelGroups(
  piCatalog: PiCatalogModel[],
  openRouterModels: string[],
  prefs: ModelVisibility,
  keep?: (model: ChatModelOption) => boolean,
): ChatBackendGroup[] {
  const defaults = new Set(
    buildVisibleGroups({ piCatalog, openRouterModels }).flatMap((group) => group.models.map(modelVisibilityKey)),
  );
  return allModelGroups(piCatalog, openRouterModels).map((group) => ({
    ...group,
    models: group.models.filter((model) => keep?.(model) || isModelShown(model, defaults, prefs)),
  }));
}
