import React from "react";

const wrap = (children: React.ReactNode, color = "currentColor", size = 14) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: size,
      height: size,
      flex: `0 0 ${size}px`,
      color,
    }}
  >
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      {children}
    </svg>
  </span>
);

const docFrame = (
  <path d="M3 1.5 H9 L11 3.5 V12.5 H3 Z M9 1.5 V3.5 H11" stroke="currentColor" strokeWidth="1" />
);

export function FileIcon({ ext }: { ext?: string }) {
  switch (ext) {
    case "ts":
    case "tsx":
      return wrap(
        <>
          {docFrame}
          <path d="M4.5 7 H7 M5.75 7 V10.5" stroke="currentColor" strokeWidth="1" />
          <path d="M9.5 7 H8 V8.5 H9.5 V10.5 H8" stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "currentColor",
      );
    case "js":
    case "jsx":
      return wrap(
        <>
          {docFrame}
          <path d="M5 7 V10 Q5 11 6 11 Q7 11 7 10 V7" stroke="currentColor" strokeWidth="1" fill="none" />
          <path d="M8 10 Q8 11 9 11 Q10 11 10 10 V9 H8.5 V8 Q8.5 7 9.5 7"
                stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "currentColor",
      );
    case "json":
      return wrap(
        <>
          {docFrame}
          <path
            d="M6 7 Q5 7 5 8 V8.5 Q5 9 4.5 9 Q5 9 5 9.5 V10 Q5 11 6 11"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
          <path
            d="M8 7 Q9 7 9 8 V8.5 Q9 9 9.5 9 Q9 9 9 9.5 V10 Q9 11 8 11"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </>,
        "currentColor",
      );
    case "yaml":
    case "yml":
      return wrap(
        <>
          {docFrame}
          <path d="M5 7 L7 9 L9 7 M7 9 V11" stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "currentColor",
      );
    case "md":
      return wrap(
        <>
          {docFrame}
          <path d="M5 11 V7 L7 9.5 L9 7 V11" stroke="currentColor" strokeWidth="1" fill="none" />
        </>,
        "currentColor",
      );
    case "env":
      return wrap(
        <>
          {docFrame}
          <circle cx="7" cy="9" r="1.4" stroke="currentColor" strokeWidth="1" fill="none" />
          <path
            d="M7 6.5 V7.5 M7 10.5 V11.5 M4.5 9 H5.5 M8.5 9 H9.5"
            stroke="currentColor"
            strokeWidth="1"
          />
        </>,
        "currentColor",
      );
    default:
      return wrap(
        <>
          {docFrame}
          <line x1="4.5" y1="7.5" x2="9.5" y2="7.5" stroke="currentColor" strokeWidth="1" />
          <line x1="4.5" y1="9" x2="9.5" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="4.5" y1="10.5" x2="7.5" y2="10.5" stroke="currentColor" strokeWidth="1" />
        </>,
        "currentColor",
      );
  }
}

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <line x1="7" y1="3" x2="7" y2="11" />
      <line x1="3" y1="7" x2="11" y2="7" />
    </svg>
  );
}

export function MinusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <line x1="3" y1="7" x2="11" y2="7" />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <line x1="3.5" y1="3.5" x2="10.5" y2="10.5" />
      <line x1="10.5" y1="3.5" x2="3.5" y2="10.5" />
    </svg>
  );
}

export function SplitRightIcon({ size = 14 }: { size?: number }) {
  // A rectangle with a centered vertical divider — reads as "two side-by-side
  // panes". Used for "split right" (Mod+\) on the terminal pane toolbar.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="10" height="8" rx="1" />
      <line x1="7" y1="3.5" x2="7" y2="10.5" />
    </svg>
  );
}

export function SplitDownIcon({ size = 14 }: { size?: number }) {
  // Same rectangle, divider runs horizontally — "stacked panes". Used for
  // "split down" (Mod+Shift+\) on the terminal pane toolbar.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="10" height="8" rx="1" />
      <line x1="2.5" y1="7" x2="11.5" y2="7" />
    </svg>
  );
}

export function DragHandleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="5" cy="4" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="9" cy="4" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="5" cy="7" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="9" cy="7" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="5" cy="10" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="9" cy="10" r="0.65" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GridIcon({ size = 14 }: { size?: number }) {
  // A 2×2 cell grid — reads as "tiled view". Used on the Swarm toggle in
  // the chat header to switch the centre area from the standard
  // conversation+graph layout to the swarm grid of live worker terminals.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="4" height="4" rx="0.6" />
      <rect x="8" y="2" width="4" height="4" rx="0.6" />
      <rect x="2" y="8" width="4" height="4" rx="0.6" />
      <rect x="8" y="8" width="4" height="4" rx="0.6" />
    </svg>
  );
}

export function BroadcastIcon({ size = 14 }: { size?: number }) {
  // A radiating-arc transmitter — reads as "send to many". Used on the
  // Swarm header's Broadcast button: pressing it opens a textarea that
  // pipes one prompt into every live worker PTY in the swarm.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="7" r="1.4" />
      <path d="M4 4.2 A 4 4 0 0 0 4 9.8" />
      <path d="M10 4.2 A 4 4 0 0 1 10 9.8" />
      <path d="M2.2 2.6 A 6.4 6.4 0 0 0 2.2 11.4" />
      <path d="M11.8 2.6 A 6.4 6.4 0 0 1 11.8 11.4" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 12,
        color: "var(--muted)",
        fontWeight: 800,
      }}
    >
      {open ? "▾" : "▸"}
    </span>
  );
}
