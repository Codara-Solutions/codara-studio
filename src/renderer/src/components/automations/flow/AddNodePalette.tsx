import React, { useEffect, useRef } from "react";
import type { LoomGraphNodeKind } from "./model";

// The n8n-style "add node" palette: a small popover listing the legal next
// node kinds. Opened from a node's '+' handle (anchored) or the toolbar
// (centered). Picking a kind inserts it already wired.

const KINDS: { kind: LoomGraphNodeKind; glyph: string; title: string; blurb: string; color: string; tint: string }[] = [
  { kind: "worker", glyph: "◇", title: "Worker", blurb: "Run one agent pass.", color: "var(--accent)", tint: "color-mix(in oklch, var(--accent) 14%, var(--panel-3))" },
  { kind: "guard", glyph: "◈", title: "Guard", blurb: "Branch on a condition (pass / fail).", color: "var(--ok)", tint: "color-mix(in oklch, var(--ok) 14%, var(--panel-3))" },
  { kind: "merge", glyph: "⊕", title: "Merge", blurb: "Join parallel branches.", color: "var(--info)", tint: "color-mix(in oklch, var(--info) 16%, var(--panel-3))" },
];

export interface PaletteState {
  /** screen coords (relative to the canvas container) to anchor the popover. */
  x: number;
  y: number;
  /** the node + handle we're adding FROM, or null for a free (toolbar) add. */
  from: { nodeId: string; branch?: "pass" | "fail" } | null;
}

export default function AddNodePalette({
  state,
  onPick,
  onClose,
}: {
  state: PaletteState;
  onPick: (kind: LoomGraphNodeKind) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening click doesn't immediately close it.
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="spark-menu spark-fade-in"
      role="menu"
      aria-label="Add node"
      style={{
        position: "absolute",
        left: state.x,
        top: state.y,
        width: 220,
        zIndex: 20,
      }}
    >
      <div
        className="spark-eyebrow"
        style={{ padding: "4px 8px 6px", color: "var(--muted-2)" }}
      >
        {state.from ? `Add after ${state.from.branch ? state.from.branch + " branch" : "this step"}` : "Add a node"}
      </div>
      {KINDS.map((k) => (
        <button
          key={k.kind}
          type="button"
          role="menuitem"
          className="spark-menu-item"
          onClick={() => onPick(k.kind)}
          style={{ alignItems: "flex-start" }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: 6,
              fontSize: 12,
              flex: "0 0 auto",
              background: k.tint,
              color: k.color,
            }}
          >
            {k.glyph}
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{k.title}</span>
            <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{k.blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
