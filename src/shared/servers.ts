// Dev servers Codara keeps for a workspace, the status view and the
// per-runtime launch arguments. Shared by src/main/servers/, the preload area
// (window.spark.servers) and the status view in components/status/.

/** Where a remembered server came from. */
export type DevServerSource = "agent" | "user";

/** What Codara remembers about one dev server of a workspace. Never a secret value. */
export interface DevServerSpec {
  /** Stable within the workspace: lowercase letters, digits and dashes. */
  id: string;
  command: string;
  /** Absolute local directory the command runs in. */
  cwd: string;
  port: number | null;
  url: string | null;
  /** Names of the environment variables the server was started with; values are never stored. */
  envNames: string[];
  autoStart: boolean;
  source: DevServerSource;
  createdAt: number;
  updatedAt: number;
}

/**
 * running: Codara's own process for it is alive. pane: it runs in a terminal
 * pane (the user's, or one an agent opened) and Codara learned it there.
 * stopped: not running. exited: Codara's process ended on its own.
 */
export type DevServerState = "running" | "pane" | "stopped" | "exited";

export type DevServerHealth = "up" | "down" | "unknown";

export interface DevServerStatus extends DevServerSpec {
  workspaceId: string;
  state: DevServerState;
  /** A TCP connect to the port on this computer. */
  health: DevServerHealth;
  /** The terminal session that runs it, readable with codara_terminal_read. */
  paneId: string | null;
  startedAt: number | null;
  exitCode: number | null;
  /** Env names it was saved with that this start had no value for. */
  missingEnv: string[];
  /** Why it cannot start right now, such as a port another process holds. */
  conflict: string | null;
}

export interface DevServerLogs {
  id: string;
  paneId: string | null;
  text: string;
  /** Pass back as `since` to get only output written after this read. */
  cursor: number;
  truncated: boolean;
  /** The whole log, written when it was longer than the reply. */
  fullPath?: string;
}

export interface DevServerStartInput {
  workspaceId: string;
  id?: string;
  command?: string;
  cwd?: string;
  port?: number | null;
  url?: string | null;
  env?: Record<string, string>;
  autoStart?: boolean;
  source?: DevServerSource;
}

/** What a start or restart reports. `output` is the tail when the process ended before it was ready. */
export interface DevServerStartReply {
  server: DevServerStatus;
  alreadyRunning: boolean;
  ready: boolean;
  output?: string;
}

export interface DevServerSaveInput {
  workspaceId: string;
  id: string;
  command?: string;
  cwd?: string;
  port?: number | null;
  url?: string | null;
  autoStart?: boolean;
}

/** One agent session Codara can see, for the status view. */
export interface StatusAgentSession {
  paneId: string;
  workspaceId: string;
  tabId: string | null;
  /** claude, codex, grok, pi, or another CLI Codara recognized in the pane. */
  runtime: string;
  state: string | null;
  /** Codara's tools are attached to this runtime's launches. */
  toolsAttached: boolean;
  /** A codara-studio tool server from this pane said hello and is still running. */
  toolsConnected: boolean;
  /** The client name the tool server reported, such as the CLI's own name. */
  client: string | null;
  connectedAt: number | null;
}

/** Something running that another area reports, such as a recording. */
export interface StatusActivity {
  id: string;
  kind: string;
  label: string;
  workspaceId: string | null;
  startedAt: number;
  detail?: string;
}

export interface StatusSnapshot {
  workspaceId: string | null;
  servers: DevServerStatus[];
  agents: StatusAgentSession[];
  activities: StatusActivity[];
  /** Per runtime: whether Codara's tools are attached to its launches. */
  toolsByRuntime: Record<string, boolean>;
}

/** Runtimes whose launches take extra arguments from Settings. */
export const LAUNCH_ARG_RUNTIMES = ["claude", "codex", "grok", "pi"] as const;
export type LaunchArgRuntime = (typeof LAUNCH_ARG_RUNTIMES)[number];

export interface LaunchArgsSettings {
  /** What the user typed, per runtime. */
  args: Partial<Record<LaunchArgRuntime, string>>;
  /** Adds --chrome to Claude Code launches (Claude in Chrome). */
  claudeChrome: boolean;
}

export interface LaunchArgsCheck {
  ok: boolean;
  /** The arguments as Codara will pass them, one per item. */
  argv: string[];
  error: string | null;
}
