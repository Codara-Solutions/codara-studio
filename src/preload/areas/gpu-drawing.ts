// window.spark.gpuDrawing: the renderer side of src/main/gpu-drawing.ts. The
// switch is an ordinary preference (waylandHardwareAcceleration) written
// through window.spark.preferences; this area reads what this run does about
// it and acknowledges the one-time notice.

import { ipcRenderer } from "electron";

import type { GpuDrawingStatus } from "@shared/gpu-drawing";

export const gpuDrawingApi = {
  /** null before main decided (never, once a window exists). */
  status: (): Promise<GpuDrawingStatus | null> => ipcRenderer.invoke("gpuDrawing:status"),
  /** The notice after Codara turned the switch off was shown; it is not shown again. */
  noticeShown: (): Promise<void> => ipcRenderer.invoke("gpuDrawing:noticeShown"),
};
