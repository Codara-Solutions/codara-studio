// The small dial the title-bar meters and the popover's cards share.
export function MiniRing({ value, color }: { value: number | null; color: string }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const progress = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="color-mix(in oklab, var(--ink) 13%, transparent)"
        strokeWidth="1.7"
      />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke={value === null ? "var(--muted)" : color}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress / 100)}
        transform="rotate(-90 7 7)"
        // No transition: a tween on every poll repaints the title bar for ~25
        // frames, and each frame re-composites every glass backdrop-filter on
        // screen, which kept an idle window at ~15% CPU.
      />
      <circle cx="7" cy="7" r="1" fill={value === null ? "var(--muted)" : color} />
    </svg>
  );
}
