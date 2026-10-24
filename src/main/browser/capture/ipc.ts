// The capture features' window channels: recording a browser tab from its
// toolbar (and saving or copying the file it made), and the responsive
// view's per-frame emulation. Both act on a <webview> guest the renderer
// names by id, so each first proves it is a real preview guest of the
// trusted window. The renderer side is window.spark.capture
// (src/preload/areas/capture.ts).

import { promises as fs } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { app, BrowserWindow, clipboard, dialog, webContents, type WebContents } from "electron";

import type {
  CaptureFrameEmulationRequest,
  CaptureRecordingFileRequest,
  CaptureRecordingFileResponse,
  CaptureRecordRequest,
  CaptureRecordResponse,
} from "../../../shared/capture";
import { writeClipboardFilePaths } from "../../clipboard-files";
import { workspaceDataRoot } from "../../workspace-data";
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

/** A recording this app made: a file in some workspace's browser/recordings folder. */
async function recordingFile(path: unknown): Promise<string> {
  if (typeof path !== "string" || !path) throw new Error("No recording was named.");
  const full = resolve(path);
  const parts = relative(workspaceDataRoot(), full).split(sep);
  const inRecordings = parts.length === 4 && parts[0] !== ".." && parts[1] === "browser" && parts[2] === "recordings";
  if (!inRecordings || !/\.(gif|mp4|webm)$/i.test(full)) throw new Error("That is not a recording.");
  const stat = await fs.stat(full).catch(() => null);
  if (!stat?.isFile()) throw new Error("That recording is not there any more.");
  return full;
}

let forwarding = false;

export function registerCaptureIpc(handle: IpcHandle): void {
  handle("capture:record", async (_event, request: CaptureRecordRequest): Promise<CaptureRecordResponse> => {
    const wc = guest(request?.webContentsId);
    const target = guestTarget(wc, request.tabId, request.workspaceId);
    const key = target.session.key;
    if (request.action === "status") return { key, status: recordingStatus(target) };
    if (request.action === "stop") return { key, result: await stopRecording(target) };
    const format = request.format === "gif" || request.format === "webm" ? request.format : "mp4";
    const options = normalizeRecordOptions({ format });
    return { key, status: await startRecording(target, options, appRecordDeps(nativeBitmapCodec())) };
  });

  handle("capture:recordingFile", async (event, request: CaptureRecordingFileRequest): Promise<CaptureRecordingFileResponse> => {
    const path = await recordingFile(request?.path);
    if (request.action === "copy") {
      // The file itself where the system clipboard holds files (macOS,
      // Windows), so it pastes into a chat or an issue; its path elsewhere.
      if (await writeClipboardFilePaths([path])) return { copied: "file" };
      clipboard.writeText(path);
      return { copied: "path" };
    }
    if (request.action !== "save") throw new Error("Unknown recording action.");
    const window = BrowserWindow.fromWebContents(event.sender);
    const ext = extname(path).slice(1);
    const options = {
      title: "Save recording",
      defaultPath: join(app.getPath("downloads"), basename(path)),
      filters: [{ name: ext === "gif" ? "GIF image" : `${ext.toUpperCase()} video`, extensions: [ext] }],
    };
    const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return { savedTo: null };
    const destination = choice.filePath.toLowerCase().endsWith(`.${ext}`) ? choice.filePath : `${choice.filePath}.${ext}`;
    await fs.copyFile(path, destination);
    return { savedTo: destination };
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
