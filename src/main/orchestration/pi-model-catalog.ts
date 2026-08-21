// Live model catalog for Cora's model picker.
//
// Codara used to hardcode every selectable model, so a newly released model
// (Opus 5, a new GPT tier) could not be chosen until someone shipped a code
// change. Pi already solves this: it ships a bundled catalog, refreshes it from
// pi.dev in the background, and can filter it down to the models the connected
// subscription is actually entitled to use.
//
// This module asks Pi for that list. It deliberately uses Pi's programmatic
// ModelRuntime rather than the `get_available_models` RPC command, because the
// RPC route needs a live manager session and the picker must work before one
// exists — including on the very first launch after connecting a subscription.
//
// The result is a MERGE INPUT, not a replacement: the renderer keeps its
// curated rows (nice labels, badges, effort ladders, ordering) and unions in
// anything Pi reports that the curated list doesn't cover yet. A brand-new
// model therefore shows up immediately with its vendor label, and only needs a
// hand-written entry later if it deserves special presentation.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_SUBSCRIPTION_PROVIDERS } from "../../shared/agent-families";
import type { PiSubscriptionProvider, PiCatalogModel } from "@shared/types";

import { codaraPiPaths, resolveCodaraPiRuntime } from "./pi-runtime-electron";

/** Pi throttles its own network refresh to 4h; this only bounds how often we
 * pay the (cheap, local) composition cost and pick up a background refresh. */
const CACHE_TTL_MS = 10 * 60_000;
/** Failures are re-tried far sooner than successes — see the catch below. */
const FAILURE_CACHE_TTL_MS = 30_000;
const CREATE_TIMEOUT_MS = 10_000;

const PROVIDERS: readonly PiSubscriptionProvider[] = PI_SUBSCRIPTION_PROVIDERS;

interface PiModelLike {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  reasoning?: unknown;
  contextWindow?: unknown;
  thinkingLevelMap?: unknown;
}

interface ModelRuntimeLike {
  getModels(providerId?: string): readonly unknown[];
  getAvailable(providerId?: string): Promise<readonly unknown[]>;
  hasConfiguredAuth(providerId: string): boolean;
}

/** The catalog Pi itself refreshes from. We query it directly — see fetchRemoteCatalog. */
const PI_CATALOG_BASE_URL = "https://pi.dev";
const CATALOG_FETCH_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Pi's full thinking ladder, minus "off", in ascending order. Emitting in this
 * order (not JSON-key order) keeps downstream effort cycling monotonic. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The thinking levels a model actually supports, mirroring Pi's own
 * getSupportedThinkingLevels (pi-ai dist/models.js): every reasoning model
 * supports minimal…high whether or not thinkingLevelMap has an entry for them;
 * xhigh and max additionally require an entry; an explicit null always means
 * unsupported. A non-reasoning model has no reasoning control at all.
 */
function thinkingLevelsFrom(value: unknown, reasoning: boolean): string[] {
  if (!reasoning) return [];
  const map = isRecord(value) ? value : {};
  return THINKING_LEVELS.filter((level) => {
    const native = map[level];
    if (native === null) return false;
    if (level === "xhigh" || level === "max") return native !== undefined;
    return true;
  });
}

function toCatalogModel(raw: unknown, provider: PiSubscriptionProvider): PiCatalogModel | null {
  if (!isRecord(raw)) return null;
  const model = raw as PiModelLike;
  const id = stringValue(model.id);
  if (!id) return null;
  const contextWindow =
    typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : null;
  const reasoning = model.reasoning === true;
  return {
    id,
    label: stringValue(model.name) ?? id,
    provider,
    reasoning,
    ...(contextWindow !== null ? { contextWindow } : {}),
    thinkingLevels: thinkingLevelsFrom(model.thinkingLevelMap, reasoning),
  };
}

/**
 * Pi's catalog lists many models twice — an evergreen id and its dated snapshot
 * ("claude-opus-4-5" and "claude-opus-4-5-20251101"). Both launch the same
 * model, so when the undated id is present its dated twins are dropped rather
 * than padding the picker with near-duplicate rows.
 */
function dropDatedAliases(models: PiCatalogModel[]): PiCatalogModel[] {
  const ids = new Set(models.map((model) => model.id));
  return models.filter((model) => {
    const dated = /^(.+)-\d{8}$/.exec(model.id);
    return !(dated && ids.has(dated[1]));
  });
}

async function loadModelRuntime(): Promise<ModelRuntimeLike> {
  const runtime = await resolveCodaraPiRuntime();
  const paths = codaraPiPaths();
  // pathToFileURL, not string concatenation: a Windows drive letter, a space,
  // or a '#' in the install path all produce a wrong or invalid URL otherwise.
  const modulePath = pathToFileURL(join(runtime.packageRoot, "dist", "core", "model-runtime.js")).href;
  const loaded = (await import(/* @vite-ignore */ modulePath)) as {
    ModelRuntime?: {
      create(options?: Record<string, unknown>): Promise<ModelRuntimeLike>;
    };
  };
  if (!loaded.ModelRuntime?.create) {
    throw new Error("Pinned Pi does not expose a model runtime");
  }
  return loaded.ModelRuntime.create({
    authPath: paths.authFile,
    // Let Pi top up its catalog from the network so a model released after this
    // build still appears. Pi caches and throttles this itself; if the network
    // is unavailable, create() falls back to the bundled catalog.
    allowModelNetwork: true,
    modelRefreshTimeoutMs: CREATE_TIMEOUT_MS,
  });
}

/**
 * Fetch a provider's catalog straight from pi.dev.
 *
 * Pi already has a remote-catalog overlay pointed at this exact endpoint, but
 * it is gated: remote-catalog-provider.js discards the whole remote list unless
 * the response's Last-Modified is newer than the timestamp baked into the
 * installed package's bundled catalog. On a fresh install that timestamp is
 * effectively "now", so the overlay is dropped and the runtime keeps serving a
 * catalog that is already behind. Measured on Pi 0.82.0: pi.dev serves
 * claude-opus-5, and ModelRuntime.refresh({force:true}) returns success with
 * zero errors while still reporting only up to claude-opus-4-8.
 *
 * Since the entire point of this module is "a model released after this build
 * is selectable", we read the source ourselves and merge it over Pi's baseline.
 * Failure is silent and non-fatal: the caller keeps whatever Pi supplied.
 */
async function fetchRemoteCatalog(provider: PiSubscriptionProvider): Promise<unknown[]> {
  try {
    const url = new URL(
      `/api/models/providers/${encodeURIComponent(provider)}`,
      PI_CATALOG_BASE_URL,
    );
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    // The endpoint returns an id-keyed object; tolerate a bare array too, since
    // Pi's own parser accepts both shapes.
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload)) {
      const models = payload.models;
      if (Array.isArray(models)) return models;
      return Object.values(payload);
    }
    return [];
  } catch {
    return [];
  }
}

let cached: { at: number; ttl: number; models: PiCatalogModel[] } | null = null;
let inflight: Promise<PiCatalogModel[]> | null = null;

/**
 * Every model the connected subscriptions can currently use. Returns an empty
 * array — never throws — when Pi is missing or nothing is connected, so the
 * picker silently falls back to its curated rows rather than breaking.
 */
export function inspectPiModelCatalog(force = false): Promise<PiCatalogModel[]> {
  if (!force && cached && Date.now() - cached.at < cached.ttl) {
    return Promise.resolve(cached.models);
  }
  // A forced read must not be satisfied by a non-forced read that happens to be
  // in flight — Refresh means "hit the source now", so it supersedes the
  // in-flight promise (whose late result is discarded via the inflight check
  // below rather than clobbering the fresher one).
  if (inflight && !force) return inflight;
  // `let … = null` (not const): the closure compares against `work` to detect
  // being superseded by a forced re-read, and TS rejects a const IIFE result
  // referenced from its own initializer. The comparison only runs after the
  // first await, by which point the assignment below has completed.
  let work: Promise<PiCatalogModel[]> | null = null;
  work = (async (): Promise<PiCatalogModel[]> => {
    try {
      const modelRuntime = await loadModelRuntime();
      const models: PiCatalogModel[] = [];
      const seen = new Set<string>();
      for (const provider of PROVIDERS) {
        // getModels, NOT getAvailable: the picker lists its curated rows whether
        // or not a subscription is connected, so the dynamic rows must behave
        // the same. Auth-filtering here meant a user who had not connected yet
        // saw no new models at all — and connecting is exactly when someone
        // goes looking for them. An unusable pick fails at launch with a clear
        // message, which is a better outcome than a silently short list.
        const baseline = (() => {
          try {
            return modelRuntime.getModels(provider);
          } catch {
            return [];
          }
        })();
        // Pi's own copy first, then the live catalog on top: the remote entry
        // wins on conflict because it is the fresher description of the model.
        const raws = [...baseline, ...(await fetchRemoteCatalog(provider))];
        for (const raw of raws) {
          const model = toCatalogModel(raw, provider);
          if (!model) continue;
          if (seen.has(model.id)) {
            const index = models.findIndex((entry) => entry.id === model.id);
            if (index >= 0) models[index] = model;
            continue;
          }
          seen.add(model.id);
          models.push(model);
        }
      }
      const deduped = dropDatedAliases(models);
      // An empty SUCCESS almost always means "no subscription connected yet",
      // which the user is often in the middle of fixing — cache it as briefly
      // as a failure so connecting doesn't leave the picker curated-only for
      // the full TTL.
      const ttl = deduped.length > 0 ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS;
      if (inflight === work) cached = { at: Date.now(), ttl, models: deduped };
      return deduped;
    } catch {
      // Missing runtime, unreadable auth store, or a Pi API change must not
      // take out the model picker — the curated catalog still works.
      //
      // Cache the failure only briefly. A transient error (a subscription
      // being connected right now, a slow first network refresh) must not pin
      // an empty catalog for the full TTL, which would look like the dynamic
      // models silently not working.
      if (inflight === work) cached = { at: Date.now(), ttl: FAILURE_CACHE_TTL_MS, models: [] };
      return [];
    }
  })();
  inflight = work;
  void work.finally(() => {
    if (inflight === work) inflight = null;
  });
  return work;
}

/** Drop the cache so the next read is live — used after connect/disconnect. */
export function invalidatePiModelCatalogCache(): void {
  cached = null;
}
