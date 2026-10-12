import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentAssetCompatibility,
  AgentPiMcpDelivery,
  AgentPiMcpLiveStatus,
  AgentPiMcpPreview,
  AgentSyncResult,
  AppSettings,
  WorkerRuntime,
} from "@shared/types";
import { claudeConfigDir, claudeUserConfigFile } from "./orchestration/claude-paths";
import { codaraHomeDir } from "./orchestration/codara-managed-cli-roots";
import { defaultPersonalCodexHomeDir } from "./orchestration/codex-cli-account-profiles";
import { defaultPersonalGrokHomeDir } from "./orchestration/grok-cli-account-profiles";
import type {
  AgentAssetDeleteResult,
  AgentAssetInstallResult,
  AgentAssetInventory,
  AgentAssetInventoryItem,
  AgentMcpSaveResult,
  AgentMcpImportCandidate,
  AgentMcpImportResult,
  AgentMcpServerDetail,
  AgentMcpServerDraft,
  AgentMcpTarget,
  AgentMcpTransport,
} from "@shared/types";
import { withConfigFileLock, writeConfigFileAtomic } from "./config-file-io";
import {
  parseTomlText,
  removeTomlMcpServer,
  renameTomlMcpServer,
  renderTomlMcpServer,
  scanTomlMcpServerNames,
  tomlMcpServerNamesFromDocument,
  tomlMcpServersFromDocument,
  upsertTomlMcpServer,
  type McpServerConfig,
} from "./mcp-toml";
import {
  PI_MCP_DEFAULTS,
  RESERVED_MCP_SERVER_NAMES,
  normalizePiMcpServersDetailed,
} from "./orchestration/pi-mcp-config";
import { outsideWriteCapability } from "./outside-write-guard";

/** Explicit exception to the outside-write guard: an MCP server or agent setting the user edited in Settings. */
const AGENT_CONFIG_EDIT = outsideWriteCapability("an MCP server or agent setting the user edited in Settings");

export type { McpServerConfig } from "./mcp-toml";

type SyncKind = "mcp" | "skill";
// Grok Build reads the same Codex-shaped TOML (`[mcp_servers.<name>]`), which
// is why mcp-installer registers the built-in server in ~/.grok/config.toml
// with renderCodexBlock(). One parser and one writer serve both.
type SyncSourceRuntime = "claude" | "codex" | "grok" | "shared" | "codara";
type TomlCopyRuntime = "codex" | "grok";
type SyncScope = "user" | "workspace";
type CliRuntime = "claude" | "codex" | "grok";

interface SyncSource {
  kind: SyncKind;
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
  names: string[];
  // ~/.claude.json only: the exact key under `projects` whose mcpServers map is
  // Claude's local scope for the active workspace.
  project?: string;
  // MCP only, and best effort: a name is discovered even when its definition
  // cannot be parsed, so a name may be missing from this map.
  configs?: Map<string, McpServerConfig>;
  // Skills only: the directory and frontmatter description behind each name.
  skillDirs?: Map<string, string>;
  skillDescriptions?: Map<string, string>;
  truncated?: boolean;
}

interface ParsedAssetId {
  kind: SyncKind;
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  name: string;
  path: string;
  project?: string;
  dir?: string;
}

/** Which Pi session role a discovered MCP server was assigned to. */
export type PiMcpScope = "cora" | "worker";

// ~/.claude.json keeps every project's history and grows well past what other
// config files reach; parses are cached by mtime, so the size cap only guards
// against a pathological file.
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_CLAUDE_USER_CONFIG_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_DOC_BYTES = 16 * 1024;
const MAX_SKILLS_PER_ROOT = 512;
const MAX_PI_SKILLS = 256;
const MAX_NAMES_PER_LINE = 12;
// Keys that hold an MCP server map in a JSON config.
const MCP_MAP_KEYS = ["mcpServers", "mcp_servers"];
const MAX_SOURCE_LINES = 8;
const MCP_SYNC_START = "# >>> SPARK_AGENT_MCP_SYNC";
const MCP_SYNC_END = "# <<< SPARK_AGENT_MCP_SYNC";
const CODEX_SYSTEM_SKILL_ROOT = "/skills/.system/";

const assetChangeListeners = new Set<() => void>();

/** Called after every Capability Center write, so live Pi rosters can refresh. */
export function onAgentAssetsChanged(listener: () => void): () => void {
  assetChangeListeners.add(listener);
  return () => assetChangeListeners.delete(listener);
}

function notifyAssetsChanged(): void {
  for (const listener of assetChangeListeners) {
    try {
      listener();
    } catch {
      // A listener failure must never fail the write that already landed.
    }
  }
}

type TrashFn = (path: string) => Promise<void>;
let trashItem: TrashFn | null = null;
let defaultPiAgentDir: string | null = null;

/**
 * Main-process wiring this module cannot import itself, because it also runs
 * in plain Node (tests, the remote bridge): removing a skill moves its folder
 * to the OS trash through Electron's shell.trashItem, and Cora's Pi agent
 * dir (under the Codara home) is a skill root Cora loads. Without a trash
 * function a removal is permanent.
 */
export function configureAgentSync(options: { trashItem?: TrashFn | null; piAgentDir?: string | null }): void {
  if (options.trashItem !== undefined) trashItem = options.trashItem;
  if (options.piAgentDir !== undefined) defaultPiAgentDir = options.piAgentDir;
}

/**
 * Codara's own MCP server list. Only Cora and her workers read it, and only
 * per launch through the Pi bridge roster, so a server added here never
 * reaches a CLI config. It is a Claude-shaped `mcpServers` map, mode 600,
 * because env values and headers may hold credentials.
 */
export function codaraMcpConfigPath(): string {
  return join(codaraHomeDir(), "mcp-servers.json");
}

/** Codara's own skill folder: skills created or imported in the Capability Center. */
export function codaraSkillsDir(): string {
  return join(codaraHomeDir(), "skills");
}

export function renderAgentSyncPromptLines(input: {
  cwd: string;
  runtime: WorkerRuntime;
  settings: Pick<AppSettings, "agentMcpSyncEnabled" | "agentSkillSyncEnabled" | "agentDisabledMcpIds" | "agentDisabledSkillIds">;
}): string[] {
  if (input.runtime !== "claude" && input.runtime !== "codex") return [];

  // A CLI never loads Codara's own servers or skills, so naming them to one
  // would advertise tools it cannot reach.
  const forCli = (sources: SyncSource[]) => sources.filter((source) => source.runtime !== "codara");
  const mcpSources = input.settings.agentMcpSyncEnabled
    ? filterSourcesForSessions(forCli(discoverMcpSources(input.cwd)), input.settings.agentDisabledMcpIds)
    : [];
  const skillSources = input.settings.agentSkillSyncEnabled
    ? filterSourcesForSessions(forCli(discoverSkillSources(input.cwd)), input.settings.agentDisabledSkillIds)
    : [];
  if (mcpSources.length === 0 && skillSources.length === 0) return [];

  const lines = [
    "Codara synced only compact MCP/skill awareness into this prompt so your context window stays focused.",
    "- Treat the names below as capability hints, not full documentation.",
    "- Inspect full runtime config or skill docs only when they materially help this task; summarize findings instead of pasting large config/tool output back into your working context.",
    "- If a listed MCP server or skill is not available in your current runtime session, continue with normal filesystem and terminal tools.",
  ];

  if (mcpSources.length > 0) {
    lines.push("", "MCP servers discovered:", ...formatSources(mcpSources));
  }
  if (skillSources.length > 0) {
    lines.push("", "Skills discovered:", ...formatSources(skillSources));
  }

  return lines;
}

export function listAgentAssets(input: {
  cwd?: string | null;
  settings: Pick<
    AppSettings,
    "agentDisabledMcpIds" | "agentDisabledSkillIds" | "agentMcpCoraManagerIds" | "agentMcpPiWorkerIds"
  >;
}): AgentAssetInventory {
  const cwd = input.cwd ?? "";
  const piScopes = {
    cora: input.settings.agentMcpCoraManagerIds ?? [],
    worker: input.settings.agentMcpPiWorkerIds ?? [],
  };
  const skillSources = discoverSkillSources(cwd || homedir());
  const visibleSkillSources = cwd ? skillSources : skillSources.filter((source) => source.scope === "user");
  const truncated = visibleSkillSources.some((source) => source.truncated);
  return {
    mcp: cwd
      ? sourcesToInventory(discoverMcpSources(cwd), input.settings.agentDisabledMcpIds, piScopes)
      : sourcesToInventory(discoverMcpSources(homedir()), input.settings.agentDisabledMcpIds, piScopes)
        .filter((item) => item.scope === "user"),
    skills: sourcesToInventory(visibleSkillSources, input.settings.agentDisabledSkillIds),
    ...(truncated ? { skillsTruncated: true } : {}),
  };
}

/**
 * Resolve the MCP servers a Pi session of the given role should connect to.
 * Assignment is opt-in per scope (AppSettings.agentMcpCoraManagerIds /
 * agentMcpPiWorkerIds) and still honors the session-wide disable list, so a
 * server disabled in the Capability Center never reaches Pi even if it was
 * assigned earlier. Discovery reuses the same config candidates Claude/Codex
 * sync reads; nothing is written.
 */
export function listPiMcpServers(input: {
  cwd?: string | null;
  scope: PiMcpScope;
  settings: Pick<AppSettings, "agentDisabledMcpIds" | "agentMcpCoraManagerIds" | "agentMcpPiWorkerIds">;
}): McpServerConfig[] {
  return resolvePiMcpAssignments(input).servers;
}

function resolvePiMcpAssignments(input: {
  cwd?: string | null;
  scope: PiMcpScope;
  settings: Pick<AppSettings, "agentDisabledMcpIds" | "agentMcpCoraManagerIds" | "agentMcpPiWorkerIds">;
}): {
  servers: McpServerConfig[];
  skipped: Array<{ key: string; name: string; state: AgentPiMcpDelivery["state"]; reason: string }>;
} {
  const assigned = new Set(
    input.scope === "cora"
      ? input.settings.agentMcpCoraManagerIds ?? []
      : input.settings.agentMcpPiWorkerIds ?? [],
  );
  const skipped: Array<{ key: string; name: string; state: AgentPiMcpDelivery["state"]; reason: string }> = [];
  if (assigned.size === 0) return { servers: [], skipped };
  const disabled = new Set(input.settings.agentDisabledMcpIds ?? []);
  const sources = discoverMcpSources(input.cwd?.trim() || homedir());
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  const turnedOff = new Map<string, string>();
  for (const source of sources) {
    for (const name of source.names) {
      const key = sessionKey("mcp", name);
      if (!assigned.has(key) || seen.has(key)) continue;
      if (disabled.has(key)) {
        turnedOff.set(key, name);
        continue;
      }
      const server = source.configs?.get(name) ?? null;
      // First readable definition wins: workspace candidates are listed before
      // user-scope ones, matching how the runtimes themselves resolve a name.
      if (!server) continue;
      if (server.enabled === false) {
        turnedOff.set(key, name);
        continue;
      }
      seen.add(key);
      turnedOff.delete(key);
      servers.push(server);
    }
  }
  for (const key of assigned) {
    if (seen.has(key)) continue;
    const name = turnedOff.get(key) ?? key.replace(/^mcp:/, "");
    if (disabled.has(key)) {
      skipped.push({ key, name, state: "turned-off", reason: "Turned off in the Capability Center." });
    } else if (turnedOff.has(key)) {
      skipped.push({ key, name, state: "turned-off", reason: "Its config entry sets enabled = false." });
    } else {
      skipped.push({ key, name, state: "no-definition", reason: "No readable definition was found for this workspace." });
    }
  }
  return { servers, skipped };
}

/**
 * What each assigned server's delivery to Pi looks like for this workspace:
 * delivered, dropped and why, plus evidence that a remote server signs in
 * through Claude's OAuth store (which the Pi bridge cannot use).
 */
export function describePiMcpDelivery(input: {
  cwd?: string | null;
  settings: Pick<AppSettings, "agentDisabledMcpIds" | "agentMcpCoraManagerIds" | "agentMcpPiWorkerIds">;
  env?: NodeJS.ProcessEnv;
  // Bridge reports from running Cora chats, keyed by lowercased bridge name.
  live?: ReadonlyMap<string, AgentPiMcpLiveStatus>;
}): AgentPiMcpPreview {
  const errors: string[] = [];
  const oauthNames = claudeMcpOAuthNames();
  const describe = (scope: PiMcpScope): AgentPiMcpDelivery[] => {
    try {
      const resolved = resolvePiMcpAssignments({ cwd: input.cwd, scope, settings: input.settings });
      const normalized = normalizePiMcpServersDetailed(resolved.servers, {
        cwd: input.cwd?.trim() || undefined,
        env: input.env,
      });
      const out: AgentPiMcpDelivery[] = [];
      for (const server of normalized.servers) {
        const raw = resolved.servers.find((entry) => entry.name === server.rawName);
        const live = scope === "cora" ? input.live?.get(server.name.toLowerCase()) : undefined;
        const needsOAuth = Boolean(
          raw?.url &&
          !Object.keys(raw.headers ?? {}).some((header) => header.toLowerCase() === "authorization") &&
          oauthNames.has(server.rawName.toLowerCase()),
        );
        out.push({
          sessionKey: sessionKey("mcp", server.rawName),
          name: server.rawName,
          state: needsOAuth ? "needs-oauth" : "delivered",
          ...(needsOAuth
            ? { reason: "This server signs in through Claude's OAuth login, which Cora cannot reuse. Add an Authorization header to use it from Cora." }
            : {}),
          ...(live ? { live } : {}),
        });
      }
      for (const dropped of normalized.dropped) {
        out.push({
          sessionKey: sessionKey("mcp", dropped.name),
          name: dropped.name,
          state: dropped.reason,
          reason: dropped.detail,
        });
      }
      for (const entry of resolved.skipped) {
        out.push({ sessionKey: entry.key, name: entry.name, state: entry.state, reason: entry.reason });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  };
  return {
    cora: describe("cora"),
    worker: describe("worker"),
    maxServers: PI_MCP_DEFAULTS.maxServers,
    errors,
  };
}

// Key names only: the token values in Claude's credential store are never read
// into Codara's memory beyond this parse.
function claudeMcpOAuthNames(): Set<string> {
  const names = new Set<string>();
  const text = readSmallText(join(claudeConfigDir(), ".credentials.json"), MAX_CONFIG_BYTES);
  if (!text) return names;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const store = parsed?.mcpOAuth;
    if (!store || typeof store !== "object" || Array.isArray(store)) return names;
    for (const key of Object.keys(store)) {
      const name = key.split("|")[0]?.trim().toLowerCase();
      if (name) names.add(name);
    }
  } catch {
    // An unreadable store is simply no evidence.
  }
  return names;
}

/**
 * Skill folders a Pi session (Cora or a Pi worker) should load, in priority
 * order. Pi starts with --no-skills plus one --skill per entry, so a skill the
 * user switched off in the Capability Center is really gone from Cora, and
 * skills kept in Claude's and Codex's folders reach her too. Pi's own roots
 * (.pi/skills, .agents/skills up to the repository root, ~/.agents/skills and
 * the agent dir) stay in the set, so nothing Pi loaded before is lost.
 */
export function listPiSkillPaths(input: {
  cwd?: string | null;
  piAgentDir?: string | null;
  settings: Pick<AppSettings, "agentDisabledSkillIds">;
}): string[] {
  const cwd = input.cwd?.trim() ?? "";
  const disabled = new Set(input.settings.agentDisabledSkillIds ?? []);
  // `piNative` roots also hold single-file skills (a root .md with skill
  // frontmatter), which Pi discovers there and nowhere else.
  const roots: Array<{ path: string; piNative: boolean }> = [];
  if (cwd) {
    roots.push({ path: join(cwd, ".pi", "skills"), piNative: true });
    for (const dir of ancestorsToRepoRoot(cwd)) roots.push({ path: join(dir, ".agents", "skills"), piNative: false });
    roots.push({ path: join(cwd, ".claude", "skills"), piNative: false });
    roots.push({ path: join(cwd, ".codex", "skills"), piNative: false });
  }
  // Ahead of every other user root: a skill the user added in Codara wins a
  // name clash with a copy some CLI keeps.
  roots.push({ path: codaraSkillsDir(), piNative: false });
  if (input.piAgentDir) roots.push({ path: join(input.piAgentDir, "skills"), piNative: true });
  if (defaultPiAgentDir) roots.push({ path: join(defaultPiAgentDir, "skills"), piNative: true });
  roots.push(
    { path: join(homedir(), ".agents", "skills"), piNative: false },
    { path: join(claudeConfigDir(), "skills"), piNative: false },
    { path: join(defaultPersonalCodexHomeDir(), "skills"), piNative: false },
  );
  const seenRoots = new Set<string>();
  const seenNames = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const rootKey = normalizePathForMatch(resolve(root.path));
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    const entries = [...indexSkillDirsByName(root.path).dirs];
    if (root.piNative) entries.push(...rootSkillFiles(root.path));
    for (const [name, location] of entries) {
      const key = sessionKey("skill", name);
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      if (disabled.has(key)) continue;
      // Codex's bundled system skills drive Codex-only tooling.
      if (normalizePathForMatch(location).includes(CODEX_SYSTEM_SKILL_ROOT)) continue;
      out.push(location);
      if (out.length >= MAX_PI_SKILLS) return out;
    }
  }
  return out;
}

function rootSkillFiles(root: string): Array<[string, string]> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".md") || entry.toLowerCase() === "skill.md") continue;
    const file = join(root, entry);
    const frontmatter = readSkillFrontmatter(file);
    if (!frontmatter?.description) continue;
    out.push([frontmatter.name || entry.replace(/\.md$/i, ""), file]);
  }
  return out;
}

function ancestorsToRepoRoot(cwd: string): string[] {
  const out: string[] = [];
  let current = resolve(cwd);
  for (let depth = 0; depth < 32; depth += 1) {
    out.push(current);
    if (pathExists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * Config files the Capability Center is allowed to write a user-authored MCP
 * server into. Private, user-scope files come first so the add form defaults
 * to a location that is never committed; workspace files that usually are
 * committed carry a hint. Every path is one discoverMcpSources reads back, and
 * `readBy` names the CLIs that load it.
 */
export function listMcpWriteTargets(input: { cwd?: string | null }): AgentMcpTarget[] {
  const cwd = input.cwd?.trim() ?? "";
  const home = homedir();
  const targets: AgentMcpTarget[] = [];
  targets.push(mcpTarget("codara", "user", codaraMcpConfigPath(), "Codara's own list", {
    readBy: [],
    hint: "Codara's own list. Cora and its workers get it per launch; your Claude, Codex and Grok configs stay untouched.",
  }));
  targets.push(mcpTarget("claude", "user", claudeUserConfigFile(), "Every workspace, Claude", {
    readBy: ["claude"],
  }));
  targets.push(mcpTarget("codex", "user", tomlRuntimeConfigPath("codex"), "Every workspace, Codex", {
    readBy: ["codex"],
  }));
  targets.push(mcpTarget("grok", "user", tomlRuntimeConfigPath("grok"), "Every workspace, Grok", {
    readBy: ["grok"],
  }));
  if (cwd) {
    targets.push(mcpTarget("claude", "workspace", claudeUserConfigFile(), "This workspace, Claude (private)", {
      readBy: ["claude"],
      hint: "Stored in your own ~/.claude.json for this folder only, never in the repository.",
    }));
    targets.push(mcpTarget("shared", "workspace", join(cwd, ".mcp.json"), "This workspace, project .mcp.json (Claude)", {
      readBy: ["claude"],
      hint: "Claude asks before using project servers. This file is usually committed to git, so use ${VAR} placeholders for secrets.",
    }));
    targets.push(mcpTarget("codex", "workspace", join(cwd, ".codex", "config.toml"), "This workspace, Codex", {
      readBy: ["codex"],
      hint: "Codex loads it for trusted projects. It may be committed to git, so use ${VAR} placeholders for secrets.",
    }));
  }
  targets.push(mcpTarget("shared", "user", join(home, ".mcp.json"), "Workspaces under your home folder, Claude (~/.mcp.json)", {
    readBy: ["claude"],
    hint: "Claude reads it for workspaces inside your home folder and asks before using it. Codex and Grok never read it.",
  }));
  return targets;
}

/** Full definition behind one discovered MCP entry, for the edit form. */
export function readMcpServerDetail(input: { id: string }): AgentMcpServerDetail | null {
  const parsed = parseAssetId(input.id);
  if (!parsed || parsed.kind !== "mcp") return null;
  const server = readMcpServerByName(parsed.path, parsed.name, parsed.project);
  if (!server) return null;
  return {
    id: input.id,
    targetId: mcpTargetId(parsed.runtime, parsed.scope, parsed.path),
    name: server.name,
    transport: mcpTransportOf(server),
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
  };
}

/**
 * The raw definition behind an asset id, for a connection test. The id comes
 * from the renderer and the result is started as a process, so only a config
 * file the inventory itself lists for `cwd` is read: an id naming another
 * folder's .mcp.json, or another project's map in ~/.claude.json, is refused.
 */
export function readMcpServerForAsset(
  id: string,
  cwd: string,
): { server: McpServerConfig; scope: SyncScope; path: string } | null {
  const parsed = parseAssetId(id);
  if (!parsed || parsed.kind !== "mcp") return null;
  const source = discoverMcpSources(cwd.trim() || homedir()).find((candidate) =>
    candidate.runtime === parsed.runtime &&
    candidate.scope === parsed.scope &&
    normalizePathForMatch(resolve(candidate.path)) === normalizePathForMatch(resolve(parsed.path)) &&
    (candidate.project ?? null) === (parsed.project ?? null));
  if (!source || !source.names.includes(parsed.name)) return null;
  const server = source.configs?.get(parsed.name) ?? null;
  return server ? { server, scope: parsed.scope, path: source.path } : null;
}

/** Validate an unsaved form draft into the runtime-agnostic shape. */
export function mcpServerFromDraft(draft: AgentMcpServerDraft): { server: McpServerConfig } | { error: string } {
  return validateMcpDraft(draft);
}

/**
 * Servers in the Claude, Codex and Grok configs for this workspace that can
 * be copied into Codara's own list. Read only: nothing here writes, and the
 * import below only ever writes Codara's file.
 */
export function listMcpImportCandidates(input: { cwd?: string | null }): AgentMcpImportCandidate[] {
  const sources = discoverMcpSources(input.cwd?.trim() || homedir());
  const inCodara = new Set(
    sources.filter((source) => source.runtime === "codara").flatMap((source) => source.names.map((name) => name.toLowerCase())),
  );
  const out: AgentMcpImportCandidate[] = [];
  for (const source of sources) {
    if (source.runtime === "codara") continue;
    for (const name of source.names) {
      if (isReservedMcpName(name)) continue;
      const server = source.configs?.get(name);
      if (!server) continue;
      out.push({
        id: assetId({
          kind: "mcp",
          runtime: source.runtime,
          scope: source.scope,
          name,
          path: source.path,
          ...(source.project !== undefined ? { project: source.project } : {}),
        }),
        name,
        runtime: source.runtime,
        scope: source.scope,
        path: source.path,
        transport: mcpTransportOf(server),
        summary: describeMcpServer(server),
        alreadyInCodara: inCodara.has(name.toLowerCase()),
      });
    }
  }
  return out;
}

/**
 * Copy servers from the CLI configs into Codara's own list. Each id must name
 * an entry the inventory lists for `cwd` (readMcpServerForAsset), so a forged
 * id cannot pull a definition from an arbitrary file. A name Codara already
 * has is skipped, never overwritten.
 */
export function importMcpServersToCodara(input: { cwd?: string | null; ids: readonly string[] }): Promise<AgentMcpImportResult> {
  return withAssetMutation(async () => {
    const cwd = input.cwd?.trim() || "";
    const destination = codaraMcpConfigPath();
    const target = mcpTarget("codara", "user", destination, "Codara");
    const imported: string[] = [];
    const skipped: string[] = [];
    try {
      for (const id of input.ids) {
        const parsed = parseAssetId(id);
        if (!parsed || parsed.kind !== "mcp" || parsed.runtime === "codara") {
          skipped.push("An entry that is not a CLI server was skipped.");
          continue;
        }
        const found = readMcpServerForAsset(id, cwd);
        if (!found) {
          skipped.push(`${parsed.name}: its definition could not be read.`);
          continue;
        }
        const { enabled: _enabled, cwd: _cwd, ...server } = found.server;
        if (isReservedMcpName(server.name) || !MCP_NAME_PATTERN.test(server.name)) {
          skipped.push(`${server.name}: Codara cannot use this name.`);
          continue;
        }
        const taken = mcpNameTaken(target, server.name, null);
        if (taken !== false) {
          skipped.push(taken === true ? `${server.name}: already in Codara.` : taken.error);
          continue;
        }
        await upsertClaudeMcpServer(destination, server, { codaraOwned: true });
        imported.push(server.name);
      }
    } catch (err) {
      return { ok: false, imported, skipped, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: imported.length > 0 || skipped.length === 0, imported, skipped };
  });
}

let assetMutationTail: Promise<void> = Promise.resolve();

function withAssetMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const operation = assetMutationTail.then(mutation);
  assetMutationTail = operation.then(() => undefined, () => undefined);
  void operation.then(notifyAssetsChanged, () => undefined);
  return operation;
}

export function mcpServerRevision(detail: AgentMcpServerDetail | null): string {
  return createHash("sha256").update(JSON.stringify(detail)).digest("hex");
}

/**
 * Create or update a user-authored MCP server. Unlike writeClaudeMcpServers,
 * which is additive and skips an existing name, this overwrites in place so an
 * edit sticks. When `replaceId` names an entry in a different file or under a
 * different name, that entry is removed after the new one is written, so an
 * edit that changes location moves rather than forks.
 */
export function saveMcpServer(input: Parameters<typeof saveMcpServerUnlocked>[0]): Promise<AgentMcpSaveResult> {
  return withAssetMutation(() => saveMcpServerUnlocked(input));
}

async function saveMcpServerUnlocked(input: {
  cwd?: string | null;
  targetId: string;
  server: AgentMcpServerDraft;
  replaceId?: string | null;
  expectedRevision?: string;
}): Promise<AgentMcpSaveResult> {
  if (input.expectedRevision !== undefined && (
    !input.replaceId || mcpServerRevision(readMcpServerDetail({ id: input.replaceId })) !== input.expectedRevision
  )) {
    return { ok: false, error: "This server changed in Studio. Reload its current configuration before saving." };
  }
  const previous = input.replaceId ? parseAssetId(input.replaceId) : null;
  const cwd = input.cwd?.trim() || "";
  let target = listMcpWriteTargets({ cwd: cwd || null }).find((item) => item.id === input.targetId);
  // Editing in place: an entry's own file is always a legal destination, even
  // when discovery reads it but the add form does not offer it as a location.
  if (!target && previous && previous.kind === "mcp") {
    const own = mcpTargetId(previous.runtime, previous.scope, previous.path);
    if (own === input.targetId) {
      target = mcpTarget(previous.runtime, previous.scope, previous.path, "Current location");
    }
  }
  if (!target) return { ok: false, error: "Unknown config location." };
  const validated = validateMcpDraft(input.server);
  if ("error" in validated) return { ok: false, error: validated.error };
  const server = validated.server;
  if (target.runtime === "grok" && server.headers) {
    return { ok: false, error: "Grok config.toml cannot carry request headers. Save this server to a Claude or Codex config instead." };
  }
  if (target.format === "toml" && server.type === "sse") {
    return { ok: false, error: "Codex and Grok configs cannot carry an SSE server. Save it to Codara or a Claude config instead." };
  }

  // ~/.claude.json at workspace scope is Claude's private per-project map.
  const project = isClaudeUserConfig(target.path) && target.scope === "workspace"
    ? previous?.project ?? (cwd ? claudeProjectKeyFor(target.path, cwd) : null)
    : null;
  if (isClaudeUserConfig(target.path) && target.scope === "workspace" && !project) {
    return { ok: false, error: "Open a workspace to save a server for this folder only." };
  }

  const previousServer = previous && previous.kind === "mcp"
    ? readMcpServerByName(previous.path, previous.name, previous.project)
    : null;
  if (isCommittableConfig(target, cwd)) {
    const secret = firstNewLiteralSecret(server, previous?.path === target.path ? previousServer : null);
    if (secret) {
      return {
        ok: false,
        error: `${secret.label} looks like a secret, and ${target.path} is usually committed to git. Write it as \${${secret.variable}} and set ${secret.variable} in your environment, or save the server to a private location such as "Every workspace" or "This workspace, Claude (private)".`,
      };
    }
  }

  // Editing an entry that already lives in this file and map: the write
  // rewrites it where it sits, so a rename inside the file is not a move.
  const editingHere = Boolean(
    previous && previous.kind === "mcp" && previous.path === target.path && (previous.project ?? null) === (project ?? null),
  );
  const replaceName = editingHere ? previous!.name : null;
  const replacingHere = editingHere && previous!.name === server.name;
  if (!replacingHere) {
    const taken = mcpNameTaken(target, server.name, project);
    if (taken !== false) {
      return { ok: false, error: taken === true ? `'${server.name}' already exists in ${target.path}.` : taken.error };
    }
  }

  try {
    if (target.format === "json") {
      await upsertClaudeMcpServer(target.path, server, { replaceName, project, codaraOwned: target.runtime === "codara" });
    }
    else await upsertCodexMcpServer(target.path, server, replaceName);
    const renamedInPlace = editingHere;
    if (previous && previous.kind === "mcp" && !replacingHere && !renamedInPlace) {
      await deleteMcpAsset(previous);
    }
    return { ok: true, name: server.name, path: target.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteAgentAsset(input: { id: string }): Promise<AgentAssetDeleteResult> {
  return withAssetMutation(() => deleteAgentAssetUnlocked(input));
}

async function deleteAgentAssetUnlocked(input: { id: string }): Promise<AgentAssetDeleteResult> {
  const parsed = parseAssetId(input.id);
  if (!parsed) return { ok: false, deleted: [], error: "Invalid agent asset id." };
  try {
    if (parsed.kind === "mcp") {
      const deleted = await deleteMcpAsset(parsed);
      if (deleted.length === 0) {
        return { ok: false, deleted: [], error: `'${parsed.name}' was not found in ${parsed.path}. Refresh the list.` };
      }
      if (mcpNameListed(parsed)) {
        return { ok: false, deleted: [], error: `'${parsed.name}' is still defined in ${parsed.path}. Edit the file by hand.` };
      }
      return { ok: true, deleted };
    }
    const deleted = await deleteSkillAsset(parsed);
    if (deleted.length === 0) {
      return { ok: false, deleted: [], error: `Skill '${parsed.name}' was not found under ${parsed.path}. Refresh the list.` };
    }
    return { ok: true, deleted };
  } catch (err) {
    return { ok: false, deleted: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function mcpNameListed(asset: ParsedAssetId): boolean {
  const loaded = loadConfig(asset.path);
  if (!loaded) return false;
  if (loaded.format === "json") {
    if (!loaded.json) return false;
    const container = jsonMcpContainer(loaded.json, asset.project);
    return Boolean(container && Object.prototype.hasOwnProperty.call(container, asset.name));
  }
  return loaded.tomlNames.includes(asset.name);
}

// `dryRun` walks the same path and fills the same lists without writing, so
// the Capability Center can show what a sync would copy before it asks.
export function syncAgentAssets(input: { cwd?: string | null; dryRun?: boolean }): Promise<AgentSyncResult> {
  if (input.dryRun) return syncAgentAssetsUnlocked(input);
  return withAssetMutation(() => syncAgentAssetsUnlocked(input));
}

async function syncAgentAssetsUnlocked(input: { cwd?: string | null; dryRun?: boolean }): Promise<AgentSyncResult> {
  const startedAt = new Date().toISOString();
  const result: AgentSyncResult = {
    startedAt,
    completedAt: startedAt,
    ...(input.dryRun ? { dryRun: true } : {}),
    mcp: { toClaude: [], toCodex: [], skipped: [], errors: [] },
    skills: { toClaude: [], toCodex: [], skipped: [], errors: [] },
  };

  await syncMcpConfigs(input.cwd ?? null, result);
  await syncSkillDirs(input.cwd ?? null, result);

  result.completedAt = new Date().toISOString();
  return result;
}

// Copy a single discovered asset into the runtime that was missing it. Powers
// the per-cell "Add to Claude/Codex/Grok" action in the Capability Center, so
// the user can spread one MCP server or skill without running a full sync.
export function installAgentAssetToRuntime(input: Parameters<typeof installAgentAssetToRuntimeUnlocked>[0]): Promise<AgentAssetInstallResult> {
  return withAssetMutation(() => installAgentAssetToRuntimeUnlocked(input));
}

async function installAgentAssetToRuntimeUnlocked(input: {
  id: string;
  target: "claude" | "codex" | "grok";
}): Promise<AgentAssetInstallResult> {
  const parsed = parseAssetId(input.id);
  if (!parsed) return { ok: false, installed: [], error: "Invalid agent asset id." };
  if (parsed.runtime === input.target) {
    return { ok: false, installed: [], error: `'${parsed.name}' is already installed for ${input.target}.` };
  }
  try {
    if (parsed.kind === "mcp") {
      return await installMcpAssetToRuntime(parsed, input.target);
    }
    // Skills are a Claude/Codex directory convention; Grok Build has no
    // equivalent skill root, so the Skills tab never offers a Grok column.
    if (input.target === "grok") {
      return { ok: false, installed: [], error: `Grok Build cannot carry skill '${parsed.name}'.` };
    }
    return await installSkillAssetToRuntime(parsed, input.target);
  } catch (err) {
    return { ok: false, installed: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function blankSyncResult(): AgentSyncResult {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    mcp: { toClaude: [], toCodex: [], skipped: [], errors: [] },
    skills: { toClaude: [], toCodex: [], skipped: [], errors: [] },
  };
}

// The workspace folder an asset belongs to, so a copy into Claude keeps its
// scope: a project server lands in Claude's private map for that project,
// never in the user-wide map where every Claude session would load it.
function assetWorkspaceRoot(asset: ParsedAssetId): string | null {
  if (asset.scope !== "workspace") return null;
  if (asset.project) return asset.project;
  const parent = dirname(asset.path);
  const parentName = basename(parent);
  if (parentName === ".codex" || parentName === ".grok" || parentName === ".claude") return dirname(parent);
  return parent;
}

async function installMcpAssetToRuntime(
  asset: ParsedAssetId,
  target: "claude" | "codex" | "grok",
): Promise<AgentAssetInstallResult> {
  const source = readMcpServerByName(asset.path, asset.name, asset.project);
  if (!source) {
    return {
      ok: false,
      installed: [],
      error: `Could not read MCP server '${asset.name}' from ${asset.path}.`,
    };
  }
  const workspaceRoot = assetWorkspaceRoot(asset);
  const result = blankSyncResult();
  if (target === "claude") {
    // An explicit copy of one server carries its headers: the destination is
    // Claude's own private config, and a remote server without its
    // Authorization header is a connection that fails on the first call.
    const added = await writeClaudeMcpServers(claudeUserConfigFile(), [source], result, {
      keepHeaders: true,
      project: workspaceRoot ?? undefined,
    });
    if (added.length === 0) {
      return { ok: false, installed: [], error: firstMcpMessage(result, `Could not add '${asset.name}' to Claude.`) };
    }
    return { ok: true, installed: added };
  }
  const label = TOML_RUNTIME_LABEL[target];
  if (target === "grok" && source.url && source.headers) {
    return {
      ok: false,
      installed: [],
      error: `'${asset.name}' sends request headers, which Grok Build config.toml cannot carry. Keep it in a Claude or Codex config.`,
    };
  }
  // Codex and Grok load a project config only for projects they trust, so a
  // copy lands in the user's own config, which works in every project.
  const destination = tomlRuntimeConfigPath(target);
  const server = source;
  const outcome = await withConfigFileLock(destination, async () => {
    const existing = await readTextIfExists(destination);
    const parsed = parseTomlText(existing);
    if (!parsed.ok) return { error: `Could not read ${destination}: ${parsed.error}` };
    if (tomlMcpServerNamesFromDocument(parsed.value).includes(server.name)) {
      return { error: `${label} already has MCP server '${server.name}'.` };
    }
    await fs.mkdir(dirname(destination), { recursive: true, mode: target === "grok" ? 0o700 : undefined });
    await writeConfigFileAtomic(destination, ensureTrailingNewline(upsertTomlMcpServer(existing, server, destination)), { outsideWrite: AGENT_CONFIG_EDIT });
    return { error: null };
  });
  if (outcome.error) return { ok: false, installed: [], error: outcome.error };
  return { ok: true, installed: [server.name] };
}

const TOML_RUNTIME_LABEL: Record<TomlCopyRuntime, string> = {
  codex: "Codex",
  grok: "Grok Build",
};

function tomlRuntimeConfigPath(runtime: TomlCopyRuntime): string {
  return runtime === "grok"
    ? join(defaultPersonalGrokHomeDir(), "config.toml")
    : join(defaultPersonalCodexHomeDir(), "config.toml");
}

async function installSkillAssetToRuntime(
  asset: ParsedAssetId,
  target: "claude" | "codex",
): Promise<AgentAssetInstallResult> {
  const sourceDir = resolveSkillDir(asset);
  if (!sourceDir) {
    return { ok: false, installed: [], error: `Could not locate skill '${asset.name}' under ${asset.path}.` };
  }
  if (isSymlink(sourceDir)) {
    return { ok: false, installed: [], error: `Skill '${asset.name}' is a symlink; copy it manually.` };
  }
  // Mirror the source scope: a workspace skill stays in the workspace (swap the
  // .claude/.codex segment), a user skill lands in the target's user root.
  const destRoot = deriveSkillDestRoot(asset.path, asset.scope, target);
  const dest = join(destRoot, basename(sourceDir));
  if (pathExists(dest)) {
    return { ok: false, installed: [], error: `${target} already has skill '${asset.name}'.` };
  }
  await fs.mkdir(destRoot, { recursive: true });
  await copyDir(sourceDir, dest);
  return { ok: true, installed: [asset.name] };
}

function firstMcpMessage(result: AgentSyncResult, fallback: string): string {
  return result.mcp.errors[0] ?? result.mcp.skipped[0] ?? fallback;
}

function deriveSkillDestRoot(sourceRoot: string, scope: SyncScope, target: "claude" | "codex"): string {
  if (scope === "user") {
    return join(target === "claude" ? claudeConfigDir() : defaultPersonalCodexHomeDir(), "skills");
  }
  // Discovered workspace roots are <workspace>/.claude|.codex|.agents|.pi/skills.
  // Scope, not a folder name inside a relocated user home, selects the target.
  return join(dirname(dirname(sourceRoot)), `.${target}`, "skills");
}

/**
 * Whether saving `name` into `target` would collide. Only the map the write
 * lands in counts: the top-level mcpServers map, or the per-project map for
 * Claude's private workspace scope. Fails closed: a file that exists but
 * cannot be read or parsed is reported, never treated as free.
 */
function mcpNameTaken(target: AgentMcpTarget, name: string, project: string | null): boolean | { error: string } {
  if (!pathExists(target.path)) return false;
  const loaded = loadConfig(target.path);
  if (!loaded) return { error: `Could not read ${target.path}.` };
  if (target.format === "toml") {
    if (loaded.tomlError) return { error: `Could not read ${target.path}: ${loaded.tomlError}` };
    return loaded.tomlNames.includes(name);
  }
  if (loaded.jsonError) return { error: `Could not read ${target.path}: ${loaded.jsonError}` };
  if (!loaded.json) return false;
  const container = jsonMcpContainer(loaded.json, project ?? undefined);
  return Boolean(container && Object.prototype.hasOwnProperty.call(container, name));
}

function readMcpServerByName(path: string, name: string, project?: string): McpServerConfig | null {
  const loaded = loadConfig(path);
  if (!loaded) return null;
  if (loaded.format === "json") {
    if (!loaded.json) return null;
    const container = jsonMcpContainer(loaded.json, project);
    if (!container || !Object.prototype.hasOwnProperty.call(container, name)) return null;
    return normalizeMcpServer(name, container[name]);
  }
  return loaded.tomlServers.find((server) => server.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface LoadedConfig {
  format: "json" | "toml";
  text: string;
  json: Record<string, unknown> | null;
  jsonError: string | null;
  tomlServers: McpServerConfig[];
  tomlNames: string[];
  tomlError: string | null;
}

const configCache = new Map<string, { version: string; loaded: LoadedConfig }>();

function maxBytesFor(path: string): number {
  return isClaudeUserConfig(path) ? MAX_CLAUDE_USER_CONFIG_BYTES : MAX_CONFIG_BYTES;
}

function isClaudeUserConfig(path: string): boolean {
  return normalizePathForMatch(resolve(path)) === normalizePathForMatch(resolve(claudeUserConfigFile()));
}

// Parsed once per file version: ~/.claude.json can be megabytes, and the
// inventory, Pi delivery and every edit would otherwise re-parse it.
function loadConfig(path: string): LoadedConfig | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytesFor(path)) return null;
  // The inode catches an atomic replace that lands within the same mtime tick.
  const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
  const cached = configCache.get(path);
  if (cached && cached.version === version) return cached.loaded;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const loaded: LoadedConfig = {
    format: path.toLowerCase().endsWith(".json") ? "json" : "toml",
    text,
    json: null,
    jsonError: null,
    tomlServers: [],
    tomlNames: [],
    tomlError: null,
  };
  if (loaded.format === "json") {
    if (text.trim()) {
      try {
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) loaded.jsonError = "Expected a JSON object.";
        else loaded.json = value as Record<string, unknown>;
      } catch (error) {
        loaded.jsonError = error instanceof Error ? error.message : String(error);
      }
    }
  } else {
    const parsed = parseTomlText(text);
    if (parsed.ok) {
      loaded.tomlServers = tomlMcpServersFromDocument(parsed.value);
      loaded.tomlNames = tomlMcpServerNamesFromDocument(parsed.value);
    } else {
      loaded.tomlError = parsed.error;
      loaded.tomlNames = scanTomlMcpServerNames(text);
    }
  }
  configCache.set(path, { version, loaded });
  if (configCache.size > 64) configCache.delete(configCache.keys().next().value!);
  return loaded;
}

function jsonMcpContainer(record: Record<string, unknown>, project?: string): Record<string, unknown> | null {
  let holder: unknown = record;
  if (project !== undefined) {
    const projects = record.projects;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return null;
    holder = (projects as Record<string, unknown>)[project];
  }
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return null;
  for (const key of MCP_MAP_KEYS) {
    const child = (holder as Record<string, unknown>)[key];
    if (child && typeof child === "object" && !Array.isArray(child)) return child as Record<string, unknown>;
  }
  return null;
}

function normalizeProjectPath(path: string): string {
  const unified = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return process.platform === "win32" || process.platform === "darwin" ? unified.toLowerCase() : unified;
}

/**
 * The key of the active workspace in ~/.claude.json `projects`, matched the
 * way Claude Code keys it (absolute path, compared through realpath and the
 * platform's case rules). Falls back to the cwd itself for a new entry.
 */
function claudeProjectKeyFor(path: string, cwd: string): string {
  return findClaudeProjectKey(loadConfig(path)?.json ?? null, cwd) ?? resolve(cwd);
}

function findClaudeProjectKey(record: Record<string, unknown> | null, cwd: string): string | null {
  const projects = record?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return null;
  const wanted = new Set([normalizeProjectPath(cwd)]);
  try {
    wanted.add(normalizeProjectPath(realpathSync(cwd)));
  } catch {
    // A workspace path that no longer exists still matches lexically.
  }
  for (const key of Object.keys(projects)) {
    if (wanted.has(normalizeProjectPath(key))) return key;
  }
  return null;
}

function discoverMcpSources(cwd: string): SyncSource[] {
  const sources: SyncSource[] = [];
  for (const candidate of mcpConfigCandidates(cwd)) {
    const loaded = loadConfig(candidate.path);
    if (!loaded) continue;
    let names: string[];
    let configs: Map<string, McpServerConfig>;
    let project: string | undefined;
    if (loaded.format === "json") {
      if (!loaded.json) continue;
      if (candidate.local) {
        const key = findClaudeProjectKey(loaded.json, cwd);
        if (!key) continue;
        project = key;
      }
      const container = jsonMcpContainer(loaded.json, project);
      if (!container) continue;
      names = [];
      configs = new Map();
      for (const [rawName, raw] of Object.entries(container)) {
        const name = rawName.trim();
        if (!name) continue;
        names.push(name);
        const server = normalizeMcpServer(name, raw);
        if (server) configs.set(name, server);
      }
      names.sort((a, b) => a.localeCompare(b));
    } else {
      names = [...loaded.tomlNames].sort((a, b) => a.localeCompare(b));
      configs = new Map(loaded.tomlServers.map((server) => [server.name, server]));
    }
    if (names.length === 0) continue;
    sources.push({
      kind: "mcp",
      runtime: candidate.runtime,
      scope: candidate.scope,
      path: candidate.path,
      names,
      configs,
      ...(project !== undefined ? { project } : {}),
    });
  }
  return dedupeSources(sources);
}

function discoverSkillSources(cwd: string): SyncSource[] {
  const sources: SyncSource[] = [];
  for (const candidate of skillRootCandidates(cwd)) {
    const index = indexSkillDirsByName(candidate.path);
    if (index.dirs.size === 0) continue;
    sources.push({
      kind: "skill",
      runtime: candidate.runtime,
      scope: candidate.scope,
      path: candidate.path,
      names: [...index.dirs.keys()].sort((a, b) => a.localeCompare(b)),
      skillDirs: index.dirs,
      skillDescriptions: index.descriptions,
      ...(index.truncated ? { truncated: true } : {}),
    });
  }
  return dedupeSources(sources);
}

function filterSourcesForSessions(sources: SyncSource[], disabledSessionKeys: string[]): SyncSource[] {
  const disabled = new Set(disabledSessionKeys);
  return sources
    .map((source) => ({
      ...source,
      names: source.names.filter((name) => !disabled.has(sessionKey(source.kind, name))),
    }))
    .filter((source) => source.names.length > 0);
}

/** Which agent CLIs actually load a given MCP config file, and a caveat if any. */
function mcpSourceReaders(source: Pick<SyncSource, "runtime" | "scope" | "path" | "project">): {
  readBy: CliRuntime[];
  note?: string;
} {
  if (source.runtime === "codara") {
    return { readBy: [], note: "Codara's own list: only Cora and its workers load it, per launch." };
  }
  if (source.runtime === "codex") return { readBy: ["codex"] };
  if (source.runtime === "grok") return { readBy: ["grok"] };
  if (source.runtime === "shared") {
    return source.scope === "workspace"
      ? { readBy: ["claude"], note: "Claude asks before using a project .mcp.json server. Codex and Grok never read .mcp.json." }
      : { readBy: ["claude"], note: "Claude reads ~/.mcp.json only for workspaces inside your home folder. Codex and Grok never read it." };
  }
  if (isClaudeUserConfig(source.path)) return { readBy: ["claude"] };
  return {
    readBy: [],
    note: "Claude Code does not load MCP servers from settings.json. Only Cora and Pi workers can use this entry.",
  };
}

function sourcesToInventory(
  sources: SyncSource[],
  disabledSessionKeys: string[],
  piScopes?: { cora: string[]; worker: string[] },
): AgentAssetInventoryItem[] {
  const disabled = new Set(disabledSessionKeys);
  const coraAssigned = new Set(piScopes?.cora ?? []);
  const workerAssigned = new Set(piScopes?.worker ?? []);
  const items: AgentAssetInventoryItem[] = [];
  // Mirrors resolvePiMcpAssignments: sources arrive in discovery order and the
  // first readable, enabled definition of a name is the one Pi connects with.
  const piDefined = new Set<string>();
  for (const source of sources) {
    const readers = source.kind === "mcp" ? mcpSourceReaders(source) : null;
    for (const name of source.names) {
      const key = sessionKey(source.kind, name);
      const skillDir = source.skillDirs?.get(name) ?? null;
      const config = source.kind === "mcp" ? source.configs?.get(name) ?? null : null;
      const piDefinition = Boolean(config && config.enabled !== false && !piDefined.has(key));
      if (piDefinition) piDefined.add(key);
      const compatibility = describeAssetCompatibility(source, skillDir, config);
      const skillDescription = source.skillDescriptions?.get(name);
      const systemSkill = Boolean(skillDir && normalizePathForMatch(skillDir).includes(CODEX_SYSTEM_SKILL_ROOT));
      items.push({
        id: assetId({
          kind: source.kind,
          runtime: source.runtime,
          scope: source.scope,
          name,
          path: source.path,
          ...(source.project !== undefined ? { project: source.project } : {}),
          ...(skillDir ? { dir: skillDir } : {}),
        }),
        sessionKey: key,
        kind: source.kind,
        runtime: source.runtime,
        scope: source.scope,
        name,
        path: source.path,
        enabledForSessions: !disabled.has(key),
        enabledForCoraManager: source.kind === "mcp" && coraAssigned.has(key),
        enabledForPiWorkers: source.kind === "mcp" && workerAssigned.has(key),
        detail: source.path,
        canDelete: !isProtectedSkillSource(source, skillDir),
        compatibility: compatibility.compatibility,
        compatibilityReason: compatibility.reason,
        syncable: compatibility.syncable,
        mcpTransport: config ? mcpTransportOf(config) : undefined,
        mcpSummary: config ? describeMcpServer(config) : undefined,
        ...(readers ? { readBy: readers.readBy, ...(readers.note ? { readByNote: readers.note } : {}) } : {}),
        ...(source.project !== undefined ? { claudeLocalScope: true } : {}),
        ...(piDefinition ? { piDefinition: true } : {}),
        ...(skillDir ? { skillDir } : {}),
        ...(skillDescription ? { skillDescription } : {}),
        ...(source.kind === "skill" ? { piLoads: !disabled.has(key) && !systemSkill } : {}),
      });
    }
  }
  return items.sort((a, b) => `${a.kind}:${a.name}:${a.runtime}:${a.scope}`.localeCompare(`${b.kind}:${b.name}:${b.runtime}:${b.scope}`));
}

function describeAssetCompatibility(
  source: SyncSource,
  skillDir: string | null,
  config?: McpServerConfig | null,
): { compatibility: AgentAssetCompatibility; reason: string; syncable: boolean } {
  if (source.kind === "mcp") {
    // Codex carries headers (http_headers, env_http_headers and
    // bearer_token_env_var). Grok Build's support is unconfirmed, so a copy
    // into Grok is refused with its own message instead.
    if (config?.url && config.headers) {
      return {
        compatibility: "both",
        reason: "This server sends request headers. Claude and Codex can carry them; Grok Build config.toml cannot.",
        syncable: true,
      };
    }
    return {
      compatibility: "both",
      reason: "MCP servers are runtime-agnostic if the local command or URL is reachable.",
      syncable: true,
    };
  }

  const normalizedSkillDir = normalizePathForMatch(skillDir ?? source.path);
  if (source.runtime === "codex" && normalizedSkillDir.includes(CODEX_SYSTEM_SKILL_ROOT)) {
    return {
      compatibility: "codex",
      reason: "Bundled Codex system skill; it may reference Codex-only tools or plugin hooks.",
      syncable: false,
    };
  }
  if (source.runtime === "shared") {
    return {
      compatibility: "both",
      reason: "Shared skill source.",
      syncable: true,
    };
  }
  return {
    compatibility: "both",
    reason: "Plain skill docs can be offered to either runtime; workers load full docs only when useful.",
    syncable: true,
  };
}

function isProtectedSkillSource(source: SyncSource, skillDir: string | null): boolean {
  if (source.kind !== "skill") return false;
  return Boolean(skillDir && normalizePathForMatch(skillDir).includes(CODEX_SYSTEM_SKILL_ROOT));
}

function sessionKey(kind: SyncKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}

function assetId(input: ParsedAssetId): string {
  return JSON.stringify(input);
}

function parseAssetId(id: string): ParsedAssetId | null {
  try {
    const parsed = JSON.parse(id) as Record<string, unknown>;
    const kind = parsed.kind === "mcp" || parsed.kind === "skill" ? parsed.kind : null;
    const runtime =
      parsed.runtime === "claude" ||
      parsed.runtime === "codex" ||
      parsed.runtime === "grok" ||
      parsed.runtime === "shared" ||
      parsed.runtime === "codara"
        ? parsed.runtime
        : null;
    const scope = parsed.scope === "user" || parsed.scope === "workspace" ? parsed.scope : null;
    const name = typeof parsed.name === "string" ? parsed.name : null;
    const path = typeof parsed.path === "string" ? parsed.path : null;
    if (!kind || !runtime || !scope || !name || !path) return null;
    return {
      kind,
      runtime,
      scope,
      name,
      path,
      ...(typeof parsed.project === "string" ? { project: parsed.project } : {}),
      ...(typeof parsed.dir === "string" ? { dir: parsed.dir } : {}),
    };
  } catch {
    return null;
  }
}

// Returns the names actually removed. An entry that is already gone is an
// empty list, which the move path in saveMcpServerUnlocked tolerates and
// deleteAgentAssetUnlocked reports.
async function deleteMcpAsset(asset: ParsedAssetId): Promise<string[]> {
  if (asset.runtime === "codara") {
    // Only Codara's own list: an id naming any other file under this runtime
    // is refused rather than deleted from.
    if (normalizePathForMatch(resolve(asset.path)) !== normalizePathForMatch(resolve(codaraMcpConfigPath()))) return [];
    return (await deleteClaudeMcpServer(asset.path, asset.name, undefined, true)) ? [asset.name] : [];
  }
  if (asset.runtime === "claude" || asset.runtime === "shared") {
    return (await deleteClaudeMcpServer(asset.path, asset.name, asset.project)) ? [asset.name] : [];
  }
  if (asset.runtime === "codex" || asset.runtime === "grok") {
    return (await deleteCodexMcpServer(asset.path, asset.name)) ? [asset.name] : [];
  }
  return [];
}

function resolveSkillDir(asset: ParsedAssetId): string | null {
  const root = resolve(asset.path);
  if (asset.dir) {
    const dir = resolve(asset.dir);
    const rel = relative(root, dir);
    // The id came through the renderer: only a skill folder inside the listed
    // root is ever touched.
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return findSkillFile(dir) ? dir : null;
  }
  return indexSkillDirsByName(root).dirs.get(asset.name) ?? null;
}

async function deleteSkillAsset(asset: ParsedAssetId): Promise<string[]> {
  const dir = resolveSkillDir(asset);
  if (!dir) return [];
  if (trashItem) await trashItem(dir);
  else await fs.rm(dir, { recursive: true, force: true });
  return [dir];
}

// Sync never crosses scopes: a project's .mcp.json reaches only that
// project's .codex/config.toml, and the user's Codex servers reach only the
// user's own ~/.claude.json. Copying user servers into a committed project
// file leaked their credentials, and copying project servers into the
// user-wide Codex config activated them in every Codex session.
async function syncMcpConfigs(cwd: string | null, result: AgentSyncResult): Promise<void> {
  try {
    // The built-in server is switched per CLI in the Capability Center, and its
    // entry holds this machine's absolute paths, so it never rides a sync.
    // Only the user's own tables count: an older sync filled the managed block
    // of the user Codex config with servers from project .mcp.json files, and
    // copying those into ~/.claude.json would activate them everywhere. Claude
    // has no `enabled` switch, so a server off in Codex would arrive on.
    const userCodex = readCodexMcpServers(tomlRuntimeConfigPath("codex"), { excludeManagedBlock: true })
      .filter((server) => !isReservedMcpName(server.name))
      .filter((server) => {
        if (server.enabled !== false) return true;
        result.mcp.skipped.push(`Codex MCP server '${server.name}' is turned off (enabled = false) and was not copied to Claude.`);
        return false;
      });
    const toClaude = await writeClaudeMcpServers(claudeUserConfigFile(), userCodex, result, { keepHeaders: true });
    result.mcp.toClaude.push(...toClaude);

    let projectServers: McpServerConfig[] = [];
    if (!cwd) {
      result.mcp.skipped.push("No active workspace; the project .mcp.json to .codex/config.toml sync was skipped.");
    } else {
      projectServers = readClaudeMcpServers(join(cwd, ".mcp.json")).filter((server) => !isReservedMcpName(server.name));
      const notes: string[] = [];
      const safe = projectServers.map((server) => placeholderSecrets(server, notes));
      const toCodex = await writeCodexManagedMcpServers(join(cwd, ".codex", "config.toml"), safe, result);
      result.mcp.toCodex.push(...toCodex);
      result.mcp.skipped.push(...notes);
    }

    if (userCodex.length === 0 && projectServers.length === 0) {
      result.mcp.skipped.push("No MCP servers found in the workspace .mcp.json or the user Codex config.toml.");
    }
  } catch (err) {
    result.mcp.errors.push(err instanceof Error ? err.message : String(err));
  }
}

async function syncSkillDirs(cwd: string | null, result: AgentSyncResult): Promise<void> {
  const rootPairs = [
    {
      codex: join(defaultPersonalCodexHomeDir(), "skills"),
      claude: join(claudeConfigDir(), "skills"),
      label: "user",
    },
  ];
  if (cwd) {
    rootPairs.push({
      codex: join(cwd, ".codex", "skills"),
      claude: join(cwd, ".claude", "skills"),
      label: "workspace",
    });
  }

  for (const pair of rootPairs) {
    await copyMissingSkills(pair.codex, pair.claude, "codex", "claude", pair.label, result);
    await copyMissingSkills(pair.claude, pair.codex, "claude", "codex", pair.label, result);
  }
}

const RESERVED_MCP_NAMES = new Set<string>(RESERVED_MCP_SERVER_NAMES.map((name) => name.toLowerCase()));

function isReservedMcpName(name: string): boolean {
  return RESERVED_MCP_NAMES.has(name.toLowerCase());
}

function readClaudeMcpServers(path: string): McpServerConfig[] {
  const loaded = loadConfig(path);
  if (!loaded?.json) return [];
  const container = jsonMcpContainer(loaded.json);
  if (!container) return [];
  return Object.entries(container)
    .map(([name, value]) => normalizeMcpServer(name, value))
    .filter((server): server is McpServerConfig => Boolean(server));
}

function readCodexMcpServers(path: string, options?: { excludeManagedBlock?: boolean }): McpServerConfig[] {
  const loaded = loadConfig(path);
  if (!loaded) return [];
  if (!options?.excludeManagedBlock) return loaded.tomlServers;
  const stripped = stripManagedMcpBlock(loaded.text);
  if (!stripped.removed) return loaded.tomlServers;
  const parsed = parseTomlText(stripped.text);
  return parsed.ok ? tomlMcpServersFromDocument(parsed.value) : [];
}

function normalizeMcpServer(name: string, value: unknown): McpServerConfig | null {
  if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const args = Array.isArray(record.args)
    ? record.args.filter((item): item is string => typeof item === "string")
    : undefined;
  const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
    ? Object.fromEntries(
      Object.entries(record.env as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, String(v)]),
    )
    : undefined;
  const headers = record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
    ? Object.fromEntries(
      Object.entries(record.headers as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, String(v)]),
    )
    : undefined;
  const server: McpServerConfig = {
    name: name.trim(),
    command: typeof record.command === "string" ? record.command : undefined,
    args,
    env,
    url: typeof record.url === "string" ? record.url : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    headers,
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
  };
  if (!server.command && !server.url) return null;
  return server;
}

// Writes the Codex managed block of a project's .codex/config.toml.
async function writeCodexManagedMcpServers(
  path: string,
  sourceServers: McpServerConfig[],
  result: AgentSyncResult,
): Promise<string[]> {
  if (sourceServers.length === 0) return [];
  const label = TOML_RUNTIME_LABEL.codex;
  return withConfigFileLock(path, async () => {
    const existing = await readTextIfExists(path);
    const whole = parseTomlText(existing);
    if (!whole.ok) {
      result.mcp.errors.push(`Could not read ${path}: ${whole.error}`);
      return [];
    }
    const stripped = stripManagedMcpBlock(existing);
    // The block is rewritten whole, so whatever an earlier sync put in it has
    // to be carried over.
    const managed = readManagedMcpBlockServers(existing);
    // Names outside the block only: the block's own entries are refreshed.
    const strippedParse = parseTomlText(stripped.text);
    const existingNames = new Set(strippedParse.ok ? tomlMcpServerNamesFromDocument(strippedParse.value) : []);
    const syncable = sourceServers.filter((server) => {
      if (existingNames.has(server.name)) {
        result.mcp.skipped.push(`${label} already has MCP server '${server.name}'.`);
        return false;
      }
      if (!server.command && !server.url) {
        result.mcp.skipped.push(`MCP server '${server.name}' is missing command/url and was skipped for ${label}.`);
        return false;
      }
      return true;
    });
    if (syncable.length === 0 && !stripped.removed) return [];
    if (result.dryRun) return syncable.map((server) => server.name);

    await fs.mkdir(dirname(path), { recursive: true });
    // Source definitions win over the copy already in the block, so a re-sync
    // still refreshes a changed command or env.
    const merged = new Map(managed.map((server) => [server.name, server]));
    for (const server of syncable) merged.set(server.name, server);
    const block = merged.size > 0 ? renderCodexManagedBlock([...merged.values()]) : "";
    const base = stripped.text.trimEnd();
    const next = [base, block].filter(Boolean).join("\n\n") + "\n";
    const check = parseTomlText(next);
    if (!check.ok) {
      result.mcp.errors.push(`Could not update ${path} safely: ${check.error}`);
      return [];
    }
    await writeConfigFileAtomic(path, next, { outsideWrite: AGENT_CONFIG_EDIT });
    return syncable.map((server) => server.name);
  });
}

async function writeClaudeMcpServers(
  path: string,
  sourceServers: McpServerConfig[],
  result: AgentSyncResult,
  options?: { keepHeaders?: boolean; project?: string },
): Promise<string[]> {
  if (sourceServers.length === 0) return [];
  return withConfigFileLock(path, async () => {
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(await fs.readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
      parsed = value as Record<string, unknown>;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        result.mcp.errors.push(`Could not read ${path}: ${(err as Error).message}`);
        return [];
      }
    }
    const existing = options?.project !== undefined
      ? ensureProjectJsonMcpMap(parsed, findClaudeProjectKey(parsed, options.project) ?? resolve(options.project))
      : ensureTopLevelJsonMcpMap(parsed);
    const added: string[] = [];
    for (const server of sourceServers) {
      if (existing[server.name]) {
        result.mcp.skipped.push(`Claude already has MCP server '${server.name}'.`);
        continue;
      }
      existing[server.name] = options?.keepHeaders
        ? renderUserMcpServer(server)
        : renderClaudeMcpServer(server);
      added.push(server.name);
    }
    if (added.length === 0 || result.dryRun) return added;
    await fs.mkdir(dirname(path), { recursive: true });
    await writeConfigFileAtomic(path, JSON.stringify(parsed, null, 2) + "\n", { outsideWrite: AGENT_CONFIG_EDIT });
    return added;
  });
}

function mcpTarget(
  runtime: SyncSourceRuntime,
  scope: SyncScope,
  path: string,
  label: string,
  extra?: { readBy?: CliRuntime[]; hint?: string },
): AgentMcpTarget {
  return {
    id: mcpTargetId(runtime, scope, path),
    runtime,
    scope,
    path,
    label,
    format: path.toLowerCase().endsWith(".json") ? "json" : "toml",
    ...(extra?.readBy ? { readBy: extra.readBy } : {}),
    ...(extra?.hint ? { hint: extra.hint } : {}),
  };
}

function mcpTargetId(runtime: SyncSourceRuntime, scope: SyncScope, path: string): string {
  return `${runtime}:${scope}:${path}`;
}

// A file inside the workspace that teams commit. ~/.claude.json at workspace
// scope is the user's private per-project map, not a repository file.
function isCommittableConfig(target: Pick<AgentMcpTarget, "scope" | "path">, cwd: string): boolean {
  if (target.scope !== "workspace" || isClaudeUserConfig(target.path)) return false;
  if (!cwd) return true;
  const rel = relative(resolve(cwd), resolve(target.path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// Names follow the API key conventions MCP servers document (FOO_API_KEY,
// GITHUB_TOKEN, Authorization), plus value shapes of well-known tokens.
const SECRET_NAME_SEGMENTS = new Set([
  "KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS", "PWD", "CREDENTIAL", "CREDENTIALS",
  "AUTH", "AUTHORIZATION", "BEARER", "COOKIE", "SESSION", "PRIVATE", "SIGNATURE", "PAT",
]);
const SECRET_VALUE_PATTERN = /^(?:Bearer\s+|Basic\s+)?(?:sk-|sk_|pk_live|rk_live|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abposr]-|AKIA|AIza|ya29\.|eyJ)/;

function isPlaceholderOnly(value: string): boolean {
  return /^(?:Bearer\s+)?\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

function looksSecret(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isPlaceholderOnly(trimmed)) return false;
  const segments = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (segments.some((segment) => SECRET_NAME_SEGMENTS.has(segment))) return true;
  return SECRET_VALUE_PATTERN.test(trimmed);
}

function placeholderName(server: string, name: string): string {
  return `${server}_${name}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "MCP_SECRET";
}

function firstNewLiteralSecret(
  server: McpServerConfig,
  previous: McpServerConfig | null,
): { label: string; variable: string } | null {
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (previous?.env?.[key] === value) continue;
    if (looksSecret(key, value)) return { label: `Environment variable ${key}`, variable: /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : placeholderName(server.name, key) };
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (previous?.headers?.[key] === value) continue;
    if (looksSecret(key, value)) return { label: `Header ${key}`, variable: placeholderName(server.name, key === "Authorization" ? "token" : key) };
  }
  return null;
}

/**
 * A copy of `server` safe to write into a committed workspace file: literal
 * secrets become ${VAR} placeholders (expanded by Claude, Codex env_vars and
 * the Pi bridge from the environment), and each replacement is noted so the
 * user knows which variable to set.
 */
function placeholderSecrets(server: McpServerConfig, notes: string[]): McpServerConfig {
  let changed = false;
  const env = server.env ? { ...server.env } : undefined;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!looksSecret(key, value)) continue;
    const variable = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : placeholderName(server.name, key);
    env![key] = `\${${variable}}`;
    notes.push(`'${server.name}': ${key} was written as \${${variable}} instead of its value. Set ${variable} in your environment.`);
    changed = true;
  }
  const headers = server.headers ? { ...server.headers } : undefined;
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!looksSecret(key, value)) continue;
    const bearer = /^Bearer\s+/i.test(value.trim());
    const variable = placeholderName(server.name, bearer || key.toLowerCase() === "authorization" ? "token" : key);
    headers![key] = bearer ? `Bearer \${${variable}}` : `\${${variable}}`;
    notes.push(`'${server.name}': header ${key} was written with \${${variable}} instead of its value. Set ${variable} in your environment.`);
    changed = true;
  }
  return changed ? { ...server, ...(env ? { env } : {}), ...(headers ? { headers } : {}) } : server;
}

// Names are used as TOML bare-or-quoted keys, JSON object keys, and Pi tool
// prefixes, so keep them to the charset every one of those accepts.
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateMcpDraft(draft: AgentMcpServerDraft): { server: McpServerConfig } | { error: string } {
  const name = draft.name.trim();
  if (!name) return { error: "Name is required." };
  if (!MCP_NAME_PATTERN.test(name)) {
    return { error: "Name may use letters, digits, dot, underscore and hyphen, and must start with a letter or digit." };
  }
  if (RESERVED_MCP_NAMES.has(name.toLowerCase())) {
    return { error: `${name} is reserved for Codara's built-in server.` };
  }
  if (draft.transport === "http" || draft.transport === "sse") {
    const url = (draft.url ?? "").trim();
    if (!url) return { error: `URL is required for an ${draft.transport === "sse" ? "SSE" : "HTTP"} server.` };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "URL is not a valid address." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "URL must start with http:// or https://." };
    }
    const headers = normalizeMcpPairs(draft.headers);
    if ("error" in headers) return { error: `Header ${headers.error}` };
    return {
      server: { name, url, type: draft.transport === "sse" ? "sse" : "streamable-http", headers: headers.value },
    };
  }
  if (draft.transport !== "stdio") return { error: "Choose how Codara starts the server." };
  const command = (draft.command ?? "").trim();
  if (!command) return { error: "Command is required for a stdio server." };
  if (/[\r\n\0]/.test(command)) return { error: "The command must be a single line." };
  const args = (draft.args ?? []).slice();
  const env = normalizeMcpPairs(draft.env);
  if ("error" in env) return { error: `Environment variable ${env.error}` };
  return {
    server: { name, command, args: args.length > 0 ? args : undefined, env: env.value },
  };
}

function normalizeMcpPairs(
  input?: Record<string, string>,
): { value?: Record<string, string> } | { error: string } {
  if (!input) return { value: undefined };
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (/[\s=:]/.test(key)) return { error: `name '${key}' cannot contain spaces, '=' or ':'.` };
    out[key] = String(rawValue ?? "");
  }
  return { value: Object.keys(out).length > 0 ? out : undefined };
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// Upsert, unlike writeClaudeMcpServers: an existing name is overwritten so an
// edit takes effect. A file that exists but does not parse throws rather than
// being replaced, so a hand-written config is never silently clobbered.
// `project` selects Claude's private per-project map in ~/.claude.json;
// without it the write lands on the top-level map.
async function upsertClaudeMcpServer(
  path: string,
  server: McpServerConfig,
  options?: { replaceName?: string | null; project?: string | null; codaraOwned?: boolean },
): Promise<void> {
  await withConfigFileLock(path, async () => {
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
      parsed = value as Record<string, unknown>;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Could not read ${path}: ${(err as Error).message}`);
      }
    }
    const container = options?.project
      ? ensureProjectJsonMcpMap(parsed, options.project)
      : ensureTopLevelJsonMcpMap(parsed);
    const replaceName = options?.replaceName ?? null;
    if (replaceName && replaceName !== server.name) delete container[replaceName];
    container[server.name] = renderUserMcpServer(server);
    await fs.mkdir(dirname(path), { recursive: true });
    // Codara's own list carries no outside-write capability, so the guard
    // refuses the write if that path ever resolves into a CLI's home.
    await writeConfigFileAtomic(
      path,
      JSON.stringify(parsed, null, 2) + "\n",
      options?.codaraOwned ? { mode: 0o600 } : { outsideWrite: AGENT_CONFIG_EDIT },
    );
  });
}

function ensureTopLevelJsonMcpMap(parsed: Record<string, unknown>): Record<string, unknown> {
  const existing = jsonMcpContainer(parsed);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  parsed.mcpServers = created;
  return created;
}

function ensureProjectJsonMcpMap(parsed: Record<string, unknown>, project: string): Record<string, unknown> {
  const projects =
    parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)
      ? parsed.projects as Record<string, unknown>
      : {};
  parsed.projects = projects;
  const entry =
    projects[project] && typeof projects[project] === "object" && !Array.isArray(projects[project])
      ? projects[project] as Record<string, unknown>
      : {};
  projects[project] = entry;
  return ensureTopLevelJsonMcpMap(entry);
}

async function upsertCodexMcpServer(path: string, server: McpServerConfig, replaceName: string | null): Promise<void> {
  await withConfigFileLock(path, async () => {
    let existing = await readTextIfExists(path);
    if (replaceName && replaceName !== server.name) existing = renameTomlMcpServer(existing, replaceName, server.name, path);
    const next = ensureTrailingNewline(upsertTomlMcpServer(existing, server, path));
    await fs.mkdir(dirname(path), { recursive: true });
    await writeConfigFileAtomic(path, next, { outsideWrite: AGENT_CONFIG_EDIT });
  });
}

// renderClaudeMcpServer is shared with sync, which never copies headers into a
// file other people read. A user-authored or private copy keeps them.
function renderUserMcpServer(server: McpServerConfig): Record<string, unknown> {
  const rendered = renderClaudeMcpServer(server);
  if (server.url && server.headers) rendered.headers = server.headers;
  return rendered;
}

function mcpTransportOf(server: McpServerConfig): AgentMcpTransport {
  if (!server.url) return "stdio";
  return server.type === "sse" ? "sse" : "http";
}

function describeMcpServer(server: McpServerConfig): string {
  if (server.url) {
    try {
      const url = new URL(server.url);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return server.url;
    }
  }
  const text = [server.command ?? "", ...(server.args ?? [])].filter(Boolean).join(" ");
  return text.length > 72 ? `${text.slice(0, 71)}…` : text;
}

async function deleteClaudeMcpServer(path: string, name: string, project?: string, codaraOwned = false): Promise<boolean> {
  return withConfigFileLock(path, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(`Could not read ${path}: ${(err as Error).message}`);
    }
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
      parsed = value as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Could not read ${path}: ${(err as Error).message}`);
    }
    const container = jsonMcpContainer(parsed, project);
    if (!container || !Object.prototype.hasOwnProperty.call(container, name)) return false;
    delete container[name];
    await writeConfigFileAtomic(
      path,
      JSON.stringify(parsed, null, 2) + "\n",
      codaraOwned ? { mode: 0o600 } : { outsideWrite: AGENT_CONFIG_EDIT },
    );
    return true;
  });
}

async function deleteCodexMcpServer(path: string, name: string): Promise<boolean> {
  return withConfigFileLock(path, async () => {
    const existing = await readTextIfExists(path);
    if (!existing) return false;
    const next = removeTomlMcpServer(existing, name, path);
    if (next === existing) return false;
    await writeConfigFileAtomic(path, next, { outsideWrite: AGENT_CONFIG_EDIT });
    return true;
  });
}

async function copyMissingSkills(
  sourceRoot: string,
  destRoot: string,
  sourceRuntime: "claude" | "codex",
  destRuntime: "claude" | "codex",
  scope: string,
  result: AgentSyncResult,
): Promise<void> {
  const skillDirs = findSkillDirs(sourceRoot).dirs;
  if (skillDirs.length === 0) return;
  if (!result.dryRun) await fs.mkdir(destRoot, { recursive: true });
  for (const source of skillDirs) {
    const name = basename(source);
    const compatibility = describeSkillDirCompatibility(sourceRuntime, source);
    if (!skillDirCanSyncToRuntime(compatibility.compatibility, destRuntime)) {
      result.skills.skipped.push(
        `${sourceRuntime} ${scope} skill '${name}' is ${compatibility.compatibility}-only; not copied to ${destRuntime}.`,
      );
      continue;
    }
    if (isSymlink(source)) {
      result.skills.skipped.push(`${sourceRuntime} ${scope} skill '${name}' is a symlink; skipped direct copy.`);
      continue;
    }
    const dest = join(destRoot, name);
    if (pathExists(dest)) {
      result.skills.skipped.push(`${destRuntime} already has ${scope} skill '${name}'.`);
      continue;
    }
    try {
      if (!result.dryRun) await copyDir(source, dest);
      const label = `${scope}:${name}`;
      if (destRuntime === "claude") result.skills.toClaude.push(label);
      else result.skills.toCodex.push(label);
    } catch (err) {
      result.skills.errors.push(
        `Could not copy ${sourceRuntime} ${scope} skill '${name}' to ${destRuntime}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function describeSkillDirCompatibility(
  sourceRuntime: "claude" | "codex",
  source: string,
): { compatibility: AgentAssetCompatibility; reason: string } {
  const normalized = normalizePathForMatch(source);
  if (sourceRuntime === "codex" && normalized.includes(CODEX_SYSTEM_SKILL_ROOT)) {
    return {
      compatibility: "codex",
      reason: "Bundled Codex system skill.",
    };
  }
  return {
    compatibility: "both",
    reason: "Plain skill docs.",
  };
}

function skillDirCanSyncToRuntime(
  compatibility: AgentAssetCompatibility,
  destRuntime: "claude" | "codex",
): boolean {
  return compatibility === "both" || compatibility === "unknown" || compatibility === destRuntime;
}

function mcpConfigCandidates(cwd: string): Array<{
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
  local?: boolean;
}> {
  const home = homedir();
  return [
    // First, so a server the user added or imported in Codara is the copy
    // Cora connects with when a CLI config holds the same name.
    { runtime: "codara", scope: "user", path: codaraMcpConfigPath() },
    { runtime: "shared", scope: "workspace", path: join(cwd, ".mcp.json") },
    // Claude's private per-project servers: ~/.claude.json projects[<cwd>].
    // Other projects' maps in the same file are never read.
    { runtime: "claude", scope: "workspace", path: claudeUserConfigFile(), local: true },
    // Claude Code does not load MCP servers from settings.json; these stay as
    // read-only sources because existing configs rely on them for Pi delivery.
    { runtime: "claude", scope: "workspace", path: join(cwd, ".claude", "settings.json") },
    { runtime: "claude", scope: "workspace", path: join(cwd, ".claude", "settings.local.json") },
    { runtime: "codex", scope: "workspace", path: join(cwd, ".codex", "config.toml") },
    // Grok Build's workspace config mirrors Codex's, and mcp-installer already
    // probes the same path when it looks for a user-owned built-in entry.
    { runtime: "grok", scope: "workspace", path: join(cwd, ".grok", "config.toml") },
    { runtime: "shared", scope: "user", path: join(home, ".mcp.json") },
    { runtime: "claude", scope: "user", path: claudeUserConfigFile() },
    { runtime: "claude", scope: "user", path: join(claudeConfigDir(), "settings.json") },
    { runtime: "codex", scope: "user", path: tomlRuntimeConfigPath("codex") },
    { runtime: "grok", scope: "user", path: tomlRuntimeConfigPath("grok") },
  ];
}

function skillRootCandidates(cwd: string): Array<{
  runtime: SyncSourceRuntime;
  scope: SyncScope;
  path: string;
}> {
  return [
    { runtime: "codex", scope: "workspace", path: join(cwd, ".codex", "skills") },
    { runtime: "claude", scope: "workspace", path: join(cwd, ".claude", "skills") },
    { runtime: "shared", scope: "workspace", path: join(cwd, ".agents", "skills") },
    // Pi's own roots: Cora loads these natively.
    { runtime: "shared", scope: "workspace", path: join(cwd, ".pi", "skills") },
    { runtime: "codara", scope: "user", path: codaraSkillsDir() },
    { runtime: "codex", scope: "user", path: join(defaultPersonalCodexHomeDir(), "skills") },
    { runtime: "claude", scope: "user", path: join(claudeConfigDir(), "skills") },
    { runtime: "shared", scope: "user", path: join(homedir(), ".agents", "skills") },
    ...(defaultPiAgentDir
      ? [{ runtime: "shared" as const, scope: "user" as const, path: join(defaultPiAgentDir, "skills") }]
      : []),
  ];
}

function readSmallText(path: string, maxBytes: number): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function stripManagedMcpBlock(text: string): { text: string; removed: boolean } {
  const start = text.indexOf(MCP_SYNC_START);
  const end = text.indexOf(MCP_SYNC_END);
  if (start === -1 || end === -1 || end < start) return { text, removed: false };
  const after = end + MCP_SYNC_END.length;
  return {
    text: `${text.slice(0, start).trimEnd()}\n${text.slice(after).trimStart()}`.trimEnd() + "\n",
    removed: true,
  };
}

// Servers currently living between the managed markers. Callers that rebuild
// the block need them to keep the servers earlier syncs installed.
function readManagedMcpBlockServers(text: string): McpServerConfig[] {
  const start = text.indexOf(MCP_SYNC_START);
  const end = text.indexOf(MCP_SYNC_END);
  if (start === -1 || end === -1 || end < start) return [];
  const parsed = parseTomlText(text.slice(start + MCP_SYNC_START.length, end));
  return parsed.ok ? tomlMcpServersFromDocument(parsed.value) : [];
}

function renderCodexManagedBlock(servers: McpServerConfig[]): string {
  return [
    MCP_SYNC_START,
    "# Managed by Codara Settings > Agents sync. Edit the source .mcp.json or remove this block to reset.",
    ...servers.flatMap((server) => renderTomlMcpServer(server)),
    MCP_SYNC_END,
  ].join("\n");
}

function renderClaudeMcpServer(server: McpServerConfig): Record<string, unknown> {
  if (server.url) {
    return {
      type: server.type === "sse" ? "sse" : "streamable-http",
      url: server.url,
    };
  }
  return {
    type: "stdio",
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
  };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function findSkillDirs(root: string): { dirs: string[]; truncated: boolean } {
  if (!directoryExists(root)) return { dirs: [], truncated: false };
  const out: string[] = [];
  const truncated = collectSkillDirs(root, 0, out);
  return { dirs: out, truncated };
}

/**
 * Each skill folder under `root`, keyed by the name the agents use for it:
 * the SKILL.md frontmatter `name`, else the folder name. A Markdown heading is
 * never a name; skills often share headings such as "# Instructions".
 */
function indexSkillDirsByName(root: string): {
  dirs: Map<string, string>;
  descriptions: Map<string, string>;
  truncated: boolean;
} {
  const indexed = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const found = findSkillDirs(root);
  for (const dir of found.dirs) {
    const frontmatter = readSkillFrontmatter(findSkillFile(dir));
    const name = frontmatter?.name || basename(dir);
    if (indexed.has(name)) continue;
    indexed.set(name, dir);
    if (frontmatter?.description) descriptions.set(name, frontmatter.description);
  }
  return { dirs: indexed, descriptions, truncated: found.truncated };
}

// Returns true when the per-root cap stopped the walk early.
function collectSkillDirs(dir: string, depth: number, out: string[]): boolean {
  if (out.length >= MAX_SKILLS_PER_ROOT) return true;
  if (depth > 3) return false;
  if (findSkillFile(dir)) {
    out.push(dir);
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries.sort()) {
    if (entry === "node_modules" || entry === ".git") continue;
    const child = join(dir, entry);
    if (!directoryExists(child)) continue;
    if (collectSkillDirs(child, depth + 1, out)) return true;
  }
  return false;
}

async function copyDir(source: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const sourcePath = join(source, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destPath);
    }
  }
}

function findSkillFile(dir: string): string | null {
  const candidates = [join(dir, "SKILL.md"), join(dir, "skill.md")];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function readSkillFrontmatter(path: string | null): { name?: string; description?: string } | null {
  if (!path) return null;
  const text = readSmallText(path, MAX_SKILL_DOC_BYTES);
  if (!text) return null;
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(name|description)\s*:\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    let value = field[2].trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-" || value === "") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      value = block.join(" ");
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (field[1] === "name") out.name = value.slice(0, 80);
    else out.description = value.slice(0, 400);
  }
  return out;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizePathForMatch(path: string): string {
  return path.split(sep).join("/").replace(/\\/g, "/").toLowerCase();
}

function dedupeSources(sources: SyncSource[]): SyncSource[] {
  const out: SyncSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.kind}:${source.runtime}:${source.scope}:${source.path}:${source.project ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...source,
      names: [...new Set(source.names.map((name) => name.trim()).filter(Boolean))],
    });
  }
  return out.filter((source) => source.names.length > 0);
}

function formatSources(sources: SyncSource[]): string[] {
  const visible = sources.slice(0, MAX_SOURCE_LINES);
  const lines = visible.map((source) => {
    const names = source.names.slice(0, MAX_NAMES_PER_LINE);
    const suffix = source.names.length > names.length ? `, +${source.names.length - names.length} more` : "";
    return `- ${source.runtime} ${source.scope} (${source.path}): ${names.join(", ")}${suffix}`;
  });
  const omitted = sources.length - visible.length;
  if (omitted > 0) {
    lines.push(`- +${omitted} more source(s) omitted to keep this prompt compact.`);
  }
  return lines;
}
