import React, { useCallback, useEffect, useRef, useState } from "react";

// Copyable run-id chip. Click → writes the BARE id to the clipboard (no
// prefix, no quotes: it gets pasted straight into an assistant that resolves
// it to ~/.Codara/runs/<run-id>/) and flips the label to "Copied" for ~1.5s.
// The chip doubles as a label so a surface showing several runs says which
// one you are reading. Shared by the chat header, the chat status bar, and
// the automations detail; `compact` is the icon-only target for dense rows.

async function writeClipboard(text: string): Promise<void> {
  // Electron's main-process clipboard is the reliable path in the desktop
  // app; the browser API is the fallback for surfaces without the preload
  // bridge.
  const bridge = window.spark?.clipboard?.writeText;
  if (bridge) {
    await bridge(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export default function RunIdChip({
  runId,
  compact = false,
  maxChars = 12,
}: {
  runId: string;
  compact?: boolean;
  // Display budget for the id. Headers keep the default so the chip stays
  // narrow; roomier rows raise it to show the id whole.
  maxChars?: number;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // History rows are themselves clickable; copying must not also toggle
      // the accordion underneath.
      e.stopPropagation();
      void writeClipboard(runId)
        .then(() => {
          setCopied(true);
          if (timerRef.current != null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {
          /* clipboard blocked by the platform: no badge rather than a lie */
        });
    },
    [runId],
  );

  const truncated = runId.length > maxChars;
  const short = truncated ? `${runId.slice(0, maxChars)}…` : runId;
  // The tooltip carries the full id only when the chip cannot show it, so a
  // reader can still get at it without copying.
  const title = copied ? "Copied" : truncated ? `Copy run id: ${runId}` : "Copy run id";

  if (compact) {
    return (
      <button
        type="button"
        className="spark-icon-btn"
        onClick={handleClick}
        title={copied ? "Copied" : `Copy run id: ${runId}`}
        aria-label="Copy run id"
        style={
          {
            "--spark-icon-btn-size": "18px",
            fontSize: 10,
            color: copied ? "var(--accent)" : "var(--muted-2)",
            // Copy must survive a cramped row: the chip holds its width
            // instead of being shrunk (or clipped) out of reach by a long
            // sibling such as a paused run's park reason.
            flex: "0 0 auto",
          } as React.CSSProperties
        }
      >
        {copied ? "✓" : "⧉"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      aria-label="Copy run id"
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 7px",
        borderRadius: 999,
        border: copied ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        background: copied ? "var(--accent-soft)" : "var(--panel-2)",
        color: copied ? "var(--accent)" : "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        // Copy must survive a cramped row: the chip holds its width instead of
        // being shrunk (or clipped) out of reach by a long sibling such as a
        // paused run's park reason.
        flex: "0 0 auto",
        // No inline box-shadow, so the global :focus-visible ring renders.
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span aria-hidden style={{ color: copied ? "var(--accent)" : "var(--muted)" }}>
        id
      </span>
      <span>{copied ? "Copied" : short}</span>
    </button>
  );
}
