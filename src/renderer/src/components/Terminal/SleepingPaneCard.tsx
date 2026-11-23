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

// Pane widths (px) under which the pill drops a part: the memory freed, then
// how long it sleeps, then everything but Resume.
const DROP_FREED_BELOW = 380;
const DROP_ASLEEP_BELOW = 300;
const RESUME_ONLY_BELOW = 260;

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

/**
 * A sleeping pane reads as asleep at a glance; its output is secondary. The
 * scrim takes no pointer events, so the wheel still scrolls the output under
 * it (text under it cannot be selected while it sleeps). Solid like the rest
 * of the pane's chrome: no blur, no glass.
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
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const waking = hibernation.resumeRequested === true;
  const name = RUNTIME_NAME[hibernation.runtime] ?? "Agent";
  const title = hibernation.summary?.title ?? `${name} session`;
  const detail = hibernation.summary?.detail ?? null;
  const resumeOnly = width < RESUME_ONLY_BELOW;
  const asleep = sleptFor(hibernation.sleptAt, Date.now());
  const freed = freedText(hibernation.freedBytes);
  const parts = [width < DROP_ASLEEP_BELOW ? null : asleep, width < DROP_FREED_BELOW ? null : freed].filter(Boolean);
  // What a narrow pill leaves out is still on its tooltip.
  const tooltip = [
    resumeOnly ? title : null,
    parts.length < [asleep, freed].filter(Boolean).length ? [asleep, freed].filter(Boolean).join(" · ") : null,
    detail,
  ].filter(Boolean);
  const failed = hibernation.wakeError ? `Could not resume: ${hibernation.wakeError}` : null;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const resume = (keepRunning: boolean) => (keepRunning ? onResumeKeepRunning() : onResume());
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
          pointerEvents: "none",
          zIndex: 6,
        }}
      >
        <div
          className="spark-fade-in"
          role="group"
          aria-label={`${name} asleep: ${title}`}
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
              color: "var(--accent)",
            }}
          >
            <MoonIcon size={21} />
          </div>
          <div
            data-testid="pane-sleeping-pill"
            title={tooltip.join("\n") || undefined}
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
            {!resumeOnly ? (
              <span
                style={{
                  minWidth: 0,
                  fontSize: 12.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <span data-testid="pane-sleeping-title" style={{ fontWeight: 600 }}>
                  {title}
                </span>
                {failed ? (
                  <span data-testid="pane-sleeping-error" style={{ color: "var(--danger)" }}>
                    {` · ${failed}`}
                  </span>
                ) : parts.length > 0 ? (
                  <span data-testid="pane-sleeping-meta" style={{ color: "var(--ink-dim)" }}>
                    {` · ${parts.join(" · ")}`}
                  </span>
                ) : null}
              </span>
            ) : null}
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
      </div>
    </>
  );
}
