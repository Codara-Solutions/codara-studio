import type { ChatBackendKind } from "./types";

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
