// Chrome-tab versions of the browser methods whose main handler only knows
// Codara's own tabs (the renderer-side ones in core.ts and capture.ts). A
// method listed here runs when its tabId is a chrome: id; new tools that
// resolve their tab with resolveBrowserTarget() mark themselves
// `targets: "any"` instead and need no entry.

import { chromeLinkTool } from "../browser/chrome/link-tool";
import * as ops from "../browser/chrome/tab-ops";
import { resolveBrowserTarget, type BrowserTarget } from "../browser/targets";
import { acting } from "./core";
import type { PreviewToolHandler, PreviewToolTable } from "./types";

function onTarget(op: (target: BrowserTarget, params: Record<string, unknown>) => Promise<unknown>): PreviewToolHandler {
  return async (params) => op(await resolveBrowserTarget(params), params);
}

// The acting entries stamp the agent's action first, as on Codara tabs, so a
// fresh wait or a wait for the navigation a click started knows what came
// after it.
export const chromeTargetTools: PreviewToolTable = {
  "preview.navigate": acting(onTarget(ops.navigate)),
  "preview.url": onTarget(ops.url),
  "preview.snapshot": onTarget(ops.snapshot),
  "preview.evaluate": acting(onTarget(ops.evaluate)),
  "preview.click": acting(onTarget(ops.click)),
  "preview.type": acting(onTarget(ops.type)),
  "preview.press_key": acting(onTarget(ops.pressKey)),
  "preview.key": acting(onTarget(ops.key)),
  "preview.mouse": acting(onTarget(ops.mouse)),
  "preview.hover": acting(onTarget(ops.hover)),
  "preview.scroll": acting(onTarget(ops.scroll)),
  "preview.drag": acting(onTarget(ops.drag)),
  "preview.upload": acting(onTarget(ops.upload)),
  "preview.console": onTarget(ops.consoleEntries),
  "preview.network": onTarget(ops.networkEntries),
  "preview.resize": onTarget(ops.resize),
  "preview.screenshot": onTarget(ops.screenshot),
  // codara_preview_close on a chrome: tab is the link tool's close, so one
  // tool closes tabs in both browsers and the extension decides again.
  "preview.close": (params, method, host) => chromeLinkTool({ ...params, action: "close" }, method, host),
};

/** Methods only the extension link has: its state, and opening, closing or bringing forward a tab. */
export const chromeLinkTools: PreviewToolTable = {
  "preview.chrome": { run: chromeLinkTool, targets: "any" },
};
