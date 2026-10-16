import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Readers and parsers for Linux's /proc and /sys. Everything here is a small
// pseudo-file read synchronously into one reused buffer: an async read costs
// a thread-pool round trip per file, which measured about ten times the CPU
// of the read itself when scanning ~900 processes (5 ms sync, 50 ms async).

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
let readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

/**
 * A one-line /proc file with a single read: procfs hands back a whole
 * record per read, and skipping the read that would return EOF halves the
 * syscalls of a process scan.
 */
export function readProcLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const read = readSync(fd, readBuffer, 0, readBuffer.length, null);
    return read > 0 ? readBuffer.toString("latin1", 0, read) : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/** The whole file as latin1 text, or null when it cannot be read. */
export function readSmallFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let length = 0;
    for (;;) {
      if (length === readBuffer.length) {
        if (readBuffer.length >= MAX_FILE_BYTES) return null;
        const grown = Buffer.allocUnsafe(readBuffer.length * 2);
        readBuffer.copy(grown, 0, 0, length);
        readBuffer = grown;
      }
      const read = readSync(fd, readBuffer, length, readBuffer.length - length, null);
      if (read <= 0) break;
      length += read;
    }
    return readBuffer.toString("latin1", 0, length);
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

export interface CpuTimes {
  idle: number;
  total: number;
}

/**
 * /proc/stat's aggregate and per-core lines. iowait counts as idle, as in
 * htop: the core is free to run other work while a task waits on a disk.
 * guest and guest_nice are already inside user and nice.
 */
export function parseProcStatCpu(text: string): { total: CpuTimes; cores: CpuTimes[] } | null {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) {
      if (total) break;
      continue;
    }
    const fields = line.trim().split(/\s+/);
    const values = fields.slice(1, 9).map(Number);
    if (values.length < 4 || values.some((value) => !Number.isFinite(value))) continue;
    const idle = values[3] + (values[4] ?? 0);
    const times = { idle, total: values.reduce((sum, value) => sum + value, 0) };
    if (fields[0] === "cpu") total = times;
    else cores.push(times);
  }
  return total ? { total, cores } : null;
}

export interface LinuxMemory {
  totalBytes: number;
  availableBytes: number;
  freeBytes: number;
  /** Buffers, page cache and reclaimable slab: `free`'s buff/cache. */
  cacheBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export function parseMeminfo(text: string): LinuxMemory | null {
  const fields = new Map<string, number>();
  for (const match of text.matchAll(/^(\w+(?:\(\w+\))?):\s+(\d+)(?: kB)?$/gm)) {
    fields.set(match[1], Number(match[2]) * 1024);
  }
  const total = fields.get("MemTotal");
  const free = fields.get("MemFree");
  if (total === undefined || free === undefined) return null;
  const cacheBytes =
    (fields.get("Buffers") ?? 0) + (fields.get("Cached") ?? 0) + (fields.get("SReclaimable") ?? 0);
  return {
    totalBytes: total,
    // Kernels before 3.14 have no MemAvailable.
    availableBytes: Math.min(total, fields.get("MemAvailable") ?? free + cacheBytes),
    freeBytes: free,
    cacheBytes,
    swapTotalBytes: fields.get("SwapTotal") ?? 0,
    swapFreeBytes: fields.get("SwapFree") ?? 0,
  };
}

export interface PressureLine {
  avg10: number;
  /** Microseconds stalled since boot. */
  total: number;
}

/** /proc/pressure/{memory,cpu,io}: "some" and, except for cpu on old kernels, "full". */
export function parsePressure(text: string): { some: PressureLine; full: PressureLine | null } | null {
  const line = (kind: string): PressureLine | null => {
    const match = new RegExp(`^${kind} avg10=([0-9.]+) avg60=[0-9.]+ avg300=[0-9.]+ total=(\\d+)`, "m").exec(
      text,
    );
    return match ? { avg10: Number(match[1]), total: Number(match[2]) } : null;
  };
  const some = line("some");
  return some ? { some, full: line("full") } : null;
}

/** Pages swapped in and out since boot, from /proc/vmstat. */
export function parseVmstatSwap(text: string): { swapInPages: number; swapOutPages: number } | null {
  const swapIn = /^pswpin (\d+)$/m.exec(text)?.[1];
  const swapOut = /^pswpout (\d+)$/m.exec(text)?.[1];
  if (swapIn === undefined || swapOut === undefined) return null;
  return { swapInPages: Number(swapIn), swapOutPages: Number(swapOut) };
}

/**
 * Bytes read and written since boot by the given block devices. diskstats
 * counts in 512-byte sectors whatever the device's real sector size.
 */
export function parseDiskstats(
  text: string,
  devices: ReadonlySet<string>,
): { readBytes: number; writeBytes: number } | null {
  let readBytes = 0;
  let writeBytes = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !devices.has(fields[2])) continue;
    readBytes += Number(fields[5]) * 512;
    writeBytes += Number(fields[9]) * 512;
    seen = true;
  }
  return seen ? { readBytes, writeBytes } : null;
}

/** Bytes received and sent since boot by the given interfaces, from /proc/net/dev. */
export function parseNetDev(
  text: string,
  interfaces: ReadonlySet<string>,
): { receiveBytes: number; sendBytes: number } | null {
  let receiveBytes = 0;
  let sendBytes = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (!interfaces.has(line.slice(0, colon).trim())) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    if (fields.length < 9) continue;
    receiveBytes += Number(fields[0]);
    sendBytes += Number(fields[8]);
    seen = true;
  }
  return seen ? { receiveBytes, sendBytes } : null;
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Physical disks and network interfaces: the ones backed by a device. Loop,
 * zram, device-mapper and RAID members' upper layers, bridges, veths and
 * tunnels have none, and counting them would count the same bytes twice.
 */
export function physicalBlockDevices(sysRoot = "/sys"): Set<string> {
  const base = join(sysRoot, "block");
  return new Set(listDir(base).filter((name) => existsSync(join(base, name, "device"))));
}

export function physicalNetworkInterfaces(sysRoot = "/sys"): Set<string> {
  const base = join(sysRoot, "class", "net");
  return new Set(listDir(base).filter((name) => existsSync(join(base, name, "device"))));
}

/**
 * The file holding the CPU package temperature in millidegrees: coretemp's
 * "Package id 0" on Intel, k10temp's Tdie (else Tctl) on AMD, then a thermal
 * zone that names the package. Found once; the sensors do not move.
 */
export function findCpuTemperatureFile(sysRoot = "/sys"): string | null {
  const hwmonBase = join(sysRoot, "class", "hwmon");
  const ranked: Array<{ path: string; rank: number }> = [];
  for (const entry of listDir(hwmonBase)) {
    const dir = join(hwmonBase, entry);
    const name = readSmallFile(join(dir, "name"))?.trim();
    if (!name) continue;
    if (!["coretemp", "k10temp", "zenpower", "cpu_thermal", "soc_thermal"].includes(name)) continue;
    for (const file of listDir(dir)) {
      const match = /^temp(\d+)_input$/.exec(file);
      if (!match) continue;
      const label = readSmallFile(join(dir, `temp${match[1]}_label`))?.trim() ?? "";
      const rank =
        /^Package id 0$/i.test(label) || /^Tdie$/i.test(label)
          ? 0
          : /^Tctl$/i.test(label)
            ? 1
            : name.endsWith("_thermal") && match[1] === "1"
              ? 2
              : -1;
      if (rank >= 0) ranked.push({ path: join(dir, file), rank });
    }
  }
  ranked.sort((left, right) => left.rank - right.rank);
  if (ranked[0]) return ranked[0].path;
  const zoneBase = join(sysRoot, "class", "thermal");
  for (const entry of listDir(zoneBase)) {
    const type = readSmallFile(join(zoneBase, entry, "type"))?.trim() ?? "";
    if (/^(x86_pkg_temp|cpu[-_]thermal|TCPU)$/i.test(type)) return join(zoneBase, entry, "temp");
  }
  return null;
}

/** A millidegree sysfs reading in whole degrees, or null outside a sane range. */
export function readMillidegrees(path: string | null): number | null {
  if (!path) return null;
  const value = Number(readSmallFile(path)?.trim());
  if (!Number.isFinite(value)) return null;
  const celsius = Math.round(value / 1000);
  return celsius > -40 && celsius < 150 ? celsius : null;
}
