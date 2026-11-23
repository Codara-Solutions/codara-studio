// What a sleeping agent pane shows (agent hibernation): its output faded back
// behind a solid scrim and, centred on the pane at any size, the moon above
// one pill with the session's title, how long it sleeps, the memory freed and
// Resume. Its own module so the renderer loads it only once a pane actually
// sleeps, not at startup.

import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { TerminalLeafHibernation } from "../../tabs/types";
import { MoonIcon } from "./AgentSleepControls";

const RUNTIME_NAME: Record<TerminalLeafHibernation["runtime"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

export const RESUME_TITLE = "Resume. Shift+click: resume and never let it sleep again";

// Pane widths (px, the pane's own box) under which the pill drops a part:
// the memory freed, then how long it sleeps, then everything but Resume.
const DROP_FREED_BELOW = 380;
const DROP_ASLEEP_BELOW = 300;
const RESUME_ONLY_BELOW = 260;
// Pane height (px) under which the moon goes and the pill keeps clear of the
// Sleeping chip in the pane's top-left corner.
const SHORT_BELOW = 140;
const CHIP_CLEARANCE = 36;

/** 0: everything; 1: no memory freed; 2: no time asleep either; 3: Resume only. */
export type PillStep = 0 | 1 | 2 | 3;

export function pillStep(width: number): PillStep {
  if (width < RESUME_ONLY_BELOW) return 3;
  if (width < DROP_ASLEEP_BELOW) return 2;
  if (width < DROP_FREED_BELOW) return 1;
  return 0;
}

function sleptFor(sleptAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - sleptAt) / 60_000));
  if (minutes < 1) return "asleep just now";
  if (minutes < 60) return `asleep ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `asleep ${hours} h`;
  return `asleep ${Math.round(hours / 24)} days`;
}

function freedText(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !(bytes > 0)) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `freed ${(mb / 1024).toFixed(1)} GB` : `freed ${Math.round(mb)} MB`;
}

// The error text on the pill: the danger colour taken halfway to the ink, so
// it reads at 4.5:1 or better on --panel-2 in every theme (Rose Pine Dawn is
// the lowest, 4.58:1). Existing tokens only, no new colour.
const ERROR_COLOR = "color-mix(in oklab, var(--danger) 50%, var(--ink))";

/**
 * The moon above one pill. Presentational: SleepingPaneCard measures the pane
 * and passes the step and whether it is short.
 */
export function SleepingPill({
  hibernation,
  step,
  short,
  now,
  onResume,
  onResumeKeepRunning,
}: {
  hibernation: TerminalLeafHibernation;
  step: PillStep;
  short: boolean;
  now: number;
  onResume: () => void;
  onResumeKeepRunning: () => void;
}) {
  const waking = hibernation.resumeRequested === true;
  const name = RUNTIME_NAME[hibernation.runtime] ?? "Agent";
  const title = hibernation.summary?.title ?? `${name} session`;
  const detail = hibernation.summary?.detail ?? null;
  const resumeOnly = step === 3;
  const asleep = sleptFor(hibernation.sleptAt, now);
  const freed = freedText(hibernation.freedBytes);
  const failed = hibernation.wakeError ? `Could not resume: ${hibernation.wakeError}` : null;
  const parts = [step >= 2 ? null : asleep, step >= 1 ? null : freed].filter(Boolean);
  const all = [asleep, freed].filter(Boolean);
  // What the pill leaves out is still on its tooltip. A failed resume shows
  // its reason, not the title, and the tooltip always has both and the last
  // request.
  const tooltip = failed
    ? [failed, title, detail]
    : [resumeOnly ? title : null, parts.length < all.length ? all.join(" · ") : null, detail];
  const label = `${name} asleep: ${title}${failed ? `. ${failed}` : ""}`;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const resume = (keepRunning: boolean) => (keepRunning ? onResumeKeepRunning() : onResume());
  return (
    <div
      className="spark-fade-in"
      role="group"
      aria-label={label}
      data-testid="pane-sleeping-card"
      data-waking={waking ? "true" : "false"}
      onMouseDown={stop}
      onPointerDown={stop}
      style={{
        display: "grid",
        justifyItems: "center",
        gap: 12,
        maxWidth: "100%",
        minWidth: 0,
        pointerEvents: "auto",
        animationDuration: "var(--motion-fast)",
      }}
    >
      {short ? null : (
        <div
          data-testid="pane-sleeping-moon"
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: "var(--panel-2)",
            border: "1px solid var(--rule)",
            boxShadow: "var(--lift-hi), 0 0 0 1px var(--rule-soft)",
            color: "var(--accent-text)",
          }}
        >
          <MoonIcon size={21} />
        </div>
      )}
      <div
        data-testid="pane-sleeping-pill"
        title={tooltip.filter(Boolean).join("\n") || undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          maxWidth: "100%",
          minWidth: 0,
          padding: resumeOnly ? 6 : "6px 6px 6px 16px",
          borderRadius: 999,
          background: "var(--panel-2)",
          border: "1px solid var(--rule)",
          boxShadow: "var(--lift-hi), 0 0 0 1px var(--rule-soft)",
          color: "var(--ink)",
        }}
      >
        {resumeOnly ? (
          failed ? (
            <span
              data-testid="pane-sleeping-error-mark"
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)", flex: "none", marginLeft: 4 }}
            />
          ) : null
        ) : (
          <span
            style={{
              minWidth: 0,
              fontSize: 12.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {failed ? (
              <span data-testid="pane-sleeping-error" style={{ color: ERROR_COLOR, fontWeight: 500 }}>
                {failed}
              </span>
            ) : (
              <>
                <bdi data-testid="pane-sleeping-title" style={{ fontWeight: 600 }}>
                  {title}
                </bdi>
                {parts.length > 0 ? (
                  <span data-testid="pane-sleeping-meta" style={{ color: "var(--ink-dim)" }}>
                    {` · ${parts.join(" · ")}`}
                  </span>
                ) : null}
              </>
            )}
          </span>
        )}
        <button
          type="button"
          className="spark-btn is-primary"
          data-testid="pane-resume"
          disabled={waking}
          title={RESUME_TITLE}
          aria-keyshortcuts="Shift+Enter"
          onKeyDown={(event) => {
            // The focus lands here right after Sleep now: an Enter still
            // held from that press must not wake the agent at once.
            if (event.key === "Enter" && event.repeat) {
              event.preventDefault();
              return;
            }
            if (event.key !== "Enter" || !event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            resume(true);
          }}
          onClick={(event) => {
            event.stopPropagation();
            resume(event.shiftKey);
          }}
          style={{ borderRadius: 999, flex: "none" }}
        >
          {waking ? "Resuming…" : failed ? "Try again" : "Resume"}
        </button>
      </div>
    </div>
  );
}

/**
 * A sleeping pane reads as asleep at a glance; its output is secondary. The
 * scrim takes no pointer events, so the wheel still scrolls the output under
 * it and its text can still be selected and copied. Solid like the rest of
 * the pane's chrome: no blur, no glass.
 */
export default function SleepingPaneCard({
  hibernation,
  onResume,
  onResumeKeepRunning,
}: {
  hibernation: TerminalLeafHibernation;
  onResume: () => void;
  onResumeKeepRunning: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Only the step and the short flag are state: a resize re-renders the card
  // when one of them changes, not on every frame.
  const [step, setStep] = useState<PillStep>(0);
  const [short, setShort] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // The pane's own box (this layer fills it), not the padded content.
      const box = node.getBoundingClientRect();
      setStep(pillStep(box.width));
      setShort(box.height < SHORT_BELOW);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        aria-hidden
        data-testid="pane-sleeping-scrim"
        style={{
          position: "absolute",
          inset: 0,
          background: "color-mix(in oklab, var(--bg) 84%, transparent)",
          pointerEvents: "none",
          zIndex: 4,
        }}
      />
      <div
        ref={ref}
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          padding: 16,
          paddingTop: short ? CHIP_CLEARANCE : 16,
          pointerEvents: "none",
          zIndex: 6,
        }}
      >
        <SleepingPill
          hibernation={hibernation}
          step={step}
          short={short}
          now={Date.now()}
          onResume={onResume}
          onResumeKeepRunning={onResumeKeepRunning}
        />
      </div>
    </>
  );
}
