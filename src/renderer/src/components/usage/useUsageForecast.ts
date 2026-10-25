// Labs: the usage forecast, shared by the title bar, the usage panel and the
// Usage tab. One read serves all three; the main process caches the scan.

import { useEffect, useState } from "react";
import type { UsageForecastReport, WindowForecastView } from "@shared/usage-forecast";

const FRESH_MS = 60_000;
const POLL_MS = 5 * 60_000;

let cached: { at: number; report: UsageForecastReport | null } | null = null;
let inflight: Promise<UsageForecastReport | null> | null = null;
let forcedAfter: Promise<UsageForecastReport | null> | null = null;
/** Bumped when the report is forgotten: a read that started before must not
 * bring back a report from before the feature was turned off. */
let generation = 0;

/** A new report, or why the last read failed (the report then stays). */
export type UsageForecastUpdate = { report: UsageForecastReport | null } | { error: string };
const listeners = new Set<(update: UsageForecastUpdate) => void>();
let pollTimer: number | null = null;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadUsageForecast(force = false): Promise<UsageForecastReport | null> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.report);
  if (inflight) {
    if (!force) return inflight;
    // A forced read waits for the one in flight and then reads again, since
    // the one in flight may predate the change that forced it. Every forced
    // read that arrives meanwhile shares that one second read.
    if (!forcedAfter) {
      const waited = generation;
      const after: Promise<UsageForecastReport | null> = inflight
        .catch(() => null)
        .then(() => {
          if (forcedAfter === after) forcedAfter = null;
          return waited === generation ? loadUsageForecast(true) : null;
        });
      forcedAfter = after;
    }
    return forcedAfter;
  }
  const started = generation;
  const read: Promise<UsageForecastReport | null> = window.spark.usageAnalytics
    .forecast()
    .then(
      (report) => {
        if (started !== generation) return null;
        cached = { at: Date.now(), report };
        for (const listener of listeners) listener({ report });
        return report;
      },
      (err: unknown) => {
        if (started === generation) {
          for (const listener of listeners) listener({ error: messageOf(err) });
        }
        throw err;
      },
    )
    .finally(() => {
      if (inflight === read) inflight = null;
    });
  inflight = read;
  return read;
}

/**
 * Follows the forecast while the feature is on. However many meters and tabs
 * watch it, one timer reads it every POLL_MS: each read builds a report in
 * the main process, so one per view would multiply that work.
 */
export function watchUsageForecast(listener: (update: UsageForecastUpdate) => void): () => void {
  listeners.add(listener);
  pollTimer ??= window.setInterval(() => {
    void loadUsageForecast().catch(() => undefined);
  }, POLL_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

/** Forgets the last report, so turning the feature back on never shows one
 * from before it was off. */
export function forgetUsageForecast(): void {
  generation += 1;
  cached = null;
  inflight = null;
  forcedAfter = null;
}

export interface UsageForecastState {
  report: UsageForecastReport | null;
  loading: boolean;
  error: string | null;
}

export function useUsageForecast(enabled: boolean): UsageForecastState {
  const [report, setReport] = useState<UsageForecastReport | null>(enabled ? (cached?.report ?? null) : null);
  const [loading, setLoading] = useState(enabled && cached === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      forgetUsageForecast();
      setReport(null);
      return;
    }
    let alive = true;
    const unwatch = watchUsageForecast((update) => {
      if (!alive) return;
      if ("error" in update) {
        setError(update.error);
        return;
      }
      setReport(update.report);
      setError(null);
    });
    setLoading(true);
    loadUsageForecast()
      .then((next) => {
        if (!alive) return;
        setReport(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(messageOf(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      unwatch();
    };
  }, [enabled]);

  return { report, loading, error };
}

export function forecastFor(
  report: UsageForecastReport | null,
  profileId: string | undefined,
  windowId: string,
): WindowForecastView | null {
  if (!report || !profileId) return null;
  return report.windows.find((view) => view.profileId === profileId && view.windowId === windowId) ?? null;
}

/** How the panel shows the forecast. B (ghost, the projection on the meter)
 * is the chosen default; A and C stay as a per-viewer choice in the Labs card,
 * so it lives in localStorage rather than in preferences. */
export type ForecastPanelStyle = "line" | "ghost" | "pill";

const STYLE_KEY = "spark.usage.forecastStyle";
const STYLE_EVENT = "spark:usage-forecast-style";

export function readForecastStyle(): ForecastPanelStyle {
  try {
    const value = window.localStorage.getItem(STYLE_KEY);
    return value === "line" || value === "pill" ? value : "ghost";
  } catch {
    return "ghost";
  }
}

export function writeForecastStyle(style: ForecastPanelStyle): void {
  try {
    window.localStorage.setItem(STYLE_KEY, style);
  } catch {
    // A locked storage keeps the choice for this window only.
  }
  window.dispatchEvent(new CustomEvent(STYLE_EVENT, { detail: style }));
}

export function useForecastStyle(): ForecastPanelStyle {
  const [style, setStyle] = useState<ForecastPanelStyle>(readForecastStyle);
  useEffect(() => {
    const onChange = (event: Event) => setStyle((event as CustomEvent<ForecastPanelStyle>).detail);
    window.addEventListener(STYLE_EVENT, onChange);
    return () => window.removeEventListener(STYLE_EVENT, onChange);
  }, []);
  return style;
}
