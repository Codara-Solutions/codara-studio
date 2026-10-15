// The crash and freeze black box: what the main process records about its own
// freezes and crashes, and what Settings > About shows and exports. Shared by
// src/main/diagnostics/, the preload area (window.spark.diagnostics) and the
// About page. Everything here stays on the computer; nothing is uploaded.

/** One notable event, kept in a small ring so a freeze or crash has context. */
export interface Breadcrumb {
  /** Epoch ms. */
  t: number;
  category: string;
  message: string;
}

/** One frame of the main thread's JavaScript stack, captured during a freeze. */
export interface HangStackFrame {
  fn: string;
  url: string;
  line: number;
  column: number;
}

/**
 * One time the main process stopped answering. Written by the watchdog thread
 * (src/main/diagnostics/hang-watchdog-worker.ts) to diagnostics/hangs.jsonl.
 */
export interface HangRecord {
  id: string;
  /** Epoch ms of the last heartbeat before the freeze. */
  startedAt: number;
  /** Epoch ms when the watchdog noticed it. */
  detectedAt: number;
  /** How long the main thread had been silent when noticed. */
  unresponsiveMs: number;
  /** The whole freeze, once heartbeats came back; otherwise the longest silence seen. */
  durationMs: number;
  /** False when the app closed (or was killed) before the main thread answered again. */
  recovered: boolean;
  pid: number;
  /**
   * Process CPU time over the silence as a share of one core. Near 100 means
   * the main thread was busy computing; near 0 means it waited on something
   * (disk, a lock, a synchronous call).
   */
  cpuPercent: number | null;
  rssBytes: number | null;
  loadAverage: number[] | null;
  freeMemoryBytes: number | null;
  totalMemoryBytes: number | null;
  /** The main thread's JavaScript stack at the moment of the freeze, innermost first. */
  stack: HangStackFrame[] | null;
  /** Why there is no stack, when there is none. */
  stackNote: string | null;
  /** The last notable events before the freeze. */
  breadcrumbs: Breadcrumb[];
}

/** One summary window of the main event loop's delay. */
export interface EventLoopWindow {
  /** Epoch ms at the end of the window. */
  t: number;
  windowMs: number;
  /** Delay beyond the sampling interval, in ms. */
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface CrashDumpInfo {
  /** Relative to the crash dump folder, with forward slashes ("pending/<id>.dmp"). */
  path: string;
  bytes: number;
  /** Epoch ms of the file's last write. */
  modifiedAt: number;
}

export interface DiagnosticsSummary {
  watchdog: boolean;
  crashReporter: boolean;
  hangs: {
    total: number;
    /** Freezes in the last seven days. */
    recent: number;
    /** The longest of the recent ones, in ms. */
    longestRecentMs: number | null;
    last: { at: number; durationMs: number; recovered: boolean } | null;
  };
  crashes: {
    count: number;
    bytes: number;
    lastAt: number | null;
  };
}

export type DiagnosticsExportResult =
  | { status: "saved"; path: string; fileName: string; files: number; bytes: number }
  | { status: "canceled" };

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** "7.4 s", "820 ms", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** "3.2 MB", "640 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * The "Freezes and crashes" line on the About page. `formatTime` turns an
 * epoch ms into the user's local date and time.
 */
export function describeDiagnosticsSummary(
  summary: DiagnosticsSummary,
  formatTime: (epochMs: number) => string,
): string {
  const parts: string[] = [];
  const { hangs, crashes } = summary;
  if (hangs.recent > 0) {
    const longest = hangs.longestRecentMs !== null ? `, the longest ${formatDuration(hangs.longestRecentMs)}` : "";
    parts.push(`${plural(hangs.recent, "freeze", "freezes")} in the last 7 days${longest}.`);
    if (hangs.last) {
      const how = hangs.last.recovered ? "recovered" : "did not recover";
      parts.push(`Last one ${formatTime(hangs.last.at)}, ${formatDuration(hangs.last.durationMs)}, ${how}.`);
    }
  } else if (hangs.total > 0 && hangs.last) {
    parts.push(`No freezes in the last 7 days. Last one ${formatTime(hangs.last.at)}.`);
  }
  if (crashes.count > 0) {
    const when = crashes.lastAt !== null ? `, the last ${formatTime(crashes.lastAt)}` : "";
    parts.push(`${plural(crashes.count, "crash report", "crash reports")} kept (${formatBytes(crashes.bytes)})${when}.`);
  }
  if (parts.length === 0) parts.push("No freezes or crashes recorded.");
  if (!summary.watchdog) parts.push("Freeze detection is off.");
  if (!summary.crashReporter) parts.push("Crash reports are off.");
  return parts.join(" ");
}
