// Audits, traces with Core Web Vitals and memory snapshots
// (resources/codara-studio-mcp/tools/browser-insight.cjs). Handlers resolve
// their tab with resolveBrowserTarget() and mark themselves targets: "any",
// so they work on Chrome tabs too.

import { auditAccessibility } from "../browser/audit/accessibility";
import { auditQuality } from "../browser/audit/quality";
import { resolveBrowserTarget } from "../browser/targets";
import { PreviewToolParamsError, type PreviewToolTable } from "./types";

const AUDIT_KINDS = ["accessibility", "quality"] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  if (value === undefined || value === null) {
    if (fallback) return fallback;
    throw new PreviewToolParamsError(`${name} is required: ${allowed.join(", ")}.`);
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PreviewToolParamsError(`${name} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

async function audit(params: Record<string, unknown>): Promise<unknown> {
  const kind = oneOf(params.kind, AUDIT_KINDS, "kind", "accessibility");
  const target = await resolveBrowserTarget(params);
  return kind === "quality" ? auditQuality(target) : auditAccessibility(target);
}

export const insightPreviewTools: PreviewToolTable = {
  "preview.audit": { run: audit, targets: "any" },
};
