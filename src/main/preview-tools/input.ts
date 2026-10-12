// Trusted input, sent by main straight to the guest (../preview-input.ts).
// press_key lives here too: it uses trusted input when a guest resolves and
// falls back to the renderer's synthetic event when it cannot.

import { handlePreviewInputOp, type PreviewInputOp } from "../preview-input";
import type { PreviewToolHandler, PreviewToolTable } from "./types";

export function inputOp(op: PreviewInputOp): PreviewToolHandler {
  return (params) => handlePreviewInputOp(op, params);
}

export const inputPreviewTools: PreviewToolTable = {
  "preview.scroll": inputOp("scroll"),
  "preview.hover": inputOp("hover"),
  "preview.mouse": inputOp("mouse"),
  "preview.drag": inputOp("drag"),
  "preview.upload": inputOp("upload"),
  "preview.key": inputOp("key"),
  "preview.press_key": inputOp("press_key"),
};
