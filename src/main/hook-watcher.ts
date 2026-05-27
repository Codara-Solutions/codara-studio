// Hook watcher — the consumer half of the "CLI hook ingestion" big-bet.
// Watches <spark-home>/hooks/ for JSON files dropped by `spark-hook.py`,
// reads each file, routes the event to run-store, then moves the file to
// <spark-home>/hooks/processed/ so we don't reprocess it on app restart.
//
// Design rules
// ------------
// 1. fs.watch (not chokidar) — Spark already uses fs.watch elsewhere
//    (fs-watcher.ts) and the burst rate here is small (a tool-heavy Claude
//    turn might produce 30-50 files; not 30k). Falling back to a scan on
//    "rename" events keeps Windows/macOS quirks from dropping events.
// 2. Race-safe reads — when fs.watch fires on a new file, the writer's
//    `os.replace()` may not have committed the rename yet on Windows. We
//    open-read with a small retry/backoff (200ms × 3) before giving up.
// 3. Self-healing — the hooks dir is auto-created on start. If it's deleted
//    out from under us mid-run, we re-create on the next tick and re-arm.
// 4. Malformed input is dropped, not crashed. We log once per file with the
//    parse error and the raw bytes (capped to 1KiB) so the user can diagnose.
// 5. Routing rules:
//      Notification     → applyHookStateReport({state: "blocked"})
//      Stop / SubagentStop → applyHookStateReport({state: "done"})
//      SessionStart     → appendEvent + capture session_id from payload
//      every other hook → appendEvent only (PreToolUse, PostToolUse,
//                         UserPromptSubmit, PreCompact, ...)

import { promises as fs, type FSWatcher } from "node:fs";
import { watch as fsWatch } from "node:fs";
import { join } from "node:path";

import { sparkHome } from "./spark-home";

type RunStoreModule = typeof import("./orchestration/run-store");

const HOOKS_SUBDIR = "hooks";
const PROCESSED_SUBDIR = "processed";

// Files we drop into hooks/ are uuid.json — anything else is either our own
// tmp file (".tmp" suffix from the python writer) or unrelated user noise we
// should ignore. The python writer renames .tmp → uuid.json atomically so we
// never read a half-written file.
const HOOK_FILE_PATTERN = /\.json$/i;
const TMP_FILE_PATTERN = /\.tmp$/i;

// Race-safe read: on Windows the fs.watch event fires before os.replace()
// has finished committing, so the first open can ENOENT or hand us a 0-byte
// file. Retry a few times with short backoff. Three tries at 60/120/240 ms
// covers every observed delay in dev; if it still fails after that the file
// is genuinely broken / missing and we drop.
const READ_RETRIES = 3;
const READ_RETRY_BASE_MS = 60;

// Cap on the bytes we'll read from a single hook file. Real hook payloads
// (PreToolUse for a large tool input) can be a few KB; 256 KiB is the cap
// from above which we treat the file as hostile/corrupt and drop it.
const MAX_HOOK_FILE_BYTES = 256 * 1024;

// Debounce window when fs.watch sees a "rename" event but the file name is
// missing (Windows on some volumes). We rescan the directory and process
// any new uuid.json files. Set high enough that we coalesce a 30-event
// burst into one scan; low enough that we still feel real-time.
const RESCAN_DEBOUNCE_MS = 50;

interface WatcherState {
  hooksDir: string;
  processedDir: string;
  watcher: FSWatcher | null;
  // Files we've already kicked off processing for in this process lifetime.
  // Prevents the same uuid being handled twice if fs.watch sends duplicate
  // events (which it can — same inode, different listeners on macOS).
  inFlight: Set<string>;
  // Set when stopHookWatcher() is called; we use this to bail out of any
  // pending retries / rescans so shutdown is prompt.
  stopped: boolean;
  // Rescan debounce timer for the directory-level fallback path.
  rescanTimer: NodeJS.Timeout | null;
  // Lazy-resolved run-store. We use a Promise so concurrent dispatches
  // share the import.
  runStorePromise: Promise<RunStoreModule> | null;
}

let active: WatcherState | null = null;

// Wrapper that the Python script emits. We re-validate every field at the
// read site because the file may have been hand-edited or corrupted. Both
// `paneId` and `payload` may be empty strings / null respectively when the
// script's stdin/env was empty; we propagate that to run-store which then
// drops the event (no worker to attach to).
interface HookFileEnvelope {
  hookName: string;
  timestamp: string;
  paneId: string;
  payload: unknown;
  parseError?: string;
}

export async function startHookWatcher(): Promise<void> {
  if (active) return;

  const hooksDir = join(sparkHome(), HOOKS_SUBDIR);
  const processedDir = join(hooksDir, PROCESSED_SUBDIR);

  try {
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.mkdir(processedDir, { recursive: true });
  } catch (err) {
    console.warn("[hook-watcher] failed to ensure hooks dir:", err);
    // We still register state so a later directory-create observed elsewhere
    // doesn't double-start the watcher.
  }

  const state: WatcherState = {
    hooksDir,
    processedDir,
    watcher: null,
    inFlight: new Set(),
    stopped: false,
    rescanTimer: null,
    runStorePromise: null,
  };
  active = state;

  // Pick up any files that were dropped while Spark was shut down. Without
  // this, a long-running Claude session that emitted hooks during a crash
  // would have those events lost forever.
  void rescanDirectory(state).catch((err) =>
    console.warn("[hook-watcher] initial rescan failed:", err),
  );

  try {
    const watcher = fsWatch(hooksDir, { persistent: true }, (_eventType, filename) => {
      if (state.stopped) return;
      if (filename && typeof filename === "string") {
        const name = filename.toString();
        if (TMP_FILE_PATTERN.test(name)) return;
        if (HOOK_FILE_PATTERN.test(name)) {
          void handleFile(state, name).catch((err) =>
            console.warn("[hook-watcher] handle failed:", err),
          );
          return;
        }
      }
      // Filename missing (Windows on some volumes) OR the event was a
      // rename of an unrelated file (e.g. the python tmp file). Schedule a
      // debounced rescan so we don't miss any newly-arrived hook files.
      if (state.rescanTimer === null) {
        state.rescanTimer = setTimeout(() => {
          state.rescanTimer = null;
          void rescanDirectory(state).catch((err) =>
            console.warn("[hook-watcher] rescan failed:", err),
          );
        }, RESCAN_DEBOUNCE_MS);
      }
    });
    watcher.on("error", (err) => {
      console.warn("[hook-watcher] fs.watch error:", err);
    });
    state.watcher = watcher;
  } catch (err) {
    console.warn("[hook-watcher] failed to start fs.watch on", hooksDir, ":", err);
  }
}

export async function stopHookWatcher(): Promise<void> {
  if (!active) return;
  const state = active;
  state.stopped = true;
  if (state.rescanTimer !== null) {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = null;
  }
  try {
    state.watcher?.close();
  } catch (err) {
    console.warn("[hook-watcher] watcher.close threw:", err);
  }
  active = null;
}

async function rescanDirectory(state: WatcherState): Promise<void> {
  if (state.stopped) return;
  let entries: string[];
  try {
    entries = await fs.readdir(state.hooksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Directory disappeared (user wiped ~/.SparkAgent); re-create on the
      // next event tick. fs.watch is now bound to a deleted inode; restart.
      try {
        await fs.mkdir(state.hooksDir, { recursive: true });
        await fs.mkdir(state.processedDir, { recursive: true });
      } catch (mkErr) {
        console.warn("[hook-watcher] failed to recreate hooks dir:", mkErr);
      }
      return;
    }
    console.warn("[hook-watcher] readdir failed:", err);
    return;
  }
  for (const name of entries) {
    if (!HOOK_FILE_PATTERN.test(name)) continue;
    if (TMP_FILE_PATTERN.test(name)) continue;
    void handleFile(state, name).catch((err) =>
      console.warn("[hook-watcher] handle failed:", err),
    );
  }
}

async function handleFile(state: WatcherState, filename: string): Promise<void> {
  if (state.stopped) return;
  if (state.inFlight.has(filename)) return;
  state.inFlight.add(filename);
  try {
    const filePath = join(state.hooksDir, filename);

    // Race-safe read with retry. ENOENT and zero-byte reads both indicate
    // the writer hasn't finished the os.replace yet.
    let raw: string | null = null;
    for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
      if (state.stopped) return;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          // Probably a directory entry (e.g. the processed/ subdir surfaced
          // as a watch event). Nothing to do.
          return;
        }
        if (stat.size === 0) {
          await delay(READ_RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        if (stat.size > MAX_HOOK_FILE_BYTES) {
          console.warn(
            "[hook-watcher] dropping oversized hook file",
            filename,
            "size:",
            stat.size,
          );
          await dropFile(filePath);
          return;
        }
        raw = await fs.readFile(filePath, "utf8");
        if (raw.length > 0) break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // File renamed away (processed by another instance? unlikely) or
          // not yet finalised — back off and retry.
          await delay(READ_RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    if (raw === null || raw.length === 0) {
      // Gave up — drop quietly so we don't keep retrying every fs.watch tick.
      await dropFile(filePath);
      return;
    }

    let envelope: HookFileEnvelope | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        envelope = {
          hookName: typeof obj.hookName === "string" ? obj.hookName : "unknown",
          timestamp:
            typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString(),
          paneId: typeof obj.paneId === "string" ? obj.paneId : "",
          payload: obj.payload === undefined ? null : obj.payload,
          parseError: typeof obj.parseError === "string" ? obj.parseError : undefined,
        };
      }
    } catch (err) {
      console.warn(
        "[hook-watcher] malformed hook file",
        filename,
        (err as Error).message,
        "preview:",
        raw.slice(0, 1024),
      );
    }

    if (envelope) {
      try {
        await dispatchEnvelope(state, envelope);
      } catch (err) {
        console.warn("[hook-watcher] dispatch failed for", filename, err);
      }
    }

    await moveToProcessed(state, filePath, filename);
  } finally {
    state.inFlight.delete(filename);
  }
}

async function dispatchEnvelope(state: WatcherState, envelope: HookFileEnvelope): Promise<void> {
  // No paneId means we can't tie the event to a worker (the python script
  // landed without SPARK_PANE_ID in env — happens if the user launched
  // Claude outside Spark's orchestrator). We still log + drop here; a future
  // "ambient hook surface" can pick these up.
  if (!envelope.paneId) {
    return;
  }

  const runStore = await loadRunStore(state);
  if (!runStore) return;

  const payloadObj =
    envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
      ? (envelope.payload as Record<string, unknown>)
      : null;

  switch (envelope.hookName) {
    case "Notification": {
      // Notifications fire when Claude needs human input (permission prompt,
      // model question). Surface as blocked so the UI's attention rollup
      // catches it. The note picks the most useful free text on the payload
      // — Claude commonly includes `message` for permission prompts.
      const note = stringField(payloadObj, ["message", "text", "title", "reason"]);
      runStore.applyHookStateReport({
        paneId: envelope.paneId,
        state: "blocked",
        ...(note ? { note } : {}),
      });
      // Also append the raw event so the Session Inspector can replay it.
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: note ?? "Worker requesting attention",
      });
      return;
    }
    case "Stop":
    case "SubagentStop": {
      runStore.applyHookStateReport({
        paneId: envelope.paneId,
        state: "done",
      });
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: envelope.hookName === "SubagentStop" ? "Sub-agent stopped" : "Worker stopped",
      });
      return;
    }
    case "SessionStart": {
      // SessionStart carries the new session id, which Spark uses for
      // `claude -r <uuid>` resume. We append the event with the id surfaced
      // as a top-level field so a future "agent-resume on restore" big-bet
      // can pull it without re-parsing the payload.
      const sessionId = stringField(payloadObj, [
        "session_id",
        "sessionId",
        "id",
      ]);
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: sessionId
          ? { ...(payloadObj ?? {}), sessionId }
          : payloadObj,
        timestamp: envelope.timestamp,
        message: sessionId ? `Session started: ${sessionId}` : "Session started",
      });
      return;
    }
    case "PreToolUse":
    case "PostToolUse": {
      const tool = stringField(payloadObj, ["tool_name", "toolName", "tool"]);
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: tool
          ? `${envelope.hookName}: ${tool}`
          : envelope.hookName,
      });
      return;
    }
    case "UserPromptSubmit": {
      const promptPreview = stringField(payloadObj, ["prompt", "input", "message"]);
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: promptPreview
          ? `User prompt: ${truncate(promptPreview, 120)}`
          : "User prompt submitted",
      });
      return;
    }
    case "PreCompact": {
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
        message: "Context compaction starting",
      });
      return;
    }
    default: {
      // Unknown / future hook events still land in the event log so we don't
      // silently drop anything. A user investigating a new Claude release
      // can grep the log for hook.<unknown> and see what arrived.
      runStore.applyHookEvent({
        paneId: envelope.paneId,
        hookName: envelope.hookName,
        payload: payloadObj,
        timestamp: envelope.timestamp,
      });
    }
  }
}

async function moveToProcessed(
  state: WatcherState,
  filePath: string,
  filename: string,
): Promise<void> {
  const target = join(state.processedDir, filename);
  try {
    await fs.rename(filePath, target);
  } catch (err) {
    // Rename can fail if processed/ was deleted out from under us, or on
    // Windows when another process briefly held the file open. Try unlink as
    // a fallback so we don't loop forever on the same file.
    try {
      await fs.mkdir(state.processedDir, { recursive: true });
      await fs.rename(filePath, target);
    } catch {
      try {
        await fs.unlink(filePath);
      } catch (unlinkErr) {
        const code = (unlinkErr as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(
            "[hook-watcher] failed to move/unlink",
            filePath,
            "rename err:",
            err,
            "unlink err:",
            unlinkErr,
          );
        }
      }
    }
  }
}

async function dropFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[hook-watcher] dropFile failed:", err);
    }
  }
}

async function loadRunStore(state: WatcherState): Promise<RunStoreModule | null> {
  if (!state.runStorePromise) {
    state.runStorePromise = import("./orchestration/run-store");
  }
  try {
    return await state.runStorePromise;
  } catch (err) {
    console.warn("[hook-watcher] run-store import failed:", err);
    state.runStorePromise = null;
    return null;
  }
}

function stringField(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test / diagnostic helpers. Lets future ipc handlers / Session Inspector
// surface whether the watcher is currently armed without re-implementing
// the state lookup.
export function isHookWatcherActive(): boolean {
  return active !== null && active.stopped === false;
}
