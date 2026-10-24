// Labs: the usage forecast, shared by the title bar, the usage panel and the
// Usage tab. One read serves all three; the main process caches the scan.

import { useEffect, useState } from "react";
import type { UsageForecastReport, WindowForecastView } from "@shared/usage-forecast";

const FRESH_MS = 60_000;
const POLL_MS = 5 * 60_000;

let cached: { at: number; report: UsageForecastReport | null } | null = null;
let inflight: Promise<UsageForecastReport | null> | null = null;
const listeners = new Set<(report: UsageForecastReport | null) => void>();

export function loadUsageForecast(force = false): Promise<UsageForecastReport | null> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.report);
  // A forced read waits for the one in flight and then reads again, since the
  // one in flight may predate the change that forced it.
  if (inflight) return force ? inflight.catch(() => null).then(() => loadUsageForecast(true)) : inflight;
  inflight = window.spark.usageAnalytics
    .forecast()
    .then((report) => {
      cached = { at: Date.now(), report };
      for (const listener of listeners) listener(report);
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
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
      setReport(null);
      return;
    }
    let alive = true;
    const listener = (next: UsageForecastReport | null) => {
      if (alive) setReport(next);
    };
    listeners.add(listener);
    const read = (force: boolean) => {
      setLoading(true);
      loadUsageForecast(force)
        .then((next) => {
          if (!alive) return;
          setReport(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    read(false);
    const timer = window.setInterval(() => read(true), POLL_MS);
    return () => {
      alive = false;
      listeners.delete(listener);
      window.clearInterval(timer);
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

/** How the panel shows the forecast. A per-viewer demo choice, so it lives in
 * localStorage rather than in preferences. */
export type ForecastPanelStyle = "line" | "ghost" | "pill";

const STYLE_KEY = "spark.usage.forecastStyle";
const STYLE_EVENT = "spark:usage-forecast-style";

export function readForecastStyle(): ForecastPanelStyle {
  try {
    const value = window.localStorage.getItem(STYLE_KEY);
    return value === "ghost" || value === "pill" ? value : "line";
  } catch {
    return "line";
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
