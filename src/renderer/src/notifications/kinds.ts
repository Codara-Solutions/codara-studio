import type { InAppNotificationTone, NotifyKind } from "@shared/types";

// Per-kind presentation metadata shared by the toast cards and the
// notification center: a short label (center rows), the fallback tone, and
// which glyph the icon chip renders.

export type NotifyGlyph = "check" | "alert" | "cross" | "bell";

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
  "automation.finished": { label: "Loom finished", tone: "success", glyph: "check" },
  "automation.failed": { label: "Loom failed", tone: "danger", glyph: "cross" },
  "app.update-ready": { label: "Update ready", tone: "success", glyph: "bell" },
};

// Tolerates unknown kinds from a persisted history written by a newer build.
export function kindMeta(kind: NotifyKind): NotifyKindMeta {
  return NOTIFY_KIND_META[kind] ?? FALLBACK_META;
}
