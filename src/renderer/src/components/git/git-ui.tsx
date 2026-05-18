import React, { useState } from "react";
import type { GitFileStatus } from "@shared/types";

// Shared atoms for the Source Control panel: status mapping helpers, a couple
// of path utilities, the icon set, and the small hover-button + spinner the
// panel reuses everywhere. Kept in one place so the panel's surfaces stay
// visually consistent.

// ── Status helpers ───────────────────────────────────────────────────────────

// One-letter glyph for a change row — the same compact mono-badge language the
// file context menu uses. Never a colored border.
export function statusGlyph(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    case "typechange":
      return "T";
    case "modified":
    default:
      return "M";
  }
}

// Status → an existing app status token. Untracked reads as "new" (green, like
// added); conflicts and deletions as danger; renames / type-changes as info.
export function statusColor(status: GitFileStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "var(--ok)";
    case "deleted":
    case "conflicted":
      return "var(--danger)";
    case "renamed":
    case "typechange":
      return "var(--info)";
    case "modified":
    default:
      return "var(--warn)";
  }
}

export function statusLabel(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflict";
    case "typechange":
      return "Type changed";
    case "modified":
    default:
      return "Modified";
  }
}

// Split a repo-relative path into a dimmed directory prefix and the file name.
export function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

// Compress git's `%ar` ("3 hours ago") into a glanceable token ("3h").
export function shortenRelative(value: string): string {
  if (!value) return "";
  if (/just now|seconds? ago|moment/i.test(value)) return "now";
  const m = value.match(/(\d+)\s*(year|month|week|day|hour|minute|second)/i);
  if (!m) return value;
  const abbr: Record<string, string> = {
    year: "y",
    month: "mo",
    week: "w",
    day: "d",
    hour: "h",
    minute: "m",
    second: "s",
  };
  return `${m[1]}${abbr[m[2].toLowerCase()] ?? ""}`;
}

// ── Spinner ──────────────────────────────────────────────────────────────────

export function Spinner({ size = 12 }: { size?: number }): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: "1.5px solid var(--rule-strong)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "spark-spin 0.7s linear infinite",
      }}
    />
  );
}

// ── Icon button ──────────────────────────────────────────────────────────────

interface IconButtonProps {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  size?: number;
}

export function IconButton({
  title,
  onClick,
  children,
  disabled = false,
  danger = false,
  active = false,
  size = 22,
}: IconButtonProps): React.ReactElement {
  const [hover, setHover] = useState(false);
  const lit = (hover || active) && !disabled;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: size,
        height: size,
        padding: 0,
        flex: `0 0 ${size}px`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: 5,
        cursor: "default",
        background: lit ? (danger ? "var(--danger-soft)" : "var(--hover)") : "transparent",
        color: disabled
          ? "var(--muted-2)"
          : lit
            ? danger
              ? "var(--danger)"
              : "var(--ink)"
            : "var(--muted)",
        opacity: disabled ? 0.5 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────
// All 14×14, 1.2px stroke, currentColor — they inherit the button's color.

function svg(children: React.ReactNode, strokeWidth = 1.2): React.ReactElement {
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

export function BranchIcon(): React.ReactElement {
  return svg(
    <>
      <circle cx="3.5" cy="3" r="1.6" />
      <circle cx="3.5" cy="11" r="1.6" />
      <circle cx="10.5" cy="4.5" r="1.6" />
      <path d="M3.5 4.6v4.8" />
      <path d="M10.5 6.1c0 2.4-2 3.3-4 3.6" />
    </>,
  );
}

export function RefreshIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M11.5 6a4.5 4.5 0 1 0-1 4.2" />
      <path d="M11.5 2.4V6H8" />
    </>,
  );
}

export function PushIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M7 11V3.4" />
      <path d="M3.6 6.4 7 3l3.4 3.4" />
      <path d="M3.4 12.2h7.2" />
    </>,
  );
}

export function PullIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M7 2.6v7.6" />
      <path d="M3.6 6.8 7 10.2l3.4-3.4" />
      <path d="M3.4 12.4h7.2" />
    </>,
  );
}

export function SyncIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M2.6 6a4.4 4.4 0 0 1 7.6-2.4" />
      <path d="M10.6 1.6v2.6H8" />
      <path d="M11.4 8a4.4 4.4 0 0 1-7.6 2.4" />
      <path d="M3.4 12.4V9.8H6" />
    </>,
  );
}

export function CommitIcon(): React.ReactElement {
  return svg(<path d="M3 7.4 6 10.4 11.2 4" />, 1.6);
}

export function SparkleIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M7.2 2.4 8 5.2l2.8.8L8 6.8l-.8 2.8-.8-2.8L3.6 6l2.8-.8.8-2.8Z" />
      <path d="M11 9.2l.4 1.2 1.2.4-1.2.4-.4 1.2-.4-1.2-1.2-.4 1.2-.4.4-1.2Z" />
      <path d="M3 9.8l.3.9.9.3-.9.3-.3.9-.3-.9-.9-.3.9-.3.3-.9Z" />
    </>,
    1.15,
  );
}

export function UndoIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M3 6.5h6.2A2.8 2.8 0 0 1 9.2 12H6" />
      <path d="M5.4 4 3 6.5 5.4 9" />
    </>,
  );
}

export function CheckoutIcon(): React.ReactElement {
  return svg(
    <>
      <circle cx="7" cy="7" r="2" />
      <path d="M2 7h3M9 7h3" />
    </>,
  );
}

export function RevertIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M11 8a4 4 0 1 0-1.2 2.8" />
      <path d="M7 4.6V7l1.8 1" />
    </>,
  );
}

export function OpenFileIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M7 2.4H2.6v9h9V7" />
      <path d="M8.4 2.4h3.2v3.2" />
      <path d="M11.4 2.6 6.6 7.4" />
    </>,
  );
}

export function BackIcon(): React.ReactElement {
  return svg(
    <>
      <path d="M8.6 3 4.4 7l4.2 4" />
    </>,
    1.6,
  );
}

export function PlusGlyph(): React.ReactElement {
  return svg(
    <>
      <path d="M7 3.2v7.6M3.2 7h7.6" />
    </>,
    1.6,
  );
}

export function MinusGlyph(): React.ReactElement {
  return svg(<path d="M3.2 7h7.6" />, 1.6);
}

export function CopyIcon(): React.ReactElement {
  return svg(
    <>
      <rect x="5" y="5" width="7" height="7" rx="1.2" />
      <path d="M9 5V3.4A1 1 0 0 0 8 2.4H3.4a1 1 0 0 0-1 1V8a1 1 0 0 0 1 1H5" />
    </>,
  );
}

export function InitRepoIcon(): React.ReactElement {
  return svg(
    <>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M7 4.6v4.8M4.6 7h4.8" />
    </>,
  );
}
