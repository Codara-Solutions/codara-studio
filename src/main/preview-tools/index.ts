// Agent-socket methods for the browser and the other studio tools, merged
// from one table per area. agent-socket.ts asks hasPreviewTool() before its
// own switch and hands matching calls to runPreviewTool(); everything a
// handler needs from the socket arrives through the host argument.
//
// The MCP side mirrors this layout: resources/codara-studio-mcp/tools/ holds
// one module per area and names the method each tool calls here.

import { describeDriver } from "../browser/agent-driver";
import { guardPageDialogs } from "../browser/dialog-guard";
import { recordActedTab, withActedTab } from "../browser/acted-tab";
import { noteChromeToolCall } from "../browser/chrome/activity";
import { BrowserTabRefError, parseTabRef } from "../browser/tab-ref";
import { scopePreviewWorkspace } from "../preview-workspace";
import { normalizeTabGroupName } from "../../shared/tab-group-name";
import { capturePreviewTools } from "./capture";
import { cdpPreviewTools } from "./cdp";
import { chromeLinkTools, chromeTargetTools } from "./chrome";
import { codePreviewTools } from "./code";
import { corePreviewTools } from "./core";
import { cosTaskTools } from "./cos-tasks";
import { devtoolsPreviewTools } from "./devtools";
import { inboxPreviewTools } from "./inbox";
import { inputPreviewTools } from "./input";
import { insightPreviewTools } from "./insight";
import { pointPreviewTools } from "./point";
import { serverTools } from "./servers";
import { sessionSearchTools } from "./session-search";
import { tabTools } from "./tabs";
import { workspaceStatusTools } from "./workspace-status";
import { PreviewToolParamsError, type PreviewToolEntry, type PreviewToolHost, type PreviewToolTable } from "./types";

export { PreviewToolParamsError, type PreviewToolHost } from "./types";

const TABLES: readonly PreviewToolTable[] = [
  corePreviewTools,
  capturePreviewTools,
  inputPreviewTools,
  devtoolsPreviewTools,
  cdpPreviewTools,
  inboxPreviewTools,
  insightPreviewTools,
  pointPreviewTools,
  serverTools,
  workspaceStatusTools,
  cosTaskTools,
  sessionSearchTools,
  tabTools,
  chromeLinkTools,
  // A snippet's browser calls go through runPreviewTool like any socket call.
  codePreviewTools((method, params, host) => runPreviewTool(method, params, host)),
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

// `group` names a tab group on the tools that open or move a tab. The CLI
// sends a numeric name as a number, and an empty name means no group.
function readGroupParam(params: Record<string, unknown>): void {
  if (params.group === undefined || params.group === null) {
    delete params.group;
    return;
  }
  if (typeof params.group !== "string" && typeof params.group !== "number") {
    throw new PreviewToolParamsError("group must be a tab group name.");
  }
  const group = normalizeTabGroupName(params.group);
  if (group) params.group = group;
  else delete params.group;
}

async function dispatchPreviewTool(
  method: string,
  params: Record<string, unknown>,
  host: PreviewToolHost,
): Promise<unknown> {
  const entry = HANDLERS.get(method);
  if (!entry) throw new Error(`unknown method: ${method}`);
  const scope = entry.scope ?? (method.startsWith("preview.") ? "browser" : "none");
  // Who drives the tab comes from the scoped caller, never from tool JSON:
  // the tab's banner names it and its Stop button refuses it by key.
  delete params.driver;
  if (scope === "browser") {
    // Scoping drops the pid once it found the pane; an agent outside any pane
    // keeps it as its key, so stopping one such agent leaves the others alone.
    const callerPid = params.callerPid;
    await host.scopeToCaller(params);
    await scopePreviewWorkspace(params, host.getRun);
    params.driver = await describeDriver({ callerPid, ...params }, host);
  }
  readGroupParam(params);
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
