import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GitStashEntry, GitStashList } from "@shared/types";
import { ChevronIcon } from "../icons";
import { InlineInput } from "../file-icons/InlineInput";
import { IconButton, Spinner } from "./git-ui";

interface Props {
  cwd: string;
  /** Called after any stash mutation so the panel re-reads git state. */
  onChanged: () => void;
  /** Bumped by the panel after any git mutation — re-read on change. */
  refreshKey?: number;
  disabled: boolean;
}

// Stash list + "Stash changes" entry point for the Source Control panel.
//
// The section is self-contained: it reads both the stash list and the working
// status (so it can offer "Stash changes" whenever there are uncommitted
// changes, even with no stashes yet) and renders nothing only when the repo is
// clean and stash-free. Per-row apply / pop / drop run over
// window.spark.git.stash*; drop uses the in-app two-step confirm (never
// window.confirm). onChanged() fires after every mutation so the rest of the
// panel refreshes.
export default function StashSection({
  cwd,
  onChanged,
  refreshKey,
  disabled,
}: Props): React.ReactElement | null {
  const [list, setList] = useState<GitStashList | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const refresh = useCallback(async (): Promise<void> => {
    const target = cwdRef.current;
    const [stashes, status] = await Promise.all([
      window.spark.git.stashes(target),
      window.spark.git.status(target),
    ]);
    if (cwdRef.current !== target) return;
    setList(stashes);
    setHasChanges(
      Boolean(status?.isRepo) &&
        (status.staged.length > 0 || status.unstaged.length > 0),
    );
  }, []);

  useEffect(() => {
    setSaving(false);
    setError(null);
    void refresh();
  }, [cwd, refreshKey, refresh]);

  // Run one stash mutation: block while busy, surface failures inline, and tell
  // the panel to refresh on success.
  const run = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
      if (busy || disabled) return;
      setBusy(true);
      setError(null);
      try {
        const result = await fn();
        if (!result.ok) setError(result.error ?? "Stash operation failed.");
        else onChanged();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, disabled, onChanged],
  );

  const saveStash = useCallback(
    (message: string) => {
      setSaving(false);
      const trimmed = message.trim();
      void run(() =>
        window.spark.git.stashSave(cwdRef.current, {
          message: trimmed || undefined,
          includeUntracked: true,
        }),
      );
    },
    [run],
  );

  const entries = list?.entries ?? [];
  const blocked = busy || disabled;

  // Nothing to show: clean tree and no stashes. (A list-read error with no
  // changes is surfaced; otherwise stay invisible like the other sections.)
  if (entries.length === 0 && !hasChanges && !error && !list?.error) return null;

  return (
    <div>
      <div
        onClick={() => entries.length > 0 && setCollapsed((c) => !c)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 26,
          padding: "0 8px",
          cursor: "default",
        }}
      >
        {entries.length > 0 ? (
          <ChevronIcon open={!collapsed} />
        ) : (
          // Keep the chevron column width so the eyebrow aligns with the other
          // section headers even when there is nothing to expand.
          <span style={{ width: 14, height: 14, flex: "0 0 14px" }} />
        )}
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            letterSpacing: "0.1em",
            fontWeight: 800,
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          Stashes
        </span>
        <span style={{ flex: 1 }} />
        {busy && <Spinner size={11} />}
        {hasChanges && !saving && (
          <button
            type="button"
            title="Stash all changes (including untracked)"
            disabled={blocked}
            onClick={(e) => {
              e.stopPropagation();
              if (!blocked) setSaving(true);
            }}
            style={{
              appearance: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 20,
              padding: "0 7px 0 6px",
              borderRadius: 6,
              border: "1px solid var(--rule-soft)",
              background: "transparent",
              color: blocked ? "var(--muted-2)" : "var(--muted)",
              cursor: "default",
              fontFamily: "var(--font-sans)",
              fontSize: 10.5,
              fontWeight: 700,
              opacity: blocked ? 0.5 : 1,
              transition:
                "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              if (!blocked) {
                e.currentTarget.style.background = "var(--hover)";
                e.currentTarget.style.color = "var(--ink)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = blocked ? "var(--muted-2)" : "var(--muted)";
            }}
          >
            <StashIcon />
            Stash
          </button>
        )}
        {entries.length > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted-2)",
              minWidth: 16,
              textAlign: "right",
            }}
          >
            {String(entries.length).padStart(2, "0")}
          </span>
        )}
      </div>

      {saving && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 8px 0 14px",
          }}
        >
          <span style={{ color: "var(--muted)", display: "inline-flex" }}>
            <StashIcon />
          </span>
          <InlineInput
            initial=""
            placeholder="Stash message (optional) — Enter to stash"
            onCommit={saveStash}
            onCancel={() => setSaving(false)}
          />
        </div>
      )}

      {(error || list?.error) && (
        <StashError text={error ?? list?.error ?? ""} onDismiss={() => setError(null)} />
      )}

      {!collapsed && entries.length > 0 && (
        <div style={{ paddingBottom: 4 }}>
          {entries.map((entry) => (
            <StashRow
              key={entry.ref}
              entry={entry}
              disabled={blocked}
              onApply={() => run(() => window.spark.git.stashApply(cwdRef.current, entry.ref))}
              onPop={() => run(() => window.spark.git.stashPop(cwdRef.current, entry.ref))}
              onDrop={() => run(() => window.spark.git.stashDrop(cwdRef.current, entry.ref))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One stash entry. The trailing slot shows the relative date at rest and swaps
// to apply / pop / drop on hover — fixed width either way so hover never
// reflows the row. Drop is two-step (click to arm, click again to confirm),
// matching the discard control in ChangeRow.
function StashRow({
  entry,
  disabled,
  onApply,
  onPop,
  onDrop,
}: {
  entry: GitStashEntry;
  disabled: boolean;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);

  const reset = (): void => {
    setHover(false);
    setConfirmDrop(false);
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={reset}
      title={entry.ref}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 8px 0 14px",
        fontSize: 12,
        color: "var(--ink-dim)",
        background: hover
          ? "color-mix(in oklab, var(--ink) 5%, transparent)"
          : "transparent",
        overflow: "hidden",
        whiteSpace: "nowrap",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "baseline",
          gap: 5,
          overflow: "hidden",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: "0 1 auto" }}>
          {entry.message || entry.ref}
        </span>
        {entry.branch && (
          <span
            style={{
              color: "var(--muted-2)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {entry.branch}
          </span>
        )}
      </span>

      <span
        style={{
          flex: "0 0 70px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 2,
        }}
      >
        {hover && !disabled ? (
          <>
            <IconButton title="Apply stash (keep it in the list)" onClick={onApply} size={20}>
              <ApplyStashIcon />
            </IconButton>
            <IconButton title="Pop stash (apply then drop)" onClick={onPop} size={20}>
              <PopStashIcon />
            </IconButton>
            <IconButton
              title={confirmDrop ? "Click again to drop" : "Drop stash"}
              danger
              active={confirmDrop}
              size={20}
              onClick={() => {
                if (confirmDrop) {
                  onDrop();
                  setConfirmDrop(false);
                } else {
                  setConfirmDrop(true);
                }
              }}
            >
              <DropStashIcon />
            </IconButton>
          </>
        ) : entry.relativeDate ? (
          <span
            style={{
              color: "var(--muted-2)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            {entry.relativeDate}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// Compact inline error strip for a failed stash op — mirrors GitPanel's
// ErrorStrip but scoped to this section.
function StashError({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        margin: "2px 8px 6px 14px",
        padding: "6px 9px",
        borderRadius: 7,
        border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
        background: "var(--danger-soft)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: 1.5,
          color: "color-mix(in oklch, var(--danger) 80%, var(--ink))",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 84,
          overflow: "auto",
        }}
      >
        {text}
      </span>
      <button
        type="button"
        title="Dismiss"
        onClick={onDismiss}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          border: "none",
          background: "transparent",
          color: "var(--danger)",
          cursor: "default",
          fontSize: 13,
          lineHeight: 1,
          padding: 2,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ── Local icons ──────────────────────────────────────────────────────────────
// 14×14, 1.2px stroke, currentColor — match the git-ui icon set. Defined here
// (not in git-ui.tsx, which this agent must not edit).

function strokeSvg(children: React.ReactNode, strokeWidth = 1.2): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

// A small tray / inbox — the stash drawer.
function StashIcon(): React.ReactElement {
  return strokeSvg(
    <>
      <path d="M2.2 7.4 3.4 3.2A1 1 0 0 1 4.36 2.5h5.28a1 1 0 0 1 .96.7L11.8 7.4" />
      <path d="M2.2 7.4h2.6l.7 1.4h3l.7-1.4h2.6v3a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z" />
    </>,
  );
}

// Apply: down-into-tray arrow (restore without removing the stash).
function ApplyStashIcon(): React.ReactElement {
  return strokeSvg(
    <>
      <path d="M7 2.6v5.2" />
      <path d="M4.8 5.8 7 8l2.2-2.2" />
      <path d="M2.8 10.6h8.4" />
    </>,
  );
}

// Pop: same apply arrow with a strike, signalling the stash is removed after.
function PopStashIcon(): React.ReactElement {
  return strokeSvg(
    <>
      <path d="M7 2.4v4.4" />
      <path d="M5 5 7 7l2-2" />
      <path d="M3 9.2h8" />
      <path d="M3 11.4h8" />
    </>,
  );
}

// Drop: a trash glyph (destructive).
function DropStashIcon(): React.ReactElement {
  return strokeSvg(
    <>
      <path d="M3 4.2h8" />
      <path d="M5.4 4.2V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1" />
      <path d="M4 4.2 4.5 11a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9L10 4.2" />
    </>,
  );
}
