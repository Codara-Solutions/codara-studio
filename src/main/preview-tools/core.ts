// Page reading and DOM actions, run by the renderer against the picked tab
// (components/Preview/previewRpc.ts) through the preview bridge.

import { browserBackend } from "../browser/targets";
import { requestPreviewOp, type PreviewOpName } from "../preview-bridge";
import { waitForLoopbackPreviewServer } from "../preview-navigation";
import type { PreviewToolHandler, PreviewToolHost, PreviewToolTable } from "./types";

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

// Codara's tabs, then the tabs of a connected Chrome the caller may use. A
// Chrome that does not answer leaves the Codara list intact.
async function list(params: Record<string, unknown>, _method: string, host: PreviewToolHost): Promise<unknown> {
  const result = await requestPreviewOp("list", { ...params });
  const chrome = browserBackend("chrome");
  if (!chrome?.list || !(await host.mayUseUserBrowser(params))) return result;
  const extra = await chrome.list(params).catch(() => []);
  if (!extra.length || !result || typeof result !== "object" || !Array.isArray((result as { tabs?: unknown }).tabs)) return result;
  return { ...(result as Record<string, unknown>), tabs: [...(result as { tabs: unknown[] }).tabs, ...extra] };
}

export const corePreviewTools: PreviewToolTable = {
  "preview.list": list,
  "preview.navigate": navigate,
  "preview.url": rendererOp("url"),
  "preview.snapshot": rendererOp("snapshot"),
  "preview.evaluate": rendererOp("evaluate"),
  "preview.click": rendererOp("click"),
  "preview.type": rendererOp("type"),
  "preview.wait_for": rendererOp("wait_for"),
};
