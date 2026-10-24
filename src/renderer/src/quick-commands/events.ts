// Window events that open the quick command surfaces, so the tab strip
// button, the keyboard command and the terminal menu reach the host App
// renders once without prop drilling (the house cross-module pattern).

export const QUICK_COMMANDS_EVENT = "spark:quick-commands";

// returnFocus: where the keyboard goes back when the add or edit dialog
// closes. A menu that opens the dialog closes in the same click, so it names
// what it came from (the terminal, the tab bar button).
export type QuickCommandsRequest =
  | { action: "palette" }
  | { action: "add"; returnFocus?: HTMLElement | null }
  | { action: "edit"; id: string; returnFocus?: HTMLElement | null };

export function requestQuickCommands(detail: QuickCommandsRequest): void {
  window.dispatchEvent(new CustomEvent<QuickCommandsRequest>(QUICK_COMMANDS_EVENT, { detail }));
}

/** Settings, on the Quick commands page. */
export function openQuickCommandSettings(): void {
  window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "quick-commands" } }));
}
