// Pure, dependency-free normalizer for the MCP roster handed to a Pi session.
// pi-runtime-electron.ts wraps it (discovery, disk write, env stamping) exactly
// as it wraps pi-runtime.ts, so the rules below stay unit-testable without
// Electron or a filesystem.

export type PiMcpTransport = "stdio" | "http" | "sse";
export type PiMcpAudience = "cora" | "worker";

export interface PiMcpServerConfig {
  name: string;
  transport: PiMcpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface PiMcpBridgeConfig {
  version: 1;
  audience: PiMcpAudience;
  connectTimeoutMs: number;
  stdioConnectTimeoutMs: number;
  callTimeoutMs: number;
  maxTotalCallMs: number;
  maxToolsPerServer: number;
  servers: PiMcpServerConfig[];
  // A live roster is rewritten while the session runs (the Capability Center
  // assigned or removed a server); the bridge re-reads it before each prompt.
  // Only a live roster may be empty.
  live?: boolean;
}

/** Sidecar the bridge writes next to a live roster with each server's state. */
export function piMcpStatusPath(configPath: string): string {
  return configPath.replace(/\.json$/, "") + ".status.json";
}

export interface RawMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

// Codara's own built-in server reaches Pi as an in-process bridge module
// (CODARA_PI_BRIDGE_PATH), so re-delivering the config-file copy would spawn a
// second server process and shadow every codara_* tool with an mcp__ duplicate.
// The retired managed names below are earlier copies of that same server, so
// they are dropped for the same reason. `playwright` is deliberately absent:
// mcp-installer.ts only cleans up its own managed legacy entry and never
// touches a user-owned Playwright MCP server, which must reach Pi like any
// other user server.
export const RESERVED_MCP_SERVER_NAMES = [
  "codara-studio",
  "spark-preview",
  "cora-preview",
  "spark-orchestrator",
  "cora-orchestrator",
] as const;

export const PI_MCP_DEFAULTS = {
  connectTimeoutMs: 10_000,
  // A first `npx -y` run installs the package before the handshake.
  stdioConnectTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  maxTotalCallMs: 600_000,
  // Remote tools stay inactive until codara_external_tools loads them, so a
  // server costs a connection, not prompt tokens; the caps bound connection
  // fan-out and a runaway server.
  maxServers: 16,
  maxToolsPerServer: 256,
} as const;

const RESERVED = new Set<string>(RESERVED_MCP_SERVER_NAMES.map((name) => name.toLowerCase()));

/** Tool-name charset accepted by both Anthropic and OpenAI tool schemas. */
export function sanitizeMcpSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function stringRecord(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string" || !key.trim()) continue;
    out[key] = expandEnvPlaceholders(raw, env);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve ${VAR} / ${env:VAR} placeholders against the main process env.
 * Pi's own environment is stripped of every credential before launch, so a
 * server's secrets can only travel through the mode-600 config file.
 */
export function expandEnvPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const resolved = env[name];
    return typeof resolved === "string" ? resolved : match;
  });
}

function inferTransport(server: RawMcpServer): PiMcpTransport | null {
  if (typeof server.url === "string" && server.url.trim()) {
    const declared = (server.type ?? "").toLowerCase();
    return declared === "sse" ? "sse" : "http";
  }
  if (typeof server.command === "string" && server.command.trim()) return "stdio";
  return null;
}

function isSupportedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type PiMcpDropReason = "turned-off" | "reserved" | "duplicate" | "unsupported" | "over-cap";

export interface PiMcpDroppedServer {
  name: string;
  reason: PiMcpDropReason;
  detail: string;
}

/**
 * Turn discovered runtime-agnostic entries into the exact roster the Pi bridge
 * connects to. Entries that cannot be launched (no command and no usable url),
 * explicitly disabled entries, and Codara's own built-in server are dropped
 * rather than surfaced as a broken connection at session start.
 */
export function normalizePiMcpServers(
  raw: readonly RawMcpServer[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxServers?: number } = {},
): PiMcpServerConfig[] {
  return normalizePiMcpServersDetailed(raw, options).servers.map(({ rawName: _rawName, ...server }) => server);
}

/** The same roster plus every dropped entry and why, for the Capability Center. */
export function normalizePiMcpServersDetailed(
  raw: readonly RawMcpServer[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxServers?: number } = {},
): { servers: Array<PiMcpServerConfig & { rawName: string }>; dropped: PiMcpDroppedServer[] } {
  const env = options.env ?? process.env;
  const maxServers = options.maxServers ?? PI_MCP_DEFAULTS.maxServers;
  const seen = new Set<string>();
  const servers: Array<PiMcpServerConfig & { rawName: string }> = [];
  const dropped: PiMcpDroppedServer[] = [];
  const drop = (name: string, reason: PiMcpDropReason, detail: string) => {
    dropped.push({ name, reason, detail });
  };
  for (const entry of raw) {
    const rawName = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!rawName) continue;
    if (entry.enabled === false) {
      drop(rawName, "turned-off", "Its config entry sets enabled = false.");
      continue;
    }
    if (RESERVED.has(rawName.toLowerCase())) {
      drop(rawName, "reserved", "Codara's built-in tools already reach Cora directly.");
      continue;
    }
    const name = sanitizeMcpSegment(rawName);
    if (!name || seen.has(name.toLowerCase())) {
      drop(rawName, "duplicate", "Another assigned server already uses this name.");
      continue;
    }
    const transport = inferTransport(entry);
    if (!transport) {
      drop(rawName, "unsupported", "The entry has no command and no URL.");
      continue;
    }
    if (servers.length >= maxServers) {
      drop(rawName, "over-cap", `A session connects to at most ${maxServers} servers; turn one off to make room.`);
      continue;
    }
    if (transport === "stdio") {
      const command = expandEnvPlaceholders(entry.command!.trim(), env);
      if (!command) {
        drop(rawName, "unsupported", "The command is empty.");
        continue;
      }
      const args = Array.isArray(entry.args)
        ? entry.args.filter((arg): arg is string => typeof arg === "string")
          .map((arg) => expandEnvPlaceholders(arg, env))
        : undefined;
      const serverEnv = stringRecord(entry.env, env);
      seen.add(name.toLowerCase());
      servers.push({
        rawName,
        name,
        transport,
        command,
        ...(args && args.length > 0 ? { args } : {}),
        ...(serverEnv ? { env: serverEnv } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      continue;
    }
    const url = expandEnvPlaceholders(entry.url!.trim(), env);
    if (!isSupportedUrl(url)) {
      drop(rawName, "unsupported", "The URL is not an http(s) address.");
      continue;
    }
    const headers = stringRecord(entry.headers, env);
    seen.add(name.toLowerCase());
    servers.push({
      rawName,
      name,
      transport,
      url,
      ...(headers ? { headers } : {}),
    });
  }
  return { servers, dropped };
}

export function buildPiMcpBridgeConfig(
  servers: readonly PiMcpServerConfig[],
  options: { audience: PiMcpAudience } & Partial<Omit<PiMcpBridgeConfig, "version" | "servers" | "audience">>,
): PiMcpBridgeConfig {
  return {
    version: 1,
    audience: options.audience,
    connectTimeoutMs: options.connectTimeoutMs ?? PI_MCP_DEFAULTS.connectTimeoutMs,
    stdioConnectTimeoutMs: options.stdioConnectTimeoutMs ?? PI_MCP_DEFAULTS.stdioConnectTimeoutMs,
    callTimeoutMs: options.callTimeoutMs ?? PI_MCP_DEFAULTS.callTimeoutMs,
    maxTotalCallMs: options.maxTotalCallMs ?? PI_MCP_DEFAULTS.maxTotalCallMs,
    maxToolsPerServer: options.maxToolsPerServer ?? PI_MCP_DEFAULTS.maxToolsPerServer,
    servers: [...servers],
    ...(options.live ? { live: true } : {}),
  };
}

/** The registered Pi tool name for one remote tool, mirrored by mcp-bridge.ts. */
export function piMcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpSegment(server)}__${sanitizeMcpSegment(tool)}`;
}
