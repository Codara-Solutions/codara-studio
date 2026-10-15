import { useState, type CSSProperties } from "react";
import {
  WORKSPACE_STATUS_IDS,
  WORKSPACE_STATUS_LABELS,
  WORKSPACE_STATUS_NOTE_MAX,
  WORKSPACE_STATUS_TONES,
  workspaceStatusAge,
  type WorkspaceStatusId,
  type WorkspaceStatusPatch,
} from "@shared/workspace-status";
import { unwrapIpcError } from "../../lib/ipc-error";
import { WorkspaceStatusChip } from "./WorkspaceStatusChip";
import { setWorkspaceStatus, useWorkspaceStatus } from "./workspaceStatusStore";

const sectionLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "var(--muted)",
  padding: "0 6px",
};

// Body of the rail's "Set status…" popover: the five statuses, the progress
// note, and the latest checkpoints agents or the user left. The parent
// supplies the AnchoredMenu shell. The statuses are options, so the menu's
// arrow keys walk them and opening the popover focuses the current one.
export default function WorkspaceStatusPicker({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const entry = useWorkspaceStatus(workspaceId);
  const [status, setStatus] = useState<WorkspaceStatusId | null>(entry?.status ?? null);
  const [note, setNote] = useState(entry?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (patch: WorkspaceStatusPatch) => {
    setSaving(true);
    setError(null);
    try {
      await setWorkspaceStatus(workspaceId, patch);
      onClose();
    } catch (err) {
      setError(unwrapIpcError(err));
    } finally {
      setSaving(false);
    }
  };
  const save = () => void apply({ status, note });
  const checkpoints = entry ? entry.checkpoints.slice().reverse() : [];
  const now = Date.now();

  return (
    <div
      data-testid="workspace-status-picker"
      style={{ width: 256, padding: 4, display: "grid", gap: 8 }}
      // The popover is portalled, but React still bubbles its events to the
      // row it was opened from, whose click selects the workspace.
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div style={{ display: "grid", gap: 2 }}>
        <div id={`workspace-status-label-${workspaceId}`} style={{ ...sectionLabel, paddingTop: 4 }}>
          Status
        </div>
        <div role="listbox" aria-labelledby={`workspace-status-label-${workspaceId}`} style={{ display: "grid", gap: 2 }}>
          {WORKSPACE_STATUS_IDS.map((id, index) => {
            const selected = status === id;
            // One tab stop for the list (the chosen status, else the first):
            // Tab moves on to the note, the arrows walk the statuses.
            const tabStop = status === null ? index === 0 : selected;
            return (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={tabStop ? 0 : -1}
                className={selected ? "spark-menu-item is-active" : "spark-menu-item"}
                onClick={() => setStatus(selected ? null : id)}
                onDoubleClick={() => void apply({ status: id, note })}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 7, height: 7, borderRadius: 999, flex: "0 0 7px", background: WORKSPACE_STATUS_TONES[id] }}
                />
                <span style={{ flex: 1 }}>{WORKSPACE_STATUS_LABELS[id]}</span>
                {selected && (
                  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <polyline points="1.5,5.5 4,8 8.5,2.5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={sectionLabel}>Progress note</span>
        <input
          className="spark-input"
          value={note}
          maxLength={WORKSPACE_STATUS_NOTE_MAX}
          placeholder="What is done or happening now"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            // Text editing keys stay in the field; the menu's own arrow and
            // Home/End handling would move focus to the status list.
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          style={{ margin: "0 4px", width: "calc(100% - 8px)", boxSizing: "border-box" }}
        />
      </label>

      {error && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: 11, padding: "0 6px" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, padding: "0 4px 2px" }}>
        <button
          type="button"
          className="spark-btn"
          disabled={saving || !entry}
          onClick={() => void apply({ clear: true })}
        >
          Clear
        </button>
        <button type="button" className="spark-btn is-primary" disabled={saving} onClick={save}>
          Save
        </button>
      </div>

      {checkpoints.length > 0 && (
        <section
          aria-label="Recent checkpoints"
          style={{ borderTop: "1px solid var(--rule-soft)", paddingTop: 7, display: "grid", gap: 5 }}
        >
          <div style={sectionLabel}>Recent checkpoints</div>
          <ol
            data-testid="workspace-status-checkpoints"
            style={{ listStyle: "none", margin: 0, padding: "0 6px 4px", display: "grid", gap: 6, maxHeight: 180, overflow: "auto" }}
          >
            {checkpoints.map((checkpoint, index) => (
              <li key={`${checkpoint.at}-${index}`} style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {checkpoint.status && <WorkspaceStatusChip status={checkpoint.status} />}
                  <span style={{ fontSize: 10.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {checkpoint.by.label}, {workspaceStatusAge(checkpoint.at, now)}
                  </span>
                </div>
                {checkpoint.note && (
                  <div style={{ fontSize: 11, lineHeight: 1.35, color: "var(--ink-dim)", overflowWrap: "anywhere" }}>
                    {checkpoint.note}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
