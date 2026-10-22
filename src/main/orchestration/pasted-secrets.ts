// A key the user pastes into a Cora chat. Everything a run writes keeps the
// scrubbed text (scrubSecrets in @shared/memory-items): run.json,
// events.jsonl, worker prompt files, and so every prompt rebuilt or replayed
// from them. The model sees the key itself in one place only, the live prompt
// of the turn that delivers the message, so it can store it with secret-put
// when asked to.
//
// The raw text is held in memory, never written, keyed by the scrubbed text
// that was stored, and goes once that prompt is accepted (or after an hour).
// The keys themselves stay known for the life of the process, so whatever a
// run writes later has them replaced as well: the model repeating a key, or
// a worker task it wrote with one.
//
// No Electron import, so the unit suite bundles it directly.

import { SECRET_REDACTED, scrubSecrets, secretsIn } from "@shared/memory-items";

const LIVE_TTL_MS = 60 * 60 * 1000;
const LIVE_MAX = 200;
const KNOWN_MAX = 500;

const live = new Map<string, { raw: string; at: number }>();
const known = new Set<string>();

function prune(now: number): void {
  for (const [scrubbed, entry] of live) {
    if (now - entry.at > LIVE_TTL_MS || live.size > LIVE_MAX) live.delete(scrubbed);
  }
}

/**
 * What a person typed, scrubbed for storage. When a credential was replaced,
 * the raw text is kept for the live prompt (livePastedText) and its keys for
 * redaction (redactPastedSecrets).
 */
export function scrubPastedText(raw: string, now = Date.now()): string {
  const scrubbed = scrubSecrets(raw);
  if (scrubbed === raw) return raw;
  prune(now);
  live.set(scrubbed.trim(), { raw: raw.trim(), at: now });
  for (const secret of secretsIn(raw)) {
    if (known.size >= KNOWN_MAX) known.delete(known.values().next().value!);
    known.add(secret);
  }
  return scrubbed;
}

/** The raw text behind a stored message, for the live prompt only; undefined when there is none. */
export function livePastedText(stored: string, now = Date.now()): string | undefined {
  const entry = live.get(stored.trim());
  if (!entry) return undefined;
  if (now - entry.at > LIVE_TTL_MS) {
    live.delete(stored.trim());
    return undefined;
  }
  return entry.raw;
}

/** Forgets the raw text behind these stored messages: their prompt was delivered. */
export function forgetPastedText(stored: readonly string[]): void {
  for (const text of stored) live.delete(text.trim());
}

/**
 * A worker prompt read back from disk with the raw text in place of each
 * stored message it holds, for handing to the worker in memory; `used` lists
 * the stored texts it replaced, to forget once the worker has it.
 */
export function withPastedText(prompt: string, now = Date.now()): { prompt: string; used: string[] } {
  let out = prompt;
  const used: string[] = [];
  for (const scrubbed of live.keys()) {
    const raw = livePastedText(scrubbed, now);
    if (!raw || !out.includes(scrubbed)) continue;
    // The newest copy is this turn's message; earlier ones are history.
    const at = out.lastIndexOf(scrubbed);
    out = `${out.slice(0, at)}${raw}${out.slice(at + scrubbed.length)}`;
    used.push(scrubbed);
  }
  return { prompt: out, used };
}

/**
 * `text` with every key a person pasted in this process replaced, for
 * anything about to be written to disk. With `json`, the text is serialized
 * JSON and the keys are matched as JSON escapes them, so the result stays
 * valid JSON.
 */
export function redactPastedSecrets(text: string, options: { json?: boolean } = {}): string {
  if (!known.size) return text;
  let out = text;
  for (const secret of known) {
    const form = options.json ? JSON.stringify(secret).slice(1, -1) : secret;
    if (out.includes(form)) out = out.split(form).join(SECRET_REDACTED);
  }
  return out;
}

/** A JSON-shaped value with the pasted keys replaced; the same value when there are none. */
export function redactPastedSecretsIn<T>(value: T): T {
  if (!known.size) return value;
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  const redacted = redactPastedSecrets(json, { json: true });
  return redacted === json ? value : (JSON.parse(redacted) as T);
}
