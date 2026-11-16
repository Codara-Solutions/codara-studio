// The window half of the feedback questions (approvals.ts): main sends
// "feedback:ask" and the renderer's FeedbackHost shows the card; its answer
// comes back through feedback:answer (ipc.ts).

import { randomBytes } from "node:crypto";
import { getTrustedMainWindow } from "../main-window-trust";
import { FeedbackAsks } from "./approvals";

let asks: FeedbackAsks | null = null;

export function feedbackAsks(): FeedbackAsks {
  asks ??= new FeedbackAsks({
    show(request) {
      const win = getTrustedMainWindow();
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
      win.webContents.send("feedback:ask", request);
      if (!win.isFocused()) win.flashFrame(true);
      return true;
    },
    close(payload) {
      const win = getTrustedMainWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("feedback:askClosed", payload);
    },
    newId: () => randomBytes(12).toString("hex"),
  });
  return asks;
}
