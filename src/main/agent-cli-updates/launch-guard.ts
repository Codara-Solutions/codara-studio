// What the update service tells the terminal launcher (pty-manager.ts):
// which tool is being swapped right now, so Codara does not start it
// half-installed, and which tools' own updaters stay off after a roll back,
// so the version Codara put back is not replaced again at the next start.
// Kept tiny (one import, the startup parser): pty-manager loads it at startup.

import { parseManualAgentStartupCommand } from "../manual-agent-startup";

/**
 * The switch each vendor documents for its own updater. Claude Code reads
 * DISABLE_AUTOUPDATER (its settings docs); Grok reads GROK_DISABLE_AUTOUPDATER
 * (its bundled docs: "Check for CLI updates on launch ... GROK_DISABLE_AUTOUPDATER
 * to suppress"). Codex has none: installing a named release takes it off its
 * scheduled updates by itself (install.sh drops auto-update-version).
 */
export const VENDOR_UPDATER_OFF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claude: { DISABLE_AUTOUPDATER: "1" },
  grok: { GROK_DISABLE_AUTOUPDATER: "1" },
};

/**
 * How long a launch still counts after its terminal opened: the shell may
 * type the tool's command a moment later, before any process of it exists.
 */
export const LAUNCH_SETTLE_MS = 30_000;

let held: readonly string[] = [];
/** Tools being swapped, with the name the refusal uses. */
const busy = new Map<string, string>();
const starting = new Map<string, number>();

/** Tools whose own updater stays off in the terminals Codara opens. */
export function holdVendorUpdates(tools: readonly string[]): void {
  held = [...tools];
}

/** The environment that keeps those updaters off. */
export function vendorUpdaterEnv(): Record<string, string> {
  return Object.assign({}, ...held.map((tool) => VENDOR_UPDATER_OFF[tool] ?? {}));
}

export function setToolBusy(tool: string, isBusy: boolean, label = tool): void {
  if (isBusy) busy.set(tool, label);
  else busy.delete(tool);
}

/** Tools being swapped right now (the quit prompt names them). */
export function busyTools(): string[] {
  return [...busy.keys()];
}

/**
 * A launch of the tool starts. Refused at once while the tool is being
 * swapped: callers that open panes give up after seconds, so a held launch
 * would only start late, unseen, or in the middle of a roll back. Returns
 * the call that ends the launch; until then the update counts it as a session.
 */
export function beginToolLaunch(tool: string): () => void {
  const updating = busy.get(tool);
  if (updating !== undefined) throw new Error(updatingMessage(updating));
  starting.set(tool, (starting.get(tool) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (starting.get(tool) ?? 1) - 1;
    if (left > 0) starting.set(tool, left);
    else starting.delete(tool);
  };
}

function updatingMessage(label: string): string {
  return `${label} is updating. Try again in a few minutes.`;
}

/**
 * The refusal for a terminal whose startup command launches a tool being
 * swapped, or null. Callers that open panes ask before the pane exists: the
 * launch's own refusal reaches only the pane, and they would wait out their
 * spawn timeout and report a bad folder.
 */
export function toolUpdating(command: string | null | undefined): string | null {
  const runtime = parseManualAgentStartupCommand(command)?.runtime;
  const label = runtime ? busy.get(runtime) : undefined;
  return label === undefined ? null : updatingMessage(label);
}

/** Launches of the tool that have begun and may not have a process yet. */
export function launchesStarting(tool: string): number {
  return starting.get(tool) ?? 0;
}
