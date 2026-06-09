import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { Cron } from "croner";
import type {
  AutomationTrigger,
  CreateScheduledJobInput,
  RunState,
  ScheduledJob,
  StartAutopilotInput,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { writeFileAtomic } from "../fs-atomic";
import { sparkHome } from "../spark-home";
// run-store is heavy (it transitively loads openrouter + agent-sync). Importing
// scheduler at boot to arm timers must NOT drag run-store into cold start, so we
// lazy-import startAutopilot only when a job actually fires (runJobNow below;
// fireJob goes through run-queue, also lazily).

// Automation scheduler ─────────────────────────────────────────────────────────
// A registry of saved automations. Each one pins a StartAutopilotInput and a
// trigger (cron / interval / folder-watch); when the trigger fires we enqueue
// that input onto the overnight run-queue and kick a drain. Firing happens in
// the Electron main process, so it only runs WHILE THE APP IS OPEN — true
// fire-while-closed survives the daemon split (docs/daemon-split-PLAN.md). Until
// then this is a real, working in-app scheduler.
//
// Persisted as a single JSON file next to spark-state.json / spark-settings.json.
// The on-disk shape is versioned-by-convention via the `jobs` envelope so a
// future migration can add sibling fields without reinterpreting a bare array.
const SCHEDULER_FILE = "scheduler.json";

interface SchedulerFile {
  jobs: ScheduledJob[];
}

// In-process cache + write serialization, mirroring preferences-store.ts. The
// cache means repeated list/mutate calls in one boot pay a single fs.readFile;
// chaining `writing` keeps concurrent mutations from racing the atomic write.
let cache: ScheduledJob[] | null = null;
let writing: Promise<void> = Promise.resolve();

// jobId -> disarm fn. A job is "armed" when its trigger has a live timer/watcher.
const armed = new Map<string, () => void>();

function schedulerPath(): string {
  return join(sparkHome(), SCHEDULER_FILE);
}

// Tolerate legacy jobs that stored a bare `cron` string before the trigger union
// existed: synthesize a cron trigger so they keep firing after the upgrade.
function normalizeJob(job: ScheduledJob): ScheduledJob {
  if (!job.trigger && job.cron) {
    return { ...job, trigger: { kind: "cron", expr: job.cron } };
  }
  return job;
}

async function readFromDisk(): Promise<ScheduledJob[]> {
  try {
    const raw = await fs.readFile(schedulerPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerFile>;
    return Array.isArray(parsed.jobs) ? parsed.jobs.map(normalizeJob) : [];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("[scheduler] failed to read, starting empty:", err);
    return [];
  }
}

async function loadJobs(): Promise<ScheduledJob[]> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

// Persist the given list, update the cache, and serialize against any in-flight
// write so two mutations can't interleave their atomic renames.
async function persist(jobs: ScheduledJob[]): Promise<void> {
  cache = jobs;
  const snapshot: SchedulerFile = { jobs };
  writing = writing
    .then(() => writeFileAtomic(schedulerPath(), JSON.stringify(snapshot, null, 2)))
    .catch((err) => {
      console.error("[scheduler] write failed:", err);
    });
  await writing;
}

// Broadcast a registry-changed event so the renderer's Automations panel can
// live-refresh. Uses the run event bus with no runId (so nothing is journaled);
// the panel filters on event.type. Best-effort.
async function emitUpdated(): Promise<void> {
  try {
    const { appendEvent } = await import("./event-log");
    await appendEvent({ workspaceId: "", type: "automation.updated" });
  } catch {
    /* best effort — a missing live update just means the panel refreshes lazily */
  }
}

export async function listJobs(): Promise<ScheduledJob[]> {
  // Return a shallow copy so callers (IPC handlers) can't mutate the cache.
  return [...(await loadJobs())];
}

export async function createJob(input: CreateScheduledJobInput): Promise<ScheduledJob> {
  const jobs = await loadJobs();
  const job: ScheduledJob = {
    id: makeId("job"),
    name: input.name,
    trigger: input.trigger,
    // Default to enabled when the caller omits the flag.
    enabled: input.enabled ?? true,
    input: input.input,
    createdAt: new Date().toISOString(),
  };
  await persist([...jobs, job]);
  armJob(job);
  void emitUpdated();
  return job;
}

export async function deleteJob(id: string): Promise<void> {
  const jobs = await loadJobs();
  const next = jobs.filter((job) => job.id !== id);
  // No-op (but still persist) when the id is unknown — keeps the call idempotent.
  if (next.length !== jobs.length) {
    disarmJob(id);
    await persist(next);
    void emitUpdated();
  }
}

export async function setEnabled(id: string, enabled: boolean): Promise<ScheduledJob> {
  const jobs = await loadJobs();
  const target = jobs.find((job) => job.id === id);
  if (!target) {
    throw new Error(`Scheduled job not found: ${id}`);
  }
  const updated: ScheduledJob = { ...target, enabled };
  await persist(jobs.map((job) => (job.id === id ? updated : job)));
  if (enabled) armJob(updated);
  else disarmJob(id);
  void emitUpdated();
  return updated;
}

// Fire a job by hand right now, immediately and directly (bypasses the queue so
// the caller gets a RunState back). Used by the "Run now" button. Loads the job,
// hands its pinned input to startAutopilot, then stamps lastRunAt / lastRunId.
export async function runJobNow(id: string): Promise<RunState> {
  const jobs = await loadJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job) {
    throw new Error(`Scheduled job not found: ${id}`);
  }

  const { startAutopilot } = await import("./run-store");
  const run = await startAutopilot(job.input);

  const freshJobs = await loadJobs();
  const freshJob = freshJobs.find((entry) => entry.id === id);
  if (!freshJob) return run;
  const updated: ScheduledJob = {
    ...freshJob,
    lastRunAt: new Date().toISOString(),
    lastRunId: run.id,
  };
  await persist(freshJobs.map((entry) => (entry.id === id ? updated : entry)));
  void emitUpdated();
  return run;
}

// Automatic firing path (cron tick / interval loop / folder change): route the
// job's input through the overnight queue (enqueue + burnDown) so the queue's
// concurrency cap stays authoritative, then stamp lastRunAt. For folder triggers
// we inject the changed path into the run's note so the agent knows what fired.
async function fireJob(id: string, firedPath?: string): Promise<void> {
  const jobs = await loadJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job || !job.enabled) return;

  const input = firedPath ? injectTriggerNote(job.input, firedPath) : job.input;
  try {
    const { enqueue, burnDown } = await import("./run-queue");
    await enqueue({ title: job.name, input });
    void burnDown().catch((err: unknown) =>
      console.error("[scheduler] burnDown after fire failed:", err),
    );
  } catch (err) {
    console.error(`[scheduler] failed to fire job ${id}:`, err);
    return;
  }

  const freshJobs = await loadJobs();
  const freshJob = freshJobs.find((entry) => entry.id === id);
  if (!freshJob) return;
  const updated: ScheduledJob = {
    ...freshJob,
    lastRunAt: new Date().toISOString(),
    ...(firedPath ? { lastFiredPath: firedPath } : {}),
  };
  await persist(freshJobs.map((entry) => (entry.id === id ? updated : entry)));
  void emitUpdated();
}

function injectTriggerNote(input: StartAutopilotInput, firedPath: string): StartAutopilotInput {
  const prefix = input.initialUserNote ? `${input.initialUserNote}\n\n` : "";
  return {
    ...input,
    initialUserNote: `${prefix}[Automation] Triggered by a change at: ${firedPath}`,
  };
}

// ── Arming ─────────────────────────────────────────────────────────────────

function armJob(job: ScheduledJob): void {
  // Always disarm first so re-arming (toggle/edit) never leaks a timer.
  disarmJob(job.id);
  if (!job.enabled) return;
  const trigger = job.trigger;
  try {
    if (trigger.kind === "cron") {
      const cron = new Cron(trigger.expr, trigger.tz ? { timezone: trigger.tz } : {}, () => {
        void fireJob(job.id);
      });
      armed.set(job.id, () => cron.stop());
    } else if (trigger.kind === "interval") {
      const everyMs = Math.max(1000, Math.floor(trigger.everyMs));
      const handle = setInterval(() => {
        void fireJob(job.id);
      }, everyMs);
      armed.set(job.id, () => clearInterval(handle));
    } else {
      const stop = watchFolder(trigger, (path) => {
        void fireJob(job.id, path);
      });
      armed.set(job.id, stop);
    }
  } catch (err) {
    console.warn(`[scheduler] failed to arm job ${job.id}:`, err);
  }
}

function disarmJob(id: string): void {
  const disarm = armed.get(id);
  if (disarm) {
    try {
      disarm();
    } catch (err) {
      console.warn(`[scheduler] failed to disarm job ${id}:`, err);
    }
    armed.delete(id);
  }
}

export async function startScheduler(): Promise<void> {
  const jobs = await loadJobs();
  for (const job of jobs) armJob(job);
}

export function stopScheduler(): void {
  for (const disarm of armed.values()) {
    try {
      disarm();
    } catch {
      /* best effort during teardown */
    }
  }
  armed.clear();
}

// ── Folder watching ──────────────────────────────────────────────────────────
// A single non-recursive fs.watch on the folder (works on all OSes; recursive
// fs.watch is unsupported on Linux). fs.watch is noisy and on Windows often
// reports a null filename and fires before the writer commits, so we never trust
// individual events: a debounced full re-scan diffs the directory against a
// baseline snapshot to derive add/change/unlink. The baseline is taken at arm
// time so files that already exist do NOT fire on startup.
function watchFolder(
  trigger: Extract<AutomationTrigger, { kind: "folder" }>,
  onFire: (path: string) => void,
): () => void {
  const folder = trigger.path;
  const events = new Set(trigger.events);
  const debounceMs = trigger.debounceMs ?? 400;
  const matches = globMatcher(trigger.glob);

  let baseline = new Map<string, number>(); // filename -> mtimeMs
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function snapshot(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !matches(entry.name)) continue;
        try {
          const info = await fs.stat(join(folder, entry.name));
          out.set(entry.name, info.mtimeMs);
        } catch {
          /* file vanished between readdir and stat — skip */
        }
      }
    } catch (err) {
      console.warn("[scheduler] folder snapshot failed:", folder, err);
    }
    return out;
  }

  async function rescan(): Promise<void> {
    if (stopped) return;
    const current = await snapshot();
    for (const [name, mtime] of current) {
      const prev = baseline.get(name);
      if (prev === undefined) {
        if (events.has("add")) onFire(join(folder, name));
      } else if (mtime !== prev) {
        if (events.has("change")) onFire(join(folder, name));
      }
    }
    if (events.has("unlink")) {
      for (const name of baseline.keys()) {
        if (!current.has(name)) onFire(join(folder, name));
      }
    }
    baseline = current;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rescan();
    }, debounceMs);
  }

  // Take the baseline BEFORE watching so pre-existing files don't fire as adds.
  void snapshot().then((base) => {
    if (stopped) return;
    baseline = base;
    try {
      watcher = fsWatch(folder, { persistent: false }, () => schedule());
      watcher.on("error", (err) => console.warn("[scheduler] folder watch error:", folder, err));
    } catch (err) {
      console.warn("[scheduler] failed to watch folder:", folder, err);
    }
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    }
  };
}

// Minimal "*"-glob matched against a basename, case-insensitive. No glob (or "*")
// matches everything. We split on "*" and regex-escape the literal segments.
function globMatcher(glob?: string): (name: string) => boolean {
  if (!glob || glob === "*") return () => true;
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${pattern}$`, "i");
  return (name: string) => re.test(basename(name));
}
