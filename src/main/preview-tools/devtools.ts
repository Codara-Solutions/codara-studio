// Console, network, emulation, storage and viewport size. Everything but
// resize works on the tab's DevTools protocol session, so it drives a Codara
// tab and a shared Chrome tab alike.

import { describeEmulation, applyEmulation, EmulationParamsError, normalizeEmulationRequest } from "../browser/emulation";
import { isFreshPartition } from "../../shared/browser-partition";
import { newFreshPartition, trackFreshPartition, wipeFreshPartition } from "../browser/fresh-tabs";
import { NetworkParamsError, networkTool } from "../browser/network-detail";
import { consoleRing } from "../browser/recorders/console";
import { clearStorage, parseStorageArea, readStorage, setStorageItem, StorageParamsError } from "../browser/storage";
import { resolveBrowserTarget, type BrowserTarget } from "../browser/targets";
import { requestPreviewOp } from "../preview-bridge";
import { waitForLoopbackPreviewServer } from "../preview-navigation";
import { rendererOp } from "./core";
import { PreviewToolParamsError, type PreviewToolEntry, type PreviewToolTable } from "./types";

function paramsError(error: unknown): never {
  if (error instanceof EmulationParamsError || error instanceof NetworkParamsError || error instanceof StorageParamsError) {
    throw new PreviewToolParamsError(error.message);
  }
  throw error;
}

function onAnyTab(run: (target: BrowserTarget, params: Record<string, unknown>) => Promise<unknown>): PreviewToolEntry {
  return {
    targets: "any",
    run: async (params) => {
      try {
        return await run(await resolveBrowserTarget(params), params);
      } catch (error) {
        return paramsError(error);
      }
    },
  };
}

function clampLimit(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 100;
  return Math.min(500, Math.max(1, value));
}

async function consoleTool(target: BrowserTarget, params: Record<string, unknown>): Promise<unknown> {
  const ring = consoleRing(target.session);
  if (params.clear === true) {
    ring.clear();
    return { ok: true, tabId: target.ref, cleared: true, entries: [] };
  }
  const level = typeof params.level === "string" ? params.level.toLowerCase() : null;
  let entries = ring.toArray();
  if (level) entries = entries.filter((entry) => entry.level === level);
  const sliced = entries.slice(-clampLimit(params.limit));
  return { ok: true, tabId: target.ref, count: sliced.length, total: ring.size, entries: sliced };
}

async function emulateTool(target: BrowserTarget, params: Record<string, unknown>): Promise<unknown> {
  const request = normalizeEmulationRequest(params);
  const state = await applyEmulation(target, request.changes, { reset: request.reset });
  const active = describeEmulation(state);
  const summary = Object.keys(active).length ? `Emulating ${Object.keys(active).join(", ")}` : "Emulation off";
  await target.showActivity(summary);
  const info = await target.info().catch(() => null);
  return {
    ok: true,
    tabId: target.ref,
    emulation: active,
    ...(info?.viewport ? { viewport: info.viewport, devicePixelRatio: info.devicePixelRatio } : {}),
  };
}

function routing(params: Record<string, unknown>): Record<string, unknown> {
  return { runId: params.runId, workspaceId: params.workspaceId, callerPaneId: params.callerPaneId };
}

async function openFreshTab(params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.tabId === "string" && params.tabId.startsWith("chrome:")) {
    throw new PreviewToolParamsError("A logged-out tab is always a new Codara tab; leave tabId out.");
  }
  const url = typeof params.url === "string" && params.url.trim() ? params.url.trim() : "about:blank";
  if (!(await waitForLoopbackPreviewServer(url))) {
    throw new Error(`Preview server is not accepting connections at ${url}. Start the server before opening a tab on it.`);
  }
  const partition = newFreshPartition();
  trackFreshPartition(partition);
  const group = typeof params.group === "string" ? params.group : undefined;
  const opened = await requestPreviewOp<{ tabId?: string; url?: string; group?: string }>("open_isolated", {
    ...routing(params),
    url,
    partition,
    ...(group ? { group } : {}),
  });
  return {
    ok: true,
    tabId: opened?.tabId ?? null,
    url: opened?.url ?? url,
    ...(opened?.group ? { group: opened.group } : {}),
    isolated: true,
    note: "A new tab with its own temporary session: no cookies or storage, separate from the user's tabs. Pass this tabId to the other browser tools; storage action discard closes it and wipes its data.",
  };
}

async function discardFreshTab(params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.tabId !== "string" || !params.tabId) {
    throw new PreviewToolParamsError("discard needs the tabId that storage action fresh returned.");
  }
  if (params.tabId.startsWith("chrome:")) throw new PreviewToolParamsError("Codara never closes a Chrome tab.");
  const closed = await requestPreviewOp<{ tabId?: string; partition?: string; closed?: string[] }>("close_isolated", { ...routing(params), tabId: params.tabId });
  if (!isFreshPartition(closed?.partition)) {
    throw new PreviewToolParamsError(`Tab ${params.tabId} is not a logged-out tab; only tabs from storage action fresh can be discarded.`);
  }
  await wipeFreshPartition(closed.partition);
  const others = (closed.closed ?? []).filter((id) => id !== params.tabId);
  return { ok: true, tabId: params.tabId, closed: true, ...(others.length ? { alsoClosed: others } : {}), wiped: true };
}

async function storageTool(params: Record<string, unknown>): Promise<unknown> {
  const action = typeof params.action === "string" ? params.action.toLowerCase() : "get";
  if (action === "fresh") return openFreshTab(params);
  if (action === "discard") return discardFreshTab(params);
  if (action !== "get" && action !== "set" && action !== "clear") {
    throw new PreviewToolParamsError("action must be get, set, clear, fresh or discard.");
  }
  const target = await resolveBrowserTarget(params);
  const area = parseStorageArea(params.area);
  if (action === "set") return setStorageItem(target, { area, name: params.name, value: params.value });
  if (action === "clear") return clearStorage(target, { area, name: params.name });
  return readStorage(target, { area, redact: params.redact !== false });
}

export const devtoolsPreviewTools: PreviewToolTable = {
  "preview.console": onAnyTab(consoleTool),
  "preview.network": onAnyTab(networkTool),
  "preview.emulate": onAnyTab(emulateTool),
  "preview.storage": {
    targets: "any",
    run: async (params) => {
      try {
        return await storageTool(params);
      } catch (error) {
        return paramsError(error);
      }
    },
  },
  // The webview element's size is the guest viewport, so the renderer resizes it.
  "preview.resize": rendererOp("resize"),
};
