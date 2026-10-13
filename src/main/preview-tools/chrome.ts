// Chrome-tab versions of the browser methods whose main handler only knows
// Codara's own tabs (the renderer-side ones in core.ts and capture.ts). A
// method listed here runs when its tabId is a chrome: id; new tools that
// resolve their tab with resolveBrowserTarget() mark themselves
// `targets: "any"` instead and need no entry.

import type { PreviewToolTable } from "./types";

export const chromeTargetTools: PreviewToolTable = {};
