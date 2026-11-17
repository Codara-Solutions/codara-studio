// Which models Cora's own chat may start a Claude Code or Codex session on.
// Decided here in the main process, from what Studio knows: the run's
// messages as the user wrote them and the user's worker settings. The prompt
// Pi sees mixes in memory, replays of Cora's replies and usage notes that
// name models, so it cannot tell whether the user asked for a model.

import type { AppSettings, HumanRunMessage } from "@shared/types";
import { ALLOWED_WORKER_MODELS } from "@shared/worker-model-roster";

const TOP_TIER_WORD = /\b(?:fable|mythos)\b/i;

/** Whether a model name is the top tier (Fable, Mythos). */
export function isTopTierModel(model: string): boolean {
  return TOP_TIER_WORD.test(model.replace(/[-_.@/]/g, " "));
}

/** A request for the top tier: "use fable", "run it on Mythos". */
const TOP_TIER_REQUEST = /\b(?:use|using|run(?:\s+it)?(?:\s+on)?|with|on|switch(?:\s+it)?\s+to|try)\s+(?:claude[\s-]+)?(?:fable|mythos)\b/gi;
const NEGATION_BEFORE = /\b(?:don'?t|do\s+not|never|not|no|without|avoid|stop)\b[^.!?\n]{0,20}$/i;

/** The user's own words in a note: quoted lines and fenced blocks (a pasted
 *  log, an excerpt) are left out. */
function ownWords(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** Whether a note asks for the top tier, not merely names it. */
export function asksForTopTier(text: string): boolean {
  const words = ownWords(text);
  for (const match of words.matchAll(TOP_TIER_REQUEST)) {
    if (!NEGATION_BEFORE.test(words.slice(0, match.index))) return true;
  }
  return false;
}

/**
 * Whether the user asked for the top tier in this chat: a note they typed in
 * the chat box or on the phone (typedByUser) that asks for it, or the chat's
 * own model picked in the UI. A plan copied in, automation and workflow text,
 * pause notes, chat.send from an agent, memory and Cora's replies never count.
 */
export function userNamedTopTier(messages: readonly HumanRunMessage[], chatModel?: string | null): boolean {
  if (chatModel && isTopTierModel(chatModel)) return true;
  return messages.some(
    (message) =>
      message.author === "user" &&
      message.kind === "note" &&
      message.typedByUser === true &&
      !message.boardNote &&
      !message.resumeNote &&
      !message.compaction &&
      asksForTopTier(message.message),
  );
}

/** Native worker ids the user switched off in Settings. Empty while the
 *  roster was never customized. */
export function disabledWorkerModels(settings: { coraWorkerModels?: AppSettings["coraWorkerModels"] }): Set<string> {
  if (!Array.isArray(settings.coraWorkerModels)) return new Set();
  const enabled = new Set(settings.coraWorkerModels.map((id) => id.trim().toLowerCase().split("@")[0]));
  return new Set(ALLOWED_WORKER_MODELS.map((id) => id.toLowerCase()).filter((id) => !enabled.has(id)));
}

/**
 * Why Cora may not start a session on `model`, or null. Only two rules: the
 * top tier needs the user to have named it in this chat, and an exact model
 * id the user switched off stays off. Aliases such as `opus` (Studio's own
 * default) are never refused.
 */
export function managerSessionModelRefusal(
  model: string | null | undefined,
  context: { messages: readonly HumanRunMessage[]; disabled: ReadonlySet<string>; chatModel?: string | null },
): string | null {
  const name = model?.trim() ?? "";
  if (!name) return null;
  if (isTopTierModel(name) && !userNamedTopTier(context.messages, context.chatModel)) {
    return `Session model ${name} is the top tier, used only when the user asks for it by name. Start the session on a standard model (omit model for Opus).`;
  }
  if (context.disabled.has(name.toLowerCase().split("@")[0])) {
    return `Session model ${name} is switched off in Settings. Omit model, or use a model the user left on.`;
  }
  return null;
}

/** Automatic deliveries a queued message gets before only a user action
 *  delivers it (run-store.ts MAX_AUTOMATIC_DELIVERY_ATTEMPTS). */
export const MAX_AUTOMATIC_DELIVERY_ATTEMPTS = 2;

/** Whether the user queued a message the manager has not received yet. One
 *  stuck past its automatic deliveries does not count, or it would end every
 *  wait after one chunk. */
export function hasQueuedUserInput(messages: readonly HumanRunMessage[]): boolean {
  return messages.some(
    (message) =>
      message.author === "user" &&
      message.deliveryState === "queued" &&
      (message.deliveryAttempts ?? 0) < MAX_AUTOMATIC_DELIVERY_ATTEMPTS &&
      !message.boardNote &&
      !message.resumeNote &&
      !message.compaction,
  );
}
