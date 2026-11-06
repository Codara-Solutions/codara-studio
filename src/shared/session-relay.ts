// A message an outside assistant (or any caller of session.relay) asks to
// send to a session it did not start. Nothing is delivered until the user
// presses Send on the notification; the text is untrusted, so it is only ever
// shown as text and typed into the target as one pasted prompt. Pure, so
// scripts/test-session-relay.cjs loads it without the app.

export const RELAY_TEXT_MAX_CHARS = 4_000;
export const RELAY_SENDER_MAX_CHARS = 40;
export const RELAY_REASON_MAX_CHARS = 300;
export const RELAY_MAX_PENDING = 20;
export const RELAY_TTL_MS = 24 * 60 * 60 * 1000;
export const RELAY_LOG_PREVIEW_CHARS = 200;
/** Only these CLIs take a pasted prompt the way Studio's own submit path sends it. */
export const RELAY_RUNTIMES: readonly string[] = ["claude", "codex"];

export type RelayOutcome = "sent" | "dismissed" | "expired" | "undeliverable";
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

export interface PendingRelay {
  id: string;
  sender: string;
  reason: string | null;
  text: string;
  target: RelayTarget;
  createdAt: number;
  expiresAt: number;
}

export interface RelayRequest {
  target: string;
  text: string;
  sender: string;
  reason: string | null;
}

// C0 and C1 controls (tab and newline kept) and the bidirectional overrides
// that can make the text on the approval card read differently from the bytes
// that would be sent.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** The text as it will be shown and sent: the same bytes in both places. */
export function cleanRelayText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "").trim();
}

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

export function parseRelayRequest(params: Record<string, unknown>): RelayRequest | string {
  const target = typeof params.target === "string" ? params.target.trim() : "";
  if (!target) return "target is required: a session id from codara_session_list_all";
  if (typeof params.text !== "string") return "text is required";
  if (params.text.length > RELAY_TEXT_MAX_CHARS) return `text is limited to ${RELAY_TEXT_MAX_CHARS} characters`;
  const text = cleanRelayText(params.text);
  if (!text) return "text is required";
  if (typeof params.sender !== "string") return "sender is required: a short name for who is asking, such as Grok Bot";
  const sender = cleanRelaySender(params.sender);
  if (!sender) return "sender must contain letters or digits";
  let reason: string | null = null;
  if (params.reason !== undefined && params.reason !== null) {
    if (typeof params.reason !== "string") return "reason must be a string";
    if (params.reason.length > RELAY_REASON_MAX_CHARS) return `reason is limited to ${RELAY_REASON_MAX_CHARS} characters`;
    reason = cleanRelayText(params.reason).replace(/\s+/g, " ") || null;
  }
  return { target, text, sender, reason };
}

/**
 * What the target receives as a new user turn. The prefix also keeps the text
 * from opening with a character the CLI treats as a command ("/", "!", "#").
 */
export function relayPrompt(relay: Pick<PendingRelay, "sender" | "text">): string {
  return `[Relayed from ${relay.sender}, approved by you] ${relay.text}`;
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
