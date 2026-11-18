// Keeping the agent command-line tools (Claude Code, Codex, Grok) up to date.
// Main checks the installed and the newest version of each, updates them with
// their own installer while no session of that tool runs, and puts the
// previous version back when the new one fails its version check. Pi is pinned
// to the version Codara is tested with and is only shown.

export const AGENT_CLI_TOOL_IDS = ["claude", "codex", "grok", "pi"] as const;
export type AgentCliToolId = (typeof AGENT_CLI_TOOL_IDS)[number];
export type UpdatableAgentCliToolId = Exclude<AgentCliToolId, "pi">;

export const AGENT_CLI_LABELS: Record<AgentCliToolId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

/**
 * How a tool was installed, which decides who may update it:
 * - "native": the vendor's own installer (`claude update`, `codex update`,
 *   `grok update`), in the user's home.
 * - "npm": a global npm package in a folder the user can write.
 * - "manual": installed some other way (Homebrew, WinGet, pnpm, bun, an npm
 *   folder that needs administrator rights, or a layout Codara does not
 *   recognise). Codara shows the command and never runs it.
 * - "pinned": Pi, which stays on the version Codara is tested with.
 */
export type AgentCliInstallMethod = "native" | "npm" | "manual" | "pinned";

/**
 * Where a tool's update stands:
 * - "idle": nothing running.
 * - "waiting": an update is due but a session of that tool is running.
 * - "updating" / "verifying" / "rolling-back": the steps of one update.
 * - "updated": the last update finished and passed its version check.
 * - "rolled-back": the new version failed its check; the old one is back.
 * - "failed": the update (or its roll back) did not work; `message` says
 *   what to run by hand.
 */
export type AgentCliUpdatePhase =
  | "idle"
  | "waiting"
  | "updating"
  | "verifying"
  | "rolling-back"
  | "updated"
  | "rolled-back"
  | "failed";

export interface AgentCliToolStatus {
  id: AgentCliToolId;
  label: string;
  installed: boolean;
  /** Installed version, as its version check printed it. */
  version: string | null;
  /** Newest published version, or null before the first check or when it failed. */
  latestVersion: string | null;
  updateAvailable: boolean;
  installMethod: AgentCliInstallMethod;
  /** How the install was recognised, in plain words ("npm", "Homebrew", ...). */
  installSource: string | null;
  /** Codara can run the update itself (native installer or writable npm). */
  canUpdate: boolean;
  /** The command a person would run to update it by hand. */
  manualCommand: string | null;
  phase: AgentCliUpdatePhase;
  /** One sentence for the user about the phase, or null. */
  message: string | null;
  /** Running sessions of this tool that hold an update back. */
  liveSessions: number;
  /** Pi only: the version Codara is tested with. */
  pinnedVersion?: string;
}

export interface AgentCliUpdatesSnapshot {
  autoUpdate: boolean;
  checking: boolean;
  lastCheckedAt: string | null;
  /** Why the newest versions could not be read, when they could not. */
  checkError: string | null;
  tools: AgentCliToolStatus[];
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** The first x.y.z[-pre] in a version check's output ("2.1.327 (Claude Code)", "codex-cli 0.169.0"). */
export function parseCliVersion(output: string | null | undefined): string | null {
  if (!output) return null;
  const match = VERSION_RE.exec(output);
  return match ? match[0] : null;
}

/**
 * Semver order: numbers first, then a release is newer than its pre-releases,
 * and pre-release fields compare numerically when both are numbers.
 * Unparseable input sorts lowest.
 */
export function compareCliVersions(a: string, b: string): number {
  const left = VERSION_RE.exec(a);
  const right = VERSION_RE.exec(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(left[index]) - Number(right[index]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  const leftPre = left[4];
  const rightPre = right[4];
  if (!leftPre || !rightPre) return leftPre ? -1 : rightPre ? 1 : 0;
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const l = leftParts[index];
    const r = rightParts[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln < rn ? -1 : 1;
    } else if (ln !== null || rn !== null) {
      return ln !== null ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export function isNewerCliVersion(candidate: string | null, installed: string | null): boolean {
  if (!candidate || !installed) return false;
  return compareCliVersions(candidate, installed) > 0;
}
