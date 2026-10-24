// A key the user pastes into a Cora chat. Everything a run writes keeps the
// scrubbed text (scrubSecrets in @shared/memory-items): run.json,
// events.jsonl, worker prompt files, and so every prompt rebuilt or replayed
// from them. The model sees the key itself in one place only, the live prompt
// of the turn that delivers the message, so it can store it with secret-put
// when asked to.
//
// The raw text is held in memory, never written, keyed by its run and the
// scrubbed text that was stored, and goes once that prompt is accepted (or
// after an hour). A new chat's first message is scrubbed before its run
// exists; the run claims it when the message is stored.
// The keys themselves stay known to that run, so whatever it writes later
// has them replaced as well: the model repeating a key, or a worker task it
// wrote with one. They are kept across restarts in one 0600 file per run
// beside the Pi sessions (setPastedKeyDir), which already hold the key;
// never in the run's own folder, which stays scrubbed. Only that run's
// writes. A key that reads as one on its own (keyLike: "sk-proj-…", a random
// mix of letters and digits) is replaced in every string the run writes: a
// command, a tool's output, an error. A word the scrubber took for a key only
// because of its label ("token: codara-studio2") is replaced in message-text
// fields alone, so it cannot rewrite a folder, a branch or a command.
//
// No Electron import, so the unit suite bundles it directly.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SECRET_REDACTED, keyLike, scrubSecrets, secretsIn } from "@shared/memory-items";

const LIVE_TTL_MS = 60 * 60 * 1000;
const LIVE_MAX = 200;
const KNOWN_MAX = 50;
const KNOWN_RUNS_MAX = 200;

// Shorter pieces, or ones without a letter ("128000" after "max token:",
// a date), are left to the scrubber alone: replacing them everywhere a run
// writes would rewrite ordinary numbers.
const KNOWN_MIN = 8;

interface LiveText {
  runId: string;
  scrubbed: string;
  raw: string;
  /** The keys in it, for the run that claims a first message. */
  secrets: string[];
  at: number;
}

// `${runId}\n${scrubbed}`; an empty run id is a first message not yet claimed.
const live = new Map<string, LiveText>();
interface RunKeys {
  all: Set<string>;
  /** The ones keyLike, replaced in every field. */
  strong: Set<string>;
}
const known = new Map<string, RunKeys>();
// Runs whose key file was read this process (or that have none).
const loaded = new Set<string>();
let keyDir: (() => string) | null = null;

/** Where each run's keys are kept across restarts (run-store sets it). */
export function setPastedKeyDir(dir: () => string): void {
  keyDir = dir;
  loaded.clear();
}

const RUN_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

function keyFile(runId: string): string | null {
  return keyDir && RUN_FILE_NAME.test(runId) ? join(keyDir(), `${runId}.json`) : null;
}

function keysOf(runId: string): RunKeys | undefined {
  if (known.has(runId) || loaded.has(runId)) return known.get(runId);
  loaded.add(runId);
  const file = keyFile(runId);
  if (!file) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const keys = Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.length >= KNOWN_MIN) : [];
    if (keys.length) remember(runId, keys, false);
  } catch {
    // No file: nothing was pasted into this run.
  }
  return known.get(runId);
}

function persist(runId: string, keys: RunKeys): void {
  const file = keyFile(runId);
  if (!file) return;
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify([...keys.all]), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // Kept in memory for this process all the same.
  }
}

function remember(runId: string, secrets: readonly string[], save = true): void {
  if (!runId || !secrets.length) return;
  let keys = save ? keysOf(runId) : known.get(runId);
  if (!keys) {
    if (known.size >= KNOWN_RUNS_MAX) {
      const oldest = known.keys().next().value!;
      known.delete(oldest);
      loaded.delete(oldest);
    }
    keys = { all: new Set(), strong: new Set() };
    known.set(runId, keys);
  }
  for (const secret of secrets) {
    if (keys.all.size >= KNOWN_MAX) {
      const oldest = keys.all.values().next().value!;
      keys.all.delete(oldest);
      keys.strong.delete(oldest);
    }
    keys.all.add(secret);
    if (keyLike(secret)) keys.strong.add(secret);
  }
  if (save) persist(runId, keys);
}

/** Forgets the keys pasted into `runId`, on disk too: the run was deleted. */
export function forgetPastedKeys(runId: string): void {
  known.delete(runId);
  loaded.delete(runId);
  const file = keyFile(runId);
  try {
    if (file) rmSync(file, { force: true });
  } catch {
    // Deleting the run goes on; the file holds only what Pi's session does.
  }
}

const keyOf = (runId: string, scrubbed: string) => `${runId}\n${scrubbed.trim()}`;

function prune(now: number): void {
  for (const [key, entry] of live) {
    if (now - entry.at > LIVE_TTL_MS || live.size > LIVE_MAX) live.delete(key);
  }
}

/**
 * What a person typed, scrubbed for storage. When a credential was replaced,
 * the raw text is kept for the live prompt of `runId` (livePastedText) and
 * its keys for redaction (redactPastedSecrets). Text that comes in already
 * scrubbed claims a first message no run had yet.
 */
export function scrubPastedText(raw: string, runId = "", now = Date.now()): string {
  const scrubbed = scrubSecrets(raw);
  prune(now);
  if (scrubbed === raw) {
    const unclaimed = runId ? live.get(keyOf("", raw)) : undefined;
    if (unclaimed) {
      live.delete(keyOf("", raw));
      live.set(keyOf(runId, raw), { ...unclaimed, runId });
      remember(runId, unclaimed.secrets);
    }
    return raw;
  }
  const secrets = secretsIn(raw).filter((secret) => secret.length >= KNOWN_MIN && /[A-Za-z]/.test(secret));
  live.set(keyOf(runId, scrubbed), { runId, scrubbed: scrubbed.trim(), raw: raw.trim(), secrets, at: now });
  remember(runId, secrets);
  return scrubbed;
}

/** The raw text behind a message stored in `runId`, for the live prompt only; undefined when there is none. */
export function livePastedText(runId: string, stored: string, now = Date.now()): string | undefined {
  const entry = live.get(keyOf(runId, stored));
  if (!entry) return undefined;
  if (now - entry.at > LIVE_TTL_MS) {
    live.delete(keyOf(runId, stored));
    return undefined;
  }
  return entry.raw;
}

/** Forgets the raw text behind these messages of `runId`: their prompt was delivered. */
export function forgetPastedText(runId: string, stored: readonly string[]): void {
  for (const text of stored) live.delete(keyOf(runId, text));
}

/**
 * A worker prompt read back from disk with the raw text in place of each
 * stored message it holds, for handing to the worker in memory; `used` lists
 * the stored texts it replaced, to forget once the worker has it.
 */
export function withPastedText(runId: string, prompt: string, now = Date.now()): { prompt: string; used: string[] } {
  let out = prompt;
  const used: string[] = [];
  for (const { runId: owner, scrubbed } of [...live.values()]) {
    if (owner !== runId) continue;
    const raw = livePastedText(runId, scrubbed, now);
    if (!raw || !out.includes(scrubbed)) continue;
    // The newest copy is this turn's message; earlier ones are history.
    const at = out.lastIndexOf(scrubbed);
    out = `${out.slice(0, at)}${raw}${out.slice(at + scrubbed.length)}`;
    used.push(scrubbed);
  }
  return { prompt: out, used };
}

function replaceKnown(text: string, keys: ReadonlySet<string>): string {
  let out = text;
  for (const secret of keys) {
    if (out.includes(secret)) out = out.split(secret).join(SECRET_REDACTED);
  }
  return out;
}

/** `text` with every key a person pasted into `runId` replaced, for that run's text about to be written to disk. */
export function redactPastedSecrets(runId: string | null | undefined, text: string): string {
  const keys = runId ? keysOf(runId) : undefined;
  return keys ? replaceKnown(text, keys.all) : text;
}

// The fields that hold what someone said: user messages and answers, the
// first message, prompt text, what the model wrote back (its summary, its
// question and the reason a run stopped). Everything else
// (branches, worktrees, URLs, commands, ids, folders, times) names things,
// and a word the scrubber took for a key only by its label must not rename
// them; a key that reads as one on its own is replaced there too.
const TEXT_FIELD =
  /^(?:message|messages|text|prompt|title|description|question|questionReason|answer|content|body|summary|goal|note|notes|reason|rationale|details|response|result|initialUserNote|delta)$/;

/**
 * A JSON-shaped value `runId` writes, with the keys pasted into that run
 * replaced: keyLike ones in every string, the others in message-text fields
 * only (TEXT_FIELD). Object keys are left alone. A bare string is text. The
 * same value when nothing changed.
 */
export function redactPastedSecretsIn<T>(runId: string | null | undefined, value: T): T {
  const keys = runId ? keysOf(runId) : undefined;
  if (!keys) return value;
  const walk = (node: unknown, text: boolean): unknown => {
    if (typeof node === "string") return replaceKnown(node, text ? keys.all : keys.strong);
    if (Array.isArray(node)) {
      const items = node.map((item) => walk(item, text));
      return items.some((item, index) => item !== node[index]) ? items : node;
    }
    if (!node || typeof node !== "object") return node;
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(node)) {
      out[field] = walk(item, TEXT_FIELD.test(field));
      changed ||= out[field] !== item;
    }
    return changed ? out : node;
  };
  return walk(value, true) as T;
}
