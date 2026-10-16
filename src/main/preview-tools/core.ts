// Page reading and DOM actions, run by the renderer against the picked tab
// (components/Preview/previewRpc.ts) through the preview bridge. Waits and
// "find by description" run in main against any browser target.

import { callTarget, markAgentAction } from "../browser/agent-action";
import { findElements } from "../browser/find";
import { browserBackend, resolveBrowserTarget, type BrowserTarget } from "../browser/targets";
import { normalizeWaitRequest, waitForPage, WaitRequestError } from "../browser/wait";
import { requestPreviewOp, type PreviewOpName } from "../preview-bridge";
import { waitForLoopbackPreviewServer } from "../preview-navigation";
import { resolveRemotePreviewUrl } from "../remote/port-forward-preview";
import { savedServerHint } from "../servers/navigate-hint";
import { PreviewToolParamsError, type PreviewToolHandler, type PreviewToolHost, type PreviewToolTable } from "./types";

export function rendererOp(op: PreviewOpName): PreviewToolHandler {
  return (params) => requestPreviewOp(op, { ...params });
}

/** An agent action: stamped on the tab first, so waits know what "after your last action" means. */
export function acting(handler: PreviewToolHandler): PreviewToolHandler {
  return async (params, method, host) => {
    await markAgentAction(params);
    return handler(params, method, host);
  };
}

/** The call's tab, or the error saying why there is none. */
export async function requireTarget(params: Record<string, unknown>): Promise<BrowserTarget> {
  return (await callTarget(params)) ?? resolveBrowserTarget(params);
}

async function navigate(params: Record<string, unknown>): Promise<unknown> {
  const hasUrl = typeof params.url === "string" && params.url.trim() !== "";
  if (!hasUrl && (typeof params.tabId !== "string" || typeof params.group !== "string")) {
    throw new PreviewToolParamsError("navigate needs a url, or a tabId and a group to move that tab into the group.");
  }
  if (hasUrl && typeof params.url === "string") {
    // In an SSH workspace localhost means the host: open its forwarded port.
    const remote = await resolveRemotePreviewUrl(params.workspaceId, params.url);
    if (remote && "error" in remote) throw new Error(remote.error);
    const url = remote ? remote.url : params.url;
    if (remote) params = { ...params, url };
    const reachable = await waitForLoopbackPreviewServer(url);
    if (!reachable) {
      throw new Error(
        `Preview server is not accepting connections at ${url}. ` +
        "Start the server (or keep it running) before navigating the Electron preview." +
        (await savedServerHint(params.workspaceId, url)),
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

async function waitFor(params: Record<string, unknown>): Promise<unknown> {
  let request;
  try {
    request = normalizeWaitRequest(params);
  } catch (error) {
    if (error instanceof WaitRequestError) throw new PreviewToolParamsError(error.message);
    throw error;
  }
  const target = await requireTarget(params);
  try {
    return await waitForPage(target, request);
  } catch (error) {
    if (error instanceof WaitRequestError) return { ok: false, error: error.message };
    throw error;
  }
}

async function find(params: Record<string, unknown>): Promise<unknown> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new PreviewToolParamsError('find needs a query, for example "the search button".');
  const target = await requireTarget(params);
  const result = await findElements(target, query, typeof params.limit === "number" ? params.limit : undefined);
  if (result.count) return result;
  return { ...result, hint: "Nothing matched. Try other words, or read the page with codara_preview_snapshot." };
}

export const corePreviewTools: PreviewToolTable = {
  "preview.list": list,
  "preview.navigate": acting(navigate),
  "preview.close": rendererOp("close"),
  "preview.url": rendererOp("url"),
  "preview.snapshot": rendererOp("snapshot"),
  "preview.evaluate": acting(rendererOp("evaluate")),
  "preview.click": acting(rendererOp("click")),
  "preview.type": acting(rendererOp("type")),
  "preview.wait_for": { run: waitFor, targets: "any" },
  "preview.find": { run: find, targets: "any" },
};
