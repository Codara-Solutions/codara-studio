import type { SystemResourceSnapshot } from "@shared/types";

// The minute of history the popover's charts draw. The title-bar meters keep
// it while closed, so the charts are full the moment the popover opens; it
// lives apart from the popover's model to keep the startup bundle small.

export const HISTORY_WINDOW_MS = 60_000;

/** One sample of the figures the charts draw. */
export interface HistoryPoint {
  at: number;
  cpu: number;
  ram: number;
  swap: number | null;
  swapActivity: number | null;
  pressure: number | null;
  disk: number | null;
  network: number | null;
  gpus: Record<string, number | null>;
}

export function historyPoint(snapshot: SystemResourceSnapshot): HistoryPoint {
  const sum = (left: number | null, right: number | null): number | null =>
    left === null && right === null ? null : (left ?? 0) + (right ?? 0);
  return {
    at: snapshot.sampledAt,
    cpu: snapshot.cpuPercent,
    ram: snapshot.ramPercent,
    swap: snapshot.swapPercent,
    swapActivity: sum(snapshot.swapInBytesPerSecond, snapshot.swapOutBytesPerSecond),
    pressure: snapshot.memoryPressurePercent,
    disk: sum(snapshot.diskReadBytesPerSecond, snapshot.diskWriteBytesPerSecond),
    network: sum(snapshot.networkReceiveBytesPerSecond, snapshot.networkSendBytesPerSecond),
    gpus: Object.fromEntries(snapshot.gpus.map((gpu) => [gpu.id, gpu.utilizationPercent])),
  };
}

/** The history with `point` appended and anything older than the window dropped. */
export function appendHistory(history: readonly HistoryPoint[], point: HistoryPoint): HistoryPoint[] {
  const cutoff = point.at - HISTORY_WINDOW_MS - 2_000;
  const kept = history.filter((entry) => entry.at >= cutoff && entry.at < point.at);
  kept.push(point);
  return kept;
}

export interface SeriesPoint {
  at: number;
  value: number;
}

export function seriesOf(
  history: readonly HistoryPoint[],
  pick: (point: HistoryPoint) => number | null | undefined,
): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const entry of history) {
    const value = pick(entry);
    if (typeof value === "number" && Number.isFinite(value)) points.push({ at: entry.at, value });
  }
  return points;
}

