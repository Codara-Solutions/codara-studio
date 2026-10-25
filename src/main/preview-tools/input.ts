// Trusted input, sent by main straight to the guest (../preview-input.ts).
// press_key lives here too: it uses trusted input when a guest resolves and
// falls back to the renderer's synthetic event when it cannot. Page dialogs
// (alert, confirm, prompt, beforeunload) are answered here as well.

import { describeDialog, dialogState, normalizeDialogPolicy } from "../browser/recorders/dialogs";
import { handlePreviewInputOp, type PreviewInputOp } from "../preview-input";
import { acting, requireTarget } from "./core";
import { PreviewToolParamsError, type PreviewToolHandler, type PreviewToolTable } from "./types";

export function inputOp(op: PreviewInputOp): PreviewToolHandler {
  return (params) => handlePreviewInputOp(op, params);
}

async function dialog(params: Record<string, unknown>): Promise<unknown> {
  const target = await requireTarget(params);
  const state = dialogState(target.session);
  if (params.policy !== undefined || params.autoMs !== undefined) {
    if (params.policy !== undefined && params.policy !== "ask" && params.policy !== "accept" && params.policy !== "dismiss") {
      throw new PreviewToolParamsError("policy must be ask, accept or dismiss.");
    }
    state.policy = normalizeDialogPolicy({ action: params.policy, autoMs: params.autoMs }, state.policy);
  }
  const answered = state.takeUnreported().map(({ id: _id, ...rest }) => rest);
  const news = answered.length ? { dialogsAnswered: answered } : {};
  if (typeof params.accept !== "boolean") {
    return { ok: true, dialogs: state.pending().map(describeDialog), policy: state.policy, ...news };
  }
  const open = state.pending();
  const chosen = typeof params.id === "string" ? open.find((entry) => entry.id === params.id) : open[0];
  if (!chosen) return { ok: false, error: "No dialog is open on this tab.", policy: state.policy, ...news };
  const promptText = typeof params.promptText === "string" ? params.promptText : undefined;
  await state.answer(chosen.id, { accept: params.accept, promptText }, "agent");
  return {
    ok: true,
    answered: {
      type: chosen.type,
      message: chosen.message,
      accepted: params.accept,
      ...(chosen.type === "prompt" && params.accept ? { promptText: promptText ?? chosen.defaultPrompt } : {}),
    },
    dialogs: state.pending().map(describeDialog),
    ...news,
  };
}

export const inputPreviewTools: PreviewToolTable = {
  "preview.scroll": acting(inputOp("scroll")),
  "preview.hover": acting(inputOp("hover")),
  "preview.mouse": acting(inputOp("mouse")),
  "preview.drag": acting(inputOp("drag")),
  "preview.upload": acting(inputOp("upload")),
  "preview.key": acting(inputOp("key")),
  "preview.press_key": acting(inputOp("press_key")),
  "preview.dialog": { run: dialog, targets: "any" },
};
