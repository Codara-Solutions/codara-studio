import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  enumerateDays,
  makeUsageWindow,
  resolveLocalTimeZone,
  type UsageProviderKind,
  type UsageSessionRow,
  type UsageSummary,
  type UsageSummaryInput,
} from "@shared/usage-analytics";
import { ClaudeMark, CodexMark } from "../BrandMarks";
import { SparkIcon } from "../icons";
import {
  formatCount,
  formatDayRange,
  formatDayShort,
  formatPercent,
  formatShare,
  formatTokens,
  formatUsd,
  spansYears,
} from "./usage-format";
import {
  PROVIDER_ORDER,
  PROVIDER_READING_ORDER,
  buildDailyTotals,
  buildModelRows,
  buildProjectRows,
  buildProviderCards,
  busiestDay,
  intensityColumns,
  summarizeBuckets,
  type DayTotals,
  type ModelRow,
  type ProjectRow,
  type ProviderCardData,
  type SummaryTotals,
} from "./usage-derive";

// The Usage page: what the three harnesses on this machine actually spent.
// The scan lives in the main process; this file is display only.
//
// Layout, top to bottom: a row of stat cards that answer the money and volume
// questions at a glance, a daily intensity grid beside the token mix, the one
// loud element (the stacked daily chart), a card per provider with its share,
// a breakdown table (model, project, or day), the most recent sessions, and
// the sources the scan read. Everything but the chart stays in the app's quiet
// register: hairline cards, mono numerals, uppercase micro-labels.

const WINDOW_OPTIONS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1y" },
];

const LONGEST_WINDOW_DAYS = 365;

// How many trailing days the intensity grid shows at most.
const INTENSITY_DAYS = 42;
const RECENT_SESSIONS_SHOWN = 12;

const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cora: "Cora",
};

/**
 * Provider identity colours.
 *
 * All three derive from theme tokens rather than fixed hexes, so the seven
 * bundled themes (four of them light) re-tint them for free. Cora takes the
 * house accent because it is Codara's own spend; Codex keeps the `--info` blue
 * the app already assigns it (see BrandMarks); Claude is `--warn` pulled toward
 * `--danger`, which lands on Anthropic's terracotta and, being off the pure
 * amber, does not read as a warning next to the other two.
 */
const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "color-mix(in oklch, var(--warn) 75%, var(--danger))",
  codex: "var(--info)",
  cora: "var(--accent)",
};

function ProviderMark({
  provider,
  size = 12,
}: {
  provider: UsageProviderKind;
  size?: number;
}) {
  if (provider === "claude") return <ClaudeMark size={size} />;
  if (provider === "codex") return <CodexMark size={size} />;
  return <SparkIcon size={size} />;
}

/**
 * A provider's mark in its colour. The mark alone is the only thing telling
 * two rows of the same model apart (Claude Code's and Cora's), so its name
 * rides along for screen readers and as a tooltip.
 */
function ProviderBadge({
  provider,
  size = 12,
}: {
  provider: UsageProviderKind;
  size?: number;
}) {
  return (
    <span
      title={PROVIDER_LABEL[provider]}
      style={{ display: "flex", color: PROVIDER_COLOR[provider] }}
    >
      <ProviderMark provider={provider} size={size} />
      <span className="spark-sr-only">{PROVIDER_LABEL[provider]}</span>
    </span>
  );
}

type UsageMetric = "cost" | "tokens";
type UsageBreakdown = "model" | "project" | "day";

// Reopening the tab, or flipping back to a window already fetched, reuses the
// last answer inside this window instead of re-running a scan that takes
// seconds on a large history. Refresh always bypasses it.
const SUMMARY_TTL_MS = 2 * 60 * 1000;
const summaryCache = new Map<
  string,
  { fetchedAtMs: number; summary: UsageSummary }
>();

function windowKey(input: UsageSummaryInput): string {
  return `${input.sinceDay}|${input.untilDay}|${input.timeZone}`;
}

const LABEL: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const MONO: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};

const CARD: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface)",
  background: "color-mix(in oklab, var(--panel) 55%, transparent)",
  padding: "14px 16px",
  minWidth: 0,
};

const CARD_TITLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink)",
};

const CARD_HINT: React.CSSProperties = {
  fontSize: 11,
  color: "var(--muted)",
  marginTop: 2,
};

const NOTE: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "var(--muted)",
};

export default function UsagePage() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [breakdown, setBreakdown] = useState<UsageBreakdown>("model");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Bumped by Refresh to re-read the clock. Without it the range would hold the
  // `new Date()` captured when the window length last changed, and a tab left
  // open overnight would keep asking for yesterday.
  const [rangeEpoch, setRangeEpoch] = useState(0);

  const timeZone = useMemo(() => resolveLocalTimeZone(), []);
  const range = useMemo(
    () => makeUsageWindow(windowDays, new Date(), timeZone),
    [windowDays, timeZone, rangeEpoch],
  );

  // Guards against a slow earlier scan resolving after a newer one and
  // overwriting it with a stale window's numbers.
  const requestRef = useRef(0);
  const pendingForceRef = useRef(false);

  const load = useCallback(
    async (input: UsageSummaryInput, options?: { force?: boolean }) => {
      const key = windowKey(input);
      const cached = summaryCache.get(key);
      const request = (requestRef.current += 1);
      if (
        !options?.force &&
        cached &&
        Date.now() - cached.fetchedAtMs < SUMMARY_TTL_MS
      ) {
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

  const refresh = useCallback(() => {
    pendingForceRef.current = true;
    setRangeEpoch((epoch) => epoch + 1);
  }, []);

  // Every number on screen comes from `summary`, so the dates, the axis and
  // the day counts come from it too. While another window loads, the last
  // answer stays up under the dates it covers, dimmed, instead of being
  // spread across the new window's days.
  const shownSince = summary?.sinceDay ?? range.sinceDay;
  const shownUntil = summary?.untilDay ?? range.untilDay;
  const switching =
    loading &&
    summary !== null &&
    (summary.sinceDay !== range.sinceDay || summary.untilDay !== range.untilDay);

  const days = useMemo(
    () => enumerateDays(shownSince, shownUntil),
    [shownSince, shownUntil],
  );
  const buckets = summary?.buckets ?? [];

  const daily = useMemo(() => buildDailyTotals(days, buckets), [days, buckets]);
  const byDay = useMemo(
    () => new Map(daily.map((entry) => [entry.day, entry])),
    [daily],
  );

  const totals = useMemo(() => summarizeBuckets(buckets), [buckets]);
  const activeDays = daily.filter((day) => day.tokens > 0).length;
  const perActiveDay = activeDays === 0 ? 0 : totals.tokens / activeDays;

  // Each source counts its own distinct sessions, and the three transcript
  // roots are disjoint, so summing them is exact.
  const sessionCount = (summary?.sources ?? []).reduce(
    (total, source) => total + source.distinctSessions,
    0,
  );

  const modelRows = useMemo(() => buildModelRows(buckets), [buckets]);
  const projectRows = useMemo(
    () => buildProjectRows(summary?.projects ?? []),
    [summary],
  );
  const dayRows = useMemo(
    () => daily.filter((day) => day.tokens > 0).reverse(),
    [daily],
  );
  const providerCards = useMemo(
    () => buildProviderCards(buckets, summary?.sources ?? [], totals.tokens),
    [buckets, summary, totals.tokens],
  );
  const intensityDays = useMemo(() => daily.slice(-INTENSITY_DAYS), [daily]);
  const recentShown = summary?.recentSessions.slice(0, RECENT_SESSIONS_SHOWN) ?? [];

  return (
    <div
      data-usage-page
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
          padding: "22px 26px 44px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <header
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={LABEL}>Usage</span>
            <span
              data-usage-range
              aria-live="polite"
              style={{ fontSize: 11, color: "var(--muted)" }}
            >
              {formatDayRange(shownSince, shownUntil)}
              {loading
                ? " · scanning…"
                : summary
                  ? ` · scanned ${formatUpdatedAt(summary.readAt)}`
                  : ""}
              {totals.unpricedRecords > 0 ? " · some models are unpriced" : ""}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Segmented
              label="Usage window"
              options={WINDOW_OPTIONS.map((option) => ({
                value: String(option.days),
                label: option.label,
              }))}
              value={String(windowDays)}
              onChange={(value) => setWindowDays(Number(value))}
            />
            <RefreshButton onClick={refresh} busy={loading} />
          </div>
        </header>

        {error !== null && (
          <div
            role="alert"
            style={{
              border:
                "1px solid color-mix(in oklch, var(--danger) 45%, transparent)",
              borderRadius: "var(--radius-surface)",
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--ink-dim)",
            }}
          >
            Usage could not be scanned. {error}
          </div>
        )}

        {summary === null ? (
          <p
            style={{
              padding: "72px 0",
              textAlign: "center",
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            {error === null ? "Scanning transcripts…" : "Nothing to show."}
          </p>
        ) : (
          <div
            data-usage-body
            aria-busy={switching}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 18,
              opacity: switching ? 0.55 : 1,
              transition: "opacity var(--motion-fast) var(--ease-out)",
            }}
          >
            {totals.records === 0 ? (
              <EmptyWindow
                summary={summary}
                windowDays={windowDays}
                onShowLongest={() => setWindowDays(LONGEST_WINDOW_DAYS)}
              />
            ) : (
              <>
                {/* The money and volume answers, first. */}
                <section
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  <div
                    data-usage-stats
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(190px, 1fr))",
                      gap: 10,
                    }}
                  >
                    <StatCard
                      label="Est. cost"
                      value={`${formatUsd(totals.costUsd)}${totals.pricedRecords > 0 ? "*" : ""}`}
                      hint="What this usage costs at API prices."
                      icon={<CoinsGlyph />}
                      emphasis
                    />
                    <StatCard
                      label="Total tokens"
                      value={formatTokens(totals.tokens)}
                      hint="New input, cache reads, cache writes and output."
                      icon={<SparkGlyph />}
                    />
                    <StatCard
                      label="Sessions"
                      value={formatCount(sessionCount)}
                      hint="Sessions with at least one turn in this window."
                      icon={<SessionsGlyph />}
                    />
                    <StatCard
                      label="Active days"
                      value={`${activeDays} / ${days.length}`}
                      hint="Days in this window with any usage."
                      icon={<CalendarGlyph />}
                    />
                    <StatCard
                      label="Per active day"
                      value={formatTokens(perActiveDay)}
                      hint="Total tokens divided by the days with usage."
                      icon={<GaugeGlyph />}
                    />
                    <StatCard
                      label="Cache hits"
                      value={
                        totals.cacheHitShare === null
                          ? "–"
                          : formatPercent(totals.cacheHitShare)
                      }
                      hint="Share of prompt tokens read from the cache instead of sent again or written to it."
                      icon={<CacheGlyph />}
                    />
                    <StatCard
                      label="Cache saved"
                      value={formatUsd(totals.cacheSavingsUsd)}
                      hint="What cache reads saved over the input price, less the premium paid to write the cache."
                      icon={<SavedGlyph />}
                    />
                    <StatCard
                      label="Output tokens"
                      value={formatTokens(totals.outputTokens)}
                      hint="Tokens the models generated, reasoning included."
                      icon={<OutputGlyph />}
                    />
                  </div>
                  {totals.pricedRecords > 0 && (
                    <p style={NOTE}>
                      * Estimated where the transcript reported no cost, from
                      Codara&apos;s local rate table, which can drift from vendor
                      list prices. Cora reports exact costs and is used as-is.
                      Usage on a subscription is shown at what it would cost at
                      API prices, not what the plan charged.
                    </p>
                  )}
                </section>

                <section
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 0.9fr)",
                    gap: 12,
                  }}
                >
                  <IntensityGrid
                    days={intensityDays}
                    truncated={daily.length > intensityDays.length}
                  />
                  <TokenMix totals={totals} />
                </section>

                <section
                  style={{
                    ...CARD,
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={CARD_TITLE}>Daily usage</div>
                      <div style={CARD_HINT}>
                        Stacked by provider. Hover a day for the split.
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 14,
                      }}
                    >
                      <Legend />
                      <Segmented
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

                <section
                  style={{ display: "flex", flexDirection: "column", gap: 10 }}
                >
                  <div
                    style={{ display: "flex", alignItems: "baseline", gap: 10 }}
                  >
                    <span style={LABEL}>Providers</span>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>
                      {providerCards.filter((card) => card.tokens > 0).length}{" "}
                      with usage in this window
                    </span>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(260px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {providerCards.map((card) => (
                      <ProviderCard key={card.provider} card={card} />
                    ))}
                  </div>
                </section>

                <section
                  style={{
                    ...CARD,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={CARD_TITLE}>Breakdown</div>
                      <div style={CARD_HINT}>
                        {breakdown === "model"
                          ? "Every model that ran, costliest first."
                          : breakdown === "project"
                            ? "Every working directory the agents ran in, costliest first."
                            : "Each day with activity, newest first."}
                      </div>
                    </div>
                    <Segmented
                      label="Breakdown grouping"
                      options={[
                        { value: "model", label: "Model" },
                        { value: "project", label: "Project" },
                        { value: "day", label: "Day" },
                      ]}
                      value={breakdown}
                      onChange={(value) =>
                        setBreakdown(value as UsageBreakdown)
                      }
                    />
                  </div>
                  {breakdown === "model" ? (
                    <ModelTable rows={modelRows} />
                  ) : breakdown === "project" ? (
                    <ProjectTable rows={projectRows} />
                  ) : (
                    <DayTable
                      rows={dayRows}
                      withYear={spansYears(shownSince, shownUntil)}
                    />
                  )}
                </section>

                <section
                  style={{
                    ...CARD,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div>
                    <div style={CARD_TITLE}>Recent sessions</div>
                    <div style={CARD_HINT}>
                      {recentShown.length === 1
                        ? "The one session with activity in this window."
                        : `The last ${recentShown.length} sessions with activity in this window.`}
                    </div>
                  </div>
                  <SessionsTable rows={recentShown} />
                </section>
              </>
            )}

            <SourcesFooter summary={summary} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A window with no usage. A page of zeros and empty charts said the same thing
 * less clearly, and a 7-day window is often empty for someone who works in
 * bursts, so the longest window is one click away.
 */
function EmptyWindow({
  summary,
  windowDays,
  onShowLongest,
}: {
  summary: UsageSummary;
  windowDays: number;
  onShowLongest: () => void;
}) {
  const anyTranscripts = summary.sources.some(
    (source) => source.status === "ok",
  );
  return (
    <section
      data-usage-empty
      style={{
        ...CARD,
        padding: "40px 24px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        textAlign: "center",
      }}
    >
      <div style={CARD_TITLE}>
        No usage between {formatDayRange(summary.sinceDay, summary.untilDay)}
      </div>
      <div style={{ ...CARD_HINT, maxWidth: 460, lineHeight: 1.5 }}>
        {anyTranscripts
          ? "Codara reads the Claude Code, Codex and Cora transcripts on this machine, and none of them has a turn in this window."
          : "No Claude Code, Codex or Cora transcripts were found on this machine. Usage shows up here once an agent has run."}
      </div>
      {anyTranscripts && windowDays < LONGEST_WINDOW_DAYS && (
        <button
          type="button"
          className="spark-btn"
          onClick={onShowLongest}
          style={{ marginTop: 4 }}
        >
          Show the last year
        </button>
      )}
    </section>
  );
}

function formatUpdatedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSessionTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function projectLabel(project: string): string {
  if (!project) return "No directory recorded";
  const trimmed = project.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/* ── Stat cards ──────────────────────────────────────────────────────────── */

function StatCard({
  label,
  value,
  hint,
  icon,
  emphasis = false,
}: {
  label: string;
  value: string;
  /** What the number counts, for the tooltip and screen readers. */
  hint: string;
  icon: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      data-usage-stat={label}
      title={hint}
      style={{
        ...CARD,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          flex: "0 0 32px",
          borderRadius: 8,
          background: emphasis
            ? "color-mix(in oklab, var(--accent) 16%, transparent)"
            : "color-mix(in oklab, var(--ink) 6%, transparent)",
          color: emphasis ? "var(--accent)" : "var(--muted)",
        }}
      >
        {icon}
      </span>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            ...MONO,
            fontSize: emphasis ? 20 : 16,
            fontWeight: 600,
            lineHeight: 1.1,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </span>
        <span style={LABEL}>{label}</span>
        <span className="spark-sr-only">{hint}</span>
      </div>
    </div>
  );
}

const GLYPH_PROPS = {
  width: 15,
  height: 15,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function CoinsGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <ellipse cx="8" cy="4.5" rx="5" ry="2" />
      <path d="M3 4.5v3c0 1.1 2.2 2 5 2s5-.9 5-2v-3" />
      <path d="M3 7.5v3c0 1.1 2.2 2 5 2s5-.9 5-2v-3" />
    </svg>
  );
}
function SparkGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <path d="M8 2c.4 3.2 2.6 5.4 5.8 5.8v.4C10.6 8.6 8.4 10.8 8 14c-.4-3.2-2.6-5.4-5.8-5.8v-.4C5.4 7.4 7.6 5.2 8 2z" />
    </svg>
  );
}
function SessionsGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 7l2 1.5L5 10M8.5 10h3" />
    </svg>
  );
}
function CalendarGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 7h11M5.5 2v3M10.5 2v3" />
    </svg>
  );
}
function GaugeGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
      <path d="M8 11.5l2.6-3.6" />
    </svg>
  );
}
function CacheGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </svg>
  );
}
function SavedGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <path d="M8 2.5l4.5 2.2v3.6c0 2.7-1.9 4.6-4.5 5.7-2.6-1.1-4.5-3-4.5-5.7V4.7L8 2.5z" />
      <path d="M6 8l1.5 1.5L10.2 6.7" />
    </svg>
  );
}
function OutputGlyph() {
  return (
    <svg {...GLYPH_PROPS}>
      <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
    </svg>
  );
}

/* ── Intensity grid and token mix ────────────────────────────────────────── */

function intensityFor(tokens: number, peak: number): number {
  if (tokens <= 0 || peak <= 0) return 0;
  const share = tokens / peak;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

const INTENSITY_FILL: Record<number, string> = {
  0: "color-mix(in oklab, var(--ink) 5%, transparent)",
  1: "color-mix(in oklab, var(--accent) 30%, transparent)",
  2: "color-mix(in oklab, var(--accent) 52%, transparent)",
  3: "color-mix(in oklab, var(--accent) 76%, transparent)",
  4: "var(--accent)",
};

function IntensityGrid({
  days,
  truncated,
}: {
  days: DayTotals[];
  /** The window is longer than the grid, which shows its last days only. */
  truncated: boolean;
}) {
  // The peak is taken over the cells drawn, so the chip always names a cell
  // the reader can see.
  const bestDay = busiestDay(days);
  const peak = bestDay?.tokens ?? 0;
  const columns = intensityColumns(days.length);
  return (
    <section style={{ ...CARD, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={CARD_TITLE}>Daily intensity</div>
          <div style={CARD_HINT}>
            {truncated
              ? `Token activity across every provider, last ${days.length} days.`
              : "Token activity per day across every provider."}
          </div>
        </div>
        {bestDay && (
          <span
            data-usage-peak
            title={`${formatTokens(bestDay.tokens)} tokens · ${formatUsd(bestDay.costUsd)}`}
            style={{
              ...LABEL,
              padding: "3px 8px",
              borderRadius: 99,
              border: "1px solid var(--rule)",
              whiteSpace: "nowrap",
            }}
          >
            Peak {formatDayShort(bestDay.day)}
          </span>
        )}
      </div>
      <div
        role="img"
        aria-label={
          bestDay
            ? `Token activity by day, busiest ${formatDayShort(bestDay.day)} with ${formatTokens(bestDay.tokens)} tokens`
            : "Token activity by day"
        }
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: 3,
        }}
      >
        {days.map((day) => (
          <span
            key={day.day}
            title={`${formatDayShort(day.day)}: ${formatTokens(day.tokens)} tokens · ${formatUsd(day.costUsd)}`}
            style={{
              aspectRatio: "1 / 1",
              minHeight: 10,
              borderRadius: 3,
              background: INTENSITY_FILL[intensityFor(day.tokens, peak)],
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginTop: "auto",
          paddingTop: 10,
          ...MONO,
          fontSize: 9,
          color: "var(--muted)",
        }}
      >
        <span>{days[0] ? formatDayShort(days[0].day) : ""}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Less
          <span style={{ display: "inline-flex", gap: 3 }} aria-hidden>
            {[0, 1, 2, 3, 4].map((level) => (
              <span
                key={level}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: INTENSITY_FILL[level],
                }}
              />
            ))}
          </span>
          More
        </span>
        <span>
          {days.length > 0 ? formatDayShort(days[days.length - 1].day) : ""}
        </span>
      </div>
    </section>
  );
}

function TokenMix({ totals }: { totals: SummaryTotals }) {
  const segments = [
    {
      key: "input",
      label: "New input",
      value: totals.uncachedInputTokens,
      fill: "var(--ink)",
    },
    {
      key: "output",
      label: "Output",
      value: totals.outputTokens,
      fill: "var(--accent)",
    },
    {
      key: "cache-read",
      label: "Cache read",
      value: totals.cachedInputTokens,
      fill: "color-mix(in oklab, var(--ink) 45%, transparent)",
    },
    {
      key: "cache-write",
      label: "Cache write",
      value: totals.cacheCreationTokens,
      fill: "color-mix(in oklab, var(--ink) 22%, transparent)",
    },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <section style={CARD}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={CARD_TITLE}>Token mix</div>
          <div style={CARD_HINT}>
            Where the tokens went, across every provider.
          </div>
        </div>
        {totals.reasoningTokens > 0 && (
          <span
            style={{
              ...LABEL,
              padding: "3px 8px",
              borderRadius: 99,
              border: "1px solid var(--rule)",
              whiteSpace: "nowrap",
            }}
          >
            {formatTokens(totals.reasoningTokens)} reasoning
          </span>
        )}
      </div>
      <div
        role="img"
        aria-label={`Token mix: ${segments
          .map(
            (segment) =>
              `${segment.label} ${total > 0 ? formatShare(segment.value / total) : "0%"}`,
          )
          .join(", ")}`}
        style={{
          display: "flex",
          height: 10,
          borderRadius: 99,
          overflow: "hidden",
          background: "color-mix(in oklab, var(--ink) 5%, transparent)",
        }}
      >
        {total > 0 &&
          segments.map((segment) =>
            segment.value > 0 ? (
              <span
                key={segment.key}
                title={`${segment.label}: ${formatTokens(segment.value)}`}
                style={{
                  width: `${(segment.value / total) * 100}%`,
                  background: segment.fill,
                }}
              />
            ) : null,
          )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "8px 14px",
          marginTop: 12,
          fontSize: 11,
        }}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--ink-dim)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: segment.fill,
                  flex: "0 0 7px",
                }}
              />
              {segment.label}
            </span>
            <span style={{ ...MONO, color: "var(--ink-dim)" }}>
              {formatTokens(segment.value)}
              <span style={{ color: "var(--muted)", marginLeft: 6 }}>
                {total > 0 ? formatShare(segment.value / total) : "0%"}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Provider cards ──────────────────────────────────────────────────────── */

function ProviderCard({ card }: { card: ProviderCardData }) {
  const status = card.source?.status ?? "missing";
  const statusLabel =
    status === "ok"
      ? card.tokens > 0
        ? "Active"
        : "Quiet"
      : status === "error"
        ? "Error"
        : "Not found";
  const statusColor =
    status === "error"
      ? "var(--danger)"
      : status === "ok" && card.tokens > 0
        ? "var(--ok)"
        : "var(--muted-2)";
  return (
    <div
      style={{
        ...CARD,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{ display: "flex", color: PROVIDER_COLOR[card.provider] }}
        >
          <ProviderMark provider={card.provider} size={14} />
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            flex: 1,
            minWidth: 0,
          }}
        >
          {PROVIDER_LABEL[card.provider]}
        </span>
        <span
          title={card.source?.message ?? card.source?.dir ?? ""}
          style={{
            ...LABEL,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: statusColor,
            }}
          />
          {statusLabel}
        </span>
      </div>
      <div
        title={card.topModel ?? undefined}
        style={{
          ...MONO,
          fontSize: 11,
          color: "var(--muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {card.topModel ?? "No model yet"}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 8,
          fontSize: 11,
        }}
      >
        <Mini label="Tokens" value={formatTokens(card.tokens)} />
        <Mini label="Sessions" value={formatCount(card.sessions)} />
        <Mini label="Cost" value={formatUsd(card.costUsd)} />
      </div>
      <div
        role="img"
        aria-label={`${PROVIDER_LABEL[card.provider]}: ${formatShare(card.share)} of tokens`}
        title={`${formatShare(card.share)} of tokens`}
        style={{
          height: 5,
          borderRadius: 99,
          overflow: "hidden",
          background: "color-mix(in oklab, var(--ink) 6%, transparent)",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${Math.max(card.share * 100, card.tokens > 0 ? 2 : 0)}%`,
            background: PROVIDER_COLOR[card.provider],
            borderRadius: 99,
          }}
        />
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}
    >
      <span style={{ ...MONO, fontSize: 12, color: "var(--ink-dim)" }}>
        {value}
      </span>
      <span style={LABEL}>{label}</span>
    </div>
  );
}

/* ── Chart ───────────────────────────────────────────────────────────────── */

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 220;
const PLOT_HEIGHT = 208;
const TICK_COUNT = 4;
const BAR_CAP_RADIUS = 1.5;
// Above this many columns the axis shows three anchors instead of every day.
const DENSE_AXIS_THRESHOLD = 10;

/**
 * A scale whose maximum is a readable 1/2/5 x 10^n step at or above the peak.
 * Rounding UP is the point: stopping at the last step below the peak would draw
 * the tallest day past the top of the plot, where it is clipped.
 */
export function niceScale(
  peak: number,
  count: number,
): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) *
    magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step)
    ticks.push(value);
  return { max, ticks };
}

/** A bar with rounded top corners and a square base, so the stack sits flush. */
function topRoundedBar(
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const radius = Math.min(BAR_CAP_RADIUS, height, width / 2);
  if (radius <= 0) return `M${x},${y}h${width}v${height}h${-width}Z`;
  return [
    `M${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + width - radius}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `V${y + height}`,
    `H${x}`,
    "Z",
  ].join(" ");
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
  const withYear =
    days.length > 0 && spansYears(days[0], days[days.length - 1]);

  const columns = useMemo(
    () =>
      days.map((day) => {
        const entry = byDay.get(day);
        let stackTop = 0;
        const bands = PROVIDER_ORDER.map((provider) => {
          const cell = entry?.byProvider.get(provider);
          const value =
            cell === undefined
              ? 0
              : metric === "cost"
                ? cell.costUsd
                : cell.tokens;
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
  const toY = (value: number) =>
    max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * PLOT_HEIGHT;
  const format = metric === "cost" ? formatUsd : formatTokens;

  const slot = days.length === 0 ? 0 : VIEW_WIDTH / days.length;
  // A 2px gutter at 365 days is sub-pixel once scaled down, so the gap is a
  // proportion of the slot with a floor that keeps 7-day bars from touching.
  const barWidth = Math.max(1, slot - Math.max(1, slot * 0.22));

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
  const hoverLeft =
    days.length === 0 ? 0 : (((hoverIndex ?? 0) + 0.5) / days.length) * 100;
  const dense = days.length > DENSE_AXIS_THRESHOLD;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 10 }}>
        {/* Axis labels sit outside the SVG: the plot scales non-uniformly to
            the pane width, which would stretch any text inside it. */}
        <div
          style={{
            position: "relative",
            width: 46,
            height: 208,
            flex: "0 0 46px",
          }}
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              style={{
                ...MONO,
                position: "absolute",
                right: 0,
                top: `${(toY(tick) / VIEW_HEIGHT) * 100}%`,
                transform: "translateY(-50%)",
                fontSize: 9,
                color: "var(--muted)",
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
          style={{ position: "relative", height: 208, flex: 1 }}
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

            {hoverIndex !== null && (
              <rect
                x={hoverIndex * slot}
                y={0}
                width={slot}
                height={VIEW_HEIGHT}
                fill="color-mix(in oklab, var(--ink) 4%, transparent)"
              />
            )}

            {columns.map((column, index) => {
              const x = index * slot + (slot - barWidth) / 2;
              const topBand = [...column.bands]
                .reverse()
                .find((band) => band.value > 0);
              return (
                <g key={column.day}>
                  {column.bands.map((band) => {
                    if (band.value <= 0) return null;
                    const y = toY(band.top);
                    const height = Math.max(0, toY(band.base) - y);
                    return (
                      <path
                        key={band.provider}
                        className="usage-bar"
                        d={
                          band === topBand
                            ? topRoundedBar(x, y, barWidth, height)
                            : `M${x},${y}h${barWidth}v${height}h${-barWidth}Z`
                        }
                        fill={PROVIDER_COLOR[band.provider]}
                        opacity={
                          hoverIndex === null || hoverIndex === index ? 1 : 0.5
                        }
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>

          {hovered !== undefined && hovered.total > 0 && (
            <div
              className="spark-menu spark-fade-in"
              style={{
                position: "absolute",
                top: 0,
                left: `${hoverLeft}%`,
                transform:
                  hoverLeft > 60 ? "translateX(-100%)" : "translateX(0)",
                pointerEvents: "none",
                zIndex: 2,
                minWidth: 158,
                padding: "7px 9px",
                display: "grid",
                gap: 3,
                fontSize: 11,
              }}
            >
              <div style={{ ...LABEL, marginBottom: 1 }}>
                {formatDayShort(hovered.day, withYear)}
              </div>
              {[...hovered.bands].reverse().map((band) => (
                <div
                  key={band.provider}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 14,
                  }}
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
                  <span style={MONO}>{format(band.value)}</span>
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 14,
                  marginTop: 3,
                  paddingTop: 4,
                  borderTop: "1px solid var(--rule-soft)",
                }}
              >
                <span style={{ color: "var(--muted)" }}>Total</span>
                <span style={MONO}>{format(hovered.total)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        data-usage-axis
        style={{
          display: "flex",
          justifyContent: "space-between",
          paddingLeft: 56,
          ...MONO,
          fontSize: 9,
          color: "var(--muted)",
        }}
      >
        {dense
          ? [
              days[0],
              days[Math.floor(days.length / 2)],
              days[days.length - 1],
            ].map((day, index) => (
              <span key={day ?? index}>
                {day === undefined ? "" : formatDayShort(day, withYear)}
              </span>
            ))
          : days.map((day) => (
              <span key={day} style={{ flex: 1, textAlign: "center" }}>
                {formatDayShort(day)}
              </span>
            ))}
      </div>
    </div>
  );
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

// Cells never wrap: a model id or project name broken over two lines reads as
// two values. A table wider than a narrow pane scrolls inside TableScroll.
const CELL: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--rule-soft)",
  fontSize: 12,
  whiteSpace: "nowrap",
};
const NUM_CELL: React.CSSProperties = {
  ...CELL,
  ...MONO,
  textAlign: "right",
  color: "var(--ink-dim)",
};
const HEAD_CELL: React.CSSProperties = {
  ...LABEL,
  padding: "0 8px 6px",
  borderBottom: "1px solid var(--rule)",
  fontWeight: 400,
  textAlign: "left",
  whiteSpace: "nowrap",
};

const TABLE: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div data-usage-table style={{ overflowX: "auto", minWidth: 0 }}>
      {children}
    </div>
  );
}

function ModelTable({ rows }: { rows: ModelRow[] }) {
  if (rows.length === 0) return <EmptyRow />;
  return (
    <TableScroll>
      <table style={TABLE}>
        <thead>
          <tr>
            <th style={HEAD_CELL}>Model</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Input</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cache read</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cache write</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Output</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.provider}:${row.model}`} className="usage-row">
              <td style={CELL}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <ProviderBadge provider={row.provider} />
                  <span style={MONO}>{row.model}</span>
                  {row.unpriced && <UnpricedBadge />}
                </span>
              </td>
              <td style={NUM_CELL}>{formatTokens(row.uncachedInputTokens)}</td>
              <td style={NUM_CELL}>{formatTokens(row.cachedInputTokens)}</td>
              <td style={NUM_CELL}>{formatTokens(row.cacheCreationTokens)}</td>
              <td style={NUM_CELL}>{formatTokens(row.outputTokens)}</td>
              <td style={{ ...NUM_CELL, color: "var(--ink)" }}>
                {formatUsd(row.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function ProjectTable({ rows }: { rows: ProjectRow[] }) {
  if (rows.length === 0) return <EmptyRow />;
  return (
    <TableScroll>
      <table style={TABLE}>
        <thead>
          <tr>
            <th style={HEAD_CELL}>Project</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Sessions</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Turns</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Tokens</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="usage-row">
              <td style={CELL} title={row.project || undefined}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <span style={{ display: "inline-flex", gap: 3 }}>
                    {row.providers.map((provider) => (
                      <ProviderBadge key={provider} provider={provider} />
                    ))}
                  </span>
                  <span
                    style={{
                      color: row.project ? "var(--ink)" : "var(--muted)",
                    }}
                  >
                    {projectLabel(row.project)}
                  </span>
                  {row.project && (
                    <span
                      style={{
                        ...MONO,
                        fontSize: 10,
                        color: "var(--muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 320,
                      }}
                    >
                      {row.project}
                    </span>
                  )}
                </span>
              </td>
              <td style={NUM_CELL}>{formatCount(row.sessions)}</td>
              <td style={NUM_CELL}>{formatCount(row.records)}</td>
              <td style={NUM_CELL}>{formatTokens(row.tokens)}</td>
              <td style={{ ...NUM_CELL, color: "var(--ink)" }}>
                {formatUsd(row.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function DayTable({
  rows,
  withYear,
}: {
  rows: DayTotals[];
  withYear: boolean;
}) {
  if (rows.length === 0) return <EmptyRow />;
  return (
    <TableScroll>
      <table style={TABLE}>
        <thead>
          <tr>
            <th style={HEAD_CELL}>Day</th>
            {PROVIDER_READING_ORDER.map((provider) => (
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
            <tr key={row.day} className="usage-row">
              <td style={{ ...CELL, ...MONO }}>
                {formatDayShort(row.day, withYear)}
              </td>
              {PROVIDER_READING_ORDER.map((provider) => (
                <td key={provider} style={NUM_CELL}>
                  {formatUsd(row.byProvider.get(provider)?.costUsd ?? 0)}
                </td>
              ))}
              <td style={{ ...NUM_CELL, color: "var(--ink)" }}>
                {formatUsd(row.costUsd)}
              </td>
              <td style={NUM_CELL}>{formatTokens(row.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function SessionsTable({ rows }: { rows: UsageSessionRow[] }) {
  if (rows.length === 0) return <EmptyRow />;
  return (
    <TableScroll>
      <table style={TABLE}>
        <thead>
          <tr>
            <th style={HEAD_CELL}>Last active</th>
            <th style={HEAD_CELL}>Project</th>
            <th style={HEAD_CELL}>Model</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Turns</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Input</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Output</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cache</th>
            <th style={{ ...HEAD_CELL, textAlign: "right" }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.provider}:${row.sessionId}`} className="usage-row">
              <td style={{ ...CELL, ...MONO, color: "var(--muted)" }}>
                {formatSessionTime(row.lastMs)}
              </td>
              <td style={CELL} title={row.project || row.sessionId}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <ProviderBadge provider={row.provider} />
                  <span
                    style={{
                      color: row.project ? "var(--ink)" : "var(--muted)",
                    }}
                  >
                    {projectLabel(row.project)}
                  </span>
                </span>
              </td>
              <td style={{ ...CELL, ...MONO, color: "var(--ink-dim)" }}>
                {row.model || "Unknown"}
              </td>
              <td style={NUM_CELL}>{formatCount(row.records)}</td>
              <td style={NUM_CELL}>
                {formatTokens(row.totals.uncachedInputTokens)}
              </td>
              <td style={NUM_CELL}>{formatTokens(row.totals.outputTokens)}</td>
              <td style={NUM_CELL}>
                {formatTokens(
                  row.totals.cachedInputTokens + row.totals.cacheCreationTokens,
                )}
              </td>
              <td style={{ ...NUM_CELL, color: "var(--ink)" }}>
                {formatUsd(row.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function EmptyRow() {
  return (
    <p
      style={{
        padding: "28px 0",
        textAlign: "center",
        fontSize: 12,
        color: "var(--muted)",
      }}
    >
      No usage in this window.
    </p>
  );
}

/* ── Sources ─────────────────────────────────────────────────────────────── */

const SOURCE_DOT: Record<string, string> = {
  ok: "var(--ok)",
  missing: "var(--muted-2)",
  error: "var(--danger)",
};

function SourcesFooter({ summary }: { summary: UsageSummary }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <span style={LABEL}>Sources</span>
      {summary.sources.map((source) => (
        <div
          key={source.provider}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            ...MONO,
            fontSize: 10,
            color: "var(--muted)",
          }}
        >
          <span
            aria-hidden
            title={source.status}
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              flex: "0 0 5px",
              background: SOURCE_DOT[source.status] ?? "var(--muted-2)",
            }}
          />
          <span style={{ color: "var(--ink-dim)", minWidth: 78 }}>
            {PROVIDER_LABEL[source.provider]}
          </span>
          <span>{source.dir || "—"}</span>
          {source.status === "ok" ? (
            <span>
              {formatCount(source.scannedFiles)}{" "}
              {source.scannedFiles === 1 ? "file" : "files"} ·{" "}
              {formatCount(source.distinctSessions)}{" "}
              {source.distinctSessions === 1 ? "session" : "sessions"}
            </span>
          ) : (
            <span
              style={{
                color:
                  source.status === "error" ? "var(--danger)" : "var(--muted)",
              }}
            >
              {source.message ?? source.status}
            </span>
          )}
        </div>
      ))}
      <span style={{ ...MONO, fontSize: 10, color: "var(--muted)" }}>
        Scanned in {(summary.scanDurationMs / 1000).toFixed(1)}s · managed
        accounts link their transcripts into the personal home, so each session
        is counted once · Grok sessions are not counted: their transcripts
        record no token usage
      </span>
    </section>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────────── */

function Segmented({
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
        alignItems: "center",
        gap: 2,
        padding: 2,
        borderRadius: 99,
        border: "1px solid var(--rule)",
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
              appearance: "none",
              border: "none",
              borderRadius: 99,
              padding: "3px 10px",
              background: selected
                ? "color-mix(in oklab, var(--ink) 9%, transparent)"
                : "transparent",
              color: selected ? "var(--ink)" : "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              cursor: "default",
              transition:
                "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function RefreshButton({
  onClick,
  busy,
}: {
  onClick: () => void;
  busy: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={busy ? "Scanning transcripts…" : "Rescan transcripts"}
      aria-label="Rescan transcripts"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        padding: 0,
        border: "none",
        borderRadius: 99,
        background: hover && !busy ? "var(--hover)" : "transparent",
        color: busy ? "var(--muted-2)" : hover ? "var(--ink)" : "var(--muted)",
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={
          busy ? { animation: "spark-spin 1s linear infinite" } : undefined
        }
      >
        <path d="M12 7a5 5 0 1 1-1.6-3.66" />
        <path d="M12.2 1.9v2.6H9.6" />
      </svg>
    </button>
  );
}

function Swatch({ provider }: { provider: UsageProviderKind }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: 2,
        flex: "0 0 7px",
        background: PROVIDER_COLOR[provider],
      }}
    />
  );
}

function Legend() {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "4px 14px",
      }}
    >
      {PROVIDER_READING_ORDER.map((provider) => (
        <span
          key={provider}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "var(--ink-dim)",
            whiteSpace: "nowrap",
          }}
        >
          <span
            aria-hidden
            style={{ display: "flex", color: PROVIDER_COLOR[provider] }}
          >
            <ProviderMark provider={provider} size={11} />
          </span>
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
        ...LABEL,
        fontSize: 9,
        padding: "1px 5px",
        borderRadius: 99,
        border: "1px solid color-mix(in oklch, var(--warn) 40%, transparent)",
        color: "var(--warn)",
      }}
    >
      unpriced
    </span>
  );
}
