import { containsSecret, type MemoryItemKind, type MemoryItemScope } from "@shared/memory-items";

// Deterministic detection of what a user message teaches Cora: an explicit
// "remember this", a standing preference ("always", "never", "from now on"),
// or a correction of Cora's previous answer that states how to do it instead.
//
// This runs on every user message, so it must be cheap and must stay quiet:
// a false positive becomes a memory that rides every later prompt. Anything
// ambiguous is left to the end-of-chat review (memory-learning.ts), which
// sees the whole conversation. Patterns cover English and Spanish fully, and
// the common French, German and Portuguese phrasings.
//
// Pure, so scripts/test-memory-signals.cjs and the memory eval load it
// directly.

export type MemorySignalTrigger = "remember" | "preference" | "correction";

export interface MemorySignalCandidate {
  trigger: MemorySignalTrigger;
  kind: MemoryItemKind;
  scope: MemoryItemScope;
  /** The memory as it will be stored. */
  text: string;
  /** The user's sentence it came from, verbatim. */
  quote: string;
  confidence: number;
}

export interface MemorySignalContext {
  /** Cora (or a worker on its behalf) answered before this message. */
  followsCoraReply: boolean;
}

/** Corrections without a reusable rule still count as a signal for the review. */
export interface MemorySignalScan {
  candidates: MemorySignalCandidate[];
  sawCorrection: boolean;
}

const MAX_SCANNED_CHARS = 6_000;
const MIN_SENTENCE_CHARS = 8;
const MAX_SENTENCE_CHARS = 400;
const MAX_CANDIDATES_PER_MESSAGE = 3;
// Past this size a message with several paragraphs is read as the user's
// words wrapped around something pasted (an email, a doc, a page).
const PASTE_MIN_CHARS = 300;
const PASTE_MIN_PARAGRAPHS = 3;

const REMEMBER_PATTERN = new RegExp(
  [
    "\\bremember\\b(?! (?:when|how|why|what|if)\\b)",
    "\\bdon'?t forget\\b",
    "\\bkeep in mind\\b",
    "\\bmake a note\\b",
    "\\bnote (?:that|for (?:the )?future)\\b",
    "\\bfor future reference\\b",
    "\\bsave (?:this|that) (?:to|in) (?:your )?memory\\b",
    "\\b(?:recuerda|recuerdalo|recuérdalo|acuerdate|acuérdate)\\b",
    "\\bno (?:te )?olvides\\b",
    "\\bten en cuenta\\b",
    "\\btoma nota\\b",
    "\\bapunta(?:te)? que\\b",
    "\\bguarda (?:esto|en (?:tu )?memoria)\\b",
    "\\bsouviens[- ]toi\\b",
    "\\bn'oublie pas\\b",
    "\\bretiens que\\b",
    "\\bmerk dir\\b",
    "\\bdenk daran\\b",
    "\\blembre[- ]se\\b",
    "\\blembra que\\b",
  ].join("|"),
  "i",
);

const PREFERENCE_PATTERN = new RegExp(
  [
    "\\balways\\b",
    "\\bnever\\b",
    "\\bfrom now on\\b",
    "\\bgoing forward\\b",
    "\\bin the future\\b",
    "\\bfrom here on\\b",
    "\\bevery time\\b",
    "\\bby default\\b",
    "\\bi (?:really )?(?:prefer|like it when|hate it when|don'?t like|do not like|want you to)\\b",
    "\\bi'?d (?:rather|prefer)\\b",
    "\\bstop (?:doing|using|adding|writing|asking|saying|making)\\b",
    "\\bdon'?t ever\\b",
    "\\bsiempre\\b",
    "\\bnunca\\b",
    "\\bjam[aá]s\\b",
    "\\ba partir de ahora\\b",
    "\\bde ahora en adelante\\b",
    "\\bdesde ahora\\b",
    "\\bpor defecto\\b",
    "\\bcada vez que\\b",
    "\\b(?:yo )?prefiero\\b",
    "\\bno me gusta\\b",
    "\\bme gusta (?:que|cuando)\\b",
    "\\bquiero que\\b",
    "\\bdeja de\\b",
    "\\btoujours\\b",
    "\\bjamais\\b",
    "\\bd[ée]sormais\\b",
    "\\bje pr[ée]f[èe]re\\b",
    "\\bimmer\\b",
    "\\bab jetzt\\b",
    "\\bich bevorzuge\\b",
    "\\bsempre\\b",
    "\\ba partir de agora\\b",
    "\\bprefiro\\b",
  ].join("|"),
  "i",
);

// A preference word only teaches something when the sentence tells Cora how
// to behave. "The test always fails" uses "always" to describe the world, so
// a verb counts only as an imperative opening the sentence (after fillers and
// the preference words themselves), while addressing Cora counts anywhere.
const ADDRESS_PATTERN = new RegExp(
  [
    "\\b(?:you|your|please|i (?:really )?prefer|i'?d prefer|i'?d rather|i want|i like|i hate|i don'?t like|call me|tell me|ask me|show me|give me)\\b",
    "\\b(?:t[uú]|usted|prefiero|quiero que|por favor|h[aá]blame|ll[aá]mame|resp[oó]ndeme|dime|preg[uú]ntame|no me gusta|me gusta (?:que|cuando))\\b",
    "\\b(?:vous|je pr[ée]f[èe]re|s'il te pla[iî]t|bitte|ich bevorzuge|voc[eê]|prefiro|por favor)\\b",
  ].join("|"),
  "i",
);

const DIRECTIVE_LEAD = new RegExp(
  "^(?:(?:no|nope|ok(?:ay)?|so|and|also|then|well|actually|hey|cora|btw|please|pls|from now on|going forward|in the future|from here on|by default|every time|" +
    "vale|bueno|pues|oye|y|tambi[eé]n|en realidad|" +
    "always|never|in this (?:repo|repository|project|workspace|codebase)|everywhere|" +
    "siempre|nunca|jam[aá]s|a partir de ahora|de ahora en adelante|desde ahora|por defecto|en este (?:repo|repositorio|proyecto)|" +
    "toujours|jamais|d[ée]sormais|immer|ab jetzt|sempre|a partir de agora)[,:]?\\s+)+",
  "i",
);

const IMPERATIVE_START = new RegExp(
  "^(?:" +
    [
      "don'?t|do not|use|avoid|write|reply|answer|respond|talk|speak|keep|make sure|run|ask|commit|push|pull|explain|show|put|name|format|test|check|add|remove|stop|include|leave|prefer|start|end|open|close|mention|say|call|tell|give|send|merge|rebase|deploy",
      "no uses|no hagas|no pongas|usa|utiliza|escribe|responde|contesta|habla|evita|aseg[uú]rate|pon|haz|hazlo|pregunta|explica|ejecuta|corre|deja de|incluye|a[nñ]ade|quita|manda",
      "utilise|r[ée]ponds|[ée]cris|parle|verwende|antworte|schreib|sprich|benutze|responda|escreva|fale|n'utilise pas|ne mets pas",
    ].join("|") +
    ")\\b",
  "i",
);

function isDirective(sentence: string): boolean {
  if (ADDRESS_PATTERN.test(sentence)) return true;
  return IMPERATIVE_START.test(sentence.replace(DIRECTIVE_LEAD, ""));
}

// A correction opens by rejecting what Cora just did.
const CORRECTION_OPENER = new RegExp(
  [
    "^(?:no|nope|nah|wrong|not that|not quite|that'?s (?:not|wrong)|that is (?:not|wrong)|actually|i said|i meant|i told you|you (?:forgot|missed|didn'?t|did not|should(?:n'?t)?)|that'?s not what|why did you|instead)\\b",
    "^(?:no[,.!]|eso no|as[ií] no|mal\\b|incorrecto|te dije|te he dicho|me refiero|en realidad|realmente no|no es eso|no era eso|olvidaste|te olvidaste|por qu[eé] has)",
    "^(?:non[,.!]|pas [çc]a|nein[,.!]|falsch|n[aã]o[,.!])",
  ].join("|"),
  "i",
);

// What makes a correction reusable: it says what to do instead, or states a
// rule, rather than only pointing at a mistake in this one answer.
const RULE_PATTERN = new RegExp(
  [
    "\\b(?:instead|rather than|should|must|always|never|don'?t|do not|use|prefer|better to|the right way)\\b",
    "\\b(?:en vez de|en lugar de|deber[ií]as|tienes que|hay que|siempre|nunca|no uses|usa|utiliza|mejor)\\b",
    "\\b(?:au lieu de|plut[oô]t|toujours|jamais|statt|immer|nie|em vez de|sempre|nunca)\\b",
  ].join("|"),
  "i",
);

// Signals that a memory is about this repository rather than the user.
const WORKSPACE_PATTERN = new RegExp(
  [
    "`[^`]+`",
    "\\b[\\w.-]+/[\\w./-]+",
    "\\b[\\w-]+\\.(?:ts|tsx|js|jsx|cjs|mjs|json|py|rs|go|md|yml|yaml|toml|css|html|sh|sql|lock)\\b",
    "\\b(?:npm|pnpm|yarn|bun|npx|node|git|make|cargo|pytest|docker|tsc|eslint|prettier|vite|webpack|playwright|jest|vitest)\\b",
    "\\b(?:repo|repository|codebase|this project|this app|branch|commit|tests?|build|deploy|migration|schema|endpoint|component|function|module|package|dependency|dependencies|ci|lint|typecheck)\\b",
    "\\b(?:este proyecto|el repo|el repositorio|la rama|los tests|las pruebas|el build|el despliegue|esta app)\\b",
  ].join("|"),
  "i",
);

// Signals that a memory is about the user and holds everywhere.
const GLOBAL_PATTERN = new RegExp(
  [
    "\\b(?:reply|replies|answer|answers|respond|responses|talk to me|speak|write to me|explain|explanations?|language|english|spanish|french|german|tone|concise|brief|short|verbose|detailed|emojis?|formal|informal|call me|my name|i am|i'm a|timezone|time zone)\\b",
    "\\b(?:resp[oó]ndeme|resp[oó]nde|contesta|h[aá]blame|habla|ingl[eé]s|espa[nñ]ol|castellano|tono|breve|corto|detallado|emojis?|ll[aá]mame|me llamo|mi nombre|soy)\\b",
    "\\b(?:everywhere|in every (?:project|repo|chat)|in all (?:projects|repos|chats)|en todos los proyectos|en todos los chats|en general)\\b",
  ].join("|"),
  "i",
);

const EXPLICIT_WORKSPACE = /\b(?:in this (?:repo|repository|project|workspace|codebase)|en este (?:repo|repositorio|proyecto)|aqu[ií] en este)\b/i;
const EXPLICIT_GLOBAL = /\b(?:everywhere|in every (?:project|repo|chat)|in all (?:projects|repos|chats)|en todos los proyectos|en todos los chats|in general|en general)\b/i;

const LEADING_FILLER = new RegExp(
  [
    "^(?:no|nope|actually|ok(?:ay)?|well|so|and|also|btw|by the way|hey|cora|please|pls)\\b[,.!:;]?\\s*",
    "^(?:remember|don'?t forget|keep in mind|note|for future reference)(?: that)?[,:]?\\s*",
    // A standing rule already holds from now on; the phrase only adds words.
    "^(?:from now on|going forward|from here on|a partir de ahora|de ahora en adelante|desde ahora)\\b[,.!:;]?\\s*",
    "^(?:no|vale|bueno|pues|oye|y|tambi[eé]n|por favor|recuerda(?:lo)?|acu[eé]rdate(?: de)?|ten en cuenta|toma nota|no olvides)(?: que)?\\b[,.!:;]?\\s*",
  ].join("|"),
  "i",
);

function stripCode(message: string): string {
  return message
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .split("\n")
    // Quoted replies, stack frames and log lines are someone else's words.
    .filter((line) => !/^\s*(?:>|at\s+\S+\s+\(|\[\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T)/.test(line))
    .join("\n");
}

/**
 * The part of a message that is the user talking. A long message of several
 * paragraphs is usually a request around pasted material, and that
 * material's "always reply within 24 hours" is its author's rule, not one the
 * user gave Cora: only the first and last paragraphs, where people put their
 * own ask, are read.
 */
function ownWords(body: string): string {
  const paragraphs = body.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (body.length < PASTE_MIN_CHARS || paragraphs.length < PASTE_MIN_PARAGRAPHS) return body;
  return `${paragraphs[0]}\n\n${paragraphs[paragraphs.length - 1]}`;
}

function sentences(text: string): string[] {
  return text
    // Titles and Latin abbreviations end in a period without ending the
    // sentence; "as Dr. Ruiz" must stay one memory.
    .split(/\n+|(?<!\b(?:Dr|Mr|Mrs|Ms|Mx|Sr|Sra|Srta|Prof|St|vs|etc|e\.g|i\.e|approx)\.)(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'`(])/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE_CHARS && sentence.length <= MAX_SENTENCE_CHARS);
}

function cleanMemoryText(sentence: string): string {
  let text = sentence.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(LEADING_FILLER, "").trim();
    if (next === text) break;
    text = next;
  }
  text = text.replace(/^[,.;:\-\s]+/, "");
  if (!text) return "";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?)`"]$/.test(text)) text += ".";
  return text;
}

export function classifyMemoryScope(text: string): MemoryItemScope {
  if (EXPLICIT_WORKSPACE.test(text)) return "workspace";
  if (EXPLICIT_GLOBAL.test(text)) return "global";
  const workspace = WORKSPACE_PATTERN.test(text);
  const personal = GLOBAL_PATTERN.test(text);
  if (workspace && !personal) return "workspace";
  if (personal) return "global";
  // A rule about how Cora works with no repository detail ("never push
  // without asking") is the user's working style, which holds everywhere.
  return "global";
}

function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence) || /^¿/.test(sentence);
}

/**
 * Scan one user message. `followsCoraReply` gates corrections: the first
 * message of a chat cannot correct anything.
 */
export function detectMemorySignals(message: string, context: MemorySignalContext): MemorySignalScan {
  const scan: MemorySignalScan = { candidates: [], sawCorrection: false };
  const body = ownWords(stripCode(message.slice(0, MAX_SCANNED_CHARS)));
  const all = sentences(body);
  // "No." alone is too short to survive as a sentence, yet it is what makes
  // the next sentence a correction.
  const opensWithCorrection = context.followsCoraReply && CORRECTION_OPENER.test(body.trimStart());
  if (opensWithCorrection) scan.sawCorrection = true;
  const seen = new Set<string>();
  const push = (candidate: MemorySignalCandidate) => {
    const key = candidate.text.toLowerCase();
    if (seen.has(key) || scan.candidates.length >= MAX_CANDIDATES_PER_MESSAGE) return;
    seen.add(key);
    scan.candidates.push(candidate);
  };

  all.forEach((sentence, index) => {
    if (containsSecret(sentence)) return;
    const remember = REMEMBER_PATTERN.test(sentence);
    if (remember && !isQuestion(sentence)) {
      const text = cleanMemoryText(sentence);
      if (text.length >= MIN_SENTENCE_CHARS) {
        const scope = classifyMemoryScope(sentence);
        push({
          trigger: "remember",
          kind: scope === "global" && GLOBAL_PATTERN.test(sentence) ? "preference" : "fact",
          scope,
          text,
          quote: sentence,
          confidence: 0.9,
        });
      }
      return;
    }
    const correctionOpening = context.followsCoraReply && index < 2 &&
      (CORRECTION_OPENER.test(sentence) || opensWithCorrection);
    if (correctionOpening) scan.sawCorrection = true;
    if (PREFERENCE_PATTERN.test(sentence) && isDirective(sentence) && !isQuestion(sentence)) {
      const text = cleanMemoryText(sentence);
      if (text.length >= MIN_SENTENCE_CHARS) {
        push({
          trigger: correctionOpening ? "correction" : "preference",
          kind: correctionOpening ? "correction" : "preference",
          scope: classifyMemoryScope(sentence),
          text,
          quote: sentence,
          confidence: correctionOpening ? 0.8 : 0.75,
        });
      }
      return;
    }
    if (correctionOpening && RULE_PATTERN.test(sentence) && !isQuestion(sentence)) {
      const text = cleanMemoryText(sentence);
      if (text.length >= MIN_SENTENCE_CHARS) {
        push({
          trigger: "correction",
          kind: "correction",
          scope: classifyMemoryScope(sentence),
          text,
          quote: sentence,
          // An implicit correction may only apply to the task at hand, so it
          // is kept for relevant turns, not every prompt, until it recurs.
          confidence: 0.55,
        });
      }
    }
  });
  return scan;
}
