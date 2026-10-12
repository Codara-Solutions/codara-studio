// Agent-socket methods for the browser and the other studio tools, merged
// from one table per area. agent-socket.ts asks hasPreviewTool() before its
// own switch and hands matching calls to runPreviewTool(); everything a
// handler needs from the socket arrives through the host argument.
//
// The MCP side mirrors this layout: resources/codara-studio-mcp/tools/ holds
// one module per area and names the method each tool calls here.

import { scopePreviewWorkspace } from "../preview-workspace";
import { capturePreviewTools } from "./capture";
import { corePreviewTools } from "./core";
import { devtoolsPreviewTools } from "./devtools";
import { inputPreviewTools } from "./input";
import type { PreviewToolEntry, PreviewToolHost, PreviewToolTable } from "./types";

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
  return entry.run(params, method);
}
