import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CreateScheduledJobInput, RunState, ScheduledJob } from "@shared/types";
import { makeId } from "@shared/ids";
import { writeFileAtomic } from "../fs-atomic";
import { sparkHome } from "../spark-home";
import { startAutopilot } from "./run-store";

// Scheduler registry ─────────────────────────────────────────────────────────
// A registry of saved cron-style jobs. Each job pins a StartAutopilotInput and a
// cron expression; firing it enqueues that autopilot run. SCAFFOLD: cron parsing
// and timer firing are stubbed (see startScheduler/stopScheduler below) — for
// now jobs are persisted and can only be fired by hand via runJobNow().
//
// Persisted as a single JSON file next to spark-state.json / spark-settings.json
// (covered implicitly by the migration in spark-home.ts). The on-disk shape is
// versioned-by-convention via the `jobs` envelope so a future migration can add
// sibling fields without reinterpreting a bare array.
const SCHEDULER_FILE = "scheduler.json";

interface SchedulerFile {
  jobs: ScheduledJob[];
}

// In-process cache + write serialization, mirroring preferences-store.ts. The
// cache means repeated list/mutate calls in one boot pay a single fs.readFile;
// chaining `writing` keeps concurrent mutations from racing the atomic write.
let cache: ScheduledJob[] | null = null;
let writing: Promise<void> = Promise.resolve();

function schedulerPath(): string {
  return join(sparkHome(), SCHEDULER_FILE);
}

async function readFromDisk(): Promise<ScheduledJob[]> {
  try {
    const raw = await fs.readFile(schedulerPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerFile>;
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
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

export async function listJobs(): Promise<ScheduledJob[]> {
  // Return a shallow copy so callers (IPC handlers) can't mutate the cache.
  return [...(await loadJobs())];
}

export async function createJob(input: CreateScheduledJobInput): Promise<ScheduledJob> {
  const jobs = await loadJobs();
  const job: ScheduledJob = {
    id: makeId("job"),
    name: input.name,
    cron: input.cron,
    // Default to enabled when the caller omits the flag.
    enabled: input.enabled ?? true,
    input: input.input,
    createdAt: new Date().toISOString(),
  };
  await persist([...jobs, job]);
  return job;
}

export async function deleteJob(id: string): Promise<void> {
  const jobs = await loadJobs();
  const next = jobs.filter((job) => job.id !== id);
  // No-op (but still persist) when the id is unknown — keeps the call idempotent.
  if (next.length !== jobs.length) {
    await persist(next);
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
  return updated;
}

// Fire a job by hand right now, bypassing the (stubbed) cron schedule. Loads the
// job, hands its pinned input to startAutopilot, then stamps lastRunAt /
// lastRunId from the created run so the panel can link back to it.
export async function runJobNow(id: string): Promise<RunState> {
  const jobs = await loadJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job) {
    throw new Error(`Scheduled job not found: ${id}`);
  }

  const run = await startAutopilot(job.input);

  const updated: ScheduledJob = {
    ...job,
    lastRunAt: new Date().toISOString(),
    lastRunId: run.id,
  };
  await persist(jobs.map((entry) => (entry.id === id ? updated : entry)));
  return run;
}

// TODO(overnight-queue): real cron parsing + timer firing is DEFERRED until the
// daemon split lands. The whole point of the scheduler is to fire jobs while the
// renderer (and ideally the whole UI process) is closed; wiring node-cron timers
// into the Electron main process here would only fire while the app is open,
// which defeats the feature and risks double-firing once the daemon also runs.
// Until then startScheduler/stopScheduler are intentional NO-OPs and jobs can
// only be triggered manually via runJobNow(). See docs/overnight-queue-PLAN.md
// for the full build (cron evaluation, per-job timers, enqueue-on-fire, and the
// `ScheduledJobStatus` idle/running transition that becomes meaningful then).
export function startScheduler(): void {
  // NO-OP stub — see TODO above.
}

export function stopScheduler(): void {
  // NO-OP stub — see TODO above.
}
