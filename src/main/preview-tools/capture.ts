// Screenshots. The image goes back as image content and is also saved under
// the workspace's data folder, so an agent that cannot read image content
// (or a shell user of `cora tool`) still has it as a file.

import { writeBrowserArtifact } from "../browser/artifacts";
import { requestPreviewOp } from "../preview-bridge";
import type { PreviewToolTable } from "./types";

async function screenshot(params: Record<string, unknown>): Promise<unknown> {
  const result = await requestPreviewOp("screenshot", { ...params });
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
