import React, { useId, useMemo, useState } from "react";
import type { NavigationTarget, SystemResource, SystemResourceSnapshot } from "@shared/types";
import { getAgentBoardSources, useAgentBoardSources } from "../agent-board/agentBoardSources";
import { RuntimeMark, CodaraMark, type BrandRuntime } from "../BrandMarks";
import { focusJumpTargetWhenReady } from "../jump/focus-target";
import { paneOverlaysSnapshot } from "../Terminal/paneOverlays";
import { MiniRing } from "./MiniRing";
import {
  describeGroup,
  formatBytes,
  formatPercent,
  formatRate,
  formatValue,
  HISTORY_WINDOW_MS,
  idleLabel,
  isAlarm,
  paneOwnerIndex,
  programLabel,
  rankedRows,
  RESOURCE_LABELS,
  RESOURCES,
  rowName,
  rowWhere,
  seriesOf,
  topApps,
  topProcesses,
  type GroupView,
  type HistoryPoint,
  type SeriesPoint,
} from "./model";
import "./system-activity.css";

// What is using the machine: one list, heaviest first, of Codara's panes, what
// closed panes left running, Codara itself and other apps. CPU reads as a share
// of the whole machine, the scale of the total, so the rows add up to it. The
// title-bar meter that was pressed picks the resource; the machine totals sit
// small in the tabs. The meters own polling and history, so this only draws.

const WIDTH = 420;
const CHART_HEIGHT = 30;
const HISTORY_GAP_MS = 6_000;
const PROCESSES_SHOWN = 4;
const APPS_SHOWN = 5;

const BRAND_RUNTIMES = new Set(["claude", "codex", "grok", "pi"]);

const COLORS: Record<SystemResource, string> = {
  cpu: "var(--metric-cpu)",
  memory: "var(--metric-ram)",
  gpu: "var(--metric-gpu)",
  swap: "var(--metric-swap)",
};

function busiestGpu(point: HistoryPoint): number | null {
  const values = Object.values(point.gpus).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : null;
}

const HISTORY: Record<SystemResource, (point: HistoryPoint) => number | null> = {
  cpu: (point) => point.cpu,
  memory: (point) => point.ram,
  gpu: busiestGpu,
  swap: (point) => point.swap,
};

function totalPercent(snapshot: SystemResourceSnapshot, resource: SystemResource): number | null {
  if (resource === "cpu") return snapshot.cpuPercent;
  if (resource === "memory") return snapshot.ramPercent;
  if (resource === "gpu") return snapshot.gpuPercent;
  return snapshot.swapPercent;
}

function totalText(snapshot: SystemResourceSnapshot, resource: SystemResource): string {
  if (resource === "memory") return formatBytes(snapshot.ramUsedBytes);
  if (resource === "swap") return formatBytes(snapshot.swapUsedBytes);
  const value = totalPercent(snapshot, resource);
  return value === null ? "n/a" : `${Math.round(value)}%`;
}

/** The few machine facts worth a glance for each resource, one short line each. */
function factsFor(snapshot: SystemResourceSnapshot, resource: SystemResource): string[] {
  const join = (parts: Array<string | null | false>) => parts.filter(Boolean).join(" · ");
  if (resource === "cpu") {
    return [
      join([
        `${snapshot.cpuLogicalCores} threads`,
        snapshot.loadAverage && `load ${snapshot.loadAverage[0].toFixed(1)}`,
        snapshot.cpuTemperatureC !== null && `${Math.round(snapshot.cpuTemperatureC)} °C`,
      ]),
    ];
  }
  if (resource === "memory") {
    return [
      join([
        `of ${formatBytes(snapshot.ramTotalBytes)}`,
        `${formatBytes(snapshot.ramAvailableBytes)} available`,
        snapshot.ramCachedBytes !== null && `${formatBytes(snapshot.ramCachedBytes)} cache`,
        (snapshot.memoryPressurePercent ?? 0) >= 1 && `${formatPercent(snapshot.memoryPressurePercent)} stalled`,
      ]),
    ];
  }
  if (resource === "swap") {
    if (snapshot.swapTotalBytes === null) return ["Swap is not reported on this system"];
    return [
      join([
        `of ${formatBytes(snapshot.swapTotalBytes)}`,
        snapshot.swapInBytesPerSecond !== null && `in ${formatRate(snapshot.swapInBytesPerSecond)}`,
        snapshot.swapOutBytesPerSecond !== null && `out ${formatRate(snapshot.swapOutBytesPerSecond)}`,
      ]),
    ];
  }
  if (snapshot.gpus.length === 0) return [snapshot.gpuUnavailableReason ?? "No GPU found"];
  return snapshot.gpus.map((gpu) =>
    join([
      gpu.name,
      gpu.asleep ? "asleep" : gpu.utilizationPercent !== null && `${Math.round(gpu.utilizationPercent)}%`,
      gpu.memoryUsedBytes !== null &&
        (gpu.memoryTotalBytes !== null
          ? `${formatBytes(gpu.memoryUsedBytes)} of ${formatBytes(gpu.memoryTotalBytes)}`
          : formatBytes(gpu.memoryUsedBytes)),
      gpu.temperatureC !== null && `${Math.round(gpu.temperatureC)} °C`,
      !gpu.asleep && gpu.note,
    ]),
  );
}

function segmentsOf(series: SeriesPoint[]): SeriesPoint[][] {
  const segments: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const point of series) {
    const previous = current[current.length - 1];
    if (previous && point.at - previous.at > HISTORY_GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** The last minute of the resource's machine total, newest at the right. */
function Chart({ series, now, color, label }: { series: SeriesPoint[]; now: number; color: string; label: string }) {
  const width = 300;
  const height = CHART_HEIGHT;
  const [hover, setHover] = useState<SeriesPoint | null>(null);
  const start = now - HISTORY_WINDOW_MS;
  const x = (at: number) => ((at - start) / HISTORY_WINDOW_MS) * width;
  const y = (value: number) => height - 1 - (Math.min(100, Math.max(0, value)) / 100) * (height - 3);
  const paths = segmentsOf(series.filter((point) => point.at >= start - 2_000)).map((segment) => {
    const line = segment.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
    const first = segment[0];
    const last = segment[segment.length - 1];
    return { line, area: `${line}L${x(last.at).toFixed(1)},${height}L${x(first.at).toFixed(1)},${height}Z` };
  });
  const values = series.map((point) => point.value);
  const summary =
    values.length > 0
      ? `${label} over the last minute: ${Math.round(Math.min(...values))}% to ${Math.round(Math.max(...values))}%`
      : `${label}: no readings yet`;
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = start + ((event.clientX - box.left) / box.width) * HISTORY_WINDOW_MS;
    let nearest: SeriesPoint | null = null;
    for (const point of series) {
      if (!nearest || Math.abs(point.at - at) < Math.abs(nearest.at - at)) nearest = point;
    }
    setHover(nearest && Math.abs(nearest.at - at) < 3_000 ? nearest : null);
  };
  return (
    <div className="sa-chart" style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        <line className="sa-chart__base" x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} />
        {paths.map((path, index) => (
          <g key={index}>
            <path d={path.area} fill={color} opacity={0.12} />
            <path
              d={path.line}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
        {hover ? (
          <line className="sa-chart__cursor" x1={x(hover.at)} x2={x(hover.at)} y1={0} y2={height} vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      {hover ? (
        <span className="sa-chart__readout">
          {Math.round(hover.value)}% · {Math.max(0, Math.round((now - hover.at) / 1000))} s ago
        </span>
      ) : null}
    </div>
  );
}

function WarningIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M8 1.6 15 14H1L8 1.6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6v3.6M8 11.6v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MemoryWarning({
  snapshot,
  resource,
  onResource,
}: {
  snapshot: SystemResourceSnapshot;
  resource: SystemResource;
  onResource: (resource: SystemResource) => void;
}) {
  if (snapshot.memoryLevel === "ok") return null;
  const swapping = (snapshot.swapOutBytesPerSecond ?? 0) > 1024 * 1024;
  return (
    <div className="sa-warning" data-level={snapshot.memoryLevel} role="status">
      <WarningIcon />
      <span className="sa-warning__text">
        <strong>{snapshot.memoryLevel === "critical" ? "Memory almost full" : "Memory running low"}</strong>
        {`: ${formatBytes(snapshot.ramAvailableBytes)} available`}
        {swapping ? `, swapping ${formatRate(snapshot.swapOutBytesPerSecond)}` : ""}
      </span>
      {resource !== "memory" ? (
        <button type="button" className="sa-warning__go" onClick={() => onResource("memory")}>
          Show RAM
        </button>
      ) : null}
    </div>
  );
}

function Chevron() {
  return (
    <svg className="sa-row__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden focusable="false">
      <path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OwnerMark({ view, alarm }: { view: GroupView; alarm: boolean }) {
  if (alarm) {
    return (
      <span className="sa-mark sa-mark--alarm" aria-hidden>
        <WarningIcon />
      </span>
    );
  }
  if (view.kind === "codara") {
    return (
      <span className="sa-mark sa-mark--codara" aria-hidden>
        <CodaraMark size={14} />
      </span>
    );
  }
  if (view.kind === "outside") {
    return (
      <span className="sa-mark sa-mark--outside" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" focusable="false">
          <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="8" y="1.5" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="1.5" y="8" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="8" y="8" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </span>
    );
  }
  if (view.runtime && BRAND_RUNTIMES.has(view.runtime)) {
    return (
      <span className="sa-mark" style={{ color: `var(--agent-${view.runtime})` }} aria-hidden>
        <RuntimeMark runtime={view.runtime as BrandRuntime} size={14} />
      </span>
    );
  }
  return (
    <span className="sa-mark sa-mark--shell" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 14 14" focusable="false">
        <path d="M2.5 3.5 6 7l-3.5 3.5M7.5 11h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** What was asked of the row, and the processes or programs behind it. */
function RowDetail({ view, resource, cores }: { view: GroupView; resource: SystemResource; cores: number }) {
  const leftRunning = view.kind === "left-running";
  const command = leftRunning ? topProcesses(view.group, resource, 1)[0]?.command : "";
  const programs = leftRunning || view.kind === "outside";
  const listed = topApps(view.group, resource, APPS_SHOWN);
  // One program left running is already the row's name and figure.
  const apps = leftRunning && listed.length < 2 ? [] : listed;
  return (
    <div className="sa-row__detail">
      {view.note ? (
        <p className="sa-row__note" title={view.note}>
          {view.note}
        </p>
      ) : null}
      {command ? (
        <code className="sa-row__command" title={command}>
          {command}
        </code>
      ) : null}
      {leftRunning ? <p className="sa-row__note">Nothing is watching this. It runs until it is stopped.</p> : null}
      <ul className="sa-row__list">
        {programs
          ? apps.map((app) => (
              <li key={app.name} title={`${app.processCount} process${app.processCount === 1 ? "" : "es"}`}>
                <span className="sa-row__detail-name">{programLabel(app)}</span>
                <span className="sa-num">{formatValue(app, resource, cores)}</span>
              </li>
            ))
          : topProcesses(view.group, resource, PROCESSES_SHOWN).map((entry) => (
              <li key={entry.pid} title={`${entry.command || entry.name}\npid ${entry.pid}`}>
                <span className="sa-row__detail-name">{entry.name}</span>
                <span className="sa-num">{formatValue(entry, resource, cores)}</span>
              </li>
            ))}
      </ul>
    </div>
  );
}

function Row({
  view,
  resource,
  cores,
  alarm,
  expanded,
  onToggle,
  onJump,
}: {
  view: GroupView;
  resource: SystemResource;
  cores: number;
  alarm: boolean;
  expanded: boolean;
  onToggle: () => void;
  onJump: (target: NavigationTarget) => void;
}) {
  const detailId = useId();
  const value = formatValue(view.group, resource, cores);
  const name = rowName(view, resource);
  const body = (
    <>
      <OwnerMark view={view} alarm={alarm} />
      <span className="sa-row__text">
        <span className="sa-row__name">{name}</span>
        <span className="sa-row__where">
          {view.color ? <i className="sa-row__dot" style={{ background: view.color }} /> : null}
          <span className="sa-row__where-text">{rowWhere(view, resource)}</span>
        </span>
      </span>
      <span className="sa-row__value sa-num">{value}</span>
    </>
  );
  const target = view.target;
  return (
    <li className="sa-row" data-owner={view.kind} data-alarm={alarm || undefined} data-expanded={expanded || undefined}>
      <div className="sa-row__line">
        {target ? (
          <button
            type="button"
            className="sa-row__main"
            aria-label={`Go to ${name}: ${value} ${RESOURCE_LABELS[resource]}`}
            onClick={() => onJump(target)}
          >
            {body}
          </button>
        ) : (
          <button type="button" className="sa-row__main" aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>
            {body}
          </button>
        )}
        <button
          type="button"
          className="sa-row__more"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${expanded ? "Hide" : "Show"} what runs in ${name}`}
          onClick={onToggle}
        >
          <Chevron />
        </button>
      </div>
      <div id={detailId} hidden={!expanded}>
        {expanded ? <RowDetail view={view} resource={resource} cores={cores} /> : null}
      </div>
    </li>
  );
}

const NOTHING_USES: Partial<Record<SystemResource, string>> = {
  gpu: "Nothing here uses video memory",
  swap: "Nothing here uses swap",
};

function Rows({
  snapshot,
  views,
  resource,
  onJump,
}: {
  snapshot: SystemResourceSnapshot;
  views: GroupView[];
  resource: SystemResource;
  onJump: (target: NavigationTarget) => void;
}) {
  // Rows the user flipped. An alarmed row starts open, so what it is doing
  // shows without a click, and a flip closes it like any other.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [showIdle, setShowIdle] = useState(false);
  const idleId = useId();
  const toggle = (key: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const processes = snapshot.processes;
  if (!processes) return <p className="sa-note">Reading processes</p>;
  if (processes.unavailableReason) return <p className="sa-note">{processes.unavailableReason}</p>;
  if (resource === "gpu" && !processes.gpuMeasured) {
    return <p className="sa-note">{processes.gpuUnavailableReason ?? "Reading video memory per app"}</p>;
  }
  if (resource === "swap" && !processes.swapMeasured) {
    return <p className="sa-note">{processes.swapUnavailableReason ?? "Reading swap per app"}</p>;
  }
  const cores = snapshot.cpuLogicalCores;
  const { busy, idle } = rankedRows(views, resource, processes.cpuMeasured);
  const row = (view: GroupView) => {
    const alarm = isAlarm(view, resource, cores);
    return (
      <Row
        key={view.key}
        view={view}
        resource={resource}
        cores={cores}
        alarm={alarm}
        expanded={flipped.has(view.key) !== alarm}
        onToggle={() => toggle(view.key)}
        onJump={onJump}
      />
    );
  };
  const label = RESOURCE_LABELS[resource];
  return (
    <>
      {busy.length > 0 ? (
        <ul className="sa-rows" aria-label={`Everything by ${label}`}>
          {busy.map(row)}
        </ul>
      ) : NOTHING_USES[resource] ? (
        <p className="sa-note">{NOTHING_USES[resource]}</p>
      ) : null}
      {idle.length > 0 ? (
        <>
          <button
            type="button"
            className="sa-idle"
            data-expanded={showIdle || undefined}
            aria-expanded={showIdle}
            aria-controls={idleId}
            onClick={() => setShowIdle((shown) => !shown)}
          >
            <Chevron />
            <span>{idleLabel(idle)}</span>
          </button>
          <div id={idleId} hidden={!showIdle}>
            {showIdle ? (
              <ul className="sa-rows" aria-label={`Idle by ${label}`}>
                {idle.map(row)}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
      {resource === "cpu" ? (
        <p className="sa-note sa-note--fine">{processes.cpuMeasured ? "Share of the whole machine" : "Measuring CPU"}</p>
      ) : null}
    </>
  );
}

export default function SystemActivityPopover({
  anchor,
  snapshot,
  history,
  resource,
  onResource,
  onClose,
  style,
}: {
  anchor: DOMRect;
  snapshot: SystemResourceSnapshot;
  history: HistoryPoint[];
  resource: SystemResource;
  onResource: (resource: SystemResource) => void;
  onClose: (options?: { restoreFocus?: boolean }) => void;
  style?: React.CSSProperties;
}) {
  const sources = useAgentBoardSources();
  const panes = useMemo(
    () => paneOwnerIndex(sources.workspaces, sources.layouts, paneOverlaysSnapshot()),
    [sources.workspaces, sources.layouts],
  );
  const views = useMemo(
    () => (snapshot.processes?.groups ?? []).map((group) => describeGroup(group, panes, sources.workspaces)),
    [snapshot.processes, panes, sources.workspaces],
  );
  const tabsId = useId();
  const width = Math.min(WIDTH, window.innerWidth - 16);
  const left = Math.min(Math.max(8, anchor.right - width), Math.max(8, window.innerWidth - width - 8));
  const top = anchor.bottom + 6;

  const jump = (target: NavigationTarget) => {
    const navigate = getAgentBoardSources().navigate;
    if (!navigate) return;
    onClose({ restoreFocus: false });
    navigate(target);
    if (target.type === "terminal") {
      focusJumpTargetWhenReady({ workspaceId: target.workspaceId, tabId: target.tabId, paneId: target.paneId });
    }
  };

  const onTabKey = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = RESOURCES[(RESOURCES.indexOf(resource) + step + RESOURCES.length) % RESOURCES.length];
    onResource(next);
    document.getElementById(`${tabsId}-${next}`)?.focus();
  };

  return (
    <div
      className="spark-menu system-activity"
      role="dialog"
      aria-label="System activity"
      data-resource={resource}
      style={{ position: "fixed", top, left, width, maxHeight: window.innerHeight - top - 10, zIndex: 1300, ...style }}
    >
      <div className="sa-tabs" role="tablist" aria-label="Resource" onKeyDown={onTabKey}>
        {RESOURCES.map((option) => (
          <button
            key={option}
            id={`${tabsId}-${option}`}
            type="button"
            role="tab"
            className="sa-tab"
            data-resource={option}
            aria-selected={resource === option}
            aria-controls={`${tabsId}-panel`}
            tabIndex={resource === option ? 0 : -1}
            onClick={() => onResource(option)}
          >
            <MiniRing value={totalPercent(snapshot, option)} color={COLORS[option]} />
            <span className="sa-tab__label">{RESOURCE_LABELS[option]}</span>
            <span className="sa-tab__value sa-num">{totalText(snapshot, option)}</span>
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} className="system-activity__panel" role="tabpanel" aria-labelledby={`${tabsId}-${resource}`}>
        <div className="sa-overview">
          <Chart
            series={seriesOf(history, HISTORY[resource])}
            now={snapshot.sampledAt}
            color={COLORS[resource]}
            label={`${RESOURCE_LABELS[resource]} total`}
          />
          {factsFor(snapshot, resource).map((line, index) => (
            <p key={index} className="sa-facts">
              {line}
            </p>
          ))}
        </div>
        <MemoryWarning snapshot={snapshot} resource={resource} onResource={onResource} />
        <div className="system-activity__rows">
          <Rows snapshot={snapshot} views={views} resource={resource} onJump={jump} />
        </div>
      </div>
    </div>
  );
}
