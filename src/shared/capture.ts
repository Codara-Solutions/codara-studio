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

export type CaptureRecordFormat = "mp4" | "webm" | "gif";

export interface CaptureRecordRequest {
  webContentsId: number;
  tabId?: string | null;
  workspaceId?: string | null;
  action: "start" | "stop" | "status";
  format?: CaptureRecordFormat;
}

export interface CaptureRecordingStatus {
  recording: true;
  tabId: string;
  format: CaptureRecordFormat;
  elapsedMs: number;
  frames: number;
  maxSeconds: number;
}

export interface CaptureRecordingResult {
  recording: false;
  tabId: string;
  path: string;
  format: CaptureRecordFormat;
  mimeType: string;
  bytes: number;
  frames: number;
  durationMs: number;
  size: { width: number; height: number };
  fps: number;
  encodeMs?: number;
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
  /** While a stopped recording encodes: how far along, 0 to 1. */
  progress?: number;
  result?: CaptureRecordingResult;
  error?: string;
}

/** Save a finished recording elsewhere (a save dialog) or put it on the clipboard. */
export interface CaptureRecordingFileRequest {
  path: string;
  action: "save" | "copy";
}

export interface CaptureRecordingFileResponse {
  /** Where it was saved; null when the dialog was cancelled. */
  savedTo?: string | null;
  /** What the clipboard got: the file itself, or its path where the system cannot hold files. */
  copied?: "file" | "path";
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
