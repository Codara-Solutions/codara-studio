import { useEffect, useState } from "react";

// Two small surfaces for the copy-branch workspace flow:
//  - CopyBranchDeleteDialog: confirm removing a worktree-backed workspace,
//    with an opt-in to also delete its branch.
//  - CopyBranchErrorToast: a transient danger card for create/delete failures
//    (the app has no generic renderer-side toast push; notifications only flow
//    from the main process).

export function CopyBranchDeleteDialog({
  workspaceName,
  branch,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  workspaceName: string;
  branch: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (opts: { deleteBranch: boolean; force: boolean }) => void;
}) {
  const [deleteBranch, setDeleteBranch] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  // git worktree remove refuses a dirty tree; surface a force retry then.
  const dirty = Boolean(error && /contains modified or untracked|use --force/i.test(error));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete workspace ${workspaceName}`}
      style={{
        position: "absolute",
        inset: 0,
        background: "color-mix(in oklch, var(--bg) 70%, transparent)",
        display: "grid",
        placeItems: "center",
        zIndex: 1200,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        style={{
          width: "min(420px, calc(100vw - 48px))",
          background: "var(--panel-2)",
          border: "1px solid var(--rule)",
          borderRadius: 10,
          boxShadow: "var(--shadow-2)",
          padding: 18,
          fontFamily: "var(--font-sans)",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
          Delete “{workspaceName}”?
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5 }}>
          This removes the git worktree from disk. The branch{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>{branch}</code> is kept
          unless you choose to delete it.
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--ink)",
            cursor: busy ? "not-allowed" : "default",
          }}
        >
          <input
            type="checkbox"
            checked={deleteBranch}
            disabled={busy}
            onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
          />
          Also delete the branch (only if already merged)
        </label>
        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--danger)",
              background: "color-mix(in oklch, var(--danger) 12%, transparent)",
              border: "1px solid color-mix(in oklch, var(--danger) 40%, var(--rule))",
              borderRadius: 6,
              padding: "8px 10px",
              overflowWrap: "anywhere",
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <DialogButton label="Cancel" onClick={onCancel} disabled={busy} />
          {dirty && (
            <DialogButton
              label={busy ? "Removing…" : "Force remove"}
              danger
              disabled={busy}
              onClick={() => onConfirm({ deleteBranch, force: true })}
            />
          )}
          {!dirty && (
            <DialogButton
              label={busy ? "Removing…" : "Delete"}
              danger
              disabled={busy}
              onClick={() => onConfirm({ deleteBranch, force: false })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DialogButton({
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: "none",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        padding: "7px 14px",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "default",
        opacity: disabled ? 0.55 : 1,
        color: danger ? "var(--danger)" : "var(--ink)",
        background: danger
          ? "color-mix(in oklch, var(--danger) 14%, transparent)"
          : "transparent",
        border: `1px solid ${
          danger
            ? "color-mix(in oklch, var(--danger) 50%, var(--rule))"
            : "var(--rule-strong)"
        }`,
      }}
    >
      {label}
    </button>
  );
}

export function CopyBranchErrorToast({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(onDismiss, 6_000);
    return () => window.clearTimeout(id);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div
      role="alert"
      className="spark-fade-in"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        zIndex: 1100,
        maxWidth: "min(380px, calc(100vw - 32px))",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid color-mix(in oklch, var(--danger) 60%, var(--rule-strong))",
        background: "color-mix(in oklch, var(--danger) 14%, var(--panel))",
        boxShadow: "var(--shadow-2)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 2 }}>
          Copy branch failed
        </div>
        <div
          style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.4, overflowWrap: "anywhere" }}
        >
          {message}
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          cursor: "default",
          fontSize: 16,
          lineHeight: 1,
          padding: 4,
        }}
      >
        ×
      </button>
    </div>
  );
}
