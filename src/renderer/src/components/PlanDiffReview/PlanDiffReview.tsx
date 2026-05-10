import React, { useState } from "react";
import type { PendingMutation, RunState } from "@shared/types";

// PlanDiffReview is the killer-feature overlay: when plan mode queues
// mutating actions (worker dispatches the user hasn't approved yet), it
// renders as a backdrop-blur sheet over the workbench so the user can apply
// or discard atomically. Mounts once at App.tsx root, above the workbench
// content but below modal dialogs (z-index sits between settings dialog and
// the editor).
//
// MVP decision: we DON'T populate per-file diff previews pre-execution.
// Spark workers run autonomously and produce file mutations as side effects,
// so we can't dry-run them to diff their output. Instead each card surfaces
// the manager's natural-language description ("implement quoteForShell")
// plus the worker scope (allowed paths, expected outputs, runtime, model)
// — that is what the user reviews. Diffs appear post-hoc in the run canvas
// once the worker reports back. A future "worker_output" source can populate
// diffPreview when the data is available, and this component already
// switches on `mutation.diffPreview` to render it.

interface Props {
  run: RunState | null;
}

export default function PlanDiffReview({ run }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = run?.pendingMutations ?? [];
  if (!run || queue.length === 0) return null;

  const applyAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.applyPendingMutations({ runId: run.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discardAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.discardPendingMutations({ runId: run.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyOne = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.applyPendingMutations({
        runId: run.id,
        ids: [id],
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discardOne = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.discardPendingMutations({
        runId: run.id,
        ids: [id],
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Plan mode review"
      style={{
        position: "fixed",
        // Sit below the window chrome (which the user expects to keep
        // working — drag, minimize, close) but above the workbench tabs
        // and right panel. The native settings dialog uses z-index ~1000
        // in its own portal, so 80 keeps us safely below it.
        inset: "44px 0 30px 0",
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in oklch, var(--bg) 70%, transparent)",
        backdropFilter: "blur(18px) saturate(120%)",
        WebkitBackdropFilter: "blur(18px) saturate(120%)",
        borderTop: "1px solid var(--rule-soft)",
        borderBottom: "1px solid var(--rule-soft)",
        fontFamily: "var(--font-sans)",
        animation: "spark-plan-overlay-fade 160ms var(--ease-out)",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 18px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "color-mix(in oklch, var(--panel) 70%, transparent)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.2,
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--accent)",
            }}
          >
            Plan review
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              marginTop: 2,
            }}
          >
            {queue.length} pending change{queue.length === 1 ? "" : "s"}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              marginTop: 2,
            }}
          >
            Spark queued {queue.length} worker dispatch
            {queue.length === 1 ? "" : "es"} for your review. Apply to send to
            the autopilot, or discard to drop them entirely.
          </span>
        </div>
        <OverlayButton
          variant="default"
          disabled={busy}
          onClick={discardAll}
          title="Drop every queued mutation. Sends a system message into the chat so the timeline shows the discard."
        >
          Discard all
        </OverlayButton>
        <OverlayButton
          variant="accent"
          disabled={busy}
          onClick={applyAll}
          title="Apply every queued mutation. The autopilot will pick them up and launch workers immediately."
        >
          Apply {queue.length}
        </OverlayButton>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 18px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontSize: 12,
            borderBottom:
              "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
          }}
        >
          {error}
        </div>
      )}

      <ul
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          listStyle: "none",
          margin: 0,
          padding: "12px 18px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {queue.map((mutation) => (
          <PendingMutationCard
            key={mutation.id}
            mutation={mutation}
            busy={busy}
            onApply={() => applyOne(mutation.id)}
            onDiscard={() => discardOne(mutation.id)}
          />
        ))}
      </ul>

      {/* Local keyframes for the overlay fade-in. Keeping it inline avoids
          adding a global stylesheet for a one-off effect. */}
      <style>
        {`@keyframes spark-plan-overlay-fade {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }`}
      </style>
    </div>
  );
}

function PendingMutationCard({
  mutation,
  busy,
  onApply,
  onDiscard,
}: {
  mutation: PendingMutation;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(false);
  const w = mutation.workerTaskInput;
  const diff = mutation.diffPreview;
  const totals = diff?.totals;
  const hasDiff = Boolean(diff && diff.files.length > 0);

  return (
    <li
      style={{
        background: "color-mix(in oklch, var(--panel) 86%, transparent)",
        border: "1px solid var(--rule)",
        borderRadius: 9,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "10px 12px",
        }}
      >
        <button
          type="button"
          onClick={() => hasDiff && setOpen((v) => !v)}
          disabled={!hasDiff}
          aria-label="Toggle diff"
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            color: hasDiff ? "var(--ink-dim)" : "var(--muted)",
            cursor: hasDiff ? "default" : "not-allowed",
            padding: 0,
            marginTop: 2,
            display: "inline-flex",
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          <Caret />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              wordBreak: "break-word",
            }}
          >
            {mutation.description}
          </div>
          <div
            style={{
              marginTop: 4,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--muted)",
            }}
          >
            <Tag label={w.runtimePreference} tone="default" />
            {w.modelHint && <Tag label={w.modelHint} tone="default" />}
            {w.effortHint && <Tag label={`effort:${w.effortHint}`} tone="default" />}
            {w.taskClass && <Tag label={w.taskClass} tone="default" />}
            {w.canRunParallel && <Tag label="parallel" tone="accent" />}
          </div>
          {(w.allowedPaths.length > 0 || w.expectedOutputs.length > 0) && (
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--ink-dim)",
                lineHeight: 1.5,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {w.allowedPaths.length > 0 && (
                <div>
                  <ScopeLabel>scope</ScopeLabel>
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {w.allowedPaths.join(", ")}
                  </span>
                </div>
              )}
              {w.expectedOutputs.length > 0 && (
                <div>
                  <ScopeLabel>outputs</ScopeLabel>
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {w.expectedOutputs.join(", ")}
                  </span>
                </div>
              )}
            </div>
          )}
          {totals && (
            <div
              style={{
                marginTop: 6,
                display: "flex",
                gap: 10,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ color: "var(--accent)" }}>
                +{totals.addedLines}
              </span>
              <span style={{ color: "var(--danger)" }}>
                −{totals.removedLines}
              </span>
              <span style={{ color: "var(--muted)" }}>
                {totals.filesChanged} file
                {totals.filesChanged === 1 ? "" : "s"}
              </span>
            </div>
          )}
          {!hasDiff && (
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--muted)",
                fontStyle: "italic",
              }}
            >
              Diff appears in the run canvas after the worker reports back.
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <OverlayButton
            variant="ghost"
            disabled={busy}
            onClick={onDiscard}
            title="Discard this queued mutation."
          >
            Discard
          </OverlayButton>
          <OverlayButton
            variant="accent"
            disabled={busy}
            onClick={onApply}
            title="Apply just this mutation; the autopilot will launch the worker now."
          >
            Apply
          </OverlayButton>
        </div>
      </div>

      {open && hasDiff && diff && (
        <div
          style={{
            borderTop: "1px solid var(--rule-soft)",
            background: "color-mix(in oklch, var(--bg) 90%, transparent)",
            padding: "8px 12px 10px 38px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {diff.files.map((file) => (
            <UnifiedDiffBlock
              key={file.path}
              path={file.path}
              added={file.added}
              removed={file.removed}
              unifiedDiff={file.unifiedDiff}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function UnifiedDiffBlock({
  path,
  added,
  removed,
  unifiedDiff,
}: {
  path: string;
  added: number;
  removed: number;
  unifiedDiff: string;
}) {
  const lines = unifiedDiff.split("\n");
  return (
    <div
      style={{
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "5px 8px",
          background: "color-mix(in oklch, var(--panel) 70%, transparent)",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {path}
        </span>
        <span style={{ color: "var(--accent)" }}>+{added}</span>
        <span style={{ color: "var(--danger)" }}>−{removed}</span>
      </div>
      <div style={{ maxHeight: 240, overflow: "auto" }}>
        {lines.map((line, i) => {
          const tone =
            line.startsWith("+") && !line.startsWith("+++")
              ? "add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "del"
                : line.startsWith("@@")
                  ? "hunk"
                  : "ctx";
          const bg =
            tone === "add"
              ? "color-mix(in oklch, var(--accent) 12%, transparent)"
              : tone === "del"
                ? "color-mix(in oklch, var(--danger) 12%, transparent)"
                : tone === "hunk"
                  ? "color-mix(in oklch, var(--ink) 4%, transparent)"
                  : "transparent";
          const fg =
            tone === "add"
              ? "var(--accent)"
              : tone === "del"
                ? "var(--danger)"
                : tone === "hunk"
                  ? "var(--muted)"
                  : "var(--ink-dim)";
          return (
            <div
              key={i}
              style={{
                display: "block",
                whiteSpace: "pre",
                padding: "1px 8px",
                background: bg,
                color: fg,
              }}
            >
              {line || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tag({ label, tone }: { label: string; tone: "default" | "accent" }) {
  return (
    <span
      style={{
        padding: "1px 7px",
        border: `1px solid ${tone === "accent" ? "var(--accent-edge)" : "var(--rule-soft)"}`,
        borderRadius: 999,
        background:
          tone === "accent"
            ? "color-mix(in oklch, var(--accent) 14%, transparent)"
            : "color-mix(in oklch, var(--ink) 3%, transparent)",
        color: tone === "accent" ? "var(--accent)" : "var(--ink-dim)",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

function ScopeLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: 56,
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginRight: 6,
      }}
    >
      {children}
    </span>
  );
}

function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OverlayButton({
  children,
  onClick,
  disabled,
  title,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  variant: "default" | "accent" | "ghost";
}) {
  const palette =
    variant === "accent"
      ? {
          bg: "color-mix(in oklch, var(--accent) 22%, var(--panel))",
          border: "var(--accent-edge)",
          ink: "var(--ink)",
        }
      : variant === "ghost"
        ? {
            bg: "transparent",
            border: "var(--rule-soft)",
            ink: "var(--ink-dim)",
          }
        : {
            bg: "color-mix(in oklch, var(--ink) 4%, var(--panel))",
            border: "var(--rule-strong)",
            ink: "var(--ink)",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        appearance: "none",
        background: disabled ? "transparent" : palette.bg,
        border: `1px solid ${disabled ? "var(--rule-soft)" : palette.border}`,
        color: disabled ? "var(--muted)" : palette.ink,
        padding: "6px 12px",
        borderRadius: 7,
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "default",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}
