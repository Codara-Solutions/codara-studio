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

export const pointApi = {
  inspect: (request: PointInspectRequest): Promise<PointInspection> => ipcRenderer.invoke("point:inspect", request),
};
