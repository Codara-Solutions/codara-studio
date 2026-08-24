import React, { useState } from "react";
import { ChevronIcon } from "../icons";
import { IconButton } from "./git-ui";

interface Props {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Section-level actions revealed on header hover (discard all / stage all /
   * unstage all). Rendered left-to-right in the order given, just before the
   * count.
   */
  actions?: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
  }>;
  disabled: boolean;
  children: React.ReactNode;
}

// A collapsible change group — the "Staged Changes" / "Changes" headers. The
// header reuses the rail's uppercase eyebrow + count language.
export default function ChangeSection({
  title,
  count,
  collapsed,
  onToggle,
  actions,
  disabled,
  children,
}: Props): React.ReactElement {
  const [hover, setHover] = useState(false);

  return (
    <div>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 26,
          padding: "0 8px 0 8px",
          cursor: "default",
          background: hover ? "var(--hover)" : "transparent",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        <ChevronIcon open={!collapsed} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            letterSpacing: "0.12em",
            fontWeight: 800,
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {actions && actions.length > 0 && hover && !disabled && (
          <span
            onClick={(e) => e.stopPropagation()}
            style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
          >
            {actions.map((item) => (
              <IconButton
                key={item.key}
                title={item.title}
                onClick={item.onClick}
                danger={item.danger}
                size={20}
              >
                {item.icon}
              </IconButton>
            ))}
          </span>
        )}
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
          {String(count).padStart(2, "0")}
        </span>
      </div>
      {!collapsed && <div style={{ paddingBottom: 4 }}>{children}</div>}
    </div>
  );
}
