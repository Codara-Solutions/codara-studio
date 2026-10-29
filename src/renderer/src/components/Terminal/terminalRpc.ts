// Renderer-side handler for terminal-bridge requests. Listens for
// "terminal-bridge:request" from main, dispatches the op against the terminal
// registry (which reaches useTabs via the adapter App.tsx registers), and sends
// back a "terminal-bridge:response" with the same reqId so main can match it.
//
// Mirrors previewRpc.ts. Tab creation/destruction and phone-owned xterm sizing
// route through here because that state is renderer-owned. terminal.write/read
// operate on the PTY session directly in main and never reach the renderer.

import {
  closeAgentTerminal,
  createAgentTerminal,
  forgetExternalTerminalSize,
  listDeliverablePanes,
  listShareableStudioTerminals,
  getWorkspaceAgentCounts,
  setExternalTerminalSize,
} from "./terminalRegistry";
import { closePaneOverlay, openPaneOverlay } from "./paneOverlays";
import { assignPaneToGroup } from "../../tabs/tabGroupBridge";
import { tabLinkBridge } from "../../tabs/tabLinkBridge";
import { editorOpenBridge } from "../../tabs/editorOpenBridge";
import { previewTabOpener } from "../Preview/registry";
import { sanitizeTerminalAgentOwner } from "@shared/agent-terminal-owner";
import { parseTabLink } from "@shared/tab-links";
import type { TerminalLeafOrigin } from "../../tabs/types";

interface BridgeRequest {
  reqId: string;
  op: string;
  params: Record<string, unknown>;
}

interface BridgeResponse {
  reqId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let registered = false;

export function registerTerminalRpcHandler(): void {
  if (registered) return;
  registered = true;
  const terminalBridge = window.spark?.terminalBridge;
  if (!terminalBridge) {
    console.warn("[terminalRpc] window.spark.terminalBridge is missing; terminal tools disabled");
    return;
  }
  terminalBridge.onRequest(async (raw) => {
    const req: BridgeRequest = {
      reqId: raw.reqId,
      op: raw.op,
      params: (raw.params as Record<string, unknown>) ?? {},
    };
    try {
      const result = await dispatch(req);
      terminalBridge.sendResponse({ reqId: req.reqId, ok: true, result } satisfies BridgeResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      terminalBridge.sendResponse({ reqId: req.reqId, ok: false, error: message } satisfies BridgeResponse);
    }
  });
}

async function dispatch(req: BridgeRequest): Promise<unknown> {
  switch (req.op) {
    case "agentCounts":
      return getWorkspaceAgentCounts();
    case "list":
      return listShareableStudioTerminals();
    case "panes":
      return listDeliverablePanes();
    case "create":
      return create(req.params);
    case "destroy":
      return destroy(req.params);
    case "resize":
      return resize(req.params);
    case "overlay":
      return overlay(req.params);
    case "closeOverlay":
      return closeOverlay(req.params);
    case "group":
      return group(req.params);
    case "tabs":
      return tabs(req.params);
    case "tabAct":
      return tabAct(req.params);
    case "openFile":
      return openFile(req.params);
    default:
      throw new Error(`unknown terminal op: ${req.op || "?"}`);
  }
}

async function create(params: Record<string, unknown>): Promise<unknown> {
  const cwd = readString(params, "cwd");
  const command = readString(params, "command");
  const title = readString(params, "title");
  const workspaceId = readString(params, "workspaceId");
  const workspaceCwd = readString(params, "workspaceCwd");
  const callerPaneId = readString(params, "callerPaneId");
  // Main pins the Claude account when it builds a phone-origin create
  // (createRemoteTerminal resolves the Active profile and validates any
  // --resume id against ITS state dir). Dropping the id here would let the
  // pane's spawn re-resolve a default that may have changed since that
  // validation, launching under a different account than main checked.
  const nativeClaudeProfileId = readString(params, "nativeClaudeProfileId");
  const origin = readPhoneOrigin(params.origin);
  const requestedFromPane = params.requestedFromPane === true;
  const groupName = readString(params, "group");
  const openedBy = readString(params, "openedBy");
  const agentOwner = sanitizeTerminalAgentOwner(params.agentOwner);
  return createAgentTerminal({
    cwd: cwd ?? undefined,
    command: command ?? undefined,
    title: title ?? undefined,
    workspaceId: workspaceId ?? undefined,
    workspaceCwd: workspaceCwd ?? undefined,
    callerPaneId: callerPaneId ?? undefined,
    nativeClaudeProfileId: nativeClaudeProfileId ?? undefined,
    origin: origin ?? undefined,
    ...(requestedFromPane ? { requestedFromPane } : {}),
    ...(groupName ? { group: groupName } : {}),
    ...(openedBy ? { openedBy: openedBy.slice(0, 200) } : {}),
    ...(agentOwner ? { agentOwner } : {}),
  });
}

// Moves the tab holding an existing pane into a named group of its workspace.
async function group(params: Record<string, unknown>): Promise<unknown> {
  const paneId = readString(params, "paneId");
  const name = readString(params, "group");
  if (!paneId || !name) throw new Error("group requires paneId and group");
  const joined = assignPaneToGroup(paneId, name);
  if (!joined) throw new Error(`No terminal pane '${paneId}' is open in Codara.`);
  return { paneId, group: joined };
}

// codara_tab: what a link names, and the workspace on screen. Main decides
// what the caller may do with it before asking for tabAct.
async function tabs(params: Record<string, unknown>): Promise<unknown> {
  const ref = parseTabLink(params.link);
  if (!ref) throw new Error("tabs requires a codara://tab or codara://group link");
  const bridge = tabLinkBridge();
  const target = bridge.resolve(ref);
  return {
    target: target && {
      ...target,
      tabs: target.tabs.map((tab) => (tab.kind === "preview" ? { ...tab, openedBy: previewTabOpener(tab.tabId) } : tab)),
    },
    activeWorkspaceId: bridge.activeWorkspaceId(),
  };
}

async function tabAct(params: Record<string, unknown>): Promise<unknown> {
  const bridge = tabLinkBridge();
  const action = readString(params, "action");
  if (action === "focus") {
    const ref = parseTabLink(params.link);
    if (!ref) throw new Error("focus requires a link");
    return { ok: bridge.focus(ref) };
  }
  if (action === "close") {
    const workspaceId = readString(params, "workspaceId");
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.filter((id): id is string => typeof id === "string") : [];
    if (!workspaceId || tabIds.length === 0) throw new Error("close requires workspaceId and tabIds");
    return { closed: bridge.close(workspaceId, tabIds) };
  }
  const tabId = readString(params, "tabId");
  if (!tabId) throw new Error(`${action ?? "?"} requires tabId`);
  if (action === "split") return bridge.split(tabId, params.direction === "down" ? "down" : "right");
  if (action === "unsplit") return bridge.unsplit(tabId);
  throw new Error(`unknown tab action: ${action ?? "?"}`);
}

// codara_open_file: main checked the file and the caller's workspace.
async function openFile(params: Record<string, unknown>): Promise<unknown> {
  const workspaceId = readString(params, "workspaceId");
  // Not trimmed: a file name may end in a space.
  const path = typeof params.path === "string" ? params.path : null;
  if (!workspaceId || !path) throw new Error("openFile requires workspaceId and path");
  const line = typeof params.line === "number" && Number.isInteger(params.line) && params.line > 0 ? params.line : undefined;
  return editorOpenBridge().open({ workspaceId, path, ...(line !== undefined ? { line } : {}) });
}

async function overlay(params: Record<string, unknown>): Promise<unknown> {
  const hostPaneId = readString(params, "hostPaneId");
  const command = readString(params, "command");
  if (!hostPaneId || !command) throw new Error("overlay requires hostPaneId and command");
  const cwd = readString(params, "cwd");
  const title = readString(params, "title");
  const opened = openPaneOverlay({
    hostPaneId,
    command,
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
  });
  return { paneId: opened.paneId, hostPaneId: opened.hostPaneId };
}

async function closeOverlay(params: Record<string, unknown>): Promise<unknown> {
  const paneId = readString(params, "paneId");
  if (!paneId) throw new Error("closeOverlay requires paneId");
  return { ok: true, closed: closePaneOverlay(paneId) };
}

async function destroy(params: Record<string, unknown>): Promise<unknown> {
  const tabId = readString(params, "tabId");
  if (!tabId) throw new Error("destroy requires 'tabId'");
  const paneId = readString(params, "paneId");
  if (paneId) forgetExternalTerminalSize(paneId);
  closeAgentTerminal(tabId);
  return { ok: true };
}

async function resize(params: Record<string, unknown>): Promise<unknown> {
  const paneId = readString(params, "paneId");
  const cols = readDimension(params.cols);
  const rows = readDimension(params.rows);
  if (!paneId || cols === null || rows === null) {
    throw new Error("resize requires paneId, cols and rows");
  }
  setExternalTerminalSize(paneId, cols, rows);
  return { ok: true };
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPhoneOrigin(value: unknown): TerminalLeafOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "phone") return null;
  const deviceName = readString(candidate, "deviceName");
  if (!deviceName) return null;
  const initialCols = readDimension(candidate.initialCols);
  const initialRows = readDimension(candidate.initialRows);
  return {
    kind: "phone",
    deviceName,
    ...(initialCols !== null ? { initialCols } : {}),
    ...(initialRows !== null ? { initialRows } : {}),
  };
}

function readDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const dimension = Math.trunc(value);
  return dimension >= 2 && dimension <= 500 ? dimension : null;
}
