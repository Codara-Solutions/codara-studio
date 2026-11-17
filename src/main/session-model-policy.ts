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

/** Whether the user's own notes in this chat name the top tier. Synthetic
 *  notes (board, resume, compaction) and anything Cora wrote do not count. */
export function userNamedTopTier(messages: readonly HumanRunMessage[]): boolean {
  return messages.some(
    (message) =>
      message.author === "user" &&
      message.kind === "note" &&
      !message.boardNote &&
      !message.resumeNote &&
      !message.compaction &&
      TOP_TIER_WORD.test(message.message),
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
  context: { messages: readonly HumanRunMessage[]; disabled: ReadonlySet<string> },
): string | null {
  const name = model?.trim() ?? "";
  if (!name) return null;
  if (isTopTierModel(name) && !userNamedTopTier(context.messages)) {
    return `Session model ${name} is the top tier, used only when the user asks for it by name. Start the session on a standard model (omit model for Opus).`;
  }
  if (context.disabled.has(name.toLowerCase().split("@")[0])) {
    return `Session model ${name} is switched off in Settings. Omit model, or use a model the user left on.`;
  }
  return null;
}

/** Whether the user queued a message the manager has not received yet. */
export function hasQueuedUserInput(messages: readonly HumanRunMessage[]): boolean {
  return messages.some(
    (message) =>
      message.author === "user" &&
      message.deliveryState === "queued" &&
      !message.boardNote &&
      !message.resumeNote &&
      !message.compaction,
  );
}
