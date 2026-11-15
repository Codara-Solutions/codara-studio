// Feedback in the running app: what Studio adds to a report (its version, the
// operating system and the install id) and where feedback.json lives. Loaded
// the first time feedback is opened or sent, never at startup (ipc.ts).

import { app } from "electron";
import { join } from "node:path";
import { isFeedbackKind, type FeedbackDraft, type FeedbackInfo, type FeedbackSendResult, type FeedbackSource } from "@shared/feedback";
import { codaraHome } from "../codara-home";
import { logMain } from "../file-log";
import { writeFileAtomic } from "../fs-atomic";
import { sendFeedback } from "./client";
import { FEEDBACK_FILE, FeedbackStore } from "./store";

let store: FeedbackStore | null = null;

export function feedbackStore(): FeedbackStore {
  store ??= new FeedbackStore({
    file: join(codaraHome(), FEEDBACK_FILE),
    write: (file, text) => writeFileAtomic(file, text, { mode: 0o600 }),
  });
  return store;
}

const VERSION_TAG = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function feedbackInfo(): FeedbackInfo {
  const version = app.getVersion();
  return {
    appVersion: VERSION_TAG.test(version) ? version : "unknown",
    platform: `${process.platform}-${process.arch}`,
  };
}

export function feedbackDraftOf(raw: unknown): FeedbackDraft | null {
  const value = raw as Partial<FeedbackDraft> | null;
  if (!value || !isFeedbackKind(value.kind) || typeof value.message !== "string") return null;
  if (value.contact !== undefined && value.contact !== null && typeof value.contact !== "string") return null;
  return { kind: value.kind, message: value.message, contact: value.contact ?? null };
}

export async function sendStudioFeedback(draft: FeedbackDraft, source: FeedbackSource): Promise<FeedbackSendResult> {
  const result = await sendFeedback({ ...draft, source, ...feedbackInfo(), installId: await feedbackStore().installId() });
  // The outcome only: never the text, the contact or the id.
  logMain("feedback", `${source} report ${result.ok ? "sent" : `not sent (${result.error})`}`);
  return result;
}
