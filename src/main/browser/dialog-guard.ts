// Every browser tool call goes through guardPageDialogs (preview-tools/
// index.ts), so a page dialog never leaves an agent waiting:
//
// - While a dialog is open the page runs no script, so a call that needs
//   the page fails at once and says which dialog to answer.
// - A call that opens a dialog (a click on "Delete") returns as soon as the
//   dialog shows, with the dialog in its result, instead of hanging until
//   someone answers it.
// - Every result carries the dialogs still open and the ones answered since
//   the agent last heard (by the user, or by the tab's policy).

import { callTarget } from "./agent-action";
import type { CdpSession } from "./cdp-session";
import { describeDialog, dialogState, type DialogState, type PageDialog } from "./recorders/dialogs";

// Methods that never need the page, so they neither resolve a tab nor wait.
// preview.code runs many calls, each guarded on its own.
const UNGUARDED = new Set(["preview.list", "preview.inbox", "preview.url", "preview.code"]);
// Methods that still work while a dialog holds the page. A navigation drops
// the dialog with the page, as in a browser; a navigate without a tabId may
// also be about to open the caller's own tab rather than the one resolved here.
const ALLOWED_WHILE_OPEN = new Set(["preview.dialog", "preview.console", "preview.network", "preview.navigate"]);

function blockedResult(open: PageDialog[]): Record<string, unknown> {
  const first = open[0];
  const what = first.type === "beforeunload" ? "a leave-page (beforeunload) dialog" : `a ${first.type} dialog${first.message ? ` "${first.message.slice(0, 120)}"` : ""}`;
  return {
    ok: false,
    error: `The page is showing ${what} and runs nothing until it is answered. Answer it with codara_preview_dialog (accept true or false).`,
    dialogs: open.map(describeDialog),
  };
}

/** Add the tab's dialog news to a result object (a result that lists open dialogs itself passes includeOpen false). */
export function withDialogNews(value: unknown, state: DialogState, includeOpen = true): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const open = includeOpen ? state.pending() : [];
  const answered = state.takeUnreported();
  if (!open.length && !answered.length) return value;
  return {
    ...(value as Record<string, unknown>),
    ...(open.length ? { dialogs: open.map(describeDialog) } : {}),
    ...(answered.length ? { dialogsAnswered: answered.map(({ id: _id, ...rest }) => rest) } : {}),
  };
}

export async function guardPageDialogs(
  method: string,
  params: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (!method.startsWith("preview.") || UNGUARDED.has(method)) return run();
  const target = await callTarget(params);
  if (!target) return run();
  const session: CdpSession = target.session;
  const state = dialogState(session);
  if (method === "preview.dialog") return run();
  const open = state.pending();
  if (open.length && !ALLOWED_WHILE_OPEN.has(method)) return withDialogNews(blockedResult(open), state, false);
  const end = state.callStarted();
  let stopWatching = () => {};
  const opened = new Promise<PageDialog>((resolve) => {
    stopWatching = state.onOpen(resolve);
  });
  try {
    const running = run();
    const first = await Promise.race([
      running.then((value) => ({ value })),
      opened.then((dialog) => ({ dialog })),
    ]);
    if ("dialog" in first) {
      // The action itself is still blocked inside the page; its eventual
      // result is no longer anyone's to read.
      running.catch(() => {});
      return withDialogNews({
        ok: true,
        note: `The page opened a ${first.dialog.type} dialog and is paused until it is answered: call codara_preview_dialog.`,
      }, state);
    }
    return withDialogNews(first.value, state);
  } finally {
    stopWatching();
    end();
  }
}
