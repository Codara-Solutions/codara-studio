import type { ChatBackendKind, ChatMode } from "./types";

/**
 * The chat mode a run actually dispatches under. There is no mode selector: an
 * ordinary chat is always Auto, and the Automations hub owns the only other
 * persona. Runs stamped "talk" / "plan" / "execute" by an older build still
 * load; they collapse to Auto here so a legacy chat can never strand the user
 * in a mode the UI no longer offers.
 */
export function effectiveChatMode(mode: ChatMode | undefined): ChatMode {
  return mode === "automation" ? "automation" : "auto";
}

export interface ChatFeatureFlags {
  chat1mContext?: boolean;
}

export interface NormalizedChatFeatureFlags {
  chat1mContext: boolean;
}

// Fast mode is one global setting (AppSettings.openAiFastMode), not a per-chat
// flag: the composer's flash button writes it, and the old per-chat pill's
// chatFastMode write path is gone.
// These two helpers remain because resolveChatBackendConfig still decides, per
// backend, whether the Settings value means anything for that session.
export function chatBackendSupportsFastMode(backend: ChatBackendKind): boolean {
  return backend === "codex";
}

/**
 * Whether a chat model id belongs to OpenAI. The composer's fast-mode toggle
 * is the only OpenAI-gated control: Anthropic fast mode must never exist, so
 * anything that is not a gpt-* id answers false.
 */
export function chatModelIsOpenAi(model: string | undefined): boolean {
  return model?.trim().toLowerCase().startsWith("gpt-") === true;
}

export function effectiveChatFastMode(
  backend: ChatBackendKind,
  requested: boolean | undefined,
): boolean {
  return chatBackendSupportsFastMode(backend) && requested === true;
}

export function effectiveChatOneMillionContext(backend: ChatBackendKind): boolean {
  return backend === "claude";
}

export function normalizeChatFeatureFlags(
  backend: ChatBackendKind,
  flags: ChatFeatureFlags,
): NormalizedChatFeatureFlags {
  return {
    chat1mContext: effectiveChatOneMillionContext(backend),
  };
}
