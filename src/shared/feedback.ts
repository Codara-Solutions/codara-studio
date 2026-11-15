// Feedback to Codara (the studio-feedback service, docs in its repository as
// docs/feedback-api.md): the rules a report must follow, shared by main (the
// client and the agent tool) and the renderer (the Send feedback dialog), so
// Studio refuses a report the service would refuse before anything is sent.

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackSource = "user" | "agent";

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = { bug: "Bug", idea: "Idea", other: "Other" };

/** Unicode code points, after trimming, as the service counts them. */
export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 254;

/** What the dialog asks main to send. Main adds the version, platform and install id. */
export interface FeedbackDraft {
  kind: FeedbackKind;
  message: string;
  contact?: string | null;
}

export type FeedbackFailure = "invalid" | "rate_limited" | "unavailable" | "timeout" | "offline" | "rejected";

export type FeedbackSendResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error: FeedbackFailure;
      /** One plain sentence for the person or agent. */
      message: string;
      /** The input that was wrong, for `invalid`. */
      field?: string;
      retryAfterSeconds?: number;
    };

/** What the dialog shows in its "what is sent" line. */
export interface FeedbackInfo {
  appVersion: string;
  platform: string;
}

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return (FEEDBACK_KINDS as readonly unknown[]).includes(value);
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

// U+0000 to U+001F except tab, newline and carriage return, U+007F to U+009F,
// and a surrogate without its pair.
const MESSAGE_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const CONTACT_LOCAL_FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f<>()"',;:\\[\]]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const CONTACT_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Null when the message is acceptable, else why not, in plain words. */
export function feedbackMessageProblem(raw: string): string | null {
  const message = raw.trim();
  if (!message) return "Write a message first.";
  const length = codePointLength(message);
  if (length > FEEDBACK_MESSAGE_MAX) {
    return `The message is ${length.toLocaleString("en-US")} characters; the most is ${FEEDBACK_MESSAGE_MAX.toLocaleString("en-US")}.`;
  }
  if (MESSAGE_FORBIDDEN.test(message)) return "The message has control characters in it. Plain text only.";
  return null;
}

/** Null when the contact is empty or a plausible email address. */
export function feedbackContactProblem(raw: string | null | undefined): string | null {
  const contact = (raw ?? "").trim();
  if (!contact) return null;
  const at = contact.indexOf("@");
  const local = contact.slice(0, at);
  const domain = contact.slice(at + 1);
  const ok =
    codePointLength(contact) <= FEEDBACK_CONTACT_MAX &&
    at > 0 &&
    contact.indexOf("@", at + 1) === -1 &&
    codePointLength(local) <= 64 &&
    !CONTACT_LOCAL_FORBIDDEN.test(local) &&
    CONTACT_DOMAIN.test(domain);
  return ok ? null : "That email address does not look right. Leave it empty to send without one.";
}

/** "1 minute", "3 minutes": how long a 429 asks to wait, rounded up. */
export function retryAfterText(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "later";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export type FeedbackAnswer = "yes" | "no";

/** The question an agent's codara_feedback_send waits on. */
export interface FeedbackSendAsk {
  action: "send";
  id: string;
  expiresAt: number;
  /** "Claude Code", "Codex", ...: who is asking. */
  agent: string;
  workspaceName: string | null;
  kind: FeedbackKind;
  /** Exactly what would be sent, trimmed. */
  message: string;
}

export type FeedbackStatus = "open" | "done";

/** A stored report, as the service's admin routes return it. Strangers' text. */
export interface FeedbackItem {
  id: string;
  createdAt: string;
  kind: FeedbackKind;
  source: FeedbackSource;
  message: string;
  appVersion: string;
  platform: string;
  contact: string | null;
  installId: string | null;
  status: FeedbackStatus;
  doneAt: string | null;
}

/** The question an admin's codara_feedback_delete always waits on. */
export interface FeedbackDeleteAsk {
  action: "delete";
  id: string;
  expiresAt: number;
  agent: string;
  workspaceName: string | null;
  /** The item as the service stored it, never as the agent described it. */
  item: Pick<FeedbackItem, "id" | "kind" | "source" | "createdAt" | "status" | "message">;
}

export type FeedbackAsk = FeedbackSendAsk | FeedbackDeleteAsk;
/** A question as an agent's call asks it; the queue adds the id and the deadline. */
export type FeedbackAskInput = Omit<FeedbackSendAsk, "id" | "expiresAt"> | Omit<FeedbackDeleteAsk, "id" | "expiresAt">;

/** What the window may know about the admin token: never the token. */
export interface FeedbackAdminTokenState {
  source: "env" | "saved" | "none";
  /** False when no keyring can encrypt a token on this system. */
  canSave: boolean;
}

export interface FeedbackAskClosed {
  id: string;
  reason: "expired" | "withdrawn";
}
