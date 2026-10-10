import { execFile } from "node:child_process";
import { join } from "node:path";
import type { AgentMcpProbeRequest, AgentMcpProbeResult, Workspace } from "@shared/types";
import { mcpServerFromDraft, readMcpServerForAsset, type McpServerConfig } from "./agent-sync";
import { normalizePiMcpServersDetailed, type PiMcpServerConfig } from "./orchestration/pi-mcp-config";
import { buildPiSubscriptionEnvironment } from "./orchestration/pi-runtime";
import { workspaceProjectPolicyModeForTerminalCwd } from "./orchestration/project-policy";

// One-shot connection test for a user MCP server: start it (or reach its URL)
// the way the Pi bridge would, run initialize and tools/list, and shut it
// down. It runs arbitrary commands, so callers invoke it only on an explicit
// click and never for a workspace the user has not trusted.

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDERR_LINES = 20;
const MAX_TOOLS = 256;

interface ProbeClient {
  connect(transport: unknown, options?: Record<string, unknown>): Promise<void>;
  listTools(params?: unknown, options?: Record<string, unknown>): Promise<{ tools?: Array<{ name?: unknown; description?: unknown }> }>;
  getServerVersion?(): { name?: string; version?: string } | undefined;
  close(): Promise<void>;
}

interface ProbeTransport {
  stderr?: NodeJS.ReadableStream | null;
  pid?: number | null;
  close?(): Promise<void>;
}

export interface McpProbeOptions {
  /** Environment the server inherits; the Pi bridge's own, credentials stripped. */
  baseEnv: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function redact(text: string, server: PiMcpServerConfig): string {
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

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// `npx` and shell wrappers spawn the real server as a grandchild, which a
// SIGTERM to the direct child leaves running. Collect the tree up front and
// kill whatever is left after the transport closed.
async function descendantPids(pid: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  const table = await new Promise<string>((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 2_000 }, (error, stdout) => resolve(error ? "" : stdout));
  });
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [childText, parentText] = line.trim().split(/\s+/);
    const child = Number(childText);
    const parent = Number(parentText);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

// Windows walks the tree itself, so it runs while the direct child is alive.
async function killWindowsTree(pid: number | null | undefined): Promise<void> {
  if (!pid || process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: 5_000, windowsHide: true }, () => resolve());
  });
}

// The SDK's close() already ended the direct child; only orphans remain.
function killOrphans(descendants: number[]): void {
  for (const target of descendants) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export async function probeMcpServer(server: PiMcpServerConfig, options: McpProbeOptions): Promise<AgentMcpProbeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stderr: string[] = [];
  let transport: ProbeTransport | null = null;
  let client: ProbeClient | null = null;
  let descendants: number[] = [];
  const finish = (result: Omit<AgentMcpProbeResult, "durationMs" | "transport" | "stderrTail">): AgentMcpProbeResult => ({
    ...result,
    transport: server.transport,
    durationMs: Date.now() - started,
    ...(stderr.length > 0 ? { stderrTail: stderr.slice(-MAX_STDERR_LINES).map((line) => redact(line, server)) } : {}),
  });
  try {
    const [{ Client }, stdio, http, sse] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/client/sse.js"),
    ]);
    if (server.transport === "stdio") {
      const stdioTransport = new stdio.StdioClientTransport({
        command: server.command!,
        args: server.args ?? [],
        env: Object.fromEntries(
          Object.entries({ ...options.baseEnv, ...(server.env ?? {}) })
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        cwd: server.cwd,
        stderr: "pipe",
      });
      stdioTransport.stderr?.on("data", (chunk: Buffer | string) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          stderr.push(trimmed.slice(0, 500));
          if (stderr.length > MAX_STDERR_LINES * 2) stderr.shift();
        }
      });
      transport = stdioTransport as unknown as ProbeTransport;
    } else {
      const url = new URL(server.url!);
      const requestInit = server.headers ? { requestInit: { headers: server.headers } } : undefined;
      transport = (server.transport === "sse"
        ? new sse.SSEClientTransport(url, requestInit)
        : new http.StreamableHTTPClientTransport(url, requestInit)) as unknown as ProbeTransport;
    }
    client = new Client({ name: "codara-probe", version: "1" }) as unknown as ProbeClient;
    const connecting = client.connect(transport, { timeout: timeoutMs });
    if (transport.pid) void descendantPids(transport.pid).then((pids) => { descendants = pids; });
    await withTimeout(connecting, timeoutMs, "Connecting");
    if (transport.pid) descendants = await descendantPids(transport.pid);
    const remaining = Math.max(1_000, timeoutMs - (Date.now() - started));
    const listed = await withTimeout(client.listTools(undefined, { timeout: remaining }), remaining, "Listing tools");
    const info = client.getServerVersion?.();
    const tools = (listed?.tools ?? [])
      .slice(0, MAX_TOOLS)
      .map((tool) => ({
        name: typeof tool?.name === "string" ? tool.name : "",
        ...(typeof tool?.description === "string" && tool.description.trim()
          ? { description: tool.description.trim().replace(/\s+/g, " ").slice(0, 300) }
          : {}),
      }))
      .filter((tool) => tool.name);
    return finish({
      ok: true,
      tools,
      ...(info?.name ? { serverName: info.name } : {}),
      ...(info?.version ? { serverVersion: info.version } : {}),
    });
  } catch (error) {
    return finish({ ok: false, tools: [], error: redact(errorText(error), server) });
  } finally {
    await killWindowsTree(transport?.pid);
    await client?.close().catch(() => undefined);
    await transport?.close?.().catch(() => undefined);
    killOrphans(descendants);
  }
}

/**
 * Test one server from the Capability Center: a discovered entry by asset id,
 * or an unsaved form draft. The server is resolved and normalized the way it
 * would be handed to Pi for this workspace and starts with the same
 * credential-stripped environment, so a pass here means Cora can connect too.
 * A workspace-scoped entry inside an imported pull request is never started:
 * its command comes from untrusted repository content.
 */
export async function runMcpProbe(
  input: AgentMcpProbeRequest,
  context: { workspaces: readonly Workspace[]; piAgentDir: string; timeoutMs?: number },
): Promise<AgentMcpProbeResult> {
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  let raw: McpServerConfig;
  if (typeof input.id === "string" && input.id) {
    const found = readMcpServerForAsset(input.id);
    if (!found) return { ok: false, tools: [], durationMs: 0, error: "This server's definition could not be read. Refresh the list." };
    if (found.scope === "workspace" && !cwd) {
      return { ok: false, tools: [], durationMs: 0, error: "Open the workspace this server belongs to, then test it again." };
    }
    if (found.scope === "workspace" &&
      (await workspaceProjectPolicyModeForTerminalCwd(cwd, context.workspaces)) === "untrusted-pull-request") {
      return {
        ok: false,
        tools: [],
        durationMs: 0,
        error: "This server comes from an imported pull request's configuration, so Codara will not start it.",
      };
    }
    raw = found.server;
  } else if (input.draft && typeof input.draft === "object") {
    const validated = mcpServerFromDraft(input.draft);
    if ("error" in validated) return { ok: false, tools: [], durationMs: 0, error: validated.error };
    raw = validated.server;
  } else {
    return { ok: false, tools: [], durationMs: 0, error: "Choose a server to test." };
  }
  const normalized = normalizePiMcpServersDetailed([raw], { cwd: cwd || undefined, maxServers: 1 });
  const server = normalized.servers[0];
  if (!server) {
    return { ok: false, tools: [], durationMs: 0, error: normalized.dropped[0]?.detail ?? "This server cannot be started." };
  }
  const { rawName: _rawName, ...config } = server;
  const baseEnv = buildPiSubscriptionEnvironment(process.env, context.piAgentDir, join(context.piAgentDir, "sessions"));
  return probeMcpServer(config, { baseEnv, timeoutMs: context.timeoutMs });
}
