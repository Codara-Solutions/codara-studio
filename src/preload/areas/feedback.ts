// window.spark.feedback: the renderer side of src/main/feedback/ (Send
// feedback). The renderer hands over what the person typed; main adds the
// version, platform and install id and talks to the service.

import { ipcRenderer } from "electron";

import type { FeedbackDraft, FeedbackInfo, FeedbackSendResult } from "@shared/feedback";

export const feedbackApi = {
  info: (): Promise<FeedbackInfo> => ipcRenderer.invoke("feedback:info"),
  send: (draft: FeedbackDraft): Promise<FeedbackSendResult> => ipcRenderer.invoke("feedback:send", draft),
};
