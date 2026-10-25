// Glyphs for the browser pane's capture controls, drawn on the same 14px
// grid and stroke as ../icons.tsx.

export function DevicesIcon({ size = 14 }: { size?: number }) {
  // A desktop screen with a phone in front of it: "several sizes at once".
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 9.5 H2 a0.8 0.8 0 0 1 -0.8 -0.8 V3 a0.8 0.8 0 0 1 0.8 -0.8 H10.5 a0.8 0.8 0 0 1 0.8 0.8 V5" />
      <path d="M4.5 12 H8.5" />
      <rect x="9.3" y="6.2" width="3.5" height="6" rx="0.7" />
    </svg>
  );
}

export function RecordIcon({ size = 14, active = false }: { size?: number; active?: boolean }) {
  // A ring with a dot; recording fills it and squares the dot into "stop".
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="7" cy="7" r="5.3" />
      {active ? <rect x="5" y="5" width="4" height="4" rx="0.6" fill="currentColor" stroke="none" /> : <circle cx="7" cy="7" r="2.4" fill="currentColor" stroke="none" />}
    </svg>
  );
}
