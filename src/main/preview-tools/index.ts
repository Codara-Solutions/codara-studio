// Agent-socket methods for the browser and the other studio tools, merged
// from one table per area. agent-socket.ts asks hasPreviewTool() before its
// own switch and hands matching calls to runPreviewTool(); everything a
// handler needs from the socket arrives through the host argument.
//
// The MCP side mirrors this layout: resources/codara-studio-mcp/tools/ holds
// one module per area and names the method each tool calls here.

import { guardPageDialogs } from "../browser/dialog-guard";
import { recordActedTab, withActedTab } from "../browser/acted-tab";
import { noteChromeToolCall } from "../browser/chrome/activity";
import { BrowserTabRefError, parseTabRef } from "../browser/tab-ref";
import { scopePreviewWorkspace } from "../preview-workspace";
import { capturePreviewTools } from "./capture";
import { chromeLinkTools, chromeTargetTools } from "./chrome";
import { corePreviewTools } from "./core";
import { devtoolsPreviewTools } from "./devtools";
import { inboxPreviewTools } from "./inbox";
import { inputPreviewTools } from "./input";
import { insightPreviewTools } from "./insight";
import { pointPreviewTools } from "./point";
import { serverTools } from "./servers";
import { PreviewToolParamsError, type PreviewToolEntry, type PreviewToolHost, type PreviewToolTable } from "./types";

export { PreviewToolParamsError, type PreviewToolHost } from "./types";

const TABLES: readonly PreviewToolTable[] = [
  corePreviewTools,
  capturePreviewTools,
  inputPreviewTools,
  devtoolsPreviewTools,
  inboxPreviewTools,
  insightPreviewTools,
  pointPreviewTools,
  serverTools,
  chromeLinkTools,
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

/** Whether the socket refuses this method for an imported pull-request run. */
export function previewToolRefusesUntrustedRuns(method: string): boolean {
  return HANDLERS.get(method)?.trustedRunsOnly === true;
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
  if (!method.startsWith("preview.")) return dispatchPreviewTool(method, params, host);
  const { value, tabId } = await recordActedTab(() => dispatchPreviewTool(method, params, host));
  return withActedTab(value, tabId ?? (typeof params.tabId === "string" ? params.tabId : null));
}

async function dispatchPreviewTool(
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
  // A page dialog must never leave the call hanging (browser/dialog-guard.ts).
  if (ref?.kind !== "chrome") return guardPageDialogs(method, params, () => entry.run(params, method, host));
  if (!(await host.mayUseUserBrowser(params))) {
    throw new PreviewToolParamsError("This session may not use tabs of your own browser.");
  }
  // Every call that reaches the user's own browser is logged with its agent.
  noteChromeToolCall(method, params);
  if (entry.targets === "any") return guardPageDialogs(method, params, () => entry.run(params, method, host));
  const chrome = CHROME_HANDLERS.get(method);
  if (chrome) return guardPageDialogs(method, params, () => chrome.run(params, method, host));
  throw new PreviewToolParamsError(
    `${method.replace(/^preview\./, "codara_preview_")} cannot drive a Chrome tab yet. Use a Codara browser tab for it.`,
  );
}
