import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  enumerateDays,
  makeUsageWindow,
  resolveLocalTimeZone,
  totalTokens,
  type UsageDayBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@shared/usage-analytics";
import { formatCount, formatDayShort, formatPercent, formatTokens, formatUsd } from "./usage-format";

// The Usage page: daily token spend across the three harnesses whose
// transcripts live on this machine (Claude Code, Codex, and Cora's own Pi
// sessions). The scan itself lives in the main process; this file is display
// only — every number here is derived from the summary it hands back.

const WINDOW_OPTIONS = [7, 30, 90] as const;

const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cora: "Cora",
};

// Stacking order, bottom band first. Cora carries the app accent because it is
// Codara's own spend; the other two take their vendors' marks.
const PROVIDER_ORDER: readonly UsageProviderKind[] = ["cora", "codex", "claude"];

const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "var(--ink-dim)",
  cora: "var(--accent)",
};

type UsageMetric = "cost" | "tokens";
type UsageBreakdown = "model" | "day";

// Reopening the tab (or flipping back to a window already fetched) inside this
// window reuses the last answer instead of re-running a scan that takes seconds
// on a large history. Manual refresh always bypasses it.
const SUMMARY_TTL_MS = 2 * 60 * 1000;
const summaryCache = new Map<string, { fetchedAtMs: number; summary: UsageSummary }>();

function windowKey(input: UsageSummaryInput): string {
  return `${input.sinceDay}|${input.untilDay}|${input.timeZone}`;
}

interface DayTotals {
  day: string;
  costUsd: number;
  tokens: number;
  byProvider: Map<UsageProviderKind, { costUsd: number; tokens: number }>;
}

export default function UsagePage() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [breakdown, setBreakdown] = useState<UsageBreakdown>("model");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Bumped by Refresh to re-read the clock. Without it the range would hold
  // the `new Date()` captured when the window length last changed, and a tab
  // left open overnight would keep asking for yesterday's untilDay — today's
  // usage would be invisible no matter how often the user refreshed.
  const [rangeEpoch, setRangeEpoch] = useState(0);

  // Otherwise recomputed only when the window length changes, so an unrelated
  // re-render never shifts the range and triggers a fresh scan.
  const timeZone = useMemo(() => resolveLocalTimeZone(), []);
  const range = useMemo(
    () => makeUsageWindow(windowDays, new Date(), timeZone),
    [windowDays, timeZone, rangeEpoch],
  );

  // Guards against a slow earlier scan resolving after a newer one and
  // overwriting it with a stale window's numbers.
  const requestRef = useRef(0);
  // Set by Refresh and consumed by the fetch effect, so one gesture both
  // re-reads the clock and bypasses the summary cache.
  const pendingForceRef = useRef(false);

  const load = useCallback(
    async (input: UsageSummaryInput, options?: { force?: boolean }) => {
      const key = windowKey(input);
      const cached = summaryCache.get(key);
      // The counter is bumped on EVERY load, cache hits included. Serving a hit
      // without claiming the newest request number would let an older, slower
      // scan for a different window resolve afterwards, pass the staleness
      // check, and paint 90-day totals under a 30-day header.
      const request = (requestRef.current += 1);
      if (!options?.force && cached && Date.now() - cached.fetchedAtMs < SUMMARY_TTL_MS) {
        setSummary(cached.summary);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await window.spark.usageAnalytics.summary(input);
        if (requestRef.current !== request) return;
        summaryCache.set(key, { fetchedAtMs: Date.now(), summary: next });
        setSummary(next);
      } catch (err) {
        if (requestRef.current !== request) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestRef.current === request) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const force = pendingForceRef.current;
    pendingForceRef.current = false;
    void load(range, { force });
  }, [load, range]);

  // Bumping the epoch rebuilds `range` off the current clock, which re-runs the
  // effect above even when the resulting days are unchanged (the memo returns a
  // new object), so Refresh always rescans.
  const refresh = useCallback(() => {
    pendingForceRef.current = true;
    setRangeEpoch((epoch) => epoch + 1);
  }, []);

  const days = useMemo(() => enumerateDays(range.sinceDay, range.untilDay), [range]);
  const buckets = summary?.buckets ?? [];

  const daily = useMemo(() => buildDailyTotals(days, buckets), [days, buckets]);
  const byDay = useMemo(() => new Map(daily.map((entry) => [entry.day, entry])), [daily]);

  const totals = useMemo(() => summarizeBuckets(buckets), [buckets]);
  const activeDays = daily.filter((day) => day.tokens > 0).length;
  const dailyAverage = activeDays === 0 ? 0 : totals.tokens / activeDays;
  const observedInput = totals.uncachedInputTokens + totals.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : totals.cachedInputTokens / observedInput;

  // Each source counts its own distinct sessions, and the three transcript
  // roots are disjoint, so summing them is exact — unlike summing the per-cell
  // counts, where one session spanning days and models is counted repeatedly.
  const sessionCount = (summary?.sources ?? []).reduce(
    (total, source) => total + source.distinctSessions,
    0,
  );

  const modelRows = useMemo(() => buildModelRows(buckets), [buckets]);
  const dayRows = useMemo(() => daily.filter((day) => day.tokens > 0).reverse(), [daily]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflowY: "auto",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "20px 24px 40px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <header
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Usage</h1>
            <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>
              {formatDayShort(range.sinceDay)} – {formatDayShort(range.untilDay)} ·{" "}
              {range.timeZone}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <SegmentedControl
              label="Usage window"
              options={WINDOW_OPTIONS.map((option) => ({
                value: String(option),
                label: `${option} days`,
              }))}
              value={String(windowDays)}
              onChange={(value) => setWindowDays(Number(value))}
            />
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              title="Rescan transcripts"
              style={{
                border: "1px solid var(--rule)",
                borderRadius: "var(--radius-control)",
                background: "transparent",
                color: "var(--ink-dim)",
                fontSize: 11,
                padding: "5px 10px",
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.5 : 1,
              }}
            >
              {loading ? "Scanning…" : "Refresh"}
            </button>
          </div>
        </header>

        {error !== null && (
          <div
            role="alert"
            style={{
              border: "1px solid var(--danger)",
              background: "var(--danger-soft)",
              borderRadius: "var(--radius-surface)",
              padding: "8px 12px",
              fontSize: 12,
            }}
          >
            Usage could not be scanned: {error}
          </div>
        )}

        {summary === null ? (
          <p style={{ padding: "64px 0", textAlign: "center", fontSize: 12, color: "var(--ink-dim)" }}>
            {error === null ? "Scanning transcripts…" : "No usage to show."}
          </p>
        ) : (
          <>
            <section
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 1,
                background: "var(--rule-soft)",
                border: "1px solid var(--rule-soft)",
                borderRadius: "var(--radius-surface)",
                overflow: "hidden",
              }}
            >
              <Stat
                label="Total cost"
                value={`${formatUsd(totals.costUsd)}${totals.pricedRecords > 0 ? "*" : ""}`}
                detail={
                  totals.unpricedRecords > 0
                    ? `${formatCount(totals.unpricedRecords)} calls on unpriced models`
                    : "across all three harnesses"
                }
              />
              <Stat
                label="Total tokens"
                value={formatTokens(totals.tokens)}
                detail={`${formatCount(sessionCount)} sessions`}
              />
              <Stat
                label="Daily average"
                value={formatTokens(dailyAverage)}
                detail={`over ${formatCount(activeDays)} active days`}
              />
              <Stat
                label="Cache hits"
                value={formatPercent(cachedShare)}
                detail={`${formatTokens(totals.cachedInputTokens)} of observed input`}
              />
              <Stat
                label="Cache savings"
                value={formatUsd(totals.cacheSavingsUsd)}
                detail="vs. full input rates"
              />
            </section>

            <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
              * Estimated where the transcript did not report a cost: those calls are priced from
              Codara's local rate table, which drifts from vendor list prices. Cora's own sessions
              report exact costs and are used as-is.
            </p>

            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>
                  Daily {metric === "cost" ? "cost" : "tokens"}
                </h2>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <Legend />
                  <SegmentedControl
                    label="Chart metric"
                    options={[
                      { value: "cost", label: "Cost" },
                      { value: "tokens", label: "Tokens" },
                    ]}
                    value={metric}
                    onChange={(value) => setMetric(value as UsageMetric)}
                  />
                </div>
              </div>
              <UsageChart days={days} byDay={byDay} metric={metric} />
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>Breakdown</h2>
                <SegmentedControl
                  label="Breakdown grouping"
                  options={[
                    { value: "model", label: "Model" },
                    { value: "day", label: "Day" },
                  ]}
                  value={breakdown}
                  onChange={(value) => setBreakdown(value as UsageBreakdown)}
                />
              </div>
              {breakdown === "model" ? (
                <ModelTable rows={modelRows} />
              ) : (
                <DayTable rows={dayRows} />
              )}
            </section>

            <SourcesFooter summary={summary} />
          </>
        )}
      </div>
    </div>
  );
}

/* ── Derivations ─────────────────────────────────────────────────────────── */

function buildDailyTotals(days: string[], buckets: UsageDayBucket[]): DayTotals[] {
  const rows = new Map<string, DayTotals>();
  for (const day of days) {
    rows.set(day, { day, costUsd: 0, tokens: 0, byProvider: new Map() });
  }
  for (const bucket of buckets) {
    const row = rows.get(bucket.day);
    // A bucket outside the enumerated days can only happen if the summary and
    // the range drifted apart mid-fetch; drop it rather than draw off-axis.
    if (row === undefined) continue;
    const tokens = totalTokens(bucket.totals);
    row.costUsd += bucket.costUsd;
    row.tokens += tokens;
    const provider = row.byProvider.get(bucket.provider) ?? { costUsd: 0, tokens: 0 };
    provider.costUsd += bucket.costUsd;
    provider.tokens += tokens;
    row.byProvider.set(bucket.provider, provider);
  }
  return [...rows.values()];
}

interface SummaryTotals {
  costUsd: number;
  cacheSavingsUsd: number;
  tokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  pricedRecords: number;
  unpricedRecords: number;
}

function summarizeBuckets(buckets: UsageDayBucket[]): SummaryTotals {
  const totals: SummaryTotals = {
    costUsd: 0,
    cacheSavingsUsd: 0,
    tokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    pricedRecords: 0,
    unpricedRecords: 0,
  };
  for (const bucket of buckets) {
    totals.costUsd += bucket.costUsd;
    totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
    totals.tokens += totalTokens(bucket.totals);
    totals.uncachedInputTokens += bucket.totals.uncachedInputTokens;
    totals.cachedInputTokens += bucket.totals.cachedInputTokens;
    totals.cacheCreationTokens += bucket.totals.cacheCreationTokens;
    totals.outputTokens += bucket.totals.outputTokens;
    if (bucket.costSource === "priced") totals.pricedRecords += bucket.recordCount;
    if (bucket.costSource === "unpriced") totals.unpricedRecords += bucket.recordCount;
  }
  return totals;
}

interface ModelRow {
  provider: UsageProviderKind;
  model: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  unpriced: boolean;
}

function buildModelRows(buckets: UsageDayBucket[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const bucket of buckets) {
    const key = `${bucket.provider}:${bucket.model}`;
    const row = rows.get(key) ?? {
      provider: bucket.provider,
      model: bucket.model,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      unpriced: false,
    };
    row.uncachedInputTokens += bucket.totals.uncachedInputTokens;
    row.cachedInputTokens += bucket.totals.cachedInputTokens;
    row.cacheCreationTokens += bucket.totals.cacheCreationTokens;
    row.outputTokens += bucket.totals.outputTokens;
    row.costUsd += bucket.costUsd;
    if (bucket.costSource === "unpriced") row.unpriced = true;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens);
}

/* ── Chart ───────────────────────────────────────────────────────────────── */

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 220;
const TICK_COUNT = 4;

/**
 * A scale whose maximum is a readable 1/2/5 x 10^n step at or above the peak.
 * Rounding UP is the point: stopping at the last step below the peak would draw
 * the tallest day past the top of the plot, where it is clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

function UsageChart({
  days,
  byDay,
  metric,
}: {
  days: string[];
  byDay: Map<string, DayTotals>;
  metric: UsageMetric;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const columns = useMemo(
    () =>
      days.map((day) => {
        const entry = byDay.get(day);
        let stackTop = 0;
        const bands = PROVIDER_ORDER.map((provider) => {
          const cell = entry?.byProvider.get(provider);
          const value = cell === undefined ? 0 : metric === "cost" ? cell.costUsd : cell.tokens;
          const base = stackTop;
          stackTop += value;
          return { provider, value, base, top: stackTop };
        });
        return { day, bands, total: stackTop };
      }),
    [days, byDay, metric],
  );

  const peak = columns.reduce((max, column) => Math.max(max, column.total), 0);
  const { max, ticks } = niceScale(peak, TICK_COUNT);
  const toY = (value: number) => (max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT * (1 - value / max));
  const format = metric === "cost" ? formatUsd : formatTokens;

  const slot = days.length === 0 ? 0 : VIEW_WIDTH / days.length;
  // Bars keep a hairline gap at any window length, but never collapse to
  // nothing on a 90-day range.
  const barWidth = Math.max(1, slot * 0.72);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const bounds = plotRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width === 0 || days.length === 0) return;
      const fraction = (event.clientX - bounds.left) / bounds.width;
      const index = Math.floor(fraction * days.length);
      setHoverIndex(Math.min(days.length - 1, Math.max(0, index)));
    },
    [days.length],
  );

  const hovered = hoverIndex === null ? undefined : columns[hoverIndex];
  const hoverLeft = days.length === 0 ? 0 : (((hoverIndex ?? 0) + 0.5) / days.length) * 100;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {/* Axis labels live outside the SVG so the non-uniform scaling of the
            plot never stretches their glyphs. */}
        <div style={{ position: "relative", width: 52, height: 200, flex: "0 0 52px" }}>
          {ticks.map((tick) => (
            <span
              key={tick}
              style={{
                position: "absolute",
                right: 0,
                top: `${(toY(tick) / VIEW_HEIGHT) * 100}%`,
                transform: "translateY(-50%)",
                fontSize: 10,
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
          style={{ position: "relative", height: 200, flex: 1 }}
        >
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Daily ${metric === "cost" ? "cost" : "tokens"} by provider`}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="var(--rule-soft)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {columns.map((column, index) => {
              const x = index * slot + (slot - barWidth) / 2;
              return (
                <g key={column.day} opacity={hoverIndex === null || hoverIndex === index ? 1 : 0.55}>
                  {column.bands.map((band) =>
                    // A day with no usage renders nothing rather than a
                    // zero-height sliver, so gaps read as gaps.
                    band.value <= 0 ? null : (
                      <rect
                        key={band.provider}
                        x={x}
                        width={barWidth}
                        y={toY(band.top)}
                        height={Math.max(0, toY(band.base) - toY(band.top))}
                        fill={PROVIDER_COLOR[band.provider]}
                      />
                    ),
                  )}
                </g>
              );
            })}
          </svg>

          {hovered !== undefined && hovered.total > 0 && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: `${hoverLeft}%`,
                transform: hoverLeft > 60 ? "translateX(-100%)" : "translateX(0)",
                pointerEvents: "none",
                zIndex: 2,
                minWidth: 150,
                border: "1px solid var(--rule)",
                borderRadius: "var(--radius-surface)",
                background: "var(--panel-2)",
                boxShadow: "var(--shadow-1)",
                padding: "6px 8px",
                fontSize: 11,
              }}
            >
              <div style={{ color: "var(--ink-dim)", marginBottom: 3 }}>
                {formatDayShort(hovered.day)}
              </div>
              {[...hovered.bands].reverse().map((band) => (
                <div
                  key={band.provider}
                  style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      color: "var(--ink-dim)",
                    }}
                  >
                    <Swatch provider={band.provider} />
                    {PROVIDER_LABEL[band.provider]}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{format(band.value)}</span>
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  marginTop: 4,
                  paddingTop: 4,
                  borderTop: "1px solid var(--rule-soft)",
                }}
              >
                <span style={{ color: "var(--ink-dim)" }}>Total</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{format(hovered.total)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          paddingLeft: 60,
          fontSize: 10,
          color: "var(--muted)",
        }}
      >
        <span>{days[0] === undefined ? "" : formatDayShort(days[0])}</span>
        <span>
          {days[Math.floor(days.length / 2)] === undefined
            ? ""
            : formatDayShort(days[Math.floor(days.length / 2)]!)}
        </span>
        <span>
          {days[days.length - 1] === undefined ? "" : formatDayShort(days[days.length - 1]!)}
        </span>
      </div>
    </div>
  );
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

const CELL: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid var(--rule-soft)",
  fontSize: 12,
};
const NUM_CELL: React.CSSProperties = {
  ...CELL,
  textAlign: "right",
  fontFamily: "var(--font-mono)",
  color: "var(--ink-dim)",
};
const HEAD_CELL: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid var(--rule)",
  fontSize: 11,
  fontWeight: 400,
  color: "var(--muted)",
  textAlign: "left",
};

function ModelTable({ rows }: { rows: ModelRow[] }) {
  if (rows.length === 0) return <EmptyRow />;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={HEAD_CELL}>Model</th>
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Input</th>
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cached</th>
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cache write</th>
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Output</th>
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.provider}:${row.model}`}>
            <td style={CELL}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <Swatch provider={row.provider} />
                <span style={{ fontFamily: "var(--font-mono)" }}>{row.model}</span>
                {row.unpriced && <UnpricedBadge />}
              </span>
            </td>
            <td style={NUM_CELL}>{formatTokens(row.uncachedInputTokens)}</td>
            <td style={NUM_CELL}>{formatTokens(row.cachedInputTokens)}</td>
            <td style={NUM_CELL}>{formatTokens(row.cacheCreationTokens)}</td>
            <td style={NUM_CELL}>{formatTokens(row.outputTokens)}</td>
            <td style={{ ...NUM_CELL, color: "var(--ink)" }}>{formatUsd(row.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayTable({ rows }: { rows: DayTotals[] }) {
  if (rows.length === 0) return <EmptyRow />;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={HEAD_CELL}>Day</th>
          {PROVIDER_ORDER.map((provider) => (
            <th key={provider} style={{ ...HEAD_CELL, textAlign: "right" }}>
              {PROVIDER_LABEL[provider]}
            </th>
          ))}
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Total</th>
          <th style={{ ...HEAD_CELL, textAlign: "right" }}>Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.day}>
            <td style={CELL}>{formatDayShort(row.day)}</td>
            {PROVIDER_ORDER.map((provider) => (
              <td key={provider} style={NUM_CELL}>
                {formatUsd(row.byProvider.get(provider)?.costUsd ?? 0)}
              </td>
            ))}
            <td style={{ ...NUM_CELL, color: "var(--ink)" }}>{formatUsd(row.costUsd)}</td>
            <td style={NUM_CELL}>{formatTokens(row.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyRow() {
  return (
    <p style={{ padding: "24px 0", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
      No usage in this window.
    </p>
  );
}

/* ── Sources ─────────────────────────────────────────────────────────────── */

function SourcesFooter({ summary }: { summary: UsageSummary }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>Sources</h2>
      {summary.sources.map((source) => (
        <div
          key={source.provider}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: 8,
            fontSize: 11,
            color: "var(--ink-dim)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 110 }}>
            <Swatch provider={source.provider} />
            {PROVIDER_LABEL[source.provider]}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {source.dir || "—"}
          </span>
          {source.status === "ok" ? (
            <span style={{ color: "var(--muted)" }}>
              {formatCount(source.scannedFiles)} files · {formatCount(source.distinctSessions)}{" "}
              sessions
            </span>
          ) : (
            <span style={{ color: source.status === "error" ? "var(--danger)" : "var(--muted)" }}>
              {source.message ?? source.status}
            </span>
          )}
        </div>
      ))}
      <span style={{ fontSize: 11, color: "var(--muted)" }}>
        Scanned in {(summary.scanDurationMs / 1000).toFixed(1)}s. Managed account directories link
        their transcripts into the personal home, so each session is counted once.
      </span>
    </section>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div
      style={{
        background: "var(--panel)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--muted)" }}>{label}</span>
      <span style={{ fontSize: 18, fontFamily: "var(--font-mono)" }}>{value}</span>
      <span style={{ fontSize: 11, color: "var(--muted)" }}>{detail}</span>
    </div>
  );
}

function SegmentedControl({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: "inline-flex",
        border: "1px solid var(--rule)",
        borderRadius: "var(--radius-control)",
        overflow: "hidden",
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            style={{
              border: "none",
              background: selected ? "var(--panel-3)" : "transparent",
              color: selected ? "var(--ink)" : "var(--ink-dim)",
              fontSize: 11,
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Swatch({ provider }: { provider: UsageProviderKind }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 2,
        flex: "0 0 8px",
        background: PROVIDER_COLOR[provider],
      }}
    />
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {[...PROVIDER_ORDER].reverse().map((provider) => (
        <span
          key={provider}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "var(--ink-dim)",
          }}
        >
          <Swatch provider={provider} />
          {PROVIDER_LABEL[provider]}
        </span>
      ))}
    </div>
  );
}

function UnpricedBadge() {
  return (
    <span
      title="This model is not in Codara's rate table, so its calls contribute no cost."
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: "var(--radius-control)",
        border: "1px solid var(--rule)",
        color: "var(--muted)",
      }}
    >
      unpriced
    </span>
  );
}
