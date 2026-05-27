import type { AgentEffortLevel } from "@shared/types";
import {
  EFFORT_LABELS,
  THINKING_BAR_COUNT,
  barsForEffort,
  nextEffort,
} from "./types";

interface Props {
  effort: AgentEffortLevel;
  availableEfforts: AgentEffortLevel[];
  onCycle: (next: AgentEffortLevel) => void;
}

// Click-to-cycle thinking-level pill. Tap advances through the allowed
// list and wraps. The bars icon shows how "deep" the level is at a glance.
export default function ThinkingControl({ effort, availableEfforts, onCycle }: Props) {
  if (availableEfforts.length === 0) return null;
  const label = EFFORT_LABELS[effort] ?? effort;
  const litBars = barsForEffort(effort);

  return (
    <button
      type="button"
      className="composer-thinking"
      title="Click to change thinking level"
      onClick={() => onCycle(nextEffort(effort, availableEfforts))}
    >
      <ThinkingBars lit={litBars} />
      <span className="composer-thinking-label">{label}</span>
    </button>
  );
}

// 5 ascending bars; first `lit` lit in accent yellow, rest dimmed.
function ThinkingBars({ lit }: { lit: number }) {
  const total = THINKING_BAR_COUNT;
  const width = 14;
  const height = 12;
  const barWidth = 2;
  const gap = 1;
  const totalBarWidth = total * barWidth + (total - 1) * gap;
  const startX = (width - totalBarWidth) / 2;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      style={{ flex: "0 0 auto" }}
    >
      {Array.from({ length: total }, (_, i) => {
        const barHeight = ((i + 1) / total) * height;
        const x = startX + i * (barWidth + gap);
        const y = height - barHeight;
        const isLit = i < lit;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            rx={0.6}
            fill={isLit ? "var(--accent)" : "var(--ink-dim)"}
            fillOpacity={isLit ? 1 : 0.35}
          />
        );
      })}
    </svg>
  );
}
