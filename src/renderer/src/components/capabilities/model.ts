import type {
  AgentAssetInventoryItem,
  AgentMcpServerDetail,
  AgentMcpTarget,
  AgentPiMcpDelivery,
  AgentPiMcpPreview,
  AgentSyncResult,
  AppSettings,
  MemoryTierStatus,
} from "@shared/types";
import { isOpenRouterModelId, DEFAULT_CORA_WORKER_MODELS } from "@shared/worker-model-roster";

// Pure state and helpers behind the Capability Center. Nothing here touches the
// DOM or IPC except openRouterKeyVerified, which hashes with WebCrypto.

export type CapabilityTab = "mcp" | "skills" | "profiles" | "memory" | "workers" | "policy";

export const CAPABILITY_TABS: { id: CapabilityTab; label: string }[] = [
  { id: "mcp", label: "Tools (MCP servers)" },
  { id: "skills", label: "Skills" },
  { id: "profiles", label: "Profiles" },
  { id: "memory", label: "Memory" },
  { id: "workers", label: "Worker models" },
  { id: "policy", label: "Behavior" },
];

export function isCapabilityTab(value: unknown): value is CapabilityTab {
  return CAPABILITY_TABS.some((tab) => tab.id === value);
}

export type CapabilityKind = "mcp" | "skill";
export type RuntimeColumn = "claude" | "codex" | "grok" | "shared";
export type CliRuntime = "claude" | "codex" | "grok";

export const RUNTIME_COLUMNS: RuntimeColumn[] = ["claude", "codex", "grok", "shared"];
export const CLI_RUNTIMES: CliRuntime[] = ["claude", "codex", "grok"];
export const PAGE_SIZE = 40;

export const RUNTIME_LABEL: Record<RuntimeColumn, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  shared: "Shared",
};
// What the user calls the external tools. RUNTIME_LABEL names the config
// column (and reads right in "Removed X from Claude"); this names the app.
export const CLI_LABEL: Record<CliRuntime, string> = {
  claude: "Claude CLI",
  codex: "Codex CLI",
  grok: "Grok Build",
};

// codara-studio ships inside Codara itself. It stays at the top of the MCP list
// with its own install controls and is hidden from the discovered inventory so
// it never reads as a third-party connector. The retired names are earlier
// copies of the same server: a workspace config can still hold one, and Pi
// drops all five by name, so a row with live-looking switches would be a lie.
// Mirrors RESERVED_MCP_SERVER_NAMES in src/main/orchestration/pi-mcp-config.ts,
// which the renderer cannot import (main-process module); scripts/test-pi-mcp-
// config.cjs asserts the two lists stay identical.
export const RESERVED_MCP_NAMES = new Set([
  "codara-studio",
  "spark-preview",
  "cora-preview",
  "spark-orchestrator",
  "cora-orchestrator",
]);

export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface NameGroup {
  kind: CapabilityKind;
  name: string;
  sessionKey: string;
  installs: Record<RuntimeColumn, AgentAssetInventoryItem[]>;
  // The copy the row describes: the definition Cora and Pi workers connect
  // with when there is one, otherwise the first copy found.
  any: AgentAssetInventoryItem;
  // MCP only: the copies do not all describe the same server.
  differs: boolean;
}

export interface Pair {
  key: string;
  value: string;
}

// One other copy of a server being edited: the same name in another config
// file. The form offers to update it too, ticked when it matched.
export interface EditorCopy {
  id: string;
  targetId: string;
  runtime: RuntimeColumn;
  path: string;
  selected: boolean;
  matched: boolean;
}

// The add/edit form. `replaceId` is the asset id being edited, which the save
// removes when the name or the destination file changed, so an edit moves an
// entry instead of forking it.
export interface EditorState {
  mode: "add" | "edit";
  replaceId: string | null;
  originalName: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  env: Pair[];
  url: string;
  headers: Pair[];
  // Who should be able to use it inside Codara.
  cora: boolean;
  workers: boolean;
  // Add: which CLI configs receive it, at which scope, unless the user picked
  // one exact file instead.
  clis: Record<CliRuntime, boolean>;
  scope: "user" | "workspace";
  customTargetId: string | null;
  // Edit: the file this copy lives in (changing it moves the entry), and the
  // other copies of the same name.
  targetId: string;
  copies: EditorCopy[];
}

export type StatusTone = "ok" | "error" | "info";
export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

export function ok(text: string): StatusMessage {
  return { tone: "ok", text };
}
export function failure(text: string): StatusMessage {
  return { tone: "error", text };
}
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The CLIs that load an item's file. Older main processes did not send
// readBy, so the runtime column stands in for it.
export function itemReadBy(item: AgentAssetInventoryItem): CliRuntime[] {
  if (item.readBy) return item.readBy as CliRuntime[];
  if (item.runtime === "shared") return ["claude", "codex"];
  return [item.runtime as CliRuntime];
}

export function groupByName(items: AgentAssetInventoryItem[], kind: CapabilityKind): NameGroup[] {
  const map = new Map<string, NameGroup>();
  for (const item of items) {
    const key = `${kind}:${item.name.toLowerCase()}`;
    let group = map.get(key);
    if (!group) {
      group = {
        kind,
        name: item.name,
        sessionKey: item.sessionKey,
        installs: { claude: [], codex: [], grok: [], shared: [] },
        any: item,
        differs: false,
      };
      map.set(key, group);
    }
    group.installs[item.runtime].push(item);
    if (item.piDefinition && !group.any.piDefinition) group.any = item;
  }
  for (const group of map.values()) {
    if (kind !== "mcp") continue;
    const summaries = new Set(
      RUNTIME_COLUMNS.flatMap((rt) => group.installs[rt])
        .map((item) => item.mcpSummary)
        .filter((summary): summary is string => Boolean(summary)),
    );
    group.differs = summaries.size > 1;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function groupItems(group: NameGroup): AgentAssetInventoryItem[] {
  return RUNTIME_COLUMNS.flatMap((rt) => group.installs[rt]);
}

export function filterGroups(groups: NameGroup[], search: string): NameGroup[] {
  const query = search.trim().toLowerCase();
  if (!query) return groups;
  return groups.filter((group) => {
    const haystack = [
      group.name,
      group.any.mcpSummary ?? "",
      group.any.skillDescription ?? "",
      ...groupItems(group).map((item) => item.path),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function toggleKey(list: string[], key: string, enabled: boolean): string[] {
  const next = new Set(list);
  if (enabled) next.delete(key);
  else next.add(key);
  return [...next].sort();
}

// The Pi scope lists are opt-IN (a listed key is assigned), the mirror image of
// the disabled-awareness lists.
export function toggleAssignment(list: string[], key: string, assigned: boolean): string[] {
  const next = new Set(list);
  if (assigned) next.add(key);
  else next.delete(key);
  return [...next].sort();
}

export function mcpSessionKey(name: string): string {
  return `mcp:${name.trim().toLowerCase()}`;
}

// Assignment keys are global by lowercase name, so this is the single place a
// server's Cora and worker access is written. A server switched on must never
// stay silently blocked by a leftover entry in the older disable list.
export function withPiAssignment(
  settings: AppSettings,
  key: string,
  access: { cora?: boolean; workers?: boolean },
): AppSettings {
  const next: AppSettings = { ...settings };
  if (access.cora !== undefined) {
    next.agentMcpCoraManagerIds = toggleAssignment(settings.agentMcpCoraManagerIds, key, access.cora);
  }
  if (access.workers !== undefined) {
    next.agentMcpPiWorkerIds = toggleAssignment(settings.agentMcpPiWorkerIds, key, access.workers);
  }
  if (access.cora || access.workers) {
    next.agentDisabledMcpIds = settings.agentDisabledMcpIds.filter((id) => id !== key);
  }
  return next;
}

// How one CLI column sees a group: it loads a copy, a copy sits in its config
// but the CLI does not load that file, a copy can be added, or it cannot.
export type CliState =
  | { kind: "reads"; items: AgentAssetInventoryItem[] }
  | { kind: "unread"; items: AgentAssetInventoryItem[]; reason: string }
  | { kind: "ready" }
  | { kind: "blocked"; reason: string };

export function cliState(group: NameGroup, cli: CliRuntime): CliState {
  const items = groupItems(group);
  const reading = items.filter((item) => itemReadBy(item).includes(cli));
  if (reading.length > 0) return { kind: "reads", items: reading };
  const parked = group.installs[cli];
  if (parked.length > 0) {
    return {
      kind: "unread",
      items: parked,
      reason: parked.find((item) => item.readByNote)?.readByNote ?? `${CLI_LABEL[cli]} does not load this file.`,
    };
  }
  if (group.kind === "skill" && cli === "grok") {
    return { kind: "blocked", reason: "Grok Build has no skill folder." };
  }
  if (!group.any.syncable) {
    return {
      kind: "blocked",
      reason: group.any.compatibilityReason ?? `This entry cannot be copied to ${CLI_LABEL[cli]}.`,
    };
  }
  // An entry pinned to one runtime cannot be copied into another.
  const only = group.any.compatibility;
  if (only !== "both" && only !== "unknown" && only !== cli) {
    return {
      kind: "blocked",
      reason: group.any.compatibilityReason ?? `This entry does not work under ${CLI_LABEL[cli]}.`,
    };
  }
  if (cli === "grok" && group.any.mcpTransport !== "stdio" && group.any.compatibilityReason?.includes("headers")) {
    return { kind: "blocked", reason: group.any.compatibilityReason };
  }
  return { kind: "ready" };
}

// The file a new server goes to for one CLI at one scope. Grok has no
// per-workspace target, so "this workspace" offers Claude and Codex only.
export function targetFor(
  targets: AgentMcpTarget[],
  cli: CliRuntime,
  scope: "user" | "workspace",
): AgentMcpTarget | undefined {
  return targets.find((target) => target.runtime === cli && target.scope === scope);
}

export function deliveryFor(
  preview: AgentPiMcpPreview | null,
  scope: "cora" | "worker",
  key: string,
): AgentPiMcpDelivery | undefined {
  return preview?.[scope].find((entry) => entry.sessionKey === key);
}

export function deliveryText(
  delivery: AgentPiMcpDelivery,
  maxServers: number,
): { tone: "ok" | "warn" | "muted"; text: string } {
  switch (delivery.state) {
    case "delivered": {
      const live = delivery.live;
      if (!live) return { tone: "ok", text: "ready for the next message" };
      if (live.status === "connected") {
        return { tone: "ok", text: `connected, ${live.tools} ${live.tools === 1 ? "tool" : "tools"}` };
      }
      if (live.status === "pending") return { tone: "muted", text: "connecting" };
      if (live.status === "failed") return { tone: "warn", text: `failed to connect${live.error ? `: ${live.error}` : ""}` };
      return { tone: "muted", text: "disconnected" };
    }
    case "needs-oauth":
      return { tone: "warn", text: "needs an Authorization header (Claude sign-in cannot be reused)" };
    case "turned-off":
      return { tone: "warn", text: "turned off in its config" };
    case "no-definition":
      return { tone: "warn", text: "not defined for this workspace" };
    case "reserved":
      return { tone: "warn", text: "reserved name, not delivered" };
    case "duplicate":
      return { tone: "warn", text: "another server already uses this name" };
    case "unsupported":
      return { tone: "warn", text: "this kind of server is not supported" };
    case "over-cap":
      return { tone: "warn", text: `over the ${maxServers}-server limit, not delivered` };
    default:
      return { tone: "muted", text: delivery.state };
  }
}

export function pairsFrom(record?: Record<string, string>): Pair[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

export function pairsToRecord(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function splitArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Values under these names are credentials, so the form masks them until the
// user asks to see one. Shapes of well-known tokens are masked whatever the
// name.
const SECRET_KEY_PATTERN = /token|key|secret|password|passwd|authorization|cookie|credential|bearer/i;
const SECRET_VALUE_PATTERN = /^(?:Bearer\s+|Basic\s+)?(?:sk-|sk_|pk_live|rk_live|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abposr]-|AKIA|AIza|ya29\.|eyJ)/;

export function isSecretPair(pair: Pair): boolean {
  return SECRET_KEY_PATTERN.test(pair.key) || SECRET_VALUE_PATTERN.test(pair.value.trim());
}

export function blankEditor(targets: AgentMcpTarget[]): EditorState {
  return {
    mode: "add",
    replaceId: null,
    originalName: "",
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    env: [],
    url: "",
    headers: [],
    cora: true,
    workers: false,
    clis: { claude: Boolean(targetFor(targets, "claude", "user")), codex: false, grok: false },
    scope: "user",
    customTargetId: null,
    targetId: "",
    copies: [],
  };
}

export function editorFromDetail(
  detail: AgentMcpServerDetail,
  access: { cora: boolean; workers: boolean },
  copies: EditorCopy[],
): EditorState {
  return {
    mode: "edit",
    replaceId: detail.id,
    originalName: detail.name,
    name: detail.name,
    transport: detail.transport,
    command: detail.command ?? "",
    argsText: (detail.args ?? []).join("\n"),
    env: pairsFrom(detail.env),
    url: detail.url ?? "",
    headers: pairsFrom(detail.headers),
    cora: access.cora,
    workers: access.workers,
    clis: { claude: false, codex: false, grok: false },
    scope: "user",
    customTargetId: null,
    targetId: detail.targetId,
    copies,
  };
}

export function editorDraft(editor: EditorState) {
  return {
    name: editor.name.trim(),
    transport: editor.transport,
    command: editor.transport === "stdio" ? editor.command.trim() : undefined,
    args: editor.transport === "stdio" ? splitArgs(editor.argsText) : undefined,
    env: editor.transport === "stdio" ? pairsToRecord(editor.env) : undefined,
    url: editor.transport === "http" ? editor.url.trim() : undefined,
    headers: editor.transport === "http" ? pairsToRecord(editor.headers) : undefined,
  };
}

// Where an add writes: one exact file the user picked, or one file per ticked
// CLI at the chosen scope.
export function editorDestinations(
  editor: EditorState,
  targets: AgentMcpTarget[],
): { targets: AgentMcpTarget[]; problem: string | null } {
  if (editor.customTargetId) {
    const target = targets.find((item) => item.id === editor.customTargetId);
    return target ? { targets: [target], problem: null } : { targets: [], problem: "Choose where to save this server." };
  }
  const picked = CLI_RUNTIMES.filter((cli) => editor.clis[cli]);
  if (picked.length === 0) {
    return {
      targets: [],
      problem: "Pick at least one CLI config to keep the server in. Cora and Pi workers read it from there.",
    };
  }
  const out: AgentMcpTarget[] = [];
  for (const cli of picked) {
    const target = targetFor(targets, cli, editor.scope);
    if (!target) {
      return {
        targets: [],
        problem: `${CLI_LABEL[cli]} has no ${editor.scope === "workspace" ? "per-workspace" : "user"} config to save into. Untick it or choose every workspace.`,
      };
    }
    out.push(target);
  }
  return { targets: out, problem: null };
}

// Mirrors the main-process rules so the user sees the problem before a write is
// attempted. The main process stays the authority.
export function validateEditor(editor: EditorState): string | null {
  const name = editor.name.trim();
  if (!name) return "Name is required.";
  if (!MCP_NAME_PATTERN.test(name)) {
    return "Name may use letters, digits, dot, underscore and hyphen, and must start with a letter or digit.";
  }
  if (RESERVED_MCP_NAMES.has(name.toLowerCase())) return `${name} is reserved for Codara's built-in server.`;
  if (editor.mode === "edit" && !editor.targetId) return "Choose where to save this server.";
  if (editor.transport === "stdio") {
    if (!editor.command.trim()) return "Command is required for a stdio server.";
    return null;
  }
  const url = editor.url.trim();
  if (!url) return "URL is required for an HTTP server.";
  if (!/^https?:\/\//i.test(url)) return "URL must start with http:// or https://.";
  return null;
}

// A target id is `${runtime}:${scope}:${path}`; the path itself may hold colons
// on Windows, so split on the first two only.
export function describeUnlistedTarget(id: string): AgentMcpTarget {
  const first = id.indexOf(":");
  const second = id.indexOf(":", first + 1);
  const path = second === -1 ? id : id.slice(second + 1);
  return {
    id,
    runtime: "shared",
    scope: "user",
    path,
    label: "Current location",
    format: path.toLowerCase().endsWith(".json") ? "json" : "toml",
  };
}

export interface SyncSummary {
  tone: StatusTone;
  headline: string;
  lines: string[];
}

export function summarizeSync(result: AgentSyncResult): SyncSummary {
  const lines: string[] = [];
  const list = (label: string, names: string[]) => {
    if (names.length > 0) lines.push(`${label}: ${names.join(", ")}`);
  };
  list("MCP servers to Claude", result.mcp.toClaude);
  list("MCP servers to Codex", result.mcp.toCodex);
  list("MCP servers repaired in Grok", result.mcp.toGrok ?? []);
  list("Skills to Claude", result.skills.toClaude);
  list("Skills to Codex", result.skills.toCodex);
  const count =
    result.mcp.toClaude.length + result.mcp.toCodex.length + (result.mcp.toGrok?.length ?? 0) +
    result.skills.toClaude.length + result.skills.toCodex.length;
  const errors = [...result.mcp.errors, ...result.skills.errors];
  const notes = [...result.mcp.skipped, ...result.skills.skipped];
  const verb = result.dryRun ? "would copy" : "copied";
  let headline: string;
  if (count === 0) {
    headline = result.dryRun
      ? "Nothing to copy. Claude and Codex already share every entry that can be shared."
      : "Nothing copied. Claude and Codex already share every entry that can be shared.";
  } else {
    headline = `Sync ${verb} ${count} ${count === 1 ? "entry" : "entries"}.`;
  }
  for (const error of errors) lines.push(`Problem: ${error}`);
  for (const note of notes) lines.push(note);
  return { tone: errors.length > 0 ? "error" : "ok", headline, lines };
}

export function syncCount(result: AgentSyncResult): number {
  return (
    result.mcp.toClaude.length + result.mcp.toCodex.length + result.skills.toClaude.length +
    result.skills.toCodex.length
  );
}

// The fraction of the hard cap at which the writer starts asking Cora to
// consolidate instead of append (MEMORY_FILE_SOFT_BYTES / MEMORY_FILE_MAX_BYTES
// in src/main/orchestration/cora-memory.ts). Derived from the reported cap
// rather than hard-coded, so the renderer cannot drift from a cap change.
const MEMORY_SOFT_RATIO = 0.8;

export function memoryTone(status: MemoryTierStatus): "ok" | "warn" | "over" {
  if (status.overCap || status.bytesUsed > status.bytesCap) return "over";
  return status.bytesUsed >= Math.ceil(status.bytesCap * MEMORY_SOFT_RATIO) ? "warn" : "ok";
}

// Bytes at the scale these files live at: a few KB, where "3.2 KB" is the
// readable unit and a decimal past 10 KB is noise.
export function formatMemoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
}

// Mirrors openRouterConfigurationHash in src/main/openrouter-config.ts, which
// the renderer cannot import (node:crypto). The main process stays the
// authority; this only decides whether a row is labelled usable.
export async function openRouterKeyVerified(settings: AppSettings): Promise<boolean> {
  const apiKey = typeof settings.openRouterApiKey === "string" ? settings.openRouterApiKey.trim() : "";
  if (!apiKey || !settings.openRouterVerifiedKeyHash) return false;
  const ids = [...new Set((settings.openRouterCoraModels ?? []).map((id) => id.trim()).filter(Boolean))].sort();
  const encoder = new TextEncoder();
  const bytes = new Uint8Array([
    ...encoder.encode(apiKey),
    ...encoder.encode("\0"),
    ...encoder.encode(JSON.stringify(ids)),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === settings.openRouterVerifiedKeyHash;
}

// Mirrors availableCoraWorkerModels in src/main/openrouter-config.ts: the
// worker models a launch can actually use. An OpenRouter id counts only with a
// verified key and while it is still one of the user's Cora favorites.
export function usableWorkerModels(settings: AppSettings, openRouterVerified: boolean): string[] {
  const favorites = new Set(
    openRouterVerified ? (settings.openRouterCoraModels ?? []).map((id) => id.trim()).filter(Boolean) : [],
  );
  const configured = Array.isArray(settings.coraWorkerModels) ? settings.coraWorkerModels : DEFAULT_CORA_WORKER_MODELS;
  return [...new Set(configured.map((id) => id.trim()).filter(Boolean))].filter(
    (id) => !isOpenRouterModelId(id) || favorites.has(id),
  );
}
