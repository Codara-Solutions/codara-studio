// window.spark.point: the renderer side of src/main/browser/point/ (the
// element picker and comments on the page).

import { ipcRenderer } from "electron";
import type { PointInspection } from "@shared/point-format";
import type { PointRegionInput } from "@shared/preview-point";

export interface PointInspectRequest {
  workspaceId: string;
  tabId: string;
  /** @refs or unique selectors. */
  selectors?: string[];
  /** Viewport CSS pixels, for the elements under drawn marks. */
  regions?: PointRegionInput[];
  crops?: "none" | "data" | "file" | "both";
}

export interface PointSaveImageRequest {
  workspaceId: string;
  label: string;
  mimeType: "image/jpeg" | "image/png";
  /** Base64. */
  data: string;
}

export interface PointSaveDetailsRequest {
  workspaceId: string;
  label: string;
  /** Plain JSON data. */
  details: Record<string, unknown>;
}

export const pointApi = {
  inspect: (request: PointInspectRequest): Promise<PointInspection> => ipcRenderer.invoke("point:inspect", request),
  /** Saves under the workspace's browser screenshots and returns the path. */
  saveImage: (request: PointSaveImageRequest): Promise<string> => ipcRenderer.invoke("point:saveImage", request),
  /** Saves JSON under the workspace's browser snapshots and returns the path. */
  saveDetails: (request: PointSaveDetailsRequest): Promise<string> => ipcRenderer.invoke("point:saveDetails", request),
};
