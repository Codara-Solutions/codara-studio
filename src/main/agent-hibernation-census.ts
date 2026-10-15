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
import type { AgentHibernationRuntime } from "@shared/agent-hibernation";
import { commandRunsNativeCli } from "./orchestration/native-cli-process-shutdown";
import { listProcessesWithCommands, processStartMs } from "./owned-process-tree";

export interface CensusProcess {
  pid: number;
  parentPid: number;
  // Epoch ms, or null when the platform did not say.
  startMs: number | null;
  command: string;
}

export type CensusVerdict =
  | { ok: true; agentPid: number; members: number }
  | {
      ok: false;
      reason: "process-list-unavailable" | "no-agent-process" | "other-processes";
      detail?: string;
    };

// MCP servers and other helpers an agent starts on launch come up within a
// few seconds of it. A process that appears later was started by the agent
// doing work (or by the user) and may be anything, a dev server included.
export const AGENT_BOOT_WINDOW_MS = 20_000;
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
// npm-installed CLIs on Windows run as `node …\@scope\pkg\cli.js`.
const PACKAGE_PATHS: Record<AgentHibernationRuntime, RegExp> = {
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
  if (runtimeFromProcessCommand(normalized) === runtime) return true;
  if (runtime !== "pi" && commandRunsNativeCli(runtime, normalized)) return true;
  const name = executableName(command).replace(/\.exe$/, "");
  return (name === "node" || name === "bun") && PACKAGE_PATHS[runtime].test(normalized);
}

function isHelperProcess(command: string): boolean {
  return HELPER_NAME_RE.test(executableName(command));
}

function isShellProcess(command: string): boolean {
  return SHELL_NAME_RE.test(executableName(command));
}

function isToolShell(command: string): boolean {
  return CLAUDE_TOOL_SHELL_RE.test(command) || LOGIN_COMMAND_SHELL_RE.test(command);
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
    if (entry.pid === agent.pid || chain.has(entry.pid)) continue;
    if (underAgent.has(entry.pid)) {
      if (isToolShell(entry.command)) {
        return { ok: false, reason: "other-processes", detail: `tool shell ${entry.pid}` };
      }
      if (entry.startMs === null) {
        return { ok: false, reason: "process-list-unavailable", detail: `start of ${entry.pid} unknown` };
      }
      if (entry.startMs < agentStart - START_SLACK_MS || entry.startMs > agentStart + bootWindowMs) {
        return { ok: false, reason: "other-processes", detail: `late child ${entry.pid}` };
      }
      continue;
    }
    // Beside the agent: only helpers that hold no user work may be there, or
    // a shell whose own children are all such helpers.
    if (isHelperProcess(entry.command)) continue;
    if (isShellProcess(entry.command) && onlyHelpersBelow(entry.pid, children)) continue;
    return { ok: false, reason: "other-processes", detail: `sibling ${entry.pid}` };
  }
  return { ok: true, agentPid: agent.pid, members: tree.length };
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
    out.push({
      pid,
      parentPid,
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
          "Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,Name",
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
export function listConsolePids(shellPid: number): Promise<number[] | null> {
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0) return Promise.resolve(null);
  let script: string;
  try {
    const ptyRoot = dirname(createRequire(__filename).resolve("node-pty/package.json"));
    script = join(ptyRoot, "lib", "conpty_console_list_agent.js");
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
