// Screenshots, before/after comparisons, sizes side by side, and flow
// recordings. Every handler works on any browser target (a Codara tab or a
// shared Chrome tab) and in the background. Images go back as image
// content and are also saved under the workspace's data folder, so an
// agent that cannot read image content (or a shell user of `cora tool`)
// still has them as files.

import { isCompareOptionError, runCompare } from "../browser/capture/compare";
import { nativeBitmapCodec } from "../browser/capture/codec";
import { SizesOptionError } from "../browser/capture/sizes";
import { appRecordDeps, normalizeRecordOptions, RecordOptionError, claimRecording, startRecording, stopRecording } from "../browser/record/recorder";
import { captureScreenshot, normalizeScreenshotRequest, ScreenshotOptionError, type ScreenshotResult } from "../browser/screenshot";
import { resolveBrowserTarget, type BrowserTarget } from "../browser/targets";
import { PreviewToolParamsError, type PreviewToolTable } from "./types";

/** Compact by default: any model reads a 1280 px JPEG for a fraction of a full-size PNG. */
export const TOOL_SCREENSHOT_DEFAULTS = { format: "jpeg", quality: 70, maxWidth: 1280 } as const;

async function asParamsError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof ScreenshotOptionError ||
      error instanceof SizesOptionError ||
      error instanceof RecordOptionError ||
      isCompareOptionError(error)
    ) {
      throw new PreviewToolParamsError((error as Error).message);
    }
    throw error;
  }
}

export function screenshotToolResult(shot: ScreenshotResult): Record<string, unknown> {
  const { data, mimeType, ...rest } = shot;
  return { ...rest, mimeType, dataUrl: `data:${mimeType};base64,${data}` };
}

async function screenshot(params: Record<string, unknown>): Promise<unknown> {
  return asParamsError(async () => {
    const request = normalizeScreenshotRequest(params, TOOL_SCREENSHOT_DEFAULTS);
    const target = await resolveBrowserTarget(params);
    return screenshotToolResult(await captureScreenshot(target, request));
  });
}

async function compare(params: Record<string, unknown>): Promise<unknown> {
  return asParamsError(async () => runCompare(await resolveBrowserTarget(params), params, { bitmap: nativeBitmapCodec() }));
}

async function record(params: Record<string, unknown>): Promise<unknown> {
  return asParamsError(async () => {
    const options = params.stop === true ? null : normalizeRecordOptions(params);
    let target: BrowserTarget;
    try {
      target = await resolveBrowserTarget(params);
    } catch (error) {
      // The tab closed during the recording: its result is still kept.
      const done = !options && typeof params.tabId === "string" ? claimRecording(params.tabId) : null;
      if (done) return done;
      throw error;
    }
    if (!options) return stopRecording(target);
    const started = await startRecording(target, options, appRecordDeps(nativeBitmapCodec()));
    return {
      ...started,
      next: `Drive the flow, then call codara_preview_record with stop: true${params.tabId ? ` and tabId ${JSON.stringify(target.ref)}` : ""}. It stops itself after ${options.maxSeconds} s.`,
    };
  });
}

export const capturePreviewTools: PreviewToolTable = {
  "preview.screenshot": { run: screenshot, targets: "any" },
  "preview.compare": { run: compare, targets: "any" },
  "preview.record": { run: record, targets: "any" },
};
