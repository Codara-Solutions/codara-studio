// window.spark.feedback: the renderer side of src/main/feedback/ (Send
// feedback, and the question an agent's report waits on). The renderer hands
// over what the person typed or answered; main adds the version, platform and
// install id and talks to the service.

import { ipcRenderer } from "electron";

import type { FeedbackAdminTokenState, FeedbackAnswer, FeedbackAsk, FeedbackAskClosed, FeedbackDraft, FeedbackInfo, FeedbackSendResult } from "@shared/feedback";
import { subscribe } from "../subscribe";

export const feedbackApi = {
  info: (): Promise<FeedbackInfo> => ipcRenderer.invoke("feedback:info"),
  send: (draft: FeedbackDraft): Promise<FeedbackSendResult> => ipcRenderer.invoke("feedback:send", draft),
  /** Questions still waiting, for a window that mounts after they were sent. */
  pending: (): Promise<FeedbackAsk[]> => ipcRenderer.invoke("feedback:pending"),
  onAsk: subscribe<FeedbackAsk>("feedback:ask"),
  /** The agent stopped waiting, or the question expired. */
  onAskClosed: subscribe<FeedbackAskClosed>("feedback:askClosed"),
  /** False when the question is no longer waited for. */
  answer: (id: string, answer: FeedbackAnswer): Promise<boolean> => ipcRenderer.invoke("feedback:answer", { id, answer }),
  /** Write-only: main never hands the token back. */
  adminTokenState: (): Promise<FeedbackAdminTokenState> => ipcRenderer.invoke("feedback:adminTokenState"),
  saveAdminToken: (token: string): Promise<{ ok: true; state: FeedbackAdminTokenState } | { ok: false; message: string }> =>
    ipcRenderer.invoke("feedback:adminTokenSave", token),
  removeAdminToken: (): Promise<FeedbackAdminTokenState> => ipcRenderer.invoke("feedback:adminTokenRemove"),
};
