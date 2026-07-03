/**
 * Shared run-status presentation helpers.
 *
 * SparkAgentPanel, SettingsDialog and RunsView each used to carry their own
 * near-identical "status -> color" and "is this status live?" helpers. They
 * are consolidated here so the mapping has a single source of truth — and so
 * the `paused` case is handled everywhere (RunsView's old `statusColor`
 * omitted it, which made paused runs render with the wrong dot color).
 *
 * The returned strings are CSS custom-property references resolved against
 * Codara's design tokens (see styles.css).
 */
import type { RunStatus } from "@shared/types";

/**
 * Map a run status to the design token used for its status dot / accent.
 * Covers every `RunStatus` member:
 *  - planning / running / reviewing -> accent (work in progress)
 *  - complete                       -> ok
 *  - blocked / failed               -> danger
 *  - paused                         -> info
 *  - idle / cancelled               -> muted
 */
export function runStatusColor(status: RunStatus): string {
  if (status === "running" || status === "reviewing" || status === "planning") return "var(--accent)";
  if (status === "complete") return "var(--ok)";
  if (status === "blocked" || status === "failed") return "var(--danger)";
  if (status === "paused") return "var(--info)";
  return "var(--muted)";
}

/**
 * True when a run is actively progressing (planning, running, or in review)
 * and therefore should render live affordances such as the pulsing dot.
 */
export function isRunningStatus(status: RunStatus): boolean {
  return status === "running" || status === "reviewing" || status === "planning";
}
