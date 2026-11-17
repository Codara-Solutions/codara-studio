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
import { checkNavigateUrl, corePreviewTools } from "./core";
import { cosTaskTools } from "./cos-tasks";
import { devtoolsPreviewTools } from "./devtools";
import { feedbackTools } from "./feedback";
import { inboxPreviewTools } from "./inbox";
import { inputPreviewTools } from "./input";
import { openFileTools } from "./open-file";
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
  openFileTools,
  chromeLinkTools,
  feedbackTools,
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

// Numeric fields of the browser tools' schemas, and the objects that nest
// them. Agents and the CLI often send these as strings ("1280").
const NUMERIC_FIELDS = new Set([
  "width", "height", "x", "y", "deltaX", "deltaY", "timeoutMs", "maxBytes", "stableMs", "limit", "quality", "maxWidth",
  "scale", "threshold", "fps", "maxSeconds", "steps", "autoMs", "cpu", "deviceScaleFactor", "ms",
]);
const NESTED_FIELDS = new Set(["clip", "from", "to"]);
const NUMERIC_TEXT = /^\s*-?(\d+\.?\d*|\.\d+)\s*$/;

/** Reads numeric strings as numbers, in place. */
export function coerceNumericParams(params: Record<string, unknown>, depth = 0): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && NUMERIC_FIELDS.has(key) && NUMERIC_TEXT.test(value)) params[key] = Number(value);
    else if (depth === 0 && NESTED_FIELDS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      coerceNumericParams(value as Record<string, unknown>, 1);
    }
  }
}

// Names agents reach for that a tool calls something else, and the hint for
// a call that used another tool's fields.
function readAliases(method: string, params: Record<string, unknown>): void {
  if (method === "preview.evaluate" && params.code === undefined && typeof params.expression === "string") {
    params.code = params.expression;
    delete params.expression;
  }
  if (method === "preview.click" && params.selector === undefined && params.x !== undefined && params.y !== undefined) {
    throw new PreviewToolParamsError("click needs a selector (an @reference or CSS). To click at x, y use codara_preview_mouse.");
  }
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
  // Codara's own fields, never the agent's.
  delete params.lookupWake;
  delete params.lookupTabId;
  if (scope === "browser") {
    // Scoping drops the pid once it found the pane; an agent outside any pane
    // keeps it as its key, so stopping one such agent leaves the others alone.
    const callerPid = params.callerPid;
    await host.scopeToCaller(params);
    await scopePreviewWorkspace(params, host.getRun);
    params.driver = await describeDriver({ callerPid, ...params }, host);
  }
  readGroupParam(params);
  if (method.startsWith("preview.")) {
    coerceNumericParams(params);
    readAliases(method, params);
  }
  let ref;
  try {
    ref = parseTabRef(params.tabId);
  } catch (error) {
    if (error instanceof BrowserTabRefError) throw new PreviewToolParamsError(error.message);
    throw error;
  }
  if (ref?.kind === "preview") params.tabId = ref.tabId;
  if (ref?.kind !== "chrome" && method === "preview.navigate") {
    // Before any lookup of the tab, so a refused navigate wakes nothing.
    await checkNavigateUrl(params);
    // The call's lookups pick the tab the navigate will load into (previewRpc
    // getWebContentsId). With a url, a sleeping one wakes on a blank page: the
    // dialog guard and the action stamp attach as on an awake tab, then the
    // navigate loads the URL under them. Without a url (a group move) the tab
    // keeps its page and stays asleep.
    params.lookupWake = typeof params.url === "string" && params.url.trim() !== "" ? "blank" : "none";
  }
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
