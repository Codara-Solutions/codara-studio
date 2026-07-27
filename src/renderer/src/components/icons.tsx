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

export function SparkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PhoneIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="1.25" width="7" height="11.5" rx="1.6" />
      <path d="M5.5 3h3" />
      <circle cx="7" cy="10.75" r=".55" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ZoomPaneIcon({ size = 14, zoomed = false }: { size?: number; zoomed?: boolean }) {
  // Four corner brackets — reads as "expand to fill" when not zoomed and
  // "collapse back into split" when zoomed. The zoomed state pulls the
  // brackets inward so the affordance toggles visibly.
  const inset = zoomed ? 4 : 2.5;
  const armLen = zoomed ? 1.6 : 2.2;
  const min = inset;
  const max = 14 - inset;
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
      {/* top-left */}
      <line x1={min} y1={min + armLen} x2={min} y2={min} />
      <line x1={min} y1={min} x2={min + armLen} y2={min} />
      {/* top-right */}
      <line x1={max - armLen} y1={min} x2={max} y2={min} />
      <line x1={max} y1={min} x2={max} y2={min + armLen} />
      {/* bottom-right */}
      <line x1={max} y1={max - armLen} x2={max} y2={max} />
      <line x1={max} y1={max} x2={max - armLen} y2={max} />
      {/* bottom-left */}
      <line x1={min + armLen} y1={max} x2={min} y2={max} />
      <line x1={min} y1={max} x2={min} y2={max - armLen} />
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

export function InspectIcon({ size = 14 }: { size?: number }) {
  // Crosshair + corner marks: reads as "pick an element in the browser pane".
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
      <path d="M2 4.5 V2.5 H4.5" />
      <path d="M9.5 2.5 H12 V4.5" />
      <path d="M12 9.5 V12 H9.5" />
      <path d="M4.5 12 H2 V9.5" />
      <circle cx="7" cy="7" r="1.6" />
    </svg>
  );
}

export function DrawIcon({ size = 14 }: { size?: number }) {
  // A pencil tip with a short stroke trail — "annotate this page".
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
      <path d="M9 2.5 L11.5 5 L5.5 11 H3 V8.5 Z" />
      <path d="M8.2 3.3 L10.7 5.8" />
      <path d="M2.5 12.5 H6" />
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

export function HistoryIcon({ size = 14 }: { size?: number }) {
  // A clock face with a counter-clockwise arrow — the universal "history"
  // glyph. Used on the Codara chat header's Chats button to open the
  // recent-chats popover.
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
      <path d="M2.5 6 A 4.5 4.5 0 1 0 3.6 3.2" />
      <polyline points="2.2,2.2 2.6,5.4 5.6,5" />
      <polyline points="7,4.4 7,7.2 9,8.4" />
    </svg>
  );
}

export function BackIcon({ size = 14 }: { size?: number }) {
  // A leftward arrow — browser "back" navigation. 1.5px stroke to sit in the
  // same icon family as Inspect / Draw in the preview toolbar.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="11" y1="7" x2="3.5" y2="7" />
      <polyline points="6.5,3.5 3,7 6.5,10.5" />
    </svg>
  );
}

export function ForwardIcon({ size = 14 }: { size?: number }) {
  // A rightward arrow — browser "forward" navigation.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="7" x2="10.5" y2="7" />
      <polyline points="7.5,3.5 11,7 7.5,10.5" />
    </svg>
  );
}

export function ReloadIcon({ size = 14 }: { size?: number }) {
  // A circular-arrow refresh glyph — browser "reload". The gap + arrowhead
  // reads as the standard clockwise reload icon.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 7 A 4 4 0 1 1 9.6 3.9" />
      <polyline points="11.2,1.8 11.2,4.2 8.8,4.2" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 14 }: { size?: number }) {
  // A box with an arrow escaping the top-right — "open in system browser".
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 3 H3.5 V10.5 H11 V7" />
      <line x1="7" y1="7" x2="11" y2="3" />
      <polyline points="8,3 11,3 11,6" />
    </svg>
  );
}

export function DevToolsIcon({ size = 14 }: { size?: number }) {
  // Angle brackets `< >` — "open Chromium DevTools". The same code-glyph
  // shape the old `{}` label implied, drawn as a stroked SVG.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="5,4 2.5,7 5,10" />
      <polyline points="9,4 11.5,7 9,10" />
    </svg>
  );
}

export function GlobeIcon({ size = 14 }: { size?: number }) {
  // A meridian-and-equator globe — the security/scheme glyph for http (no
  // lock). Sits in the address pill's leading slot.
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
      <circle cx="7" cy="7" r="4.5" />
      <ellipse cx="7" cy="7" rx="2" ry="4.5" />
      <line x1="2.5" y1="7" x2="11.5" y2="7" />
    </svg>
  );
}

export function LockIcon({ size = 14 }: { size?: number }) {
  // A closed padlock — the security glyph for https. Shackle + body, drawn
  // to match the address pill's leading slot scale.
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
      <rect x="3.5" y="6.5" width="7" height="5.5" rx="1" />
      <path d="M5 6.5 V4.75 A 2 2 0 0 1 9 4.75 V6.5" />
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
