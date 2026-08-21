import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SystemResourceSnapshot } from "@shared/types";

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

type MetricKind = "cpu" | "gpu" | "ram";

interface HistoryPoint {
  cpu: number;
  gpu: number | null;
  ram: number;
}

const POLL_INTERVAL_MS = 2_500;
const HISTORY_LENGTH = 28;

const METRICS: ReadonlyArray<{
  kind: MetricKind;
  label: string;
  color: string;
}> = [
  { kind: "cpu", label: "CPU", color: "var(--accent)" },
  {
    kind: "gpu",
    label: "GPU",
    color: "color-mix(in oklch, var(--accent) 55%, #b38cff)",
  },
  {
    kind: "ram",
    label: "RAM",
    color: "color-mix(in oklch, var(--accent) 28%, #e9a85f)",
  },
];

function valueFor(
  snapshot: SystemResourceSnapshot,
  kind: MetricKind,
): number | null {
  if (kind === "cpu") return snapshot.cpuPercent;
  if (kind === "gpu") return snapshot.gpuPercent;
  return snapshot.ramPercent;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

function MiniRing({ value, color }: { value: number | null; color: string }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const progress = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="color-mix(in oklab, var(--ink) 13%, transparent)"
        strokeWidth="1.7"
      />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke={value === null ? "var(--muted)" : color}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress / 100)}
        transform="rotate(-90 7 7)"
        style={{ transition: "stroke-dashoffset 420ms var(--ease-out)" }}
      />
      <circle cx="7" cy="7" r="1" fill={value === null ? "var(--muted)" : color} />
    </svg>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span className="system-meter-sparkline" />;
  const width = 72;
  const height = 22;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (Math.min(100, Math.max(0, value)) / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="system-meter-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MetricRow({
  metric,
  snapshot,
  history,
}: {
  metric: (typeof METRICS)[number];
  snapshot: SystemResourceSnapshot;
  history: HistoryPoint[];
}) {
  const value = valueFor(snapshot, metric.kind);
  const values = history
    .map((point) => point[metric.kind])
    .filter((entry): entry is number => entry !== null);
  const detail =
    metric.kind === "cpu"
      ? `${snapshot.cpuLogicalCores} logical cores`
      : metric.kind === "ram"
        ? `${formatBytes(snapshot.ramUsedBytes)} of ${formatBytes(snapshot.ramTotalBytes)}`
        : value === null
          ? "GPU activity is unavailable on this machine"
          : "Busiest graphics engine";
  return (
    <div className="system-meter-popover-row">
      <div className="system-meter-popover-heading">
        <span className="system-meter-popover-mark" style={{ color: metric.color }}>
          <MiniRing value={value} color={metric.color} />
        </span>
        <span className="system-meter-popover-label">{metric.label}</span>
        <span className="system-meter-popover-value" style={{ color: metric.color }}>
          {value === null ? "—" : `${Math.round(value)}%`}
        </span>
      </div>
      <div className="system-meter-popover-graph">
        <div className="system-meter-popover-track">
          <span
            style={{
              width: `${value ?? 0}%`,
              background: metric.color,
            }}
          />
        </div>
        <Sparkline values={values} color={metric.color} />
      </div>
      <span className="system-meter-popover-detail">{detail}</span>
    </div>
  );
}

function SystemPopover({
  anchor,
  snapshot,
  history,
}: {
  anchor: DOMRect;
  snapshot: SystemResourceSnapshot;
  history: HistoryPoint[];
}) {
  const width = 292;
  const left = Math.min(
    Math.max(8, anchor.right - width),
    Math.max(8, window.innerWidth - width - 8),
  );
  return (
    <div
      className="spark-menu spark-fade-in system-meter-popover"
      role="dialog"
      aria-label="System activity"
      style={
        {
          position: "fixed",
          top: anchor.bottom + 6,
          left,
          width,
          zIndex: 1300,
          WebkitAppRegion: "no-drag",
        } as AppRegionStyle
      }
    >
      <div className="system-meter-popover-title">
        <span className="system-meter-live-dot" />
        <span>System activity</span>
        <span className="system-meter-live-label">LIVE</span>
      </div>
      <div className="system-meter-popover-rows">
        {METRICS.map((metric) => (
          <MetricRow
            key={metric.kind}
            metric={metric}
            snapshot={snapshot}
            history={history}
          />
        ))}
      </div>
      <span className="system-meter-popover-footnote">
        Whole-machine usage · refreshes while Codara is visible
      </span>
    </div>
  );
}

export default function SystemMeters() {
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    void window.spark.system
      .resourceSnapshot()
      .then((next) => {
        setSnapshot(next);
        setHistory((current) => [
          ...current.slice(-(HISTORY_LENGTH - 1)),
          { cpu: next.cpuPercent, gpu: next.gpuPercent, ram: next.ramPercent },
        ]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  const title = snapshot
    ? METRICS.map((metric) => {
        const value = valueFor(snapshot, metric.kind);
        return `${metric.label} ${value === null ? "unavailable" : `${Math.round(value)}%`}`;
      }).join(" · ")
    : "System activity loading";

  return (
    <div ref={rootRef} className="system-meters-root">
      <button
        ref={buttonRef}
        type="button"
        data-window-control
        className="system-meters-pill"
        title={title}
        aria-label={`System activity: ${title}`}
        aria-expanded={anchor !== null}
        onClick={() =>
          setAnchor((current) =>
            current ? null : (buttonRef.current?.getBoundingClientRect() ?? null),
          )
        }
      >
        {METRICS.map((metric) => {
          const value = snapshot ? valueFor(snapshot, metric.kind) : null;
          return (
            <span key={metric.kind} className="system-meter-mini">
              <MiniRing value={value} color={metric.color} />
              <span className="system-meter-mini-label">{metric.label}</span>
              <span className="system-meter-mini-value" style={{ color: metric.color }}>
                {value === null ? "—" : Math.round(value)}
              </span>
            </span>
          );
        })}
      </button>
      {anchor && snapshot ? (
        <SystemPopover anchor={anchor} snapshot={snapshot} history={history} />
      ) : null}
    </div>
  );
}
