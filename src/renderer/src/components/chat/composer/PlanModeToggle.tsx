import type { ChatMode } from "@shared/types";

interface Props {
  mode: ChatMode;
  onSelect: (mode: ChatMode) => void;
}

// Manager-mode selector — a SINGLE pill that CYCLES on each press:
//   Auto → Talk → Plan → Execute → Auto → …
// The label shows the CURRENT mode; clicking advances to the next one. Colour
// and the leading dot shift per mode (see .composer-mode-cycle in styles.css):
//   Auto       — Cora decides per message: answer, plan, or build with
//                parallel workers. Default for new chats.
//   Talk       — pure conversation, no workers.
//   Plan       — Best-of-N council: top-tier Claude + Codex agents each draft a
//                PLAN + PRD, then a judge synthesizes the best merged pair.
//   Execute    — Cora spawns workers to implement the work (the composer shell
//                also picks up its dashed "armed" border in this mode).
// "automation" is no longer offered here (the architect moved to the
// Automations tab) but keeps a META entry so legacy persisted runs still
// render their own label; clicking one advances into the normal cycle.
const CYCLE: ReadonlyArray<ChatMode> = ["auto", "talk", "plan", "execute"];

const META: Record<ChatMode, { label: string; blurb: string }> = {
  auto: {
    label: "Auto",
    blurb: "Cora decides — answers, plans, or builds with parallel workers",
  },
  talk: { label: "Talk", blurb: "pure conversation, no workers" },
  plan: {
    label: "Plan",
    blurb:
      "Best-of-N council — top-tier Claude + Codex agents each draft a PLAN + PRD, then a judge synthesizes the best merged pair",
  },
  execute: { label: "Execute", blurb: "Cora spawns workers to do the work" },
  automation: {
    label: "Automation",
    blurb: "design, create, test and run Cora automations (looms) by chatting",
  },
};

export default function PlanModeToggle({ mode, onSelect }: Props) {
  // Off-cycle-but-known modes (legacy "automation" runs) render their own
  // label; unknown persisted junk falls back to Auto. Either way the next
  // click lands on CYCLE[0]: indexOf(current) is -1 for "automation", and
  // -1 + 1 === 0.
  const current: ChatMode = META[mode] ? mode : CYCLE[0];
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
