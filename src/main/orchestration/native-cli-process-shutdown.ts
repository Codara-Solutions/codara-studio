import { spawnSync } from "node:child_process";
import {
  captureOwnedProcessTree,
  isOwnedProcessTreeAlive,
  signalOwnedProcessTree,
  type OwnedProcessTree,
} from "../owned-process-tree";
import type { NativeCliAccountRuntime } from "./native-cli-accounts";

const PROCESS_LIST_TIMEOUT_MS = 1_000;
const PROCESS_LIST_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 1_500;
const POLL_MS = 75;

export interface NativeCliProcessSnapshot {
  pid: number;
  parentPid: number;
  startedAt: string;
  command: string;
}

export interface NativeCliExternalShutdownResult {
  closedProcessCount: number;
}

export interface NativeCliProcessShutdownDependencies {
  platform?: NodeJS.Platform;
  currentPid?: number;
  listProcesses?: () => readonly NativeCliProcessSnapshot[];
  captureTree?: (pid: number) => OwnedProcessTree | null;
  signalTree?: (tree: OwnedProcessTree | null, signal: NodeJS.Signals) => number;
  treeAlive?: (tree: OwnedProcessTree | null) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
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

function listPosixProcesses(): NativeCliProcessSnapshot[] {
  const result = spawnSync(
    "ps",
    ["-axo", "pid=,ppid=,lstart=,command="],
    {
      encoding: "utf8",
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BYTES,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Could not inspect running native CLI sessions");
  }
  return parseNativeCliProcessList(result.stdout);
}

function listWindowsProcesses(): NativeCliProcessSnapshot[] {
  const script = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BYTES,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Could not inspect running native CLI sessions");
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
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
      }];
    });
  } catch {
    throw new Error("Could not inspect running native CLI sessions");
  }
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
): boolean {
  const normalized = command.trim().replace(/\\/g, "/");
  if (!normalized) return false;

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

export function nativeCliRootProcesses(
  runtime: NativeCliAccountRuntime,
  processes: readonly NativeCliProcessSnapshot[],
  currentPid: number = process.pid,
): NativeCliProcessSnapshot[] {
  const candidates = processes.filter(
    (entry) =>
      entry.pid !== currentPid && commandRunsNativeCli(runtime, entry.command),
  );
  const candidatePids = new Set(candidates.map((entry) => entry.pid));
  return candidates.filter((entry) => !candidatePids.has(entry.parentPid));
}

async function waitForTrees(
  trees: readonly OwnedProcessTree[],
  treeAlive: (tree: OwnedProcessTree | null) => boolean,
  wait: (milliseconds: number) => Promise<void>,
  milliseconds: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, milliseconds);
  while (Date.now() < deadline && trees.some((tree) => treeAlive(tree))) {
    await wait(POLL_MS);
  }
}

/**
 * Close native CLI sessions that were started outside Codara before a global
 * account change. POSIX gets a terminal-style HUP, then TERM, then a bounded
 * KILL fallback. On Windows we refuse to hard-terminate unknown external
 * consoles; Codara-owned ConPTY sessions have already taken their graceful
 * close path, and the account selection remains unchanged.
 */
export async function shutdownExternalNativeCliProcesses(
  runtime: NativeCliAccountRuntime,
  options: {
    graceMs?: number;
    dependencies?: NativeCliProcessShutdownDependencies;
  } = {},
): Promise<NativeCliExternalShutdownResult> {
  const dependencies = options.dependencies ?? {};
  const platform = dependencies.platform ?? process.platform;
  const currentPid = dependencies.currentPid ?? process.pid;
  const listProcesses =
    dependencies.listProcesses ??
    (platform === "win32" ? listWindowsProcesses : listPosixProcesses);
  const captureTree = dependencies.captureTree ?? captureOwnedProcessTree;
  const signalTree = dependencies.signalTree ?? signalOwnedProcessTree;
  const treeAlive = dependencies.treeAlive ?? isOwnedProcessTreeAlive;
  const wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  const before = listProcesses();
  const roots = nativeCliRootProcesses(runtime, before, currentPid);
  if (roots.length === 0) return { closedProcessCount: 0 };

  const protectedAncestors = ancestorPids(before, currentPid);
  if (roots.some((entry) => protectedAncestors.has(entry.pid))) {
    throw new Error(
      `Cannot switch ${runtime} accounts while Codara is running inside that CLI session`,
    );
  }
  if (platform === "win32") {
    throw new Error(
      `Close external ${runtime} sessions before switching accounts`,
    );
  }

  const trees = roots
    .map((entry) => captureTree(entry.pid))
    .filter((tree): tree is OwnedProcessTree => tree !== null);
  for (const tree of trees) signalTree(tree, "SIGHUP");
  await waitForTrees(trees, treeAlive, wait, options.graceMs ?? DEFAULT_GRACE_MS);
  for (const tree of trees) {
    if (treeAlive(tree)) signalTree(tree, "SIGTERM");
  }
  await waitForTrees(trees, treeAlive, wait, 500);
  for (const tree of trees) {
    if (treeAlive(tree)) signalTree(tree, "SIGKILL");
  }
  await waitForTrees(trees, treeAlive, wait, 250);

  const remaining = nativeCliRootProcesses(runtime, listProcesses(), currentPid);
  if (remaining.length > 0) {
    throw new Error(`Could not close every running ${runtime} session`);
  }
  return { closedProcessCount: roots.length };
}
