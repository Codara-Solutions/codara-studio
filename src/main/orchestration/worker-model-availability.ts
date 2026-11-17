import type { AppSettings, PiSubscriptionProvider } from "@shared/types";
import {
  chooseCoraRoute,
  normalizeCoraRouteOrder,
  type CoraRouteAvailability,
} from "@shared/cora-routes";
import { ALLOWED_WORKER_MODELS, partitionWorkerModelsByAccount } from "@shared/worker-model-roster";
import { availableCoraWorkerModels, configuredOpenRouterCoraModels } from "../openrouter-config";

export interface CoraWorkerModelAvailability {
  /** Enabled models Cora can launch now. */
  connected: string[];
  /** Enabled models whose provider has no usable account. */
  disconnected: string[];
}

/** Subscription providers with a usable sign-in, read without refreshing.
 *  Null when the store cannot be read. The auth modules load lazily, as in
 *  pi-runtime-electron, so bundles that only need the settings filter do not
 *  pull in the credential stores. */
async function usableSubscriptions(): Promise<Set<PiSubscriptionProvider> | null> {
  try {
    const [{ inspectPiAccountProfileAuthStore }, { usablePiProviders }] = await Promise.all([
      import("./pi-account-auth-store"),
      import("./pi-worker-providers"),
    ]);
    const inspection = await inspectPiAccountProfileAuthStore();
    return usablePiProviders(inspection.statuses);
  } catch {
    return null;
  }
}

/** Native ids in Pi's bundled catalog plus the worker roster, or undefined
 *  when the catalog cannot be read (the roster alone is used then). */
async function nativeCatalogModels(): Promise<Set<string> | undefined> {
  try {
    const { inspectPiModelCatalog } = await import("./pi-model-catalog");
    const models = await inspectPiModelCatalog();
    return new Set([...ALLOWED_WORKER_MODELS, ...models.map((model) => model.id)]);
  } catch {
    return undefined;
  }
}

/** What each Cora route can carry right now. */
export async function coraRouteAvailability(settings: AppSettings): Promise<CoraRouteAvailability | null> {
  const [subscriptions, nativeModels] = await Promise.all([usableSubscriptions(), nativeCatalogModels()]);
  if (!subscriptions) return null;
  return {
    subscriptions,
    openRouterModels: new Set(configuredOpenRouterCoraModels(settings)),
    ...(nativeModels ? { nativeModels } : {}),
  };
}

/**
 * The id Cora launches for `model`: the same model on the first route in the
 * user's order that can carry it now. An unreadable auth store or a model no
 * route carries keeps `model` as picked, so its launch error names the fix.
 */
export async function routeCoraModel(
  model: string,
  settings: AppSettings,
  availability?: CoraRouteAvailability | null,
): Promise<string> {
  const known = availability === undefined ? await coraRouteAvailability(settings) : availability;
  if (!known) return model;
  return chooseCoraRoute(model, normalizeCoraRouteOrder(settings.coraRouteOrder), known)?.model ?? model;
}

/**
 * The enabled worker models, split by whether a route can carry them now. A
 * failed read keeps every enabled model, the same way
 * detectWorkerAssignableRuntimes degrades, so an unreadable store never
 * leaves Cora with no workers at all.
 */
export async function coraWorkerModelAvailability(
  settings: AppSettings,
): Promise<CoraWorkerModelAvailability> {
  const enabled = availableCoraWorkerModels(settings);
  const availability = await coraRouteAvailability(settings);
  if (!availability) return { connected: enabled, disconnected: [] };
  const split = partitionWorkerModelsByAccount(enabled, availability.subscriptions);
  const order = normalizeCoraRouteOrder(settings.coraRouteOrder);
  // A model whose sign-in is missing still runs when a later route carries it.
  const rerouted = split.disconnected.filter((id) => chooseCoraRoute(id, order, availability) !== null);
  return {
    connected: [...split.connected, ...rerouted],
    disconnected: split.disconnected.filter((id) => !rerouted.includes(id)),
  };
}
