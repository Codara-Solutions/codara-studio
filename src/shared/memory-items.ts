// Cora memory v3: the learned-item layer under the two markdown files.
//
// The markdown tiers (cora-memory.ts) stay the small, user-owned core that is
// pasted into every prompt. Items are everything Cora learns on its own: a
// preference the user stated, a correction, a lesson a worker reported. Each
// one carries where it came from, how sure Cora is, and how often it was used,
// so retrieval can pick the few that matter for a turn and consolidation can
// merge, supersede and retire them without asking the model to rewrite a file.
//
// Pure: shared by the main process (store, retrieval, learning) and the
// renderer (the Memory page), so no node imports here.

export type MemoryItemScope = "global" | "workspace";

export type MemoryItemKind = "preference" | "correction" | "fact" | "procedure" | "lesson";

/**
 * Who taught it. `user` is a statement in the user's own message, `correction`
 * a correction of Cora's previous answer, `reflection` the background review
 * of a chat, `worker` a lesson a worker reported, `ledger` a command several
 * verified runs relied on, `manual` an item the user typed on the Memory page.
 */
export type MemoryItemSource = "user" | "correction" | "reflection" | "worker" | "ledger" | "manual";

/** `proposed` items are suggestions: never injected until the user approves. */
export type MemoryItemStatus = "active" | "proposed" | "archived";

export type MemoryArchiveReason = "superseded" | "merged" | "stale" | "contradicted" | "dismissed";

export interface MemoryItemEvidence {
  runId?: string;
  messageId?: string;
  /** The user's words (or the report line) the item was learned from. */
  quote?: string;
  at: string;
}

export interface CoraMemoryItem {
  id: string;
  scope: MemoryItemScope;
  /** Set for workspace items only. */
  workspaceId?: string;
  kind: MemoryItemKind;
  text: string;
  source: MemoryItemSource;
  status: MemoryItemStatus;
  /** 0..1. Explicit statements start high, inferred ones low. */
  confidence: number;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Last time the user (or a run) said it again. */
  lastConfirmedAt?: string;
  lastUsedAt?: string;
  useCount: number;
  /** Times the same thing was learned again, including the first. */
  confirmations: number;
  helpful?: number;
  harmful?: number;
  evidence: MemoryItemEvidence[];
  supersedes?: string[];
  supersededBy?: string;
  archivedReason?: MemoryArchiveReason;
  archivedAt?: string;
}

export interface MemoryLearningSettings {
  /** Read the user's messages for stated preferences and corrections. */
  capture: boolean;
  /** Review finished chats with a model call (throttled, cheapest model). */
  reflection: boolean;
  /** Merge, supersede and retire items in the background. */
  consolidation: boolean;
}

export const DEFAULT_MEMORY_LEARNING_SETTINGS: MemoryLearningSettings = {
  capture: true,
  reflection: true,
  consolidation: true,
};

export interface MemoryDigestEntry {
  itemId: string;
  text: string;
  scope: MemoryItemScope;
  kind: MemoryItemKind;
  action: "learned" | "confirmed" | "replaced" | "retired" | "suggested";
  at: string;
}

/** `memory:items` payload: everything the Memory page shows below the files. */
export interface MemoryItemsView {
  profileId: string;
  items: CoraMemoryItem[];
  digest: MemoryDigestEntry[];
  settings: MemoryLearningSettings;
  /** Short records of finished runs kept for planning (run-memory.ts). */
  runHistoryCount: number;
}

export interface MemoryItemPatch {
  text?: string;
  pinned?: boolean;
  scope?: MemoryItemScope;
  kind?: MemoryItemKind;
  /** "active" approves a suggestion; "archived" dismisses it. */
  status?: "active" | "archived";
  /** Thumbs from the user: +1 helpful, -1 not helpful. */
  feedback?: 1 | -1;
}

export const MEMORY_ITEM_MAX_CHARS = 500;

// ── text helpers ────────────────────────────────────────────────────────────

// Smart punctuation (phone keyboards, model output) types "don’t"; left
// as is it splits into "don" + "t" and the negation goes uncounted, which
// flips every do/don't comparison between a memory and the user's quote.
function foldApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc\uff07]/g, "'");
}

/** Lowercase, strip accents, fold typographic apostrophes, collapse whitespace. */
export function normalizeMemoryText(text: string): string {
  return foldApostrophes(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// English and Spanish carry most of the owner's chats; French, German and
// Portuguese function words are included so mixed-language memories still
// tokenize to their content words.
const STOPWORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with",
  "from", "into", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
  "these", "those", "there", "here", "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "they", "them", "their", "so", "do", "does", "did", "can", "could", "should", "would", "will",
  "just", "also", "too", "very", "please", "pls", "ok", "okay", "yes", "about", "than", "then",
  "when", "what", "which", "who", "how", "why", "all", "any", "some", "more", "most", "other",
  "such", "only", "own", "same", "have", "has", "had", "get", "got", "let", "lets", "make",
  "user", "cora", "thing", "things", "one", "like", "want", "need",
  "after", "before", "every", "each", "again", "until", "while", "since", "over", "under",
  "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "de", "del", "al", "en",
  "con", "por", "para", "que", "es", "son", "esta", "este", "esto", "eso", "lo", "le", "les",
  "se", "su", "sus", "mi", "mis", "tu", "tus", "yo", "nos", "me", "te", "muy", "mas", "pero",
  "como", "cuando", "donde", "ya", "porque", "favor",
  "le", "les", "des", "du", "et", "ou", "est", "sont", "pour", "avec", "dans", "sur", "je", "tu",
  "il", "elle", "nous", "vous", "der", "die", "das", "und", "oder", "ist", "sind", "mit", "fur",
  "ich", "du", "wir", "sie", "o", "os", "as", "um", "uma", "e", "em", "com", "para", "eu", "voce",
]);

// Negation and frequency words decide a memory's polarity, so they are kept
// out of the topic tokens and read separately by memoryPolarity.
const POLARITY_WORDS = new Set<string>([
  "not", "no", "never", "dont", "don't", "cant", "cannot", "wont", "stop", "avoid", "without",
  "nunca", "jamas", "nada",
  "sin", "evita", "evitar", "deja", "ne", "pas", "jamais", "nicht", "nie", "kein", "keine",
  "nao", "always", "siempre", "toujours", "immer", "sempre",
]);

const SUFFIXES = ["ations", "ation", "ings", "ing", "edly", "ed", "es", "s", "mente", "ciones", "cion"];

function stem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  // "invoices" loses "es" above, so "invoice" has to lose its "e" to meet it.
  if (token.length >= 4 && token.endsWith("e")) return token.slice(0, -1);
  return token;
}

/** Content tokens of a memory or a query: stopwords and polarity words dropped, lightly stemmed. */
export function memoryTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const normalized = normalizeMemoryText(text).replace(/n't\b/g, " not");
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw) || POLARITY_WORDS.has(raw)) continue;
    const token = stem(raw);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

// Retrieval-only concept tags. A memory says "use pnpm" while the request
// says "install the dependencies": no shared word, same subject. Tagging both
// sides with the concept bridges that gap without loosening duplicate
// detection, which keeps using the plain tokens.
const CONCEPTS: Array<[string, RegExp]> = [
  ["#packages", /^(?:npm|pnpm|yarn|bun|npx|install|dependenc|dependency|packag|lockfil|node_modul|paquet|dependencia)/],
  ["#tests", /^(?:test|tests|spec$|jest|vitest|pytest|playwright|e2e|unit|suit|prueba|coverag)/],
  ["#git", /^(?:git|commit|push|pull|branch|merg|rebas|pr$|worktree|rama|tag)/],
  ["#build", /^(?:build|compil|bundl|vite|webpack|tsc|typecheck|lint|eslint|prettier|format)/],
  ["#language", /^(?:english|spanish|espanol|ingl|french|german|portugu|catalan|italian|languag|idioma|lengua)/],
  ["#style", /^(?:concis|brief|short|verbos|detail|ton$|emoji|formal|informal|brev|corto|explain|explan)/],
  ["#reply", /^(?:reply|answer|respond|respons|talk|speak|writ|contest|habl|escrib)/],
  ["#memory", /^(?:memory|remember|memoria|recuerd)/],
  ["#ui", /^(?:ui|ux|button|layout|css|styl|design|component|screen|pag$|dialog|modal)/],
  ["#database", /^(?:databas|db$|migrat|schema|column|tabl|sql|postgr|sqlit|mysql|drizzl|prisma|tabla)/],
  ["#deploy", /^(?:deploy|releas|publish|ship|ci$|pipelin|despliegu)/],
];

/** Tokens plus concept tags, for ranking only. */
export function memoryRetrievalTokens(text: string): string[] {
  const tokens = memoryTokens(text);
  const tags = new Set<string>();
  for (const token of tokens) {
    for (const [tag, pattern] of CONCEPTS) if (pattern.test(token)) tags.add(tag);
  }
  return [...tokens, ...tags];
}

/**
 * How well a quote backs a memory written from it: the share of the memory's
 * retrieval tokens the quote carries, and how many content words it adds
 * that the quote never said. A review answer can cite a real sentence of the
 * user's and still write anything into `text`, so the quote existing is not
 * enough; the words have to come from it. Concept tags bridge a paraphrase
 * across languages ("Answer in Spanish." from "respóndeme en español").
 */
export function memoryQuoteSupport(text: string, quote: string): { coverage: number; unsupported: number } {
  const quoted = new Set(memoryRetrievalTokens(quote));
  const tokens = [...new Set(memoryRetrievalTokens(text))];
  if (tokens.length === 0) return { coverage: 0, unsupported: 0 };
  let shared = 0;
  let unsupported = 0;
  for (const token of tokens) {
    if (quoted.has(token)) shared += 1;
    else if (!token.startsWith("#")) unsupported += 1;
  }
  return { coverage: shared / tokens.length, unsupported };
}

const QUOTE_MIN_COVERAGE = 0.5;
const QUOTE_MAX_UNSUPPORTED_WORDS = 3;

const NEGATORS = new Set<string>([
  "not", "no", "never", "dont", "cant", "cannot", "wont", "stop", "avoid", "without", "nunca",
  "jamas", "sin", "evita", "evitar", "pas", "jamais", "nicht", "nie", "kein", "keine", "nao",
]);

/**
 * Whether a sentence negates an odd number of times. Token coverage drops
 * polarity words, so "Push to main without asking first." covers every word
 * of "never push to main without asking me first"; only the count of
 * negations tells the two apart. A ", not Y" tail names the rejected value of
 * a preference ("use pnpm, not npm") and does not negate the sentence.
 */
export function memoryNegatesOddly(text: string): boolean {
  const normalized = normalizeMemoryText(text)
    .replace(/n't\b/g, " not")
    .replace(/\bdeja de\b/g, " stop ")
    .replace(/,\s*(?:not|no)\b/g, ",");
  let count = 0;
  for (const raw of normalized.split(/[^a-z0-9]+/)) if (NEGATORS.has(raw)) count += 1;
  return count % 2 === 1;
}

function quoteCovers(text: string, quote: string): boolean {
  const { coverage, unsupported } = memoryQuoteSupport(text, quote);
  return coverage >= QUOTE_MIN_COVERAGE && unsupported <= QUOTE_MAX_UNSUPPORTED_WORDS;
}

/**
 * Whether `quote` is enough to stand behind `text` as the user's own words:
 * its words, and the same "do" or "don't".
 */
export function memorySupportedByQuote(text: string, quote: string | undefined): boolean {
  if (!quote) return false;
  return quoteCovers(text, quote) && memoryNegatesOddly(text) === memoryNegatesOddly(quote);
}

const RETRACTION_PATTERN =
  /\b(?:forget|no longer|anymore|any more|olvida|olvidate|ya no|oublie|vergiss|nicht mehr)\b/;

/**
 * Whether the user's quote takes `text` back: it contradicts the memory,
 * says the opposite about the same words, or asks to forget it. Restating
 * the memory is no reason to archive it.
 */
export function memoryRetractedByQuote(text: string, quote: string | undefined): boolean {
  if (!quote) return false;
  if (memoriesContradict(text, quote)) return true;
  if (!quoteCovers(text, quote)) return false;
  return memoryNegatesOddly(text) !== memoryNegatesOddly(quote) ||
    RETRACTION_PATTERN.test(normalizeMemoryText(quote));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  if (small.size === 0) return 0;
  let shared = 0;
  for (const value of small) if (large.has(value)) shared += 1;
  return shared / small.size;
}

/** Topic overlap of two memories, 0..1, ignoring polarity. */
export function memorySimilarity(a: string, b: string): number {
  const ta = new Set(memoryTokens(a));
  const tb = new Set(memoryTokens(b));
  const j = jaccard(ta, tb);
  // A reworded memory that adds a clause keeps nearly all of the shorter one's
  // words; plain Jaccard would score it below the duplicate line.
  const c = Math.min(ta.size, tb.size) >= 3 ? containment(ta, tb) * 0.9 : 0;
  return Math.max(j, c);
}

const NEGATION_PATTERN =
  /\b(?:not|no|never|don't|dont|do not|can't|cant|cannot|won't|wont|stop|avoid|without|nunca|jamas|jamás|sin|evita|deja de|no uses|ne\b[^.]*\bpas|jamais|nicht|nie|kein|keine|nao|não)\b/i;

/** -1 for a "don't / never" memory, +1 otherwise. */
export function memoryPolarity(text: string): -1 | 1 {
  return NEGATION_PATTERN.test(foldApostrophes(text)) ? -1 : 1;
}

// Slots a preference can hold exactly one value for. Two memories that name
// the same slot with different values contradict even when most of their
// words differ ("answer in Spanish" vs "reply in English").
const SLOTS: Array<{ slot: string; values: Array<[string, RegExp]> }> = [
  {
    slot: "language",
    values: [
      ["english", /\b(english|ingles|inglés|anglais|englisch)\b/i],
      ["spanish", /\b(spanish|espanol|español|castellano|espagnol|spanisch)\b/i],
      ["french", /\b(french|frances|francés|francais|français)\b/i],
      ["german", /\b(german|aleman|alemán|allemand|deutsch)\b/i],
      ["portuguese", /\b(portuguese|portugues|portugués)\b/i],
      ["catalan", /\b(catalan|catalán|catala|català)\b/i],
      ["italian", /\b(italian|italiano|italien)\b/i],
    ],
  },
  {
    slot: "package-manager",
    values: [
      ["npm", /\bnpm\b/i],
      ["pnpm", /\bpnpm\b/i],
      ["yarn", /\byarn\b/i],
      ["bun", /\bbun\b/i],
    ],
  },
  {
    slot: "indentation",
    values: [
      ["tabs", /\btabs?\b/i],
      ["spaces", /\bspaces?\b/i],
    ],
  },
  {
    slot: "verbosity",
    values: [
      ["short", /\b(concise|brief|short|shorter|terse|breve|corto|conciso)\b/i],
      ["long", /\b(detailed|verbose|longer|thorough|in depth|detallad[oa]|extens[oa])\b/i],
    ],
  },
];

// Words that only say "do it this way" and name no object of their own.
const SLOT_GENERIC_TOKEN =
  /^(?:reply|repli|answer|respond|respons|response|talk|speak|write|writ|use|prefer|keep|give|giv|now|default|future|futur|forward|indent|explain|explan|repo|repository|repositori|project|workspace|everywhere|everywher|workspac|chat|contesta|responde|habla|escribe|escrib|usa|utiliza)$/;

/**
 * Whether two memories naming one slot are about the same object. "Reply in
 * French" and "always answer in Spanish" are (nothing but the value and
 * generic verbs is left on either side), while "write commit messages in
 * English" and "answer in Spanish" are not: the owner of this rule chats in
 * Spanish and commits in English, and the second must never retire the first.
 */
function sameSlotObject(a: string, b: string, slot: string): boolean {
  const values = SLOTS.find((entry) => entry.slot === slot)?.values ?? [];
  const residual = (text: string) =>
    new Set(memoryTokens(text).filter((token) =>
      !SLOT_GENERIC_TOKEN.test(token) && !values.some(([, pattern]) => pattern.test(token))));
  const ra = residual(a);
  const rb = residual(b);
  if (ra.size === 0 && rb.size === 0) return true;
  if (ra.size === 0 || rb.size === 0) return false;
  return jaccard(ra, rb) >= 0.5;
}

function slotValues(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { slot, values } of SLOTS) {
    for (const [value, pattern] of values) {
      if (!pattern.test(text)) continue;
      const set = found.get(slot) ?? new Set<string>();
      set.add(value);
      found.set(slot, set);
    }
  }
  return found;
}

// "X instead of Y", "X rather than Y", "X not Y", "X en vez de Y": the value
// the user chose and the one they rejected.
const PREFER_OVER_PATTERN =
  /\b([\w.@/-]+)\s+(?:instead of|rather than|over|not|en vez de|en lugar de|y no|plutot que|plutôt que|statt)\s+([\w.@/-]+)/i;

function preferencePair(text: string): { chosen: string; rejected: string } | null {
  const match = PREFER_OVER_PATTERN.exec(normalizeMemoryText(text));
  if (!match) return null;
  // The character class keeps dots for "next.js" and file names, so a
  // sentence's final period has to come off or "npm." never equals "npm".
  const chosen = match[1].replace(/\.+$/, "");
  const rejected = match[2].replace(/\.+$/, "");
  return chosen && rejected ? { chosen, rejected } : null;
}

/**
 * Whether `newer` contradicts `older`: the same topic with opposite polarity,
 * the same single-value slot with a different value, or a swapped
 * "X instead of Y" pair. Conservative on purpose: a false positive retires a
 * memory the user still wants.
 */
export function memoriesContradict(older: string, newer: string): boolean {
  const pairOld = preferencePair(older);
  const pairNew = preferencePair(newer);
  if (pairOld && pairNew && pairOld.chosen === pairNew.rejected && pairOld.rejected === pairNew.chosen) {
    return true;
  }
  const topic = memorySimilarity(older, newer);
  if (pairOld && !pairNew && topic >= 0.2) {
    const normalizedNew = normalizeMemoryText(newer);
    if (new RegExp(`\\b${escapeRegExp(pairOld.rejected)}\\b`).test(normalizedNew) &&
        !new RegExp(`\\b${escapeRegExp(pairOld.chosen)}\\b`).test(normalizedNew) &&
        memoryPolarity(newer) === 1) {
      return true;
    }
  }
  const slotsOld = slotValues(older);
  const slotsNew = slotValues(newer);
  for (const [slot, valuesNew] of slotsNew) {
    const valuesOld = slotsOld.get(slot);
    if (!valuesOld) continue;
    if (valuesOld.size !== 1 || valuesNew.size !== 1) continue;
    const [oldValue] = valuesOld;
    const [newValue] = valuesNew;
    if (oldValue === newValue) {
      if (memoryPolarity(older) !== memoryPolarity(newer) && topic >= 0.3) return true;
      continue;
    }
    // Different values for one slot only conflict when both are positive
    // statements about the same thing ("use pnpm" vs "use npm"), not when one
    // merely mentions the other value ("pnpm, not npm" is handled above).
    if (memoryPolarity(older) === 1 && memoryPolarity(newer) === 1 && !pairOld && !pairNew && sameSlotObject(older, newer, slot)) {
      return true;
    }
  }
  return topic >= 0.6 && memoryPolarity(older) !== memoryPolarity(newer);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Near-duplicate threshold: above this two memories say the same thing. */
export const MEMORY_DUPLICATE_SIMILARITY = 0.75;

// ── secret scanning ─────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|pwd|passphrase|secret|token|api[_ -]?key|access[_ -]?key|contrase(?:n|ñ)a|clave|mot de passe|passwort)\s*(?:is|es|=|:)\s*\S{6,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i,
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Whether a memory would carry a credential. Memory is pasted into every
 * future prompt and shown on the Memory page, so a secret must never land in
 * it however the user phrased the request.
 */
export function containsSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{36,}/g)) {
    const token = match[0];
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && !/^[a-f0-9-]+$/i.test(token)) {
      return true;
    }
  }
  return false;
}

export const SECRET_REDACTED = "[redacted]";

const KEYWORD_SECRET = SECRET_PATTERNS[SECRET_PATTERNS.length - 2];
const URL_CREDENTIALS = SECRET_PATTERNS[SECRET_PATTERNS.length - 1];

// containsSecret refuses a whole memory on a hint; scrubbing rewrites what
// the user said, so it replaces only what reads like a credential. A value
// after "password is" must hold a digit or a symbol ("the token is expired"
// stays), a provider-looking token must hold a digit ("sk-learn-models"
// stays), and a long opaque token must stand alone, not be a piece of a link
// or a path.
function credentialLike(value: string): boolean {
  return /\d/.test(value) || /[^A-Za-z]/.test(value);
}

/**
 * The text with the credentials in it replaced by "[redacted]", for text a
 * person typed that is about to be written to disk (run files, the task
 * list). The keyword keeps its keyword ("password is [redacted]") and a URL
 * its scheme and host, so the text still says what was there. Text without
 * one comes back as it was.
 */
export function scrubSecrets(text: string): string {
  if (!containsSecret(text)) return text;
  let out = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    `${SECRET_REDACTED} private key`,
  );
  for (const pattern of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    if (pattern === KEYWORD_SECRET) {
      out = out.replace(global, (match) =>
        match.replace(/^(.*?(?:\bis|\bes|=|:)\s*)(\S+?)([.,;:!?)\]]*)$/i, (whole, head: string, value: string, tail: string) =>
          // Already scrubbed: "[redacted]" would otherwise lose its "]" to
          // the tail and gain another on every pass.
          credentialLike(value) && !`${value}${tail}`.startsWith(SECRET_REDACTED) ? `${head}${SECRET_REDACTED}${tail}` : whole,
        ),
      );
    } else if (pattern === URL_CREDENTIALS) {
      out = out.replace(global, (match) => `${match.slice(0, match.indexOf("://") + 3)}${SECRET_REDACTED}@`);
    } else {
      out = out.replace(global, (match) => (/\d/.test(match) ? SECRET_REDACTED : match));
    }
  }
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    return `${SECRET_REDACTED}${match.slice(match.trimEnd().length)}`;
  });
  return out.replace(/(?<![\w./:@#?&=%-])[A-Za-z0-9+_=-]{36,}(?![\w./-])/g, (token) =>
    /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && !/^[a-f0-9-]+$/i.test(token) ? SECRET_REDACTED : token,
  );
}

// ── ranking ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** Half-life of a memory nobody used or confirmed. */
export const MEMORY_RECENCY_HALF_LIFE_DAYS = 60;

export function memoryLastTouched(item: CoraMemoryItem): number {
  let latest = Date.parse(item.updatedAt);
  for (const value of [item.lastConfirmedAt, item.lastUsedAt, item.createdAt]) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed) && (!Number.isFinite(latest) || parsed > latest)) latest = parsed;
  }
  return Number.isFinite(latest) ? latest : 0;
}

/** 0.25..1: old memories fade but never vanish from a strongly relevant match. */
export function memoryRecencyFactor(item: CoraMemoryItem, now: number): number {
  const ageDays = Math.max(0, (now - memoryLastTouched(item)) / DAY_MS);
  return 0.25 + 0.75 * Math.pow(0.5, ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS);
}

/** 0.3..2: used and thumbed-up memories rise, thumbed-down ones sink. */
export function memoryUsefulness(item: CoraMemoryItem): number {
  const value = 1 + 0.15 * Math.log1p(item.useCount) + 0.1 * Math.log1p(Math.max(0, item.confirmations - 1)) +
    0.25 * ((item.helpful ?? 0) - (item.harmful ?? 0));
  return Math.min(2, Math.max(0.3, value));
}

export interface RankedMemoryItem {
  item: CoraMemoryItem;
  relevance: number;
  score: number;
}

/**
 * BM25 relevance of each item to the query, weighted by recency, usefulness
 * and confidence. Items sharing no content word with the query score 0 and
 * are left out.
 */
export function rankMemoryItems(
  items: readonly CoraMemoryItem[],
  query: string,
  now: number,
): RankedMemoryItem[] {
  const queryTokens = new Set(memoryRetrievalTokens(query));
  if (queryTokens.size === 0 || items.length === 0) return [];
  const docs = items.map((item) => memoryRetrievalTokens(item.text));
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const tokens of docs) {
    totalLength += tokens.length;
    for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const averageLength = totalLength / docs.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const n = docs.length;
  const ranked: RankedMemoryItem[] = [];
  items.forEach((item, index) => {
    const tokens = docs[index];
    let relevance = 0;
    for (const token of queryTokens) {
      const tf = tokens.filter((value) => value === token).length;
      if (tf === 0) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      relevance += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / averageLength)));
    }
    if (relevance <= 0) return;
    const score = relevance * memoryRecencyFactor(item, now) * memoryUsefulness(item) * (0.5 + item.confidence);
    ranked.push({ item, relevance, score });
  });
  return ranked.sort((a, b) => b.score - a.score);
}

/** Always-on: pinned items, and confident standing preferences of the user. */
export function isCoreMemoryItem(item: CoraMemoryItem): boolean {
  if (item.status !== "active") return false;
  if (item.pinned) return true;
  if (item.kind === "preference" || item.kind === "correction") return item.confidence >= 0.7;
  return item.kind === "procedure" && item.scope === "workspace" && item.confidence >= 0.85;
}

const KIND_LABEL: Record<MemoryItemKind, string> = {
  preference: "preference",
  correction: "correction",
  fact: "fact",
  procedure: "procedure",
  lesson: "lesson",
};

export function memoryItemLabel(item: Pick<CoraMemoryItem, "scope" | "kind">): string {
  return `${item.scope === "global" ? "global" : "workspace"} ${KIND_LABEL[item.kind]}`;
}
