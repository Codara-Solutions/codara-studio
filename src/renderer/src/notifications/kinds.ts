import type { InAppNotificationTone, NotifyKind } from "@shared/types";

// Per-kind presentation metadata shared by the toast cards and the
// notification center: a short label (center rows), the fallback tone, and
// which glyph the icon chip renders.

// "loop" is the automation family's shared glyph — a circular-arrow (mirrors
// the app's reload glyph) that reads as "repeats", so every automation.* alert
// is recognizable at a glance regardless of outcome.
export type NotifyGlyph = "check" | "alert" | "cross" | "bell" | "loop";

export interface NotifyKindMeta {
  label: string;
  tone: InAppNotificationTone;
  glyph: NotifyGlyph;
}

const FALLBACK_META: NotifyKindMeta = { label: "Notification", tone: "success", glyph: "bell" };

export const NOTIFY_KIND_META: Record<NotifyKind, NotifyKindMeta> = {
  "run.blocked": { label: "Needs you", tone: "warning", glyph: "alert" },
  "run.complete": { label: "Run finished", tone: "success", glyph: "check" },
  "run.failed": { label: "Run failed", tone: "danger", glyph: "cross" },
  "terminal.agent.needs-input": { label: "Agent needs input", tone: "warning", glyph: "alert" },
  "terminal.agent.done": { label: "Agent finished", tone: "success", glyph: "check" },
  // The automation family shares the "loop" glyph and the violet accent (see
  // accentVar) so it reads as its own group. The tone still drives the sound
  // and the a11y role; the title text ("Automation — finished/failed/needs
  // you") carries the outcome.
  "automation.finished": { label: "Automation finished", tone: "success", glyph: "loop" },
  "automation.failed": { label: "Automation failed", tone: "danger", glyph: "loop" },
  "automation.blocked": { label: "Automation needs you", tone: "warning", glyph: "loop" },
  "app.update-ready": { label: "Update ready", tone: "success", glyph: "bell" },
};

// Tolerates unknown kinds from a persisted history written by a newer build.
export function kindMeta(kind: NotifyKind): NotifyKindMeta {
  return NOTIFY_KIND_META[kind] ?? FALLBACK_META;
}

// The accent color a notification renders with — the left status rule, the icon
// chip tint/border, and the glyph color all derive from it. Automation.* kinds
// share a dedicated violet family (var(--automation)) so they're instantly
// distinguishable from run/terminal alerts; every other kind uses its tone
// color. Kept here (not inline in a component) so the toast card and the
// notification center apply the same family treatment.
export function accentVar(kind: NotifyKind, tone: InAppNotificationTone): string {
  if (kind.startsWith("automation.")) return "var(--automation)";
  return tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warn)" : "var(--ok)";
}
