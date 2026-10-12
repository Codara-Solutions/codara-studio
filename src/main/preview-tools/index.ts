// Agent-socket methods for the browser and the other studio tools, merged
// from one table per area. agent-socket.ts asks hasPreviewTool() before its
// own switch and hands matching calls to runPreviewTool(); everything a
// handler needs from the socket arrives through the host argument.
//
// The MCP side mirrors this layout: resources/codara-studio-mcp/tools/ holds
// one module per area and names the method each tool calls here.

import { BrowserTabRefError, parseTabRef } from "../browser/tab-ref";
import { scopePreviewWorkspace } from "../preview-workspace";
import { capturePreviewTools } from "./capture";
import { chromeTargetTools } from "./chrome";
import { corePreviewTools } from "./core";
import { devtoolsPreviewTools } from "./devtools";
import { inputPreviewTools } from "./input";
import { PreviewToolParamsError, type PreviewToolEntry, type PreviewToolHost, type PreviewToolTable } from "./types";

export { PreviewToolParamsError, type PreviewToolHost } from "./types";

const TABLES: readonly PreviewToolTable[] = [
  corePreviewTools,
  capturePreviewTools,
  inputPreviewTools,
  devtoolsPreviewTools,
];

function mergeTables(tables: readonly PreviewToolTable[]): Map<string, PreviewToolEntry> {
  const merged = new Map<string, PreviewToolEntry>();
  for (const table of tables) {
    for (const [method, value] of Object.entries(table)) {
      if (merged.has(method)) throw new Error(`Two preview tool modules handle ${method}.`);
      merged.set(method, typeof value === "function" ? { run: value } : value);
    }
  }
  return merged;
}

const HANDLERS = mergeTables(TABLES);
// Chrome-tab versions of "preview"-only methods, used when tabId is chrome:.
const CHROME_HANDLERS = mergeTables([chromeTargetTools]);

export function hasPreviewTool(method: string): boolean {
  return HANDLERS.has(method);
}

/** The socket methods this folder answers, for tests and capability lists. */
export function previewToolMethods(): string[] {
  return [...HANDLERS.keys()];
}

export async function runPreviewTool(
  method: string,
  params: Record<string, unknown>,
  host: PreviewToolHost,
): Promise<unknown> {
  const entry = HANDLERS.get(method);
  if (!entry) throw new Error(`unknown method: ${method}`);
  const scope = entry.scope ?? (method.startsWith("preview.") ? "browser" : "none");
  if (scope === "browser") {
    await host.scopeToCaller(params);
    await scopePreviewWorkspace(params, host.getRun);
  }
  let ref;
  try {
    ref = parseTabRef(params.tabId);
  } catch (error) {
    if (error instanceof BrowserTabRefError) throw new PreviewToolParamsError(error.message);
    throw error;
  }
  if (ref?.kind === "preview") params.tabId = ref.tabId;
  if (ref?.kind !== "chrome") return entry.run(params, method);
  if (!(await host.mayUseUserBrowser(params))) {
    throw new PreviewToolParamsError("This session may not use tabs of your own browser.");
  }
  if (entry.targets === "any") return entry.run(params, method);
  const chrome = CHROME_HANDLERS.get(method);
  if (chrome) return chrome.run(params, method);
  throw new PreviewToolParamsError(
    `${method.replace(/^preview\./, "codara_preview_")} cannot drive a Chrome tab yet. Use a Codara browser tab for it.`,
  );
}
