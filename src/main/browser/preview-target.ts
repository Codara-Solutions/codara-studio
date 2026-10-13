// The BrowserTarget backend for Codara's own browser tabs.

import { requestPreviewOp } from "../preview-bridge";
import { previewCdpSession } from "./preview-cdp";
import { resolvePreviewGuest } from "./preview-guest";
import { formatTabRef, type BrowserTabRef } from "./tab-ref";
import {
  evaluateOverCdp,
  registerBrowserBackend,
  type BrowserTarget,
  type BrowserTargetBackend,
  type BrowserTargetInfo,
} from "./targets";

/** The renderer's routing fields, forwarded so it picks the same tab for every call. */
function routing(params: Record<string, unknown>, tabId: string): Record<string, unknown> {
  return { tabId, runId: params.runId, workspaceId: params.workspaceId, callerPaneId: params.callerPaneId };
}

async function resolvePreviewTarget(ref: BrowserTabRef | null, params: Record<string, unknown>): Promise<BrowserTarget> {
  const scoped = { ...params, tabId: ref?.kind === "preview" ? ref.tabId : null };
  const { wc, info } = await resolvePreviewGuest(scoped);
  const session = previewCdpSession(wc);
  const tabId = info.tabId;
  const target: BrowserTarget = {
    kind: "preview",
    ref: formatTabRef({ kind: "preview", tabId }),
    session,
    workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null,
    async info(): Promise<BrowserTargetInfo> {
      const metrics = await target
        .evaluate<{ width: number; height: number; dpr: number }>(
          "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
        )
        .catch(() => null);
      return {
        ref: target.ref,
        kind: "preview",
        url: wc.isDestroyed() ? info.url ?? "" : wc.getURL(),
        title: wc.isDestroyed() ? "" : wc.getTitle(),
        viewport: metrics ? { width: metrics.width, height: metrics.height } : info.viewport,
        devicePixelRatio: metrics?.dpr || info.devicePixelRatio || 1,
      };
    },
    evaluate: (expression, options) => evaluateOverCdp(session, expression, options),
    async captureViewport() {
      // The renderer's capture paints a hidden tab (capturePaint.ts), which a
      // protocol screenshot of a background guest does not.
      const shot = await requestPreviewOp<{ dataUrl?: string }>("screenshot", routing(params, tabId));
      const dataUrl = typeof shot?.dataUrl === "string" ? shot.dataUrl : "";
      const comma = dataUrl.indexOf(",");
      if (!dataUrl.startsWith("data:image/png;base64,") || comma < 0) throw new Error("The browser tab returned no screenshot.");
      return Buffer.from(dataUrl.slice(comma + 1), "base64");
    },
    async showActivity(action, point) {
      await requestPreviewOp("activity", { ...routing(params, tabId), action, ...point }).catch(() => {});
    },
    async keepPainting(ms) {
      // A background guest renders no frames, so it reports no paints and no
      // interaction latency until its host is composed again.
      const lease = await requestPreviewOp<{ leaseId?: string; background?: boolean }>("paint", { ...routing(params, tabId), hold: true, ms });
      const leaseId = lease?.leaseId;
      return {
        background: lease?.background === true,
        release: async () => {
          if (leaseId) await requestPreviewOp("paint", { hold: false, leaseId }).catch(() => {});
        },
      };
    },
  };
  return target;
}

export const previewTargetBackend: BrowserTargetBackend = {
  kind: "preview",
  resolve: resolvePreviewTarget,
};

let registered = false;

export function registerPreviewTargets(): void {
  if (registered) return;
  registered = true;
  registerBrowserBackend(previewTargetBackend);
}
