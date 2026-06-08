import type { ChatMode } from "@shared/types";

interface Props {
  mode: ChatMode;
  onSelect: (mode: ChatMode) => void;
}

// Manager-mode selector — a SINGLE pill that CYCLES on each press:
//   Talk → Plan → Execute → Talk → …
// The label shows the CURRENT mode; clicking advances to the next one. Colour
// and the leading dot shift per mode (see .composer-mode-cycle in styles.css):
//   Talk    — pure conversation, no workers.
//   Plan    — Best-of-N council: top-tier Claude + Codex agents each draft a
//             PLAN + PRD, then a judge synthesizes the best merged pair.
//   Execute — Spark spawns workers to implement the work (the composer shell
//             also picks up its dashed "armed" border in this mode).
const CYCLE: ReadonlyArray<ChatMode> = ["talk", "plan", "execute"];

const META: Record<ChatMode, { label: string; blurb: string }> = {
  talk: { label: "Talk", blurb: "pure conversation, no workers" },
  plan: {
    label: "Plan",
    blurb:
      "Best-of-N council — top-tier Claude + Codex agents each draft a PLAN + PRD, then a judge synthesizes the best merged pair",
  },
  execute: { label: "Execute", blurb: "Spark spawns workers to do the work" },
};

export default function PlanModeToggle({ mode, onSelect }: Props) {
  // Guard against an unknown / legacy persisted value; fall back to Talk.
  const current: ChatMode = CYCLE.includes(mode) ? mode : CYCLE[0];
  const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
  const meta = META[current];
  const nextMeta = META[next];

  return (
    <button
      type="button"
      className={`composer-mode-cycle is-${current}`}
      title={`${meta.label} — ${meta.blurb}.\nClick to switch to ${nextMeta.label}.`}
      aria-label={`Manager mode: ${meta.label}. Click to switch to ${nextMeta.label}.`}
      onClick={() => onSelect(next)}
    >
      {meta.label}
    </button>
  );
}
