// Process census for agent hibernation: may this pane's process tree be
// stopped without taking anything but the idle agent with it?
//
// The answer is yes only when the tree is exactly "the pane's shell, maybe a
// launcher chain, the agent, and what the agent started while booting (its
// MCP servers)". Anything else (a dev server the user backgrounded before
// starting the agent, a command the agent ran with its shell tool, a process
// the agent started long after boot) keeps the pane awake. Unknown start
// times or an unreadable process list keep it awake too.
//
// The classifier is pure and unit-tested (scripts/test-agent-hibernation-
// census.cjs); the listing below is the only OS-specific part.

import { execFile, fork } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runtimeFromProcessCommand } from "@shared/agent-patterns";
import { MAYBE_AGY_RE, type AgentHibernationRuntime } from "@shared/agent-hibernation";
import { commandRunsCodaraMcpServer } from "@shared/codara-mcp-server";
import { commandRunsNativeCli } from "./orchestration/native-cli-process-shutdown";
import { listProcessesWithCommands, processStartMs, readProcFile } from "./owned-process-tree";

export interface CensusProcess {
  pid: number;
  parentPid: number;
  // Epoch ms, or null when the platform did not say.
  startMs: number | null;
  command: string;
  // Resident memory in bytes, when the listing carries it (Windows only).
  memoryBytes?: number | null;
}

export type CensusVerdict =
  // memoryBytes: what the pane's whole tree holds, the memory a stop gives
  // back; null when the listing had no memory column (POSIX: the caller then
  // reads it for `pids`, the pane's shell and everything under it).
  | { ok: true; agentPid: number; members: number; memoryBytes: number | null; pids: number[] }
  | {
      ok: false;
      reason: "process-list-unavailable" | "no-agent-process" | "other-processes";
      detail?: string;
    };

// MCP servers and other helpers an agent starts on launch come up within a
// minute of it. A process that appears later was started by the agent doing
// work (or by the user) and may be anything, a dev server included. Measured
// on Windows while seven restored agents booted at once: `npx` and `pipx` MCP
// servers came up to 32 s after the agent, so 20 s refused every pane. Tool
// shells are refused at any age, so the wider window only admits processes
// that are not running a command for the user.
export const AGENT_BOOT_WINDOW_MS = 60_000;
// `ps -o lstart` has one-second resolution, so a child can read as starting
// up to a second BEFORE its parent.
const START_SLACK_MS = 1_500;

const SHELL_NAME_RE = /^-?(?:zsh|bash|sh|dash|ksh|fish|pwsh|powershell|cmd)(?:\.exe)?$/i;
// Programs a shell or a console host keeps beside the agent that hold no user
// work: the powerlevel10k git status daemon and the Windows console hosts.
const HELPER_NAME_RE = /^(?:gitstatusd(?:-[\w.-]+)?|conhost\.exe|openconsole\.exe)$/i;
// The shell Claude Code's Bash tool runs every command in. Any process under
// it is something the agent ran for the user.
const CLAUDE_TOOL_SHELL_RE = /shell-snapshots[\\/]snapshot-/i;
// A login shell running a command string (`bash -lc "npm run dev"`) is how
// agents run tool commands. Launchers like `npm exec` use a plain `sh -c`.
const LOGIN_COMMAND_SHELL_RE = /^\s*\S*(?:zsh|bash|sh|dash|ksh|fish)(?:\.exe)?\s+(?:-\w*l\w*c\w*|-\w*c\w*l\w*|--login\s+-\w*c)\b/i;
// Claude Code's PowerShell tool on Windows: `cmd.exe /d /s /c ""…\chcp.com"
// 65001 >nul & "…\pwsh.exe" …"`. The code page switch is what tells it apart
// from the `cmd /c npx …` an MCP server is started with, which must not count.
const WINDOWS_POWERSHELL_TOOL_RE = /chcp(?:\.com)?"?\s+65001\b[\s\S]*\b(?:pwsh|powershell)(?:\.exe)?\b/i;
// npm-installed CLIs on Windows run as `node …\@scope\pkg\cli.js`.
// Antigravity's `agy` is one native binary with no npm package: only its
// exact name counts (runtimeFromProcessCommand).
const PACKAGE_PATHS: Record<Exclude<AgentHibernationRuntime, "antigravity">, RegExp> = {
  claude: /[\\/]@anthropic-ai[\\/]claude-code[\\/]/i,
  codex: /[\\/]@openai[\\/]codex[\\/]/i,
  grok: /[\\/]@xai-official[\\/]grok[\\/]/i,
  pi: /[\\/]@mariozechner[\\/]pi-coding-agent[\\/]/i,
};

/**
 * Collapse a command line into whitespace-separated tokens even when a path
 * was quoted because it contains spaces (Windows command lines usually are).
 */
export function normalizeCommandForMatch(command: string): string {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (token) tokens.push(token.replace(/\s+/g, "_"));
  }
  return tokens.join(" ");
}

function executableName(command: string): string {
  const first = normalizeCommandForMatch(command).split(" ", 1)[0] ?? "";
  return first.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

export function commandRunsAgent(command: string, runtime: AgentHibernationRuntime): boolean {
  const normalized = normalizeCommandForMatch(command);
  if (!normalized) return false;
  if (SHELL_NAME_RE.test(executableName(command))) return false;
  // agy is a native binary: the process itself is named agy. A script that
  // only carries the name (`node tools/agy.js`) is some other program.
  if (runtime === "antigravity") return executableName(command).replace(/\.exe$/, "") === "agy";
  if (runtimeFromProcessCommand(normalized) === runtime) return true;
  if (runtime !== "pi" && commandRunsNativeCli(runtime, normalized)) return true;
  const name = executableName(command).replace(/\.exe$/, "");
  return (name === "node" || name === "bun") && PACKAGE_PATHS[runtime].test(normalized);
}

// A path ending in agy (`/opt/bash tools/agy`): agy itself, whatever the
// flattened listing's first word looks like.
const AGY_PATH_RE = /[\\/]agy(?:\.exe)?(?=\s|$)/i;

/**
 * A process that may be agy itself: a path to agy, or an agy word in
 * anything but a shell that typed it (`zsh -ic agy`).
 */
function mayBeAgy(command: string): boolean {
  return AGY_PATH_RE.test(command) || (MAYBE_AGY_RE.test(command) && !isShellProcess(command));
}

function isHelperProcess(command: string): boolean {
  return HELPER_NAME_RE.test(executableName(command));
}

function isShellProcess(command: string): boolean {
  return SHELL_NAME_RE.test(executableName(command));
}

export function isToolShell(command: string): boolean {
  return (
    CLAUDE_TOOL_SHELL_RE.test(command) ||
    LOGIN_COMMAND_SHELL_RE.test(command) ||
    WINDOWS_POWERSHELL_TOOL_RE.test(command)
  );
}

// What a refusal names: the program and its age, never its arguments, which
// can carry tokens and end up in the log.
function describeProcess(entry: CensusProcess, agentStart: number | null): string {
  const name = executableName(entry.command) || "?";
  let age = "";
  if (entry.startMs !== null && agentStart !== null) {
    const seconds = Math.round((entry.startMs - agentStart) / 1000);
    age = ` ${seconds < 0 ? "-" : "+"}${Math.abs(seconds)}s`;
  }
  return `${entry.pid} ${name}${age}`;
}

/**
 * Decide whether the tree under `rootPid` (the pane's shell) holds nothing
 * but the idle agent. Pure: the caller supplies one consistent listing.
 */
export function classifyPaneProcessTree(
  processes: readonly CensusProcess[],
  rootPid: number,
  runtime: AgentHibernationRuntime,
  options: {
    bootWindowMs?: number;
    // Every process holding the pane's terminal: its POSIX tty, or on
    // Windows its console. One that is not in the tree under the pane's
    // shell (a job whose parent exited) still uses the pane and dies with
    // it, so the pane stays awake. A list without the pane's shell in it is
    // not a real answer.
    terminalPids?: readonly number[] | null;
  } = {},
): CensusVerdict {
  const bootWindowMs = options.bootWindowMs ?? AGENT_BOOT_WINDOW_MS;
  const byPid = new Map<number, CensusProcess>();
  const children = new Map<number, CensusProcess[]>();
  for (const entry of processes) {
    byPid.set(entry.pid, entry);
    const list = children.get(entry.parentPid) ?? [];
    list.push(entry);
    children.set(entry.parentPid, list);
  }
  if (!byPid.has(rootPid)) {
    return { ok: false, reason: "process-list-unavailable", detail: "pane shell not listed" };
  }
  // An agy that replaced the pane's shell (`exec agy`) is not the one the
  // proof would read: the search below starts under the root. A shell that
  // only typed it (`zsh -ic agy`) is fine.
  if (runtime === "antigravity" && mayBeAgy(byPid.get(rootPid)!.command)) {
    return { ok: false, reason: "other-processes", detail: "agy is the pane's own process" };
  }

  // Breadth-first so the shallowest agent process wins: an agent's own MCP
  // servers can carry agent-looking names, the agent itself never sits below
  // one of them.
  const depth = new Map<number, number>([[rootPid, 0]]);
  const queue: number[] = [rootPid];
  const tree: CensusProcess[] = [];
  let agent: CensusProcess | null = null;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (depth.has(child.pid)) continue;
      depth.set(child.pid, (depth.get(pid) ?? 0) + 1);
      tree.push(child);
      queue.push(child.pid);
      if (!agent && commandRunsAgent(child.command, runtime)) agent = child;
    }
  }
  if (!agent) return { ok: false, reason: "no-agent-process" };
  if (options.terminalPids && !options.terminalPids.includes(rootPid)) {
    return { ok: false, reason: "process-list-unavailable", detail: "terminal holders without the pane shell" };
  }
  for (const pid of options.terminalPids ?? []) {
    if (pid !== rootPid && !depth.has(pid)) {
      return { ok: false, reason: "other-processes", detail: `terminal holder ${pid}` };
    }
  }
  if (agent.startMs === null) {
    return { ok: false, reason: "process-list-unavailable", detail: "agent start time unknown" };
  }

  // The launcher chain from the pane's shell down to the agent.
  const chain = new Set<number>();
  for (let cursor: number | undefined = agent.parentPid; cursor !== undefined && cursor !== rootPid; ) {
    if (chain.has(cursor)) break;
    chain.add(cursor);
    cursor = byPid.get(cursor)?.parentPid;
  }
  const underAgent = new Set<number>();
  const mark = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (underAgent.has(child.pid)) continue;
      underAgent.add(child.pid);
      mark(child.pid);
    }
  };
  mark(agent.pid);

  const agentStart = agent.startMs;
  for (const entry of tree) {
    if (entry.pid === agent.pid) continue;
    // Antigravity's proof (antigravity-presence.ts) is read off one agy
    // process: a second one would be stopped unchecked, whenever it started.
    // MAYBE_AGY_RE: unquoted spaces in its path too; a false match only keeps
    // a pane awake. In the launcher chain, the shells that typed it may name it.
    if (runtime === "antigravity" && (chain.has(entry.pid) ? mayBeAgy(entry.command) : MAYBE_AGY_RE.test(entry.command))) {
      return { ok: false, reason: "other-processes", detail: `second agy ${describeProcess(entry, agentStart)}` };
    }
    if (chain.has(entry.pid)) continue;
    if (underAgent.has(entry.pid)) {
      if (isToolShell(entry.command)) {
        return { ok: false, reason: "other-processes", detail: `tool shell ${describeProcess(entry, agentStart)}` };
      }
      // Codara's own MCP server holds no user work and starts no process, but
      // Claude Code connects it lazily, often a minute or more after boot.
      // Only the server itself is exempt from the clock: anything under it is
      // judged like any other child.
      if (commandRunsCodaraMcpServer(entry.command)) continue;
      if (entry.startMs === null) {
        return { ok: false, reason: "process-list-unavailable", detail: `start of ${entry.pid} unknown` };
      }
      if (entry.startMs < agentStart - START_SLACK_MS || entry.startMs > agentStart + bootWindowMs) {
        return { ok: false, reason: "other-processes", detail: `late child ${describeProcess(entry, agentStart)}` };
      }
      continue;
    }
    // Beside the agent: only helpers that hold no user work may be there, or
    // a shell whose own children are all such helpers.
    if (isHelperProcess(entry.command)) continue;
    if (isShellProcess(entry.command) && onlyHelpersBelow(entry.pid, children)) continue;
    return { ok: false, reason: "other-processes", detail: `sibling ${describeProcess(entry, agentStart)}` };
  }
  let memoryBytes: number | null = 0;
  for (const entry of [byPid.get(rootPid)!, ...tree]) {
    const bytes = entry.memoryBytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      memoryBytes = null;
      break;
    }
    memoryBytes += bytes;
  }
  return {
    ok: true,
    agentPid: agent.pid,
    members: tree.length,
    memoryBytes,
    pids: [rootPid, ...tree.map((entry) => entry.pid)],
  };
}

function onlyHelpersBelow(pid: number, children: Map<number, CensusProcess[]>): boolean {
  for (const child of children.get(pid) ?? []) {
    if (!isHelperProcess(child.command)) return false;
    if (!onlyHelpersBelow(child.pid, children)) return false;
  }
  return true;
}

// ── Listing ─────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
// Get-CimInstance needs a PowerShell start plus a WMI query; on a busy
// Windows machine that alone can take a few seconds. Hibernation is never in
// a hurry, so it waits longer than the account-switch listing does.
const WINDOWS_LIST_TIMEOUT_MS = 15_000;
const WINDOWS_LIST_MAX_BYTES = 8 * 1024 * 1024;

/** `/Date(1760000000000)/` (Windows PowerShell 5) or an ISO stamp (pwsh 7). */
export function parseWindowsCreationDate(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const legacy = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (legacy) {
    const ms = Number(legacy[1]);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function parseWindowsCensusList(output: string): CensusProcess[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const out: CensusProcess[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const parentPid = Number(record.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) {
      continue;
    }
    const workingSet = Number(record.WorkingSetSize);
    out.push({
      pid,
      parentPid,
      memoryBytes: Number.isFinite(workingSet) && workingSet >= 0 && record.WorkingSetSize !== null ? workingSet : null,
      startMs: parseWindowsCreationDate(record.CreationDate),
      // Protected processes report no command line; fall back to the image
      // name so the classifier still sees what it is.
      command:
        typeof record.CommandLine === "string" && record.CommandLine
          ? record.CommandLine
          : typeof record.Name === "string"
            ? record.Name
            : "",
    });
  }
  return out;
}

async function listWindowsCensus(): Promise<CensusProcess[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "Get-CimInstance Win32_Process",
          "Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,Name,WorkingSetSize",
          "ConvertTo-Json -Compress",
        ].join(" | "),
      ],
      {
        encoding: "utf8",
        timeout: WINDOWS_LIST_TIMEOUT_MS,
        maxBuffer: WINDOWS_LIST_MAX_BYTES,
        windowsHide: true,
      },
    );
    return parseWindowsCensusList(stdout);
  } catch {
    return null;
  }
}

/**
 * Every process holding the pane's terminal, for the census. POSIX: the
 * processes whose controlling terminal is the pane's tty. Windows: the
 * processes attached to the pane's console, which is what node-pty's kill
 * stops (it kills the whole console process list, or closes the console
 * under them). Null when that cannot be read; the caller then refuses.
 */
export function listPaneTerminalPids(
  pane: { pid: number; ttyPath: string | null },
  platform: NodeJS.Platform = process.platform,
): Promise<number[] | null> {
  return platform === "win32" ? listConsolePids(pane.pid) : listTerminalPids(pane.ttyPath, platform);
}

/**
 * The answer of node-pty's console-list agent: the pids attached to the
 * console, minus the agent itself (it attaches to the console to ask).
 * Null for anything that is not a list of pids.
 */
export function consolePidsFromAgentMessage(message: unknown, agentPid: number | undefined): number[] | null {
  const list = (message as { consoleProcessList?: unknown } | null)?.consoleProcessList;
  if (!Array.isArray(list) || list.length === 0) return null;
  const pids: number[] = [];
  for (const value of list) {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) return null;
    if (value !== agentPid) pids.push(value as number);
  }
  return pids;
}

const CONSOLE_LIST_TIMEOUT_MS = 8_000;

/**
 * Windows: the pids attached to the console of the pane whose shell is
 * `shellPid`, read by node-pty's own console-list agent (the helper its kill
 * uses), forked here so a failure or timeout answers null instead of the
 * shell alone.
 */
export function listConsolePids(shellPid: number, agentScript?: string): Promise<number[] | null> {
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0) return Promise.resolve(null);
  let script: string;
  try {
    // `agentScript` is for tests: a stand-in agent that answers like node-pty's.
    script =
      agentScript ??
      join(dirname(createRequire(__filename).resolve("node-pty/package.json")), "lib", "conpty_console_list_agent.js");
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof fork> | null = null;
    const finish = (value: number[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CONSOLE_LIST_TIMEOUT_MS);
    try {
      child = fork(script, [String(shellPid)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    } catch {
      finish(null);
      return;
    }
    const agentPid = child.pid;
    child.on("message", (message) => finish(consolePidsFromAgentMessage(message, agentPid)));
    child.on("error", () => finish(null));
    // The helper sends its answer and exits at once; "exit" can come before
    // that message is read, so it waits a moment before giving up on it.
    child.on("exit", () => setTimeout(() => finish(null), 250));
  });
}

/**
 * POSIX: the pids whose controlling terminal is exactly `ttyPath`. Null when
 * that cannot be read, including a pane whose terminal is unknown; the caller
 * then refuses to stop the pane.
 */
export async function listTerminalPids(
  ttyPath: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<number[] | null> {
  if (platform === "win32") return null;
  if (!ttyPath) return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-t", ttyPath, "-o", "pid="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const pids: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (line.trim() && Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    }
    return pids;
  } catch {
    return null;
  }
}

// ── Memory of the pane's tree (POSIX) ───────────────────────────────────────
// The POSIX listing has no memory column, so the sleep reads it for the few
// processes it is about to stop. Linux: each one's proportional set size of
// anonymous and shared memory (smaps_rollup "Pss_Anon" + "Pss_Shmem"). Pss
// splits pages the processes share (heap pages a fork shares) instead of
// counting them once per process, and file-backed pages (the node binary,
// its libraries) are left out: they stay in the page cache after the stop,
// so they are not given back. Older kernels: the whole Pss; then the status
// file's RssAnon + RssShmem, then VmRSS. Elsewhere: `ps -o rss`.

/** Kilobytes in a /proc line such as "Pss:  123456 kB"; null when absent. */
export function procKbField(text: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(text);
  const kb = match ? Number(match[1]) : NaN;
  return Number.isFinite(kb) && kb >= 0 ? kb : null;
}

/** Sum of `ps -o pid=,rss=` rows (kB) for the listed pids; null when a row is unreadable. */
export function parsePsRss(output: string): number | null {
  let kb = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) return null;
    kb += Number(match[2]);
  }
  return kb * 1024;
}

// Kilobytes the stop gives back, from one /proc file's text; null when the
// file has none of the fields.
function freedKb(file: "smaps_rollup" | "status", text: string): number | null {
  const sum = (a: string, b: string): number | null => {
    const first = procKbField(text, a);
    return first === null ? null : first + (procKbField(text, b) ?? 0);
  };
  if (file === "smaps_rollup") return sum("Pss_Anon", "Pss_Shmem") ?? procKbField(text, "Pss");
  return sum("RssAnon", "RssShmem") ?? procKbField(text, "VmRSS");
}

async function linuxProcessMemoryBytes(pid: number, read: (path: string) => Promise<string>): Promise<number | null> {
  for (const file of ["smaps_rollup", "status"] as const) {
    try {
      const kb = freedKb(file, await read(`/proc/${pid}/${file}`));
      // A kernel thread or zombie has no memory lines: it holds nothing.
      if (kb !== null) return kb * 1024;
      if (file === "status") return 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // Gone since the listing: it holds nothing any more.
      if (code === "ENOENT" || code === "ESRCH") return 0;
    }
  }
  return null;
}

/**
 * What the processes `pids` hold in memory, in bytes; null when it cannot be
 * read for every one of them (never a partial sum presented as the whole).
 */
export async function readTreeMemoryBytes(
  pids: readonly number[],
  options: { platform?: NodeJS.Platform; read?: (path: string) => Promise<string> } = {},
): Promise<number | null> {
  const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (unique.length === 0) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return null;
  if (platform === "linux") {
    const read = options.read ?? (async (path: string) => (await readProcFile(path)).toString("utf8"));
    const sizes = await Promise.all(unique.map((pid) => linuxProcessMemoryBytes(pid, read)));
    return sizes.some((size) => size === null) ? null : sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,rss=", "-p", unique.join(",")], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    return parsePsRss(stdout);
  } catch (error) {
    // `ps -p` exits 1 when none of the pids is left: nothing is held.
    const code = (error as { code?: unknown }).code;
    const stdout = (error as { stdout?: unknown }).stdout;
    return code === 1 && typeof stdout === "string" && !stdout.trim() ? 0 : null;
  }
}

/** Every process on the machine with start time and command, or null. */
export async function listCensusProcesses(): Promise<CensusProcess[] | null> {
  if (process.platform === "win32") return listWindowsCensus();
  // A fresh listing: the decision stops processes, so it never reuses one.
  const listed = await listProcessesWithCommands(0);
  if (!listed) return null;
  return listed.map((entry) => ({
    pid: entry.pid,
    parentPid: entry.parentPid,
    startMs: processStartMs(entry.startedAt),
    command: entry.command,
  }));
}
