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
  /**
   * Where the entry came from. ssh-config and codara-cloud entries are
   * read-only in the UI.
   */
  source: "ssh-config" | "manual" | "codara-cloud";
  /**
   * Argv spawned WITHOUT a shell; its stdio becomes the SSH transport. Only
   * entries written by main (Codara Cloud boxes) carry it: the renderer can
   * never set it through saveHost.
   */
  proxyCommand?: string[];
  /**
   * An ssh_config ProxyCommand line, unexpanded. Expanded and run through the
   * platform shell only when the user connects (see proxy-command.ts).
   */
  proxyCommandTemplate?: string;
  /** Known-hosts key to use instead of host:port. */
  hostKeyAlias?: string;
  /** Codara Cloud box id; the box is woken before the SSH handshake. */
  codaraBoxId?: string;
}

export type RemoteConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface RemoteConnectionStatus {
  hostId: string;
  state: RemoteConnectionState;
  /** Present when state === "error"; shown in the workspace row tooltip. */
  error?: string;
  /** Present while connecting, e.g. the phase of a Codara box that is waking. */
  progress?: string;
  /** Set when the host's key changed: Studio refuses until the user trusts the new one. */
  hostKeyChange?: HostKeyChange;
}

// ── Codara Cloud boxes ───────────────────────────────────────────────────────

/** Projection of one box from `codaracloud boxes list -o json`. */
export interface CodaraBoxSummary {
  id: string;
  name: string;
  clientSlug: string;
  projectSlug: string | null;
  environmentSlug: string | null;
  region: string | null;
  /** Pending, Starting, Running, Sleeping, Suspended, Blocked, Failed or Deleting. */
  phase: string;
  message: string | null;
  canConnect: boolean;
}

export type CodaraBoxesErrorCode =
  | "cli_missing"
  | "cli_outdated"
  | "not_signed_in"
  | "boxes_disabled"
  | "failed";

export type CodaraBoxesListResult =
  | { ok: true; boxes: CodaraBoxSummary[] }
  | { ok: false; code: CodaraBoxesErrorCode; message: string; installUrl?: string };

export type CodaraBoxConnectInfoResult =
  | { ok: true; host: RemoteHostConfig }
  | { ok: false; code: CodaraBoxesErrorCode; message: string; installUrl?: string };

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

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The Add host form's host and port fields. "user@host:port" in the host
 * field fills the other two; an empty port is 22.
 */
export function parseHostAddress(
  hostField: string,
  portField: string,
): { host: string; user: string | null; port: number } | { error: string } {
  const trimmed = hostField.trim();
  const address = /^(?:([^@\s]+)@)?([^@\s:]+)(?::(\d+))?$/.exec(trimmed);
  const portText = address?.[3] ?? (portField.trim() || "22");
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!isValidPort(port)) return { error: "Port must be a number from 1 to 65535." };
  return { host: address?.[2] ?? trimmed, user: address?.[1] ?? null, port };
}

// ── Host keys ────────────────────────────────────────────────────────────────

/** Asked before the first connection to a host whose key Studio has not seen. */
export interface HostKeyPromptRequest {
  requestId: string;
  hostId: string;
  /** `host:port`, or the host key alias. */
  hostLabel: string;
  keyType: string;
  /** `SHA256:<base64 without padding>`, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

export interface HostKeyPromptAnswer {
  requestId: string;
  trust: boolean;
}

export interface HostKeyChange {
  hostLabel: string;
  previousFingerprint: string;
  newFingerprint: string;
  keyType: string;
  /** Set when the earlier key is the one ~/.ssh/known_hosts lists, not Codara's own. */
  listedBy?: "known_hosts";
}
