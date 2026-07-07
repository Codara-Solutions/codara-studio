// Remote (SSH) workspace primitives shared by main and renderer.
//
// A remote workspace's cwd is a VIRTUAL PATH: `ssh://<hostId>/<posix path>`.
// Because every subsystem already threads cwd-derived path strings through
// IPC, the scheme prefix carries routing information end to end — the main
// process routes any ssh:// path to the host's SSH connection (SFTP / exec /
// shell channel) and everything else to the existing local code, unchanged.
//
// hostId is the host's alias (from ~/.ssh/config or a manually added host).
// It never contains "/" — enforced at host creation — so parsing is a plain
// prefix split, no URL library involved.

export const REMOTE_SCHEME = "ssh://";

export interface RemotePathParts {
  hostId: string;
  /** Absolute POSIX path on the remote host ("/" rooted, forward slashes). */
  path: string;
}

export function isRemotePath(p: string | null | undefined): boolean {
  return typeof p === "string" && p.startsWith(REMOTE_SCHEME);
}

export function parseRemotePath(p: string): RemotePathParts | null {
  if (!isRemotePath(p)) return null;
  const rest = p.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const hostId = rest.slice(0, slash);
  const path = rest.slice(slash) || "/";
  return { hostId, path };
}

export function makeRemotePath(hostId: string, posixPath: string): string {
  const normalized = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  return `${REMOTE_SCHEME}${hostId}${normalized}`;
}

/** Join POSIX segments onto a remote (or plain POSIX) base path. */
export function remoteJoin(base: string, ...segments: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const seg of segments) {
    const clean = seg.replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean) out += `/${clean}`;
  }
  return out || "/";
}

// ── Host registry ────────────────────────────────────────────────────────────

export interface RemoteHostConfig {
  /** Unique alias; doubles as the hostId inside ssh:// paths. No "/" or whitespace. */
  id: string;
  host: string;
  port: number;
  username: string;
  /** Local path to a private key, when key auth is configured. */
  identityFile?: string;
  /** Where the entry came from — ssh-config entries are read-only in the UI. */
  source: "ssh-config" | "manual";
}

export type RemoteConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface RemoteConnectionStatus {
  hostId: string;
  state: RemoteConnectionState;
  /** Present when state === "error"; shown in the workspace row tooltip. */
  error?: string;
}

/** Directory entry returned by the pre-workspace remote folder browser. */
export interface RemoteBrowseEntry {
  name: string;
  path: string; // absolute POSIX path on the host (NOT ssh://-prefixed)
  isDir: boolean;
}

export interface RemoteBrowseResult {
  path: string;
  parent: string | null;
  entries: RemoteBrowseEntry[];
  error?: string;
}

// Auth prompts: main asks, the renderer shows a modal and answers.
export interface RemoteAuthPromptRequest {
  requestId: string;
  hostId: string;
  kind: "password" | "passphrase";
  /** Human line, e.g. "Password for jorge@203.0.113.7" */
  message: string;
  /** Offer a "remember" checkbox (safeStorage-encrypted, opt-in). */
  canRemember: boolean;
}

export interface RemoteAuthPromptAnswer {
  requestId: string;
  /** null = user cancelled. */
  value: string | null;
  remember: boolean;
}

export function isValidHostId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}
