// Console, network and viewport emulation.

import { rendererOp } from "./core";
import { inputOp } from "./input";
import type { PreviewToolTable } from "./types";

export const devtoolsPreviewTools: PreviewToolTable = {
  "preview.console": inputOp("console"),
  "preview.network": inputOp("network"),
  // The webview element's size is the guest viewport, so the renderer resizes it.
  "preview.resize": rendererOp("resize"),
};
