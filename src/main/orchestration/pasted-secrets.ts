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
// The keys themselves stay known for the life of the process, so whatever a
// run writes later has them replaced as well: the model repeating a key, or
// a worker task it wrote with one.
//
// No Electron import, so the unit suite bundles it directly.

import { SECRET_REDACTED, scrubSecrets, secretsIn } from "@shared/memory-items";

const LIVE_TTL_MS = 60 * 60 * 1000;
const LIVE_MAX = 200;
const KNOWN_MAX = 500;

// Shorter pieces, or ones without a letter ("128000" after "max token:",
// a date), are left to the scrubber alone: replacing them everywhere a run
// writes would rewrite ordinary numbers.
const KNOWN_MIN = 8;

interface LiveText {
  runId: string;
  scrubbed: string;
  raw: string;
  at: number;
}

// `${runId}\n${scrubbed}`; an empty run id is a first message not yet claimed.
const live = new Map<string, LiveText>();
const known = new Set<string>();

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
    }
    return raw;
  }
  live.set(keyOf(runId, scrubbed), { runId, scrubbed: scrubbed.trim(), raw: raw.trim(), at: now });
  for (const secret of secretsIn(raw)) {
    if (secret.length < KNOWN_MIN || !/[A-Za-z]/.test(secret)) continue;
    if (known.size >= KNOWN_MAX) known.delete(known.values().next().value!);
    known.add(secret);
  }
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

function replaceKnown(text: string, form: (secret: string) => string): string {
  let out = text;
  for (const secret of known) {
    const needle = form(secret);
    if (out.includes(needle)) out = out.split(needle).join(SECRET_REDACTED);
  }
  return out;
}

/**
 * `text` with every key a person pasted in this process replaced, for
 * anything about to be written to disk. With `json`, the text is serialized
 * JSON: keys are matched as JSON escapes them and only inside string values,
 * so the result is always valid JSON.
 */
export function redactPastedSecrets(text: string, options: { json?: boolean } = {}): string {
  if (!known.size) return text;
  if (!options.json) return replaceKnown(text, (secret) => secret);
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => replaceKnown(literal, (secret) => JSON.stringify(secret).slice(1, -1)));
}

/** A JSON-shaped value with the pasted keys replaced; the same value when there are none. */
export function redactPastedSecretsIn<T>(value: T): T {
  if (!known.size) return value;
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  const redacted = redactPastedSecrets(json, { json: true });
  return redacted === json ? value : (JSON.parse(redacted) as T);
}
