// Socket methods behind resources/codara-studio-mcp/tools/browser-point.cjs.
// codara_preview_inspect describes one element the way the picker does for
// the user (selector, box model, styles, CSS rules, source file and line),
// on a Codara tab or a shared Chrome tab. The picker and comments on the
// page are renderer UI that sends through src/main/agent-delivery.ts.

import { elementAtPoint } from "../browser/locator";
import { inspectPage } from "../browser/point/inspect";
import { resolveBrowserTarget } from "../browser/targets";
import { PreviewToolParamsError, type PreviewToolTable } from "./types";

async function inspect(params: Record<string, unknown>): Promise<unknown> {
  const ref = typeof params.ref === "string" && params.ref.trim() ? params.ref.trim() : null;
  const x = typeof params.x === "number" && Number.isFinite(params.x) ? params.x : null;
  const y = typeof params.y === "number" && Number.isFinite(params.y) ? params.y : null;
  if (!ref && (x === null || y === null)) {
    throw new PreviewToolParamsError("Pass ref (an @ref from a snapshot or a unique CSS selector), or x and y in viewport CSS pixels.");
  }
  const target = await resolveBrowserTarget(params);
  let selector = ref;
  if (!selector) {
    const hit = await elementAtPoint(target, x as number, y as number);
    if (!hit) throw new Error(`No element at ${x},${y}. Viewport coordinates are CSS pixels; take a screenshot to check.`);
    selector = hit.ref;
  }
  const { workspaceRootFor } = await import("../browser/point");
  const workspaceId = target.workspaceId ?? (typeof params.workspaceId === "string" ? params.workspaceId : null);
  const inspection = await inspectPage(target, { selectors: [selector], crops: "both", workspaceRoot: await workspaceRootFor(workspaceId) });
  const missing = inspection.missing[0];
  if (missing) throw new PreviewToolParamsError(missing.error);
  const element = inspection.elements[0];
  void target.showActivity("Inspecting", element ? { x: element.box.x + element.box.width / 2, y: element.box.y + element.box.height / 2 } : undefined);
  const { crop, ...described } = element;
  return {
    tabId: inspection.tabId,
    url: inspection.url,
    title: inspection.title,
    viewport: inspection.viewport,
    scroll: inspection.scroll,
    element: described,
    ...(crop?.path ? { path: crop.path } : {}),
    ...(crop?.data ? { dataUrl: `data:${crop.mimeType};base64,${crop.data}` } : {}),
  };
}

export const pointPreviewTools: PreviewToolTable = {
  "preview.inspect": { run: inspect, targets: "any" },
};
