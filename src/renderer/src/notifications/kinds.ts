import type { InAppNotificationTone, NotifyKind } from "@shared/types";
import { notifyState } from "@shared/notify-center";

// Per-kind presentation metadata shared by the toast cards and the
// notification center: a short label (center rows), the fallback tone, and
// which glyph the icon chip renders.

// The glyph says what happened, so a state that asks something of the user
// looks the same whatever raised it: "alert" for every needs-you, "cross" for
// every failure. Finished work gets a check, or the "loop" mark when an
// automation finished. Informational kinds get a glyph for their source.
export type NotifyGlyph = "check" | "alert" | "cross" | "bell" | "loop" | "commit" | "pr" | "download";

export interface NotifyKindMeta {
  label: string;
  tone: InAppNotificationTone;
  glyph: NotifyGlyph;
}

const FALLBACK_META: NotifyKindMeta = { label: "Notification", tone: "success", glyph: "bell" };

export const NOTIFY_KIND_META: Record<NotifyKind, NotifyKindMeta> = {
  "run.blocked": { label: "Cora needs you", tone: "warning", glyph: "alert" },
  "run.complete": { label: "Cora finished", tone: "success", glyph: "check" },
  "run.failed": { label: "Cora run failed", tone: "danger", glyph: "cross" },
  "terminal.agent.needs-input": { label: "Agent needs input", tone: "warning", glyph: "alert" },
  "terminal.agent.done": { label: "Agent finished", tone: "success", glyph: "check" },
  "terminal.agent.failed": { label: "Agent failed", tone: "danger", glyph: "cross" },
  "automation.finished": { label: "Automation finished", tone: "success", glyph: "loop" },
  "automation.failed": { label: "Automation failed", tone: "danger", glyph: "cross" },
  "automation.blocked": { label: "Automation needs you", tone: "warning", glyph: "alert" },
  // A Notify step inside a loom pass: user-authored text, so the label is
  // neutral and the body IS the message.
  "automation.step": { label: "Automation", tone: "success", glyph: "loop" },
  "app.update-ready": { label: "Update ready", tone: "success", glyph: "download" },
  "git.teammate-push": { label: "Teammate pushed", tone: "success", glyph: "commit" },
  "git.pull-request": { label: "Pull request", tone: "success", glyph: "pr" },
  "git.ci-failed": { label: "CI failed", tone: "danger", glyph: "cross" },
  "worktree.setup-approval": { label: "Setup needs you", tone: "warning", glyph: "alert" },
};

// Tolerates unknown kinds from a persisted history written by a newer build.
export function kindMeta(kind: NotifyKind): NotifyKindMeta {
  return NOTIFY_KIND_META[kind] ?? FALLBACK_META;
}

// The accent color a notification renders with: the toast's left status
// rule, the icon chip tint and border, and the glyph. State comes first, so
// an automation that needs you is amber like any other question and one that
// failed is red. Automation outcomes that need nothing keep the violet
// automation family, and informational kinds (a push, a pull request) use
// the info blue rather than claiming success.
export function accentVar(kind: NotifyKind, tone: InAppNotificationTone): string {
  if (tone === "danger") return "var(--danger)";
  if (tone === "warning") return "var(--warn)";
  if (kind.startsWith("automation.")) return "var(--automation)";
  if (notifyState(kind) === "info") return "var(--info)";
  return "var(--ok)";
}
