// User-configured MCP servers for Cora's Pi harness.
//
// Codara's own studio tools reach Pi as an in-process module
// (CODARA_PI_BRIDGE_PATH). This module is the separate, opt-in path for the
// third-party servers the user assigned to this session's scope in the
// Capability Center: the launcher writes a mode-600 roster file and stamps
// CODARA_PI_MCP_CONFIG + CODARA_PI_MCP_SDK_DIR, and both entrypoints
// (index.ts for the Cora manager, worker.ts for implementation workers) call
// registerMcpBridge with it.
//
// A live roster (Cora's own sessions) can change while the session runs: the
// launcher rewrites the file when the user assigns or removes a server in the
// Capability Center, and the bridge re-reads it on each prompt, connecting new
// servers and dropping removed ones. The bridge reports each server's state to
// a status file next to the roster, which the Capability Center shows.
//
// Two hard constraints shape everything below.
// 1. A throw from the extension factory kills the whole extension, and a throw
//    from a handler fails the Codara turn (src/main/orchestration/pi-turn.ts
//    maps extension_error to a failed turn). So no I/O happens at factory time,
//    every async boundary is individually guarded, and an unreachable server
//    becomes a visible notice plus a failing tool call, never a dead session.
// 2. A packaged extension cannot resolve bare npm specifiers: Pi loads
//    extensions through a jiti instance rooted at its own package. The MCP SDK
//    is therefore required by absolute path, the same trick the studio bridge
//    already uses.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type McpBridgeTransport = "stdio" | "http" | "sse";

export interface McpBridgeServerConfig {
  name: string;
  transport: McpBridgeTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpBridgeConfig {
  version: number;
  audience: string;
  connectTimeoutMs: number;
  stdioConnectTimeoutMs: number;
  callTimeoutMs: number;
  maxTotalCallMs: number;
  maxToolsPerServer: number;
  servers: McpBridgeServerConfig[];
  sdkDir: string;
  live: boolean;
  configPath: string;
}

export interface McpBridgeHandle {
  /** One short line naming unavailable servers, folded into the system prompt
   * by the caller's existing before_agent_start handler. Empty when healthy. */
  promptSuffix(): string;
}

interface ServerState {
  config: McpBridgeServerConfig;
  // Dropped from a live roster. Its tools stay registered (Pi cannot
  // unregister) but are deactivated and refuse calls.
  removed: boolean;
  status: "pending" | "connected" | "failed" | "disconnected";
  error: string | null;
  toolNames: string[];
  skipped: string[];
  stderr: string[];
  client: McpClient | null;
  registered: Set<string>;
  connecting: Promise<void> | null;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface McpClient {
  connect(transport: unknown, options?: Record<string, unknown>): Promise<void>;
  listTools(params?: unknown, options?: Record<string, unknown>): Promise<{ tools?: McpToolDescriptor[] }>;
  callTool(params: unknown, resultSchema?: unknown, options?: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

interface RegisteredRemoteTool {
  name: string;
  serverName: string;
  remoteName: string;
  description: string;
}

const MAX_TOOL_NAME_LENGTH = 128;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_STDERR_LINES = 40;
// How long session_start holds the first prompt for MCP connections. A slow or
// dead server keeps connecting in the background instead of delaying Cora's
// first token by its full connect and listTools timeouts.
export const SESSION_START_CONNECT_WAIT_MS = 2_500;
const DEFAULT_TOOL_SEARCH_LIMIT = 5;
const MAX_TOOL_SEARCH_LIMIT = 8;

// `mcp_status` is a provider-reserved subscription-routing signal on
// Anthropic OAuth requests: merely including a tool with that exact name makes
// Claude classify the whole Pi request as third-party Extra Usage. These
// Codara-owned names are intentionally provider-neutral and covered by the
// bridge test so the reserved spelling cannot drift back in.
export const EXTERNAL_TOOL_LOADER_NAME = "codara_external_tools";
export const EXTERNAL_SERVER_STATUS_NAME = "codara_server_status";

const SEARCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "tool", "tools",
  "use", "using", "some", "any", "all", "can", "how", "what", "which", "please",
]);

const requireFromExtension = createRequire(import.meta.url);

function rosterServers(parsed: Partial<McpBridgeConfig>): McpBridgeServerConfig[] {
  return Array.isArray(parsed.servers)
    ? parsed.servers.filter((server): server is McpBridgeServerConfig =>
      Boolean(server && typeof server.name === "string" && (server.command || server.url)))
    : [];
}

export function activeMcpBridgeConfig(env: NodeJS.ProcessEnv = process.env): McpBridgeConfig | null {
  const configPath = env.CODARA_PI_MCP_CONFIG?.trim();
  const sdkDir = env.CODARA_PI_MCP_SDK_DIR?.trim();
  if (!configPath || !sdkDir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<McpBridgeConfig>;
    const servers = rosterServers(parsed);
    const live = parsed.live === true;
    if (servers.length === 0 && !live) return null;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      audience: typeof parsed.audience === "string" ? parsed.audience : "cora",
      connectTimeoutMs: positiveNumber(parsed.connectTimeoutMs, 10_000),
      stdioConnectTimeoutMs: positiveNumber(parsed.stdioConnectTimeoutMs, 30_000),
      callTimeoutMs: positiveNumber(parsed.callTimeoutMs, 60_000),
      maxTotalCallMs: positiveNumber(parsed.maxTotalCallMs, 600_000),
      maxToolsPerServer: positiveNumber(parsed.maxToolsPerServer, 256),
      servers,
      sdkDir,
      live,
      configPath,
    };
  } catch {
    return null;
  }
}

/** Mirrors piMcpStatusPath in src/main/orchestration/pi-mcp-config.ts. */
export function mcpStatusPath(configPath: string): string {
  return configPath.replace(/\.json$/, "") + ".status.json";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadMcpSdk(sdkDir: string): {
  Client: new (info: { name: string; version: string }, options?: unknown) => McpClient;
  StdioClientTransport: new (options: Record<string, unknown>) => { stderr?: NodeJS.ReadableStream | null; onerror?: (error: Error) => void; onclose?: () => void };
  StreamableHTTPClientTransport: new (url: URL, options?: Record<string, unknown>) => { onerror?: (error: Error) => void; onclose?: () => void };
  SSEClientTransport: new (url: URL, options?: Record<string, unknown>) => { onerror?: (error: Error) => void; onclose?: () => void };
} {
  const client = requireFromExtension(path.join(sdkDir, "index.js"));
  const stdio = requireFromExtension(path.join(sdkDir, "stdio.js"));
  const http = requireFromExtension(path.join(sdkDir, "streamableHttp.js"));
  const sse = requireFromExtension(path.join(sdkDir, "sse.js"));
  return {
    Client: client.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    SSEClientTransport: sse.SSEClientTransport,
  };
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Mirrors piMcpToolName in src/main/orchestration/pi-mcp-config.ts. Provider
 * tool schemas accept only [A-Za-z0-9_-]{1,128}, and Pi validates nothing. */
export function piMcpToolName(server: string, tool: string): string {
  const serverSegment = sanitizeSegment(server) || "server";
  const toolSegment = sanitizeSegment(tool) || "tool";
  const full = `mcp__${serverSegment}__${toolSegment}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  const digest = crypto.createHash("sha256").update(`${server} ${tool}`).digest("hex").slice(0, 6);
  const budget = MAX_TOOL_NAME_LENGTH - `mcp__${serverSegment}___${digest}`.length;
  return `mcp__${serverSegment}__${toolSegment.slice(0, Math.max(1, budget))}_${digest}`;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

function truncateText(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_RESULT_BYTES) return value;
  const kept = Buffer.from(value, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return `${kept}\n[truncated: ${bytes} bytes of tool output exceeded the ${MAX_RESULT_BYTES} byte limit]`;
}

/** MCP content blocks map onto Pi's (TextContent | ImageContent)[] one to one
 * for text and images. Everything else is summarized as text so a resource or
 * audio block cannot break the turn. */
function mapContent(content: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  const blocks = Array.isArray(content) ? content : [];
  const mapped: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    const type = typeof block?.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      mapped.push({ type: "text", text: truncateText(block.text) });
      continue;
    }
    if (type === "image" && typeof block.data === "string") {
      mapped.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
      continue;
    }
    mapped.push({ type: "text", text: truncateText(describeOpaqueBlock(type, block)) });
  }
  if (mapped.length === 0) mapped.push({ type: "text", text: "null" });
  return mapped;
}

function describeOpaqueBlock(type: string, block: Record<string, unknown>): string {
  const resource = block.resource as Record<string, unknown> | undefined;
  const uri = typeof block.uri === "string" ? block.uri : typeof resource?.uri === "string" ? resource.uri : "";
  const mimeType = typeof block.mimeType === "string"
    ? block.mimeType
    : typeof resource?.mimeType === "string" ? resource.mimeType : "";
  const inlineText = typeof resource?.text === "string" ? resource.text : "";
  const head = `[${type || "unknown"} content${uri ? ` ${uri}` : ""}${mimeType ? ` (${mimeType})` : ""}]`;
  return inlineText ? `${head}\n${inlineText}` : head;
}

function resultErrorMessage(result: McpCallResult, fallback: string): string {
  const texts = (result.content ?? [])
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean);
  return texts.join("\n").slice(0, 2_000) || fallback;
}

function newServerState(config: McpBridgeServerConfig): ServerState {
  return {
    config,
    removed: false,
    status: "pending",
    error: null,
    toolNames: [],
    skipped: [],
    stderr: [],
    client: null,
    registered: new Set(),
    connecting: null,
  };
}

// Status lines leave the Pi process, so a server's own env and header values
// (tokens), and any query string on its URL, never appear in them.
function redactServerSecrets(text: string, server: McpBridgeServerConfig): string {
  let out = text;
  const values = [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
    .map((value) => value.replace(/^Bearer\s+/i, ""))
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("***");
  if (server.url) {
    const query = server.url.indexOf("?");
    if (query !== -1) out = out.split(server.url.slice(query)).join("?***");
  }
  return out;
}

export function registerMcpBridge(pi: ExtensionAPI, config: McpBridgeConfig): McpBridgeHandle {
  const states = new Map<string, ServerState>();
  const remoteTools = new Map<string, RegisteredRemoteTool>();
  const activatedRemoteTools = new Set<string>();
  for (const server of config.servers) {
    states.set(server.name, newServerState(server));
  }
  let sdk: ReturnType<typeof loadMcpSdk> | null = null;
  let shutDown = false;
  let coreToolsRegistered = false;
  let lastRosterText: string | null = null;
  try {
    lastRosterText = config.live ? fs.readFileSync(config.configPath, "utf8") : null;
  } catch {
    lastRosterText = null;
  }

  function activeStates(): ServerState[] {
    return [...states.values()].filter((state) => !state.removed);
  }

  function writeStatus(): void {
    if (!config.live || shutDown) return;
    try {
      const target = mcpStatusPath(config.configPath);
      const body = JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        servers: activeStates().map((state) => ({
          name: state.config.name,
          status: state.status,
          tools: state.toolNames.length,
          updatedAt: new Date().toISOString(),
          ...(state.error ? { error: redactServerSecrets(state.error, state.config) } : {}),
        })),
      });
      const temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, body, { mode: 0o600 });
      fs.renameSync(temp, target);
    } catch {
      // Diagnostics only: a status write never affects the session.
    }
  }

  function deactivateUnselectedRemoteTools(): void {
    const active = pi.getActiveTools();
    const next = active.filter(
      (name) => !remoteTools.has(name) || activatedRemoteTools.has(name),
    );
    if (next.length !== active.length) pi.setActiveTools(next);
  }

  function activateRemoteTools(names: readonly string[]): {
    activated: RegisteredRemoteTool[];
    alreadyActive: RegisteredRemoteTool[];
    unknown: string[];
  } {
    const requested = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    const active = new Set(pi.getActiveTools());
    const activated: RegisteredRemoteTool[] = [];
    const alreadyActive: RegisteredRemoteTool[] = [];
    const unknown: string[] = [];
    for (const name of requested) {
      const metadata = remoteTools.get(name);
      if (!metadata) {
        unknown.push(name);
        continue;
      }
      activatedRemoteTools.add(name);
      if (active.has(name)) {
        alreadyActive.push(metadata);
        continue;
      }
      active.add(name);
      activated.push(metadata);
    }
    // Additive activation is Pi's provider-neutral dynamic-tool signal. On
    // supported Anthropic/OpenAI models it becomes native deferred loading;
    // other providers receive the same tools through Pi's safe fallback.
    if (activated.length > 0) pi.setActiveTools([...active]);
    return { activated, alreadyActive, unknown };
  }

  function compactDescription(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function searchRemoteTools(query: string, limit: number): RegisteredRemoteTool[] {
    const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalizedQuery) return [];
    // Short words and stop words are substrings of nearly every tool name
    // ("a" in "list_pods"), so they would activate unrelated tools.
    const terms = normalizedQuery
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term));
    const scored = [...remoteTools.values()].map((tool) => {
      const name = tool.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const remoteName = tool.remoteName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const serverName = tool.serverName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const description = tool.description.toLowerCase();
      let score = 0;
      let nameHit = false;
      let descriptionHits = 0;
      if (name === normalizedQuery || remoteName === normalizedQuery) score += 40;
      if (name.includes(normalizedQuery) || remoteName.includes(normalizedQuery)) {
        score += 16;
        nameHit = true;
      }
      for (const term of terms) {
        if (name.includes(term)) score += 8;
        if (remoteName.includes(term)) score += 8;
        if (name.includes(term) || remoteName.includes(term)) nameHit = true;
        if (serverName.includes(term)) score += 3;
        if (description.includes(term)) {
          score += 1;
          descriptionHits += 1;
        }
      }
      return { tool, score, nameHit, descriptionHits };
    });
    // A name hit is the strong signal. Only when no tool name matches does a
    // description that covers most of the query qualify on its own.
    const named = scored.filter((candidate) => candidate.nameHit);
    const candidates = named.length > 0
      ? named
      : scored.filter((candidate) =>
        terms.length > 0 && candidate.descriptionHits >= Math.ceil(terms.length / 2));
    return candidates
      .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
      .slice(0, limit)
      .map((candidate) => candidate.tool);
  }

  function sdkOrThrow(): ReturnType<typeof loadMcpSdk> {
    if (!sdk) sdk = loadMcpSdk(config.sdkDir);
    return sdk;
  }

  function recordStderr(state: ServerState, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      state.stderr.push(trimmed.slice(0, 500));
      if (state.stderr.length > MAX_STDERR_LINES) state.stderr.shift();
    }
  }

  function buildTransport(state: ServerState): unknown {
    const { StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } = sdkOrThrow();
    const server = state.config;
    if (server.transport === "stdio") {
      // stderr must be piped: the SDK default inherits it, which would push
      // every server's boot chatter into Pi's own bounded stderr buffer.
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env ? { ...process.env, ...server.env } : { ...process.env },
        cwd: server.cwd,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        try { recordStderr(state, chunk.toString()); } catch { /* diagnostics only */ }
      });
      return transport;
    }
    const url = new URL(server.url!);
    const options = server.headers ? { requestInit: { headers: server.headers } } : undefined;
    return server.transport === "sse"
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options);
  }

  // The SDK chains, rather than replaces, callbacks that were already set on a
  // transport before connect(), so these stay live for the whole session.
  function attachTransportWatchers(state: ServerState, transport: unknown): void {
    const target = transport as { onerror?: (error: Error) => void; onclose?: () => void };
    target.onerror = (error: Error) => {
      state.error = errorText(error);
      if (state.status === "connected") {
        state.status = "disconnected";
        writeStatus();
      }
    };
    target.onclose = () => {
      if (state.status === "connected" && !shutDown) {
        state.status = "disconnected";
        state.error = state.error ?? "the server closed the connection";
        writeStatus();
      }
    };
  }

  async function connectServer(state: ServerState): Promise<void> {
    const { Client } = sdkOrThrow();
    const previous = state.client;
    state.client = null;
    if (previous) await previous.close().catch(() => undefined);
    const client = new Client({ name: "codara-pi", version: "1" });
    const transport = buildTransport(state);
    attachTransportWatchers(state, transport);
    let listed: { tools?: McpToolDescriptor[] };
    try {
      const connectTimeout = state.config.command
        ? Math.max(config.connectTimeoutMs, config.stdioConnectTimeoutMs)
        : config.connectTimeoutMs;
      await client.connect(transport, { timeout: connectTimeout });
      listed = await client.listTools(undefined, { timeout: config.connectTimeoutMs });
    } catch (error) {
      // A timed-out handshake leaves the child process running otherwise.
      await client.close().catch(() => undefined);
      await (transport as { close?: () => Promise<void> }).close?.().catch(() => undefined);
      throw error;
    }
    // Connections finish in the background now, so one can land after
    // session_shutdown already closed every client it knew about.
    if (shutDown) {
      await client.close().catch(() => undefined);
      throw new Error("the session shut down while the server was connecting");
    }
    // A live roster can drop the server while it was still connecting.
    if (state.removed) {
      await client.close().catch(() => undefined);
      state.status = "disconnected";
      return;
    }
    state.client = client;
    state.status = "connected";
    state.error = null;
    registerServerTools(state, listed?.tools ?? []);
  }

  /** One in-flight connection per server, shared by session_start, the loader,
   * remote calls, and reconnect. Failures are recorded, never thrown. */
  function ensureConnecting(state: ServerState): Promise<void> {
    if (state.connecting) return state.connecting;
    const attempt = connectServer(state)
      .catch((error) => {
        state.status = "failed";
        state.error = errorText(error);
        state.client = null;
      })
      .finally(() => {
        if (state.connecting === attempt) state.connecting = null;
        // A late connection registers its tools as active; only the loader
        // may activate a remote definition.
        try { deactivateUnselectedRemoteTools(); } catch { /* best effort */ }
        writeStatus();
      });
    state.connecting = attempt;
    return attempt;
  }

  async function awaitPendingConnections(): Promise<void> {
    const pending = activeStates()
      .map((state) => state.connecting)
      .filter((attempt): attempt is Promise<void> => attempt !== null);
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  function registerServerTools(state: ServerState, tools: McpToolDescriptor[]): void {
    const taken = new Set(pi.getAllTools().map((tool) => tool.name));
    const accepted: string[] = [];
    const skipped: string[] = [];
    for (const tool of tools) {
      if (accepted.length >= config.maxToolsPerServer) {
        skipped.push(`${tool?.name ?? "?"} (roster capped at ${config.maxToolsPerServer} tools)`);
        continue;
      }
      const remoteName = typeof tool?.name === "string" ? tool.name.trim() : "";
      if (!remoteName) continue;
      const name = piMcpToolName(state.config.name, remoteName);
      const description = tool.description?.trim() || `${remoteName} on the ${state.config.name} MCP server.`;
      if (state.registered.has(name)) {
        remoteTools.set(name, {
          name,
          serverName: state.config.name,
          remoteName,
          description,
        });
        accepted.push(name);
        continue;
      }
      // Pi's registry is a plain Map: a duplicate name silently overwrites an
      // existing tool, including builtins like read or bash. Never overwrite.
      if (taken.has(name)) {
        skipped.push(`${remoteName} (name ${name} is already taken)`);
        continue;
      }
      taken.add(name);
      state.registered.add(name);
      accepted.push(name);
      remoteTools.set(name, {
        name,
        serverName: state.config.name,
        remoteName,
        description,
      });
      registerRemoteTool(state, name, remoteName, description, tool);
    }
    state.toolNames = accepted;
    state.skipped = skipped;
  }

  function registerRemoteTool(
    state: ServerState,
    name: string,
    remoteName: string,
    description: string,
    tool: McpToolDescriptor,
  ): void {
    const schema = tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} };
    pi.registerTool({
      name,
      label: `${state.config.name} · ${remoteName}`,
      description,
      parameters: schema as never,
      // A resumed session can replay a call shaped for an older schema version
      // of the remote tool; pass objects through and normalize anything else.
      prepareArguments: ((args: unknown) =>
        (args && typeof args === "object" && !Array.isArray(args) ? args : {})) as never,
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        if (state.removed) {
          throw new Error(
            `MCP server ${state.config.name} was removed from this session in the Capability Center. Continue without this tool.`,
          );
        }
        if (state.connecting) await state.connecting;
        const client = state.client;
        if (!client || state.status !== "connected") {
          throw new Error(
            `MCP server ${state.config.name} is ${state.status}${state.error ? `: ${state.error}` : ""}. Call ${EXTERNAL_SERVER_STATUS_NAME} with action=reconnect to retry, or continue without this tool.`,
          );
        }
        const result = await client.callTool(
          { name: remoteName, arguments: (params ?? {}) as Record<string, unknown> },
          undefined,
          {
            timeout: config.callTimeoutMs,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: config.maxTotalCallMs,
            signal,
          },
        );
        // Same translation as the studio bridge: Pi represents a failed tool by
        // a rejected execute promise and ignores isError on a returned value,
        // so a rejected mutation would otherwise read as applied.
        if (result?.isError === true) {
          throw new Error(resultErrorMessage(result, `${name} failed`));
        }
        return {
          content: mapContent(result?.content) as never,
          details: result?.structuredContent,
        };
      },
    } as never);
  }

  function registerCoreTools(): void {
    if (coreToolsRegistered) return;
    coreToolsRegistered = true;
    pi.registerTool({
      name: EXTERNAL_TOOL_LOADER_NAME,
      label: "External tools · discover",
      description:
        "Search the tools on external MCP servers assigned to this Cora session and activate only the relevant definitions. Use query for capability search, or activate with exact names returned by an earlier search. Activated tools become directly callable on the next step.",
      promptSnippet: "Discover and activate relevant tools from assigned external MCP servers",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Capability or tool name to search for, such as 'deploy Runpod endpoint'. Matching tools are activated.",
          },
          activate: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_TOOL_SEARCH_LIMIT,
            description: "Exact mcp__<server>__<tool> names to activate.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TOOL_SEARCH_LIMIT,
            description: `Maximum query matches to activate (default ${DEFAULT_TOOL_SEARCH_LIMIT}).`,
          },
        },
        additionalProperties: false,
      } as never,
      async execute(
        _toolCallId: string,
        params: { query?: string; activate?: string[]; limit?: number },
      ) {
        // A server still connecting has no tools registered yet; searching now
        // would report its capabilities as missing.
        await awaitPendingConnections();
        const explicit = Array.isArray(params?.activate) ? params.activate : [];
        const query = typeof params?.query === "string" ? params.query.trim() : "";
        const limit = Number.isInteger(params?.limit)
          ? Math.min(MAX_TOOL_SEARCH_LIMIT, Math.max(1, Number(params.limit)))
          : DEFAULT_TOOL_SEARCH_LIMIT;
        const matches = explicit.length > 0 ? [] : searchRemoteTools(query, limit);
        const selectedNames = explicit.length > 0 ? explicit : matches.map((tool) => tool.name);

        if (selectedNames.length === 0) {
          const connected = activeStates().filter((state) => state.status === "connected");
          const summary = connected.length > 0
            ? connected.map((state) => `${state.config.name} (${state.toolNames.length} tools)`).join(", ")
            : "none";
          return {
            content: [{
              type: "text",
              text: query
                ? `No assigned external tools matched ${JSON.stringify(query)}. Connected servers: ${summary}. Try a narrower tool or capability name.`
                : `Connected external MCP servers: ${summary}. Pass query to search and activate relevant tools.`,
            }] as never,
            details: { query, activated: [], connectedServers: connected.map((state) => state.config.name) },
          };
        }

        const result = activateRemoteTools(selectedNames);
        const selected = [...result.activated, ...result.alreadyActive];
        const lines = selected.map(
          (tool) => `- ${tool.name}: ${compactDescription(tool.description)}`,
        );
        if (result.unknown.length > 0) {
          lines.push(`Unknown tool names: ${result.unknown.join(", ")}`);
        }
        return {
          content: [{
            type: "text",
            text: [
              selected.length > 0
                ? `Activated ${result.activated.length} external tool(s); ${result.alreadyActive.length} already active. Call the tools directly on the next step:`
                : "No external tools were activated.",
              ...lines,
            ].join("\n"),
          }] as never,
          details: {
            query,
            activated: result.activated.map((tool) => tool.name),
            alreadyActive: result.alreadyActive.map((tool) => tool.name),
            unknown: result.unknown,
          },
        };
      },
    } as never);

    pi.registerTool({
      name: EXTERNAL_SERVER_STATUS_NAME,
      label: "External servers · status",
      description:
        "Inspect the user-configured MCP servers attached to this session: transport, connection state, registered mcp__<server>__<tool> names, skipped tools, and the last error. Use action=reconnect with a server name to retry one that failed.",
      promptSnippet: "Inspect or reconnect the configured MCP servers",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "reconnect"], description: "Defaults to list." },
          server: { type: "string", description: "Server name, required for reconnect." },
        },
        additionalProperties: false,
      } as never,
      async execute(_toolCallId: string, params: { action?: string; server?: string }) {
        const action = params?.action === "reconnect" ? "reconnect" : "list";
        if (action === "reconnect") {
          const state = states.get(String(params?.server ?? "").trim());
          if (!state || state.removed) {
            throw new Error(`Unknown MCP server. Configured: ${activeStates().map((entry) => entry.config.name).join(", ") || "none"}.`);
          }
          await ensureConnecting(state);
          return { content: [{ type: "text", text: statusLine(state) }] as never };
        }
        const lines = activeStates().map(statusLine);
        return {
          content: [{ type: "text", text: lines.join("\n\n") || "No MCP servers configured." }] as never,
          details: activeStates().map((state) => ({
            name: state.config.name,
            transport: state.config.transport,
            status: state.status,
            tools: state.toolNames,
            error: state.error,
          })),
        };
      },
    } as never);
  }

  async function connectStates(targets: ServerState[]): Promise<void> {
    await Promise.allSettled(targets.map(ensureConnecting));
  }

  // Re-read a live roster: connect added servers, reconnect changed ones, and
  // retire removed ones. A missing or unreadable file keeps the current set.
  async function reloadRoster(): Promise<void> {
    if (!config.live || shutDown) return;
    let text: string;
    let next: McpBridgeServerConfig[];
    try {
      text = fs.readFileSync(config.configPath, "utf8");
      if (text === lastRosterText) return;
      next = rosterServers(JSON.parse(text) as Partial<McpBridgeConfig>);
    } catch {
      return;
    }
    lastRosterText = text;
    const wanted = new Map(next.map((server) => [server.name, server]));
    const toConnect: ServerState[] = [];
    for (const state of states.values()) {
      if (state.removed || wanted.has(state.config.name)) continue;
      state.removed = true;
      state.status = "disconnected";
      const client = state.client;
      state.client = null;
      if (client) await client.close().catch(() => undefined);
      for (const name of state.registered) {
        remoteTools.delete(name);
        activatedRemoteTools.delete(name);
      }
      const active = pi.getActiveTools();
      const kept = active.filter((name) => !state.registered.has(name));
      if (kept.length !== active.length) pi.setActiveTools(kept);
    }
    for (const server of next) {
      const existing = states.get(server.name);
      if (!existing) {
        const state = newServerState(server);
        states.set(server.name, state);
        toConnect.push(state);
        continue;
      }
      if (!existing.removed && JSON.stringify(existing.config) === JSON.stringify(server)) continue;
      existing.removed = false;
      existing.config = server;
      existing.status = "pending";
      existing.error = null;
      toConnect.push(existing);
    }
    if (activeStates().length > 0) registerCoreTools();
    await connectStates(toConnect);
    deactivateUnselectedRemoteTools();
    writeStatus();
  }

  function statusLine(state: ServerState): string {
    const target = state.config.transport === "stdio"
      ? state.config.command ?? "?"
      : state.config.url ?? "?";
    const parts = [
      `${state.config.name} | ${state.config.transport} | ${state.status} | ${state.toolNames.length} tool(s)`,
      `  target: ${target}`,
    ];
    if (state.error) parts.push(`  last error: ${state.error}`);
    if (state.skipped.length > 0) parts.push(`  skipped: ${state.skipped.join(", ")}`);
    if (state.toolNames.length > 0) parts.push(`  tools: ${state.toolNames.join(", ")}`);
    if (state.stderr.length > 0) parts.push(`  stderr tail: ${state.stderr.slice(-5).join(" / ")}`);
    return parts.join("\n");
  }

  // An empty live roster registers nothing: the discovery and status tools
  // appear only once a server is assigned.
  if (activeStates().length > 0) registerCoreTools();

  // Pi awaits session_start before the session accepts a prompt. Fast servers
  // connect within the wait and the first turn sees them; slower ones finish
  // in the background, and the loader and remote calls wait on them on first
  // use. Every failure is recorded, never thrown.
  pi.on("session_start", async () => {
    try {
      const attempts = activeStates().map(ensureConnecting);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(attempts),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SESSION_START_CONNECT_WAIT_MS);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      // Remote definitions remain registered so the loader can activate them,
      // but only Codara's small discovery/status surface is sent initially.
      deactivateUnselectedRemoteTools();
    } catch (error) {
      for (const state of states.values()) {
        if (state.status === "pending") {
          state.status = "failed";
          state.error = errorText(error);
        }
      }
    }
    writeStatus();
  });

  // Input runs before the system prompt is built for the turn, so servers
  // assigned since the last prompt are connected and named in it.
  if (config.live) {
    pi.on("input", async () => {
      try {
        await reloadRoster();
      } catch {
        // A failed reload keeps the previous roster.
      }
    });
  }

  pi.on("session_shutdown", async () => {
    if (shutDown) return;
    shutDown = true;
    await Promise.allSettled([...states.values()].map(async (state) => {
      const client = state.client;
      state.client = null;
      if (client) await client.close().catch(() => undefined);
    }));
  });

  return {
    promptSuffix(): string {
      // A server still connecting is offered like a connected one: the loader
      // waits for it, so telling the model it is unavailable would be wrong.
      const usable = (state: ServerState) =>
        state.status === "connected" || (state.status === "pending" && state.connecting !== null);
      const healthy = activeStates().filter(usable);
      const broken = activeStates().filter((state) => !usable(state));
      const lines: string[] = [];
      if (healthy.length > 0) {
        lines.push(
          `Connected MCP servers: ${healthy.map((state) => `${state.config.name} (${state.status === "connected" ? `${state.toolNames.length} tools` : "connecting"})`).join(", ")}. Use ${EXTERNAL_TOOL_LOADER_NAME} to discover and activate only the relevant tools.`,
        );
      }
      if (broken.length > 0) {
        lines.push(
          `Unavailable MCP servers: ${broken.map((state) => `${state.config.name} (${state.status}${state.error ? `: ${state.error}` : ""})`).join("; ")}. Continue with normal tools and do not claim their capabilities were used. ${EXTERNAL_SERVER_STATUS_NAME} action=reconnect retries one.`,
        );
      }
      return lines.length > 0 ? `\n${lines.join("\n")}\n` : "";
    },
  };
}
