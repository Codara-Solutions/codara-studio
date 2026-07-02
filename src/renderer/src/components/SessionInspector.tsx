import React, { useEffect, useMemo, useState } from "react";
import type { RunState, SparkCall, SparkEvent } from "@shared/types";

// A renderer-only diagnostic overlay over the active run. Pure presentation —
// reads the same `RunState` ChatPanel sees, plus the orchestration event log
// it can fetch over IPC. No mutation, no main-process changes. Triggered by
// the global `session.openInspector` shortcut (Mod+Shift+I) and dismissed
// with Escape or the close button.
//
// Tab roster (one big bet, one small surface each):
//   - Costs           — per-step + total cost rollup, if the run records
//                       any cost data on its SparkCall log. Otherwise the
//                       "enable cost tracking" placeholder, because the
//                       OpenRouter cost-tracking big bet (G) hasn't shipped.
//   - Events log      — raw JSONL view of the run's event stream. Each row
//                       collapses by default; click to expand and read the
//                       JSON body.
//   - Context window  — approximate token usage from SparkCall records,
//                       else a placeholder.
//   - Tool failures   — filtered event log: anything whose type contains
//                       "fail", "error", or "blocked".

type InspectorTab = "costs" | "events" | "context" | "failures";

const TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: "costs", label: "Costs" },
  { id: "events", label: "Events log" },
  { id: "context", label: "Context window" },
  { id: "failures", label: "Tool failures" },
];

interface SessionInspectorProps {
  run: RunState | null;
  onClose: () => void;
}

export default function SessionInspector({ run, onClose }: SessionInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("costs");
  const [events, setEvents] = useState<SparkEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  // Esc closes — mirrors SettingsDialog's keyboard handling. Capture is fine
  // here; useGlobalShortcuts itself is also capture-phase but uses stop-
  // ImmediatePropagation only when a binding fires, so Esc still reaches us.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pull the event log over IPC. Run-state itself doesn't carry events —
  // they live in the run's events.jsonl artifact, read by main and returned
  // through `orchestration:listEvents`. We refetch when the active run
  // changes or the user re-opens the inspector after closing it.
  useEffect(() => {
    if (!run) {
      setEvents([]);
      setEventsError(null);
      return;
    }
    let cancelled = false;
    setEventsLoading(true);
    setEventsError(null);
    void window.spark.orchestration
      .listEvents(run.id)
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEventsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run?.id]);

  return (
    <div
      role="presentation"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-sans)",
        animation: "spark-fade-in var(--motion-fast) var(--ease-out)",
      }}
      onMouseDown={onClose}
    >
      {/* Scrim is a SIBLING of the dialog, never a filtered wrapper: a
          backdrop-filtered ancestor would form a backdrop root and the
          dialog's own glass would sample only the scrim's flat tint. */}
      <div className="spark-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Session inspector"
        className="spark-glass--strong"
        style={{
          zIndex: 1,
          width: "min(880px, calc(100vw - 44px))",
          height: "min(720px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          borderRadius: 12,
          overflow: "hidden",
          padding: 0,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Header
          run={run}
          activeTab={activeTab}
          onTabSelect={setActiveTab}
          onClose={onClose}
        />

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: "var(--panel)",
          }}
        >
          {run === null ? (
            <EmptyState message="No active run. Pick a chat in the Cora tab to inspect it." />
          ) : activeTab === "costs" ? (
            <CostsTab run={run} />
          ) : activeTab === "events" ? (
            <EventsTab
              events={events}
              loading={eventsLoading}
              error={eventsError}
              filter={null}
            />
          ) : activeTab === "context" ? (
            <ContextWindowTab run={run} />
          ) : (
            <EventsTab
              events={events}
              loading={eventsLoading}
              error={eventsError}
              filter="failures"
            />
          )}
        </div>
      </section>
    </div>
  );
}

// ── Header (title + tabs + close) ───────────────────────────────────────────

function Header({
  run,
  activeTab,
  onTabSelect,
  onClose,
}: {
  run: RunState | null;
  activeTab: InspectorTab;
  onTabSelect: (tab: InspectorTab) => void;
  onClose: () => void;
}) {
  return (
    <header
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--rule-soft)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "13px 18px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: "var(--accent)",
            boxShadow: "0 0 9px var(--accent-glow)",
          }}
        />
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          Session Inspector
        </div>
        {run ? (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
              marginLeft: 4,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={run.title}
          >
            {run.title}
          </div>
        ) : null}
        <div style={{ flex: 1 }} />
        <CloseButton onClick={onClose} />
      </div>
      <nav
        style={{
          display: "flex",
          gap: 2,
          padding: "0 12px",
          borderTop: "1px solid var(--rule-soft)",
          background: "color-mix(in oklch, var(--bg) 60%, var(--panel))",
        }}
      >
        {TABS.map((tab) => (
          <TabButton
            key={tab.id}
            label={tab.label}
            active={activeTab === tab.id}
            onClick={() => onTabSelect(tab.id)}
          />
        ))}
      </nav>
    </header>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        background: "transparent",
        border: "none",
        borderBottom: active
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        color: active ? "var(--ink)" : hover ? "var(--ink-dim)" : "var(--muted)",
        padding: "10px 12px",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        letterSpacing: "0.02em",
        cursor: "default",
        transition:
          "color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label="Close inspector"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        borderRadius: 6,
        border: "1px solid transparent",
        background: hover ? "var(--hover)" : "transparent",
        color: hover ? "var(--ink)" : "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 14,
        lineHeight: 1,
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      ×
    </button>
  );
}

// ── Costs tab ───────────────────────────────────────────────────────────────

// Cost-related fields the run-store might surface on its SparkCall log once
// the OpenRouter cost-tracking big bet lands. None of these exist yet at the
// time the inspector lands; we detect their absence to swap in the
// "enable cost tracking in Settings" placeholder.
type CostBearingCall = SparkCall & {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
};

function hasCostData(call: SparkCall): boolean {
  const c = call as CostBearingCall;
  return (
    typeof c.costUsd === "number" ||
    typeof c.inputTokens === "number" ||
    typeof c.outputTokens === "number" ||
    typeof c.cacheReadTokens === "number"
  );
}

function CostsTab({ run }: { run: RunState }) {
  const callsWithCost = useMemo(
    () => run.sparkCalls.filter(hasCostData),
    [run.sparkCalls],
  );

  if (callsWithCost.length === 0) {
    return (
      <Placeholder
        title="No cost data"
        detail={
          "Cost tracking isn't recording USD or input/output token splits for this run yet. " +
          "Enable cost tracking in Settings once the OpenRouter-cost big bet ships."
        }
      />
    );
  }

  // Per-step rollup. Each SparkCall is per-run rather than per-step, but the
  // mode tag tells us which decision the call belonged to. Group by mode for
  // a per-decision rollup; total at the bottom.
  type Bucket = {
    mode: SparkCall["mode"];
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    callCount: number;
  };

  const byMode = new Map<SparkCall["mode"], Bucket>();
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;

  for (const call of callsWithCost) {
    const c = call as CostBearingCall;
    const bucket = byMode.get(call.mode) ?? {
      mode: call.mode,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      callCount: 0,
    };
    bucket.totalCostUsd += c.costUsd ?? 0;
    bucket.totalInputTokens += c.inputTokens ?? 0;
    bucket.totalOutputTokens += c.outputTokens ?? 0;
    bucket.totalCacheReadTokens += c.cacheReadTokens ?? 0;
    bucket.callCount += 1;
    byMode.set(call.mode, bucket);

    totalCostUsd += c.costUsd ?? 0;
    totalInputTokens += c.inputTokens ?? 0;
    totalOutputTokens += c.outputTokens ?? 0;
    totalCacheReadTokens += c.cacheReadTokens ?? 0;
  }

  const rows = Array.from(byMode.values()).sort((a, b) =>
    b.totalCostUsd === a.totalCostUsd
      ? a.mode.localeCompare(b.mode)
      : b.totalCostUsd - a.totalCostUsd,
  );

  return (
    <div style={{ padding: "16px 20px 20px", overflow: "auto", flex: 1 }}>
      <SectionTitle
        title="Cost by manager mode"
        detail="USD plus input / output / cache-read tokens, rolled up per SparkCall mode."
      />
      <div
        role="table"
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 0.7fr 0.7fr 0.7fr 0.7fr 0.5fr",
          gap: "0 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--ink-dim)",
          background: "color-mix(in oklch, var(--ink) 2%, transparent)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 8,
          boxShadow: "var(--well)",
          overflow: "hidden",
        }}
      >
        <HeaderCell>Mode</HeaderCell>
        <HeaderCell align="right">Cost (USD)</HeaderCell>
        <HeaderCell align="right">Input</HeaderCell>
        <HeaderCell align="right">Output</HeaderCell>
        <HeaderCell align="right">Cache read</HeaderCell>
        <HeaderCell align="right">Calls</HeaderCell>

        {rows.map((row) => (
          <React.Fragment key={row.mode}>
            <BodyCell>{row.mode}</BodyCell>
            <BodyCell align="right">{formatUsd(row.totalCostUsd)}</BodyCell>
            <BodyCell align="right">{formatInt(row.totalInputTokens)}</BodyCell>
            <BodyCell align="right">{formatInt(row.totalOutputTokens)}</BodyCell>
            <BodyCell align="right">{formatInt(row.totalCacheReadTokens)}</BodyCell>
            <BodyCell align="right">{row.callCount}</BodyCell>
          </React.Fragment>
        ))}

        <BodyCell strong>Total</BodyCell>
        <BodyCell align="right" strong>
          {formatUsd(totalCostUsd)}
        </BodyCell>
        <BodyCell align="right" strong>
          {formatInt(totalInputTokens)}
        </BodyCell>
        <BodyCell align="right" strong>
          {formatInt(totalOutputTokens)}
        </BodyCell>
        <BodyCell align="right" strong>
          {formatInt(totalCacheReadTokens)}
        </BodyCell>
        <BodyCell align="right" strong>
          {callsWithCost.length}
        </BodyCell>
      </div>
    </div>
  );
}

function HeaderCell({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div
      role="columnheader"
      style={{
        padding: "10px 12px",
        textAlign: align ?? "left",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: "var(--muted)",
        background: "color-mix(in oklch, var(--ink) 3%, transparent)",
        borderBottom: "1px solid var(--rule-soft)",
        fontSize: 10,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function BodyCell({
  children,
  align,
  strong,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  strong?: boolean;
}) {
  return (
    <div
      role="cell"
      style={{
        padding: "8px 12px",
        textAlign: align ?? "left",
        color: strong ? "var(--ink)" : "var(--ink-dim)",
        fontWeight: strong ? 600 : 400,
        fontVariantNumeric: align === "right" ? "tabular-nums" : undefined,
        borderTop: strong ? "1px solid var(--rule)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  // Six decimals for sub-cent precision — runs with cheap models can rack
  // up many calls whose individual cost is fractions of a cent. Strip
  // trailing zeros once we're past cents.
  const fixed = value.toFixed(6);
  const trimmed = fixed.replace(/(\.\d{2})0+$/, "$1");
  return `$${trimmed}`;
}

function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

// ── Events tab ──────────────────────────────────────────────────────────────

function EventsTab({
  events,
  loading,
  error,
  filter,
}: {
  events: SparkEvent[];
  loading: boolean;
  error: string | null;
  filter: "failures" | null;
}) {
  const rows = useMemo(() => {
    if (filter !== "failures") return events;
    return events.filter(isFailureEvent);
  }, [events, filter]);

  if (loading) {
    return <Placeholder title="Loading events" detail="Reading the run's events.jsonl…" />;
  }
  if (error) {
    return (
      <Placeholder
        title="Couldn't load events"
        detail={error}
        tone="danger"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Placeholder
        title={filter === "failures" ? "No tool failures" : "No events yet"}
        detail={
          filter === "failures"
            ? "Nothing in this run has recorded a failure or error event."
            : "Events appear here as the orchestrator runs."
        }
      />
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "12px 16px 16px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          marginBottom: 10,
          letterSpacing: "0.02em",
          display: "flex",
          alignItems: "baseline",
          gap: 6,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--ink-dim)",
          }}
        >
          {rows.length.toLocaleString()}
        </span>
        <span>
          {filter === "failures" ? "failure" : "event"}
          {rows.length === 1 ? "" : "s"} · click a row to expand
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        {rows.map((event) => (
          <EventRow key={event.id} event={event} highlight={filter === "failures"} />
        ))}
      </div>
    </div>
  );
}

function isFailureEvent(event: SparkEvent): boolean {
  const type = (event.type ?? "").toLowerCase();
  if (
    type.includes("fail") ||
    type.includes("error") ||
    type.includes("blocked")
  ) {
    return true;
  }
  // SparkCall whose status is failed.
  const payload = event.payload;
  if (payload && typeof payload === "object") {
    const status = (payload as { status?: unknown }).status;
    if (typeof status === "string") {
      const lower = status.toLowerCase();
      if (lower === "failed" || lower === "blocked" || lower === "error") {
        return true;
      }
    }
    if ((payload as { error?: unknown }).error) return true;
  }
  return false;
}

function EventRow({ event, highlight }: { event: SparkEvent; highlight: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);

  const json = useMemo(() => {
    // Stringify only when expanded — the run's event list can be in the
    // thousands and most rows never get expanded.
    if (!expanded) return null;
    try {
      return JSON.stringify(event, null, 2);
    } catch {
      return "<unserializable event>";
    }
  }, [event, expanded]);

  const tone = highlight ? "danger" : "default";

  return (
    <div
      style={{
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        overflow: "hidden",
        background:
          tone === "danger"
            ? "color-mix(in oklch, var(--danger) 6%, transparent)"
            : hover
              ? "color-mix(in oklch, var(--ink) 3%, transparent)"
              : "transparent",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: "6px 10px",
          color: "var(--ink-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          display: "grid",
          gridTemplateColumns: "16px 168px 1fr",
          gap: 10,
          alignItems: "center",
          cursor: "default",
        }}
      >
        <span
          aria-hidden
          style={{
            color: tone === "danger" ? "var(--danger)" : "var(--muted)",
            transition: "transform var(--motion-fast) var(--ease-out)",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            display: "inline-block",
          }}
        >
          ▸
        </span>
        <span style={{ color: "var(--muted)" }}>{formatTimestamp(event.timestamp)}</span>
        <span
          style={{
            color: tone === "danger" ? "var(--danger)" : "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {event.type}
          {event.message ? (
            <span style={{ color: "var(--muted)" }}> — {event.message}</span>
          ) : null}
        </span>
      </button>
      {expanded && json !== null ? (
        <pre
          style={{
            margin: 0,
            padding: "0 12px 10px 36px",
            color: "var(--ink-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "color-mix(in oklch, var(--ink) 2%, transparent)",
            borderTop: "1px solid var(--rule-soft)",
            paddingTop: 8,
          }}
        >
          {json}
        </pre>
      ) : null}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  // Best-effort short timestamp — keep the date implicit but give enough
  // precision (HH:MM:SS.mmm) for events that fire in quick succession.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const mmm = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${mmm}`;
  } catch {
    return iso;
  }
}

// ── Context window tab ──────────────────────────────────────────────────────

function ContextWindowTab({ run }: { run: RunState }) {
  // SparkCall records carry promptTokenEstimate + contextWindowTokens (max
  // for the model). Use the latest call we know about as "current usage".
  // Sort by createdAt — listEvents would also work, but spark calls are
  // already on the run state.
  const calls = useMemo(
    () =>
      run.sparkCalls
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [run.sparkCalls],
  );

  const latest = calls.find(
    (call) =>
      typeof call.promptTokenEstimate === "number" ||
      typeof call.contextWindowTokens === "number",
  );

  if (!latest) {
    return (
      <Placeholder
        title="No context window data"
        detail="Token estimates are recorded once the manager makes its first call."
      />
    );
  }

  const used = latest.promptTokenEstimate ?? 0;
  const total = latest.contextWindowTokens ?? 0;
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const pct = total > 0 ? (used / total) * 100 : 0;

  // Bar tone bands: green under 60% used, amber 60–85%, red over 85%.
  const tone =
    total === 0 ? "muted" : ratio >= 0.85 ? "danger" : ratio >= 0.6 ? "warn" : "ok";
  const barColor =
    tone === "danger"
      ? "var(--danger)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "ok"
          ? "var(--ok)"
          : "var(--muted)";

  return (
    <div style={{ padding: "16px 20px 20px", overflow: "auto", flex: 1 }}>
      <SectionTitle
        title="Approximate context usage"
        detail={
          latest.contextWindowSource === "default"
            ? "Latest manager call. Window size is the per-model default — actual capacity may differ."
            : "Latest manager call's prompt-token estimate against the model's known context window."
        }
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--ink-dim)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span
            style={{
              color: "var(--ink)",
              fontSize: 24,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.01em",
            }}
          >
            {formatInt(used)}
          </span>
          <span
            style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}
          >
            of {total > 0 ? formatInt(total) : "—"} tokens
            {total > 0 ? ` (${pct.toFixed(1)}%)` : ""}
          </span>
        </div>
        <div
          aria-label="Context window usage"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total || 100}
          aria-valuenow={used}
          style={{
            width: "100%",
            height: 8,
            borderRadius: 999,
            background: "color-mix(in oklch, var(--ink) 6%, transparent)",
            boxShadow: "var(--well)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: barColor,
              boxShadow: "var(--lift-hi)",
              transition:
                "width var(--motion) var(--ease-out), background var(--motion-fast) var(--ease-out)",
            }}
          />
        </div>
        <div
          aria-hidden
          style={{
            height: 1,
            background: "var(--rule-soft)",
            margin: "2px 0",
          }}
        />
        <Detail label="Mode" value={latest.mode} />
        <Detail label="Model" value={latest.model} />
        <Detail
          label="Window source"
          value={latest.contextWindowSource ?? "unknown"}
        />
        <Detail label="Call id" value={latest.id} mono />
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  const empty = value === null || value === undefined || value === "";
  const display = empty ? "—" : String(value);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 12,
        fontSize: 11,
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        title={empty ? undefined : display}
        style={{
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          color: empty ? "var(--muted-2)" : "var(--ink-dim)",
          fontVariantNumeric: mono ? "tabular-nums" : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {display}
      </span>
    </div>
  );
}

// ── Shared primitives ───────────────────────────────────────────────────────

function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink)",
        }}
      >
        {title}
      </div>
      {detail ? (
        <div
          style={{
            marginTop: 4,
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function Placeholder({
  title,
  detail,
  tone,
}: {
  title: string;
  detail: string;
  tone?: "danger";
}) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <div
        style={{
          maxWidth: 420,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: tone === "danger" ? "var(--danger)" : "var(--muted-2)",
          }}
        >
          {tone === "danger" ? "Error" : "No data"}
        </div>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            color: tone === "danger" ? "var(--danger)" : "var(--ink)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {detail}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <Placeholder title="Nothing to inspect" detail={message} />;
}
