// Window events that open the quick command surfaces, so the tab strip
// button, the keyboard command and the terminal menu reach the host App
// renders once without prop drilling (the house cross-module pattern).

export const QUICK_COMMANDS_EVENT = "spark:quick-commands";

export type QuickCommandsRequest =
  | { action: "palette" }
  | { action: "add" }
  | { action: "edit"; id: string };

export function requestQuickCommands(detail: QuickCommandsRequest): void {
  window.dispatchEvent(new CustomEvent<QuickCommandsRequest>(QUICK_COMMANDS_EVENT, { detail }));
}

/** Settings, on the Quick commands page. */
export function openQuickCommandSettings(): void {
  window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "quick-commands" } }));
}
