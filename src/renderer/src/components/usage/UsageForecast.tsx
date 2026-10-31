// The usage forecast's card in the Usage tab: the chart, the weekly pattern,
// the back-test and the idea toggles. The title bar and its panel draw the
// forecast themselves (usage-glance.ts, UsagePanel.tsx).
// The numbers come from the main process (src/main/usage-forecast.ts); this
// file only draws them.

import React, { useMemo, useState } from "react";
import {
  DEFAULT_FORECAST_IDEAS,
  formatClock,
  normalizeForecastIdeas,
  type BacktestTrack,
  type ForecastIdeas,
  type ForecastPattern,
  type ForecastTone,
  type UsageForecastReport,
  type WindowForecastView,
} from "@shared/usage-forecast";
import { confidenceLine, correctionWords } from "@shared/usage-forecast-learning";
import { usePreferences } from "../../preferences/usePreferences";
import { loadUsageForecast } from "./useUsageForecast";

export const TONE_COLOR: Record<ForecastTone, string> = {
  danger: "var(--danger)",
  warn: "var(--warn)",
  ok: "var(--ink-dim)",
  calm: "var(--ok)",
};

const PROVIDER_NAME = { anthropic: "Claude", "openai-codex": "Codex" } as const;

/* ── Chart ───────────────────────────────────────────────────────────────── */

const CHART_W = 720;
const CHART_H = 230;
const PAD = { left: 38, right: 14, top: 18, bottom: 26 };

// Steps by calendar fields, not fixed milliseconds, so a daylight-saving
// change inside a 7-day window does not label two ticks with the same day.
function timeTicks(fromMs: number, toMs: number): Array<{ ms: number; label: string }> {
  const span = toMs - fromMs;
  const hour = 3_600_000;
  const stepHours = span <= 6 * hour ? 1 : span <= 2 * 86_400_000 ? 6 : 24;
  const date = new Date(fromMs);
  if (stepHours === 24) date.setHours(0, 0, 0, 0);
  else date.setHours(Math.floor(date.getHours() / stepHours) * stepHours, 0, 0, 0);
  const ticks: Array<{ ms: number; label: string }> = [];
  for (; date.getTime() <= toMs; stepHours === 24 ? date.setDate(date.getDate() + 1) : date.setHours(date.getHours() + stepHours)) {
    if (date.getTime() < fromMs) continue;
    ticks.push({
      ms: date.getTime(),
      label:
        stepHours === 24
          ? date.toLocaleDateString("en-GB", { weekday: "short" })
          : `${String(date.getHours()).padStart(2, "0")}:00`,
    });
  }
  return ticks;
}

export function ForecastChart({ view }: { view: WindowForecastView }) {
  const { result } = view;
  const length = result.resetsAtMs - result.windowStartMs;
  const domainEnd = result.resetsAtMs + length * 0.07;
  const x = (ms: number) => PAD.left + ((ms - result.windowStartMs) / (domainEnd - result.windowStartMs)) * (CHART_W - PAD.left - PAD.right);
  const y = (pct: number) => PAD.top + (1 - Math.min(100, Math.max(0, pct)) / 100) * (CHART_H - PAD.top - PAD.bottom);
  const tone = TONE_COLOR[view.verdict.tone];
  const observed = result.observed.map(([ms, pct]) => `${x(ms).toFixed(1)},${y(pct).toFixed(1)}`).join(" ");
  const observedArea = `${x(result.windowStartMs)},${y(0)} ${observed} ${x(result.nowMs)},${y(0)}`;
  const upper = result.cone.map((point) => `${x(point.ms).toFixed(1)},${y(point.p90).toFixed(1)}`);
  const lower = result.cone.map((point) => `${x(point.ms).toFixed(1)},${y(point.p10).toFixed(1)}`).reverse();
  const median = result.cone.map((point) => `${x(point.ms).toFixed(1)},${y(point.p50).toFixed(1)}`).join(" ");
  const hit = result.inUse && result.hitProbability >= 0.5 ? result.hitAt : null;
  const ticks = timeTicks(result.windowStartMs, result.resetsAtMs);
  const nowX = x(result.nowMs);
  const resetX = x(result.resetsAtMs);
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      role="img"
      aria-label={`${view.accountLabel} ${view.windowLabel}: ${view.verdict.headline}`}
      className="usage-forecast-chart"
      style={{ display: "block", overflow: "visible" }}
    >
      {[0, 25, 50, 75].map((pct) => (
        <g key={pct}>
          <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(pct)} y2={y(pct)} stroke="var(--rule-soft)" strokeWidth={1} />
          <text x={PAD.left - 6} y={y(pct) + 3} textAnchor="end" fontSize={9.5} fill="var(--muted)">
            {pct}%
          </text>
        </g>
      ))}
      <rect
        x={resetX}
        y={PAD.top}
        width={CHART_W - PAD.right - resetX}
        height={CHART_H - PAD.top - PAD.bottom}
        fill="color-mix(in oklab, var(--ink) 4%, transparent)"
      />
      <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(100)} y2={y(100)} stroke="var(--danger)" strokeWidth={1.2} strokeDasharray="5 4" />
      <text x={PAD.left - 6} y={y(100) + 3} textAnchor="end" fontSize={9.5} fill="var(--danger)">
        100%
      </text>
      <text x={PAD.left + 4} y={y(100) - 5} fontSize={9.5} fill="var(--danger)">
        Limit
      </text>
      <polygon points={observedArea} fill={`color-mix(in oklab, ${tone} 14%, transparent)`} />
      {result.inUse ? (
        <polygon points={[...upper, ...lower].join(" ")} fill="color-mix(in oklab, var(--accent) 20%, transparent)" />
      ) : null}
      <polyline points={observed} fill="none" stroke={tone} strokeWidth={2} strokeLinejoin="round" />
      <polyline points={median} fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="4 3" />
      {hit && hit.p50 !== null ? (
        <g>
          {hit.p10 !== null && hit.p90 !== null ? (
            <line x1={x(hit.p10)} x2={x(hit.p90)} y1={y(100)} y2={y(100)} stroke="var(--danger)" strokeWidth={5} strokeLinecap="round" opacity={0.35} />
          ) : null}
          <circle cx={x(hit.p50)} cy={y(100)} r={4} fill="var(--danger)" />
          <text x={x(hit.p50)} y={y(100) - 8} textAnchor="middle" fontSize={10.5} fontWeight={650} fill="var(--danger)">
            ≈ {formatClock(hit.p50, result.nowMs)}
          </text>
        </g>
      ) : null}
      <line x1={nowX} x2={nowX} y1={PAD.top} y2={CHART_H - PAD.bottom} stroke="var(--ink-dim)" strokeWidth={1} strokeDasharray="2 3" />
      <circle cx={nowX} cy={y(result.usedPercent)} r={3.5} fill={tone} stroke="var(--bg)" strokeWidth={1.5} />
      <text x={nowX + 6} y={y(result.usedPercent) + 4} fontSize={10.5} fontWeight={650} fill="var(--ink)">
        {Math.round(result.usedPercent)}% now
      </text>
      <line x1={resetX} x2={resetX} y1={PAD.top - 6} y2={CHART_H - PAD.bottom} stroke="var(--ink-dim)" strokeWidth={1.2} />
      <text x={resetX - 4} y={PAD.top - 8} textAnchor="end" fontSize={9.5} fill="var(--ink-dim)">
        Resets {formatClock(result.resetsAtMs, result.nowMs)}
      </text>
      {result.inUse && !hit ? (
        <text x={resetX - 4} y={y(result.endPercent.p50) - 6} textAnchor="end" fontSize={10} fill="var(--accent-text, var(--accent))">
          ≈ {Math.round(result.endPercent.p50)}%
        </text>
      ) : null}
      {ticks.map((tick) => (
        <text key={tick.ms} x={x(tick.ms)} y={CHART_H - 8} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
          {tick.label}
        </text>
      ))}
    </svg>
  );
}

/* ── Usage tab section ───────────────────────────────────────────────────── */

const CARD: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface)",
  background: "color-mix(in oklab, var(--panel) 55%, transparent)",
  padding: "14px 16px",
  minWidth: 0,
};

const CARD_TITLE: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--ink)" };
const CARD_HINT: React.CSSProperties = { fontSize: 11, color: "var(--muted)", marginTop: 2 };
const NOTE: React.CSSProperties = { margin: 0, fontSize: 11, color: "var(--muted)", lineHeight: 1.45 };
function viewTitle(view: WindowForecastView): string {
  return `${PROVIDER_NAME[view.provider]} · ${view.accountLabel} · ${view.windowLabel}`;
}

function defaultView(report: UsageForecastReport): WindowForecastView | null {
  const active = report.windows.filter((view) => view.active);
  const pool = active.length > 0 ? active : report.windows;
  return [...pool].sort((a, b) => b.result.hitProbability - a.result.hitProbability || b.result.endPercent.p50 - a.result.endPercent.p50)[0] ?? null;
}

export function UsageForecastSection({
  report,
  loading,
  error,
}: {
  report: UsageForecastReport | null;
  loading: boolean;
  error: string | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const view = useMemo(() => {
    if (!report) return null;
    return report.windows.find((entry) => entry.key === picked) ?? defaultView(report);
  }, [report, picked]);

  return (
    <section data-usage-forecast style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={CARD_TITLE}>Will it last until the reset?</span>
            </div>
            <div style={CARD_HINT}>
              Your past days at this time, blended with your pace right now. The band is where 8 in 10 replays end.
            </div>
          </div>
          {report && report.windows.length > 1 ? (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
              Window
              <select
                className="spark-select"
                value={view?.key ?? ""}
                onChange={(event) => setPicked(event.target.value)}
                style={{ fontSize: 11.5 }}
              >
                {report.windows.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {viewTitle(entry)}
                    {entry.active ? " (active)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {error ? <p style={{ ...NOTE, color: "var(--danger)" }}>The forecast could not be read. {error}</p> : null}
        {!report && !error ? <p style={NOTE}>{loading ? "Learning from your transcripts…" : "No forecast yet."}</p> : null}
        {report && !view ? <p style={NOTE}>No window to forecast: no account reported a limit with a reset time.</p> : null}

        {view ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="usage-forecast__dot" style={{ background: TONE_COLOR[view.verdict.tone], alignSelf: "center" }} aria-hidden />
                <span style={{ fontSize: 15, fontWeight: 650, color: view.verdict.tone === "danger" ? "var(--danger)" : "var(--ink)" }}>
                  {view.verdict.headline}
                </span>
              </div>
              {view.verdict.detail ? <span style={{ fontSize: 12, color: "var(--ink-dim)", paddingLeft: 16 }}>{view.verdict.detail}</span> : null}
              {view.learning && view.result.inUse ? (
                <span className="usage-forecast__confidence" data-confidence={view.learning.confidence} style={{ paddingLeft: 16, fontSize: 11.5 }}>
                  How sure: {confidenceLine(view.learning)}
                  {view.learning.windows > 0 ? `. From its past misses: ${correctionWords(view.learning.correction)}.` : "."}
                </span>
              ) : null}
              {view.nudge ? <span className="usage-forecast__extra is-nudge" style={{ paddingLeft: 16 }}>{view.nudge}</span> : null}
              {view.goAhead ? <span className="usage-forecast__extra" style={{ paddingLeft: 16 }}>{view.goAhead}</span> : null}
              {report?.nextAccount[view.provider] ? (
                <span className="usage-forecast__extra" style={{ paddingLeft: 16 }}>{report.nextAccount[view.provider]}</span>
              ) : null}
            </div>
            <ForecastChart view={view} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 10.5, color: "var(--muted)" }}>
              <LegendSwatch color={TONE_COLOR[view.verdict.tone]} label="Used so far" />
              <LegendSwatch color="var(--accent)" label="Most likely" dashed />
              <LegendSwatch color="color-mix(in oklab, var(--accent) 35%, transparent)" label="8 in 10 replays" block />
              <LegendSwatch color="var(--danger)" label="Limit" dashed />
              <span>
                Pace: {view.result.pace.recentPerHour.toFixed(1)}%/h now, {view.result.pace.usualPerHour.toFixed(1)}%/h usual · {view.result.analogDays} similar days replayed
              </span>
            </div>
            <p style={NOTE}>
              {view.source === "cli" ? "Codex's live read had no windows, so this uses Codex's own last reading. " : ""}
              {view.calibration.note}
              {view.calibration.method === "spend" && view.calibration.spread[1] / Math.max(0.01, view.calibration.spread[0]) > 1.5
                ? " The readings disagree, which widens the band."
                : ""}
            </p>
          </>
        ) : null}
      </div>

      {report ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
          {report.patterns.map((pattern) => (
            <WeekPattern key={pattern.provider} pattern={pattern} />
          ))}
          <BacktestCard tracks={report.backtest} />
        </div>
      ) : null}

      <IdeaControls report={report} />
    </section>
  );
}

function LegendSwatch({ color, label, dashed = false, block = false }: { color: string; label: string; dashed?: boolean; block?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <svg width={16} height={8} aria-hidden>
        {block ? (
          <rect x={0} y={0} width={16} height={8} rx={2} fill={color} />
        ) : (
          <line x1={0} x2={16} y1={4} y2={4} stroke={color} strokeWidth={2} strokeDasharray={dashed ? "4 3" : undefined} />
        )}
      </svg>
      {label}
    </span>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function WeekPattern({ pattern }: { pattern: ForecastPattern }) {
  // Rows Monday first; perHour is indexed from Sunday.
  const rows = [1, 2, 3, 4, 5, 6, 0].map((day) => pattern.perHour[day] ?? []);
  const peak = Math.max(0.0001, ...rows.flat());
  const busiest = rows
    .flatMap((row, r) => row.map((value, hour) => ({ value, r, hour })))
    .sort((a, b) => b.value - a.value)[0];
  return (
    <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={CARD_TITLE}>Your week, {PROVIDER_NAME[pattern.provider]}</div>
        <div style={CARD_HINT}>
          Average share of the {pattern.windowLabel} limit burned per hour, over {pattern.days} days.
          {busiest && busiest.value > 0
            ? ` Busiest: ${WEEKDAYS[busiest.r]} ${String(busiest.hour).padStart(2, "0")}:00, ${busiest.value.toFixed(1)}%/h.`
            : ""}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "30px repeat(24, 1fr)", gap: 2, alignItems: "center" }}>
        {rows.map((row, r) => (
          <React.Fragment key={WEEKDAYS[r]}>
            <span style={{ fontSize: 9.5, color: "var(--muted)" }}>{WEEKDAYS[r]}</span>
            {row.map((value, hour) => (
              <span
                key={hour}
                title={`${WEEKDAYS[r]} ${String(hour).padStart(2, "0")}:00 · ${value.toFixed(1)}%/h`}
                style={{
                  height: 12,
                  borderRadius: 2,
                  background:
                    value <= 0
                      ? "color-mix(in oklab, var(--ink) 5%, transparent)"
                      : `color-mix(in oklab, var(--accent) ${Math.round(18 + 82 * Math.sqrt(value / peak))}%, transparent)`,
                }}
              />
            ))}
          </React.Fragment>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} style={{ fontSize: 9, color: "var(--muted)", textAlign: "center" }}>
            {hour % 6 === 0 ? hour : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function percentWords(value: number | null): string {
  return value === null ? "–" : `${Math.round(value * 100)}%`;
}

function BacktestCard({ tracks }: { tracks: BacktestTrack[] }) {
  return (
    <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={CARD_TITLE}>How accurate is it?</div>
        <div style={CARD_HINT}>
          Replayed on your own past windows, using only what was known at the time. Then again with what it learned
          from the windows before each one.
        </div>
      </div>
      {tracks.length === 0 ? <p style={NOTE}>Not enough past windows yet.</p> : null}
      {tracks.map((track) => {
        const better = track.summary.maeModel <= track.summary.maeNaive;
        return (
          <div key={`${track.provider}-${track.windowLabel}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600 }}>
              {PROVIDER_NAME[track.provider]} {track.windowLabel} · {track.summary.windows} windows
            </span>
            <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
              Off by {track.summary.maeModel.toFixed(1)} points on average; a straight line was off by{" "}
              {track.summary.maeNaive.toFixed(1)}
              {better ? "." : ". The straight line wins here for now."}
            </span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              Band held the outcome {percentWords(track.summary.coverage)} of the time
              {track.summary.hits > 0
                ? ` · ${track.summary.hits} window${track.summary.hits === 1 ? "" : "s"} ran out, ${percentWords(track.summary.hitRecall)} of those checks called it`
                : ""}
              {track.truth === "spend" ? " · scored on spend, so this tests timing, not the % scale" : ""}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
              After learning from its misses: off by {track.learned.maeModel.toFixed(1)}, band held{" "}
              {percentWords(track.learned.coverage)} · {confidenceLine(track.learning)}
            </span>
            {track.byHistory.length > 1 ? (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {track.byHistory
                  .map(
                    (band) =>
                      `With ${band.label}: band held ${percentWords(band.coverageBefore)} → ${percentWords(band.coverageAfter)}`,
                  )
                  .join(" · ")}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const IDEA_ROWS: Array<{ key: keyof ForecastIdeas; title: string; desc: string }> = [
  { key: "burnNudge", title: "Burn nudge", desc: "\"5 agents are burning 3× your usual rate\" when a window is draining early." },
  { key: "goAhead", title: "Go ahead", desc: "Says so when plenty is left close to a reset." },
  { key: "nextAccount", title: "Next account", desc: "Which account of the same provider has the most room." },
  { key: "coraHint", title: "Cora hint", desc: "Cora reads the forecast before it dispatches several workers." },
];

function IdeaControls({ report }: { report: UsageForecastReport | null }) {
  const { preferences, setPreference } = usePreferences();
  const ideas = normalizeForecastIdeas(preferences.usageForecastIdeas ?? DEFAULT_FORECAST_IDEAS);
  const toggle = (key: keyof ForecastIdeas) => {
    void setPreference("usageForecastIdeas", { ...ideas, [key]: !ideas[key] })
      .then(() => loadUsageForecast(true))
      .catch(() => undefined);
  };
  return (
    <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={CARD_TITLE}>Extra hints</div>
        <div style={CARD_HINT}>Each idea on its own switch.</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
        {IDEA_ROWS.map((row) => (
          <label key={row.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, cursor: "default" }}>
            <input type="checkbox" checked={ideas[row.key]} onChange={() => toggle(row.key)} style={{ marginTop: 2 }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontWeight: 600 }}>{row.title}</span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>{row.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {report ? (
        <p style={NOTE}>
          {report.sources.join(" ")} {report.notes.join(" ")} Turn it off in Settings, Agents, Usage.
        </p>
      ) : null}
    </div>
  );
}
