// Page dialogs of Codara's own browser tabs (recorders/dialogs.ts holds the
// state). The tab's preload hands alert/confirm/prompt to main over a
// synchronous IPC (src/preload/guest/page-dialogs.ts); main answers when the
// user, an agent or the tab's policy does. beforeunload is decided here from
// Electron's will-prevent-unload, which cannot wait for anyone.

import { ipcMain, type IpcMainEvent, type WebContents } from "electron";

import { isTrustedPreviewGuest, onTrustedPreviewGuestAttached } from "../main-window-trust";
import { requestPreviewOp } from "../preview-bridge";
import type { CdpSession } from "./cdp-session";
import { pageActivity } from "./page-activity";
import { previewCdpSession, previewTabOfGuest } from "./preview-cdp";
import { dialogState, setDialogPresenter, type PageDialogType } from "./recorders/dialogs";

const DIALOG_CHANNEL = "preview-guest:dialog";
const PAGE_TYPES = new Set<PageDialogType>(["alert", "confirm", "prompt"]);
const SHOW_MARGIN_MS = 10_000;
const AGENT_UNLOAD_WINDOW_MS = 3_000;

const guestOfSession = new WeakMap<CdpSession, WebContents>();

function onPageDialog(event: IpcMainEvent, payload: unknown): void {
  let replied = false;
  let detach = () => {};
  const reply = (value: { accepted: boolean; text: string | null }) => {
    if (replied) return;
    replied = true;
    detach();
    event.returnValue = value;
  };
  const sender = event.sender;
  const fields = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const type = fields.type as PageDialogType;
  if (sender.getType() !== "webview" || !isTrustedPreviewGuest(sender) || event.senderFrame?.parent || !PAGE_TYPES.has(type)) {
    reply({ accepted: false, text: null });
    return;
  }
  const session = previewCdpSession(sender);
  guestOfSession.set(session, sender);
  const state = dialogState(session);
  const dialog = state.add({
    type,
    message: typeof fields.message === "string" ? fields.message : "",
    defaultPrompt: typeof fields.defaultPrompt === "string" ? fields.defaultPrompt : "",
    url: typeof fields.url === "string" ? fields.url : sender.getURL(),
    source: "page",
  }, (answer) => reply({ accepted: answer.accept, text: answer.promptText ?? null }));
  if (replied) return;
  // The page is going away: its dialog goes with it, as a native one would.
  const release = () => {
    state.closed(dialog.id);
    reply({ accepted: false, text: null });
  };
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) release();
  };
  const onDestroyed = () => state.closed(dialog.id);
  sender.on("did-start-navigation", onNavigation);
  sender.on("render-process-gone", release);
  sender.on("destroyed", onDestroyed);
  // A page that keeps opening dialogs must not pile up listeners on its guest.
  detach = () => {
    if (sender.isDestroyed()) return;
    sender.removeListener("did-start-navigation", onNavigation);
    sender.removeListener("render-process-gone", release);
    sender.removeListener("destroyed", onDestroyed);
  };
}

function onBeforeUnload(guest: WebContents, event: Electron.Event): void {
  const session = previewCdpSession(guest);
  const state = dialogState(session);
  const { action } = state.policy;
  // Electron gives no way to wait for an answer here. Under the default ask
  // policy the page is left when an agent caused the unload (a call is
  // running, or one just asked to navigate: the tab's navigate returns
  // before the page starts unloading), and kept otherwise, as Electron
  // always did.
  const agentCaused = state.agentCallInFlight || Date.now() - pageActivity(session).lastActionAt < AGENT_UNLOAD_WINDOW_MS;
  const leave = action === "accept" || (action === "ask" && agentCaused);
  if (leave) event.preventDefault();
  state.note({ type: "beforeunload", message: "", accepted: leave, by: "policy" });
}

let registered = false;

export function registerPreviewDialogs(): void {
  if (registered) return;
  registered = true;
  // Ungated by the main-window sender gate on purpose (ON_OPT_OUT in
  // scripts/test-ipc-gate-default.cjs): the sender is a preview guest, which
  // that gate refuses. onPageDialog admits only a real guest's top frame, and
  // a guest can only open a dialog of its own page.
  ipcMain.on(DIALOG_CHANNEL, onPageDialog);
  onTrustedPreviewGuestAttached((guest) => {
    guest.on("will-prevent-unload", (event) => onBeforeUnload(guest, event));
  });
  setDialogPresenter({
    async show(session, dialog) {
      // Chrome shows its own dialogs, and a subframe's dialog is Electron's
      // native box; only the main-frame dialogs Codara holds need a face.
      const guest = dialog.source === "page" ? guestOfSession.get(session) : undefined;
      if (!guest || guest.isDestroyed()) return null;
      const policy = dialogState(session).policy;
      const answer = await requestPreviewOp<{ accept?: unknown; promptText?: unknown } | null>(
        "dialog_show",
        { dialog: { ...dialog, tabId: previewTabOfGuest(guest.id) ?? "", webContentsId: guest.id } },
        { timeoutMs: policy.autoMs + SHOW_MARGIN_MS },
      ).catch(() => null);
      if (!answer || typeof answer.accept !== "boolean") return null;
      return { accept: answer.accept, ...(typeof answer.promptText === "string" ? { promptText: answer.promptText } : {}) };
    },
    hide(_session, dialog) {
      if (dialog.source === "page") void requestPreviewOp("dialog_hide", { id: dialog.id }).catch(() => {});
    },
  });
}
