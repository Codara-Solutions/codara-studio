// Trusted input, sent by main straight to the guest (../preview-input.ts).
// press_key lives here too: it uses trusted input when a guest resolves and
// falls back to the renderer's synthetic event when it cannot.

import { handlePreviewInputOp, type PreviewInputOp } from "../preview-input";
import { acting } from "./core";
import type { PreviewToolHandler, PreviewToolTable } from "./types";

export function inputOp(op: PreviewInputOp): PreviewToolHandler {
  return (params) => handlePreviewInputOp(op, params);
}

export const inputPreviewTools: PreviewToolTable = {
  "preview.scroll": acting(inputOp("scroll")),
  "preview.hover": acting(inputOp("hover")),
  "preview.mouse": acting(inputOp("mouse")),
  "preview.drag": acting(inputOp("drag")),
  "preview.upload": acting(inputOp("upload")),
  "preview.key": acting(inputOp("key")),
  "preview.press_key": acting(inputOp("press_key")),
};
