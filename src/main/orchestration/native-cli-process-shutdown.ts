import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeCliAccountRuntime } from "./native-cli-accounts";

const PROCESS_LIST_TIMEOUT_MS = 1_000;
const PROCESS_LIST_MAX_BYTES = 4 * 1024 * 1024;

export interface NativeCliProcessSnapshot {
  pid: number;
  parentPid: number;
  startedAt: string;
  command: string;
  executable?: string;
}

function safePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

/** Parse the bounded `ps` shape used below without executing or tokenizing argv. */
export function parseNativeCliProcessList(output: string): NativeCliProcessSnapshot[] {
  const processes: NativeCliProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
        line,
      );
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!safePid(pid) || !Number.isSafeInteger(parentPid) || parentPid < 0) continue;
    processes.push({
      pid,
      parentPid,
      startedAt: match[3],
      command: match[4],
    });
  }
  return processes;
}

const POSIX_LIST_COMMAND = ["ps", ["-axo", "pid=,ppid=,lstart=,command="]] as const;
const POSIX_EXECUTABLE_ARGS = ["-axo", "pid=,comm="];

function withExecutables(processes: NativeCliProcessSnapshot[], output: string): NativeCliProcessSnapshot[] {
  const executables = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) executables.set(Number(match[1]), match[2]);
  }
  return processes.flatMap((entry) => {
    const executable = executables.get(entry.pid);
    return executable ? [{ ...entry, executable }] : [];
  });
}
const WINDOWS_LIST_COMMAND = [
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "Get-CimInstance Win32_Process",
      "Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,ExecutablePath",
      "ConvertTo-Json -Compress",
    ].join(" | "),
  ],
] as const;
const execFileAsync = promisify(execFile);

async function listPosixProcessesAsync(): Promise<NativeCliProcessSnapshot[]> {
  const { stdout } = await execFileAsync(POSIX_LIST_COMMAND[0], [...POSIX_LIST_COMMAND[1]], {
    encoding: "utf8",
    timeout: PROCESS_LIST_TIMEOUT_MS,
    maxBuffer: PROCESS_LIST_MAX_BYTES,
    windowsHide: true,
  });
  const executables = await execFileAsync("ps", POSIX_EXECUTABLE_ARGS, {
    encoding: "utf8", timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: PROCESS_LIST_MAX_BYTES,
  });
  return withExecutables(parseNativeCliProcessList(stdout), executables.stdout);
}

function parseWindowsProcessList(output: string): NativeCliProcessSnapshot[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return rows.flatMap((row): NativeCliProcessSnapshot[] => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const pid = Number(record.ProcessId);
      const parentPid = Number(record.ParentProcessId);
      const command = record.CommandLine;
      if (
        !safePid(pid) ||
        !Number.isSafeInteger(parentPid) ||
        parentPid < 0 ||
        typeof command !== "string"
      ) {
        return [];
      }
      return [{
        pid,
        parentPid,
        startedAt:
          typeof record.CreationDate === "string" ? record.CreationDate : "",
        command,
        ...(typeof record.ExecutablePath === "string" ? { executable: record.ExecutablePath } : {}),
      }];
    });
  } catch {
    throw new Error("Could not inspect running native CLI sessions");
  }
}

async function listWindowsProcessesAsync(): Promise<NativeCliProcessSnapshot[]> {
  const { stdout } = await execFileAsync(WINDOWS_LIST_COMMAND[0], [...WINDOWS_LIST_COMMAND[1]], {
    encoding: "utf8",
    timeout: PROCESS_LIST_TIMEOUT_MS,
    maxBuffer: PROCESS_LIST_MAX_BYTES,
    windowsHide: true,
  });
  return parseWindowsProcessList(stdout);
}

function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function commandStartsWithNamedExecutable(
  command: string,
  executable: string,
): boolean {
  const first = firstCommandToken(command);
  return (
    first === executable ||
    first === `${executable}.exe` ||
    first.endsWith(`/${executable}`) ||
    first.endsWith(`/${executable}.exe`)
  );
}

/**
 * Match only actual vendor CLI processes. The command is anchored at argv[0]
 * (or at `node` plus its script) so an environment value or an unrelated MCP
 * command containing a package path cannot be mistaken for a live session.
 */
export function commandRunsNativeCli(
  runtime: NativeCliAccountRuntime,
  command: string,
  executable?: string,
): boolean {
  const normalized = command.trim().replace(/\\/g, "/");
  if (!normalized) return false;
  // ps does not quote paths with spaces. Its argv[0] prefix can be a
  // directory named Codex, as in ChatGPT's "Codex Framework.framework".
  // The OS executable name distinguishes those helpers from the CLI.
  if (executable) {
    const name = executable.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
    if (runtime === "codex" && name !== "codex" && name !== "codex.exe" &&
        name !== "node" && name !== "node.exe") return false;
  }

  if (runtime === "codex") {
    // ChatGPT embeds the Codex app server. It is application infrastructure,
    // not a terminal session, and an account switch must never terminate it.
    if (/\bcodex(?:\.exe)?\s+app-server(?:\s|$)/i.test(normalized)) return false;
    if (commandStartsWithNamedExecutable(normalized, "codex")) return true;
    if (/^(?:\S*\/)?node(?:\.exe)?\s+\S*\/codex(?:\.js)?(?:\s|$)/i.test(normalized)) {
      return true;
    }
    return /^\S*\/@openai\/codex(?:-[^/\s]+)?\/\S*\/codex(?:\.exe)?(?:\s|$)/i.test(
      normalized,
    );
  }

  if (runtime === "claude") {
    if (commandStartsWithNamedExecutable(normalized, "claude")) return true;
    if (/^\S*\/\.local\/share\/claude\/versions\/\S+(?:\s|$)/i.test(normalized)) {
      return true;
    }
    return /^(?:\S*\/)?node(?:\.exe)?\s+\S*(?:@anthropic-ai\/claude-code|\/claude)(?:\s|$)/i.test(
      normalized,
    );
  }

  if (commandStartsWithNamedExecutable(normalized, "grok")) return true;
  if (/^\S*\/\.grok\/downloads\/grok-[^\s/]+(?:\s|$)/i.test(normalized)) {
    return true;
  }
  return /^(?:\S*\/)?node(?:\.exe)?\s+\S*(?:@xai-official\/grok|\/grok)(?:\s|$)/i.test(
    normalized,
  );
}

function ancestorPids(
  processes: readonly NativeCliProcessSnapshot[],
  currentPid: number,
): Set<number> {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const ancestors = new Set<number>();
  let cursor = byPid.get(currentPid)?.parentPid;
  while (safePid(cursor) && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = byPid.get(cursor)?.parentPid;
  }
  return ancestors;
}

function descendantPids(
  processes: readonly NativeCliProcessSnapshot[],
  rootPid: number,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of processes) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.parentPid, siblings);
  }
  const descendants = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const cursor = queue.pop()!;
    for (const child of children.get(cursor) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * The native CLI sessions started outside Codara: one root per wrapper
 * chain. Codara's own process tree is excluded, so a CLI running inside a
 * Studio pane (a child of the pane's shell, itself a child of Studio) is
 * counted from the PTY process tree and closed by the pty layer, never here.
 */
export function nativeCliRootProcesses(
  runtime: NativeCliAccountRuntime,
  processes: readonly NativeCliProcessSnapshot[],
  currentPid: number = process.pid,
): NativeCliProcessSnapshot[] {
  const owned = descendantPids(processes, currentPid);
  const candidates = processes.filter(
    (entry) =>
      entry.pid !== currentPid &&
      !owned.has(entry.pid) &&
      commandRunsNativeCli(runtime, entry.command, entry.executable),
  );
  const candidatePids = new Set(candidates.map((entry) => entry.pid));
  return candidates.filter((entry) =>
    ![...ancestorPids(processes, entry.pid)].some((pid) => candidatePids.has(pid)),
  );
}

export async function inspectNativeCliProcesses(): Promise<NativeCliProcessSnapshot[]> {
  return process.platform === "win32" ? listWindowsProcessesAsync() : listPosixProcessesAsync();
}

/** PTY roots containing a live CLI, including a CLI typed into a plain shell. */
export function nativeCliPtyRoots(
  runtime: NativeCliAccountRuntime,
  processes: readonly NativeCliProcessSnapshot[],
  roots: readonly number[],
): Set<number> {
  const cliPids = new Set(processes.filter((entry) =>
    commandRunsNativeCli(runtime, entry.command, entry.executable),
  ).map((entry) => entry.pid));
  return new Set(roots.filter((root) => cliPids.has(root) ||
    [...descendantPids(processes, root)].some((pid) => cliPids.has(pid))));
}
