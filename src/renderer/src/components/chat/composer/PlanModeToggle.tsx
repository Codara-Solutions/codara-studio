import type { ChatMode } from "@shared/types";

interface Props {
  mode: ChatMode;
  onToggle: () => void;
}

// Talk / Execute toggle. The label reflects the CURRENT mode (matching
// vienna's convention): pressing the pill flips it. Execute mode gets an
// accent treatment because that's the "workers will spawn" state — the
// dashed border around the whole composer shell is keyed off the same
// state in CSS (.composer-shell.is-execute-mode).
export default function PlanModeToggle({ mode, onToggle }: Props) {
  const isExecute = mode === "execute";
  const label = isExecute ? "Execute" : "Talk";
  return (
    <button
      type="button"
      className={`composer-plan${isExecute ? " is-execute" : ""}`}
      aria-pressed={isExecute}
      title={
        isExecute
          ? "Execute mode — Spark spawns workers to do the work. Click to switch to Talk."
          : "Talk mode — pure conversation, no workers. Click to switch to Execute."
      }
      onClick={onToggle}
    >
      <BookIcon />
      <span className="composer-plan-label">{label}</span>
    </button>
  );
}

// Small open-book glyph borrowed from vienna. 12×12 SVG; inherits color.
function BookIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 3.5C3.5 3 5.5 3 8 4C10.5 3 12.5 3 14 3.5V13C12.5 12.5 10.5 12.5 8 13.5C5.5 12.5 3.5 12.5 2 13V3.5Z" />
      <path d="M8 4V13.5" />
    </svg>
  );
}
