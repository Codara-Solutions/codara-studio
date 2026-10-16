import { readlinkSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { SystemGpuSnapshot, SystemGpuVendor } from "@shared/types";
import {
  findExecutable,
  LineStream,
  runMetricCommand,
  TypeperfStream,
  typeperfNumber,
  type TypeperfRow,
} from "./system-metrics-commands";
import { readMillidegrees, readSmallFile } from "./system-metrics-linux";

// GPU figures per adapter, from the cheapest source each platform has:
// - NVIDIA: one long-lived `nvidia-smi --query-gpu ... -lms` (Linux, and
//   Windows when installed), never a spawn per sample.
// - AMD on Linux: amdgpu's sysfs files.
// - Intel on Linux: render-engine idle (RC6) residency, which i915 and xe both
//   publish; busy is the share of wall time the GPU was not idle.
// - macOS: ioreg's PerformanceStatistics per accelerator.
// - Windows: the GPU Engine and GPU Adapter Memory performance counters from
//   one long-lived typeperf, which covers every vendor.
// Video memory per process (the popover's GPU breakdown) comes from a second
// NVIDIA loop, `--query-compute-apps`, run only while the popover is open; on
// Windows the process counters carry it (system-metrics-processes.ts).
// A GPU that runtime power management has switched off is reported asleep and
// not asked: reading it would wake it, and on a laptop keep it awake.

const STREAM_IDLE_STOP_MS = 8_000;
const NVIDIA_LOOP_MS = 1_000;
const NVIDIA_STALE_MS = 6_000;
const FIRST_READING_WAIT_MS = 600;
const TYPEPERF_RESTART_MS = 30_000;
const TYPEPERF_STALE_MS = 5_000;
const MIB = 1024 ** 2;

export interface GpuSample {
  gpus: SystemGpuSnapshot[];
  unavailableReason: string | null;
}

/** Video memory by pid, summed over GPUs, or why there is none. */
export interface GpuProcessMemory {
  byPid: ReadonlyMap<number, number> | null;
  reason: string | null;
}

export interface GpuSampler {
  sample(detail: boolean, now: number): Promise<GpuSample>;
  /** Video memory per process; only while the popover is open. Absent where processes carry it. */
  processMemory?(now: number): GpuProcessMemory;
  /** Child processes the sampler keeps running, for its cost accounting. */
  childPids(): number[];
  stop(): void;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function gpu(partial: Partial<SystemGpuSnapshot> & Pick<SystemGpuSnapshot, "id" | "name" | "vendor">): SystemGpuSnapshot {
  return {
    utilizationPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    temperatureC: null,
    asleep: false,
    note: null,
    ...partial,
  };
}

// ── NVIDIA ──────────────────────────────────────────────────────────────────

export const NVIDIA_QUERY = "pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu";

export interface NvidiaReading {
  busId: string;
  name: string;
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
}

/** nvidia-smi prints an 8-digit PCI domain ("00000000:01:00.0"); sysfs uses 4. */
export function normalizePciAddress(address: string): string {
  const match = /^(?:([0-9a-f]+):)?([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i.exec(address.trim());
  if (!match) return address.trim().toLowerCase();
  const domain = (match[1] ?? "0").slice(-4).padStart(4, "0");
  return `${domain}:${match[2]}:${match[3]}.${match[4]}`.toLowerCase();
}

/** One `--format=csv,noheader,nounits` line of NVIDIA_QUERY. "[N/A]" fields read as null. */
export function parseNvidiaSmiLine(line: string): NvidiaReading | null {
  const fields = line.split(",").map((field) => field.trim());
  if (fields.length < 6) return null;
  const [busId] = fields;
  const numbers = fields.slice(-4).map((field) => {
    const value = Number(field);
    return field === "" || !Number.isFinite(value) ? null : value;
  });
  const name = fields.slice(1, -4).join(",").replace(/^NVIDIA\s+/i, "");
  if (!/^[0-9a-f]+:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(busId)) return null;
  const [utilization, memoryUsed, memoryTotal, temperature] = numbers;
  return {
    busId: normalizePciAddress(busId),
    name: name || "NVIDIA GPU",
    utilizationPercent: utilization === null ? null : clampPercent(utilization),
    memoryUsedBytes: memoryUsed === null ? null : memoryUsed * MIB,
    memoryTotalBytes: memoryTotal === null ? null : memoryTotal * MIB,
    temperatureC: temperature,
  };
}

/** Where the NVIDIA driver installs nvidia-smi, before $PATH. */
export function nvidiaSmiCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot?.trim() || "C:\\Windows";
    const programFiles = env.ProgramFiles?.trim() || "C:\\Program Files";
    return [
      join(systemRoot, "System32", "nvidia-smi.exe"),
      join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
    ];
  }
  return [
    "/usr/bin/nvidia-smi",
    "/bin/nvidia-smi",
    "/usr/local/bin/nvidia-smi",
    "/usr/local/nvidia/bin/nvidia-smi",
    "/opt/bin/nvidia-smi",
    "/run/current-system/sw/bin/nvidia-smi",
    "/usr/lib/wsl/lib/nvidia-smi",
  ];
}

/** The latest line per GPU from a running `nvidia-smi ... -lms`. */
export class NvidiaSmiStream {
  private readonly readings = new Map<string, { reading: NvidiaReading; at: number }>();
  private readonly stream: LineStream;
  private waiters: Array<() => void> = [];

  constructor(
    executable: string,
    private readonly now: () => number = Date.now,
    spawnProcess?: ConstructorParameters<typeof LineStream>[0]["spawnProcess"],
  ) {
    this.stream = new LineStream({
      executable,
      args: [`--query-gpu=${NVIDIA_QUERY}`, "--format=csv,noheader,nounits", `-lms`, String(NVIDIA_LOOP_MS)],
      idleStopMs: STREAM_IDLE_STOP_MS,
      now,
      spawnProcess,
      onLine: (line) => {
        const reading = parseNvidiaSmiLine(line);
        if (!reading) return;
        this.readings.set(reading.busId, { reading, at: this.now() });
        for (const wake of this.waiters.splice(0)) wake();
      },
    });
  }

  touch(): void {
    this.stream.touch();
  }

  /** Resolves on the next reading, or after `timeoutMs`: the loop's first line takes ~100 ms. */
  nextReading(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Fresh readings; empty until the first loop prints. */
  current(): NvidiaReading[] {
    const now = this.now();
    return [...this.readings.values()]
      .filter((entry) => now - entry.at <= NVIDIA_STALE_MS)
      .map((entry) => entry.reading);
  }

  get running(): boolean {
    return this.stream.running;
  }

  get failureMessage(): string | null {
    return this.stream.failureMessage;
  }

  get pid(): number | null {
    return this.stream.pid;
  }

  stop(): void {
    this.stream.stop();
  }
}

function nvidiaFigures(reading: NvidiaReading): Omit<NvidiaReading, "busId"> {
  const { busId: _busId, ...figures } = reading;
  return figures;
}

export const NVIDIA_APPS_QUERY = "gpu_bus_id,pid,used_memory";

/**
 * One `--query-compute-apps` line: "00000000:02:00.0, 112768, 185". It lists
 * CUDA work and Chromium-style GPU processes; pure display clients (the
 * compositor) are not in it.
 */
export function parseNvidiaAppLine(line: string): { busId: string; pid: number; memoryBytes: number } | null {
  const fields = line.split(",").map((field) => field.trim());
  if (fields.length < 3 || !/^[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(fields[0])) return null;
  const pid = Number(fields[1]);
  const mib = Number(fields[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(mib)) return null;
  return { busId: normalizePciAddress(fields[0]), pid, memoryBytes: mib * MIB };
}

/** Video memory per process from nvidia-smi's compute-apps loop. */
export class NvidiaAppsStream {
  private readonly seen = new Map<string, { pid: number; bytes: number; at: number }>();
  private startedAt = 0;
  private readonly stream: LineStream;

  constructor(
    executable: string,
    private readonly now: () => number = Date.now,
    spawnProcess?: ConstructorParameters<typeof LineStream>[0]["spawnProcess"],
  ) {
    this.stream = new LineStream({
      executable,
      args: [`--query-compute-apps=${NVIDIA_APPS_QUERY}`, "--format=csv,noheader,nounits", "-lms", String(NVIDIA_LOOP_MS)],
      idleStopMs: STREAM_IDLE_STOP_MS,
      now,
      spawnProcess,
      onStart: () => {
        this.startedAt = this.now();
        this.seen.clear();
      },
      onLine: (line) => {
        const app = parseNvidiaAppLine(line);
        if (app) this.seen.set(`${app.busId}/${app.pid}`, { pid: app.pid, bytes: app.memoryBytes, at: this.now() });
      },
    });
  }

  /**
   * Keeps the loop running and returns what its last pass listed. A pass
   * with no processes on the GPU prints nothing, so an empty map is only
   * trusted once the first pass is overdue.
   */
  read(): Map<number, number> | null {
    this.stream.touch();
    const now = this.now();
    if (!this.stream.running) return null;
    if (this.seen.size === 0 && now - this.startedAt < NVIDIA_LOOP_MS + 500) return null;
    const byPid = new Map<number, number>();
    for (const [key, entry] of this.seen) {
      if (now - entry.at > NVIDIA_LOOP_MS * 2.5) {
        this.seen.delete(key);
        continue;
      }
      byPid.set(entry.pid, (byPid.get(entry.pid) ?? 0) + entry.bytes);
    }
    return byPid;
  }

  get failureMessage(): string | null {
    return this.stream.failureMessage;
  }

  get pid(): number | null {
    return this.stream.pid;
  }

  stop(): void {
    this.stream.stop();
  }
}

// ── Linux DRM cards ─────────────────────────────────────────────────────────

const VENDORS: Record<string, { vendor: SystemGpuVendor; label: string }> = {
  "0x10de": { vendor: "nvidia", label: "NVIDIA" },
  "0x1002": { vendor: "amd", label: "AMD" },
  "0x8086": { vendor: "intel", label: "Intel" },
};

export interface LinuxGpuCard {
  pciAddress: string;
  vendor: SystemGpuVendor;
  name: string;
  devicePath: string;
  /** Intel: idle-residency counters, one per GT, in milliseconds. */
  idleResidencyFiles: string[];
  temperatureFile: string | null;
  /** NVIDIA: runtime D3 is enabled, so the card powers off when idle. */
  powerGated: boolean;
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * The device's name from the PCI ID database lspci uses: the bracketed
 * marketing name when there is one ("AD103 [GeForce RTX 4080 SUPER]").
 */
export function pciDeviceName(database: string, vendorId: string, deviceId: string): string | null {
  const vendor = vendorId.replace(/^0x/i, "").toLowerCase();
  const device = deviceId.replace(/^0x/i, "").toLowerCase();
  const vendorAt = database.search(new RegExp(`^${vendor}  `, "m"));
  if (vendorAt < 0) return null;
  const block = database.slice(vendorAt);
  const nextVendor = block.slice(1).search(/^[0-9a-f]{4}  /m);
  const vendorBlock = nextVendor < 0 ? block : block.slice(0, nextVendor + 1);
  const line = new RegExp(`^\\t${device}  (.+)$`, "m").exec(vendorBlock)?.[1]?.trim();
  if (!line) return null;
  const bracket = /\[([^\]]+)\]/.exec(line)?.[1]?.trim();
  if (!bracket) return line;
  const chip = line.replace(/\s*\[[^\]]+\]\s*/, " ").trim();
  // Intel's bracket is just "Intel Graphics"; the chip says which.
  return /^Intel (?:UHD |Iris |Arc )?Graphics$/i.test(bracket) && chip ? `${bracket} (${chip})` : bracket;
}

function readPciDatabase(): string | null {
  for (const path of ["/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids", "/usr/share/pci.ids"]) {
    const text = readSmallFile(path);
    if (text) return text;
  }
  return null;
}

function firstHwmonTemperature(devicePath: string): string | null {
  for (const entry of listDir(join(devicePath, "hwmon"))) {
    const path = join(devicePath, "hwmon", entry, "temp1_input");
    if (readSmallFile(path) !== null) return path;
  }
  return null;
}

/** Every GPU behind /sys/class/drm, once per PCI device. */
export function discoverLinuxGpus(sysRoot = "/sys", procRoot = "/proc"): LinuxGpuCard[] {
  const drm = join(sysRoot, "class", "drm");
  const cards: LinuxGpuCard[] = [];
  const seen = new Set<string>();
  let database: string | null | undefined;
  for (const card of listDir(drm).filter((name) => /^card\d+$/.test(name)).sort(
    (left, right) => Number(left.slice(4)) - Number(right.slice(4)),
  )) {
    const devicePath = join(drm, card, "device");
    const vendorId = readSmallFile(join(devicePath, "vendor"))?.trim().toLowerCase();
    const deviceId = readSmallFile(join(devicePath, "device"))?.trim().toLowerCase();
    if (!vendorId || !deviceId) continue;
    let pciAddress: string;
    try {
      pciAddress = normalizePciAddress(basename(readlinkSync(devicePath)));
    } catch {
      pciAddress = `${card}`;
    }
    if (seen.has(pciAddress)) continue;
    seen.add(pciAddress);
    const known = VENDORS[vendorId] ?? { vendor: "other" as const, label: "Graphics" };
    if (database === undefined) database = readPciDatabase();
    const name = (database && pciDeviceName(database, vendorId, deviceId)) ?? `${known.label} GPU`;
    const idleResidencyFiles =
      known.vendor === "intel"
        ? [
            ...listDir(join(drm, card, "gt"))
              .filter((gt) => /^gt\d+$/.test(gt))
              .map((gt) => join(drm, card, "gt", gt, "rc6_residency_ms")),
            ...listDir(devicePath)
              .filter((tile) => /^tile\d+$/.test(tile))
              .flatMap((tile) =>
                listDir(join(devicePath, tile))
                  .filter((gt) => /^gt\d+$/.test(gt))
                  .map((gt) => join(devicePath, tile, gt, "gtidle", "idle_residency_ms")),
              ),
          ].filter((path) => readSmallFile(path) !== null)
        : [];
    const powerText =
      known.vendor === "nvidia" ? readSmallFile(join(procRoot, "driver", "nvidia", "gpus", pciAddress, "power")) : null;
    cards.push({
      pciAddress,
      vendor: known.vendor,
      name,
      devicePath,
      idleResidencyFiles,
      temperatureFile: firstHwmonTemperature(devicePath),
      powerGated: powerText !== null && /Runtime D3 status:\s*Enabled/i.test(powerText),
    });
  }
  return cards;
}

function readNumber(path: string): number | null {
  const text = readSmallFile(path);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

function isSuspended(card: LinuxGpuCard): boolean {
  return readSmallFile(join(card.devicePath, "power", "runtime_status"))?.trim() === "suspended";
}

export interface LinuxGpuSamplerOptions {
  sysRoot?: string;
  procRoot?: string;
  nvidiaSmi?: string | null;
  now?: () => number;
  spawnProcess?: ConstructorParameters<typeof LineStream>[0]["spawnProcess"];
}

export class LinuxGpuSampler implements GpuSampler {
  private cards: LinuxGpuCard[] | null = null;
  private readonly idleSamples = new Map<string, { idleMs: number; at: number }>();
  private nvidia: NvidiaSmiStream | null = null;
  private nvidiaApps: NvidiaAppsStream | null = null;
  private readonly nvidiaSmi: string | null;
  private readonly now: () => number;

  constructor(private readonly options: LinuxGpuSamplerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nvidiaSmi =
      options.nvidiaSmi !== undefined
        ? options.nvidiaSmi
        : findExecutable("nvidia-smi", nvidiaSmiCandidates("linux", process.env));
  }

  async sample(detail: boolean): Promise<GpuSample> {
    this.cards ??= discoverLinuxGpus(this.options.sysRoot, this.options.procRoot);
    const nvidiaCards = this.cards.filter((card) => card.vendor === "nvidia");
    const nvidiaReadings = await this.sampleNvidia(nvidiaCards, detail);
    const gpus: SystemGpuSnapshot[] = [];
    const matched = new Set<string>();
    for (const card of this.cards) {
      const base = { id: card.pciAddress, name: card.name, vendor: card.vendor };
      if (isSuspended(card)) {
        gpus.push(gpu({ ...base, utilizationPercent: 0, asleep: true }));
        continue;
      }
      if (card.vendor === "nvidia") {
        const reading = nvidiaReadings.readings.find((entry) => entry.busId === card.pciAddress);
        if (reading) {
          matched.add(reading.busId);
          gpus.push(gpu({ ...base, ...nvidiaFigures(reading) }));
        } else {
          gpus.push(gpu({ ...base, note: nvidiaReadings.note }));
        }
        continue;
      }
      if (card.vendor === "amd") {
        const busy = readNumber(join(card.devicePath, "gpu_busy_percent"));
        gpus.push(
          gpu({
            ...base,
            utilizationPercent: busy === null ? null : clampPercent(busy),
            memoryUsedBytes: readNumber(join(card.devicePath, "mem_info_vram_used")),
            memoryTotalBytes: readNumber(join(card.devicePath, "mem_info_vram_total")),
            temperatureC: readMillidegrees(card.temperatureFile),
            note: busy === null ? "The amdgpu driver does not report activity for this GPU" : null,
          }),
        );
        continue;
      }
      if (card.vendor === "intel") {
        const busy = this.intelBusy(card);
        gpus.push(
          gpu({
            ...base,
            utilizationPercent: busy,
            temperatureC: readMillidegrees(card.temperatureFile),
            note:
              card.idleResidencyFiles.length === 0
                ? "This Intel driver does not report activity"
                : null,
          }),
        );
        continue;
      }
      gpus.push(gpu({ ...base, note: "No activity counters for this GPU" }));
    }
    // A GPU nvidia-smi sees with no DRM node (compute-only setups).
    for (const reading of nvidiaReadings.readings) {
      if (!matched.has(reading.busId) && !this.cards.some((card) => card.pciAddress === reading.busId)) {
        gpus.push(gpu({ id: reading.busId, vendor: "nvidia", ...nvidiaFigures(reading) }));
      }
    }
    return {
      gpus,
      unavailableReason: gpus.length === 0 ? "No GPU found under /sys/class/drm" : null,
    };
  }

  private async sampleNvidia(
    cards: LinuxGpuCard[],
    detail: boolean,
  ): Promise<{ readings: NvidiaReading[]; note: string | null }> {
    if (cards.length === 0 && !this.nvidia) return { readings: [], note: null };
    if (!this.nvidiaSmi) {
      return { readings: [], note: "Install the NVIDIA driver's nvidia-smi to read this GPU" };
    }
    const awake = cards.filter((card) => !isSuspended(card));
    // A power-gated card (laptop dGPU) is read only while the popover is
    // open: the loop holds the device open, which keeps it powered.
    const gentle = cards.some((card) => card.powerGated);
    if (awake.length === 0 || (gentle && !detail)) {
      this.nvidia?.stop();
      return { readings: [], note: gentle ? "Open this panel to read the NVIDIA GPU without keeping it awake" : null };
    }
    this.nvidia ??= new NvidiaSmiStream(this.nvidiaSmi, this.now, this.options.spawnProcess);
    const wasRunning = this.nvidia.running;
    this.nvidia.touch();
    if (!wasRunning && this.nvidia.running) await this.nvidia.nextReading(FIRST_READING_WAIT_MS);
    const readings = this.nvidia.current();
    const failure = this.nvidia.failureMessage;
    return {
      readings,
      note: readings.length > 0 ? null : failure ? `nvidia-smi: ${failure}` : "Reading the NVIDIA GPU",
    };
  }

  private intelBusy(card: LinuxGpuCard): number | null {
    if (card.idleResidencyFiles.length === 0) return null;
    const now = this.now();
    let busiest: number | null = null;
    for (const file of card.idleResidencyFiles) {
      const idleMs = readNumber(file);
      if (idleMs === null) continue;
      const previous = this.idleSamples.get(file);
      this.idleSamples.set(file, { idleMs, at: now });
      if (!previous || now <= previous.at) continue;
      const busy = clampPercent(100 - ((idleMs - previous.idleMs) / (now - previous.at)) * 100);
      busiest = busiest === null ? busy : Math.max(busiest, busy);
    }
    return busiest;
  }

  processMemory(): GpuProcessMemory {
    this.cards ??= discoverLinuxGpus(this.options.sysRoot, this.options.procRoot);
    const nvidiaCards = this.cards.filter((card) => card.vendor === "nvidia");
    if (nvidiaCards.length === 0) {
      return { byPid: null, reason: "Video memory per app is only reported for NVIDIA GPUs" };
    }
    if (!this.nvidiaSmi) return { byPid: null, reason: "Install nvidia-smi to see video memory per app" };
    if (nvidiaCards.every(isSuspended)) {
      this.nvidiaApps?.stop();
      return { byPid: null, reason: "The NVIDIA GPU is asleep" };
    }
    this.nvidiaApps ??= new NvidiaAppsStream(this.nvidiaSmi, this.now, this.options.spawnProcess);
    const byPid = this.nvidiaApps.read();
    const failure = this.nvidiaApps.failureMessage;
    return { byPid, reason: byPid ? null : failure ? `nvidia-smi: ${failure}` : "Reading video memory per app" };
  }

  childPids(): number[] {
    return [this.nvidia?.pid, this.nvidiaApps?.pid].filter((pid): pid is number => typeof pid === "number");
  }

  stop(): void {
    this.nvidia?.stop();
    this.nvidiaApps?.stop();
  }
}

// ── macOS ───────────────────────────────────────────────────────────────────

function macGpuName(className: string, model: string | null): { name: string; vendor: SystemGpuVendor } {
  if (/^AGX/i.test(className)) return { name: model ?? "Apple GPU", vendor: "apple" };
  if (/AMD|ATI|Radeon/i.test(className)) return { name: model ?? "AMD GPU", vendor: "amd" };
  if (/Intel/i.test(className)) return { name: model ?? "Intel GPU", vendor: "intel" };
  if (/NV|GeForce|nvidia/i.test(className)) return { name: model ?? "NVIDIA GPU", vendor: "nvidia" };
  return { name: model ?? "GPU", vendor: "other" };
}

/**
 * `ioreg -r -d 1 -c IOAccelerator`: one "+-o <Class>" object per GPU with a
 * PerformanceStatistics dictionary. Apple silicon shares system memory and
 * reports "In use system memory"; discrete cards report VRAM.
 */
export function parseMacGpus(output: string): SystemGpuSnapshot[] {
  const gpus: SystemGpuSnapshot[] = [];
  const blocks = output.split(/^(?=\+-o )/m).filter((block) => block.startsWith("+-o "));
  blocks.forEach((block, index) => {
    const className = /^\+-o (\S+)/.exec(block)?.[1] ?? "GPU";
    const number = (key: string): number | null => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\%]/g, "\\$&");
      const value = Number(new RegExp(`"${escaped}"\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`, "i").exec(block)?.[1]);
      return Number.isFinite(value) ? value : null;
    };
    const model = /"model"\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null;
    const utilization = number("Device Utilization %") ?? number("GPU Activity(%)") ?? number("GPU Utilization %");
    const sharedUsed = number("In use system memory");
    const vramUsed = number("vramUsedBytes");
    const vramFree = number("vramFreeBytes");
    const { name, vendor } = macGpuName(className, model);
    gpus.push(
      gpu({
        id: `${className}-${index}`,
        name,
        vendor,
        utilizationPercent: utilization === null ? null : clampPercent(utilization),
        memoryUsedBytes: vramUsed ?? sharedUsed,
        memoryTotalBytes: vramUsed !== null && vramFree !== null ? vramUsed + vramFree : null,
        note: utilization === null ? "macOS does not report activity for this GPU" : null,
      }),
    );
  });
  return gpus;
}

/** The busiest adapter in an ioreg dump; kept for callers that want one figure. */
export function parseMacGpuUsage(output: string): number | null {
  const values: number[] = [];
  const pattern = /"(?:Device Utilization %|GPU Activity\(%\)|GPU Utilization %)"\s*=\s*([0-9]+(?:\.[0-9]+)?)/gi;
  for (const match of output.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values.length > 0 ? clampPercent(Math.max(...values)) : null;
}

export class MacGpuSampler implements GpuSampler {
  private last: { at: number; gpus: SystemGpuSnapshot[] } | null = null;
  private pending: Promise<SystemGpuSnapshot[]> | null = null;

  constructor(private readonly read: () => Promise<string | null> = () =>
    runMetricCommand("/usr/sbin/ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"])) {}

  async sample(detail: boolean, now: number): Promise<GpuSample> {
    // ioreg is a spawn, so the title bar reads it at half the popover's rate.
    const maxAge = detail ? 900 : 1_900;
    if (!this.last || now - this.last.at >= maxAge) {
      this.pending ??= this.read()
        .then((output) => (output ? parseMacGpus(output) : []))
        .catch(() => [])
        .finally(() => {
          this.pending = null;
        });
      const gpus = await this.pending;
      this.last = { at: now, gpus };
    }
    return {
      gpus: this.last.gpus,
      unavailableReason: this.last.gpus.length === 0 ? "macOS reported no GPU activity counters" : null,
    };
  }

  childPids(): number[] {
    return [];
  }

  stop(): void {}
}

// ── Windows ─────────────────────────────────────────────────────────────────

export const WINDOWS_GPU_COUNTERS = [
  "\\GPU Engine(*)\\Utilization Percentage",
  "\\GPU Adapter Memory(*)\\Dedicated Usage",
] as const;

/**
 * Per adapter (LUID) from one typeperf row. Task Manager's figure per GPU is
 * its busiest engine after summing every process using that engine; a second
 * adapter has its own LUID and must not be added in.
 */
export function parseWindowsGpuAdapters(row: Pick<TypeperfRow, "headers" | "values">): SystemGpuSnapshot[] {
  const engines = new Map<string, Map<string, number>>();
  const memory = new Map<string, number>();
  for (let index = 1; index < row.headers.length; index += 1) {
    const header = row.headers[index];
    const value = typeperfNumber(row.values[index] ?? "");
    if (!Number.isFinite(value)) continue;
    const instance = /\((.*)\)\\[^\\]+$/.exec(header)?.[1] ?? header;
    const luid = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(instance)?.[1]?.toLowerCase() ?? "gpu";
    if (/\\GPU Adapter Memory\(/i.test(header)) {
      memory.set(luid, (memory.get(luid) ?? 0) + value);
      continue;
    }
    if (!/\\GPU Engine\(/i.test(header)) continue;
    const engine = instance.replace(/^pid_[0-9]+_/i, "");
    const adapter = engines.get(luid) ?? new Map<string, number>();
    adapter.set(engine, (adapter.get(engine) ?? 0) + value);
    engines.set(luid, adapter);
  }
  const luids = [...new Set([...engines.keys(), ...memory.keys()])].sort();
  return luids.map((luid, index) => {
    const busiest = Math.max(0, ...(engines.get(luid)?.values() ?? []));
    return gpu({
      id: luid,
      name: luids.length > 1 ? `GPU ${index}` : "GPU",
      vendor: "other",
      utilizationPercent: engines.has(luid) ? clampPercent(busiest) : null,
      memoryUsedBytes: memory.get(luid) ?? null,
    });
  });
}

export class WindowsGpuSampler implements GpuSampler {
  private readonly stream: TypeperfStream;

  constructor(typeperf: string, now: () => number = Date.now) {
    this.stream = new TypeperfStream(typeperf, WINDOWS_GPU_COUNTERS, {
      idleStopMs: STREAM_IDLE_STOP_MS,
      restartEveryMs: TYPEPERF_RESTART_MS,
      now,
    });
  }

  async sample(_detail: boolean, now: number): Promise<GpuSample> {
    this.stream.touch();
    const row = this.stream.latest(TYPEPERF_STALE_MS, now);
    const gpus = row ? parseWindowsGpuAdapters(row) : [];
    return {
      gpus,
      unavailableReason:
        gpus.length > 0
          ? null
          : this.stream.failureMessage
            ? `GPU counters are unavailable: ${this.stream.failureMessage}`
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

export class NoGpuSampler implements GpuSampler {
  async sample(): Promise<GpuSample> {
    return { gpus: [], unavailableReason: "GPU activity is not available on this platform" };
  }

  childPids(): number[] {
    return [];
  }

  stop(): void {}
}
