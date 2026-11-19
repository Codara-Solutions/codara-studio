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

// A collapsible group: "Staged Changes", "Changes", the history graph. VS
// Code's section header in Studio's tokens: a small uppercase title, the
// group's actions on hover and its size as a quiet pill.
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
          height: 24,
          padding: "0 10px 0 8px",
          cursor: "default",
          background: hover ? "var(--hover)" : "transparent",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        <ChevronIcon open={!collapsed} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            letterSpacing: "0.05em",
            fontWeight: 600,
            textTransform: "uppercase",
            color: "var(--ink-dim)",
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
            minWidth: 18,
            height: 16,
            padding: "0 5px",
            borderRadius: 8,
            background: "var(--hover-strong)",
            color: "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            fontSize: 10.5,
            fontWeight: 500,
            fontVariantNumeric: "tabular-nums",
            lineHeight: "16px",
            textAlign: "center",
          }}
        >
          {count}
        </span>
      </div>
      {!collapsed && <div style={{ paddingBottom: 4 }}>{children}</div>}
    </div>
  );
}
