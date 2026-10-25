// The browser pane's tabs and memory view and full screen, shared by
// src/main/browser/preview-tabs.ts and window.spark.previewBridge.

export interface BrowserTabMemory {
  /** Bytes per browser tab id, for tabs whose page is running. */
  tabs: Record<string, number>;
  /** Every Codara process together. */
  appBytes: number;
}

export interface BrowserFullScreenRequest {
  tabId: string | null;
  /** "window" fills the Codara window; "display" also makes the window full screen. */
  mode: "off" | "window" | "display";
}
