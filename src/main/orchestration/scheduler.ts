import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { Cron } from "croner";
import type {
  AutomationDetail,
  AutomationRunRecord,
  AutomationState,
  AutomationTrigger,
  CreateScheduledJobInput,
  LoomWorkerConfig,
  RunState,
  ScheduledJob,
  StartAutopilotInput,
  UpdateScheduledJobInput,
} from "@shared/types";
import { AUTOMATION_HISTORY_CAP } from "@shared/types";
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

// Read-time migration seam. Tolerates (1) legacy jobs that stored a bare `cron`
// string before the trigger union existed, and (2) pre-loop jobs that lack the
// loop / state / history fields. Backfilling here means the cache always holds
// the current shape, and a loop:{kind:"once"} backfill reproduces the old
// one-shot firing behaviour exactly.
function normalizeJob(job: ScheduledJob): ScheduledJob {
  let next = job;
  if (!next.trigger && next.cron) {
    next = { ...next, trigger: { kind: "cron", expr: next.cron } };
  }
  if (!next.loop) {
    next = { ...next, loop: { kind: "once", stop: {} } };
  } else if (!next.loop.stop) {
    // A loop object persisted without its stop config (hand-authored or via a
    // caller that skipped it) must still satisfy the "stop always exists"
    // contract every consumer relies on.
    next = { ...next, loop: { ...next.loop, stop: {} } };
  }
  if (!next.state) {
    next = { ...next, state: { status: "idle", iteration: 0 } };
  }
  if (!Array.isArray(next.history)) {
    next = { ...next, history: [] };
  }
  if (!next.worker) {
    next = { ...next, worker: backfillWorker(next) };
  }
  // Looms v2.5: backfill the node graph LAST — after worker is guaranteed
  // defined — from the flat trigger/loop/prompt/worker fields. A pre-graph loom
  // becomes a single `w0` worker node with no edges, so planLoomLayers yields
  // {layers:[["w0"]]} and the executor's degenerate single-node path reproduces
  // the legacy linear pipeline byte-for-byte. The flat fields are NOT mutated:
  // the driver still reads loop/prompt/worker directly; the graph is additive.
  if (!next.graph) {
    next = {
      ...next,
      graph: {
        version: 1,
        nodes: [
          {
            id: "w0",
            kind: "worker",
            worker: next.worker,
            prompt: next.prompt?.template ?? next.input?.initialUserNote ?? "",
            isolate: next.loop?.isolate,
          },
        ],
        edges: [],
        entryNodeIds: ["w0"],
      },
    };
  }
  // Looms v2.5: enforce the bare-tool-name charset on worker-node blockedTools
  // at EVERY persistence path, not just editor saves (graphFromFlow) and the
  // MCP path (validateWorkerAccessFields). A raw scheduler IPC could otherwise
  // persist a scoped entry like "Bash(rm *)" that the claude CLI flag silently
  // ignores — a fence the user believes exists but doesn't. Same regex as
  // worker-access.ts BARE_TOOL_NAME; invalid entries are dropped, and a list
  // that empties disappears entirely (matching graphFromFlow's minimal shape).
  if (next.graph?.nodes.some((n) => n.kind === "worker" && n.blockedTools?.length)) {
    next = {
      ...next,
      graph: {
        ...next.graph,
        nodes: next.graph.nodes.map((n) => {
          if (n.kind !== "worker" || !n.blockedTools?.length) return n;
          const filtered = n.blockedTools.filter((t) => /^[A-Za-z][A-Za-z0-9_]*$/.test(t));
          if (filtered.length === n.blockedTools.length) return n;
          const { blockedTools: _dropped, ...rest } = n;
          return filtered.length > 0 ? { ...rest, blockedTools: filtered } : rest;
        }),
      },
    };
  }
  return next;
}

// Looms v2 migration: pre-worker jobs pinned an engine via input.chatBackend.
// claude/codex carry over with their model/effort; openrouter (the removed API
// manager) and undefined become "auto" — resolves to claude-when-installed but
// survives codex-only machines instead of dying engine-missing. The legacy
// chat* fields stay on the pinned input untouched (the driver never reads them).
function backfillWorker(job: ScheduledJob): LoomWorkerConfig {
  const legacy = job.input?.chatBackend;
  if (legacy === "claude" || legacy === "codex") {
    return {
      engine: legacy,
      model: job.input.chatModel?.trim() || undefined,
      effort: job.input.chatEffort,
    };
  }
  return { engine: "auto" };
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
  // A folder-triggered automation cannot arm against a path that does not yet
  // exist. Creating the explicitly configured watch directory is a reversible
  // part of creating the automation and avoids persisting a loom that silently
  // never fires. Output directories remain worker-owned and can be created on
  // the first iteration according to the prompt.
  if (input.trigger.kind === "folder") {
    await fs.mkdir(input.trigger.path, { recursive: true });
  }
  let job: ScheduledJob = {
    id: makeId("job"),
    name: input.name,
    trigger: input.trigger,
    // Default to enabled when the caller omits the flag.
    enabled: input.enabled ?? true,
    input: input.input,
    // A bare automation with no loop reproduces the legacy one-shot fire.
    loop: input.loop ?? { kind: "once", stop: {} },
    prompt: input.prompt,
    // Carry the caller's graph through; normalizeJob below backfills a single
    // w0 node when it is absent, so the cached job always has a graph (the loop
    // driver assumes job.graph is present post-normalize).
    graph: input.graph,
    state: { status: "idle", iteration: 0 },
    history: [],
    createdAt: new Date().toISOString(),
    worker: input.worker ?? { engine: "auto" },
    // Back-pointer to the architect chat that authored this loom (set by the
    // automation.create RPC for assist runs). Optional — undefined for
    // manual-editor looms; JSON.stringify drops it so the persisted shape is
    // unchanged for those.
    createdByRunId: input.createdByRunId,
  };
  if (!input.worker) job.worker = backfillWorker(job);
  // Re-normalize so a freshly created job lands in the cache with the same
  // backfilled shape it would have after a disk round-trip (graph in
  // particular). Idempotent for the already-set fields above.
  job = normalizeJob(job);
  await persist([...jobs, job]);
  armJob(job);
  void emitUpdated();
  return job;
}

// Edit an automation's definition (name / trigger / input / loop / prompt). Live
// state + history are NOT touched here. Re-arms when the trigger or enabled flag
// is affected so a changed schedule takes effect immediately.
export async function updateJob(input: UpdateScheduledJobInput): Promise<ScheduledJob> {
  const jobs = await loadJobs();
  const target = jobs.find((job) => job.id === input.id);
  if (!target) throw new Error(`Scheduled job not found: ${input.id}`);
  // normalizeJob re-runs on the merged result so a caller-supplied partial
  // shape (e.g. a loop without stop) can't re-introduce a malformed record.
  const updated: ScheduledJob = normalizeJob({
    ...target,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.loop !== undefined ? { loop: input.loop } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.worker !== undefined ? { worker: input.worker } : {}),
    ...(input.graph !== undefined ? { graph: input.graph } : {}),
  });
  await persist(jobs.map((job) => (job.id === input.id ? updated : job)));
  // Re-arm so a changed trigger schedule takes effect now.
  if (updated.enabled) armJob(updated);
  else disarmJob(updated.id);
  void emitUpdated();
  return updated;
}

// Loop-driver support: fetch a single job (fresh from cache).
export async function getJob(id: string): Promise<ScheduledJob | undefined> {
  const jobs = await loadJobs();
  return jobs.find((job) => job.id === id);
}

// Loop-driver support: read-modify-write a single job through the persist mutex
// so the cache + atomic write stay authoritative. `fn` receives the current job
// and returns its replacement. No-op when the id is unknown.
export async function patchJob(
  id: string,
  fn: (job: ScheduledJob) => ScheduledJob,
): Promise<ScheduledJob | undefined> {
  const jobs = await loadJobs();
  const target = jobs.find((job) => job.id === id);
  if (!target) return undefined;
  const next = fn(target);
  await persist(jobs.map((job) => (job.id === id ? next : job)));
  void emitUpdated();
  return next;
}

// Loop-driver support: append/replace a history record (matched by runId +
// iteration — iteration alone collides across loop cycles, since "Run now" and
// trigger re-fires reset the counter while history is retained) and set live
// state in one persisted write. Caps history length.
export async function appendHistory(
  id: string,
  record: AutomationRunRecord,
  state: Partial<AutomationState>,
): Promise<void> {
  await patchJob(id, (job) => {
    const history = [...job.history];
    const existing = history.findIndex(
      (r) => r.runId === record.runId && r.iteration === record.iteration,
    );
    if (existing >= 0) history[existing] = { ...history[existing], ...record };
    else history.push(record);
    // Newest-kept cap: drop oldest first.
    const capped = history.length > AUTOMATION_HISTORY_CAP ? history.slice(-AUTOMATION_HISTORY_CAP) : history;
    return { ...job, state: { ...job.state, ...state }, history: capped };
  });
}

// Resolve an automation + its live worker run for the Hub's detail pane.
export async function getDetail(id: string): Promise<AutomationDetail | null> {
  const job = await getJob(id);
  if (!job) return null;
  let liveRun: RunState | null = null;
  if (job.state.currentRunId) {
    try {
      const { getRun } = await import("./run-store");
      liveRun = await getRun(job.state.currentRunId);
    } catch {
      liveRun = null;
    }
  }
  return { job, liveRun };
}

// Pause an automation's LOOP without disarming its trigger: the loop won't
// advance and trigger fires hold while paused; once the user resumes (or the
// loop stops), the next trigger fire starts a fresh cycle.
export async function pauseJob(id: string): Promise<ScheduledJob | undefined> {
  const { pauseLoop } = await import("./automation-loop");
  await pauseLoop(id);
  return getJob(id);
}

// Resume a paused loop: flip back to idle, then RE-DRIVE it (the in-flight run
// may have finished during the pause, or still be live). Without the re-drive a
// manual/continuous/agent loom would be silently dead after pause+resume.
export async function resumeJob(id: string): Promise<ScheduledJob | undefined> {
  await patchJob(id, (job) => ({
    ...job,
    state: { ...job.state, status: job.state.status === "paused" ? "idle" : job.state.status },
  }));
  const { resumeLoop } = await import("./automation-loop");
  await resumeLoop(id);
  return getJob(id);
}

// Stop an automation's loop now (finalize + force-pause the live run).
export async function stopJob(id: string): Promise<ScheduledJob | undefined> {
  const { stopLoop } = await import("./automation-loop");
  await stopLoop(id);
  return getJob(id);
}

export async function deleteJob(id: string): Promise<void> {
  const jobs = await loadJobs();
  if (!jobs.some((job) => job.id === id)) return; // idempotent
  disarmJob(id);
  // Stop the live worker BEFORE removing the job: stopLoop resolves the run
  // through getJob (it must run while the registry still holds the record),
  // and deleting first would orphan a headless CLI worker that keeps editing
  // the workspace with every UI surface that could see or stop it gone.
  // fireDependents:false — deleting loom A must not kick off onFinishOf(A).
  try {
    const { stopLoop } = await import("./automation-loop");
    await stopLoop(id, { fireDependents: false });
  } catch {
    /* best-effort — never block deletion on a stop failure */
  }
  // Re-read: stopLoop's finalize re-persists the registry; filtering the
  // pre-stop snapshot would clobber that write (and any concurrent patch).
  await persist((await loadJobs()).filter((job) => job.id !== id));
  void emitUpdated();
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

// "Run now": start (or restart) the automation's loop by hand immediately, and
// return the live RunState so the caller can jump to it. Delegates to the loop
// driver, which resets the loop's iteration counter for a fresh manual pass.
export async function runJobNow(id: string): Promise<RunState> {
  const { runNow } = await import("./automation-loop");
  return runNow(id);
}

// One firing path now: every trigger (cron tick / interval loop / folder change
// / continuous arm / chain) hands off to the loop driver, which owns iterations
// 1..N, stop conditions, and history. Kept exported under the old name so any
// stray caller still works.
export async function fireJob(id: string, firedPath?: string): Promise<void> {
  await startIterationViaDriver(id, { source: "trigger", firedPath });
}

async function startIterationViaDriver(
  id: string,
  opts: { source: "trigger" | "continuous" | "manual"; firedPath?: string },
): Promise<void> {
  try {
    const { startIteration } = await import("./automation-loop");
    await startIteration(id, opts);
  } catch (err) {
    console.error(`[scheduler] failed to start loop iteration for ${id}:`, err);
  }
}

// Merge a folder trigger's changed path into the run note so the agent knows
// what fired. Exported for the loop driver's prompt rendering.
export function injectTriggerNote(input: StartAutopilotInput, firedPath: string): StartAutopilotInput {
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
    switch (trigger.kind) {
      case "cron": {
        const cron = new Cron(trigger.expr, trigger.tz ? { timezone: trigger.tz } : {}, () => {
          void startIterationViaDriver(job.id, { source: "trigger" });
        });
        armed.set(job.id, () => cron.stop());
        break;
      }
      case "interval": {
        const everyMs = Math.max(1000, Math.floor(trigger.everyMs));
        const handle = setInterval(() => {
          void startIterationViaDriver(job.id, { source: "trigger" });
        }, everyMs);
        armed.set(job.id, () => clearInterval(handle));
        break;
      }
      case "folder": {
        const stop = watchFolder(trigger, (path) => {
          void startIterationViaDriver(job.id, { source: "trigger", firedPath: path });
        });
        armed.set(job.id, stop);
        break;
      }
      case "manual": {
        // Never armed — only "Run now" (or a chain head) starts a manual loom.
        break;
      }
      case "continuous": {
        // Start iteration 0 immediately on a microtask so arming stays sync.
        armed.set(job.id, () => {});
        queueMicrotask(() => {
          void startIterationViaDriver(job.id, { source: "continuous" });
        });
        break;
      }
      case "onFinishOf": {
        // Register the dependency with the driver; disarm unregisters it.
        const sourceId = trigger.automationId;
        void import("./automation-loop").then((m) => m.registerOnFinishOf(sourceId, job.id));
        armed.set(job.id, () => {
          void import("./automation-loop").then((m) => m.unregisterOnFinishOf(sourceId, job.id));
        });
        break;
      }
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
  // Re-attach to / re-decide any loops that were mid-flight when the app closed.
  try {
    const { resumeLoops } = await import("./automation-loop");
    await resumeLoops();
  } catch (err) {
    console.error("[scheduler] resumeLoops failed:", err);
  }
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
  // Tear down loop watchers/timers too (best-effort; fire-and-forget on quit).
  void import("./automation-loop")
    .then((m) => m.teardownAllLoops())
    .catch(() => {});
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
