import type { AppPreferences } from "./types";

// Keep the computer awake while agents work. The policy and the words the UI
// uses live here so the title-bar control, Settings and the main-process
// controller (src/main/keep-awake/) can never disagree about what a mode
// means or what counts as work.
//
// Every mode asks the OS to stay out of idle sleep only. The display may
// still turn off and the screen may still lock: agents need the machine, not
// the screen.

export type KeepAwakeMode = NonNullable<AppPreferences["keepAwakeMode"]>;

export const KEEP_AWAKE_MODES: ReadonlyArray<KeepAwakeMode> = ["off", "agents", "always"];

export const DEFAULT_KEEP_AWAKE_MODE: KeepAwakeMode = "agents";

export function normalizeKeepAwakeMode(value: unknown): KeepAwakeMode {
  return (KEEP_AWAKE_MODES as ReadonlyArray<unknown>).includes(value)
    ? (value as KeepAwakeMode)
    : DEFAULT_KEEP_AWAKE_MODE;
}

/** What is working right now, by kind. Any of it holds the machine awake in "agents" mode. */
export interface KeepAwakeActivity {
  /** Claude Code, Codex, Grok or Pi panes mid-turn. */
  terminalAgents: number;
  /** Cora chats with a manager turn or a worker running. */
  chats: number;
  /** Automations and workflows with live work. */
  automations: number;
  /** Cora and automation workers running. */
  workers: number;
}

export const NO_KEEP_AWAKE_ACTIVITY: KeepAwakeActivity = Object.freeze({
  terminalAgents: 0,
  chats: 0,
  automations: 0,
  workers: 0,
});

export interface KeepAwakeLidStatus {
  /**
   * This computer can stay awake with its lid closed without admin rights or
   * a change to its power settings. Only Linux laptops with systemd-logind
   * qualify; elsewhere the option is hidden.
   */
  supported: boolean;
  /** The user's choice (keepAwakeLidClosed). */
  enabled: boolean;
  /** The lid hold is taken right now. */
  active: boolean;
  /** Why the last attempt failed, while it keeps failing. */
  error: string | null;
}

export interface KeepAwakeStatus {
  mode: KeepAwakeMode;
  /** Codara holds the computer out of sleep right now. */
  holding: boolean;
  activity: KeepAwakeActivity;
  lid: KeepAwakeLidStatus;
  /** Set when the OS refused the hold. */
  error: string | null;
}

export function workingCount(activity: KeepAwakeActivity): number {
  return activity.terminalAgents + activity.chats + activity.automations + activity.workers;
}

export function shouldHoldAwake(mode: KeepAwakeMode, activity: KeepAwakeActivity): boolean {
  if (mode === "always") return true;
  if (mode === "off") return false;
  return workingCount(activity) > 0;
}

export const KEEP_AWAKE_MODE_OPTIONS: ReadonlyArray<{
  value: KeepAwakeMode;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "Off", hint: "This computer sleeps as usual." },
  {
    value: "agents",
    label: "While agents work",
    hint: "Stay awake while a terminal agent, Cora, an automation or a worker is working.",
  },
  { value: "always", label: "Always", hint: "Stay awake whenever Codara is open." },
];

export function keepAwakeModeLabel(mode: KeepAwakeMode): string {
  return KEEP_AWAKE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "Off";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "2 terminal agents, 1 Cora chat and 3 workers", or "" when nothing works. */
export function describeKeepAwakeActivity(activity: KeepAwakeActivity): string {
  const parts: string[] = [];
  if (activity.terminalAgents > 0) {
    parts.push(plural(activity.terminalAgents, "terminal agent", "terminal agents"));
  }
  if (activity.chats > 0) parts.push(plural(activity.chats, "Cora chat", "Cora chats"));
  if (activity.automations > 0) {
    parts.push(plural(activity.automations, "automation", "automations"));
  }
  if (activity.workers > 0) parts.push(plural(activity.workers, "worker", "workers"));
  return joinWords(parts);
}

/** One sentence saying what Codara is doing about sleep right now. */
export function keepAwakeSummary(status: KeepAwakeStatus): string {
  if (status.error && !status.holding && status.mode !== "off") {
    return "The system did not let Codara keep this computer awake.";
  }
  if (status.mode === "off") return "Off. This computer sleeps as usual.";
  if (status.mode === "always") return "Keeping this computer awake while Codara is open.";
  const working = describeKeepAwakeActivity(status.activity);
  if (!status.holding || !working) return "Nothing is working, so this computer can sleep.";
  const verb = workingCount(status.activity) === 1 ? "is" : "are";
  return `Keeping this computer awake: ${working} ${verb} working.`;
}

/** The short title-bar tooltip and accessible name of the control. */
export function keepAwakeIndicatorLabel(status: KeepAwakeStatus | null): string {
  if (!status) return "Keep awake";
  if (status.holding) return `Keep awake: on. ${keepAwakeSummary(status)}`;
  return `Keep awake: ${keepAwakeModeLabel(status.mode).toLowerCase()}. ${keepAwakeSummary(status)}`;
}

export const KEEP_AWAKE_DISPLAY_NOTE = "The screen can still turn off and lock.";

export const KEEP_AWAKE_LID_HINT =
  "Closing the lid does not suspend this laptop while Codara keeps it awake. On battery it keeps draining.";
