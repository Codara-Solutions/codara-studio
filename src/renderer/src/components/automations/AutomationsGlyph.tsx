import type { ReactElement } from "react";

// The automations glyph: a branching node flow — one trigger node fanning out
// into two step nodes, which is literally what an automation IS here (the
// node-flow editor). Shared by the welcome row, the tab-bar affordance, and
// the Automations tab icon so every door keeps one identity. Deliberately NOT
// a clock (the chat-history button is a clock), not a lightning bolt (read as
// "power/boost"), and not circular arrows (read as "refresh").
export function AutomationsGlyph({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.2" y="4.9" width="3.6" height="4.2" rx="1.1" />
      <rect x="9.2" y="1.5" width="3.6" height="3.6" rx="1.1" />
      <rect x="9.2" y="8.9" width="3.6" height="3.6" rx="1.1" />
      <path d="M4.8 7h2.1V3.3h2.3" />
      <path d="M6.9 7v3.7h2.3" />
    </svg>
  );
}
