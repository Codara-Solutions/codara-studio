// Glyphs for the terminal actions, drawn on the 14px grid of components/icons.tsx.

export function CopyGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
      <path d="M9.5 4.5 V3.5 A1 1 0 0 0 8.5 2.5 H3.5 A1 1 0 0 0 2.5 3.5 V8.5 A1 1 0 0 0 3.5 9.5 H4.5" />
    </svg>
  );
}

/** The pane toolbar's "Copy terminal context" glyph: a clipboard with lines. */
export function TerminalContextGlyph({ size = 12 }: { size?: number }) {
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
      <path d="M5 2.5 H3.5 A1 1 0 0 0 2.5 3.5 V11.5 A1 1 0 0 0 3.5 12.5 H10.5 A1 1 0 0 0 11.5 11.5 V3.5 A1 1 0 0 0 10.5 2.5 H9" />
      <rect x="5" y="1.5" width="4" height="2" rx="0.6" />
      <path d="M4.75 6.5 L6.25 7.75 L4.75 9" />
      <line x1="7.5" y1="9.5" x2="9.5" y2="9.5" />
    </svg>
  );
}
