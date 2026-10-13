// Chrome-tab versions of the browser methods whose main handler only knows
// Codara's own tabs (the renderer-side ones in core.ts and capture.ts). A
// method listed here runs when its tabId is a chrome: id; new tools that
// resolve their tab with resolveBrowserTarget() mark themselves
// `targets: "any"` instead and need no entry.

import { chromeLinkTool } from "../browser/chrome/link-tool";
import * as ops from "../browser/chrome/tab-ops";
import { resolveBrowserTarget, type BrowserTarget } from "../browser/targets";
import type { PreviewToolHandler, PreviewToolTable } from "./types";

function onTarget(op: (target: BrowserTarget, params: Record<string, unknown>) => Promise<unknown>): PreviewToolHandler {
  return async (params) => op(await resolveBrowserTarget(params), params);
}

export const chromeTargetTools: PreviewToolTable = {
  "preview.navigate": onTarget(ops.navigate),
  "preview.url": onTarget(ops.url),
  "preview.snapshot": onTarget(ops.snapshot),
  "preview.evaluate": onTarget(ops.evaluate),
  "preview.click": onTarget(ops.click),
  "preview.type": onTarget(ops.type),
  "preview.press_key": onTarget(ops.pressKey),
  "preview.key": onTarget(ops.key),
  "preview.mouse": onTarget(ops.mouse),
  "preview.hover": onTarget(ops.hover),
  "preview.scroll": onTarget(ops.scroll),
  "preview.drag": onTarget(ops.drag),
  "preview.upload": onTarget(ops.upload),
  "preview.console": onTarget(ops.consoleEntries),
  "preview.network": onTarget(ops.networkEntries),
  "preview.resize": onTarget(ops.resize),
  "preview.screenshot": onTarget(ops.screenshot),
};

/** Methods only the extension link has: its state, and opening, closing or bringing forward a tab. */
export const chromeLinkTools: PreviewToolTable = {
  "preview.chrome": { run: chromeLinkTool, targets: "any" },
};
