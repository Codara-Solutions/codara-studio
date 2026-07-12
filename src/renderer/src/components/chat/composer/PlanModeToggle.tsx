import { useEffect, useRef, useState } from "react";
import type { ChatMode } from "@shared/types";

interface Props {
  mode: ChatMode;
  onSelect: (mode: ChatMode) => void;
}

// Manager-mode selector. The pill opens an explicit menu instead of cycling
// through hidden choices, so a user can understand the consequence before
// changing modes:
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current: ChatMode = META[mode] ? mode : CYCLE[0];
  const meta = META[current];

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

  const visibleModes: ReadonlyArray<ChatMode> =
    current === "automation" ? ["automation", ...CYCLE] : CYCLE;

  return (
    <div className="composer-mode" ref={rootRef}>
      <button
        type="button"
        className={`composer-mode-cycle is-${current}${open ? " is-open" : ""}`}
        title={`${meta.label} — ${meta.blurb}`}
        aria-label={`Manager mode: ${meta.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{meta.label}</span>
        <span aria-hidden className="composer-chevron">⌄</span>
      </button>
      {open && (
        <div className="composer-mode-menu spark-menu" role="listbox" aria-label="Cora mode">
          <div className="composer-menu-heading">How Cora should handle this chat</div>
          {visibleModes.map((option) => {
            const optionMeta = META[option];
            const active = option === current;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={active}
                className={`composer-mode-option is-${option}${active ? " is-active" : ""}`}
                onClick={() => {
                  onSelect(option);
                  setOpen(false);
                }}
              >
                <span className="composer-mode-option-dot" aria-hidden />
                <span className="composer-mode-option-copy">
                  <span className="composer-mode-option-label">{optionMeta.label}</span>
                  <span className="composer-mode-option-description">{optionMeta.blurb}</span>
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
