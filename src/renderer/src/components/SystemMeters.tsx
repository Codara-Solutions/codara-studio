import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { SystemMemoryLevel, SystemResource, SystemResourceSnapshot } from "@shared/types";
import { appendHistory, historyPoint, type HistoryPoint } from "./system-activity/history";
import { MiniRing } from "./system-activity/MiniRing";

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

type MetricKind = "cpu" | "gpu" | "ram" | "swap";

// The meters refresh at a calm pace. Pressing one opens what uses that
// resource, sampled every second with per-process detail. Nothing samples
// while the window is hidden.
const METER_POLL_MS = 2_000;
const POPOVER_POLL_MS = 1_000;

const loadPopover = () => import("./system-activity/SystemActivityPopover");
const SystemActivityPopover = lazy(loadPopover);

const METRICS: ReadonlyArray<{ kind: MetricKind; label: string; color: string; resource: SystemResource; uses: string }> = [
  { kind: "cpu", label: "CPU", color: "var(--metric-cpu)", resource: "cpu", uses: "CPU" },
  { kind: "gpu", label: "GPU", color: "var(--metric-gpu)", resource: "gpu", uses: "video memory" },
  { kind: "ram", label: "RAM", color: "var(--metric-ram)", resource: "memory", uses: "memory" },
  { kind: "swap", label: "SWAP", color: "var(--metric-swap)", resource: "swap", uses: "swap" },
];

function valueFor(snapshot: SystemResourceSnapshot, kind: MetricKind): number | null {
  if (kind === "cpu") return snapshot.cpuPercent;
  if (kind === "gpu") return snapshot.gpuPercent;
  if (kind === "swap") return snapshot.swapPercent ?? null;
  return snapshot.ramPercent;
}

// Swap is read in bytes: its percentage is of a total that macOS grows on
// demand, so "6.2G" says more than "87".
function compactSwap(bytes: number | null): string {
  if (bytes == null) return "n/a";
  const gib = bytes / 1024 ** 3;
  if (gib < 0.05) return "0G";
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)}G`;
}

function metricText(snapshot: SystemResourceSnapshot, kind: MetricKind): string {
  if (kind === "swap") return compactSwap(snapshot.swapUsedBytes);
  const value = valueFor(snapshot, kind);
  return value === null ? "n/a" : String(Math.round(value));
}

function levelColor(level: SystemMemoryLevel | undefined, fallback: string): string {
  return level === "critical" ? "var(--danger)" : level === "low" ? "var(--warn)" : fallback;
}

export default function SystemMeters() {
  const [snapshot, setSnapshot] = useState<SystemResourceSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  // The resource the popover breaks down, and where it opened; null closed.
  const [view, setView] = useState<{ resource: SystemResource; anchor: DOMRect } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<SystemResource, HTMLButtonElement>());
  const openRef = useRef<SystemResource | null>(null);
  const inflightRef = useRef(false);
  const queuedRef = useRef(false);
  const open = view !== null;
  const resource = view?.resource ?? null;

  const load = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    if (inflightRef.current) {
      // Opening the popover (or switching what it breaks down) during a poll
      // still gets its own reading right after, not a second later.
      queuedRef.current = openRef.current !== null;
      return;
    }
    inflightRef.current = true;
    const focus = openRef.current;
    void window.spark.system
      .resourceSnapshot({ detail: focus !== null, focus: focus ?? undefined })
      .then((next) => {
        setSnapshot((current) =>
          // A meter poll that lands while the popover is open must not blank
          // its process list for a second.
          next.processes === null && openRef.current !== null && current?.processes
            ? { ...next, processes: current.processes }
            : next,
        );
        setHistory((current) => appendHistory(current, historyPoint(next)));
      })
      .catch(() => undefined)
      .finally(() => {
        inflightRef.current = false;
        if (queuedRef.current) {
          queuedRef.current = false;
          load();
        }
      });
  }, []);

  // A new resource is read at once: swap per process, say, is only read
  // while its breakdown is open.
  useEffect(() => {
    openRef.current = resource;
    if (resource) load();
  }, [load, resource]);

  useEffect(() => {
    const timer = window.setInterval(load, open ? POPOVER_POLL_MS : METER_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, open]);

  useEffect(() => {
    load();
  }, [load]);

  const close = useCallback((options?: { restoreFocus?: boolean }) => {
    const shown = openRef.current;
    setView(null);
    if (options?.restoreFocus !== false && shown) buttonRefs.current.get(shown)?.focus({ preventScroll: true });
  }, []);

  const press = (next: SystemResource) =>
    setView((current) =>
      current?.resource === next
        ? null
        : { resource: next, anchor: current?.anchor ?? pillRef.current?.getBoundingClientRect() ?? new DOMRect() },
    );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setView(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onResize = () => setView(null);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  const memoryLevel = snapshot?.memoryLevel;
  const title = snapshot
    ? METRICS.map((metric) => {
        const value = valueFor(snapshot, metric.kind);
        if (metric.kind === "swap") {
          return `${metric.label} ${value === null ? "unavailable" : compactSwap(snapshot.swapUsedBytes)}`;
        }
        const reading = `${metric.label} ${value === null ? "unavailable" : `${Math.round(value)}%`}`;
        if (metric.kind === "ram" && memoryLevel && memoryLevel !== "ok") {
          return `${reading} (memory ${memoryLevel === "critical" ? "almost full" : "low"})`;
        }
        return reading;
      }).join(", ")
    : "System activity loading";

  return (
    <div ref={rootRef} className="system-meters-root">
      <div
        ref={pillRef}
        data-window-control
        className="system-meters-pill"
        role="group"
        aria-label="System activity"
        data-memory-level={memoryLevel ?? "ok"}
        data-open={open || undefined}
        title={title}
        onPointerEnter={() => void loadPopover()}
        onFocus={() => void loadPopover()}
      >
        {METRICS.map((metric) => {
          const value = snapshot ? valueFor(snapshot, metric.kind) : null;
          const color = metric.kind === "ram" ? levelColor(memoryLevel, metric.color) : metric.color;
          const text = snapshot ? metricText(snapshot, metric.kind) : "n/a";
          const spoken = metric.kind === "swap" || text === "n/a" ? text : `${text}%`;
          return (
            <button
              key={metric.kind}
              ref={(node) => {
                if (node) buttonRefs.current.set(metric.resource, node);
                else buttonRefs.current.delete(metric.resource);
              }}
              type="button"
              data-window-control
              className="system-meter-mini"
              data-metric={metric.kind}
              aria-label={`${metric.label} ${spoken}: what uses ${metric.uses}`}
              aria-haspopup="dialog"
              aria-expanded={resource === metric.resource}
              onClick={() => press(metric.resource)}
            >
              <MiniRing value={value} color={color} />
              <span className="system-meter-mini-label">{metric.label}</span>
              <span className="system-meter-mini-value">{text}</span>
            </button>
          );
        })}
      </div>
      {view && snapshot ? (
        <Suspense fallback={null}>
          <SystemActivityPopover
            anchor={view.anchor}
            snapshot={snapshot}
            history={history}
            resource={view.resource}
            onResource={(next) => setView((current) => (current ? { ...current, resource: next } : current))}
            onClose={close}
            style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
