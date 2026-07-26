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
  chatFastMode?: boolean;
  chat1mContext?: boolean;
}

export interface NormalizedChatFeatureFlags {
  chatFastMode: boolean;
  chat1mContext: boolean;
}

export function chatBackendSupportsFastMode(backend: ChatBackendKind): boolean {
  return backend === "codex";
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
    chatFastMode: effectiveChatFastMode(backend, flags.chatFastMode),
    chat1mContext: effectiveChatOneMillionContext(backend),
  };
}
