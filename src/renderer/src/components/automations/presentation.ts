import type {
  AutomationLoop,
  AutomationStatus,
  AutomationStopReason,
  AutomationTrigger,
  LoomWorkerConfig,
  LoomWorkerNode,
  ScheduledJob,
} from "@shared/types";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "@shared/types";
import { workerModelLabel } from "./worker-models";

// Shared presentation vocabulary for the Automations surfaces (Hub list +
// detail, Workers sub-tab, MiniFlow strip, node-flow editor). One place so a
// loom reads identically everywhere.

export function automationDotColor(status: AutomationStatus): string {
  switch (status) {
    case "running":
      return "var(--accent)";
    case "blocked":
      return "var(--danger)";
    case "paused":
      return "var(--info)";
    case "stopped":
      return "var(--muted)";
    default:
      return "var(--muted-2)";
  }
}

export function statusWord(status: AutomationStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export const STOP_REASON_LABEL: Record<AutomationStopReason, string> = {
  "agent-done": "agent finished",
  "agent-no-signal": "agent gave no signal",
  "max-iterations": "max iterations",
  budget: "budget reached",
  phrase: "phrase matched",
  "tests-pass": "tests passed",
  "git-clean": "git clean",
  "until-command": "condition met",
  once: "done",
  "iteration-failed": "iteration failed",
  "user-stop": "stopped by you",
  "engine-missing": "engine not installed",
};

export function triggerSummary(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return trigger.tz ? `cron ${trigger.expr} (${trigger.tz})` : `cron ${trigger.expr}`;
    case "interval": {
      const minutes = trigger.everyMs / 60_000;
      return Number.isInteger(minutes)
        ? `every ${minutes} min`
        : `every ${Math.round(trigger.everyMs / 1000)} sec`;
    }
    case "folder": {
      const events = trigger.events.length ? trigger.events.join(", ") : "any";
      return `folder ${trigger.glob ? trigger.glob + " " : ""}on ${events}`;
    }
    case "manual":
      return "manual";
    case "continuous":
      return "continuous";
    case "onFinishOf":
      return "after another loom";
    default:
      return "trigger";
  }
}

export function loopSummary(loop: AutomationLoop): string {
  switch (loop.kind) {
    case "once":
      return "once";
    case "count":
      return `${loop.stop?.maxIterations ?? 1}×`;
    case "cadence": {
      const minutes = (loop.everyMs ?? 60_000) / 60_000;
      return Number.isInteger(minutes)
        ? `every ${minutes} min`
        : `every ${Math.round((loop.everyMs ?? 0) / 1000)}s`;
    }
    case "until":
      return "until condition";
    case "continuous":
      return "continuous";
    case "agent":
      return "agent-driven";
    default:
      return loop.kind;
  }
}

export function capLabelForLoop(loop: AutomationLoop): string {
  const m = loop.stop?.maxIterations;
  if (typeof m === "number" && m > 0) return String(m);
  if (loop.kind === "count") return String(m ?? 1);
  if (loop.kind === "once") return "1";
  // agent / continuous / until / cadence all fall back to the engine default.
  return String(DEFAULT_AGENT_MAX_ITERATIONS);
}

export function capLabel(job: ScheduledJob): string {
  return capLabelForLoop(job.loop);
}

// The Worker node's one-line identity: "Opus 5 · high". Accepts any carrier of
// model/effort (worker configs, live AutomationWorkerInfo rows).
export function workerSummary(worker: Partial<LoomWorkerConfig> | undefined): string {
  if (!worker) return "Worker";
  const parts: string[] = [workerModelLabel(worker.model)];
  if (worker.effort) parts.push(worker.effort);
  return parts.join(" · ");
}

// The JOB's worker identity for headers/list rows. Graph looms summarize
// their actual worker nodes. Single-worker graphs keep the full
// model · effort line; wider graphs count per model.
export function jobWorkerSummary(job: ScheduledJob): string {
  const nodes = job.graph?.nodes ?? [];
  const workers = nodes.filter((n): n is LoomWorkerNode => n.kind === "worker");
  // Looms v3: a steps-only loom runs no model at all — say so instead of
  // echoing the (unused) flat worker default.
  if (workers.length === 0 && nodes.some((n) => n.kind === "step")) {
    const steps = nodes.filter((n) => n.kind === "step").length;
    return `${steps} step${steps === 1 ? "" : "s"} · no AI`;
  }
  if (workers.length === 0) return workerSummary(job.worker);
  if (workers.length === 1) return workerSummary(workers[0].worker);
  const counts = new Map<string, number>();
  for (const w of workers) {
    const word = workerModelLabel(w.worker.model);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const models = [...counts.entries()]
    .map(([word, n]) => (n > 1 ? `${word} ×${n}` : word))
    .join(" + ");
  return `${workers.length} workers · ${models}`;
}

export function fmtTime(value: string | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtClock(value: string | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtUsd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

export function fmtElapsed(sinceIso: string | undefined, nowMs: number): string {
  if (!sinceIso) return "—";
  const start = Date.parse(sinceIso);
  if (!Number.isFinite(start)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// The left-list sub-line: the at-a-glance "what is this loom doing".
// Job-level state — folds the enabled flag into the run status so every
// surface can say whether a quiet loom is ARMED (trigger live, will fire) or
// PAUSED (disarmed). Live statuses win over the flag; "stopped" with the
// trigger still enabled reads as armed again (the next fire starts fresh).
export type LoomStateKind = "running" | "blocked" | "passPaused" | "armed" | "paused";
export function loomState(job: ScheduledJob): { kind: LoomStateKind; label: string; color: string } {
  const s = job.state.status;
  if (s === "running") return { kind: "running", label: "running", color: "var(--accent)" };
  if (s === "blocked") return { kind: "blocked", label: "needs you", color: "var(--danger)" };
  if (s === "paused") return { kind: "passPaused", label: "pass paused", color: "var(--info)" };
  if (!job.enabled) return { kind: "paused", label: "paused", color: "var(--muted)" };
  return { kind: "armed", label: "armed", color: "var(--warn)" };
}

export function liveCue(job: ScheduledJob): string {
  const s = job.state;
  if (s.status === "running") return `iter ${s.iteration}/${capLabel(job)}`;
  if (s.status === "blocked") return "needs you";
  if (s.status === "paused") return "paused";
  if (s.status === "stopped") {
    return s.lastStopReason ? `stopped · ${STOP_REASON_LABEL[s.lastStopReason]}` : "stopped";
  }
  if (s.nextFireAt) return `next ${fmtClock(s.nextFireAt)}`;
  return "idle";
}
