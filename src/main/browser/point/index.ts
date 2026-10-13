// Live wiring of pointing at the page: the workspace folder a tab's sources
// live in, the renderer's point:inspect channel (the picker and comments on
// the page), and the inspect entry the agent tool uses. The renderer side is
// window.spark.point (src/preload/areas/point.ts).

import { isRemotePath } from "../../../shared/remote";
import type { PointInspection } from "../../../shared/point-format";
import type { PointRegionInput } from "../../../shared/preview-point";
import type { IpcHandle } from "../../ipc";
import { writeBrowserArtifact } from "../artifacts";
import { resolveBrowserTarget } from "../targets";
import { inspectPage, MAX_INSPECTED_ELEMENTS, MAX_REGIONS, type PointInspectRequest } from "./inspect";

/** The local folder of a workspace, or null for an SSH workspace or an unknown id. */
export async function workspaceRootFor(workspaceId: string | null | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  const { loadState } = await import("../../storage");
  const workspace = (await loadState()).workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace?.cwd || isRemotePath(workspace.cwd)) return null;
  return workspace.cwd;
}

export interface PointInspectIpcRequest {
  workspaceId: string;
  tabId: string;
  selectors?: string[];
  regions?: PointRegionInput[];
  clearAttribute?: string;
  crops?: PointInspectRequest["crops"];
}

function finiteRegion(value: unknown): PointRegionInput | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x: x as number, y: y as number, width: Math.max(1, width as number), height: Math.max(1, height as number) }
    : null;
}

/** The picker's and comments' request, checked: it names a Codara tab of the given workspace. */
export async function inspectFromRenderer(request: PointInspectIpcRequest): Promise<PointInspection> {
  const workspaceId = typeof request?.workspaceId === "string" ? request.workspaceId : "";
  const tabId = typeof request?.tabId === "string" ? request.tabId : "";
  if (!workspaceId || !tabId || /^chrome:/i.test(tabId)) throw new Error("Pick from a Codara browser tab in an open workspace.");
  const selectors = Array.isArray(request.selectors) ? request.selectors.filter((s): s is string => typeof s === "string").slice(0, MAX_INSPECTED_ELEMENTS) : [];
  const regions = Array.isArray(request.regions)
    ? request.regions.map(finiteRegion).filter((r): r is PointRegionInput => r !== null).slice(0, MAX_REGIONS)
    : [];
  const clearAttribute = typeof request.clearAttribute === "string" && /^data-codara-[a-z-]{1,40}$/.test(request.clearAttribute) ? request.clearAttribute : undefined;
  const crops = request.crops === "data" || request.crops === "file" || request.crops === "both" ? request.crops : "none";
  const target = await resolveBrowserTarget({ tabId, workspaceId });
  return inspectPage(target, { selectors, regions, clearAttribute, crops, workspaceRoot: await workspaceRootFor(workspaceId) });
}

export interface PointSaveImageRequest {
  workspaceId: string;
  label: string;
  mimeType: "image/jpeg" | "image/png";
  /** Base64. */
  data: string;
}

const MAX_SAVED_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Saves an image the picker or a comment made (an element crop, an annotated
 * screenshot) under the workspace's browser screenshots, for text the user
 * copies: a copied path must outlive the popover.
 */
export async function saveImageFromRenderer(request: PointSaveImageRequest): Promise<string> {
  const workspaceId = typeof request?.workspaceId === "string" && request.workspaceId ? request.workspaceId : null;
  if (!workspaceId) throw new Error("Open a workspace first.");
  const ext = request.mimeType === "image/png" ? "png" : request.mimeType === "image/jpeg" ? "jpg" : null;
  if (!ext || typeof request.data !== "string") throw new Error("Only JPEG and PNG images can be saved.");
  const data = Buffer.from(request.data, "base64");
  if (!data.length || data.length > MAX_SAVED_IMAGE_BYTES) throw new Error("The image is empty or too large to save.");
  const label = typeof request.label === "string" ? request.label.slice(0, 60) : "image";
  return writeBrowserArtifact(workspaceId, "screenshots", { label, ext, data });
}

export function registerPointIpc(handle: IpcHandle): void {
  handle("point:inspect", async (_event, request: PointInspectIpcRequest) => inspectFromRenderer(request));
  handle("point:saveImage", async (_event, request: PointSaveImageRequest) => saveImageFromRenderer(request));
}
