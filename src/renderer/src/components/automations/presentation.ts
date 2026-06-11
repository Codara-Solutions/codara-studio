import type {
  AutomationLoop,
  AutomationStatus,
  AutomationStopReason,
  AutomationTrigger,
  LoomWorkerConfig,
  ScheduledJob,
} from "@shared/types";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "@shared/types";

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
      return `${loop.stop.maxIterations ?? 1}×`;
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
  const m = loop.stop.maxIterations;
  if (typeof m === "number" && m > 0) return String(m);
  if (loop.kind === "count") return String(m ?? 1);
  if (loop.kind === "once") return "1";
  // agent / continuous / until / cadence all fall back to the engine default.
  return String(DEFAULT_AGENT_MAX_ITERATIONS);
}

export function capLabel(job: ScheduledJob): string {
  return capLabelForLoop(job.loop);
}

const ENGINE_WORD: Record<LoomWorkerConfig["engine"], string> = {
  claude: "Claude",
  codex: "Codex",
  auto: "Auto",
};

// The Worker node's one-line identity: "Claude · claude-opus-4-8 · high".
export function workerSummary(worker: LoomWorkerConfig | undefined): string {
  if (!worker) return "Auto";
  const parts: string[] = [ENGINE_WORD[worker.engine] ?? worker.engine];
  if (worker.engine !== "auto") {
    parts.push(worker.model ?? "default model");
    if (worker.effort) parts.push(worker.effort);
  } else {
    parts.push("agent picks");
  }
  return parts.join(" · ");
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
