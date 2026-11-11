// A message an outside assistant (or any caller of session.relay) asks to
// send to a session it did not start. Nothing is delivered until the user
// presses Send on the notification; the text is untrusted, so it is only ever
// shown as text and typed into the target as one pasted prompt. The one
// exception is an answer (mode "answer"): a short reply the user gave the
// outside assistant on their phone, typed in without Send only under every
// rule in relayAnswerTargetRefusal and SessionRelays.answerRefusal. Pure, so
// scripts/test-session-relay.cjs loads it without the app.

export const RELAY_TEXT_MAX_CHARS = 4_000;
export const RELAY_SENDER_MAX_CHARS = 40;
export const RELAY_REASON_MAX_CHARS = 300;
export const RELAY_MAX_PENDING = 20;
/** One caller cannot fill every slot. */
export const RELAY_MAX_PENDING_PER_CALLER = 5;
export const RELAY_TTL_MS = 24 * 60 * 60 * 1000;
export const RELAY_LOG_PREVIEW_CHARS = 200;
/** Only these CLIs take a pasted prompt the way Studio's own submit path sends it. */
export const RELAY_RUNTIMES: readonly string[] = ["claude", "codex"];

/** An answer is typed in without Send, so it is short. */
export const RELAY_ANSWER_MAX_CHARS = 500;
/** Answers typed in without Send, across all sessions, per rolling hour. */
export const RELAY_ANSWERS_PER_HOUR = 10;
export const RELAY_ANSWER_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_RELAY_ANSWER_ASSISTANT = "Grok Bot";

export type RelayOutcome = "sent" | "dismissed" | "expired" | "undeliverable" | "answered";
/** "ask" waits for Send; "answer" may be typed in at once (see the header). */
export type RelayMode = "ask" | "answer";
export type RelayDecision = "send" | "dismiss";

export interface RelayTarget {
  /** The pane id, as session.list_all names it. */
  id: string;
  title: string;
  workspaceId: string;
  workspace: string;
  runtime: string;
  /** When the agent now in the pane started: a new agent there is a new session. */
  sessionSince: number;
}

/** The pane still holds the session the user was shown, in the same workspace. */
export function sameRelayTarget(a: RelayTarget, b: RelayTarget): boolean {
  return a.id === b.id && a.runtime === b.runtime && a.workspaceId === b.workspaceId && a.sessionSince === b.sessionSince;
}

/** Who really called, as Codara saw it: the sender name is only what it claims. */
export interface RelayCaller {
  /** Groups one caller's relays: "pane:<id>", "run:<id>", "process:<...>" or "outside". */
  key: string;
  /** "an agent in api · shell", "a Cora chat in api", "outside Codara". */
  label: string;
}

export const RELAY_OUTSIDE_CALLER: RelayCaller = { key: "outside", label: "outside Codara" };

export interface PendingRelay {
  id: string;
  sender: string;
  caller: RelayCaller;
  reason: string | null;
  text: string;
  target: RelayTarget;
  createdAt: number;
  expiresAt: number;
}

/**
 * Whether the kernel showed the caller to run outside Codara's own process
 * tree (session-relay/caller-peer.ts). Only the agent socket sets it, after
 * that check; anything parsed from the request starts unverified.
 */
export type RelayAnswerCaller = { verified: true } | { verified: false; why: string; inside?: boolean };

export interface RelayRequest {
  target: string;
  text: string;
  sender: string;
  reason: string | null;
  caller: RelayCaller;
  mode: RelayMode;
  answerCaller: RelayAnswerCaller;
}

// C0 and C1 controls (tab and newline kept) and the bidirectional overrides
// that can make the text on the approval card read differently from the bytes
// that would be sent.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

// Characters that draw nothing on the approval card but still reach the agent,
// so they could carry instructions the user never saw: every format character
// (zero-width spaces and joiners, word joiners, the BOM, bidi marks and
// isolates, Unicode tags U+E0000-E007F), blank letters, the supplementary
// variation selectors and runs of ordinary ones (one after an emoji is normal),
// and every other default-ignorable character (a combining grapheme joiner,
// Mongolian variation selectors, fillers).
const INVISIBLE_CHARS =
  /[\p{Cf}\u115f\u1160\u3164\uffa0\u{e0100}-\u{e01ef}]|(?![\ufe00-\ufe0f])\p{Default_Ignorable_Code_Point}|[\ufe00-\ufe0f]{2,}/u;

export function hasInvisibleRelayChars(raw: string): boolean {
  return INVISIBLE_CHARS.test(raw);
}

/** The text as it will be shown and sent: the same bytes in both places. */
export function cleanRelayText(raw: string): string {
  return raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(UNSAFE_CHARS, "").trim();
}

// Names that would read as the user or Codara itself on the card and in the
// "[Relayed from ...]" prefix.
const RESERVED_SENDERS = new Set(["you", "me", "user", "etienne", "codara", "codara studio", "studio", "system"]);

/**
 * A short plain label: letters, digits, spaces and . _ ' -. Anything else
 * (brackets above all, which would forge the "[Relayed from ...]" prefix)
 * goes.
 */
export function cleanRelaySender(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N} ._'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, RELAY_SENDER_MAX_CHARS)
    .trim();
}

// The wording of the answer prefix, compared on letters only.
const ANSWER_WORDING = [" answer from the user sent from ", " not typed in studio "];

// Letters that look like plain Latin ones, mapped to the Latin letter they
// pass for. A deliberate subset of the Unicode confusables list (Cyrillic,
// Greek, Armenian, Cherokee and Latin small capitals and variants), enough to keep the prefix wording
// from being spelt in look-alikes; it only decides what to compare, never
// what is refused.
const LOOK_ALIKES: Record<string, string> = Object.fromEntries(
  [
    // Cyrillic
    "АA ВB ЕE ЅS ІI ЈJ КK МM НH ОO РP СC ТT УY ХX Ԁd Ԛq Ԝw Һh Ӏl ЁE ЇI",
    "аa вb еe ѕs іi јj кk мm нh оo рp сc тt уy хx ԁd ԛq ԝw һh ӏl ёe їi пn гr ьb шw үy",
    // Greek
    "ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX αa βb γy εe ηn ιi κk μu νv οo ρp τt υu χx ωw",
    // Armenian
    "ՍU ՕO ՏS ԼL ՀH ԳQ օo սu ոn հh ցg քp զq աw յj լl ռn",
    // Cherokee (small letters are raised to these first)
    "ᎪA ᏴB ᏟC ᎠD ᎬE ᏀG ᎻH ᎥI ᎫJ ᏦK ᏞL ᎷM ᏒR ᏚS ᎢT ᏙV ᏔW ᏃZ ᏢP ᎳW ᏂH",
    // Latin letters that pass for others: small capitals, alpha, dotless i and j
    "ᴀa ʙb ᴄc ᴅd ᴇe ɢg ʜh ɪi ᴊj ᴋk ʟl ᴍm ɴn ᴏo ᴘp ʀr ꜱs ᴛt ᴜu ᴠv ᴡw ʏy ᴢz ɑa ɡg ɩi ıi ȷj",
  ]
    .join(" ")
    .split(/\s+/)
    .filter((pair) => [...pair].length === 2)
    .map((pair) => [...pair] as [string, string]),
);

function latinShape(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const raised = code >= 0xab70 && code <= 0xabbf ? char.toUpperCase() : char;
  return LOOK_ALIKES[raised] ?? char;
}

/**
 * The skeleton every comparison with the answer prefix's wording uses:
 * compatibility forms decomposed (NFKD), every combining mark (accents) and
 * every format or default-ignorable character removed, look-alike letters
 * read as the Latin letter they pass for, lowercased, and letters only, one
 * space between words and around the whole.
 */
export function relayPrefixSkeleton(raw: string): string {
  const bare = raw.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  const words = Array.from(bare, latinShape).join("").toLowerCase().split(/\P{L}+/u).filter(Boolean);
  return ` ${words.join(" ")} `;
}

/**
 * Why a text could pass for the answer prefix, or null: its skeleton
 * contains the wording. Other text in any alphabet passes untouched.
 */
export function relayAnswerForgery(raw: string): string | null {
  const skeleton = relayPrefixSkeleton(raw);
  return ANSWER_WORDING.some((phrase) => skeleton.includes(phrase))
    ? "text cannot contain the wording of the answer prefix"
    : null;
}

export function parseRelayRequest(params: Record<string, unknown>): RelayRequest | string {
  const mode = params.mode === undefined || params.mode === null ? "ask" : params.mode;
  if (mode !== "ask" && mode !== "answer") return 'mode must be "ask" or "answer"';
  const target = typeof params.target === "string" ? params.target.trim() : "";
  if (!target) return "target is required: a session id from codara_session_list_all";
  if (typeof params.text !== "string") return "text is required";
  if (params.text.length > RELAY_TEXT_MAX_CHARS) return `text is limited to ${RELAY_TEXT_MAX_CHARS} characters`;
  const hidden = (field: string) =>
    `${field} contains invisible characters (zero-width, bidi, tag or blank characters); send plain text only`;
  if (hasInvisibleRelayChars(params.text)) return hidden("text");
  const text = cleanRelayText(params.text);
  if (!text) return "text is required";
  const forged = relayAnswerForgery(text);
  if (forged) return forged;
  if (typeof params.sender !== "string") return "sender is required: a short name for who is asking, such as Grok Bot";
  if (hasInvisibleRelayChars(params.sender)) return hidden("sender");
  const sender = cleanRelaySender(params.sender);
  if (!sender) return "sender must contain letters or digits";
  if (RESERVED_SENDERS.has(sender.toLowerCase().replace(/[ ._'-]+/g, " ").trim())) {
    return `sender cannot be "${sender}": name the assistant that is asking, such as Grok Bot`;
  }
  let reason: string | null = null;
  if (params.reason !== undefined && params.reason !== null) {
    if (typeof params.reason !== "string") return "reason must be a string";
    if (params.reason.length > RELAY_REASON_MAX_CHARS) return `reason is limited to ${RELAY_REASON_MAX_CHARS} characters`;
    if (hasInvisibleRelayChars(params.reason)) return hidden("reason");
    reason = cleanRelayText(params.reason).replace(/\s+/g, " ") || null;
  }
  return {
    target,
    text,
    sender,
    reason,
    caller: RELAY_OUTSIDE_CALLER,
    mode,
    answerCaller: { verified: false, why: "Codara did not check where the call came from" },
  };
}

/**
 * What the target receives as a new user turn. The prefix also keeps the text
 * from opening with a character the CLI treats as a command ("/", "!", "#").
 */
export function relayPrompt(relay: Pick<PendingRelay, "sender" | "text">): string {
  return `[Relayed from ${relay.sender}, approved by you] ${relay.text}`;
}

/**
 * What the target receives for an answer. Nothing else can produce it: the
 * sender cannot hold brackets, and parseRelayRequest refuses any text that
 * repeats its wording.
 */
export function relayAnswerPrompt(relay: Pick<PendingRelay, "sender" | "text">): string {
  return `[Answer from the user, sent from their phone through ${relay.sender}; not typed in Studio] ${relay.text}`;
}

/** The setting's name and the claimed sender, compared as the card shows them. */
export function sameRelayAssistant(sender: string, saved: string): boolean {
  const norm = (name: string) => cleanRelaySender(name).toLowerCase();
  return norm(saved) !== "" && norm(sender) === norm(saved);
}

/** What the terminal notifier knows about the agent in a pane (terminalAgentAnswerEvidence). */
export interface RelayAnswerEvidence {
  runtime: string | null;
  /** The agent's process runs (it is not asleep and its terminal is open). */
  running: boolean;
  /** Claude Code hooks feed this pane: PreToolUse and PostToolUse count open tool calls. */
  hooks: boolean;
  /** The CLI reports its own state (OSC 7501): working, blocked, idle, done. */
  programStatus: boolean;
  programState: string | null;
  /** The notifier's state and the chip it shows. */
  state: string;
  chipState: string | null;
  turnActive: boolean;
  pendingDone: boolean;
  pendingToolCalls: number;
  backgroundRunning: number;
  teammatesActive: number;
  codexAwaitingIdle: boolean;
  lastTurnStartedAt: number;
  /**
   * The last turn's end, as the notifier announced it, and the signal that
   * ended it: "hook" (Claude Code's Stop hook), "codex" (Codex's notify
   * program or session file), "program" (an OSC 7501 status report), ...
   */
  lastTurnEnd: { at: number; failed: boolean; origin: string | null } | null;
  lastUserInputAt: number;
  /** The last of those keys that was Enter: a key after it may be unsent text. */
  lastSubmitAt: number;
}

const AT_PROMPT = new Set(["idle", "done"]);

/**
 * Why an answer cannot be typed into this session right now, or null when it
 * sits idle at its prompt after a finished turn with nothing typed. A typed
 * line in a permission prompt, a question or any other dialog of the CLI can
 * be a choice, so every unclear case refuses: the session must report its
 * state through a channel the CLI itself feeds (Claude Code hooks or status
 * reports, Codex status reports), not the screen.
 */
export function relayAnswerTargetRefusal(evidence: RelayAnswerEvidence | null): string | null {
  if (!evidence) return "Codara cannot see that session's state";
  if (!RELAY_RUNTIMES.includes(evidence.runtime ?? "")) return "only Claude Code and Codex sessions take answers";
  if (!evidence.running) return "its agent is not running";
  const trusted = evidence.programStatus || (evidence.runtime === "claude" && evidence.hooks);
  if (!trusted) return "its CLI does not report its own state, so Codara cannot tell its prompt from a dialog";
  if (evidence.programStatus && !AT_PROMPT.has(evidence.programState ?? "")) return "it is not idle at its prompt";
  if (evidence.state !== "idle" || !AT_PROMPT.has(evidence.chipState ?? "")) return "it is not idle at its prompt";
  if (evidence.turnActive || evidence.pendingDone || evidence.codexAwaitingIdle) return "its turn has not ended";
  if (evidence.pendingToolCalls > 0) return "a tool call is open, which may be a permission or question dialog";
  if (evidence.backgroundRunning > 0 || evidence.teammatesActive > 0) return "work it started is still running";
  const end = evidence.lastTurnEnd;
  if (!end || end.at < evidence.lastTurnStartedAt) return "it has not finished a turn it could be waiting on";
  if (end.failed) return "its last turn failed";
  // An OSC 7501 report is read from the pane's output, which any process of
  // the user can write to (its /dev/pts): a forged "done" over a permission
  // prompt must not let an answer press Enter on it. A hook or Codex's
  // notify program is a separate channel.
  if (end.origin !== "hook" && end.origin !== "codex") {
    return "its turn's end was reported only in its terminal output, which Codara cannot trust for this";
  }
  // Any key since the turn began: an answered prompt, a queued message, a
  // menu opened while the end was being confirmed, or unsent text. The user
  // pressing keys in the tab is not away anyway.
  if (
    evidence.lastUserInputAt > evidence.lastTurnStartedAt ||
    evidence.lastUserInputAt >= end.at ||
    evidence.lastUserInputAt > evidence.lastSubmitAt
  ) {
    return "something was typed in its tab since its last turn began";
  }
  return null;
}

/**
 * One line for a native notification and the log. Some Linux notification
 * servers read markup in a body, so its characters are swapped for lookalikes.
 */
export function relayPreview(text: string, max = RELAY_LOG_PREVIEW_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim().replace(/</g, "‹").replace(/>/g, "›").replace(/&/g, "＆");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const relaySourceKey = (relayId: string): string => `relay:${relayId}`;

export function relayIdOfSource(sourceKey: string): string | null {
  return sourceKey.startsWith("relay:") ? sourceKey.slice("relay:".length) : null;
}
