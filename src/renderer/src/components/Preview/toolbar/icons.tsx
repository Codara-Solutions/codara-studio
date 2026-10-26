// Glyphs for the browser pane's toolbar and its menus, drawn on the same
// 14px grid and stroke as ../../icons.tsx.

import type { ReactNode } from "react";

type IconProps = { size?: number };

function Svg({ size = 14, children }: IconProps & { children: ReactNode }) {
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
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function MoreIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="3" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function TabsIcon({ size }: IconProps) {
  // Two stacked windows: "the tabs you have open".
  return (
    <Svg size={size}>
      <rect x="1.8" y="4.2" width="8.6" height="7.6" rx="1" />
      <path d="M4 2.2 H11.2 a1 1 0 0 1 1 1 V9.6" />
    </Svg>
  );
}

export function FullScreenIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2 5 V2.6 a0.6 0.6 0 0 1 0.6 -0.6 H5" />
      <path d="M9 2 H11.4 a0.6 0.6 0 0 1 0.6 0.6 V5" />
      <path d="M12 9 V11.4 a0.6 0.6 0 0 1 -0.6 0.6 H9" />
      <path d="M5 12 H2.6 a0.6 0.6 0 0 1 -0.6 -0.6 V9" />
    </Svg>
  );
}

export function ExitFullScreenIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 2 V4.4 a0.6 0.6 0 0 1 -0.6 0.6 H2" />
      <path d="M12 5 H9.6 a0.6 0.6 0 0 1 -0.6 -0.6 V2" />
      <path d="M9 12 V9.6 a0.6 0.6 0 0 1 0.6 -0.6 H12" />
      <path d="M2 9 H4.4 a0.6 0.6 0 0 1 0.6 0.6 V12" />
    </Svg>
  );
}

export function CopyIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1" />
      <path d="M9.5 2.6 V2.5 a0.5 0.5 0 0 0 -0.5 -0.5 H2.5 a0.5 0.5 0 0 0 -0.5 0.5 V9 a0.5 0.5 0 0 0 0.5 0.5 H2.6" />
    </Svg>
  );
}

export function CheckIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2.8 7.4 L5.6 10.2 L11.2 3.8" />
    </Svg>
  );
}

export function ChevronDownIcon({ size = 9 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 5.2 L7 9.2 L11 5.2" strokeWidth="1.6" />
    </Svg>
  );
}
