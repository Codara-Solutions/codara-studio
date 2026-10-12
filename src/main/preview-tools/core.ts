// Page reading and DOM actions, run by the renderer against the picked tab
// (components/Preview/previewRpc.ts) through the preview bridge.

import { requestPreviewOp, type PreviewOpName } from "../preview-bridge";
import { waitForLoopbackPreviewServer } from "../preview-navigation";
import type { PreviewToolHandler, PreviewToolTable } from "./types";

export function rendererOp(op: PreviewOpName): PreviewToolHandler {
  return (params) => requestPreviewOp(op, { ...params });
}

async function navigate(params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.url === "string") {
    const reachable = await waitForLoopbackPreviewServer(params.url);
    if (!reachable) {
      throw new Error(
        `Preview server is not accepting connections at ${params.url}. ` +
        "Start the server (or keep it running) before navigating the Electron preview.",
      );
    }
  }
  return requestPreviewOp("navigate", { ...params });
}

export const corePreviewTools: PreviewToolTable = {
  "preview.list": rendererOp("list"),
  "preview.navigate": navigate,
  "preview.url": rendererOp("url"),
  "preview.snapshot": rendererOp("snapshot"),
  "preview.evaluate": rendererOp("evaluate"),
  "preview.click": rendererOp("click"),
  "preview.type": rendererOp("type"),
  "preview.wait_for": rendererOp("wait_for"),
};
