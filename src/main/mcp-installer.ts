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
// override. The single server, three rosters, live in the server.js itself.
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

import { app } from "electron";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
  SparkBuiltinRuntimeStatus,
} from "@shared/types";

import { resolveBinary } from "./binary-resolver";
import { writeFileAtomic } from "./fs-atomic";
import { sparkHome } from "./spark-home";

// The merged built-in server. Was two servers (cora-preview + cora-orchestrator)
// before v5 — both are cleaned up as legacy on launch.
const SERVER_NAME = "codara-studio";
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
const SPARK_VERSION = "5";

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
  "spark_preview_list",
  "spark_preview_url",
  "spark_preview_navigate",
  "spark_preview_snapshot",
  "spark_preview_click",
  "spark_preview_type",
  "spark_preview_press_key",
  "spark_preview_evaluate",
  "spark_preview_wait_for",
  "spark_preview_screenshot",
  "spark_preview_mouse",
  "spark_preview_scroll",
  "spark_preview_hover",
  "spark_preview_drag",
  "spark_preview_key",
  "spark_preview_upload",
  "spark_preview_console",
  "spark_preview_network",
  "spark_preview_resize",
  "spark_preview_run",
  // Terminal (open + drive agent-owned terminal tabs).
  "spark_terminal_create",
  "spark_terminal_write",
  "spark_terminal_read",
];

const SPARK_ORCHESTRATION_TOOLS = [
  // Execute-mode worker orchestration (per-run SPARK_MCP_MODE=execute).
  "spark_spawn_workers",
  "spark_ask_user",
  "spark_complete",
  "spark_name_chat",
  "spark_request_next_iteration",
  "spark_get_worker_status",
  "spark_wait_for_workers",
  "spark_message_workers",
  "spark_check_messages",
  // Automation-mode architect roster (per-run SPARK_MCP_MODE=automation).
  "spark_list_automations",
  "spark_get_automation",
  "spark_create_automation",
  "spark_update_automation",
  "spark_run_automation",
  "spark_wait_for_automation",
  "spark_set_automation_enabled",
  "spark_pause_automation",
  "spark_resume_automation",
  "spark_stop_automation",
  "spark_delete_automation",
];

// The full tool surface for the Capability Center's built-in card (dedup keeps
// spark_ask_user / spark_name_chat from double-counting).
const SPARK_BUILTIN_TOOLS = [...new Set([...SPARK_STUDIO_TOOLS, ...SPARK_ORCHESTRATION_TOOLS])];

const CLAUDE_USER_CONFIG = join(homedir(), ".claude.json");
const CODEX_USER_CONFIG = join(homedir(), ".codex", "config.toml");
const CODEX_DIR = join(homedir(), ".codex");

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

interface ManagedClaudeMcpServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  _sparkManaged: true;
  _sparkVersion: string;
}

function resolveServerScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "codara-studio-mcp", "server.js");
  }
  return join(__dirname, "..", "..", "resources", "codara-studio-mcp", "server.js");
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
  return { ELECTRON_RUN_AS_NODE: "1", SPARK_HOME_DIR: sparkHome() };
}

// Install (or refresh) the codara-studio entry and remove any old Codara-
// managed entries from previous versions.
export async function installPlaywrightMcp(): Promise<void> {
  // Keep the old function name so existing callers stay compatible — the
  // wrapper just delegates. New code should call installSparkPreviewMcp.
  await installSparkPreviewMcp();
}

export async function installSparkPreviewMcp(): Promise<void> {
  await Promise.all([installForClaude(), installForCodex()]);
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

// Per-runtime entry points used by the Capability Center's explicit install
// buttons. `createIfMissing` lets a deliberate user action create the config
// file/dir when the runtime CLI is present but hasn't written one yet — the
// boot-time auto-installer never passes this (design rule #3: stay conservative).
export async function installSparkPreviewMcpForClaude(createIfMissing = false): Promise<void> {
  await installForClaude(createIfMissing);
}

export async function installSparkPreviewMcpForCodex(createIfMissing = false): Promise<void> {
  await installForCodex(createIfMissing);
}

// Back-compat aliases: the Execute/Automation backends call these lazily before
// spawning a manager CLI to make sure the (now unified) codara-studio entry
// exists. Execute/Automation rosters are opted in per-run — Claude via its
// per-run --mcp-config, Codex via a `-c` env override — but the global entry
// still has to exist so the CLI can spawn the server at all.
export async function installOrchestratorMcpForCC(createIfMissing = false): Promise<void> {
  await installForClaude(createIfMissing);
}

export async function installOrchestratorMcpForCodex(createIfMissing = false): Promise<void> {
  await installForCodex(createIfMissing);
}

// ---------------------------------------------------------------------------
// Claude (~/.claude.json)
// ---------------------------------------------------------------------------

async function installForClaude(createIfMissing = false): Promise<void> {
  if (isSandboxedHome()) return;
  const fileExists = existsSync(CLAUDE_USER_CONFIG);
  if (!fileExists && !createIfMissing) return;

  let raw = "";
  if (fileExists) {
    try {
      raw = await fs.readFile(CLAUDE_USER_CONFIG, "utf8");
    } catch (err) {
      console.warn("[mcp-installer] could not read ~/.claude.json:", err);
      return;
    }
  }

  let parsed: Record<string, unknown>;
  if (raw.trim()) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        console.warn("[mcp-installer] ~/.claude.json is not a JSON object; skipping");
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch (err) {
      console.warn("[mcp-installer] ~/.claude.json parse failed; skipping:", (err as Error).message);
      return;
    }
  } else {
    parsed = {};
  }

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};

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

  if (!changed) return;

  parsed.mcpServers = servers;
  try {
    const payload = JSON.stringify(parsed, null, 2) + "\n";
    if (raw === payload) return;
    await writeFileAtomic(CLAUDE_USER_CONFIG, payload);
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.claude.json:", err);
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
  if (env.SPARK_HOME_DIR !== sparkHome()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Codex (~/.codex/config.toml)
// ---------------------------------------------------------------------------

async function installForCodex(createIfMissing = false): Promise<void> {
  if (isSandboxedHome()) return;
  const dirExists = directoryExists(CODEX_DIR);
  if (!dirExists && !createIfMissing) return;
  if (!dirExists) {
    try {
      await fs.mkdir(CODEX_DIR, { recursive: true });
    } catch (err) {
      console.warn("[mcp-installer] could not create ~/.codex:", err);
      return;
    }
  }

  let existing = "";
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[mcp-installer] could not read ~/.codex/config.toml:", err);
      return;
    }
  }

  // If the user has a non-Codara `codara-studio` server defined outside our
  // managed block, leave the file alone.
  if (hasUserCodaraStudioSection(existing)) return;

  // Strip our managed block, the retired orchestrator block, and any broken
  // legacy-named tables, then append one fresh block.
  const stripped = stripAllManagedBlocks(existing);
  const block = renderCodexBlock();
  const base = stripped.trimEnd();
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  if (next === existing) return;

  try {
    await fs.writeFile(CODEX_USER_CONFIG, next, "utf8");
  } catch (err) {
    console.warn("[mcp-installer] failed to write ~/.codex/config.toml:", err);
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
  const withoutManaged = stripAllManagedBlocks(text);
  const pattern = /^\s*\[mcp_servers\.(?:"codara-studio"|'codara-studio'|codara-studio)\]\s*$/m;
  return pattern.test(withoutManaged);
}

// Strip the codara-studio managed block, the retired orchestrator block, and
// every stray legacy-named table. Ordering matters: remove BOTH marker regions
// wholesale FIRST (with no legacy names, so the marker logic drops each block —
// and any legacy tables inside it — atomically), THEN sweep orphan legacy-named
// tables that survived outside any marker. Doing the legacy sweep in the same
// pass as the first marker region let that pass's legacy-section consumption run
// past the SECOND block's END marker (an END marker is a comment, not a `[`
// line), orphaning the second block's comment lines forever.
function stripAllManagedBlocks(text: string): string {
  let out = stripManagedCodexRegions(text, CODEX_BLOCK_START, CODEX_BLOCK_END, []);
  out = stripManagedCodexRegions(out, CODEX_ORCHESTRATOR_BLOCK_START, CODEX_ORCHESTRATOR_BLOCK_END, []);
  // Markers are gone now; reuse the builtin-marker strings as harmless no-ops so
  // only the legacy-table sweep runs on this final pass.
  out = stripManagedCodexRegions(out, CODEX_BLOCK_START, CODEX_BLOCK_END, LEGACY_CODEX_TABLE_NAMES);
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
    `SPARK_HOME_DIR = ${tomlString(sparkHome())}`,
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
}): boolean {
  if (input.autoInstallEnabled) {
    if (existsSync(CLAUDE_USER_CONFIG)) return true;
    if (existsSync(CODEX_DIR)) return true;
  }
  return detectUserSparkEntry(input.cwd);
}

// Back-compat shim — orchestration code still imports this name. Will be
// renamed in a follow-up.
export function isPlaywrightMcpAvailable(input: {
  cwd: string | null;
  autoInstallEnabled: boolean;
}): boolean {
  return isSparkPreviewMcpAvailable(input);
}

function detectUserSparkEntry(cwd: string | null): boolean {
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
  const tomlCandidates = [CODEX_USER_CONFIG];
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
  if (!directoryExists(CODEX_DIR)) return false;
  let existing = "";
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
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
}): Promise<SparkBuiltinMcpStatus[]> {
  const metas = builtinMeta(input.autoInstallEnabled);
  return Promise.all(
    metas.map(async (meta) => {
      const [claude, codex] = await Promise.all([
        detectClaudeBuiltinState(meta.serverName, input.claudeRuntimeAvailable),
        detectCodexBuiltinState(input.codexRuntimeAvailable),
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
): Promise<SparkBuiltinActionResult> {
  try {
    if (runtime === "claude") await installForClaude(true);
    else await installForCodex(true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uninstallSparkBuiltin(
  _id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
): Promise<SparkBuiltinActionResult> {
  try {
    if (runtime === "claude") return await uninstallManagedClaudeServer(SERVER_NAME);
    return await uninstallCodexBuiltinBlock();
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
): Promise<SparkBuiltinRuntimeStatus> {
  let existing = "";
  if (existsSync(CODEX_USER_CONFIG)) {
    try {
      existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
    } catch {
      existing = "";
    }
  }
  if (hasUserCodaraStudioSection(existing)) return { state: "user-managed", configPath: CODEX_USER_CONFIG };
  const managed = existing.includes(CODEX_BLOCK_START) && existing.includes(CODEX_BLOCK_END);
  if (managed) return { state: "installed", configPath: CODEX_USER_CONFIG };
  return { state: runtimeAvailable ? "available" : "unavailable", configPath: CODEX_USER_CONFIG };
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
async function uninstallCodexBuiltinBlock(): Promise<SparkBuiltinActionResult> {
  if (!existsSync(CODEX_USER_CONFIG)) return { ok: true };
  let existing: string;
  try {
    existing = await fs.readFile(CODEX_USER_CONFIG, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read ~/.codex/config.toml: ${(err as Error).message}` };
  }
  if (hasUserCodaraStudioSection(existing)) {
    return {
      ok: false,
      error: `A user-defined ${SERVER_NAME} section exists in config.toml; Codara won't remove it.`,
    };
  }
  const next = stripAllManagedBlocks(existing);
  if (next === existing) return { ok: true };
  try {
    await fs.writeFile(CODEX_USER_CONFIG, next, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not write ~/.codex/config.toml: ${(err as Error).message}` };
  }
}

// Test/diagnostic surface.
export const __test = {
  SERVER_NAME,
  LEGACY_SERVER_NAMES,
  SPARK_VERSION,
  CLAUDE_USER_CONFIG,
  CODEX_USER_CONFIG,
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
