// Usage analytics for the Usage tab: resolves where each provider CLI keeps
// its transcripts and hands the scan (usage-scan.ts) to a worker thread.
//
// Three roots, all personal-home only:
//   claude — <personal claude config dir>/projects/**/*.jsonl
//   codex  — <codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl, and the
//            sessions Codex moved to <codex home>/archived_sessions
//   cora   — <codaraHome>/pi-agent/sessions/*.jsonl
//
// The worker keeps the parsed-record memo between scans and is stopped once
// the page has been idle for a while, which returns the memo's memory; the
// persisted cache keeps the next scan warm.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { codaraHome } from "./codara-home";
import { codexTranscriptRoots, scanUsage, type UsageScanRequest, type UsageScanRoot } from "./usage-scan";
import type {
  ForecastScan,
  UsageScanJob,
  UsageScanReply,
  UsageScanResult,
  UsageScanWork,
} from "./usage-scan-worker";
import type { UsageSummary, UsageSummaryInput } from "@shared/usage-analytics";

const WORKER_IDLE_MS = 3 * 60 * 1000;

async function resolveProviderRoots(): Promise<UsageScanRoot[]> {
  const roots: UsageScanRoot[] = [];

  try {
    const { defaultPersonalClaudeConfigDir } = await import(
      "./orchestration/claude-cli-account-profiles"
    );
    roots.push({
      provider: "claude",
      dir: join(defaultPersonalClaudeConfigDir(), "projects"),
      error: null,
    });
  } catch (err) {
    roots.push({ provider: "claude", dir: "", error: messageOf(err) });
  }

  try {
    // resolveCodexHomePaths asserts the shared-state layout and throws when a
    // managed profile left something unexpected behind. That is a real problem
    // worth surfacing on the source row, not a reason to fail the whole page.
    const { resolveCodexHomePaths } = await import("./orchestration/codex-home");
    roots.push(...codexTranscriptRoots(resolveCodexHomePaths().sessionsRoot));
  } catch (err) {
    roots.push({ provider: "codex", dir: "", error: messageOf(err) });
  }

  roots.push({
    provider: "cora",
    dir: join(codaraHome(), "pi-agent", "sessions"),
    error: null,
  });

  return roots;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── Worker ──────────────────────────────────────────────────────────────── */

let cachedWorkerCode: string | null | undefined;

// The worker runs from source text (`eval: true`), so loading it never
// depends on the thread resolving a path inside the packaged app's asar. The
// build writes it to out/main; this module may itself land in out/main/chunks.
function usageScanWorkerCode(): string | null {
  if (cachedWorkerCode !== undefined) return cachedWorkerCode;
  cachedWorkerCode = null;
  for (const dir of [__dirname, dirname(__dirname)]) {
    try {
      cachedWorkerCode = readFileSync(join(dir, "usage-scan-worker.js"), "utf8");
      break;
    } catch {
      // Not here; try the parent of a chunk directory.
    }
  }
  return cachedWorkerCode;
}

interface PendingScan {
  resolve: (summary: UsageScanResult) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let nextJobId = 1;
const pending = new Map<number, PendingScan>();
let idleTimer: NodeJS.Timeout | null = null;

function settleAll(err: Error): void {
  for (const scan of pending.values()) scan.reject(err);
  pending.clear();
}

function startWorker(code: string): Worker {
  const thread = new Worker(code, { eval: true });
  thread.unref();
  thread.on("message", (reply: UsageScanReply) => {
    const scan = pending.get(reply.id);
    if (!scan) return;
    pending.delete(reply.id);
    if (reply.ok) scan.resolve(reply.summary);
    else scan.reject(new Error(reply.error));
    if (pending.size === 0) armIdleStop();
  });
  thread.on("error", (err) => {
    if (worker === thread) worker = null;
    settleAll(new Error(`The usage scan stopped: ${messageOf(err)}`));
  });
  thread.on("exit", (code) => {
    if (worker === thread) worker = null;
    if (pending.size > 0) settleAll(new Error(`The usage scan exited unexpectedly (code ${code}).`));
  });
  return thread;
}

function armIdleStop(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size > 0 || worker === null) return;
    const thread = worker;
    worker = null;
    void thread.terminate().catch(() => undefined);
  }, WORKER_IDLE_MS);
  idleTimer.unref();
}

function scanOnWorker<T extends UsageScanResult>(code: string, job: UsageScanWork): Promise<T> {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker === null) worker = startWorker(code);
  const id = nextJobId++;
  const thread = worker;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as PendingScan["resolve"], reject });
    thread.postMessage({ id, ...job } as UsageScanJob);
  });
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

export async function readUsageSummary(input: UsageSummaryInput): Promise<UsageSummary> {
  const request: UsageScanRequest = {
    roots: await resolveProviderRoots(),
    cachePath: join(codaraHome(), "usage-scan-cache.json"),
    input,
  };
  const code = usageScanWorkerCode();
  // A build without the worker bundle (unit harnesses, a stale out/) still
  // answers, on this thread.
  return code === null ? scanUsage(request) : scanOnWorker<UsageSummary>(code, { request });
}

/** Priced spend per time bucket since sinceMs, and the CLIs' own limit
 * readings, for the usage forecast. */
export async function readForecastScan(sinceMs: number, bucketMs: number): Promise<ForecastScan> {
  const roots = await resolveProviderRoots();
  const timeline = {
    roots,
    cachePath: join(codaraHome(), "usage-scan-cache.json"),
    sinceMs,
    bucketMs,
    nowMs: Date.now(),
  };
  const signals = { roots, memoPath: join(codaraHome(), "usage-forecast-signals.json"), sinceMs };
  const code = usageScanWorkerCode();
  if (code === null) {
    const { runForecastScan } = await import("./usage-scan-worker");
    return runForecastScan(timeline, signals);
  }
  return scanOnWorker<ForecastScan>(code, { timeline, signals });
}
