// Screenshots. The image goes back as image content and is also saved under
// the workspace's data folder, so an agent that cannot read image content
// (or a shell user of `cora tool`) still has it as a file.

import { nativeImage } from "electron";

import { writeBrowserArtifact } from "../browser/artifacts";
import { emulatedViewport } from "../browser/emulation";
import { resolveBrowserTarget } from "../browser/targets";
import { requestPreviewOp } from "../preview-bridge";
import type { PreviewToolTable } from "./types";

/**
 * A tab emulating a device viewport. The renderer's capture is of the tab's
 * view, which shows that viewport cut or padded to the view's own size, so
 * its image would not match the viewport and scale it reports; the target's
 * capture renders exactly the emulated viewport.
 */
async function emulatedScreenshot(params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (typeof params.tabId === "string" && /^chrome:/i.test(params.tabId)) return null;
  const target = await resolveBrowserTarget(params).catch(() => null);
  if (!target || target.kind !== "preview" || !emulatedViewport(target.session)) return null;
  const png = await target.captureViewport();
  const info = await target.info();
  const viewport = info.viewport ?? emulatedViewport(target.session);
  const imageSize = nativeImage.createFromBuffer(png).getSize();
  return {
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    tabId: target.ref,
    url: info.url,
    title: info.title,
    viewport,
    imageSize,
    scale: viewport && viewport.width > 0 && viewport.height > 0
      ? { x: imageSize.width / viewport.width, y: imageSize.height / viewport.height }
      : null,
  };
}

async function screenshot(params: Record<string, unknown>): Promise<unknown> {
  const result = (await emulatedScreenshot(params)) ?? (await requestPreviewOp("screenshot", { ...params }));
  if (!result || typeof result !== "object") return result;
  const shot = result as Record<string, unknown>;
  const match = typeof shot.dataUrl === "string" ? /^data:image\/(png|jpeg);base64,(.+)$/.exec(shot.dataUrl) : null;
  if (!match) return result;
  try {
    const path = await writeBrowserArtifact(
      typeof params.workspaceId === "string" ? params.workspaceId : null,
      "screenshots",
      { label: typeof shot.tabId === "string" ? shot.tabId : "tab", ext: match[1] === "jpeg" ? "jpg" : "png", data: Buffer.from(match[2], "base64") },
    );
    return { ...shot, path };
  } catch {
    // The image itself still answers the call.
    return result;
  }
}

export const capturePreviewTools: PreviewToolTable = {
  "preview.screenshot": screenshot,
};
