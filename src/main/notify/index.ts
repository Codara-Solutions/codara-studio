import type { BrowserWindow } from "electron";
import { makeId } from "@shared/ids";
import type {
  NotifyEvent,
  RunStatus,
  SparkEvent,
  TerminalAgentStatePayload,
} from "@shared/types";
import { subscribeToEvents } from "../orchestration/event-log";
import { getPreferenceCached, loadPreferences } from "../preferences-store";
import { isWatchingPane, isWatchingRun } from "./attention";
import {
  activeWindow,
  deliver,
  registerDeliveryWindow,
  signalTerminalAttention,
} from "./deliver";
import { recordToCenter } from "./center-store";
import {
  clearLastAlerted,
  createPolicyState,
  decide,
  rearm as policyRearm,
} from "./policy";
import type { PublishInput } from "./types";

// Unified notifications pipeline: producers (run adapter below,
// terminal-agent-notify, automation-loop) call publish(); the pure policy
// decides; every recorded event lands in the center history; delivered ones
// fan out across the four channels in deliver.ts. One attention tracker
// (attention.ts) feeds the suppress-while-watching rules for all producers.

export { setAttention } from "./attention";
export {
  clearCenter,
  flushNotificationCenter,
  listCenterEntries,
  markCenterAllRead,
  markCenterRead,
  removeCenterEntry,
} from "./center-store";
export type { PublishInput } from "./types";

const state = createPolicyState();

// Canonical sourceKey builders — one per producer family.
export const runSourceKey = (runId: string): string => `run:${runId}`;
export const paneSourceKey = (paneId: string): string => `pane:${paneId}`;
export const automationSourceKey = (jobId: string): string => `automation:${jobId}`;

function watchingTarget(event: PublishInput): boolean {
  const target = event.target;
  if (target.type === "run") return isWatchingRun(target.runId);
  if (target.type === "terminal") {
    return isWatchingPane(target.workspaceId, target.tabId, target.paneId);
  }
  // Teammate-push alerts (workspace targets) have no exact surface either —
  // being in the workspace doesn't mean the Source Control graph is on
  // screen — so they always alert (DND still mutes). The auto-fetcher does
  // its own "did anything change" gating before publishing.
  if (target.type === "workspace") return false;
  // No "watching an automation" surface exists; loop finishes always alert.
  return false;
}

export function publish(input: PublishInput): void {
  const event: NotifyEvent = {
    ...input,
    id: makeId("notify"),
    createdAt: new Date().toISOString(),
  };
  const decision = decide(
    { kind: event.kind, sourceKey: event.sourceKey },
    {
      watching: watchingTarget(input),
      dnd: getPreferenceCached("notificationsDnd") === true,
    },
    state,
  );
  if (decision.record) {
    void recordToCenter(event, {
      read: decision.read,
      suppressed: decision.deliver ? undefined : decision.reason,
    }).catch((err) => {
      console.warn("[notify] center record failed:", err);
    });
  }
  // DND mutes intrusive channels, not passive workspace/pane attention. An
  // unread terminal event still lights the rail so the user can find it later.
  // Watching-suppressed events are read and intentionally need no marker.
  if (
    event.target.type === "terminal" &&
    (decision.deliver || (decision.record && !decision.read))
  ) {
    signalTerminalAttention(event);
  }
  if (!decision.deliver) return;
  void loadPreferences()
    .then((prefs) => deliver(event, prefs.notificationChannels))
    .catch((err) => {
      console.warn("[notify] delivery failed:", err);
    });
}

// Real new activity on a source — clears the no-change memory + completion
// guard so its next alert delivers. Producers call this where work resumes
// (terminal working phase, automation iteration start); the run adapter
// below calls it on active status transitions.
export function rearm(sourceKey: string): void {
  policyRearm(state, sourceKey);
}

export function registerMainWindow(win: BrowserWindow): void {
  registerDeliveryWindow(win);
}

// ── Run adapter ──────────────────────────────────────────────────────────

// Statuses that count as "real new activity". paused/idle are intentionally
// excluded: a paused run (manager question via askHumanQuestion → pauseRun)
// is a quiescent wait, not resumed work, so it must NOT re-arm the blocked
// alert.
function isActiveStatus(status: RunStatus): boolean {
  return status === "running" || status === "planning" || status === "reviewing";
}

// When each run's current active phase began (ms epoch), for the "ran 12m"
// duration suffix on completions. Seeded on the first active transition we
// observe; runs already mid-flight at subscribe time get no duration.
const runActiveSince = new Map<string, number>();

// Event IDs are the lifecycle adapter's idempotency key. The policy's existing
// source/kind dedupe handles semantic re-emits; this bounded set additionally
// prevents the exact same canonical journal event from being delivered twice
// if a subscriber is registered twice or a bridge retries a live event.
const handledLifecycleEventIds = new Set<string>();
const MAX_HANDLED_LIFECYCLE_EVENT_IDS = 4_096;

function claimLifecycleEvent(eventId: string): boolean {
  if (handledLifecycleEventIds.has(eventId)) return false;
  handledLifecycleEventIds.add(eventId);
  if (handledLifecycleEventIds.size > MAX_HANDLED_LIFECYCLE_EVENT_IDS) {
    const oldest = handledLifecycleEventIds.values().next().value as string | undefined;
    if (oldest) handledLifecycleEventIds.delete(oldest);
  }
  return true;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function handleRunEvent(event: SparkEvent): void {
  // Only run-level status transitions alert; worker events fire many times
  // per run and would be pure noise.
  if (event.type !== "run.status_updated") return;

  const payload = event.payload as
    | {
        status?: unknown;
        previousStatus?: unknown;
        automationId?: unknown;
        questionMessageId?: unknown;
        blocker?: unknown;
      }
    | undefined;
  const status = typeof payload?.status === "string" ? (payload.status as RunStatus) : undefined;
  const prevStatus =
    typeof payload?.previousStatus === "string"
      ? (payload.previousStatus as RunStatus)
      : undefined;
  // Loom-owned runs stamp their automationId onto the status payload (run-store
  // emit sites). Present ⇒ this transition belongs to one automation iteration,
  // so terminal (complete/failed) pings are suppressed — the loop-level
  // automation.finished/failed (once per finalize) is the real end signal —
  // while a blocked iteration still alerts, as a distinct automation.blocked.
  const automationId =
    typeof payload?.automationId === "string" && payload.automationId.length > 0
      ? payload.automationId
      : undefined;
  const runId = event.runId;
  if (!status || !runId) return;
  if (prevStatus === status) return;
  if (!claimLifecycleEvent(event.id)) return;

  const sourceKey = runSourceKey(runId);

  if (
    status === "running" ||
    status === "planning" ||
    status === "reviewing" ||
    status === "paused" ||
    status === "idle"
  ) {
    if (isActiveStatus(status)) {
      rearm(sourceKey);
      if (!runActiveSince.has(runId)) {
        const startedMs = Date.parse(event.timestamp);
        if (Number.isFinite(startedMs)) runActiveSince.set(runId, startedMs);
      }
    } else {
      // paused/idle: allow a future re-entry into the same terminal status
      // to alert again, but keep the completion guard armed.
      clearLastAlerted(state, sourceKey);
    }
    return;
  }

  const workspaceId = event.workspaceId;

  if (status === "blocked") {
    const hasUserBlocker =
      (typeof payload?.questionMessageId === "string" && payload.questionMessageId.length > 0) ||
      (typeof payload?.blocker === "object" && payload.blocker !== null);
    if (!hasUserBlocker) return;
    if (automationId) {
      // A blocked loom iteration still needs the user (answer the question or
      // the loop hangs) — but it reads as its own automation family, and clicks
      // route via the automation target (jobId + the live run to answer in).
      // sourceKey stays run-scoped so the run's active transitions (the
      // running/planning/reviewing branch above rearms the source) let each
      // fresh blocked iteration alert again instead of being deduped.
      publish({
        kind: "automation.blocked",
        sourceKey,
        tone: "warning",
        title: "Automation — needs you",
        body: event.message?.trim() || "An automation is waiting on your answer.",
        soundKind: "needs-you",
        // workspaceId lets a cross-workspace click switch projects before
        // landing on the loom's hub/run (see routing.ts).
        target: { type: "automation", jobId: automationId, runId, workspaceId },
      });
      return;
    }
    publish({
      kind: "run.blocked",
      sourceKey,
      // A blocked run is the agent asking for you, not a failure — amber.
      tone: "warning",
      title: "Codara Studio — needs you",
      body: event.message?.trim() || "A run is blocked and needs your attention.",
      soundKind: "needs-you",
      target: { type: "run", runId, workspaceId },
    });
    return;
  }

  if (status === "complete" || status === "failed") {
    const startedMs = runActiveSince.get(runId);
    runActiveSince.delete(runId);
    // Loom-owned runs finalize once per iteration; the per-iteration terminal
    // ping would spam the user, so suppress it here (the runActiveSince cleanup
    // above still runs, so no per-run duration state leaks). The loop-level
    // automation.finished/failed published once per finalize by
    // automation-loop.ts is the truthful end-of-automation alert.
    if (automationId) return;
    const ok = status === "complete";
    let body =
      event.message?.trim() ||
      (ok ? "A run just finished while you were away." : "A run failed while you were away.");
    if (startedMs !== undefined) {
      const elapsed = Date.parse(event.timestamp) - startedMs;
      if (Number.isFinite(elapsed) && elapsed > 5 * 60_000) {
        body += ` — ran ${formatDuration(elapsed)}`;
      }
    }
    publish({
      kind: ok ? "run.complete" : "run.failed",
      sourceKey,
      tone: ok ? "success" : "danger",
      title: ok ? "Codara Studio — done" : "Codara Studio — failed",
      body,
      soundKind: "done",
      target: { type: "run", runId, workspaceId },
    });
  }
}

let started = false;

// Subscribe the run adapter to run-store events. Idempotent.
export function startNotifications(): void {
  if (started) return;
  started = true;
  // Warm the preference cache so getPreferenceCached("notificationsDnd")
  // reflects disk state from the first publish.
  void loadPreferences().catch(() => undefined);
  subscribeToEvents((event) => {
    try {
      handleRunEvent(event);
    } catch (err) {
      console.warn("[notify] run event handler threw:", err);
    }
  });
}

// ── Terminal-agent chip channel (NOT a notification) ─────────────────────
//
// Focus-independent live-state push for the terminal-agent worker chip. Sent
// by terminal-agent-notify.ts on every turn-boundary transition it detects on
// the raw pty stream, and crucially NOT gated by the suppress-while-watching
// policy: the chip must reflect "working → ready" even while the pane is
// hidden, which is the one case the renderer's visible-buffer poller can't
// cover. Pure send — no preference gate, no channel fanout.
export function emitTerminalAgentState(payload: TerminalAgentStatePayload): void {
  try {
    activeWindow()?.webContents.send("terminal-agent:state", payload);
  } catch {
    /* best-effort: chip update is non-critical */
  }
}
