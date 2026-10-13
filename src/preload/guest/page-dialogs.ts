/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from "electron";

// alert, confirm and prompt of a Codara browser tab are answered by Codara
// instead of a native message box: main shows them in the tab, lets an agent
// answer through codara_preview_dialog, and applies the tab's policy, so a
// confirm never leaves an agent's session waiting on a box nobody sees (or a
// native box lingering after the protocol answered it). sendSync keeps the
// page blocked until the answer, exactly like the native dialog would.
//
// Only the main frame runs this preload; a dialog from a subframe still goes
// through Chromium and is recorded over the DevTools protocol instead.

const DIALOG_CHANNEL = "preview-guest:dialog";

interface DialogAnswer {
  accepted: boolean;
  text?: string | null;
}

function ask(type: string, message: string, defaultPrompt: string): DialogAnswer {
  try {
    const answer = ipcRenderer.sendSync(DIALOG_CHANNEL, { type, message, defaultPrompt, url: location.href }) as DialogAnswer | null;
    if (answer && typeof answer === "object") return answer;
  } catch {
    /* main gone: behave like a dismissed dialog */
  }
  return { accepted: false, text: null };
}

export function installPageDialogs(): void {
  contextBridge.executeInMainWorld({
    // Serialized into the page's world: it may use only its argument and
    // page globals.
    func: (answer: typeof ask) => {
      const text = (value: unknown) => (value === undefined ? "" : String(value));
      const replacements = {
        alert(message?: unknown): void {
          answer("alert", text(message), "");
        },
        confirm(message?: unknown): boolean {
          return answer("confirm", text(message), "").accepted === true;
        },
        prompt(message?: unknown, defaultValue?: unknown): string | null {
          const fallback = defaultValue === undefined ? "" : String(defaultValue);
          const reply = answer("prompt", text(message), fallback);
          if (!reply.accepted) return null;
          return typeof reply.text === "string" ? reply.text : fallback;
        },
      };
      for (const [name, fn] of Object.entries(replacements)) {
        Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true });
      }
    },
    args: [ask],
  });
}
