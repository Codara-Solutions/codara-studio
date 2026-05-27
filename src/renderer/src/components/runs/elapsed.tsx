import { formatDuration, formatSince, useNowTick } from "./run-format";

interface ElapsedTimeProps {
  startedAt?: string;
  finishedAt?: string;
  // "since" mode — counts up from a single anchor timestamp.
  since?: string;
  placeholder?: string;
}

// The single home of the per-second clock in the run canvas. Each instance
// ticks itself, and only while it is genuinely counting (a started-but-
// unfinished attempt, or a "since" anchor), so the rest of the graph never
// re-renders just to advance a duration string.
export function ElapsedTime({
  startedAt,
  finishedAt,
  since,
  placeholder = "--:--:--",
}: ElapsedTimeProps) {
  const live = startedAt ? !finishedAt : Boolean(since);
  useNowTick(1000, live);
  if (startedAt) return <>{formatDuration(startedAt, finishedAt)}</>;
  if (since) return <>{formatSince(since)}</>;
  return <>{placeholder}</>;
}

interface ElapsedChipProps {
  startedAt?: string;
  finishedAt?: string;
  since?: string;
  tone?: string;
}

// A compact mono time chip — a hollow ring glyph followed by the live clock.
// Used in node footers and inspector headers wherever a duration earns a
// labelled slot rather than a bare string.
export function ElapsedChip({
  startedAt,
  finishedAt,
  since,
  tone = "var(--ink-dim)",
}: ElapsedChipProps) {
  const hasValue = Boolean(startedAt || since);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        color: tone,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          border: `1.4px solid ${tone}`,
          opacity: 0.7,
        }}
      />
      {hasValue ? (
        <ElapsedTime startedAt={startedAt} finishedAt={finishedAt} since={since} />
      ) : (
        "--:--:--"
      )}
    </span>
  );
}
