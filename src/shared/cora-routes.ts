// Which way a Cora model request travels: a provider sign-in the user already
// pays for (Claude or ChatGPT subscription, xAI), an OpenRouter key, or
// Subcloud. The model the user picked names the model; the route order in
// Settings decides how Cora reaches it. The same model is reachable both ways
// when its OpenRouter id is in the user's verified Cora list, for example
// `claude-opus-5` through the Claude sign-in or `anthropic/claude-opus-5`
// through OpenRouter.
//
// Pure, so the main process, the renderer and the unit suite share it.

import { subscriptionForModelId } from "./agent-families";
import type { PiSubscriptionProvider } from "./types";
import { ALLOWED_WORKER_MODELS } from "./worker-model-roster";

export type CoraRoute = "subscription" | "openrouter" | "subcloud";

export const CORA_ROUTES: readonly CoraRoute[] = ["subscription", "openrouter", "subcloud"];
export const DEFAULT_CORA_ROUTE_ORDER: readonly CoraRoute[] = CORA_ROUTES;

const OPENROUTER_PREFIX: Record<PiSubscriptionProvider, string> = {
  anthropic: "anthropic/",
  "openai-codex": "openai/",
  xai: "x-ai/",
};

export function isCoraRoute(value: unknown): value is CoraRoute {
  return typeof value === "string" && (CORA_ROUTES as readonly string[]).includes(value);
}

/** Every route once, in the user's order, with any missing ones after it in
 *  the default order. A route with nothing configured is skipped at launch,
 *  so listing it never sends a request anywhere. */
export function normalizeCoraRouteOrder(value: unknown): CoraRoute[] {
  const out: CoraRoute[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (isCoraRoute(item) && !out.includes(item)) out.push(item);
  }
  for (const route of DEFAULT_CORA_ROUTE_ORDER) if (!out.includes(route)) out.push(route);
  return out;
}

/** The route a model id travels on by its own spelling. */
export function routeOfModelId(model: string | undefined | null): CoraRoute | null {
  const id = model?.trim() ?? "";
  if (!id) return null;
  if (id.startsWith("subcloud/")) return "subcloud";
  if (id.includes("/")) return "openrouter";
  return subscriptionForModelId(id) ? "subscription" : null;
}

/** Native ids a sign-in is known to serve when Pi's catalog is not at hand.
 *  An OpenRouter id moves onto a sign-in only when its native spelling is a
 *  known native id: OpenRouter spells some models differently
 *  (`claude-sonnet-4.5` against `claude-sonnet-4-5`) and lists models a
 *  subscription does not offer. */
const NATIVE_ROUTABLE_MODELS: ReadonlySet<string> = new Set(ALLOWED_WORKER_MODELS);

/** The `@effort` of a native id such as `gpt-5.6-sol@low`, or undefined. */
export function effortOfModelId(model: string | undefined | null): string | undefined {
  const at = model?.indexOf("@") ?? -1;
  return at >= 0 ? model!.slice(at + 1).trim() || undefined : undefined;
}

const WORKER_RUNTIME: Record<PiSubscriptionProvider, "claude" | "codex" | "grok"> = {
  anthropic: "claude",
  "openai-codex": "codex",
  xai: "grok",
};

/** The worker family a model belongs to on any route: `gpt-5.6-sol` and
 *  `openai/gpt-5.6-sol` are both "codex". Undefined for other vendors. */
export function workerFamilyOfModelId(model: string | undefined | null): "claude" | "codex" | "grok" | undefined {
  const { base } = splitEffort((model ?? "").trim());
  if (!base) return undefined;
  for (const [provider, prefix] of Object.entries(OPENROUTER_PREFIX) as Array<[PiSubscriptionProvider, string]>) {
    if (base.startsWith(prefix)) return WORKER_RUNTIME[provider];
  }
  if (base.includes("/")) return undefined;
  const provider = subscriptionForModelId(base);
  return provider ? WORKER_RUNTIME[provider] : undefined;
}

/** `gpt-5.6-sol@high` as its model id and its effort suffix. */
function splitEffort(model: string): { base: string; effort: string } {
  const at = model.indexOf("@");
  return at >= 0 ? { base: model.slice(0, at), effort: model.slice(at) } : { base: model, effort: "" };
}

/** The same model spelled for each route that can carry it. A native
 *  `@effort` suffix stays on the native spelling only; OpenRouter gets the
 *  effort through Pi's thinking option instead. */
export function routeSpellings(
  model: string,
  nativeModels: ReadonlySet<string> = NATIVE_ROUTABLE_MODELS,
): Partial<Record<CoraRoute, string>> {
  const { base, effort } = splitEffort(model.trim());
  const route = routeOfModelId(base);
  if (route === "subscription") {
    const provider = subscriptionForModelId(base);
    return provider ? { subscription: `${base}${effort}`, openrouter: `${OPENROUTER_PREFIX[provider]}${base}` } : {};
  }
  if (route === "openrouter") {
    for (const [provider, prefix] of Object.entries(OPENROUTER_PREFIX) as Array<[PiSubscriptionProvider, string]>) {
      if (!base.startsWith(prefix)) continue;
      const native = base.slice(prefix.length);
      if (subscriptionForModelId(native) === provider && nativeModels.has(native)) {
        return { subscription: native, openrouter: base };
      }
    }
    return { openrouter: base };
  }
  return route ? { [route]: `${base}${effort}` } : {};
}

export interface CoraRouteAvailability {
  /** Subscription providers with a usable sign-in. */
  subscriptions: ReadonlySet<PiSubscriptionProvider>;
  /** OpenRouter ids verified for Cora (Settings > API and model). */
  openRouterModels: ReadonlySet<string>;
  /** Native ids the sign-ins serve (Pi's catalog); the worker roster when
   *  absent. */
  nativeModels?: ReadonlySet<string>;
}

export interface CoraRouteChoice {
  route: CoraRoute;
  /** The id to launch, spelled for that route. */
  model: string;
}

/**
 * The first route in `order` that can carry `model` now, or null when none
 * can, in which case the caller launches `model` as picked and its own error
 * explains what is missing. Subcloud carries nothing until it is configured.
 */
export function chooseCoraRoute(
  model: string,
  order: readonly CoraRoute[],
  availability: CoraRouteAvailability,
): CoraRouteChoice | null {
  const spellings = routeSpellings(model, availability.nativeModels);
  for (const route of order) {
    const id = spellings[route];
    if (!id) continue;
    if (route === "subscription") {
      const provider = subscriptionForModelId(splitEffort(id).base);
      if (provider && availability.subscriptions.has(provider)) return { route, model: id };
    } else if (route === "openrouter") {
      if (availability.openRouterModels.has(id)) return { route, model: id };
    }
  }
  return null;
}

/** Short label for a route, as Settings and the run's Costs tab show it. */
export function coraRouteLabel(model: string | undefined | null): string {
  const route = routeOfModelId(model);
  if (route === "openrouter") return "OpenRouter key";
  if (route === "subcloud") return "Subcloud";
  if (route !== "subscription") return "Unknown";
  const provider = subscriptionForModelId(model ?? "");
  if (provider === "anthropic") return "Claude sign-in";
  if (provider === "openai-codex") return "ChatGPT sign-in";
  return "xAI sign-in";
}

export interface CoraRouteRow {
  key: string;
  who: "Cora" | "Worker";
  model: string;
  route: string;
  /** First characters of the account profile id, or "" when none. */
  account: string;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

interface RouteUsage {
  model?: string;
  accountProfileId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** One row per (who, model, account) for a run's manager calls and worker
 *  attempts: the route each part took and the tokens it used there. */
export function coraRouteRows(
  managerCalls: readonly RouteUsage[],
  workerAttempts: readonly RouteUsage[],
): CoraRouteRow[] {
  const rows = new Map<string, CoraRouteRow>();
  const add = (who: CoraRouteRow["who"], usage: RouteUsage) => {
    if (!usage.model) return;
    const account = usage.accountProfileId ? usage.accountProfileId.slice(0, 8) : "";
    const key = `${who}|${usage.model}|${account}`;
    const row = rows.get(key) ?? {
      key, who, model: usage.model, route: coraRouteLabel(usage.model), account, inputTokens: 0, outputTokens: 0, count: 0,
    };
    row.inputTokens += usage.inputTokens ?? 0;
    row.outputTokens += usage.outputTokens ?? 0;
    row.count += 1;
    rows.set(key, row);
  };
  for (const call of managerCalls) add("Cora", call);
  for (const attempt of workerAttempts) add("Worker", attempt);
  return [...rows.values()];
}

/** Pi's own warning for its Claude sign-in, said where Cora uses it. */
export const CLAUDE_PI_LOGIN_BILLING_NOTE =
  "Pi's Claude sign-in is billed as extra usage, per token, not from your Claude plan limits.";

/** A chat on an account the user chose stays on it: routing it elsewhere
 *  would drop that pin without a word. The pin Cora took itself on turn 1
 *  (chatAccountProfileImplicit) does not stop routing, or turn 2 would leave
 *  the route order. */
export function managerRoutePinnedByUser(run: {
  chatAccountProfileId?: string;
  chatAccountProfileImplicit?: true;
}): boolean {
  return Boolean(run.chatAccountProfileId) && run.chatAccountProfileImplicit !== true;
}
