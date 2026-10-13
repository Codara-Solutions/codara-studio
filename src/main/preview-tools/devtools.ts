// Console, network, emulation and viewport size. Everything but resize
// works on the tab's DevTools protocol session, so it drives a Codara tab
// and a shared Chrome tab alike.

import { describeEmulation, applyEmulation, EmulationParamsError, normalizeEmulationRequest } from "../browser/emulation";
import { NetworkParamsError, networkTool } from "../browser/network-detail";
import { consoleRing } from "../browser/recorders/console";
import { resolveBrowserTarget, type BrowserTarget } from "../browser/targets";
import { rendererOp } from "./core";
import { PreviewToolParamsError, type PreviewToolEntry, type PreviewToolTable } from "./types";

function paramsError(error: unknown): never {
  if (error instanceof EmulationParamsError || error instanceof NetworkParamsError) {
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

export const devtoolsPreviewTools: PreviewToolTable = {
  "preview.console": onAnyTab(consoleTool),
  "preview.network": onAnyTab(networkTool),
  "preview.emulate": onAnyTab(emulateTool),
  // The webview element's size is the guest viewport, so the renderer resizes it.
  "preview.resize": rendererOp("resize"),
};
