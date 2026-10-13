// Audits, traces with Core Web Vitals and memory snapshots
// (resources/codara-studio-mcp/tools/browser-insight.cjs). Handlers resolve
// their tab with resolveBrowserTarget() and mark themselves targets: "any",
// so they work on Chrome tabs too.

import { auditAccessibility } from "../browser/audit/accessibility";
import { auditQuality } from "../browser/audit/quality";
import {
  LOAD_WAIT_DEFAULT_MS,
  SAMPLE_MAX_MS,
  measureLoad,
  measureMemory,
  measureVitals,
  startInteractionTrace,
  stopInteractionTrace,
} from "../browser/perf/performance";
import { TraceStateError } from "../browser/perf/trace";
import { resolveBrowserTarget } from "../browser/targets";
import { PreviewToolParamsError, type PreviewToolTable } from "./types";

const AUDIT_KINDS = ["accessibility", "quality"] as const;
const PERFORMANCE_ACTIONS = ["vitals", "load", "start", "stop", "memory"] as const;

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

function duration(value: unknown, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new PreviewToolParamsError("ms must be a number of milliseconds, 0 or more.");
  return Math.min(Math.round(value), max);
}

async function audit(params: Record<string, unknown>): Promise<unknown> {
  const kind = oneOf(params.kind, AUDIT_KINDS, "kind", "accessibility");
  const target = await resolveBrowserTarget(params);
  return kind === "quality" ? auditQuality(target) : auditAccessibility(target);
}

async function performance(params: Record<string, unknown>): Promise<unknown> {
  const action = oneOf(params.action, PERFORMANCE_ACTIONS, "action");
  const snapshot = params.snapshot === true;
  if (params.snapshot !== undefined && typeof params.snapshot !== "boolean") throw new PreviewToolParamsError("snapshot must be true or false.");
  const target = await resolveBrowserTarget(params);
  try {
    switch (action) {
      case "vitals":
        return await measureVitals(target);
      case "load":
        return await measureLoad(target, Math.max(1_000, duration(params.ms, 30_000, LOAD_WAIT_DEFAULT_MS)));
      case "start":
        return await startInteractionTrace(target);
      case "stop":
        return await stopInteractionTrace(target);
      case "memory":
        // A snapshot and its summary need time of their own within the call.
        return await measureMemory(target, duration(params.ms, snapshot ? 20_000 : SAMPLE_MAX_MS, 0), snapshot);
    }
  } catch (error) {
    if (error instanceof TraceStateError) throw new PreviewToolParamsError(error.message);
    throw error;
  }
}

export const insightPreviewTools: PreviewToolTable = {
  "preview.audit": { run: audit, targets: "any" },
  "preview.performance": { run: performance, targets: "any" },
};
