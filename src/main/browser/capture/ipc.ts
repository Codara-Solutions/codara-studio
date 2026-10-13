// The capture features' window channels: recording a browser tab from its
// toolbar, and the responsive view's per-frame emulation. Both act on a
// <webview> guest the renderer names by id, so each first proves it is a
// real preview guest of the trusted window. The renderer side is
// window.spark.capture (src/preload/areas/capture.ts).

import { webContents, type WebContents } from "electron";

import type { CaptureFrameEmulationRequest, CaptureRecordRequest, CaptureRecordResponse } from "../../../shared/capture";
import type { IpcHandle } from "../../ipc";
import { getTrustedMainWindow, isTrustedPreviewGuest } from "../../main-window-trust";
import { previewCdpSession } from "../preview-cdp";
import {
  appRecordDeps,
  normalizeRecordOptions,
  onRecordingChange,
  recordingStatus,
  startRecording,
  stopRecording,
  type RecordTarget,
} from "../record/recorder";
import { nativeBitmapCodec } from "./codec";

export const RECORDING_CHANGED_CHANNEL = "capture:recording-changed";

function guest(webContentsId: unknown): WebContents {
  const wc = typeof webContentsId === "number" ? webContents.fromId(webContentsId) : undefined;
  if (!wc || !isTrustedPreviewGuest(wc)) throw new Error("That browser tab is not open any more.");
  return wc;
}

function guestTarget(wc: WebContents, tabId: unknown, workspaceId: unknown): RecordTarget {
  return {
    ref: typeof tabId === "string" && tabId ? tabId : `guest-${wc.id}`,
    session: previewCdpSession(wc),
    workspaceId: typeof workspaceId === "string" && workspaceId ? workspaceId : null,
    async captureViewport() {
      const image = await wc.capturePage();
      if (image.isEmpty()) throw new Error("The tab painted nothing.");
      return image.toPNG();
    },
  };
}

let forwarding = false;

export function registerCaptureIpc(handle: IpcHandle): void {
  handle("capture:record", async (_event, request: CaptureRecordRequest): Promise<CaptureRecordResponse> => {
    const wc = guest(request?.webContentsId);
    const target = guestTarget(wc, request.tabId, request.workspaceId);
    const key = target.session.key;
    if (request.action === "status") return { key, status: recordingStatus(target) };
    if (request.action === "stop") return { key, result: await stopRecording(target) };
    const options = normalizeRecordOptions({ format: request.format === "webm" ? "webm" : "gif" });
    return { key, status: await startRecording(target, options, appRecordDeps(nativeBitmapCodec())) };
  });

  // The responsive view lays each frame out at its preset's size; this
  // makes the page treat it as that device (mobile layout rules, the color
  // scheme switch) without touching any other tab.
  handle("capture:frameEmulation", async (_event, request: CaptureFrameEmulationRequest) => {
    const session = previewCdpSession(guest(request?.webContentsId));
    const width = Math.round(Number(request.width));
    const height = Math.round(Number(request.height));
    if (!(width >= 120 && width <= 3840 && height >= 120 && height <= 3840)) throw new Error("The frame size is out of range.");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: request.mobile === true,
      screenWidth: width,
      screenHeight: height,
    });
    // Switching a laid-out page to a mobile viewport keeps the zoom it had,
    // which shows a phone frame magnified.
    await session.send("Emulation.resetPageScaleFactor").catch(() => {});
    const scheme = request.colorScheme === "light" || request.colorScheme === "dark" ? request.colorScheme : "";
    await session.send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-color-scheme", value: scheme }] });
    return { ok: true };
  });

  if (!forwarding) {
    forwarding = true;
    onRecordingChange((change) => {
      const window = getTrustedMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(RECORDING_CHANGED_CHANNEL, change);
    });
  }
}
