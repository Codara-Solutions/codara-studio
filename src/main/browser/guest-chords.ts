import type { WebContents } from "electron";

// Forward chord keystrokes (Ctrl/Cmd/Alt/Meta + key) from a <webview> guest
// back to its host renderer so app-wide shortcuts (Ctrl+1, Ctrl+P Quick
// Open, ...) keep working when focus is inside the embedded page. Listening
// on the webContents is the only place this fires: the webview tag in the
// host renderer does not emit before-input-event. The host preload turns the
// forwarded payload into a synthetic KeyboardEvent dispatched on window.
export function forwardGuestChords(contents: WebContents): void {
  contents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const mods = input.modifiers ?? [];
    const hasChord =
      mods.includes("control") ||
      mods.includes("alt") ||
      mods.includes("meta");
    if (!hasChord) return;
    if (!input.key) return;
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) return;
    host.send("webview:chord-key", {
      key: input.key,
      code: input.code,
      modifiers: mods,
    });
  });
}
