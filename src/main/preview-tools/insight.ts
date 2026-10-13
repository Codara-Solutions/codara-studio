// Audits, traces with Core Web Vitals and memory snapshots
// (resources/codara-studio-mcp/tools/browser-insight.cjs). Handlers resolve
// their tab with resolveBrowserTarget() and mark themselves targets: "any",
// so they work on Chrome tabs too.

import type { PreviewToolTable } from "./types";

export const insightPreviewTools: PreviewToolTable = {};
