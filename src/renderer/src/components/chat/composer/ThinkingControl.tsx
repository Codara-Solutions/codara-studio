import { useEffect, useRef, useState } from "react";
import type { AgentEffortLevel } from "@shared/types";
import {
  EFFORT_LABELS,
  THINKING_BAR_COUNT,
  barsForEffort,
} from "./types";

interface Props {
  effort: AgentEffortLevel;
  availableEfforts: AgentEffortLevel[];
  onCycle: (next: AgentEffortLevel) => void;
}

const EFFORT_DESCRIPTIONS: Record<AgentEffortLevel, string> = {
  minimal: "Lowest latency for tiny, mechanical work.",
  low: "Fast reasoning for clear, well-scoped tasks.",
  medium: "Balanced depth and speed for everyday work.",
  high: "More planning and checking for difficult tasks.",
  xhigh: "Deep analysis for complex, high-value work.",
  max: "Maximum depth when quality matters more than latency.",
};

// Explicit effort picker. A cycle-only control hid available levels (especially
// the new GPT-5.6 Max setting) and made changing from Low to Max require several
// blind clicks. The bars still provide the glanceable depth cue.
export default function ThinkingControl({ effort, availableEfforts, onCycle }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (availableEfforts.length === 0) return null;
  const label = EFFORT_LABELS[effort] ?? effort;
  const litBars = barsForEffort(effort);

  return (
    <div className="composer-thinking-wrap" ref={rootRef}>
      <button
        type="button"
        className={`composer-thinking${open ? " is-active" : ""}`}
        title={`${label} reasoning — ${EFFORT_DESCRIPTIONS[effort]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ThinkingBars lit={litBars} />
        <span className="composer-thinking-label">{label}</span>
        <span aria-hidden className="composer-chevron">⌄</span>
      </button>
      {open && (
        <div className="composer-thinking-menu spark-menu" role="listbox" aria-label="Reasoning effort">
          <div className="composer-menu-heading">Reasoning effort</div>
          {availableEfforts.map((option) => {
            const active = option === effort;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={active}
                className={`composer-effort-option${active ? " is-active" : ""}`}
                onClick={() => {
                  onCycle(option);
                  setOpen(false);
                }}
              >
                <ThinkingBars lit={barsForEffort(option)} />
                <span className="composer-mode-option-copy">
                  <span className="composer-mode-option-label">{EFFORT_LABELS[option]}</span>
                  <span className="composer-mode-option-description">
                    {EFFORT_DESCRIPTIONS[option]}
                  </span>
                </span>
                {active && <span className="composer-menu-check" aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
