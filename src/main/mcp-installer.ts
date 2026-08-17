// codara-studio MCP auto-installer — registers Codara's single built-in stdio
// MCP server in the user-scope Claude and Codex configs so every sub-agent
// Codara spawns (including verifier passes) can drive the actual <preview> tab
// and open/steer agent-owned terminal tabs inside Codara. The server lives at
// resources/codara-studio-mcp/server.js and proxies JSON-RPC calls back to
// Codara's agent-socket loopback HTTP channel. See preview-bridge.ts +
// previewRpc.ts (preview) and agent-socket.ts (terminal) for the round-trip.
//
// The globally-installed entry exposes the "studio" roster (preview + terminal
// tools). The orchestration tool sets (Execute worker-spawning / Automation
// architect) are layered on TOP of that roster only when a backend spawns the
// server with SPARK_MCP_MODE=execute|automation — Claude via a per-run
// --mcp-config, Codex via a `-c mcp_servers."codara-studio".env.SPARK_MCP_MODE`
// override — and automation workers get SPARK_MCP_MODE=worker (the
// studio surface plus the loop-lifecycle pair). The
// single server and all its rosters live in server.js itself.
//
// Design mirrors hook-installer.ts:
// 1. Idempotent. JSON entries are tagged `_sparkManaged: true` + version;
//    Codex TOML insertion lives in a dedicated managed block (`SPARK_AGENT_
//    BUILTIN_MCP`) so it never fights the agent-sync managed block.
// 2. Non-destructive. If the user already has a non-Codara `codara-studio`
//    entry, we leave it alone. We never touch user-owned `playwright`
//    entries (the user may have installed Playwright MCP separately).
// 3. Conservative. We only touch a config file if it (or its parent dir)
//    already exists — no foreign config gets created in clean homedirs.
// 4. Fire-and-forget. Errors are logged; they never block startup.
// 5. Cleanup. Any old Codara-managed entries from earlier Codara versions
//    (the Playwright experiment, the pre-merge cora-preview / cora-orchestrator
//    servers, the pre-Cora spark-* names) are removed on every launch.

import { promises as fs } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import type {
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
  SparkBuiltinRuntimeStatus,
} from "@shared/types";

import { resolveBinary } from "./binary-resolver";
import { resolveBundledResourcePath } from "./bundled-resources";
import { writeFileAtomic } from "./fs-atomic";
import { resolveCodexHomePaths } from "./orchestration/codex-home";
import { codaraHome } from "./codara-home";

// The merged built-in server. Was two servers (cora-preview + cora-orchestrator)
// before v5 — both are cleaned up as legacy on launch.
const SERVER_NAME = "codara-studio";
// Callers that report on the built-in (sync summaries, IPC status text) use
// this instead of re-typing the name.
export const SPARK_BUILTIN_SERVER_NAME = SERVER_NAME;
// Pre-merge managed entries cleaned up on every launch (never user-owned ones):
// the original Playwright experiment, the pre-Cora spark-* names, and the two
// separate Cora servers that codara-studio replaced.
const LEGACY_SERVER_NAMES = [
  "playwright",
  "spark-preview",
  "cora-preview",
  "spark-orchestrator",
  "cora-orchestrator",
] as const;
// v5: cora-preview + cora-orchestrator merged into a single codara-studio
// server (preview + terminal studio roster, plus the Execute/Automation
// orchestration rosters behind SPARK_MCP_MODE). The name change alone forces a
// fresh managed entry; the version bump forces matchesCurrent to rewrite any
// pre-merge entry that somehow shares the new name.
// v6: MCP tool names renamed from the spark_ prefix to codara_ (preview +
// terminal + execute + automation rosters). Bumped so matchesCurrent re-renders
// existing entries and the Capability Center card refreshes its tool-name text.
const SPARK_VERSION = "6";

// Instances running under an explicit home override (tests, dev harnesses,
// side-by-side profiles) must never manage the user's global agent configs —
// a sandboxed boot once baked its temp SPARK_HOME_DIR into ~/.claude.json,
// pointing every external CLI at a dead handshake path.
function isSandboxedHome(): boolean {
  const override =
    process.env.CODARA_HOME_DIR ?? process.env.SPARK_HOME_DIR ?? process.env.SPARK_USER_DATA_DIR;
  if (!override || !override.trim()) return false;
  // Only temp-dir homes count as sandboxes. A persistent custom home (a user
  // who deliberately relocated ~/.Codara) still gets managed MCP entries — the
  // baked SPARK_HOME_DIR in the entry env keeps external CLIs pointed right.
  const tmp = tmpdir();
  return override.startsWith(tmp) || override.startsWith("/tmp/") || override.startsWith("/private/tmp/");
}

// Tool rosters kept in sync with resources/codara-studio-mcp/server.js so the
// Capability Center can show "N tools" without spawning the server. The global
// entry exposes the STUDIO roster; the orchestration tools are added only in
// per-run execute/automation spawns, but are listed here so the built-in card
// reflects everything the server can do.
const SPARK_STUDIO_TOOLS = [
  // Preview (drive the live <preview> tab).
  "codara_preview_list",
  "codara_preview_url",
  "codara_preview_navigate",
  "codara_preview_snapshot",
  "codara_preview_click",
  "codara_preview_type",
  "codara_preview_press_key",
  "codara_preview_evaluate",
  "codara_preview_wait_for",
  "codara_preview_screenshot",
  "codara_preview_mouse",
  "codara_preview_scroll",
  "codara_preview_hover",
  "codara_preview_drag",
  "codara_preview_key",
  "codara_preview_upload",
  "codara_preview_console",
  "codara_preview_network",
  "codara_preview_resize",
  "codara_preview_run",
  // Terminal (open + drive agent-owned terminal tabs).
  "codara_terminal_create",
  "codara_terminal_write",
  "codara_terminal_read",
  "codara_terminal_close",
];

const SPARK_ORCHESTRATION_TOOLS = [
  // Execute-mode worker orchestration (per-run SPARK_MCP_MODE=execute).
  "codara_spawn_terminals",
  "codara_spawn_workers",
  "codara_ask_user",
  "codara_complete",
  "codara_name_chat",
  "codara_request_next_iteration",
  "codara_get_worker_status",
  "codara_wait_for_workers",
  "codara_message_workers",
  "codara_check_messages",
  // Automation-mode architect roster (per-run SPARK_MCP_MODE=automation).
  "codara_list_automations",
  "codara_get_automation",
  "codara_create_automation",
  "codara_update_automation",
  "codara_run_automation",
  "codara_wait_for_automation",
  "codara_set_automation_enabled",
  "codara_pause_automation",
  "codara_resume_automation",
  "codara_stop_automation",
  "codara_delete_automation",
];

// The full tool surface for the Capability Center's built-in card (dedup keeps
// codara_ask_user / codara_name_chat from double-counting).
const SPARK_BUILTIN_TOOLS = [...new Set([...SPARK_STUDIO_TOOLS, ...SPARK_ORCHESTRATION_TOOLS])];

const CLAUDE_USER_CONFIG = join(homedir(), ".claude.json");

export interface CodexMcpHomeOptions {
  /** Exact resolved native Codex home. Omission preserves personal-home use. */
  codexHome?: string | null;
}

export interface CodexMcpConfigTarget {
  codexHome: string;
  configPath: string;
}

export function resolveCodexMcpConfigTarget(
  codexHome?: string | null,
): CodexMcpConfigTarget {
  const paths = resolveCodexHomePaths(codexHome);
  return { codexHome: paths.homeDir, configPath: paths.configPath };
}

const CODEX_BLOCK_START = "# >>> SPARK_AGENT_BUILTIN_MCP";
const CODEX_BLOCK_END = "# <<< SPARK_AGENT_BUILTIN_MCP";

// Retired marker region from the pre-merge orchestrator installer — stripped on
// every launch so a stale block pointing at the deleted resource dir can't
// linger.
const CODEX_ORCHESTRATOR_BLOCK_START = "# >>> SPARK_AGENT_ORCHESTRATOR_MCP";
const CODEX_ORCHESTRATOR_BLOCK_END = "# <<< SPARK_AGENT_ORCHESTRATOR_MCP";

// TOML tables named after retired servers (post-merge these can only be our own
// broken leftovers) that the strip logic drops whether or not markers survive.
const LEGACY_CODEX_TABLE_NAMES = [
  "spark-preview",
  "cora-preview",
  "spark-orchestrator",
  "cora-orchestrator",
] as const;

// Resource directories the built-in server has ever shipped from. A
// codara-studio entry whose args point at one of these, under a path that no
// longer exists, is a Codara entry stranded by a moved/renamed install, not a
// server the user wired up: the marker comments that would have identified it
// can be lost to a merge or truncation, the command path cannot.
const MANAGED_SERVER_DIRS = new Set([
  "codara-studio-mcp",
  "cora-preview-mcp",
  "cora-orchestrator-mcp",
  "spark-preview-mcp",
  "spark-orchestrator-mcp",
]);

// How a `[mcp_servers."codara-studio"]` section sitting outside our markers is
// classified. "stale" is repairable, "user" is untouchable.
type CodexBuiltinSection = "absent" | "user" | "stale";

interface ManagedClaudeMcpServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  _sparkManaged: true;
  _sparkVersion: string;
}

function resolveServerScript(): string {
  return resolveBundledResourcePath("codara-studio-mcp", "server.js");
}

function resolveNodeCommand(): string {
  // process.execPath inside Electron points at the Electron binary, which
  // ALSO works as a Node interpreter when ELECTRON_RUN_AS_NODE=1 is set in
  // the spawned env. That keeps us from depending on a system Node install.
  // We pass ELECTRON_RUN_AS_NODE via the entry's env field.
  return process.execPath;
}

function buildServerArgs(): string[] {
  return [resolveServerScript()];
}

function buildServerEnv(): Record<string, string> {
  // SPARK_HOME_DIR points the MCP server at the handshake file
  // (<spark-home>/agent-socket.json). The server defaults to ~/.Codara
  // when it's unset, so injecting it only matters for custom homes — but we
  // always write it so the entry is explicit and self-describing. No
  // SPARK_MCP_MODE here: the global entry exposes the studio (preview +
  // terminal) roster; execute/automation rosters are opted in per-run.
  return { ELECTRON_RUN_AS_NODE: "1", SPARK_HOME_DIR: codaraHome() };
}

export async function installSparkPreviewMcp(
  options: CodexMcpHomeOptions = {},
): Promise<void> {
  await Promise.all([
    installForClaude(),
    installForCodex(false, undefined, options.codexHome),
  ]);
}

// Repair-only pass over both runtimes: reports which config files it had to
// rewrite. The Capability Center's "Sync Claude and Codex" action calls this so
// a stale built-in entry (a Codara entry left pointing at an install path that
// no longer exists) is repaired on demand, not only at the next launch. It never
// installs from absent: a runtime the user just removed the built-in from stays
// removed until the next launch or an explicit install.
export async function repairSparkBuiltinEntries(
  input: CodexMcpHomeOptions = {},
): Promise<{ claude: boolean; codex: boolean }> {
  const [claude, codex] = await Promise.all([
    installForClaude(false, { repairOnly: true }),
    installForCodex(false, { repairOnly: true }, input.codexHome),
  ]);
  return { claude, codex };
}

// Boot-time installer. Design rule #3 (stay conservative) says the auto-
// installer never CREATES a foreign config in a clean homedir — but that also
// meant a user who has `claude`/`codex` on PATH yet has never launched it (so
// ~/.claude.json / ~/.codex don't exist yet) silently got no codara-studio
// entry, and the browser/terminal surface just didn't work for them. Split the
// difference: probe for the actual CLI binary and, only when it resolves, allow
// createIfMissing so the entry lands the first time. The never-overwrite-a-
// user-entry guards inside installForClaude/installForCodex still hold.
export async function installSparkPreviewMcpAtBoot(): Promise<void> {
  const [claudeBin, codexBin] = await Promise.all([
    resolveBinary("claude").catch(() => null),
    resolveBinary("codex").catch(() => null),
  ]);
  await Promise.all([
    installForClaude(Boolean(claudeBin)),
    installForCodex(Boolean(codexBin)),
  ]);
}

export async function installSparkPreviewMcpForCodex(
  createIfMissing = false,
  options: CodexMcpHomeOptions = {},
): Promise<void> {
  await installForCodex(createIfMissing, undefined, options.codexHome);
}

// ---------------------------------------------------------------------------
// Claude (~/.claude.json)
// ---------------------------------------------------------------------------

// `repairOnly` restricts the write to an entry that is already ours: absent or
// user-owned means the caller asked for a repair, not an install.
async function installForClaude(
  createIfMissing = false,
  options?: { repairOnly?: boolean },
): Promise<boolean> {
  if (isSandboxedHome()) return false;
  const fileExists = existsSync(CLAUDE_USER_CONFIG);
  if (!fileExists && !createIfMissing) return false;

  let raw = "";
  if (fileExists) {
    try {
      raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
    } catch (err) {
      console.warn("[mcp-installer] could not read ~/.claude.json:", err);
      return false;
    }
  }

  let parsed: Record<string, unknown>;
  if (raw.trim()) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        console.warn("[mcp-installer] ~/.claude.json is not a JSON object; skipping");
        return false;
      }
      parsed = value as Record<string, unknown>;
    } catch (err) {
      console.warn("[mcp-installer] ~/.claude.json parse failed; skipping:", (err as Error).message);
      return false;
    }
  } else {
    parsed = {};
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};

  if (options?.repairOnly && !isSparkManaged(servers[SERVER_NAME])) return false;

  let changed = false;

  // Cleanup: remove managed entries under retired names (the Playwright
  // experiment, the pre-Cora spark-*, the pre-merge cora-preview /
  // cora-orchestrator). Never touch user-owned entries.
  for (const legacy of LEGACY_SERVER_NAMES) {
    if (servers[legacy] && isSparkManaged(servers[legacy])) {
      delete servers[legacy];
      changed = true;
    }
  }

  const existing = servers[SERVER_NAME];
  if (existing && !isSparkManaged(existing)) {
    // User owns this entry — never overwrite. If we made any cleanup change,
    // still write.
  } else if (!existing || !matchesCurrent(existing)) {
    servers[SERVER_NAME] = renderClaudeEntry();
    changed = true;
  }

  if (!changed) return false;

  parsed.mcpServers = servers;
  try {
    const payload = JSON.stringify(parsed, null, 2) + "\n";
    if (raw === payload) return false;
    await writeFileAtomic(CLAUDE_USER_CONFIG, payload);
    return true;
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.claude.json:", err);
    return false;
  }
}

function renderClaudeEntry(): ManagedClaudeMcpServer {
  return {
    type: "stdio",
    command: resolveNodeCommand(),
    args: buildServerArgs(),
    env: buildServerEnv(),
    _sparkManaged: true,
    _sparkVersion: SPARK_VERSION,
  };
}

function isSparkManaged(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)._sparkManaged === true
  );
}

function matchesCurrent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry._sparkVersion !== SPARK_VERSION) return false;
  if (entry.command !== resolveNodeCommand()) return false;
  const expectedArgs = buildServerArgs();
  if (!Array.isArray(entry.args)) return false;
  const args = entry.args as unknown[];
  if (args.length !== expectedArgs.length) return false;
  if (!args.every((arg, i) => arg === expectedArgs[i])) return false;
  const env = entry.env as Record<string, unknown> | undefined;
  if (!env || env.ELECTRON_RUN_AS_NODE !== "1") return false;
  // A stale SPARK_HOME_DIR (user relaunched Codara under a different home) must
  // force a rewrite so the MCP child dials the right handshake file.
  if (env.SPARK_HOME_DIR !== codaraHome()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Codex (~/.codex/config.toml)
// ---------------------------------------------------------------------------

async function installForCodex(
  createIfMissing = false,
  options?: { repairOnly?: boolean },
  codexHome?: string | null,
): Promise<boolean> {
  if (isSandboxedHome()) return false;
  let target = resolveCodexMcpConfigTarget(codexHome);
  const dirExists = directoryExists(target.codexHome);
  if (!dirExists && !createIfMissing) return false;
  if (!dirExists) {
    try {
      await fs.mkdir(target.codexHome, { recursive: true, mode: 0o700 });
      target = resolveCodexMcpConfigTarget(codexHome);
    } catch (err) {
      console.warn("[mcp-installer] could not create the selected Codex home:", err);
      return false;
    }
  }

  let existing = "";
  try {
    existing = await fs.readFile(target.configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mcp-installer] could not read the selected Codex config:", err);
      return false;
    }
  }

  // If the user has a non-Codara `codara-studio` server defined outside our
  // managed block, leave the file alone. A stale Codara entry (markers lost,
  // command path gone) is ours to rewrite, so it is swept with the rest.
  const section = classifyCodexBuiltinSection(existing);
  if (section === "user") return false;

  // A repair pass only rewrites an entry that is already there: our managed
  // block, or a stranded table outside it. Absent means the user removed it, and
  // re-adding it here would undo that.
  const managedBlockPresent = existing.includes(CODEX_BLOCK_START) && existing.includes(CODEX_BLOCK_END);
  if (options?.repairOnly && !managedBlockPresent && section !== "stale") return false;

  // Strip our managed block, the retired orchestrator block, and any broken
  // legacy-named tables, then append one fresh block.
  const stripped = stripAllManagedBlocks(existing, { sweepBuiltinName: section === "stale" });
  const block = renderCodexBlock();
  const base = stripped.trimEnd();
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  if (next === existing) return false;

  try {
    resolveCodexMcpConfigTarget(codexHome);
    // A managed account's config.toml is a share link to the personal
    // ~/.codex config (native-cli-shared-state.ts); the atomic rename must
    // land on the real file, not replace the link with a private fork.
    const writePath = await fs.realpath(target.configPath).catch(() => target.configPath);
    await writeFileAtomic(writePath, next, { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn("[mcp-installer] failed to write the selected Codex config:", err);
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasUserCodaraStudioSection(text: string): boolean {
  return classifyCodexBuiltinSection(text) === "user";
}

// Classify the codara-studio table that survives outside our markers. JSON
// entries carry `_sparkManaged` inside the object, so ~/.claude.json always
// knows whose entry it is; a TOML block only has two comment lines around it,
// and those have been seen split apart or dropped by a merge. When they are
// gone, the entry itself is the only evidence left: our own command/args shape
// pointing at an install path that no longer exists means the entry is a
// stranded Codara one and repairing it is the whole point.
function classifyCodexBuiltinSection(text: string): CodexBuiltinSection {
  const section = readCodexServerSection(stripAllManagedBlocks(text), SERVER_NAME);
  if (!section) return "absent";
  return isStrandedBuiltinSection(section) ? "stale" : "user";
}

function isStrandedBuiltinSection(section: CodexServerSection): boolean {
  // Every entry we have ever written runs the server script through Electron's
  // node mode. Without that env the entry is somebody else's.
  if (section.env.ELECTRON_RUN_AS_NODE !== "1") return false;
  const script = section.args.find(
    (arg) => basename(arg) === "server.js" && MANAGED_SERVER_DIRS.has(basename(dirname(arg))),
  );
  if (!script || !isAbsolute(script)) return false;
  if (!existsSync(script)) return true;
  const command = section.command ?? "";
  return isAbsolute(command) && !existsSync(command);
}

interface CodexServerSection {
  command?: string;
  args: string[];
  env: Record<string, string>;
}

// Minimal reader for one `[mcp_servers.<name>]` table plus its `.env` subtable.
// Only the fields the staleness check needs are kept; a full TOML parse is not
// worth pulling in for a shape we wrote ourselves.
function readCodexServerSection(text: string, name: string): CodexServerSection | null {
  const header = new RegExp(
    `^\\s*\\[mcp_servers\\.(?:"${escapeRegExp(name)}"|'${escapeRegExp(name)}'|${escapeRegExp(name)})(\\.env)?\\]\\s*$`,
  );
  const section: CodexServerSection = { args: [], env: {} };
  let found = false;
  let inSection = false;
  let inEnv = false;
  for (const line of text.split("\n")) {
    const match = header.exec(line);
    if (match) {
      found = true;
      inSection = true;
      inEnv = Boolean(match[1]);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inSection = false;
      inEnv = false;
      continue;
    }
    if (!inSection) continue;
    const pair = parseTomlAssignment(line);
    if (!pair) continue;
    if (inEnv) {
      section.env[pair.key] = unquoteTomlValue(pair.value);
      continue;
    }
    if (pair.key === "command") section.command = unquoteTomlValue(pair.value);
    else if (pair.key === "args") section.args = parseTomlStringArray(pair.value);
  }
  return found ? section : null;
}

function parseTomlAssignment(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
  if (!match) return null;
  return { key: unquoteTomlValue(match[1]), value: match[2].trim() };
}

function unquoteTomlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const out: string[] = [];
  for (const match of trimmed.slice(1, -1).matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : match[2]);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip the codara-studio managed block, the retired orchestrator block, and
// every stray legacy-named table. Ordering matters: remove BOTH marker regions
// wholesale FIRST (with no legacy names, so the marker logic drops each block —
// and any legacy tables inside it — atomically), THEN sweep orphan legacy-named
// tables that survived outside any marker. Doing the legacy sweep in the same
// pass as the first marker region let that pass's legacy-section consumption run
// past the SECOND block's END marker (an END marker is a comment, not a `[`
// line), orphaning the second block's comment lines forever.
// `sweepBuiltinName` adds the CURRENT name to that final sweep. Only the
// installer passes it, and only once classifyCodexBuiltinSection has proved the
// surviving codara-studio table is a stranded Codara entry rather than a
// user-owned one.
function stripAllManagedBlocks(text: string, options?: { sweepBuiltinName?: boolean }): string {
  let out = stripManagedCodexRegions(text, CODEX_BLOCK_START, CODEX_BLOCK_END, []);
  out = stripManagedCodexRegions(out, CODEX_ORCHESTRATOR_BLOCK_START, CODEX_ORCHESTRATOR_BLOCK_END, []);
  // Markers are gone now; reuse the builtin-marker strings as harmless no-ops so
  // only the legacy-table sweep runs on this final pass.
  const names = options?.sweepBuiltinName
    ? [...LEGACY_CODEX_TABLE_NAMES, SERVER_NAME]
    : LEGACY_CODEX_TABLE_NAMES;
  out = stripManagedCodexRegions(out, CODEX_BLOCK_START, CODEX_BLOCK_END, names);
  return out;
}

// Remove every managed marker region plus any stray legacy-named tables.
// Line-based on purpose: real user configs have been seen with a lost START
// marker (an orphaned block tail with only the END line), which an index-of
// implementation refused to touch — the stale block then survived forever and
// the freshly appended one made the user-ownership check trip. Orphan marker
// lines are consumed; sections named after a RETIRED server (which post-rename
// can only be our broken leftovers) are dropped whether or not markers survive
// around them. Current-name (codara-studio) sections outside markers are left
// alone — those are genuinely user-owned.
function stripManagedCodexRegions(
  text: string,
  startMarker: string,
  endMarker: string,
  legacyNames: readonly string[],
): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  // An orphaned START (no END anywhere after it) must not swallow the rest of
  // the file — treat such a START as a stray marker line instead of a block
  // opener, so user content below survives.
  const endsAfter = (idx: number): boolean =>
    lines.some((l, i) => i > idx && l.trim() === endMarker);
  let inBlock = false;
  let inLegacySection = false;
  const legacyHeaders = legacyNames.map(
    (name) =>
      new RegExp(`^\\s*\\[mcp_servers\\.(?:"${name}"|'${name}'|${name})(?:\\.env)?\\]\\s*$`),
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === startMarker) {
      if (endsAfter(i)) inBlock = true;
      inLegacySection = false;
      continue;
    }
    if (trimmed === endMarker) {
      inBlock = false;
      inLegacySection = false;
      continue;
    }
    if (inBlock) continue;
    if (legacyHeaders.some((re) => re.test(line))) {
      inLegacySection = true;
      continue;
    }
    if (inLegacySection) {
      if (/^\s*\[/.test(line)) inLegacySection = false;
      else continue;
    }
    kept.push(line);
  }
  // No global blank-line squeeze: a user's multiline TOML string may contain
  // legitimate blank runs. Only the trailing edge is normalized.
  return kept.join("\n").trimEnd() + "\n";
}

function renderCodexBlock(): string {
  const args = buildServerArgs();
  return [
    CODEX_BLOCK_START,
    `# Managed by Codara. Auto-installs the codara-studio MCP so agents can`,
    `# drive the live <preview> tab and open/steer agent-owned terminal tabs`,
    `# inside Codara. Disable via Settings > Capabilities or delete this block`,
    `# (Codara will re-add it on next launch unless the auto-install toggle is`,
    `# off).`,
    `# Version: ${SPARK_VERSION}`,
    "",
    `[mcp_servers."${SERVER_NAME}"]`,
    `command = ${tomlString(resolveNodeCommand())}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `enabled = true`,
    "",
    `[mcp_servers."${SERVER_NAME}".env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `SPARK_HOME_DIR = ${tomlString(codaraHome())}`,
    CODEX_BLOCK_END,
  ].join("\n");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Availability detection
// ---------------------------------------------------------------------------

// True when sub-agent prompts should be told to USE the codara-studio MCP.
// True if either (a) auto-install is on AND a Claude/Codex runtime is on
// disk (so we know we wrote an entry), or (b) the user has a codara-studio
// entry of their own in any user/workspace config.
export function isSparkPreviewMcpAvailable(input: {
  cwd: string | null;
  autoInstallEnabled: boolean;
  codexHome?: string | null;
}): boolean {
  const codexTarget = resolveCodexMcpConfigTarget(input.codexHome);
  if (input.autoInstallEnabled) {
    if (existsSync(CLAUDE_USER_CONFIG)) return true;
    if (existsSync(codexTarget.codexHome)) return true;
  }
  return detectUserSparkEntry(input.cwd, input.codexHome);
}

function detectUserSparkEntry(
  cwd: string | null,
  codexHome?: string | null,
): boolean {
  const jsonCandidates = [
    CLAUDE_USER_CONFIG,
    join(homedir(), ".mcp.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  if (cwd) {
    jsonCandidates.push(join(cwd, ".mcp.json"));
    jsonCandidates.push(join(cwd, ".claude", "settings.json"));
    jsonCandidates.push(join(cwd, ".claude", "settings.local.json"));
  }
  for (const path of jsonCandidates) {
    if (jsonHasServer(path, SERVER_NAME)) return true;
  }
  const tomlCandidates = [resolveCodexMcpConfigTarget(codexHome).configPath];
  if (cwd) tomlCandidates.push(join(cwd, ".codex", "config.toml"));
  for (const path of tomlCandidates) {
    if (tomlHasUserCodaraStudioSectionAt(path)) return true;
  }
  return false;
}

function jsonHasServer(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return jsonContainsServerName(parsed, name, 0);
}

function jsonContainsServerName(value: unknown, name: string, depth: number): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "mcpServers" || key === "mcp_servers") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.prototype.hasOwnProperty.call(child, name)
    ) {
      return true;
    }
    if (jsonContainsServerName(child, name, depth + 1)) return true;
  }
  return false;
}

function tomlHasUserCodaraStudioSectionAt(path: string): boolean {
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  return hasUserCodaraStudioSection(raw);
}

// ---------------------------------------------------------------------------
// Execute/Automation lazy-install gate
// ---------------------------------------------------------------------------
//
// The Execute/Automation backends call installOrchestratorMcpFor*() before
// spawning a manager CLI. This predicate tells them whether the (now unified)
// codara-studio entry is already present + current so they can skip a redundant
// write. Retained under the old name because the backends import it.
export async function isSparkOrchestratorMcpInstalled(
  target: "claude" | "codex",
  options: CodexMcpHomeOptions = {},
): Promise<boolean> {
  if (target === "claude") {
    if (!existsSync(CLAUDE_USER_CONFIG)) return false;
    let raw: string;
    try {
      raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
    } catch {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
    const entry = (servers as Record<string, unknown>)[SERVER_NAME];
    if (!entry) return false;
    // A user-owned entry counts as installed (don't reinstall over it). A
    // Codara-managed entry only counts when it matches the current version +
    // script path.
    if (!isSparkManaged(entry)) return true;
    return matchesCurrent(entry);
  }

  // target === "codex"
  const codexTarget = resolveCodexMcpConfigTarget(options.codexHome);
  if (!directoryExists(codexTarget.codexHome)) return false;
  let existing = "";
  try {
    existing = await fs.readFile(codexTarget.configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
  if (hasUserCodaraStudioSection(existing)) return true;
  // Managed block present AND at the current version? The block embeds a
  // `# Version: <n>` line; if it's missing or stale, report "not installed" so
  // the caller reinstalls the block (picking up roster/env changes from the
  // version bump). We scope the version match to WITHIN the managed block.
  const blockStart = existing.indexOf(CODEX_BLOCK_START);
  const blockEnd = existing.indexOf(CODEX_BLOCK_END);
  if (blockStart < 0 || blockEnd < 0 || blockEnd < blockStart) return false;
  const block = existing.slice(blockStart, blockEnd + CODEX_BLOCK_END.length);
  return block.includes(`# Version: ${SPARK_VERSION}`);
}

// ---------------------------------------------------------------------------
// Codara built-in status + per-runtime install/uninstall (Capability Center)
// ---------------------------------------------------------------------------
//
// The Capability Center renders codara-studio in its own branded section with
// per-runtime install controls. These functions are the backend for that
// surface: they report where the built-in is installed and let the user
// add/remove it from a single runtime at a time.

interface SparkBuiltinMeta {
  id: SparkBuiltinMcpId;
  serverName: string;
  summary: string;
  detail: string;
  tools: string[];
  autoManaged: boolean;
}

function builtinMeta(autoInstallEnabled: boolean): SparkBuiltinMeta[] {
  return [
    {
      id: "codara-studio",
      serverName: SERVER_NAME,
      summary: "Drive the preview tab, open agent terminals, and orchestrate workers",
      detail:
        "Codara's built-in MCP server. Its always-on studio tools let verifier and worker agents click, type, snapshot, screenshot, and run JS against the exact <preview> DOM the user sees, and open/drive agent-owned terminal tabs — no extra browser window. In Execute and Automation runs the same server also exposes the orchestration tools that spawn and steer Cora workers, ask you clarifying questions, mark runs complete, and build/run automations (looms).",
      tools: SPARK_BUILTIN_TOOLS,
      autoManaged: autoInstallEnabled,
    },
  ];
}

export async function getSparkBuiltinStatus(input: {
  claudeRuntimeAvailable: boolean;
  codexRuntimeAvailable: boolean;
  autoInstallEnabled: boolean;
  codexHome?: string | null;
}): Promise<SparkBuiltinMcpStatus[]> {
  const metas = builtinMeta(input.autoInstallEnabled);
  return Promise.all(
    metas.map(async (meta) => {
      const [claude, codex] = await Promise.all([
        detectClaudeBuiltinState(meta.serverName, input.claudeRuntimeAvailable),
        detectCodexBuiltinState(input.codexRuntimeAvailable, input.codexHome),
      ]);
      return {
        id: meta.id,
        name: meta.serverName,
        summary: meta.summary,
        detail: meta.detail,
        tools: meta.tools,
        autoManaged: meta.autoManaged,
        claude,
        codex,
      } satisfies SparkBuiltinMcpStatus;
    }),
  );
}

export async function installSparkBuiltin(
  _id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
  options: CodexMcpHomeOptions = {},
): Promise<SparkBuiltinActionResult> {
  try {
    if (runtime === "claude") await installForClaude(true);
    else await installForCodex(true, undefined, options.codexHome);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uninstallSparkBuiltin(
  _id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
  options: CodexMcpHomeOptions = {},
): Promise<SparkBuiltinActionResult> {
  try {
    if (runtime === "claude") return await uninstallManagedClaudeServer(SERVER_NAME);
    return await uninstallCodexBuiltinBlock(options.codexHome);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function detectClaudeBuiltinState(
  serverName: string,
  runtimeAvailable: boolean,
): Promise<SparkBuiltinRuntimeStatus> {
  const entry = await readClaudeServerEntry(serverName);
  if (entry !== undefined) {
    return {
      state: isSparkManaged(entry) ? "installed" : "user-managed",
      configPath: CLAUDE_USER_CONFIG,
    };
  }
  return { state: runtimeAvailable ? "available" : "unavailable", configPath: CLAUDE_USER_CONFIG };
}

async function detectCodexBuiltinState(
  runtimeAvailable: boolean,
  codexHome?: string | null,
): Promise<SparkBuiltinRuntimeStatus> {
  const target = resolveCodexMcpConfigTarget(codexHome);
  let existing = "";
  if (existsSync(target.configPath)) {
    try {
      existing = await fs.readFile(target.configPath, "utf8");
    } catch {
      existing = "";
    }
  }
  if (hasUserCodaraStudioSection(existing)) return { state: "user-managed", configPath: target.configPath };
  const managed = existing.includes(CODEX_BLOCK_START) && existing.includes(CODEX_BLOCK_END);
  if (managed) return { state: "installed", configPath: target.configPath };
  return { state: runtimeAvailable ? "available" : "unavailable", configPath: target.configPath };
}

async function readClaudeServerEntry(serverName: string): Promise<unknown | undefined> {
  if (!existsSync(CLAUDE_USER_CONFIG)) return undefined;
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return undefined;
  return (servers as Record<string, unknown>)[serverName];
}

// Remove a Codara-managed entry from ~/.claude.json. Refuses to touch a
// user-defined entry of the same name and treats "already absent" as success.
async function uninstallManagedClaudeServer(serverName: string): Promise<SparkBuiltinActionResult> {
  if (!existsSync(CLAUDE_USER_CONFIG)) return { ok: true };
  let raw: string;
  try {
    raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read ~/.claude.json: ${(err as Error).message}` };
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: true };
    parsed = value as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `~/.claude.json parse failed: ${(err as Error).message}` };
  }
  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : null;
  if (!servers || !(serverName in servers)) return { ok: true };
  if (!isSparkManaged(servers[serverName])) {
    return {
      ok: false,
      error: `'${serverName}' is a user-defined entry in ~/.claude.json; Codara won't remove it.`,
    };
  }
  delete servers[serverName];
  parsed.mcpServers = servers;
  try {
    await writeFileAtomic(CLAUDE_USER_CONFIG, JSON.stringify(parsed, null, 2) + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not write ~/.claude.json: ${(err as Error).message}` };
  }
}

// Strip the Codara-managed Codex block. Refuses when the user keeps their own
// codara-studio section outside the managed markers.
async function uninstallCodexBuiltinBlock(
  codexHome?: string | null,
): Promise<SparkBuiltinActionResult> {
  const target = resolveCodexMcpConfigTarget(codexHome);
  if (!existsSync(target.configPath)) return { ok: true };
  let existing: string;
  try {
    existing = await fs.readFile(target.configPath, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read ~/.codex/config.toml: ${(err as Error).message}` };
  }
  const section = classifyCodexBuiltinSection(existing);
  if (section === "user") {
    return {
      ok: false,
      error: `A user-defined ${SERVER_NAME} section exists in config.toml; Codara won't remove it.`,
    };
  }
  const next = stripAllManagedBlocks(existing, { sweepBuiltinName: section === "stale" });
  if (next === existing) return { ok: true };
  try {
    resolveCodexMcpConfigTarget(codexHome);
    // Same share-link rule as installForCodex: write through the link.
    const writePath = await fs.realpath(target.configPath).catch(() => target.configPath);
    await writeFileAtomic(writePath, next, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not write ~/.codex/config.toml: ${(err as Error).message}` };
  }
}

// Test/diagnostic surface.
export const __test = {
  SERVER_NAME,
  classifyCodexBuiltinSection,
  readCodexServerSection,
  LEGACY_SERVER_NAMES,
  SPARK_VERSION,
  CLAUDE_USER_CONFIG,
  get CODEX_USER_CONFIG() {
    return resolveCodexMcpConfigTarget().configPath;
  },
  CODEX_BLOCK_START,
  CODEX_BLOCK_END,
  CODEX_ORCHESTRATOR_BLOCK_START,
  CODEX_ORCHESTRATOR_BLOCK_END,
  LEGACY_CODEX_TABLE_NAMES,
  renderClaudeEntry,
  renderCodexBlock,
  hasUserCodaraStudioSection,
  stripAllManagedBlocks,
  matchesCurrent,
  resolveServerScript,
  resolveNodeCommand,
};
