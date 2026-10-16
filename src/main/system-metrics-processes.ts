import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  SystemAppUsage,
  SystemProcessGroup,
  SystemProcessSnapshot,
  SystemProcessesSnapshot,
  SystemResource,
} from "@shared/types";
import { runMetricCommand, TypeperfStream, typeperfNumber, type TypeperfRow } from "./system-metrics-commands";
import { readProcLine, readSmallFile } from "./system-metrics-linux";

// Per-process CPU, memory, video memory and swap for the popover, grouped by
// who owns each process: the Codara pane whose pty it runs under (its whole
// tree: the agent, its shells, test runners, MCP servers), Codara itself, or
// the rest of the machine. Read only while the popover is open.

// USER_HZ, the unit of /proc/<pid>/stat's CPU times, is 100 on every Linux
// architecture Electron ships for; it is part of the kernel's ABI.
const LINUX_CLOCK_TICKS = 100;
const COMMAND_CHARS = 240;
const PANE_GROUP_TOP = 4;
const CODARA_GROUP_TOP = 4;
const OUTSIDE_GROUP_TOP = 4;
const OUTSIDE_APPS_TOP = 6;
const MAX_ANCESTOR_DEPTH = 128;
// Swap moves slowly and /proc/<pid>/status is the costliest file read here,
// so each process's figure is reused for a few seconds.
const SWAP_REREAD_MS = 3_000;
// PF_KTHREAD in /proc/<pid>/stat's flags.
const LINUX_KERNEL_THREAD = 0x00200000;

/** One process as the platform reports it, before CPU is turned into a rate. */
export interface RawProcess {
  pid: number;
  ppid: number;
  /** Linux session id; a process reparented to init keeps its pane's session. */
  sid: number | null;
  name: string;
  /** Changes when a pid is reused, so a delta never spans two processes. */
  startKey: string;
  /** Cumulative CPU seconds (Linux) ... */
  cpuSeconds: number | null;
  /** ... or a percent of one core the platform already averaged (macOS, Windows). */
  cpuCorePercent: number | null;
  memoryBytes: number;
  /** Windows reports video memory per process with the other counters. */
  gpuMemoryBytes?: number | null;
  swapBytes?: number | null;
  /** A Linux kernel thread: no memory, no command line. */
  kernelThread?: boolean;
}

export interface MeasuredProcess {
  pid: number;
  ppid: number;
  sid: number | null;
  name: string;
  startKey: string;
  /** Percent of one core. */
  cpuPercent: number;
  memoryBytes: number;
  gpuMemoryBytes: number | null;
  swapBytes: number | null;
  kernelThread?: boolean;
}

export interface PaneRoot {
  paneId: string;
  pid: number;
  workspaceId?: string | null;
  tabId?: string | null;
  serverId?: string | null;
  /** The agent CLI main detects in the pane. */
  runtime?: string | null;
  /** The agent's latest prompt. */
  task?: string | null;
}

// ── Linux ───────────────────────────────────────────────────────────────────

export interface ProcPidStat {
  name: string;
  ppid: number;
  sid: number;
  cpuTicks: number;
  startTicks: string;
  residentPages: number;
  kernelThread: boolean;
}

/**
 * /proc/<pid>/stat. The name sits in parentheses and may itself hold spaces
 * and parentheses, so the fields are counted from the last ")".
 */
export function parseProcPidStat(text: string): ProcPidStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  // Only the first 22 fields after the name are used, out of about 50.
  const fields = text.slice(close + 2).split(" ", 22);
  if (fields.length < 22) return null;
  const ppid = Number(fields[1]);
  const sid = Number(fields[3]);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  if (!Number.isFinite(ppid) || !Number.isFinite(cpuTicks)) return null;
  return {
    name: text.slice(open + 1, close),
    ppid,
    sid,
    cpuTicks,
    startTicks: fields[19],
    residentPages: Number(fields[21]) || 0,
    kernelThread: (Number(fields[6]) & LINUX_KERNEL_THREAD) !== 0,
  };
}

/** VmSwap from /proc/<pid>/status. */
export function parseStatusSwapBytes(text: string): number | null {
  const match = /^VmSwap:\s+(\d+) kB/m.exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

/** Private resident pages from /proc/<pid>/statm: resident minus file-backed and shared. */
export function parseStatmPrivatePages(text: string): number | null {
  const fields = text.trim().split(" ");
  const resident = Number(fields[1]);
  const shared = Number(fields[2]);
  return Number.isFinite(resident) && Number.isFinite(shared) ? Math.max(0, resident - shared) : null;
}

/** The kernel's page size: 4 KiB on x86, 16 KiB on Apple-silicon Linux, 64 KiB on some arm64. */
export function linuxPageSize(procRoot = "/proc"): number {
  const statm = Number(readSmallFile(join(procRoot, "self", "statm"))?.trim().split(" ")[1]);
  const rssKb = Number(/^VmRSS:\s+(\d+) kB/m.exec(readSmallFile(join(procRoot, "self", "status")) ?? "")?.[1]);
  if (statm > 0 && rssKb > 0) {
    const ratio = (rssKb * 1024) / statm;
    for (const size of [4096, 16384, 65536]) if (Math.abs(ratio - size) / size < 0.05) return size;
  }
  return 4096;
}

/**
 * Private pages by process from the previous scan, with the resident size
 * they were read at. Most processes sit idle between samples; while their
 * resident size holds, their statm is not read again.
 */
export interface PrivatePagesCache {
  entries: Map<string, { residentPages: number; privatePages: number | null }>;
}

/** Swap per process, reread every few seconds; see SWAP_REREAD_MS. */
export interface SwapCache {
  entries: Map<string, { at: number; bytes: number | null }>;
}

export function scanLinuxProcesses(
  procRoot = "/proc",
  pageSize = 4096,
  cache: PrivatePagesCache = { entries: new Map() },
  swap: { cache: SwapCache; now: number } | null = null,
): RawProcess[] | null {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return null;
  }
  const processes: RawProcess[] = [];
  const kept: PrivatePagesCache["entries"] = new Map();
  const keptSwap: SwapCache["entries"] = new Map();
  for (const name of names) {
    const first = name.charCodeAt(0);
    if (first < 48 || first > 57) continue;
    const statText = readProcLine(`${procRoot}/${name}/stat`);
    if (!statText) continue;
    const stat = parseProcPidStat(statText);
    if (!stat) continue;
    // Kernel threads (a third of a typical listing) own no memory: skip
    // their statm.
    let privatePages: number | null = null;
    if (stat.residentPages > 0) {
      const key = `${name}:${stat.startTicks}`;
      const known = cache.entries.get(key);
      if (known && known.residentPages === stat.residentPages) {
        privatePages = known.privatePages;
      } else {
        const statm = readProcLine(`${procRoot}/${name}/statm`);
        privatePages = statm ? parseStatmPrivatePages(statm) : null;
      }
      kept.set(key, { residentPages: stat.residentPages, privatePages });
    }
    // A process swapped out entirely has no resident pages but still swap.
    let swapBytes: number | null = null;
    if (swap && !stat.kernelThread) {
      const key = `${name}:${stat.startTicks}`;
      const known = swap.cache.entries.get(key);
      if (known && swap.now - known.at < SWAP_REREAD_MS) {
        swapBytes = known.bytes;
        keptSwap.set(key, known);
      } else {
        const status = readSmallFile(`${procRoot}/${name}/status`);
        swapBytes = status ? parseStatusSwapBytes(status) : null;
        keptSwap.set(key, { at: swap.now, bytes: swapBytes });
      }
    }
    processes.push({
      pid: Number(name),
      ppid: stat.ppid,
      sid: stat.sid,
      name: stat.name,
      startKey: stat.startTicks,
      cpuSeconds: stat.cpuTicks / LINUX_CLOCK_TICKS,
      cpuCorePercent: null,
      memoryBytes: (privatePages ?? 0) * pageSize,
      swapBytes,
      kernelThread: stat.kernelThread,
    });
  }
  cache.entries = kept;
  if (swap) swap.cache.entries = keptSwap;
  return processes;
}

/** argv from /proc/<pid>/cmdline, NUL separated. */
export function readLinuxCommandLine(pid: number, procRoot = "/proc"): string[] | null {
  const text = readSmallFile(`${procRoot}/${pid}/cmdline`);
  if (!text) return null;
  const argv = text.split("\0").filter((arg, index, all) => arg !== "" || index < all.length - 1);
  return argv.length > 0 ? argv : null;
}

// ── macOS ───────────────────────────────────────────────────────────────────

/** `ps -axo pid=,ppid=,pcpu=,rss=,comm=`: comm is last because it may hold spaces. */
export function parseMacPs(output: string): RawProcess[] {
  const processes: RawProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([0-9.,]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const command = match[5];
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      sid: null,
      name: basename(command),
      startKey: command,
      cpuSeconds: null,
      cpuCorePercent: Number(match[3].replace(",", ".")),
      memoryBytes: Number(match[4]) * 1024,
    });
  }
  return processes;
}

/** `ps -o pid=,args= -p ...`: one full command line per pid. */
export function parseMacArgs(output: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2]);
  }
  return lines;
}

// ── Windows ─────────────────────────────────────────────────────────────────

export const WINDOWS_PROCESS_COUNTERS = [
  "\\Process(*)\\ID Process",
  "\\Process(*)\\Creating Process ID",
  "\\Process(*)\\% Processor Time",
  "\\Process(*)\\Working Set - Private",
  "\\GPU Process Memory(*)\\Dedicated Usage",
] as const;

/**
 * Processes from one typeperf row. Instance names ("chrome#3") are only
 * stable within a row, so the four counters are joined per row by instance.
 */
export function parseWindowsProcesses(row: Pick<TypeperfRow, "headers" | "values">): RawProcess[] {
  const byInstance = new Map<string, Partial<Record<"pid" | "ppid" | "cpu" | "memory", number>>>();
  // GPU Process Memory instances name the pid and the adapter:
  // "pid_1234_luid_0x00000000_0x0000D1C2_phys_0". A process on two GPUs
  // has two.
  let gpuReported = false;
  const gpuByPid = new Map<number, number>();
  for (let index = 1; index < row.headers.length; index += 1) {
    const gpuMatch = /\\GPU Process Memory\(pid_(\d+)_[^)]*\)\\Dedicated Usage$/i.exec(row.headers[index]);
    if (gpuMatch) {
      gpuReported = true;
      const value = typeperfNumber(row.values[index] ?? "");
      const pid = Number(gpuMatch[1]);
      if (Number.isFinite(value)) gpuByPid.set(pid, (gpuByPid.get(pid) ?? 0) + value);
      continue;
    }
    const match = /\\Process\(([^)]*)\)\\(.+)$/i.exec(row.headers[index]);
    if (!match) continue;
    const [, instance, counter] = match;
    if (/^(_Total|Idle)$/i.test(instance)) continue;
    const value = typeperfNumber(row.values[index] ?? "");
    if (!Number.isFinite(value)) continue;
    const entry = byInstance.get(instance) ?? {};
    if (/^ID Process$/i.test(counter)) entry.pid = value;
    else if (/^Creating Process ID$/i.test(counter)) entry.ppid = value;
    else if (/^% Processor Time$/i.test(counter)) entry.cpu = value;
    else if (/^Working Set - Private$/i.test(counter)) entry.memory = value;
    byInstance.set(instance, entry);
  }
  const processes: RawProcess[] = [];
  for (const [instance, entry] of byInstance) {
    if (!entry.pid) continue;
    const name = instance.replace(/#\d+$/, "");
    processes.push({
      pid: entry.pid,
      ppid: entry.ppid ?? 0,
      sid: null,
      name,
      startKey: name,
      cpuSeconds: null,
      cpuCorePercent: entry.cpu ?? 0,
      memoryBytes: entry.memory ?? 0,
      gpuMemoryBytes: gpuReported ? (gpuByPid.get(entry.pid) ?? 0) : null,
    });
  }
  return processes;
}

// ── Naming ──────────────────────────────────────────────────────────────────

const INTERPRETERS = /^(?:node|nodejs|bun|deno|tsx|ts-node|python[0-9.]*|pypy[0-9.]*|ruby|perl|php|java|uv|uvx)$/i;
const PACKAGE_RUNNERS = /^(?:npm|pnpm|yarn|npx|pnpx|bunx)$/i;
const GENERIC_SCRIPTS = /^(?:index|cli|main|bin|run|start|server|app|entry|launcher|wrapper)$/i;

function scriptName(path: string): string {
  const base = basename(path).replace(/\.(?:[cm]?[jt]sx?|py)$/i, "");
  if (!GENERIC_SCRIPTS.test(base)) return base;
  const parts = path.split(/[\\/]/);
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && parts[modules + 1]) {
    return parts[modules + 1].startsWith("@") && parts[modules + 2] ? parts[modules + 2] : parts[modules + 1];
  }
  return parts.length >= 2 && parts[parts.length - 2] ? parts[parts.length - 2] : base;
}

/**
 * What a person would call the process: the script a runtime runs ("eslint",
 * not "node"), the package script npm runs, and a Chromium helper's type.
 */
export function friendlyProcessName(rawArgv: readonly string[], fallback: string): string {
  if (rawArgv.length === 0 || !rawArgv[0]) return fallback;
  // Chromium and Electron rewrite their argv into one space-joined string
  // ("/opt/google/chrome/chrome --type=renderer ...", "electron ."). A
  // daemon's own title ("postgres: checkpointer") stays whole.
  const argv =
    rawArgv.length === 1 && /\s/.test(rawArgv[0].trim()) && !/^\S+:\s/.test(rawArgv[0])
      ? rawArgv[0].trim().split(/\s+/)
      : rawArgv;
  const executable = basename(argv[0]).replace(/\.exe$/i, "");
  if (INTERPRETERS.test(executable)) {
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "-m" && argv[index + 1]) return argv[index + 1];
      if (arg === "-jar" && argv[index + 1]) return scriptName(argv[index + 1]);
      if (arg.startsWith("-")) continue;
      return scriptName(arg);
    }
    return executable;
  }
  if (PACKAGE_RUNNERS.test(executable)) {
    const words = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    const shown = /^(?:run|exec|run-script|dlx)$/i.test(words[0] ?? "") ? words.slice(0, 2) : words.slice(0, 1);
    return [executable, ...shown].join(" ");
  }
  const type = argv.find((arg) => arg.startsWith("--type="))?.slice("--type=".length);
  const name = executable || fallback;
  return type ? `${name} (${type})` : name;
}

// ── Ownership and grouping ──────────────────────────────────────────────────

type OwnerKey = string;
const CODARA = "codara";
const OUTSIDE = "outside";

/**
 * Which pane, if any, each process belongs to: the nearest ancestor that is a
 * pane's pty, else the pane whose session it still carries after being
 * reparented. Anything under Codara's own process that no pane owns is
 * Codara's (renderers, the GPU process, Cora's runtimes).
 */
export function processOwners(
  processes: readonly Pick<MeasuredProcess, "pid" | "ppid" | "sid">[],
  panes: readonly PaneRoot[],
  appPid: number,
): Map<number, OwnerKey> {
  const parent = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const session = new Map(processes.map((entry) => [entry.pid, entry.sid]));
  const paneByPid = new Map(panes.filter((pane) => pane.pid > 0).map((pane) => [pane.pid, `pane:${pane.paneId}`]));
  const owners = new Map<number, OwnerKey>();
  for (const { pid } of processes) {
    if (owners.has(pid)) continue;
    const chain: number[] = [];
    let current: number | undefined = pid;
    let owner: OwnerKey | null = null;
    while (current !== undefined && current > 0 && chain.length < MAX_ANCESTOR_DEPTH) {
      const known = owners.get(current);
      if (known) {
        owner = known;
        break;
      }
      chain.push(current);
      const pane = paneByPid.get(current);
      if (pane) {
        owner = pane;
        break;
      }
      if (current === appPid) {
        owner = CODARA;
        break;
      }
      const next = parent.get(current);
      if (next === undefined || next === current || chain.includes(next)) break;
      current = next;
    }
    if (!owner || owner === OUTSIDE) {
      // Reparented to init (or under a process outside Codara): the session
      // a pane's shell started may still claim it. Only this process proved
      // that link, so its ancestors are left to answer for themselves.
      const sid = session.get(pid);
      owners.set(pid, (sid !== null && sid !== undefined && paneByPid.get(sid)) || OUTSIDE);
      continue;
    }
    for (const member of chain) owners.set(member, owner);
  }
  return owners;
}

type Measure = (entry: { cpuPercent: number; memoryBytes: number; gpuMemoryBytes: number | null; swapBytes: number | null }) => number;

const MEASURES: Record<SystemResource, Measure> = {
  cpu: (entry) => entry.cpuPercent,
  memory: (entry) => entry.memoryBytes,
  gpu: (entry) => entry.gpuMemoryBytes ?? 0,
  swap: (entry) => entry.swapBytes ?? 0,
};

/** The heaviest `count` by each measured resource, so every breakdown can list its own top. */
function topBy<T extends Parameters<Measure>[0]>(
  members: readonly T[],
  count: number,
  resources: readonly SystemResource[],
  key: (entry: T) => string | number,
): T[] {
  const picked = new Map<string | number, T>();
  for (const resource of resources) {
    const measure = MEASURES[resource];
    const top = [...members]
      .filter((entry) => resource === "cpu" || resource === "memory" || measure(entry) > 0)
      .sort((left, right) => measure(right) - measure(left))
      .slice(0, count);
    for (const entry of top) picked.set(key(entry), entry);
  }
  return [...picked.values()];
}

function sumOf(list: readonly MeasuredProcess[], pick: (entry: MeasuredProcess) => number | null, measured: boolean): number | null {
  return measured ? list.reduce((sum, entry) => sum + (pick(entry) ?? 0), 0) : null;
}

const roundTenth = (value: number) => Math.round(value * 10) / 10;

export interface GroupOptions {
  panes: readonly PaneRoot[];
  appPid: number;
  commandFor?: (process: MeasuredProcess) => { name: string; command: string } | null;
  /** Whether processes carry video memory and swap figures. */
  gpuMeasured?: boolean;
  swapMeasured?: boolean;
}

/**
 * The program a process outside Codara belongs to, for the Other apps row:
 * a Chromium helper counts as its browser ("chrome (renderer)" is chrome),
 * a macOS helper as its app bundle, a kernel thread as the kernel.
 */
function appNameOf(entry: MeasuredProcess, described: { name: string } | null): string {
  if (entry.kernelThread) return "kernel";
  const bundle = /\/([^/]+)\.app\//.exec(entry.startKey)?.[1];
  if (bundle) return bundle;
  return (described?.name ?? entry.name).replace(/\s+\([^)]*\)$/, "");
}

export function groupProcesses(processes: readonly MeasuredProcess[], options: GroupOptions): SystemProcessGroup[] {
  const owners = processOwners(processes, options.panes, options.appPid);
  const members = new Map<OwnerKey, MeasuredProcess[]>();
  for (const entry of processes) {
    const key = owners.get(entry.pid) ?? OUTSIDE;
    const list = members.get(key) ?? [];
    list.push(entry);
    members.set(key, list);
  }
  const gpuMeasured = options.gpuMeasured === true;
  const swapMeasured = options.swapMeasured === true;
  const resources: SystemResource[] = [
    "cpu",
    "memory",
    ...(gpuMeasured ? (["gpu"] as const) : []),
    ...(swapMeasured ? (["swap"] as const) : []),
  ];
  const paneByKey = new Map(options.panes.map((pane) => [`pane:${pane.paneId}`, pane]));
  const groups: SystemProcessGroup[] = [];
  for (const [key, list] of members) {
    const pane = paneByKey.get(key) ?? null;
    const owner = pane ? "pane" : key === CODARA ? "codara" : "outside";
    const top = topBy(
      list,
      owner === "pane" ? PANE_GROUP_TOP : owner === "codara" ? CODARA_GROUP_TOP : OUTSIDE_GROUP_TOP,
      resources,
      (entry) => entry.pid,
    );
    const shown: SystemProcessSnapshot[] = top
      .sort((left, right) => right.cpuPercent - left.cpuPercent || right.memoryBytes - left.memoryBytes)
      .map((entry) => {
        const described = options.commandFor?.(entry) ?? null;
        return {
          pid: entry.pid,
          name: described?.name ?? entry.name,
          command: (described?.command ?? "").slice(0, COMMAND_CHARS),
          cpuPercent: roundTenth(entry.cpuPercent),
          memoryBytes: entry.memoryBytes,
          gpuMemoryBytes: gpuMeasured ? (entry.gpuMemoryBytes ?? 0) : null,
          swapBytes: swapMeasured ? (entry.swapBytes ?? 0) : null,
        };
      });
    let apps: SystemAppUsage[] = [];
    if (owner === "outside") {
      const byName = new Map<string, SystemAppUsage>();
      for (const entry of list) {
        const name = appNameOf(entry, options.commandFor?.(entry) ?? null);
        const app = byName.get(name) ?? {
          name,
          processCount: 0,
          cpuPercent: 0,
          memoryBytes: 0,
          gpuMemoryBytes: gpuMeasured ? 0 : null,
          swapBytes: swapMeasured ? 0 : null,
        };
        app.processCount += 1;
        app.cpuPercent += entry.cpuPercent;
        app.memoryBytes += entry.memoryBytes;
        if (app.gpuMemoryBytes !== null) app.gpuMemoryBytes += entry.gpuMemoryBytes ?? 0;
        if (app.swapBytes !== null) app.swapBytes += entry.swapBytes ?? 0;
        byName.set(name, app);
      }
      apps = topBy([...byName.values()], OUTSIDE_APPS_TOP, resources, (app) => app.name)
        .map((app) => ({ ...app, cpuPercent: roundTenth(app.cpuPercent) }))
        .sort((left, right) => right.cpuPercent - left.cpuPercent || right.memoryBytes - left.memoryBytes);
    }
    groups.push({
      owner,
      paneId: pane?.paneId ?? null,
      workspaceId: pane?.workspaceId ?? null,
      tabId: pane?.tabId ?? null,
      serverId: pane?.serverId ?? null,
      runtime: pane?.runtime ?? null,
      task: pane?.task ?? null,
      cpuPercent: roundTenth(list.reduce((sum, entry) => sum + entry.cpuPercent, 0)),
      memoryBytes: list.reduce((sum, entry) => sum + entry.memoryBytes, 0),
      gpuMemoryBytes: sumOf(list, (entry) => entry.gpuMemoryBytes, gpuMeasured),
      swapBytes: sumOf(list, (entry) => entry.swapBytes, swapMeasured),
      processCount: list.length,
      processes: shown,
      apps,
    });
  }
  return groups.sort((left, right) => right.cpuPercent - left.cpuPercent || right.memoryBytes - left.memoryBytes);
}

// ── Sampler ─────────────────────────────────────────────────────────────────

export interface ProcessSamplerOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  appPid?: number;
  now?: () => number;
  logicalCores: () => number;
  /** Test seam: replaces the platform's process listing. */
  listProcesses?: () => Promise<RawProcess[] | null>;
  /** Windows: typeperf.exe. */
  typeperf?: string;
}

export interface ProcessSampleOptions {
  /** The breakdown on screen; swap is only read for "swap". */
  focus?: SystemResource;
  /** Video memory per pid from the GPU sampler (NVIDIA on Linux), or why there is none. */
  gpuMemory?: { byPid: ReadonlyMap<number, number> | null; reason: string | null };
}

/** Turns successive listings into CPU rates and groups them by owner. */
export class ProcessSampler {
  private previous = new Map<string, { cpuSeconds: number }>();
  private previousAt = 0;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly descriptions = new Map<string, { name: string; command: string }>();
  private readonly pendingMac = new Map<number, { key: string; name: string }>();
  private pageSize: number | null = null;
  private readonly privatePages: PrivatePagesCache = { entries: new Map() };
  private readonly swapCache: SwapCache = { entries: new Map() };
  private windowsStream: TypeperfStream | null = null;

  constructor(private readonly options: ProcessSamplerOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  /** Whether the last listing is recent enough to measure CPU against. */
  hasBaseline(now: number): boolean {
    return this.previousAt > 0 && now - this.previousAt < 5_000;
  }

  /** Whether CPU needs a baseline listing first (Linux counts CPU time, not a rate). */
  get needsBaseline(): boolean {
    return this.platform === "linux" || this.options.listProcesses !== undefined;
  }

  async sample(panes: readonly PaneRoot[], options: ProcessSampleOptions = {}): Promise<SystemProcessesSnapshot> {
    const wantSwap = options.focus === "swap" && this.platform === "linux";
    // Linux reads /proc synchronously, so the whole sample runs before the
    // first await and the caller can count its CPU time.
    const listed =
      this.platform === "linux" && !this.options.listProcesses ? this.listLinux(wantSwap) : await this.list();
    const now = this.now();
    if (!listed) {
      return {
        groups: [],
        processCount: 0,
        cpuMeasured: false,
        gpuMeasured: false,
        gpuUnavailableReason: null,
        swapMeasured: false,
        swapUnavailableReason: null,
        unavailableReason:
          this.platform === "win32"
            ? this.windowsStream?.failureMessage
              ? `Process counters are unavailable: ${this.windowsStream.failureMessage}`
              : "Reading process counters"
            : "The process list could not be read",
      };
    }
    // Percent of one core, as top shows it; a process cannot use more cores
    // than the machine has.
    const ceiling = Math.max(1, this.options.logicalCores()) * 100;
    const elapsedSeconds = this.previousAt > 0 ? (now - this.previousAt) / 1000 : 0;
    const next = new Map<string, { cpuSeconds: number }>();
    let measured = false;
    // Video memory: Windows lists it with each process; elsewhere the GPU
    // sampler hands over a map by pid.
    const windowsGpu = listed.some((entry) => entry.gpuMemoryBytes !== undefined && entry.gpuMemoryBytes !== null);
    const gpuByPid = options.gpuMemory?.byPid ?? null;
    const gpuMeasured = windowsGpu || gpuByPid !== null;
    const processes: MeasuredProcess[] = listed.map((entry) => {
      let cpuPercent = 0;
      if (entry.cpuCorePercent !== null) {
        cpuPercent = entry.cpuCorePercent;
        measured = true;
      } else if (entry.cpuSeconds !== null) {
        const key = `${entry.pid}:${entry.startKey}`;
        next.set(key, { cpuSeconds: entry.cpuSeconds });
        const before = this.previous.get(key);
        if (before && elapsedSeconds > 0) {
          cpuPercent = ((entry.cpuSeconds - before.cpuSeconds) / elapsedSeconds) * 100;
          measured = true;
        }
      }
      return {
        pid: entry.pid,
        ppid: entry.ppid,
        sid: entry.sid,
        name: entry.name,
        startKey: entry.startKey,
        cpuPercent: Math.min(ceiling, Math.max(0, cpuPercent)),
        memoryBytes: entry.memoryBytes,
        gpuMemoryBytes: windowsGpu ? (entry.gpuMemoryBytes ?? 0) : gpuByPid ? (gpuByPid.get(entry.pid) ?? 0) : null,
        swapBytes: entry.swapBytes ?? null,
        kernelThread: entry.kernelThread,
      };
    });
    this.previous = next;
    this.previousAt = now;

    const groups = groupProcesses(processes, {
      panes,
      appPid: this.options.appPid ?? process.pid,
      commandFor: (entry) => this.describe(entry),
      gpuMeasured,
      swapMeasured: wantSwap,
    });
    if (this.pendingMac.size > 0) await this.describeMac(groups);
    const live = new Set(processes.map(descriptionKey));
    for (const key of this.descriptions.keys()) if (!live.has(key)) this.descriptions.delete(key);
    return {
      groups,
      processCount: processes.length,
      cpuMeasured: measured,
      gpuMeasured,
      gpuUnavailableReason: gpuMeasured
        ? null
        : (options.gpuMemory?.reason ??
          (this.platform === "darwin" ? "macOS does not report video memory per app" : "No video memory per app on this system")),
      swapMeasured: wantSwap,
      swapUnavailableReason:
        wantSwap || this.platform === "linux"
          ? null
          : this.platform === "darwin"
            ? "macOS does not report swap per app"
            : "Windows does not report swap per app",
      unavailableReason: null,
    };
  }

  private async list(): Promise<RawProcess[] | null> {
    if (this.options.listProcesses) return this.options.listProcesses();
    if (this.platform === "linux") return this.listLinux(false);
    if (this.platform === "darwin") {
      const output = await runMetricCommand("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="]);
      return output ? parseMacPs(output) : null;
    }
    if (this.platform === "win32" && this.options.typeperf) {
      this.windowsStream ??= new TypeperfStream(this.options.typeperf, WINDOWS_PROCESS_COUNTERS, {
        idleStopMs: 8_000,
        // New processes only appear after a restart: typeperf expands
        // wildcards once.
        restartEveryMs: 15_000,
        now: this.now,
      });
      this.windowsStream.touch();
      const row = this.windowsStream.latest(5_000, this.now());
      return row ? parseWindowsProcesses(row) : null;
    }
    return null;
  }

  private listLinux(withSwap: boolean): RawProcess[] | null {
    this.pageSize ??= linuxPageSize(this.options.procRoot);
    return scanLinuxProcesses(
      this.options.procRoot,
      this.pageSize,
      this.privatePages,
      withSwap ? { cache: this.swapCache, now: this.now() } : null,
    );
  }

  private describe(entry: MeasuredProcess): { name: string; command: string } | null {
    const key = descriptionKey(entry);
    const cached = this.descriptions.get(key);
    if (cached) return cached;
    if (entry.kernelThread) return { name: entry.name, command: "" };
    if (this.platform === "darwin") {
      this.pendingMac.set(entry.pid, { key, name: entry.name });
      return null;
    }
    if (this.platform !== "linux") return null;
    const argv = readLinuxCommandLine(entry.pid, this.options.procRoot);
    // Kernel threads have no command line; their name is the whole story.
    const described = argv
      ? { name: friendlyProcessName(argv, entry.name), command: argv.join(" ").slice(0, COMMAND_CHARS) }
      : { name: entry.name, command: "" };
    this.descriptions.set(key, described);
    return described;
  }

  /** One `ps` for the processes whose command line is not known yet. */
  private async describeMac(groups: SystemProcessGroup[]): Promise<void> {
    const pending = new Map(this.pendingMac);
    this.pendingMac.clear();
    const output = await runMetricCommand("/bin/ps", ["-o", "pid=,args=", "-p", [...pending.keys()].join(",")]);
    const lines = output ? parseMacArgs(output) : new Map<number, string>();
    const described = new Map<number, { name: string; command: string }>();
    for (const [pid, { key, name }] of pending) {
      const args = lines.get(pid) ?? "";
      const entry = {
        name: args ? friendlyProcessName(macArgv(args), name) : name,
        command: args.slice(0, COMMAND_CHARS),
      };
      // A process that exited before ps ran is described by its name alone.
      this.descriptions.set(key, entry);
      described.set(pid, entry);
    }
    for (const entry of groups.flatMap((group) => group.processes)) {
      const update = described.get(entry.pid);
      if (!update) continue;
      entry.name = update.name;
      entry.command = update.command;
    }
  }

  childPids(): number[] {
    return this.windowsStream?.pid ? [this.windowsStream.pid] : [];
  }

  stop(): void {
    this.windowsStream?.stop();
  }
}

// The name is part of the key: a shell that execs a program keeps its pid
// and start time but changes its name.
function descriptionKey(entry: Pick<MeasuredProcess, "pid" | "startKey" | "name">): string {
  return `${entry.pid}:${entry.startKey}:${entry.name}`;
}

/**
 * macOS prints args space-joined. An app bundle's executable path holds
 * spaces ("Google Chrome.app/Contents/MacOS/Google Chrome"), so the first
 * argument ends after the bundle's MacOS directory entry.
 */
function macArgv(args: string): string[] {
  const bundle = /^(.*?\.app\/Contents\/MacOS\/\S+(?: \S+)*?)(?= -|$)/.exec(args)?.[1];
  if (bundle) return [bundle, ...args.slice(bundle.length).trim().split(/\s+/).filter(Boolean)];
  return args.split(/\s+/);
}
