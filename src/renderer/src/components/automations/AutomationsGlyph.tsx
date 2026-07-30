import type { ReactElement } from "react";

// The automations glyph: a lightning bolt, shared by the welcome row, the
// strip affordance, and the Automations tab icon so every door keeps one
// identity. Deliberately NOT a clock — the chat-history button next door is a
// clock (HistoryIcon), and at 12px two clocks read as the same control.
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
      <path d="M7.9 1.4 3.9 7.9h2.7L6.1 12.6l4-6.5H7.4l.5-4.7Z" />
    </svg>
  );
}
