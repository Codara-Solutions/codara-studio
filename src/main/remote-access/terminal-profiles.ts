// Server-owned remote terminal launch profiles. Kept in a tiny leaf module so
// studio-terminal-share.ts can validate renderer inventory profiles without
// pulling rpc.ts or terminal-launch.ts into the eager main process bundle.
export type RemoteTerminalProfile =
  | "shell"
  | "claude"
  | "codex"
  | "grok"
  | "pi"
  | "antigravity";

const REMOTE_TERMINAL_PROFILES: readonly string[] = [
  "shell",
  "claude",
  "codex",
  "grok",
  "pi",
  "antigravity",
] satisfies readonly RemoteTerminalProfile[];

export function isRemoteTerminalProfile(value: unknown): value is RemoteTerminalProfile {
  return typeof value === "string" && REMOTE_TERMINAL_PROFILES.includes(value);
}
