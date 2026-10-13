// Shapes shared by the capture window channels (src/main/browser/capture/ipc.ts),
// the preload (src/preload/areas/capture.ts) and the browser pane's record
// button and responsive view.

export interface CaptureSizePreset {
  name: string;
  width: number;
  height: number;
  /** Lay the page out as a phone or tablet browser does. */
  mobile: boolean;
}

/** The sizes the responsive view and codara_preview_compare start from. */
export const DEFAULT_CAPTURE_SIZES: readonly CaptureSizePreset[] = [
  { name: "Phone", width: 390, height: 844, mobile: true },
  { name: "Tablet", width: 820, height: 1180, mobile: true },
  { name: "Desktop", width: 1440, height: 900, mobile: false },
];

export type CaptureColorScheme = "light" | "dark" | null;

export interface CaptureRecordRequest {
  webContentsId: number;
  tabId?: string | null;
  workspaceId?: string | null;
  action: "start" | "stop" | "status";
  format?: "gif" | "webm";
}

export interface CaptureRecordingStatus {
  recording: true;
  tabId: string;
  format: "gif" | "webm";
  elapsedMs: number;
  frames: number;
  maxSeconds: number;
}

export interface CaptureRecordingResult {
  recording: false;
  tabId: string;
  path: string;
  format: "gif" | "webm";
  mimeType: string;
  bytes: number;
  frames: number;
  durationMs: number;
  size: { width: number; height: number };
  fps: number;
  stoppedBy?: string;
  note?: string;
}

export interface CaptureRecordResponse {
  /** The tab's session key; recording-changed events carry the same key. */
  key: string;
  status?: CaptureRecordingStatus | null;
  result?: CaptureRecordingResult;
}

export interface CaptureRecordingChange {
  key: string;
  tabId: string;
  recording: boolean;
  result?: CaptureRecordingResult;
  error?: string;
}

export interface CaptureFrameEmulationRequest {
  webContentsId: number;
  width: number;
  height: number;
  mobile: boolean;
  colorScheme: CaptureColorScheme;
}

/** Main asks the pane that owns a guest to keep it painting (hold) or to stop (release). */
export interface CaptureGuestPaintRequest {
  reqId: string;
  webContentsId: number;
  hold: boolean;
}

export interface CaptureGuestPaintAck {
  reqId: string;
  held: boolean;
}
