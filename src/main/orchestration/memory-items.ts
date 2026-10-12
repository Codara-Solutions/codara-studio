import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../fs-atomic";
import { coraProfileRoot, DEFAULT_CORA_PROFILE_ID, normalizeCoraProfileId } from "./cora-profiles";
import {
  containsSecret,
  isCoreMemoryItem,
  MEMORY_DUPLICATE_SIMILARITY,
  MEMORY_ITEM_MAX_CHARS,
  memoriesContradict,
  memoryItemLabel,
  memoryLastTouched,
  memorySimilarity,
  rankMemoryItems,
  type CoraMemoryItem,
  type MemoryDigestEntry,
  type MemoryItemEvidence,
  type MemoryItemKind,
  type MemoryItemPatch,
  type MemoryItemScope,
  type MemoryItemSource,
  type MemoryItemStatus,
} from "@shared/memory-items";

// The learned-item store of Cora memory v3: one JSON file per profile at
// <profile root>/learned/items.json, beside the markdown tiers.
//
// The markdown files remain the always-injected core the user owns. Items are
// what Cora learns by itself, so every write here goes through applyLearned,
// which does what the model used to be trusted with: drop secrets, merge a
// reworded duplicate into the existing item, let a newer statement supersede
// the one it contradicts, and keep the user's deletions from being re-learned.
//
// Imports only fs helpers, cora-profiles and the shared pure helpers, never
// cora-memory or run-store: cora-memory reads this module for injection, and
// memory-learning.ts drives the writes.

const STORE_VERSION = 1;
/** Non-archived items per profile. Past it the weakest inferred items go first. */
const MAX_LIVE_ITEMS = 400;
const MAX_ARCHIVED_ITEMS = 200;
const ARCHIVE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_PER_ITEM = 4;
const MAX_QUOTE_CHARS = 300;
const MAX_SCANNED_RUNS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Prompt budget (characters) for the always-on part of the learned block. */
export const LEARNED_CORE_BUDGET_CHARS = 1500;
/** Prompt budget (characters) for the per-turn relevant part. */
export const LEARNED_RELEVANT_BUDGET_CHARS = 1200;
const LEARNED_MAX_ITEMS = 14;

interface Tombstone {
  text: string;
  scope: MemoryItemScope;
  workspaceId?: string;
  at: string;
}

interface ScanCursor {
  messageId: string;
  at: string;
}

interface ReflectionMark {
  at: string;
  messageId?: string;
}

interface ItemStore {
  version: number;
  items: CoraMemoryItem[];
  /** What the user deleted, so automatic learning does not bring it back. */
  tombstones: Tombstone[];
  /** Per run: the newest user message already scanned for signals. */
  scanned: Record<string, ScanCursor>;
  /** Per run: when its chat was last reviewed by a model. */
  reflected: Record<string, ReflectionMark>;
  /** Day stamp and count of model reviews, for the daily cap. */
  reflectionBudget?: { day: string; count: number };
  lastConsolidatedAt?: string;
}

export interface LearnedCandidate {
  scope: MemoryItemScope;
  workspaceId?: string;
  kind: MemoryItemKind;
  text: string;
  source: MemoryItemSource;
  confidence: number;
  status?: Exclude<MemoryItemStatus, "archived">;
  evidence?: Omit<MemoryItemEvidence, "at"> & { at?: string };
}

export type LearnedAction = "added" | "confirmed" | "superseded" | "skipped";

export interface LearnedOutcome {
  action: LearnedAction;
  item?: CoraMemoryItem;
  superseded?: CoraMemoryItem[];
  reason?: string;
}

function itemsPath(profileId: string): string {
  return join(coraProfileRoot(profileId), "learned", "items.json");
}

function emptyStore(): ItemStore {
  return {
    version: STORE_VERSION,
    items: [],
    tombstones: [],
    scanned: Object.create(null) as Record<string, ScanCursor>,
    reflected: Object.create(null) as Record<string, ReflectionMark>,
  };
}

function coerceRecord<T>(value: unknown): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object") out[key] = entry as T;
  }
  return out;
}

function validItem(value: unknown): value is CoraMemoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CoraMemoryItem>;
  return typeof item.id === "string" &&
    typeof item.text === "string" &&
    (item.scope === "global" || item.scope === "workspace") &&
    (item.status === "active" || item.status === "proposed" || item.status === "archived");
}

function readStore(profileId: string): ItemStore {
  const path = itemsPath(profileId);
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ItemStore>;
    const store = emptyStore();
    store.items = Array.isArray(raw.items)
      ? raw.items.filter(validItem).map((item) => ({
          ...item,
          evidence: Array.isArray(item.evidence) ? item.evidence : [],
          useCount: typeof item.useCount === "number" ? item.useCount : 0,
          confirmations: typeof item.confirmations === "number" ? item.confirmations : 1,
          confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
        }))
      : [];
    store.tombstones = Array.isArray(raw.tombstones)
      ? raw.tombstones.filter((entry): entry is Tombstone => Boolean(entry) && typeof entry.text === "string")
      : [];
    store.scanned = coerceRecord<ScanCursor>(raw.scanned);
    store.reflected = coerceRecord<ReflectionMark>(raw.reflected);
    if (raw.reflectionBudget && typeof raw.reflectionBudget.day === "string") {
      store.reflectionBudget = { day: raw.reflectionBudget.day, count: Number(raw.reflectionBudget.count) || 0 };
    }
    if (typeof raw.lastConsolidatedAt === "string") store.lastConsolidatedAt = raw.lastConsolidatedAt;
    return store;
  } catch {
    // A corrupt store must not cost a turn. It is left on disk untouched
    // until the next write replaces it, so nothing is silently truncated
    // by a read.
    return emptyStore();
  }
}

// Same serialization shape as cora-memory's withPathLock: every
// read-modify-write of one profile's store waits for the previous one.
const storeQueues = new Map<string, Promise<void>>();

function withStoreLock<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
  const key = itemsPath(profileId);
  const prev = storeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  storeQueues.set(key, tail);
  void tail.then(() => {
    if (storeQueues.get(key) === tail) storeQueues.delete(key);
  });
  return run;
}

async function writeStore(profileId: string, store: ItemStore): Promise<void> {
  const path = itemsPath(profileId);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(store)}\n`);
}

type ChangeListener = (profileId: string) => void;
const changeListeners = new Set<ChangeListener>();

/** Notified after every write that changed what a profile's items are. */
export function onMemoryItemsChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChanged(profileId: string): void {
  for (const listener of changeListeners) {
    try {
      listener(profileId);
    } catch {
      // A broken listener must not fail the write that already landed.
    }
  }
}

/** Read-modify-write under the profile's lock. `mutate` returns whether items changed. */
async function mutateStore<T>(
  profileId: string,
  mutate: (store: ItemStore, now: number) => { result: T; changed: boolean; itemsChanged?: boolean },
): Promise<T> {
  const id = normalizeCoraProfileId(profileId);
  return withStoreLock(id, async () => {
    const store = readStore(id);
    const { result, changed, itemsChanged } = mutate(store, Date.now());
    if (changed) {
      await writeStore(id, store);
      if (itemsChanged !== false) emitChanged(id);
    }
    return result;
  });
}

function newItemId(): string {
  return `m_${randomBytes(5).toString("hex")}`;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function sameScope(item: CoraMemoryItem, scope: MemoryItemScope, workspaceId?: string): boolean {
  if (item.scope !== scope) return false;
  return scope === "global" || item.workspaceId === workspaceId;
}

// User-stated sources outrank inferred ones when two say the same thing, so a
// later reflection cannot overwrite the user's own wording with a paraphrase
// and an inferred lesson cannot supersede what the user said.
const SOURCE_TRUST: Record<MemoryItemSource, number> = {
  manual: 5,
  user: 4,
  correction: 3,
  reflection: 2,
  ledger: 1,
  worker: 1,
};

const USER_ORIGIN = new Set<MemoryItemSource>(["user", "correction", "manual"]);

/**
 * Whether a newer item may retire an older one it contradicts. The user's
 * newest statement wins over anything not pinned; an inference (a review, a
 * worker lesson) may only retire another inference, never the user's words.
 */
function mayRetire(newer: { source: MemoryItemSource }, older: CoraMemoryItem): boolean {
  if (older.pinned) return false;
  if (USER_ORIGIN.has(newer.source)) return true;
  return !USER_ORIGIN.has(older.source) && SOURCE_TRUST[newer.source] >= SOURCE_TRUST[older.source];
}

function addEvidence(item: CoraMemoryItem, evidence: MemoryItemEvidence | undefined): void {
  if (!evidence) return;
  if (evidence.messageId && item.evidence.some((entry) => entry.messageId === evidence.messageId)) return;
  item.evidence.push(evidence);
  if (item.evidence.length > MAX_EVIDENCE_PER_ITEM) {
    item.evidence.splice(0, item.evidence.length - MAX_EVIDENCE_PER_ITEM);
  }
}

function enforceCaps(store: ItemStore, now: number): void {
  store.items = store.items.filter((item) => {
    if (item.status !== "archived") return true;
    const archivedAt = Date.parse(item.archivedAt ?? item.updatedAt);
    return !Number.isFinite(archivedAt) || now - archivedAt <= ARCHIVE_RETENTION_MS;
  });
  const archived = store.items.filter((item) => item.status === "archived");
  if (archived.length > MAX_ARCHIVED_ITEMS) {
    const drop = new Set(
      archived
        .sort((a, b) => Date.parse(a.archivedAt ?? a.updatedAt) - Date.parse(b.archivedAt ?? b.updatedAt))
        .slice(0, archived.length - MAX_ARCHIVED_ITEMS)
        .map((item) => item.id),
    );
    store.items = store.items.filter((item) => !drop.has(item.id));
  }
  const live = store.items.filter((item) => item.status !== "archived");
  if (live.length > MAX_LIVE_ITEMS) {
    const evictable = live
      .filter((item) => !item.pinned && item.source !== "manual")
      .sort((a, b) => (a.confidence - b.confidence) || (memoryLastTouched(a) - memoryLastTouched(b)));
    for (const item of evictable.slice(0, live.length - MAX_LIVE_ITEMS)) {
      archive(item, "stale", now);
    }
  }
  store.tombstones = store.tombstones.filter((entry) => {
    const at = Date.parse(entry.at);
    return !Number.isFinite(at) || now - at <= TOMBSTONE_RETENTION_MS;
  });
  const runs = Object.entries(store.scanned);
  if (runs.length > MAX_SCANNED_RUNS) {
    runs.sort((a, b) => a[1].at.localeCompare(b[1].at));
    for (const [runId] of runs.slice(0, runs.length - MAX_SCANNED_RUNS)) delete store.scanned[runId];
  }
  const reflected = Object.entries(store.reflected);
  if (reflected.length > MAX_SCANNED_RUNS) {
    reflected.sort((a, b) => a[1].at.localeCompare(b[1].at));
    for (const [runId] of reflected.slice(0, reflected.length - MAX_SCANNED_RUNS)) delete store.reflected[runId];
  }
}

function archive(item: CoraMemoryItem, reason: CoraMemoryItem["archivedReason"], now: number): void {
  item.status = "archived";
  item.archivedReason = reason;
  item.archivedAt = new Date(now).toISOString();
  item.updatedAt = item.archivedAt;
}

/**
 * The mem0-style write decision for one candidate, applied in place:
 *  - a secret, an empty or an overlong text is skipped;
 *  - something the user deleted is not re-learned automatically;
 *  - a near-duplicate of a live item confirms it (and may promote a
 *    suggestion to active once it has been seen twice);
 *  - a candidate that contradicts a live item supersedes it when the
 *    candidate is at least as trusted, otherwise it waits as a suggestion;
 *  - anything else is added.
 */
function applyCandidate(store: ItemStore, candidate: LearnedCandidate, now: number): LearnedOutcome {
  const text = cleanText(candidate.text);
  if (!text) return { action: "skipped", reason: "empty" };
  if (text.length > MEMORY_ITEM_MAX_CHARS) return { action: "skipped", reason: "too long" };
  if (containsSecret(text) || (candidate.evidence?.quote && containsSecret(candidate.evidence.quote))) {
    return { action: "skipped", reason: "looks like a secret" };
  }
  if (candidate.scope === "workspace" && !candidate.workspaceId) {
    return { action: "skipped", reason: "workspace scope needs a workspace" };
  }
  const nowIso = new Date(now).toISOString();
  const evidence: MemoryItemEvidence | undefined = candidate.evidence
    ? {
        ...(candidate.evidence.runId ? { runId: candidate.evidence.runId } : {}),
        ...(candidate.evidence.messageId ? { messageId: candidate.evidence.messageId } : {}),
        ...(candidate.evidence.quote ? { quote: cleanText(candidate.evidence.quote).slice(0, MAX_QUOTE_CHARS) } : {}),
        at: candidate.evidence.at ?? nowIso,
      }
    : undefined;
  const automatic = candidate.source !== "manual";
  if (automatic && store.tombstones.some((entry) =>
    entry.scope === candidate.scope &&
    (candidate.scope === "global" || entry.workspaceId === candidate.workspaceId) &&
    memorySimilarity(entry.text, text) >= MEMORY_DUPLICATE_SIMILARITY)) {
    return { action: "skipped", reason: "the user deleted this before" };
  }
  const confidence = clampConfidence(candidate.confidence);
  const status = candidate.status ?? "active";
  const live = store.items.filter((item) =>
    item.status !== "archived" && sameScope(item, candidate.scope, candidate.workspaceId));

  let duplicate: CoraMemoryItem | undefined;
  let bestSimilarity = 0;
  for (const item of live) {
    const similarity = memorySimilarity(item.text, text);
    if (similarity >= MEMORY_DUPLICATE_SIMILARITY && similarity > bestSimilarity &&
        !memoriesContradict(item.text, text)) {
      duplicate = item;
      bestSimilarity = similarity;
    }
  }
  if (duplicate) {
    duplicate.confirmations += 1;
    duplicate.lastConfirmedAt = nowIso;
    duplicate.updatedAt = nowIso;
    // Hearing it again from the user is strong evidence it is durable: a
    // correction repeated once becomes always-on (isCoreMemoryItem).
    duplicate.confidence = clampConfidence(
      Math.max(duplicate.confidence, confidence) + (USER_ORIGIN.has(candidate.source) ? 0.15 : 0.1),
    );
    if (SOURCE_TRUST[candidate.source] > SOURCE_TRUST[duplicate.source]) {
      duplicate.source = candidate.source;
      duplicate.text = text;
      duplicate.kind = candidate.kind;
    }
    // Only evidence that may itself be active promotes a suggestion: a tool
    // or worker claim repeated twice is still only a tool claim.
    if (duplicate.status === "proposed" && status === "active") {
      duplicate.status = "active";
    }
    addEvidence(duplicate, evidence);
    return { action: "confirmed", item: duplicate };
  }

  const contradicted = live.filter((item) => memoriesContradict(item.text, text));
  const item: CoraMemoryItem = {
    id: newItemId(),
    scope: candidate.scope,
    ...(candidate.scope === "workspace" ? { workspaceId: candidate.workspaceId } : {}),
    kind: candidate.kind,
    text,
    source: candidate.source,
    status,
    confidence,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastConfirmedAt: nowIso,
    useCount: 0,
    confirmations: 1,
    evidence: evidence ? [evidence] : [],
  };
  if (contradicted.length > 0) {
    const winner = contradicted.every((old) => mayRetire(candidate, old));
    if (winner && status === "active") {
      item.supersedes = contradicted.map((old) => old.id);
      for (const old of contradicted) {
        archive(old, "superseded", now);
        old.supersededBy = item.id;
      }
      store.items.push(item);
      return { action: "superseded", item, superseded: contradicted };
    }
    // The newer claim is weaker than what it contradicts (an inference against
    // the user's own words, or anything against a pinned item): it waits for
    // the user's call instead of silently flipping behavior.
    item.status = "proposed";
    item.confidence = Math.min(item.confidence, 0.5);
  }
  store.items.push(item);
  return { action: "added", item };
}

/** Apply learned candidates for one profile in one locked write. */
export async function applyLearned(
  profileId: string,
  candidates: LearnedCandidate[],
): Promise<LearnedOutcome[]> {
  if (candidates.length === 0) return [];
  return mutateStore(profileId, (store, now) => {
    const outcomes = candidates.map((candidate) => applyCandidate(store, candidate, now));
    const changed = outcomes.some((outcome) => outcome.action !== "skipped");
    if (changed) enforceCaps(store, now);
    return { result: outcomes, changed };
  });
}

export interface MemoryItemFilter {
  /** Workspace items of other workspaces are left out when set. */
  workspaceId?: string | null;
  includeArchived?: boolean;
}

export function listMemoryItems(profileId: string, filter: MemoryItemFilter = {}): CoraMemoryItem[] {
  const store = readStore(normalizeCoraProfileId(profileId));
  return store.items.filter((item) => {
    if (!filter.includeArchived && item.status === "archived") return false;
    if (filter.workspaceId !== undefined && item.scope === "workspace") {
      return filter.workspaceId !== null && item.workspaceId === filter.workspaceId;
    }
    return true;
  });
}

export function getMemoryItem(profileId: string, id: string): CoraMemoryItem | null {
  return readStore(normalizeCoraProfileId(profileId)).items.find((item) => item.id === id) ?? null;
}

/** A user edit from the Memory page or the chat chip. */
export async function updateMemoryItem(
  profileId: string,
  id: string,
  patch: MemoryItemPatch,
  workspaceId?: string | null,
): Promise<CoraMemoryItem> {
  return mutateStore(profileId, (store, now) => {
    const item = store.items.find((entry) => entry.id === id);
    if (!item) throw new Error("That memory no longer exists.");
    const nowIso = new Date(now).toISOString();
    if (patch.text !== undefined) {
      const text = cleanText(patch.text);
      if (!text) throw new Error("A memory needs some text.");
      if (text.length > MEMORY_ITEM_MAX_CHARS) {
        throw new Error(`A memory is at most ${MEMORY_ITEM_MAX_CHARS} characters.`);
      }
      if (containsSecret(text)) throw new Error("That looks like a password or key. Memory never stores secrets.");
      item.text = text;
      // The user wrote these words now, so they are the user's.
      item.source = "manual";
      item.confidence = Math.max(item.confidence, 0.9);
    }
    if (patch.kind !== undefined) item.kind = patch.kind;
    if (patch.scope !== undefined && patch.scope !== item.scope) {
      if (patch.scope === "workspace") {
        const target = workspaceId ?? item.workspaceId;
        if (!target) throw new Error("Open a workspace to move this memory there.");
        item.workspaceId = target;
      } else {
        delete item.workspaceId;
      }
      item.scope = patch.scope;
    }
    if (patch.pinned !== undefined) item.pinned = patch.pinned;
    if (patch.status === "active") {
      item.status = "active";
      delete item.archivedReason;
      delete item.archivedAt;
      // Approval is the user vouching for it.
      item.confidence = Math.max(item.confidence, 0.8);
    } else if (patch.status === "archived") {
      archive(item, "dismissed", now);
      store.tombstones.push({
        text: item.text,
        scope: item.scope,
        ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
        at: nowIso,
      });
    }
    if (patch.feedback === 1) item.helpful = (item.helpful ?? 0) + 1;
    if (patch.feedback === -1) item.harmful = (item.harmful ?? 0) + 1;
    item.updatedAt = nowIso;
    return { result: { ...item }, changed: true };
  });
}

/** Hard delete. The text stays as a tombstone so learning does not bring it back. */
export async function deleteMemoryItem(profileId: string, id: string): Promise<void> {
  await mutateStore(profileId, (store, now) => {
    const item = store.items.find((entry) => entry.id === id);
    if (!item) return { result: undefined, changed: false };
    store.items = store.items.filter((entry) => entry.id !== id);
    store.tombstones.push({
      text: item.text,
      scope: item.scope,
      ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
      at: new Date(now).toISOString(),
    });
    // Undoing a supersede brings back what the deleted item replaced.
    for (const supersededId of item.supersedes ?? []) {
      const old = store.items.find((entry) => entry.id === supersededId);
      if (old && old.status === "archived" && old.supersededBy === item.id) {
        old.status = "active";
        delete old.archivedReason;
        delete old.archivedAt;
        delete old.supersededBy;
        old.updatedAt = new Date(now).toISOString();
      }
    }
    return { result: undefined, changed: true };
  });
}

/**
 * Rewrite an item in place, keeping its id, and file the old wording as an
 * archived version so the Memory page can show what changed. Used by the
 * review when the user's newer words refine an existing memory.
 */
export async function reviseMemoryItem(
  profileId: string,
  id: string,
  text: string,
  evidence?: Omit<MemoryItemEvidence, "at">,
): Promise<LearnedOutcome> {
  return mutateStore<LearnedOutcome>(profileId, (store, now) => {
    const item = store.items.find((entry) => entry.id === id && entry.status !== "archived");
    const clean = cleanText(text);
    if (!item || !clean || clean.length > MEMORY_ITEM_MAX_CHARS || containsSecret(clean)) {
      return { result: { action: "skipped", reason: "not revisable" }, changed: false };
    }
    if (item.text === clean) return { result: { action: "skipped", reason: "unchanged" }, changed: false };
    const nowIso = new Date(now).toISOString();
    const previous: CoraMemoryItem = {
      ...item,
      id: newItemId(),
      evidence: [...item.evidence],
      supersededBy: item.id,
    };
    archive(previous, "superseded", now);
    store.items.push(previous);
    item.text = clean;
    item.updatedAt = nowIso;
    item.lastConfirmedAt = nowIso;
    item.confidence = clampConfidence(Math.max(item.confidence, 0.75));
    item.supersedes = [...new Set([...(item.supersedes ?? []), previous.id])];
    addEvidence(item, evidence ? { ...evidence, at: nowIso } : undefined);
    enforceCaps(store, now);
    return { result: { action: "superseded", item: { ...item }, superseded: [previous] }, changed: true };
  });
}

/** Retire an item without a tombstone (the review decided it no longer holds). */
export async function archiveMemoryItem(
  profileId: string,
  id: string,
  reason: CoraMemoryItem["archivedReason"],
): Promise<CoraMemoryItem | null> {
  return mutateStore(profileId, (store, now) => {
    const item = store.items.find((entry) => entry.id === id && entry.status !== "archived");
    if (!item || item.pinned) return { result: null, changed: false };
    archive(item, reason, now);
    return { result: { ...item }, changed: true };
  });
}

/** Add an item the user typed on the Memory page. */
export async function addManualMemoryItem(
  profileId: string,
  input: { scope: MemoryItemScope; workspaceId?: string | null; kind: MemoryItemKind; text: string },
): Promise<LearnedOutcome> {
  const [outcome] = await applyLearned(profileId, [{
    scope: input.scope,
    ...(input.scope === "workspace" && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    kind: input.kind,
    text: input.text,
    source: "manual",
    confidence: 0.95,
  }]);
  if (outcome.action === "skipped") throw new Error(`Not saved: ${outcome.reason ?? "invalid memory"}.`);
  return outcome;
}

/** Remove everything Cora learned for a profile, optionally only one scope. */
export async function clearMemoryItems(
  profileId: string,
  filter: { scope?: MemoryItemScope; workspaceId?: string | null } = {},
): Promise<number> {
  return mutateStore(profileId, (store) => {
    const before = store.items.length;
    store.items = store.items.filter((item) => {
      if (filter.scope && item.scope !== filter.scope) return true;
      if (filter.scope === "workspace" && filter.workspaceId && item.workspaceId !== filter.workspaceId) return true;
      return false;
    });
    const removed = before - store.items.length;
    return { result: removed, changed: removed > 0 };
  });
}

/**
 * A chat was deleted: its quotes leave every item that cited it, and
 * suggestions that rested only on it go away. Active items stay, because
 * they are the user's stated preferences, not the chat's contents.
 */
export async function forgetRunEvidence(profileId: string, runId: string): Promise<void> {
  await mutateStore(profileId, (store) => {
    let changed = false;
    store.items = store.items.filter((item) => {
      const cited = item.evidence.some((entry) => entry.runId === runId);
      if (!cited) return true;
      changed = true;
      item.evidence = item.evidence.filter((entry) => entry.runId !== runId);
      return !(item.status === "proposed" && item.evidence.length === 0);
    });
    if (store.scanned[runId]) {
      delete store.scanned[runId];
      changed = true;
    }
    if (store.reflected[runId]) {
      delete store.reflected[runId];
      changed = true;
    }
    return { result: undefined, changed };
  });
}

// ── scan cursor and reflection bookkeeping (memory-learning.ts) ────────────

export function readScanCursor(profileId: string, runId: string): ScanCursor | null {
  return readStore(normalizeCoraProfileId(profileId)).scanned[runId] ?? null;
}

export async function writeScanCursor(profileId: string, runId: string, cursor: ScanCursor): Promise<void> {
  await mutateStore(profileId, (store) => {
    store.scanned[runId] = cursor;
    return { result: undefined, changed: true, itemsChanged: false };
  });
}

export function readReflectionMark(profileId: string, runId: string): ReflectionMark | null {
  return readStore(normalizeCoraProfileId(profileId)).reflected[runId] ?? null;
}

/**
 * Claim one model review for a run if the daily budget allows it. Returns
 * false (and records nothing) when the day's budget is spent.
 */
export async function claimReflection(
  profileId: string,
  runId: string,
  mark: ReflectionMark,
  dailyLimit: number,
): Promise<boolean> {
  return mutateStore(profileId, (store) => {
    const day = mark.at.slice(0, 10);
    const budget = store.reflectionBudget?.day === day ? store.reflectionBudget : { day, count: 0 };
    if (budget.count >= dailyLimit) return { result: false, changed: false };
    store.reflectionBudget = { day, count: budget.count + 1 };
    store.reflected[runId] = mark;
    return { result: true, changed: true, itemsChanged: false };
  });
}

export function readLastConsolidatedAt(profileId: string): string | null {
  return readStore(normalizeCoraProfileId(profileId)).lastConsolidatedAt ?? null;
}

// ── use tracking ────────────────────────────────────────────────────────────

const pendingUse = new Map<string, Map<string, string>>();
let useFlushTimer: NodeJS.Timeout | null = null;
const USE_FLUSH_DELAY_MS = 5_000;

/**
 * Record that items reached a prompt. Batched: a long chat injects on every
 * turn, and one store write per turn per item would be pure churn.
 */
export function markMemoryItemsUsed(profileId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const id = normalizeCoraProfileId(profileId);
  const pending = pendingUse.get(id) ?? new Map<string, string>();
  const at = new Date().toISOString();
  for (const itemId of ids) pending.set(itemId, at);
  pendingUse.set(id, pending);
  if (!useFlushTimer) {
    useFlushTimer = setTimeout(() => {
      useFlushTimer = null;
      void flushMemoryItemUse();
    }, USE_FLUSH_DELAY_MS);
    useFlushTimer.unref?.();
  }
}

export async function flushMemoryItemUse(): Promise<void> {
  if (useFlushTimer) {
    clearTimeout(useFlushTimer);
    useFlushTimer = null;
  }
  const batches = [...pendingUse.entries()];
  pendingUse.clear();
  for (const [profileId, uses] of batches) {
    await mutateStore(profileId, (store) => {
      let changed = false;
      for (const item of store.items) {
        const at = uses.get(item.id);
        if (!at) continue;
        item.useCount += 1;
        item.lastUsedAt = at;
        changed = true;
      }
      return { result: undefined, changed, itemsChanged: false };
    }).catch(() => undefined);
  }
}

// ── retrieval ───────────────────────────────────────────────────────────────

export interface LearnedSelection {
  core: CoraMemoryItem[];
  relevant: CoraMemoryItem[];
}

export interface LearnedSelectionInput {
  profileId: string;
  workspaceId: string;
  query: string;
  includeGlobal: boolean;
  includeWorkspace: boolean;
  /** Markdown core lines already in the prompt; items repeating them are dropped. */
  coreText?: string;
  now?: number;
  coreBudgetChars?: number;
  relevantBudgetChars?: number;
}

function renderedLength(item: CoraMemoryItem): number {
  return item.text.length + 40;
}

/**
 * Pick the learned items for one prompt: the always-on core first (pinned,
 * then confident standing preferences, newest confirmed first), then the
 * items most relevant to the query, each part inside its own character
 * budget. Items that repeat a markdown line already in the prompt are left
 * out so nothing is carried twice.
 */
export function selectLearnedMemory(input: LearnedSelectionInput): LearnedSelection {
  if (!input.includeGlobal && !input.includeWorkspace) return { core: [], relevant: [] };
  const now = input.now ?? Date.now();
  const coreLines = (input.coreText ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+(\[[^\]]*\]\s*)?/, "").trim())
    .filter((line) => line.length > 0);
  const candidates = listMemoryItems(input.profileId, { workspaceId: input.workspaceId }).filter((item) => {
    if (item.status !== "active") return false;
    if (item.scope === "global" && !input.includeGlobal) return false;
    if (item.scope === "workspace" && !input.includeWorkspace) return false;
    return !coreLines.some((line) => memorySimilarity(line, item.text) >= MEMORY_DUPLICATE_SIMILARITY);
  });
  const coreBudget = input.coreBudgetChars ?? LEARNED_CORE_BUDGET_CHARS;
  const relevantBudget = input.relevantBudgetChars ?? LEARNED_RELEVANT_BUDGET_CHARS;
  const core: CoraMemoryItem[] = [];
  let used = 0;
  const coreCandidates = candidates
    .filter(isCoreMemoryItem)
    .sort((a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      b.confidence - a.confidence ||
      memoryLastTouched(b) - memoryLastTouched(a));
  for (const item of coreCandidates) {
    if (core.length >= LEARNED_MAX_ITEMS) break;
    if (used + renderedLength(item) > coreBudget) continue;
    core.push(item);
    used += renderedLength(item);
  }
  const chosen = new Set(core.map((item) => item.id));
  const relevant: CoraMemoryItem[] = [];
  let relevantUsed = 0;
  for (const { item } of rankMemoryItems(candidates.filter((item) => !chosen.has(item.id)), input.query, now)) {
    if (core.length + relevant.length >= LEARNED_MAX_ITEMS) break;
    if (relevantUsed + renderedLength(item) > relevantBudget) continue;
    relevant.push(item);
    relevantUsed += renderedLength(item);
  }
  return { core, relevant };
}

function renderItemLine(item: CoraMemoryItem): string {
  const confirmed = item.confirmations > 1 ? `, said ${item.confirmations}x` : "";
  return `- (${memoryItemLabel(item)}${confirmed}) ${item.text} [${item.id}]`;
}

export const LEARNED_MEMORY_HEADER =
  "CORA LEARNED MEMORY (learned from this user's earlier chats and runs; apply it unless the user or this run's evidence says otherwise; the user's newest statement wins; use codara_recall to search for more)";
export const LEARNED_MEMORY_FOOTER = "[END CORA LEARNED MEMORY]";

/** The prompt block for a selection, or null when it is empty. */
export function renderLearnedMemory(
  selection: LearnedSelection,
  opts: { delta?: boolean } = {},
): string | null {
  if (selection.core.length === 0 && selection.relevant.length === 0) return null;
  const lines = [
    opts.delta
      ? `${LEARNED_MEMORY_HEADER}. Additions since the last block in this session; earlier ones still apply:`
      : LEARNED_MEMORY_HEADER,
  ];
  if (selection.core.length > 0) {
    lines.push("Always:", ...selection.core.map(renderItemLine));
  }
  if (selection.relevant.length > 0) {
    lines.push("Relevant to this request:", ...selection.relevant.map(renderItemLine));
  }
  lines.push(LEARNED_MEMORY_FOOTER);
  return lines.join("\n");
}

/** codara_recall: search everything active (and suggestions, marked) by relevance. */
export function searchMemoryItems(
  profileId: string,
  workspaceId: string | null,
  query: string,
  limit = 8,
): CoraMemoryItem[] {
  const items = listMemoryItems(profileId, { workspaceId }).filter((item) => item.status !== "archived");
  return rankMemoryItems(items, query, Date.now()).slice(0, limit).map(({ item }) => item);
}

// ── consolidation ───────────────────────────────────────────────────────────

export interface ConsolidationReport {
  merged: number;
  superseded: number;
  retired: number;
}

const PROPOSAL_TTL_MS = 30 * DAY_MS;
const STALE_AFTER_MS = 120 * DAY_MS;

/**
 * Deterministic tidy-up of one profile's items, cheap enough to run after
 * every chat: merge reworded duplicates, let the newer of two contradicting
 * items win, and retire what has gone stale. Pinned and hand-written items are
 * never retired.
 */
export async function consolidateMemoryItems(profileId: string): Promise<ConsolidationReport> {
  return mutateStore(profileId, (store, now) => {
    const report: ConsolidationReport = { merged: 0, superseded: 0, retired: 0 };
    const live = store.items.filter((item) => item.status === "active" || item.status === "proposed");
    const byNewest = [...live].sort((a, b) => memoryLastTouched(b) - memoryLastTouched(a));
    for (let i = 0; i < byNewest.length; i += 1) {
      const keep = byNewest[i];
      if (keep.status === "archived") continue;
      for (let j = i + 1; j < byNewest.length; j += 1) {
        const other = byNewest[j];
        if (other.status === "archived") continue;
        if (!sameScope(other, keep.scope, keep.workspaceId)) continue;
        if (other.pinned && !keep.pinned) continue;
        if (memoriesContradict(other.text, keep.text)) {
          if (keep.status !== "active" || other.status !== "active") continue;
          if (!mayRetire(keep, other)) continue;
          archive(other, "superseded", now);
          other.supersededBy = keep.id;
          keep.supersedes = [...new Set([...(keep.supersedes ?? []), other.id])];
          report.superseded += 1;
          continue;
        }
        if (memorySimilarity(other.text, keep.text) < MEMORY_DUPLICATE_SIMILARITY) continue;
        const survivor = SOURCE_TRUST[other.source] > SOURCE_TRUST[keep.source] ? other : keep;
        const absorbed = survivor === keep ? other : keep;
        survivor.confirmations += absorbed.confirmations;
        survivor.useCount += absorbed.useCount;
        survivor.confidence = clampConfidence(Math.max(survivor.confidence, absorbed.confidence) + 0.05);
        survivor.pinned = Boolean(survivor.pinned || absorbed.pinned) || undefined;
        if (absorbed.status === "active") survivor.status = "active";
        for (const entry of absorbed.evidence) addEvidence(survivor, entry);
        archive(absorbed, "merged", now);
        absorbed.supersededBy = survivor.id;
        report.merged += 1;
        if (absorbed === keep) break;
      }
    }
    for (const item of store.items) {
      if (item.status === "archived" || item.pinned || item.source === "manual") continue;
      const idle = now - memoryLastTouched(item);
      if (item.status === "proposed" && idle > PROPOSAL_TTL_MS) {
        archive(item, "stale", now);
        report.retired += 1;
      } else if (item.status === "active" && idle > STALE_AFTER_MS && item.useCount < 3 &&
                 (item.source !== "user" || item.confidence < 0.75)) {
        archive(item, "stale", now);
        report.retired += 1;
      }
    }
    enforceCaps(store, now);
    store.lastConsolidatedAt = new Date(now).toISOString();
    const itemsChanged = report.merged + report.superseded + report.retired > 0;
    return { result: report, changed: true, itemsChanged };
  });
}

// ── digest ──────────────────────────────────────────────────────────────────

/** What Cora learned, confirmed, replaced or retired in the last `days` days, newest first. */
export function memoryDigest(
  profileId: string,
  workspaceId: string | null,
  days = 7,
  limit = 12,
): MemoryDigestEntry[] {
  const since = Date.now() - days * DAY_MS;
  const entries: MemoryDigestEntry[] = [];
  for (const item of listMemoryItems(profileId, { workspaceId, includeArchived: true })) {
    const base = { itemId: item.id, text: item.text, scope: item.scope, kind: item.kind };
    const created = Date.parse(item.createdAt);
    if (item.status === "archived") {
      const archivedAt = Date.parse(item.archivedAt ?? item.updatedAt);
      if (archivedAt >= since && item.archivedReason !== "merged" && item.archivedReason !== "dismissed") {
        entries.push({ ...base, action: item.archivedReason === "superseded" ? "replaced" : "retired", at: item.archivedAt ?? item.updatedAt });
      }
      continue;
    }
    if (created >= since) {
      entries.push({ ...base, action: item.status === "proposed" ? "suggested" : "learned", at: item.createdAt });
    } else if (item.lastConfirmedAt && Date.parse(item.lastConfirmedAt) >= since && item.confirmations > 1) {
      entries.push({ ...base, action: "confirmed", at: item.lastConfirmedAt });
    }
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** For tests and profile deletion. */
export function memoryItemsPath(profileId = DEFAULT_CORA_PROFILE_ID): string {
  return itemsPath(normalizeCoraProfileId(profileId));
}
