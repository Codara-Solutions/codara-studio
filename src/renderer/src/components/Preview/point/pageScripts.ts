import { createPreviewDOM } from "@shared/preview-dom";
import { createPreviewLocator } from "@shared/preview-locator";
import { installHoverProbe, outlineProbe, type HoverInfo, type HoverProbeCall, type OutlineRow } from "@shared/preview-point";

// Page expressions for the picker overlay, run in the guest's main world
// through webview.executeJavaScript so the @refs they mint are the ones the
// agent tools and point.inspect resolve (both read window.__codaraPreviewDOM).

export type RunInPage = (code: string) => Promise<unknown>;

const MISSING = "__codaraPointMissing";

function installExpression(call: HoverProbeCall): string {
  return `(${installHoverProbe.toString()})(${createPreviewLocator.toString()}, ${createPreviewDOM.toString()})(${JSON.stringify(call)})`;
}

/**
 * Asks the page what is under the pointer (or at a ref). The helper stays
 * installed until the next navigation, so a pointer move sends a few bytes
 * and only the first move after a load sends the factories.
 */
export async function hoverInPage(run: RunInPage, call: HoverProbeCall): Promise<HoverInfo | null> {
  const quick = `(window.__codaraPointHover ? window.__codaraPointHover(${JSON.stringify(call)}) : ${JSON.stringify(MISSING)})`;
  const value = await run(quick);
  if (value !== MISSING) return (value as HoverInfo | null) ?? null;
  return ((await run(installExpression(call))) as HoverInfo | null) ?? null;
}

export async function outlineInPage(run: RunInPage, max = 400): Promise<{ rows: OutlineRow[]; truncated: boolean }> {
  const code = `(${outlineProbe.toString()})(${JSON.stringify({ max })}, (${createPreviewLocator.toString()})(${createPreviewDOM.toString()}))`;
  return (await run(code)) as { rows: OutlineRow[]; truncated: boolean };
}
