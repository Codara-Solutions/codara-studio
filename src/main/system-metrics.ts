import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  SystemMemoryLevel,
  SystemResourceSnapshot,
  SystemResourceSnapshotOptions,
} from "@shared/types";
import { runMetricCommand, TypeperfStream, typeperfNumber, type TypeperfRow } from "./system-metrics-commands";
import {
  LinuxGpuSampler,
  MacGpuSampler,
  NoGpuSampler,
  parseWindowsGpuAdapters,
  WINDOWS_GPU_COUNTERS,
  type GpuSample,
  type GpuSampler,
} from "./system-metrics-gpu";
import {
  findCpuTemperatureFile,
  parseDiskstats,
  parseMeminfo,
  parseNetDev,
  parsePressure,
  parseProcStatCpu,
  parseVmstatSwap,
  physicalBlockDevices,
  physicalNetworkInterfaces,
  readMillidegrees,
  readSmallFile,
  type CpuTimes,
} from "./system-metrics-linux";
import { linuxPageSize, ProcessSampler, type PaneRoot } from "./system-metrics-processes";

export { parseMacGpuUsage } from "./system-metrics-gpu";
export type { CpuTimes } from "./system-metrics-linux";
export type { PaneRoot } from "./system-metrics-processes";

// The title-bar meters and the System activity popover. The renderer polls:
// every two seconds for the meters, every second with `detail` while the
// popover is open, and not at all while the window is hidden. Everything is
// read on demand from the cheapest source the platform has (see each
// module); the long-lived streams stop by themselves once polling does.

const MEMORY_SAMPLE_INTERVAL_MS = 900;
// Back-to-back calls (two windows) reuse the last rates instead of dividing
// a few milliseconds of counters.
const MIN_RATE_INTERVAL_MS = 200;
const DEVICE_REDISCOVERY_MS = 60_000;
const PROCESS_BASELINE_WAIT_MS = 400;
const SAMPLER_COST_WINDOW_MS = 10_000;
const SAMPLER_COST_MIN_WINDOW_MS = 2_000;

export interface SwapUsage {
  usedBytes: number;
  totalBytes: number;
}

/** What a platform's memory source reports, beyond os.totalmem/freemem. */
export interface MemoryReading {
  usedBytes: number | null;
  cachedBytes: number | null;
  swap: SwapUsage | null;
  /** Cumulative pages or bytes swapped, for rates. */
  swapInBytes: number | null;
  swapOutBytes: number | null;
  /** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
  pressureLevel: number | null;
}

interface SystemResourceMonitorOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Linux test seams: a fake /proc and /sys. */
  procRoot?: string;
  sysRoot?: string;
  readCpuTimes?: () => { total: CpuTimes; cores: CpuTimes[] } | null;
  logicalCores?: () => number;
  totalMemory?: () => number;
  freeMemory?: () => number;
  loadAverage?: () => number[];
  gpuSampler?: GpuSampler;
  sampleMemory?: () => Promise<MemoryReading | null>;
  processSampler?: ProcessSampler;
  wait?: (ms: number) => Promise<void>;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundedPercent(value: number): number {
  return Math.round(clampPercent(value) * 10) / 10;
}

export function readSystemCpuTimes(): { total: CpuTimes; cores: CpuTimes[] } {
  const cores = cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq,
  }));
  return {
    total: cores.reduce((sum, core) => ({ idle: sum.idle + core.idle, total: sum.total + core.total }), {
      idle: 0,
      total: 0,
    }),
    cores,
  };
}

export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return roundedPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

/**
 * ok; low under 12% available or when tasks stall on memory a tenth of the
 * time; critical under 5% or when every task stalls a tenth of the time, the
 * point where the machine is about to swap itself to a halt or OOM-kill.
 */
export function memoryLevelFor(input: {
  totalBytes: number;
  availableBytes: number;
  pressureSomeAvg10?: number | null;
  pressureFullAvg10?: number | null;
  macPressureLevel?: number | null;
}): SystemMemoryLevel {
  const available = input.totalBytes > 0 ? input.availableBytes / input.totalBytes : 1;
  if (available < 0.05 || (input.pressureFullAvg10 ?? 0) >= 10 || input.macPressureLevel === 4) {
    return "critical";
  }
  if (available < 0.12 || (input.pressureSomeAvg10 ?? 0) >= 10 || input.macPressureLevel === 2) return "low";
  return "ok";
}

/**
 * Activity Monitor's "Memory Used": app memory (anonymous pages minus
 * purgeable), wired, and compressed. File-backed and purgeable pages are cache
 * the kernel drops under pressure, so counting active cache as used overstated
 * RAM by several points.
 */
export function parseMacUsedMemory(output: string): number | null {
  return parseMacVmStat(output)?.usedBytes ?? null;
}

export function parseMacVmStat(
  output: string,
): { usedBytes: number; cachedBytes: number; swapInBytes: number | null; swapOutBytes: number | null } | null {
  const pageSize = Number(/page size of ([0-9]+) bytes/i.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number | null => {
    const value = Number(new RegExp(`^${label}:\\s+([0-9]+)\\.`, "im").exec(output)?.[1]);
    return Number.isFinite(value) ? value : null;
  };
  const anonymous = pages("Anonymous pages");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  if (anonymous === null || wired === null || compressed === null) return null;
  const purgeable = pages("Pages purgeable") ?? 0;
  const swapIns = pages("Swapins");
  const swapOuts = pages("Swapouts");
  return {
    usedBytes: (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize,
    cachedBytes: ((pages("File-backed pages") ?? 0) + purgeable) * pageSize,
    swapInBytes: swapIns === null ? null : swapIns * pageSize,
    swapOutBytes: swapOuts === null ? null : swapOuts * pageSize,
  };
}

const SIZE_UNIT_BYTES: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** `sysctl -n vm.swapusage`: "total = 7168.00M  used = 6249.94M  free = 918.06M". */
export function parseMacSwapUsage(output: string): SwapUsage | null {
  const amount = (label: string): number | null => {
    const match = new RegExp(`${label}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)([KMGT])`, "i").exec(output);
    if (!match) return null;
    return Math.round(Number(match[1]) * SIZE_UNIT_BYTES[match[2].toUpperCase()]);
  };
  const totalBytes = amount("total");
  const usedBytes = amount("used");
  return totalBytes === null || usedBytes === null ? null : { usedBytes, totalBytes };
}

export function parseLinuxSwapUsage(meminfo: string): SwapUsage | null {
  const memory = parseMeminfo(meminfo);
  if (!memory && !/^SwapTotal:/m.test(meminfo)) return null;
  const bytes = (label: string): number | null => {
    const value = Number(new RegExp(`^${label}:\\s+([0-9]+) kB`, "im").exec(meminfo)?.[1]);
    return Number.isFinite(value) ? value * 1024 : null;
  };
  const totalBytes = bytes("SwapTotal");
  const freeBytes = bytes("SwapFree");
  if (totalBytes === null || freeBytes === null) return null;
  return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
}

function quotedCsvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"'));
}

/**
 * typeperf prints a blank line, the CSV header and one row per sample, then
 * "Exiting, please wait..." and "The command completed successfully." on
 * stdout. The data row is therefore the last quoted line, not the last line.
 */
function parseTypeperfCsv(output: string): { headers: string[]; values: string[] } | null {
  const rows = output
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map(quotedCsvFields);
  if (rows.length < 2) return null;
  const headers = rows[0];
  const values = rows[rows.length - 1];
  if (headers.length < 2 || values.length !== headers.length) return null;
  return { headers, values };
}

/** The busiest adapter's busiest engine, from a one-shot typeperf. */
export function parseWindowsGpuUsage(output: string): number | null {
  const table = parseTypeperfCsv(output);
  if (!table) return null;
  const adapters = parseWindowsGpuAdapters(table).filter((entry) => entry.utilizationPercent !== null);
  return adapters.length > 0 ? Math.max(...adapters.map((entry) => entry.utilizationPercent ?? 0)) : null;
}

export const WINDOWS_SWAP_COUNTERS = ["\\Paging File(_Total)\\% Usage", "\\Memory\\Commit Limit"] as const;

export const WINDOWS_MACHINE_COUNTERS = [
  ...WINDOWS_SWAP_COUNTERS,
  "\\Memory\\Pages Input/sec",
  "\\Memory\\Pages Output/sec",
  "\\Memory\\Standby Cache Normal Priority Bytes",
  "\\Memory\\Standby Cache Reserve Bytes",
  "\\PhysicalDisk(_Total)\\Disk Read Bytes/sec",
  "\\PhysicalDisk(_Total)\\Disk Write Bytes/sec",
  "\\Network Interface(*)\\Bytes Received/sec",
  "\\Network Interface(*)\\Bytes Sent/sec",
  ...WINDOWS_GPU_COUNTERS,
] as const;

/**
 * Page file usage from typeperf. No counter reports the page files' size, but
 * the commit limit is physical memory plus every page file, so the size is the
 * limit minus physical memory (it matches Win32_PageFileUsage exactly).
 */
export function parseWindowsSwapUsage(output: string, physicalMemoryBytes: number): SwapUsage | null {
  const table = parseTypeperfCsv(output);
  return table ? windowsSwapFromRow(table, physicalMemoryBytes) : null;
}

function windowsColumn(row: Pick<TypeperfRow, "headers" | "values">, pattern: RegExp): number | null {
  let total: number | null = null;
  for (let index = 1; index < row.headers.length; index += 1) {
    if (!pattern.test(row.headers[index])) continue;
    const value = typeperfNumber(row.values[index] ?? "");
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

function windowsSwapFromRow(row: Pick<TypeperfRow, "headers" | "values">, physicalMemoryBytes: number): SwapUsage | null {
  const usagePercent = windowsColumn(row, /\\Paging File\(_Total\)\\% Usage$/i);
  const commitLimit = windowsColumn(row, /\\Memory\\Commit Limit$/i);
  if (usagePercent === null || commitLimit === null) return null;
  const totalBytes = Math.max(0, commitLimit - physicalMemoryBytes);
  return {
    usedBytes: Math.round((clampPercent(usagePercent) / 100) * totalBytes),
    totalBytes,
  };
}

// Hyper-V, VPN and loopback adapters carry the same bytes as the real one.
const WINDOWS_VIRTUAL_NIC = /Virtual|Hyper-V|vEthernet|Loopback|isatap|Teredo|WAN Miniport|TAP-|WireGuard/i;

/** Machine-wide figures from the Windows counter stream; rates are already per second. */
export function parseWindowsMachineRow(row: Pick<TypeperfRow, "headers" | "values">, physicalMemoryBytes: number) {
  const nic = (counter: string): number | null => {
    let total: number | null = null;
    for (let index = 1; index < row.headers.length; index += 1) {
      const match = /\\Network Interface\(([^)]*)\)\\(.+)$/i.exec(row.headers[index]);
      if (!match || match[2] !== counter || WINDOWS_VIRTUAL_NIC.test(match[1])) continue;
      const value = typeperfNumber(row.values[index] ?? "");
      if (Number.isFinite(value)) total = (total ?? 0) + value;
    }
    return total;
  };
  const pageBytes = 4096;
  const pagesIn = windowsColumn(row, /\\Memory\\Pages Input\/sec$/i);
  const pagesOut = windowsColumn(row, /\\Memory\\Pages Output\/sec$/i);
  const standbyNormal = windowsColumn(row, /\\Memory\\Standby Cache Normal Priority Bytes$/i);
  const standbyReserve = windowsColumn(row, /\\Memory\\Standby Cache Reserve Bytes$/i);
  return {
    swap: windowsSwapFromRow(row, physicalMemoryBytes),
    swapInBytesPerSecond: pagesIn === null ? null : pagesIn * pageBytes,
    swapOutBytesPerSecond: pagesOut === null ? null : pagesOut * pageBytes,
    cachedBytes: standbyNormal === null && standbyReserve === null ? null : (standbyNormal ?? 0) + (standbyReserve ?? 0),
    diskReadBytesPerSecond: windowsColumn(row, /\\PhysicalDisk\(_Total\)\\Disk Read Bytes\/sec$/i),
    diskWriteBytesPerSecond: windowsColumn(row, /\\PhysicalDisk\(_Total\)\\Disk Write Bytes\/sec$/i),
    networkReceiveBytesPerSecond: nic("Bytes Received/sec"),
    networkSendBytesPerSecond: nic("Bytes Sent/sec"),
  };
}

function windowsTypeperf(): string {
  const windowsRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return join(windowsRoot, "System32", "typeperf.exe");
}

async function sampleMacMemory(): Promise<MemoryReading | null> {
  const [vmStat, sysctl] = await Promise.all([
    runMetricCommand("/usr/bin/vm_stat", []),
    runMetricCommand("/usr/sbin/sysctl", ["vm.swapusage", "kern.memorystatus_vm_pressure_level"], {
      acceptPartial: true,
    }),
  ]);
  const vm = vmStat ? parseMacVmStat(vmStat) : null;
  const pressure = Number(/kern\.memorystatus_vm_pressure_level:\s*(\d+)/.exec(sysctl ?? "")?.[1]);
  return {
    usedBytes: vm?.usedBytes ?? null,
    cachedBytes: vm?.cachedBytes ?? null,
    swap: sysctl ? parseMacSwapUsage(sysctl) : null,
    swapInBytes: vm?.swapInBytes ?? null,
    swapOutBytes: vm?.swapOutBytes ?? null,
    pressureLevel: Number.isFinite(pressure) ? pressure : null,
  };
}

/** The Windows machine counters and GPU engines share one typeperf stream. */
class WindowsMachineCounters implements GpuSampler {
  private readonly stream: TypeperfStream;

  constructor(now: () => number) {
    this.stream = new TypeperfStream(windowsTypeperf(), WINDOWS_MACHINE_COUNTERS, {
      idleStopMs: 8_000,
      // GPU engine instances are per process and typeperf expands the
      // wildcard once, so a new game or model shows up after a restart.
      restartEveryMs: 30_000,
      now,
    });
  }

  row(now: number): TypeperfRow | null {
    this.stream.touch();
    return this.stream.latest(5_000, now);
  }

  async sample(_detail: boolean, now: number): Promise<GpuSample> {
    const row = this.row(now);
    const gpus = row ? parseWindowsGpuAdapters(row) : [];
    return {
      gpus,
      unavailableReason:
        gpus.length > 0
          ? null
          : this.stream.failureMessage
            ? `GPU counters are unavailable: ${this.stream.failureMessage}`
            : row
              ? "Windows reported no GPU engines"
              : "Reading GPU counters",
    };
  }

  childPids(): number[] {
    return this.stream.pid ? [this.stream.pid] : [];
  }

  stop(): void {
    this.stream.stop();
  }
}

class CachedAsyncMetric<T> {
  private value: T | null = null;
  private sampledAt = 0;
  private pending: Promise<T | null> | null = null;

  constructor(
    private readonly sample: () => Promise<T | null>,
    private readonly now: () => number,
    private readonly intervalMs: number,
  ) {}

  read(now: number): Promise<T | null> {
    if (now - this.sampledAt < this.intervalMs) return Promise.resolve(this.value);
    if (!this.pending) {
      this.pending = this.sample()
        .catch(() => null)
        .then((value) => {
          this.value = value;
          this.sampledAt = this.now();
          return value;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}

interface Counters {
  at: number;
  swapInBytes: number | null;
  swapOutBytes: number | null;
  diskReadBytes: number | null;
  diskWriteBytes: number | null;
  networkReceiveBytes: number | null;
  networkSendBytes: number | null;
  memoryStallMicros: number | null;
}

interface Rates {
  swapInBytesPerSecond: number | null;
  swapOutBytesPerSecond: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  networkReceiveBytesPerSecond: number | null;
  networkSendBytesPerSecond: number | null;
  memoryPressurePercent: number | null;
}

const NO_RATES: Rates = {
  swapInBytesPerSecond: null,
  swapOutBytesPerSecond: null,
  diskReadBytesPerSecond: null,
  diskWriteBytesPerSecond: null,
  networkReceiveBytesPerSecond: null,
  networkSendBytesPerSecond: null,
  memoryPressurePercent: null,
};

function ratesBetween(previous: Counters, current: Counters): Rates {
  const seconds = (current.at - previous.at) / 1000;
  const rate = (before: number | null, after: number | null): number | null =>
    before === null || after === null || seconds <= 0 ? null : Math.max(0, (after - before) / seconds);
  const stall = rate(previous.memoryStallMicros, current.memoryStallMicros);
  return {
    swapInBytesPerSecond: rate(previous.swapInBytes, current.swapInBytes),
    swapOutBytesPerSecond: rate(previous.swapOutBytes, current.swapOutBytes),
    diskReadBytesPerSecond: rate(previous.diskReadBytes, current.diskReadBytes),
    diskWriteBytesPerSecond: rate(previous.diskWriteBytes, current.diskWriteBytes),
    networkReceiveBytesPerSecond: rate(previous.networkReceiveBytes, current.networkReceiveBytes),
    networkSendBytesPerSecond: rate(previous.networkSendBytes, current.networkSendBytes),
    // Microseconds stalled per second of wall time, as a percent.
    memoryPressurePercent: stall === null ? null : roundedPercent(stall / 10_000),
  };
}

type ThreadCpuUsage = () => NodeJS.CpuUsage;

/**
 * CPU the sampler spends on the main thread plus its long-lived children, as
 * a share of one core over the last ten seconds. The window restarts when the
 * cadence changes, so the open popover reports its own cost, not the title
 * bar's.
 */
class SamplerCost {
  private readonly threadCpu: ThreadCpuUsage | null =
    (process as unknown as { threadCpuUsage?: ThreadCpuUsage }).threadCpuUsage?.bind(process) ?? null;
  private pendingMicros = 0;
  private childTicks = new Map<number, number>();
  private samples: { at: number; micros: number }[] = [];
  private detail: boolean | null = null;

  /** Runs `work` and counts its CPU time (wall time where Node cannot tell a thread's). */
  measure<T>(work: () => T): T {
    const threadBefore = this.threadCpu?.();
    const wallBefore = performance.now();
    try {
      return work();
    } finally {
      if (threadBefore && this.threadCpu) {
        const after = this.threadCpu();
        this.pendingMicros += after.user - threadBefore.user + (after.system - threadBefore.system);
      } else {
        this.pendingMicros += (performance.now() - wallBefore) * 1000;
      }
    }
  }

  /** Linux children's CPU from /proc; elsewhere their cost is not counted. */
  noteChildren(pids: readonly number[], procRoot: string): void {
    const next = new Map<number, number>();
    for (const pid of pids) {
      const stat = readSmallFile(`${procRoot}/${pid}/stat`);
      if (!stat) continue;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      if (!Number.isFinite(ticks)) continue;
      next.set(pid, ticks);
      const before = this.childTicks.get(pid);
      if (before !== undefined) this.pendingMicros += (ticks - before) * 10_000;
    }
    this.childTicks = next;
  }

  /** Closes this sample's account; null until a few seconds at this cadence are in. */
  percent(now: number, detail: boolean): number | null {
    if (detail !== this.detail) {
      this.detail = detail;
      this.samples = [];
    }
    this.samples.push({ at: now, micros: this.pendingMicros });
    this.pendingMicros = 0;
    while (this.samples.length > 2 && now - this.samples[1].at >= SAMPLER_COST_WINDOW_MS) this.samples.shift();
    // The oldest sample's work happened before the window opened.
    const elapsed = now - this.samples[0].at;
    if (elapsed < SAMPLER_COST_MIN_WINDOW_MS) return null;
    const micros = this.samples.slice(1).reduce((sum, sample) => sum + sample.micros, 0);
    return Math.round((micros / (elapsed * 1000)) * 1000) / 10;
  }
}

export class SystemResourceMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly procRoot: string;
  private readonly sysRoot: string;
  private readonly readCpu: () => { total: CpuTimes; cores: CpuTimes[] } | null;
  private readonly logicalCores: () => number;
  private readonly totalMemory: () => number;
  private readonly freeMemory: () => number;
  private readonly loadAverage: () => number[];
  private readonly gpuSampler: GpuSampler;
  private readonly memoryMetric: CachedAsyncMetric<MemoryReading> | null;
  private readonly processSampler: ProcessSampler;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly windowsCounters: WindowsMachineCounters | null;
  private readonly cost = new SamplerCost();
  private previousCpu: { total: CpuTimes; cores: CpuTimes[] } | null;
  private previousCpuAt: number;
  private lastCpuPercent = 0;
  private lastCorePercents: number[] = [];
  private previousCounters: Counters | null = null;
  private lastRates: Rates = NO_RATES;
  private devices: { at: number; disks: Set<string>; interfaces: Set<string> } | null = null;
  private temperatureFile: string | null | undefined;
  private pageSize: number | null = null;
  private cpuModel: string | null = null;

  constructor(options: SystemResourceMonitorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.procRoot = options.procRoot ?? "/proc";
    this.sysRoot = options.sysRoot ?? "/sys";
    const linux = this.platform === "linux";
    this.readCpu =
      options.readCpuTimes ??
      (linux
        ? () => {
            const text = readSmallFile(join(this.procRoot, "stat"));
            return text ? parseProcStatCpu(text) : null;
          }
        : readSystemCpuTimes);
    this.logicalCores = options.logicalCores ?? (() => this.previousCpu?.cores.length || cpus().length);
    this.totalMemory = options.totalMemory ?? totalmem;
    this.freeMemory = options.freeMemory ?? freemem;
    this.loadAverage = options.loadAverage ?? loadavg;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.windowsCounters =
      this.platform === "win32" && !options.gpuSampler ? new WindowsMachineCounters(this.now) : null;
    this.gpuSampler =
      options.gpuSampler ??
      this.windowsCounters ??
      (linux
        ? new LinuxGpuSampler({ sysRoot: this.sysRoot, procRoot: this.procRoot, now: this.now })
        : this.platform === "darwin"
          ? new MacGpuSampler()
          : new NoGpuSampler());
    const sampleMemory = options.sampleMemory ?? (this.platform === "darwin" ? sampleMacMemory : null);
    this.memoryMetric = sampleMemory
      ? new CachedAsyncMetric(sampleMemory, this.now, MEMORY_SAMPLE_INTERVAL_MS)
      : null;
    this.processSampler =
      options.processSampler ??
      new ProcessSampler({
        platform: this.platform,
        procRoot: this.procRoot,
        now: this.now,
        logicalCores: () => this.logicalCores(),
        typeperf: this.platform === "win32" ? windowsTypeperf() : undefined,
      });
    this.previousCpu = this.readCpu();
    this.previousCpuAt = this.now();
  }

  async snapshot(
    options: SystemResourceSnapshotOptions = {},
    panes: () => readonly PaneRoot[] = () => [],
  ): Promise<SystemResourceSnapshot> {
    const detail = options.detail === true;
    const linux = this.platform === "linux" && !this.memoryMetric;
    const sampledAt = this.now();

    // Processes first: on the first detailed call this takes a baseline
    // listing and waits briefly, and the machine figures below then cover
    // the same moment as the process figures.
    let processes: SystemResourceSnapshot["processes"] = null;
    if (detail) {
      const focus = options.focus;
      // The GPU's per-process loop starts on the first call, so on the first
      // detailed call it has a pass in hand by the time the baseline is over.
      const gpuMemory = () => this.cost.measure(() => this.gpuSampler.processMemory?.(this.now()));
      if (this.processSampler.needsBaseline && !this.processSampler.hasBaseline(this.now())) {
        gpuMemory();
        await this.cost.measure(() => this.processSampler.sample(panes(), { focus }));
        await this.wait(PROCESS_BASELINE_WAIT_MS);
      }
      const memory = gpuMemory();
      processes = await this.cost.measure(() => this.processSampler.sample(panes(), { focus, gpuMemory: memory }));
    }

    const [gpuSample, platformMemory] = await Promise.all([
      // Counts the synchronous part: Linux's sysfs reads, not a command's wait.
      this.cost.measure(() => this.gpuSampler.sample(detail, sampledAt)).catch(
        (): GpuSample => ({ gpus: [], unavailableReason: "GPU activity could not be read" }),
      ),
      this.memoryMetric ? this.memoryMetric.read(sampledAt) : Promise.resolve(null),
    ]);

    return this.cost.measure(() => {
      const now = this.now();
      this.sampleCpu(now);
      let totalBytes = Math.max(0, this.totalMemory());
      let availableBytes = Math.min(totalBytes, Math.max(0, this.freeMemory()));
      let cachedBytes: number | null = null;
      let swap: SwapUsage | null = null;
      let pressureSomeAvg10: number | null = null;
      let pressureFullAvg10: number | null = null;
      let counters: Counters = {
        at: now,
        swapInBytes: null,
        swapOutBytes: null,
        diskReadBytes: null,
        diskWriteBytes: null,
        networkReceiveBytes: null,
        networkSendBytes: null,
        memoryStallMicros: null,
      };
      let windowsRates: Partial<Rates> = {};
      let cpuTemperatureC: number | null = null;

      if (linux) {
        const meminfo = readSmallFile(join(this.procRoot, "meminfo"));
        const memory = meminfo ? parseMeminfo(meminfo) : null;
        if (memory) {
          totalBytes = memory.totalBytes;
          availableBytes = Math.min(totalBytes, memory.availableBytes);
          const freeBytes = Math.min(availableBytes, memory.freeBytes);
          cachedBytes = Math.max(0, Math.min(memory.cacheBytes, availableBytes - freeBytes));
          swap = { usedBytes: Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes), totalBytes: memory.swapTotalBytes };
        }
        const pressureText = readSmallFile(join(this.procRoot, "pressure", "memory"));
        const pressure = pressureText ? parsePressure(pressureText) : null;
        pressureSomeAvg10 = pressure?.some.avg10 ?? null;
        pressureFullAvg10 = pressure?.full?.avg10 ?? null;
        this.pageSize ??= linuxPageSize(this.procRoot);
        const vmstatText = readSmallFile(join(this.procRoot, "vmstat"));
        const vmstat = vmstatText ? parseVmstatSwap(vmstatText) : null;
        if (!this.devices || now - this.devices.at >= DEVICE_REDISCOVERY_MS) {
          this.devices = {
            at: now,
            disks: physicalBlockDevices(this.sysRoot),
            interfaces: physicalNetworkInterfaces(this.sysRoot),
          };
        }
        const diskText = readSmallFile(join(this.procRoot, "diskstats"));
        const disk = diskText ? parseDiskstats(diskText, this.devices.disks) : null;
        const netText = readSmallFile(join(this.procRoot, "net", "dev"));
        const net = netText ? parseNetDev(netText, this.devices.interfaces) : null;
        counters = {
          at: now,
          swapInBytes: vmstat ? vmstat.swapInPages * this.pageSize : null,
          swapOutBytes: vmstat ? vmstat.swapOutPages * this.pageSize : null,
          diskReadBytes: disk?.readBytes ?? null,
          diskWriteBytes: disk?.writeBytes ?? null,
          networkReceiveBytes: net?.receiveBytes ?? null,
          networkSendBytes: net?.sendBytes ?? null,
          memoryStallMicros: pressure?.some.total ?? null,
        };
        if (this.temperatureFile === undefined) this.temperatureFile = findCpuTemperatureFile(this.sysRoot);
        cpuTemperatureC = readMillidegrees(this.temperatureFile);
      } else if (platformMemory) {
        if (platformMemory.usedBytes !== null) {
          availableBytes = Math.max(0, totalBytes - Math.min(totalBytes, platformMemory.usedBytes));
        }
        cachedBytes =
          platformMemory.cachedBytes === null ? null : Math.min(platformMemory.cachedBytes, availableBytes);
        swap = platformMemory.swap;
        counters.swapInBytes = platformMemory.swapInBytes;
        counters.swapOutBytes = platformMemory.swapOutBytes;
      } else if (this.windowsCounters) {
        const row = this.windowsCounters.row(now);
        if (row) {
          const machine = parseWindowsMachineRow(row, totalBytes);
          swap = machine.swap;
          cachedBytes = machine.cachedBytes === null ? null : Math.min(machine.cachedBytes, availableBytes);
          windowsRates = machine;
        }
      }

      if (!this.previousCounters || now - this.previousCounters.at >= MIN_RATE_INTERVAL_MS) {
        if (this.previousCounters) this.lastRates = ratesBetween(this.previousCounters, counters);
        this.previousCounters = counters;
      }
      const rates: Rates = {
        ...this.lastRates,
        ...(this.windowsCounters
          ? {
              swapInBytesPerSecond: windowsRates.swapInBytesPerSecond ?? null,
              swapOutBytesPerSecond: windowsRates.swapOutBytesPerSecond ?? null,
              diskReadBytesPerSecond: windowsRates.diskReadBytesPerSecond ?? null,
              diskWriteBytesPerSecond: windowsRates.diskWriteBytesPerSecond ?? null,
              networkReceiveBytesPerSecond: windowsRates.networkReceiveBytesPerSecond ?? null,
              networkSendBytesPerSecond: windowsRates.networkSendBytesPerSecond ?? null,
            }
          : {}),
      };

      const ramUsedBytes = Math.max(0, totalBytes - availableBytes);
      const load = this.platform === "win32" ? null : this.loadAverage();
      const gpus = gpuSample.gpus;
      const busiest = gpus
        .map((entry) => entry.utilizationPercent)
        .filter((value): value is number => value !== null);
      if (this.cpuModel === null) this.cpuModel = cpus()[0]?.model?.trim() || "";
      this.cost.noteChildren(
        [...this.gpuSampler.childPids(), ...this.processSampler.childPids()],
        this.procRoot,
      );

      return {
        sampledAt,
        platform: this.platform,
        cpuPercent: this.lastCpuPercent,
        cpuLogicalCores: Math.max(1, this.logicalCores()),
        cpuCorePercents: this.lastCorePercents,
        cpuModel: this.cpuModel || null,
        loadAverage:
          load && load.length >= 3 ? [load[0], load[1], load[2]].map((value) => Math.round(value * 100) / 100) as [number, number, number] : null,
        cpuTemperatureC,
        gpuPercent: busiest.length > 0 ? roundedPercent(Math.max(...busiest)) : null,
        gpus,
        gpuUnavailableReason: gpus.length > 0 ? null : gpuSample.unavailableReason,
        ramPercent: totalBytes > 0 ? roundedPercent((ramUsedBytes / totalBytes) * 100) : 0,
        ramUsedBytes,
        ramTotalBytes: totalBytes,
        ramAvailableBytes: availableBytes,
        ramCachedBytes: cachedBytes,
        memoryPressurePercent: rates.memoryPressurePercent,
        memoryLevel: memoryLevelFor({
          totalBytes,
          availableBytes,
          pressureSomeAvg10,
          pressureFullAvg10,
          macPressureLevel: platformMemory?.pressureLevel ?? null,
        }),
        swapPercent:
          swap === null ? null : swap.totalBytes > 0 ? roundedPercent((swap.usedBytes / swap.totalBytes) * 100) : 0,
        swapUsedBytes: swap?.usedBytes ?? null,
        swapTotalBytes: swap?.totalBytes ?? null,
        swapInBytesPerSecond: rates.swapInBytesPerSecond,
        swapOutBytesPerSecond: rates.swapOutBytesPerSecond,
        diskReadBytesPerSecond: rates.diskReadBytesPerSecond,
        diskWriteBytesPerSecond: rates.diskWriteBytesPerSecond,
        networkReceiveBytesPerSecond: rates.networkReceiveBytesPerSecond,
        networkSendBytesPerSecond: rates.networkSendBytesPerSecond,
        processes,
        samplerCpuPercent: this.cost.percent(now, detail),
      };
    });
  }

  private sampleCpu(now: number): void {
    if (now - this.previousCpuAt < MIN_RATE_INTERVAL_MS && this.lastCorePercents.length > 0) return;
    const current = this.readCpu();
    if (!current) return;
    if (this.previousCpu) {
      this.lastCpuPercent = cpuPercentBetween(this.previousCpu.total, current.total) ?? this.lastCpuPercent;
      const previousCores = this.previousCpu.cores;
      this.lastCorePercents = current.cores.map(
        (core, index) =>
          (previousCores[index] ? cpuPercentBetween(previousCores[index], core) : null) ??
          this.lastCorePercents[index] ??
          0,
      );
    }
    this.previousCpu = current;
    this.previousCpuAt = now;
  }

  stop(): void {
    this.gpuSampler.stop();
    this.processSampler.stop();
  }
}

let systemResourceMonitor: SystemResourceMonitor | null = null;

export function systemResourceSnapshot(
  options: SystemResourceSnapshotOptions = {},
  panes: () => readonly PaneRoot[] = () => [],
): Promise<SystemResourceSnapshot> {
  systemResourceMonitor ??= new SystemResourceMonitor();
  return systemResourceMonitor.snapshot(options, panes);
}
