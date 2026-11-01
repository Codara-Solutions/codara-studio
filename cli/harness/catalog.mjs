// Which models exist, so a new one needs no Pi upgrade. In order of trust: what
// the provider says this account offers, the cached copy of that answer, then
// models.json beside this file.
//
// A provider's list has ids and limits but not Pi's request settings, so a model
// Pi has never seen takes those from its family in models.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const {
  aliases: ALIASES,
  defaults: DEFAULTS,
  models: BUILT_IN,
} = JSON.parse(readFileSync(new URL("./models.json", import.meta.url), "utf8"));

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 3000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const LISTS = {
  anthropic: {
    path: "/v1/models?limit=100",
    headers: ({ access }) => ({
      authorization: `Bearer ${access}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    }),
    parse: (body) =>
      (body.data ?? []).map((model) => ({
        id: model.id,
        name: model.display_name,
        contextWindow: model.max_input_tokens,
        maxTokens: model.max_tokens,
        images: model.capabilities?.image_input?.supported,
      })),
  },
  "openai-codex": {
    // The server hides models newer than the client that asks.
    path: "/codex/models?client_version=999.0.0",
    headers: ({ access, accountId }) => ({
      authorization: `Bearer ${access}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    }),
    parse: (body) =>
      (body.models ?? [])
        .filter((model) => model.visibility === "list" && model.supported_in_api !== false)
        .map((model) => ({
          id: model.slug,
          name: model.display_name,
          contextWindow: model.context_window,
          images: model.input_modalities?.includes("image"),
        })),
  },
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function askProvider(provider, login, baseUrl) {
  const { path, headers, parse } = LISTS[provider];
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, { headers: headers(login), signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parse(await response.json());
  if (models.length === 0) throw new Error("it listed no models");
  return models;
}

/**
 * @param options.readLogin  provider to its unexpired login, or null. Discovery
 *   never refreshes a token: without a usable one it keeps what it knows.
 * @param options.force  ask even when the cached answer is fresh
 * @param options.discover  false for a custom endpoint, which has no account
 */
export async function loadCatalog({ home, readLogin, force = false, discover = true }) {
  const file = join(home, "catalog.json");
  const cache = readJson(file) ?? {};
  const configured = readJson(join(home, "models.json"))?.providers ?? {};
  const failed = [];
  let changed = false;
  const now = Date.now();
  if (discover) {
    await Promise.all(
      Object.keys(LISTS).map(async (provider) => {
        const entry = cache[provider];
        const ttl = entry?.ok ? CACHE_TTL_MS : RETRY_AFTER_FAILURE_MS;
        if (!force && entry && now - entry.checkedAt < ttl) return;
        const login = readLogin(provider);
        if (!login) return;
        const baseUrl = configured[provider]?.baseUrl ?? BUILT_IN[provider][0].baseUrl;
        changed = true;
        try {
          cache[provider] = { ok: true, checkedAt: now, models: await askProvider(provider, login, baseUrl) };
        } catch (error) {
          cache[provider] = { ...entry, ok: false, checkedAt: now };
          failed.push(`${provider} (${error.message})`);
        }
      }),
    );
  }
  if (changed) {
    try {
      writeFileSync(file, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    } catch {
      // The next run asks again.
    }
  }
  const offered = {};
  for (const provider of Object.keys(LISTS)) offered[provider] = cache[provider]?.models ?? null;
  const custom = {};
  for (const [provider, config] of Object.entries(configured)) {
    custom[provider] = new Set((config.models ?? []).map((model) => model.id));
  }
  return { offered, failed, custom };
}

const familyPattern = (alias) => new RegExp(`(^|-)${alias}(-|$)`);
const version = (id) => (id.match(/\d+/g) ?? []).map(Number);

function newer(a, b) {
  const [left, right] = [version(a), version(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export const isAlias = (name) => Object.hasOwn(ALIASES, name);

/** The newest model of an alias's family that the account offers. */
export function resolveAlias(alias, catalog) {
  const { provider, id } = ALIASES[alias];
  const family = (catalog.offered[provider] ?? []).map((model) => model.id).filter((modelId) => familyPattern(alias).test(modelId));
  return { provider, id: family.reduce((best, modelId) => (newer(modelId, best) ? modelId : best), family[0] ?? id) };
}

/** Provider to default model, in the order a new session should try them. */
export function defaultModels(catalog) {
  return Object.entries(DEFAULTS).map(([provider, alias]) => [provider, resolveAlias(alias, catalog).id]);
}

function familyTemplate(provider, id) {
  const alias = Object.keys(ALIASES).find((name) => ALIASES[name].provider === provider && familyPattern(name).test(id));
  return BUILT_IN[provider].find((model) => model.id === ALIASES[alias]?.id) ?? BUILT_IN[provider][0];
}

function providerModels(provider, current, catalog) {
  const known = new Map([...current, ...BUILT_IN[provider]].map((model) => [model.id, model]));
  const offered = catalog.offered[provider];
  if (!offered) return [...known.values()];
  const custom = catalog.custom[provider];
  const listed = new Set(offered.map((model) => model.id));
  return [
    ...offered.map((model) => {
      const base = known.get(model.id) ?? { ...familyTemplate(provider, model.id), cost: NO_COST };
      return {
        ...base,
        id: model.id,
        name: model.name ?? base.name,
        contextWindow: model.contextWindow ?? base.contextWindow,
        maxTokens: model.maxTokens ?? base.maxTokens,
        input: model.images === false ? ["text"] : base.input,
      };
    }),
    ...current.filter((model) => custom?.has(model.id) && !listed.has(model.id)),
  ];
}

/**
 * Pi's `models` replaces a provider's whole list and a model's own baseUrl beats
 * the provider's, so every entry carries the URL this run must use: the run's
 * override, else the one it has now, which a new model takes from the provider.
 */
export function registerCatalog(runtime, catalog, endpoints = {}) {
  for (const provider of Object.keys(BUILT_IN)) {
    const current = runtime.getModels(provider);
    const providerUrl = current[0]?.baseUrl ?? BUILT_IN[provider][0].baseUrl;
    const urls = new Map(current.map((model) => [model.id, model.baseUrl]));
    const models = providerModels(provider, current, catalog).map((model) => ({
      ...model,
      baseUrl: endpoints[provider] ?? urls.get(model.id) ?? providerUrl,
    }));
    runtime.registerProvider(provider, { models });
  }
}
