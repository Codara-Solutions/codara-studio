import React, { useRef, useState } from "react";
import { DragHandleIcon } from "../components/icons";
import { PANEL_HEADER_H } from "./usePanelLayout";

export interface SectionHeaderDragProps {
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: React.DragEvent<HTMLButtonElement>) => void;
}

export interface SectionHeaderProps extends SectionHeaderDragProps {
  label: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsible?: boolean;
  // Optional leading glyph (e.g. the Spark mark on the chat header).
  glyph?: React.ReactNode;
  // Optional zero-padded mono count shown before the action cluster.
  count?: number;
  // Small inline node shown right after the label (status, branch, path).
  meta?: React.ReactNode;
  // Right-aligned controls. Siblings of the toggle target, so they keep their
  // own click behaviour without toggling the section.
  actions?: React.ReactNode;
}

// The shared header band for a side-panel section: one row, fixed height
// (PANEL_HEADER_H). Chevron + glyph + label + meta form a single click target
// that collapses/expands the section. The band reads as slightly raised over
// the section body via a 1px top highlight and a hairline bottom rule.
export function SectionHeader({
  label,
  collapsed,
  onToggleCollapse,
  glyph,
  count,
  meta,
  actions,
  collapsible = true,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
}: SectionHeaderProps) {
  const [hover, setHover] = useState(false);
  const suppressClick = useRef(false);
  return (
    <div
      style={{
        flex: `0 0 ${PANEL_HEADER_H}px`,
        height: PANEL_HEADER_H,
        // Raised above the section body: relative + z-index so the downward
        // shadow lands on top of the (opaque) body below it.
        position: "relative",
        zIndex: 1,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 7px 0 5px",
        borderBottom: "1px solid var(--rule-soft)",
        background: hover
          ? "color-mix(in oklch, var(--ink) 3%, var(--panel))"
          : "var(--panel)",
        // 1px top highlight lifts the band; the soft downward cast gives the
        // body the recessed-well depth the Balanced direction calls for.
        boxShadow:
          "inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 4px 10px -6px rgba(0, 0, 0, 0.45)",
        transition: "background var(--motion-fast) var(--ease-out)",
        userSelect: "none",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-expanded={collapsible ? !collapsed : undefined}
        title={
          collapsible
            ? collapsed
              ? `Expand ${label}`
              : `Collapse ${label}`
            : label
        }
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          margin: 0,
          padding: 0,
          height: "100%",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 7,
          cursor: "default",
          color: "inherit",
          opacity: dragging ? 0.55 : 1,
          transition:
            "opacity var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
        draggable={draggable}
        aria-grabbed={draggable ? dragging : undefined}
        onDragStart={(event) => {
          suppressClick.current = true;
          onDragStart?.(event);
        }}
        onDragEnd={(event) => {
          onDragEnd?.(event);
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }}
        onClick={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            suppressClick.current = false;
            return;
          }
          if (!collapsible) return;
          onToggleCollapse();
        }}
      >
        {draggable && (
          <span
            title={`Move ${label}`}
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 14,
              height: 16,
              flex: "0 0 14px",
              color: hover ? "var(--ink-dim)" : "var(--muted-2)",
              cursor: "grab",
            }}
          >
            <DragHandleIcon size={13} />
          </span>
        )}
        {collapsible && <Chevron collapsed={collapsed} hover={hover} />}
        {glyph != null && (
          <span style={{ display: "inline-flex", alignItems: "center", flex: "0 0 auto" }}>
            {glyph}
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: hover ? "var(--ink-dim)" : "var(--muted)",
            whiteSpace: "nowrap",
            flex: "0 0 auto",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
        >
          {label}
        </span>
        {meta != null && (
          <span
            style={{
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            {meta}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {typeof count === "number" && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted)",
              flex: "0 0 auto",
            }}
          >
            {String(count).padStart(2, "0")}
          </span>
        )}
      </button>
      {actions != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto" }}>
          {actions}
        </div>
      )}
    </div>
  );
}

// Disclosure chevron: points down when expanded, rotates to point right when
// collapsed. The rotation is the section's open/close affordance.
function Chevron({ collapsed, hover }: { collapsed: boolean; hover: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        flex: "0 0 16px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: hover ? "var(--ink-dim)" : "var(--muted-2)",
        transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
        transition:
          "transform var(--motion) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
        <path
          d="M2 3.5 L5 6.5 L8 3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default SectionHeader;
