// IPC of Send feedback (window.spark.feedback, src/preload/areas/feedback.ts).
// Every channel goes through the trusted-sender `handle`. The service code
// loads on first use, so feedback costs the startup bundle only these lines.

import type { FeedbackAsk, FeedbackInfo, FeedbackSendResult } from "@shared/feedback";
import type { IpcHandle } from "../ipc";

export function registerFeedbackIpc(handle: IpcHandle): void {
  handle("feedback:info", async (): Promise<FeedbackInfo> => (await import("./service")).feedbackInfo());
  handle("feedback:send", async (_event, raw: unknown): Promise<FeedbackSendResult> => {
    const service = await import("./service");
    const draft = service.feedbackDraftOf(raw);
    if (!draft) return { ok: false, error: "invalid", message: "Choose Bug, Idea or Other and write a message." };
    return service.sendStudioFeedback(draft, "user");
  });
  // An agent's report waits on the person's click here (agent-tool.ts).
  handle("feedback:pending", async (): Promise<FeedbackAsk[]> => (await import("./asks")).feedbackAsks().list());
  handle("feedback:answer", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { id?: unknown; answer?: unknown } | null;
    if (!value || typeof value.id !== "string" || (value.answer !== "yes" && value.answer !== "no")) return false;
    return (await import("./asks")).feedbackAsks().answer(value.id, value.answer);
  });
}
