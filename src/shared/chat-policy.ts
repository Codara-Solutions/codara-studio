import type { ChatMode } from "./types";

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

/**
 * Whether a chat model id belongs to OpenAI. Fast mode is one global setting
 * (AppSettings.openAiFastMode) written by the composer's flash button, and it
 * only means anything on an OpenAI-provider Pi session — Anthropic has no
 * priority tier, so anything that is not a gpt-* id answers false and hides
 * the toggle.
 */
export function chatModelIsOpenAi(model: string | undefined): boolean {
  return model?.trim().toLowerCase().startsWith("gpt-") === true;
}
