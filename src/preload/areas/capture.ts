// window.spark.capture: the renderer side of src/main/browser/capture/ipc.ts
// (recording a browser tab from its toolbar, the responsive view's frames)
// and of src/main/browser/capture/paint.ts (keeping a background tab
// painting while a capture runs).

import { ipcRenderer } from "electron";

import type {
  CaptureFrameEmulationRequest,
  CaptureGuestPaintAck,
  CaptureGuestPaintRequest,
  CaptureRecordingChange,
  CaptureRecordRequest,
  CaptureRecordResponse,
} from "@shared/capture";

export const captureApi = {
  record: (request: CaptureRecordRequest): Promise<CaptureRecordResponse> => ipcRenderer.invoke("capture:record", request),
  frameEmulation: (request: CaptureFrameEmulationRequest): Promise<{ ok: true }> =>
    ipcRenderer.invoke("capture:frameEmulation", request),
  onRecordingChanged: (handler: (change: CaptureRecordingChange) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: CaptureRecordingChange) => handler(change);
    ipcRenderer.on("capture:recording-changed", listener);
    return () => ipcRenderer.off("capture:recording-changed", listener);
  },
  onGuestPaint: (handler: (request: CaptureGuestPaintRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: CaptureGuestPaintRequest) => handler(request);
    ipcRenderer.on("capture:guest-paint", listener);
    return () => ipcRenderer.off("capture:guest-paint", listener);
  },
  ackGuestPaint: (ack: CaptureGuestPaintAck): void => ipcRenderer.send("capture:guest-paint-ack", ack),
};
