import type { AppSettings, PiSubscriptionProvider } from "@shared/types";
import {
  chooseCoraRoute,
  normalizeCoraRouteOrder,
  workerModelsByIdentity,
  type CoraRouteAvailability,
} from "@shared/cora-routes";
import { ALLOWED_WORKER_MODELS, partitionWorkerModelsByAccount } from "@shared/worker-model-roster";
import { availableCoraWorkerModels, configuredOpenRouterCoraModels } from "../openrouter-config";
import { claudeCodeWorkerReady } from "./claude-code-worker";
import type { PiProfileAuthStatusLike } from "./pi-worker-providers";

export interface CoraWorkerModelAvailability {
  /** Enabled models Cora can launch now. */
  connected: string[];
  /** Enabled models whose provider has no usable account. */
  disconnected: string[];
}

/** Subscription providers with a usable sign-in, and those set up at all
 *  (signed in once, even if expired or signed out since), read without
 *  refreshing. Null when the store cannot be read. The auth modules load
 *  lazily, as in pi-runtime-electron, so bundles that only need the settings
 *  filter do not pull in the credential stores. */
async function subscriptionState(): Promise<{
  usable: Set<PiSubscriptionProvider>;
  configured: Set<PiSubscriptionProvider>;
} | null> {
  try {
    const [{ inspectPiAccountProfileAuthStore }, { usablePiProviders }] = await Promise.all([
      import("./pi-account-auth-store"),
      import("./pi-worker-providers"),
    ]);
    // Only these four status fields cross into the route code: never the
    // profile snapshot, account email, fingerprint or anything credential.
    const statuses: PiProfileAuthStatusLike[] = (await inspectPiAccountProfileAuthStore()).statuses.map(
      ({ provider, connected, expired, canRefresh }) => ({ provider, connected, expired, canRefresh }),
    );
    return {
      usable: usablePiProviders(statuses),
      configured: new Set(statuses.map((status) => status.provider)),
    };
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

/**
 * What each Cora route can carry right now. A sign-in counts once it was set
 * up, even when it has expired or was signed out: that launch then fails and
 * says to sign in again, instead of moving to a paid key without a word. A
 * sign-in at its usage limit is not handed to another route either.
 */
export async function coraRouteAvailability(
  settings: AppSettings,
  options: CoraRouteOptions = {},
): Promise<CoraRouteAvailability | null> {
  // Claude Code is checked only for a managed worker whose user picked an
  // order with it; Cora herself and every other launch never get it.
  const wantsClaudeCode =
    options.managedWorker === true && settings.coraRouteOrder?.includes("claudecode") === true;
  const [state, nativeModels, claudeCode] = await Promise.all([
    subscriptionState(),
    nativeCatalogModels(),
    wantsClaudeCode ? (options.claudeCodeReady ?? claudeCodeWorkerReady)() : Promise.resolve(false),
  ]);
  if (!state) return null;
  return {
    subscriptions: state.configured,
    openRouterModels: new Set(configuredOpenRouterCoraModels(settings)),
    ...(nativeModels ? { nativeModels } : {}),
    ...(claudeCode ? { claudeCode: true } : {}),
  };
}

export interface CoraRouteOptions {
  /** A managed worker of a trusted run (not a direct chat, automation or
   *  workflow step): the only launch Claude Code may run. */
  managedWorker?: boolean;
  /** Test seam for the Claude Code check. */
  claudeCodeReady?: () => Promise<boolean>;
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
  options: CoraRouteOptions = {},
): Promise<string> {
  // No order chosen in Settings: every model launches as picked.
  if (settings.coraRouteOrder === undefined) return model;
  const known = availability === undefined ? await coraRouteAvailability(settings, options) : availability;
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
  options: CoraRouteOptions = {},
): Promise<CoraWorkerModelAvailability> {
  const enabled = availableCoraWorkerModels(settings);
  const [state, availability] = await Promise.all([subscriptionState(), coraRouteAvailability(settings, options)]);
  if (!state || !availability) return { connected: enabled, disconnected: [] };
  const split = partitionWorkerModelsByAccount(enabled, state.usable);
  if (settings.coraRouteOrder === undefined) return split;
  const order = normalizeCoraRouteOrder(settings.coraRouteOrder);
  // A model whose sign-in was never set up still runs when OpenRouter
  // carries it, or Claude Code for a managed worker (options.managedWorker);
  // a broken sign-in keeps it waiting for the user.
  const rerouted = split.disconnected.filter((id) => {
    const route = chooseCoraRoute(id, order, availability)?.route;
    return route === "openrouter" || route === "claudecode";
  });
  return {
    connected: [...split.connected, ...rerouted],
    disconnected: split.disconnected.filter((id) => !rerouted.includes(id)),
  };
}

/**
 * The models a managed worker's model is picked from. With an order chosen, a
 * model is planned by what it is (`openai/gpt-5.6-sol` and `gpt-5.6-sol` are
 * one model) and routeCoraModel alone picks its route; planning on spellings
 * would let the roster pick another family, or the paid spelling, first.
 */
export function workerPlanningModels(connected: readonly string[], settings: AppSettings): string[] {
  return settings.coraRouteOrder === undefined ? [...connected] : workerModelsByIdentity(connected);
}
