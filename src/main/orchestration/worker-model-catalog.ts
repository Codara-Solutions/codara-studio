// Every model a Cora worker could run on, discovered at runtime.
//
// The worker list used to be a hand-kept roster, so a model released after a
// build could not be switched on until someone shipped a code change. This
// module unions three read-only sources per provider:
//
//   * Pi's catalog (bundled, topped up from pi.dev by pi-model-catalog.ts);
//   * the provider's own model list for the signed-in account, read with the
//     token Codara's Pi auth store already holds (Anthropic /v1/models,
//     ChatGPT's Codex model list, xAI /v1/models);
//   * caches the CLIs keep on disk: Codex's models_cache.json and the extra
//     model options Claude Code records in ~/.claude.json.
//
// Nothing here writes outside Codara's home: CLI files are read, a token that
// is about to expire is skipped rather than refreshed (a refresh rotates the
// stored refresh token), and the only file written is Codara's own cache of
// what was seen when, which drives the "New" badge. A newly discovered model
// is never switched on: the enabled list is settings.coraWorkerModels, and
// nothing here touches it.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { PI_SUBSCRIPTION_PROVIDERS } from "@shared/agent-families";
import { findOptionInCatalog } from "@shared/chat-models";
import { WORKER_MODEL_ROSTER, workerModelSubscription } from "@shared/worker-model-roster";
import { claudeUserConfigFile } from "./claude-paths";
import { codaraHomeDir } from "./codara-managed-cli-roots";
import { defaultPersonalCodexHomeDir } from "./codex-cli-account-profiles";
import type {
  PiCatalogModel,
  PiSubscriptionProvider,
  WorkerCatalogModel,
  WorkerModelCatalog,
  WorkerModelProviderState,
  WorkerModelSource,
} from "@shared/types";

const CACHE_TTL_MS = 10 * 60_000;
const NEW_WINDOW_MS = 14 * 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_LIST_PAGES = 5;
const MAX_CLI_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FIRST_SEEN_ENTRIES = 1_000;
const STATE_VERSION = 1;
const BACKGROUND_FIRST_DELAY_MS = 45_000;
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60_000;
// The Codex model list answers per client version; a newer version sees newer
// models. The CLI's own cache names the version it last used, which wins
// when it is higher.
const CODEX_CLIENT_VERSION_FLOOR = "0.162.0";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_THINKING_LEVELS = ["minimal", "low", "medium", "high"];
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,99}$/i;
const DATED_ID = /^(.+)-\d{8}$/;

const VENDOR: Record<PiSubscriptionProvider, string> = {
  anthropic: "Anthropic",
  "openai-codex": "ChatGPT",
  xai: "xAI",
};

export const DEFAULT_PROVIDER_BASE_URLS: Record<PiSubscriptionProvider, string> = {
  anthropic: "https://api.anthropic.com",
  "openai-codex": "https://chatgpt.com",
  xai: "https://api.x.ai",
};

/** One model as a provider list or CLI cache describes it. */
export interface DiscoveredModel {
  id: string;
  label?: string;
  contextWindow?: number;
  thinkingLevels?: string[];
  /** Lower sorts first; the Codex list carries its own ordering. */
  priority?: number;
}

export interface ProviderListing {
  listedFrom: "provider" | "cli" | "pi";
  models: DiscoveredModel[];
  /** A live provider list for this account: a model missing from it is not
   * offered to the account. A CLI cache or an older list is only a hint. */
  authoritative: boolean;
  note: string | null;
  checkedAt: string | null;
}

export interface WorkerModelCatalogState {
  version: number;
  baselineAt: string | null;
  firstSeen: Record<string, string>;
  /** The last live list per provider, so a restart offline keeps the models
   * the provider listed instead of falling back to Pi's catalog alone. */
  lastLive: Partial<Record<PiSubscriptionProvider, { checkedAt: string; models: DiscoveredModel[] }>>;
}

export type ProviderAccess = { access: string; accountId: string | null } | "expired";

export interface WorkerModelCatalogDeps {
  fetch: typeof fetch;
  now: () => number;
  statePath: string;
  piCatalog: (force: boolean) => Promise<PiCatalogModel[]>;
  signedInProviders: () => Promise<ReadonlySet<PiSubscriptionProvider>>;
  /** The stored token for the provider's default account; null when there is
   * none. Never refreshes. */
  readAccess: (provider: PiSubscriptionProvider) => Promise<ProviderAccess | null>;
  enabledModels: () => Promise<readonly string[]>;
  codexCliCachePath: () => string | null;
  claudeCliConfigPath: () => string | null;
  baseUrls?: Partial<Record<PiSubscriptionProvider, string>>;
}

class ListError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/** GET /v1/models on the Anthropic API: { data: [{ id, display_name }], has_more, last_id }. */
export function parseAnthropicModelList(payload: unknown): { models: DiscoveredModel[]; nextAfter: string | null } {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new ListError("unexpected response");
  const models: DiscoveredModel[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    if (!id) continue;
    const contextWindow = positiveNumber(entry.max_input_tokens) ?? positiveNumber(entry.context_window);
    models.push({
      id,
      ...(text(entry.display_name) ? { label: text(entry.display_name)! } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  const nextAfter = payload.has_more === true ? text(payload.last_id) : null;
  return { models, nextAfter };
}

/** ChatGPT's Codex model list and the Codex CLI's models_cache.json share one
 * shape: { models: [{ slug, display_name, visibility, priority, ... }] }.
 * Only "list" models are offered; hidden ones are internal or retired. */
export function parseCodexModelList(payload: unknown): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) throw new ListError("unexpected response");
  const models: DiscoveredModel[] = [];
  for (const entry of payload.models) {
    if (!isRecord(entry)) continue;
    const id = text(entry.slug) ?? text(entry.id);
    if (!id) continue;
    const visibility = text(entry.visibility);
    if (visibility && visibility !== "list") continue;
    if (entry.supported_in_api === false) continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((level) => (isRecord(level) ? text(level.effort) : text(level)))
          .filter((level): level is string => Boolean(level))
      : [];
    const thinkingLevels = THINKING_LEVELS.filter((level) => levels.includes(level));
    const contextWindow = positiveNumber(entry.context_window);
    const priority = typeof entry.priority === "number" && Number.isFinite(entry.priority) ? entry.priority : undefined;
    models.push({
      id,
      ...(text(entry.display_name) ? { label: text(entry.display_name)! } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(thinkingLevels.length > 0 ? { thinkingLevels: [...thinkingLevels] } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
  }
  return models;
}

/** GET /v1/models on the xAI API: { data: [{ id }] }, OpenAI style. */
export function parseXaiModelList(payload: unknown): DiscoveredModel[] {
  const list = isRecord(payload) ? (Array.isArray(payload.data) ? payload.data : payload.models) : null;
  if (!Array.isArray(list)) throw new ListError("unexpected response");
  const models: DiscoveredModel[] = [];
  for (const entry of list) {
    const id = isRecord(entry) ? text(entry.id) : text(entry);
    if (id) models.push({ id });
  }
  return models;
}

/** Claude Code keeps the extra models an account may pick (Fable, for one)
 * in ~/.claude.json as additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]" }]. */
export function parseClaudeCodeModelOptions(payload: unknown): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.additionalModelOptionsCache)) return [];
  const models: DiscoveredModel[] = [];
  for (const entry of payload.additionalModelOptionsCache) {
    const raw = isRecord(entry) ? text(entry.value) : null;
    const id = raw?.replace(/\[[^\]]*\]$/, "").trim();
    if (id) models.push({ id });
  }
  return models;
}

/** The Codex CLI's model cache, with the client version it was fetched for. */
export function parseCodexCliCache(payload: unknown): { models: DiscoveredModel[]; clientVersion: string | null; fetchedAt: string | null } {
  const models = parseCodexModelList(payload);
  const record = payload as Record<string, unknown>;
  return { models, clientVersion: text(record.client_version), fetchedAt: text(record.fetched_at) };
}

// ── Presentation ────────────────────────────────────────────────────────────

/** A model id Cora can route to this provider: Pi picks the provider from the
 * id's prefix, so anything else (codex-auto-review, a dated alias with no
 * prefix) could never launch. */
export function routableWorkerModel(provider: PiSubscriptionProvider, id: string): boolean {
  return MODEL_ID_PATTERN.test(id) && workerModelSubscription(id) === provider;
}

export function prettyModelLabel(id: string): string {
  const parts = id.split("-").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (/^\d+(\.\d+)*$/.test(part) && previous !== undefined && /\d$/.test(previous) && !/^GPT-/.test(previous)) {
      out[out.length - 1] = `${previous}.${part}`;
    } else if (/^\d/.test(part) && previous === "GPT") {
      out[out.length - 1] = `GPT-${part}`;
    } else if (part.toLowerCase() === "gpt") {
      out.push("GPT");
    } else {
      out.push(`${part.charAt(0).toUpperCase()}${part.slice(1)}`);
    }
  }
  return out.join(" ") || id;
}

export function isPremiumWorkerModel(id: string): boolean {
  return id === WORKER_MODEL_ROSTER.claude.premium || /(^|-)fable(-|$)/i.test(id);
}

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku", "sol", "astra", "terra", "luna"];

function versionTuple(id: string): number[] {
  return (id.match(/\d+(?:\.\d+)*/g) ?? [])
    .filter((part) => !/^\d{8}$/.test(part))
    .flatMap((part) => part.split(".").map(Number));
}

/** Newest first: the Codex list's own priority when it has one, then version
 * numbers, then the family's tier, then the id, so refreshes never reshuffle. */
export function compareWorkerModels(
  a: { id: string; priority?: number },
  b: { id: string; priority?: number },
): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const va = versionTuple(a.id);
  const vb = versionTuple(b.id);
  for (let index = 0; index < Math.max(va.length, vb.length); index += 1) {
    const diff = (vb[index] ?? -1) - (va[index] ?? -1);
    if (diff !== 0) return diff;
  }
  const fa = FAMILY_ORDER.findIndex((family) => a.id.includes(family));
  const fb = FAMILY_ORDER.findIndex((family) => b.id.includes(family));
  if (fa !== fb) return (fa < 0 ? FAMILY_ORDER.length : fa) - (fb < 0 ? FAMILY_ORDER.length : fb);
  return a.id.localeCompare(b.id);
}

// ── Merge ───────────────────────────────────────────────────────────────────

export function emptyCatalogState(): WorkerModelCatalogState {
  return { version: STATE_VERSION, baselineAt: null, firstSeen: {}, lastLive: {} };
}

interface Candidate {
  id: string;
  provider: PiSubscriptionProvider;
  sources: Set<WorkerModelSource>;
  vendorLabel?: string;
  pi?: PiCatalogModel;
  discovered?: DiscoveredModel;
  priority?: number;
}

/**
 * Union the sources into one list per provider. Pure: the caller supplies
 * the time and the persisted first-seen state, and gets the next state back.
 */
export function buildWorkerModelCatalog(input: {
  pi: readonly PiCatalogModel[];
  listings: Partial<Record<PiSubscriptionProvider, ProviderListing>>;
  cliHints?: Partial<Record<PiSubscriptionProvider, DiscoveredModel[]>>;
  signedIn: ReadonlySet<PiSubscriptionProvider>;
  enabled: readonly string[];
  state: WorkerModelCatalogState;
  now: number;
}): { catalog: WorkerModelCatalog; state: WorkerModelCatalogState } {
  const nowIso = new Date(input.now).toISOString();
  const candidates = new Map<string, Candidate>();
  const add = (provider: PiSubscriptionProvider, id: string, source: WorkerModelSource, apply: (entry: Candidate) => void) => {
    if (!routableWorkerModel(provider, id)) return;
    let entry = candidates.get(id);
    if (!entry) {
      entry = { id, provider, sources: new Set() };
      candidates.set(id, entry);
    }
    entry.sources.add(source);
    apply(entry);
  };
  for (const model of input.pi) {
    add(model.provider, model.id, "pi", (entry) => {
      entry.pi = model;
    });
  }
  for (const provider of PI_SUBSCRIPTION_PROVIDERS) {
    const listing = input.listings[provider];
    if (listing && listing.listedFrom !== "pi") {
      for (const model of listing.models) {
        add(provider, model.id, listing.listedFrom, (entry) => {
          entry.discovered = { ...entry.discovered, ...model };
          if (model.label) entry.vendorLabel = model.label;
          if (model.priority !== undefined) entry.priority = model.priority;
        });
      }
    }
    for (const model of input.cliHints?.[provider] ?? []) {
      add(provider, model.id, "cli", (entry) => {
        entry.discovered = { ...model, ...entry.discovered };
        if (model.label && !entry.vendorLabel) entry.vendorLabel = model.label;
        if (model.priority !== undefined && entry.priority === undefined) entry.priority = model.priority;
      });
    }
  }
  const enabled = new Set(input.enabled.map((id) => id.trim()).filter(Boolean));
  // An evergreen id and its dated snapshot launch the same model. A dated id
  // the user switched on keeps its own row: merged away, it would come back
  // below with no source and read "No longer listed" while it still runs.
  for (const id of [...candidates.keys()]) {
    const dated = DATED_ID.exec(id);
    if (dated && candidates.has(dated[1]) && !enabled.has(id)) {
      const twin = candidates.get(dated[1])!;
      for (const source of candidates.get(id)!.sources) twin.sources.add(source);
      candidates.delete(id);
    }
  }

  for (const id of enabled) {
    const provider = workerModelSubscription(id);
    if (!provider || candidates.has(id) || !routableWorkerModel(provider, id)) continue;
    candidates.set(id, { id, provider, sources: new Set() });
  }

  const listed = (provider: PiSubscriptionProvider, id: string): boolean => {
    const listing = input.listings[provider];
    if (!listing?.authoritative) return true;
    return listing.models.some((model) => model.id === id || DATED_ID.exec(model.id)?.[1] === id);
  };

  const firstRun = input.state.baselineAt === null;
  const baselineAt = input.state.baselineAt ?? nowIso;
  const baselineMs = Date.parse(baselineAt);
  const firstSeen: Record<string, string> = { ...input.state.firstSeen };
  const models: Array<WorkerCatalogModel & { priority?: number }> = [];
  for (const entry of candidates.values()) {
    if (entry.sources.size > 0 && !firstSeen[entry.id]) firstSeen[entry.id] = firstRun ? baselineAt : nowIso;
    const seenAt = firstSeen[entry.id] ?? nowIso;
    const seenMs = Date.parse(seenAt);
    const unavailable = !input.signedIn.has(entry.provider)
      ? "Not signed in"
      : entry.sources.size === 0
        ? "No longer listed"
        : !listed(entry.provider, entry.id)
          ? "Not in your account's list"
          : null;
    const discoveredLevels = entry.discovered?.thinkingLevels;
    const contextWindow = entry.pi?.contextWindow ?? entry.discovered?.contextWindow;
    models.push({
      id: entry.id,
      label:
        findOptionInCatalog("pi", entry.id, false)?.label ??
        entry.vendorLabel ??
        (entry.pi && entry.pi.label !== entry.id ? entry.pi.label : undefined) ??
        prettyModelLabel(entry.id),
      provider: entry.provider,
      premium: isPremiumWorkerModel(entry.id),
      isNew: entry.sources.size > 0 && seenMs > baselineMs && input.now - seenMs < NEW_WINDOW_MS,
      unavailable,
      sources: (["provider", "cli", "pi"] as const).filter((source) => entry.sources.has(source)),
      reasoning: entry.pi ? entry.pi.reasoning : true,
      ...(contextWindow ? { contextWindow } : {}),
      thinkingLevels: entry.pi?.thinkingLevels ?? discoveredLevels ?? [...DEFAULT_THINKING_LEVELS],
      firstSeenAt: seenAt,
      ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    });
  }
  const providerRank = (provider: PiSubscriptionProvider) => PI_SUBSCRIPTION_PROVIDERS.indexOf(provider);
  models.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || compareWorkerModels(a, b));

  const trimmed = Object.entries(firstSeen)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, MAX_FIRST_SEEN_ENTRIES);
  const providers: WorkerModelProviderState[] = PI_SUBSCRIPTION_PROVIDERS.map((provider) => {
    const listing = input.listings[provider];
    return {
      provider,
      signedIn: input.signedIn.has(provider),
      listedFrom: listing?.listedFrom ?? "pi",
      note: listing?.note ?? null,
      checkedAt: listing?.checkedAt ?? null,
    };
  });
  return {
    catalog: {
      models: models.map(({ priority: _priority, ...model }) => model),
      providers,
      refreshedAt: nowIso,
    },
    state: { ...input.state, version: STATE_VERSION, baselineAt, firstSeen: Object.fromEntries(trimmed) },
  };
}

// ── Fetching ────────────────────────────────────────────────────────────────

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, vendor: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ListError(`${vendor}'s model list could not be reached.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ListError(`${vendor} refused the model list for this sign-in.`);
  }
  if (!response.ok) throw new ListError(`${vendor}'s model list did not load (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new ListError(`${vendor}'s model list was not readable.`);
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function codexClientVersion(fromCliCache: string | null): string {
  if (fromCliCache && /^\d+(\.\d+){1,3}$/.test(fromCliCache) && compareVersions(fromCliCache, CODEX_CLIENT_VERSION_FLOOR) > 0) {
    return fromCliCache;
  }
  return CODEX_CLIENT_VERSION_FLOOR;
}

export async function fetchProviderModels(
  provider: PiSubscriptionProvider,
  access: { access: string; accountId: string | null },
  options: { fetch: typeof fetch; baseUrl?: string; codexClientVersion?: string },
): Promise<DiscoveredModel[]> {
  const base = (options.baseUrl ?? DEFAULT_PROVIDER_BASE_URLS[provider]).replace(/\/+$/, "");
  const vendor = VENDOR[provider];
  if (provider === "anthropic") {
    const models: DiscoveredModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const url = `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const parsed = parseAnthropicModelList(
        await getJson(options.fetch, url, {
          authorization: `Bearer ${access.access}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": CLAUDE_CODE_USER_AGENT,
        }, vendor),
      );
      models.push(...parsed.models);
      if (!parsed.nextAfter) break;
      after = parsed.nextAfter;
    }
    return models;
  }
  if (provider === "openai-codex") {
    if (!access.accountId) throw new ListError("The ChatGPT sign-in carries no account id, so its model list cannot be read.");
    const version = encodeURIComponent(options.codexClientVersion ?? CODEX_CLIENT_VERSION_FLOOR);
    return parseCodexModelList(
      await getJson(options.fetch, `${base}/backend-api/codex/models?client_version=${version}`, {
        authorization: `Bearer ${access.access}`,
        "chatgpt-account-id": access.accountId,
        "user-agent": "codex-cli",
        originator: "codex_cli_rs",
      }, vendor),
    );
  }
  return parseXaiModelList(
    await getJson(options.fetch, `${base}/v1/models`, { authorization: `Bearer ${access.access}` }, vendor),
  );
}

async function readJsonFile(path: string | null): Promise<unknown> {
  if (!path) return null;
  const stat = await fs.stat(path).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_CLI_FILE_BYTES) return null;
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function readCatalogState(path: string): Promise<WorkerModelCatalogState> {
  const raw = await readJsonFile(path);
  if (!isRecord(raw) || raw.version !== STATE_VERSION) return emptyCatalogState();
  const firstSeen: Record<string, string> = {};
  if (isRecord(raw.firstSeen)) {
    for (const [id, at] of Object.entries(raw.firstSeen)) {
      if (typeof at === "string" && !Number.isNaN(Date.parse(at))) firstSeen[id] = at;
    }
  }
  const lastLive: WorkerModelCatalogState["lastLive"] = {};
  if (isRecord(raw.lastLive)) {
    for (const provider of PI_SUBSCRIPTION_PROVIDERS) {
      const entry = raw.lastLive[provider];
      if (!isRecord(entry) || typeof entry.checkedAt !== "string" || !Array.isArray(entry.models)) continue;
      const models = entry.models
        .filter(isRecord)
        .map((model) => ({ ...model, id: text(model.id) }) as DiscoveredModel)
        .filter((model) => Boolean(model.id));
      lastLive[provider] = { checkedAt: entry.checkedAt, models };
    }
  }
  const baselineAt = typeof raw.baselineAt === "string" && !Number.isNaN(Date.parse(raw.baselineAt)) ? raw.baselineAt : null;
  return { version: STATE_VERSION, baselineAt, firstSeen, lastLive };
}

async function writeCatalogState(path: string, state: WorkerModelCatalogState): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, path);
}

// ── The catalog ─────────────────────────────────────────────────────────────

export interface WorkerModelCatalogReader {
  read(force?: boolean): Promise<WorkerModelCatalog>;
  invalidate(): void;
}

export function createWorkerModelCatalog(deps: WorkerModelCatalogDeps): WorkerModelCatalogReader {
  let cached: { at: number; catalog: WorkerModelCatalog } | null = null;
  let inflight: Promise<WorkerModelCatalog> | null = null;

  async function listingFor(
    provider: PiSubscriptionProvider,
    signedIn: boolean,
    state: WorkerModelCatalogState,
    codexCli: ReturnType<typeof parseCodexCliCache> | null,
  ): Promise<ProviderListing> {
    const nowIso = new Date(deps.now()).toISOString();
    const fallback = (note: string | null): ProviderListing => {
      const last = state.lastLive[provider];
      if (last) {
        return { listedFrom: "provider", models: last.models, authoritative: false, note, checkedAt: last.checkedAt };
      }
      if (provider === "openai-codex" && codexCli && codexCli.models.length > 0) {
        return { listedFrom: "cli", models: codexCli.models, authoritative: false, note, checkedAt: codexCli.fetchedAt };
      }
      return { listedFrom: "pi", models: [], authoritative: false, note, checkedAt: null };
    };
    if (!signedIn) return fallback(null);
    const access = await deps.readAccess(provider).catch(() => null);
    if (access === null) return fallback(null);
    if (access === "expired") {
      return fallback("The sign-in needs a refresh, which happens at the next launch; showing the last known list.");
    }
    try {
      const models = await fetchProviderModels(provider, access, {
        fetch: deps.fetch,
        baseUrl: deps.baseUrls?.[provider],
        codexClientVersion: codexClientVersion(codexCli?.clientVersion ?? null),
      });
      state.lastLive[provider] = { checkedAt: nowIso, models };
      return { listedFrom: "provider", models, authoritative: true, note: null, checkedAt: nowIso };
    } catch (err) {
      return fallback(err instanceof ListError ? err.message : `${VENDOR[provider]}'s model list did not load.`);
    }
  }

  async function build(force: boolean): Promise<WorkerModelCatalog> {
    const [pi, signedIn, enabled, state, codexRaw, claudeRaw] = await Promise.all([
      deps.piCatalog(force).catch(() => [] as PiCatalogModel[]),
      deps.signedInProviders().catch(() => new Set<PiSubscriptionProvider>()),
      deps.enabledModels().catch(() => [] as string[]),
      readCatalogState(deps.statePath),
      readJsonFile(deps.codexCliCachePath()),
      readJsonFile(deps.claudeCliConfigPath()),
    ]);
    let codexCli: ReturnType<typeof parseCodexCliCache> | null = null;
    try {
      codexCli = codexRaw ? parseCodexCliCache(codexRaw) : null;
    } catch {
      codexCli = null;
    }
    const listingsArray = await Promise.all(
      PI_SUBSCRIPTION_PROVIDERS.map((provider) => listingFor(provider, signedIn.has(provider), state, codexCli)),
    );
    const listings = Object.fromEntries(
      PI_SUBSCRIPTION_PROVIDERS.map((provider, index) => [provider, listingsArray[index]]),
    ) as Record<PiSubscriptionProvider, ProviderListing>;
    const cliHints: Partial<Record<PiSubscriptionProvider, DiscoveredModel[]>> = {
      anthropic: parseClaudeCodeModelOptions(claudeRaw),
      ...(codexCli && listings["openai-codex"].listedFrom !== "cli" ? { "openai-codex": codexCli.models } : {}),
    };
    const result = buildWorkerModelCatalog({ pi, listings, cliHints, signedIn, enabled, state, now: deps.now() });
    await writeCatalogState(deps.statePath, { ...result.state, lastLive: state.lastLive }).catch(() => undefined);
    return result.catalog;
  }

  function refresh(force: boolean): Promise<WorkerModelCatalog> {
    if (inflight && !force) return inflight;
    let work: Promise<WorkerModelCatalog> | null = null;
    work = build(force).then((catalog) => {
      if (inflight === work) cached = { at: deps.now(), catalog };
      return catalog;
    });
    inflight = work;
    void work.finally(() => {
      if (inflight === work) inflight = null;
    }).catch(() => undefined);
    return work;
  }

  return {
    read(force = false) {
      if (force || !cached) return refresh(force);
      // A stale list is served at once and replaced in the background: the
      // pickers must not wait on three provider round trips to open.
      if (deps.now() - cached.at >= CACHE_TTL_MS) void refresh(false).catch(() => undefined);
      return Promise.resolve(cached.catalog);
    },
    invalidate() {
      cached = null;
    },
  };
}

// ── Production wiring ───────────────────────────────────────────────────────

async function readStoredAccess(provider: PiSubscriptionProvider): Promise<ProviderAccess | null> {
  const { resolvePiAccountRuntimeProfile } = await import("./pi-account-auth-store");
  const selected = await resolvePiAccountRuntimeProfile({ provider }).catch(() => null);
  if (!selected) return null;
  const stat = await fs.stat(selected.authFile).catch(() => null);
  if (!stat) return null;
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(selected.authFile, "utf8"));
  } catch {
    return null;
  }
  const record = isRecord(parsed) ? parsed[provider] : null;
  if (!isRecord(record) || record.type !== "oauth") return null;
  const access = text(record.access);
  if (!access) return null;
  const expires = typeof record.expires === "number" ? record.expires : null;
  if (expires !== null && expires <= Date.now() + 60_000) return "expired";
  return { access, accountId: text(record.accountId) ?? text(record.account_id) ?? accountIdFromJwt(access) };
}

function accountIdFromJwt(access: string): string | null {
  const segments = access.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!isRecord(payload)) return null;
    const direct = text(payload.chatgpt_account_id);
    if (direct) return direct;
    for (const value of Object.values(payload)) {
      if (isRecord(value) && text(value.chatgpt_account_id)) return text(value.chatgpt_account_id);
    }
    return null;
  } catch {
    return null;
  }
}

let production: WorkerModelCatalogReader | null = null;

function productionCatalog(): WorkerModelCatalogReader {
  production ??= createWorkerModelCatalog({
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    statePath: join(codaraHomeDir(), "worker-model-catalog.json"),
    piCatalog: async (force) => {
      const piModels = await import("./pi-model-catalog");
      piModels.onPiModelCatalogInvalidated(invalidateWorkerModelCatalog);
      return piModels.inspectPiModelCatalog(force);
    },
    signedInProviders: async () => {
      const [{ inspectPiAccountProfileAuthStore }, { usablePiProviders }] = await Promise.all([
        import("./pi-account-auth-store"),
        import("./pi-worker-providers"),
      ]);
      return usablePiProviders((await inspectPiAccountProfileAuthStore()).statuses);
    },
    readAccess: readStoredAccess,
    enabledModels: async () => {
      const [{ loadSettings }, { availableCoraWorkerModels }] = await Promise.all([
        import("../storage"),
        import("../openrouter-config"),
      ]);
      return availableCoraWorkerModels(await loadSettings());
    },
    codexCliCachePath: () => join(defaultPersonalCodexHomeDir(), "models_cache.json"),
    claudeCliConfigPath: () => claudeUserConfigFile(),
  });
  return production;
}

export function inspectWorkerModelCatalog(force = false): Promise<WorkerModelCatalog> {
  return productionCatalog().read(force);
}

export function invalidateWorkerModelCatalog(): void {
  production?.invalidate();
}

/**
 * The same catalog in the shape the chat and manager pickers read, so a model
 * a provider lists for the account is pickable for Cora too. Models known only
 * because they are enabled are left out: they have nothing to describe.
 */
export async function inspectUnifiedPiModelCatalog(force = false): Promise<PiCatalogModel[]> {
  try {
    const catalog = await inspectWorkerModelCatalog(force);
    return catalog.models
      .filter((model) => model.sources.length > 0)
      .map((model) => ({
        id: model.id,
        label: model.label,
        provider: model.provider,
        reasoning: model.reasoning,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        thinkingLevels: model.thinkingLevels,
      }));
  } catch {
    const { inspectPiModelCatalog } = await import("./pi-model-catalog");
    return inspectPiModelCatalog(force);
  }
}

let backgroundTimer: NodeJS.Timeout | null = null;

/** Re-read the lists every few hours so a model released while Codara runs
 * shows up (switched off, marked New) without anyone pressing Refresh. */
export function startWorkerModelCatalogRefresh(): void {
  if (backgroundTimer) return;
  const run = () => {
    void inspectWorkerModelCatalog(true).catch(() => undefined);
  };
  const first = setTimeout(() => {
    run();
    backgroundTimer = setInterval(run, BACKGROUND_INTERVAL_MS);
    backgroundTimer.unref?.();
  }, BACKGROUND_FIRST_DELAY_MS);
  first.unref?.();
  backgroundTimer = first;
}

export function stopWorkerModelCatalogRefresh(): void {
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
}
