import {
  WORKSPACE_STATUS_LABELS,
  WORKSPACE_STATUS_TONES,
  workspaceStatusAge,
  type WorkspaceStatusEntry,
  type WorkspaceStatusId,
} from "@shared/workspace-status";
import { useWorkspaceStatus } from "./workspaceStatusStore";

// A workspace's status as a small tinted pill, in the status's own tone (the
// theme's info, ok, danger... tokens, which the light palettes re-tint), so
// it reads the same in every workspace color.
export function WorkspaceStatusChip({ status }: { status: WorkspaceStatusId }) {
  const tone = WORKSPACE_STATUS_TONES[status];
  return (
    <span
      data-testid="workspace-status-chip"
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flex: "0 0 auto",
        height: 14,
        padding: "0 5px",
        borderRadius: 999,
        fontSize: 9.5,
        fontWeight: 600,
        lineHeight: "14px",
        whiteSpace: "nowrap",
        color: tone,
        background: `color-mix(in oklab, ${tone} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 26%, transparent)`,
      }}
    >
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: tone }} />
      {WORKSPACE_STATUS_LABELS[status]}
    </span>
  );
}

/** "In review. Tests pass. Set by Codex 5 min ago." */
export function describeWorkspaceStatus(entry: WorkspaceStatusEntry, now = Date.now()): string {
  const parts: string[] = [];
  if (entry.status) parts.push(`${WORKSPACE_STATUS_LABELS[entry.status]}.`);
  if (entry.note) parts.push(/[.!?…]$/.test(entry.note) ? entry.note : `${entry.note}.`);
  if (entry.updatedAt > 0) {
    const who = entry.by.kind === "user" ? "you" : entry.by.label;
    parts.push(`Set by ${who} ${workspaceStatusAge(entry.updatedAt, now)}.`);
  }
  return parts.join(" ");
}

// The line under a workspace's name in the rail: the chip, then the note cut
// to one line. Renders nothing for a workspace with neither.
export function WorkspaceStatusLine({ workspaceId, active = false }: { workspaceId: string; active?: boolean }) {
  const entry = useWorkspaceStatus(workspaceId);
  if (!entry) return null;
  const description = describeWorkspaceStatus(entry);
  return (
    <span
      data-testid="workspace-status"
      role="note"
      aria-label={`Workspace status: ${description}`}
      title={description}
      style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, marginTop: 2 }}
    >
      {entry.status && <WorkspaceStatusChip status={entry.status} />}
      {entry.note && (
        <span
          data-testid="workspace-status-note"
          style={{
            minWidth: 0,
            fontSize: 10.5,
            lineHeight: "13px",
            color: active ? "var(--ink-dim)" : "var(--muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {entry.note}
        </span>
      )}
    </span>
  );
}
