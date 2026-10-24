import { MACHINE_CLIS, type MachineAgentSession, type MachineCli, type MachineStats } from "@shared/machines";
import { parseMacVmStat } from "../system-metrics";
import { parseMeminfo, parseProcStatCpu, type CpuTimes } from "../system-metrics-linux";
import { REMOTE_TMUX_SOCKET } from "./remote-agents";

// One exec reads a machine's size and load: CPU, memory, disk, load, which
// agent CLIs are on the login PATH, and the agent sessions of Studio's tmux
// server. Sections are marked so a login profile that prints text cannot be
// mistaken for a reading.
//
// Inside a container /proc describes the host, not the container: a box
// limited to 1 CPU and 1 GiB reads 24 CPUs and 31 GiB there. cgroup v2's
// cpu.max and memory.max hold the real limits, so they win when set. The root
// cgroup has neither file, so a plain host reads /proc as before.

const MARK = "@@codara-probe:";

const SCRIPT = [
  `echo "${MARK}os $(uname -s 2>/dev/null) $(uname -m 2>/dev/null)"`,
  `echo "${MARK}nproc $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"`,
  `if [ -r /proc/stat ]; then echo "${MARK}stat"; head -n 1 /proc/stat; fi`,
  `if [ -r /proc/meminfo ]; then echo "${MARK}meminfo"; cat /proc/meminfo; fi`,
  `if [ -r /proc/loadavg ]; then echo "${MARK}loadavg $(cat /proc/loadavg)"; else echo "${MARK}loadavg $(sysctl -n vm.loadavg 2>/dev/null | tr -d "{}")"; fi`,
  `for f in cpu.max memory.max memory.current memory.stat cpu.stat; do if [ -r "/sys/fs/cgroup/$f" ]; then echo "${MARK}cgroup $f"; cat "/sys/fs/cgroup/$f"; fi; done`,
  `if [ "$(uname -s)" = Darwin ]; then echo "${MARK}memsize $(sysctl -n hw.memsize 2>/dev/null)"; echo "${MARK}vmstat"; vm_stat 2>/dev/null; echo "${MARK}pscpu $(ps -A -o %cpu= 2>/dev/null | awk '{s+=$1} END {print s+0}')"; fi`,
  `echo "${MARK}df"; df -Pk "$HOME" 2>/dev/null | tail -n 1`,
  `echo "${MARK}clis$(for c in ${MACHINE_CLIS.join(" ")}; do command -v "$c" >/dev/null 2>&1 && printf " %s" "$c"; done)"`,
  `echo "${MARK}tmux"; tmux -L ${REMOTE_TMUX_SOCKET} list-sessions -F "#{session_name} #{session_created} #{pane_current_command}" 2>/dev/null`,
  `echo "${MARK}end"`,
].join("; ");

/** The command a connection runs: a login shell, so PATH is the one agents get. */
export function buildMachineProbe(): string {
  return `sh -lc '${SCRIPT.replace(/'/g, "'\\''")}'`;
}

/** What one probe read, before the CPU share (which needs two readings). */
export interface MachineProbeReading {
  os: string;
  arch: string | null;
  hostCpus: number | null;
  /** CPUs from cpu.max, when a quota is set. */
  quotaCpus: number | null;
  /** /proc/stat totals, or cgroup usage when a quota is set. */
  cpuSample: CpuSample | null;
  /** ps' summed %cpu on macOS, already a share of one CPU per CPU. */
  psCpuPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  memLimited: boolean;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  load1: number | null;
  clis: MachineCli[];
  sessions: Omit<MachineAgentSession, "attached" | "paneId">[];
  /** False when the probe's last line never arrived (cut short). */
  complete: boolean;
}

export type CpuSample = { kind: "proc"; times: CpuTimes } | { kind: "cgroup"; usageUsec: number };

export function parseMachineProbe(output: string): MachineProbeReading {
  const sections = new Map<string, { arg: string; body: string[] }>();
  let current: { arg: string; body: string[] } | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const at = line.indexOf(MARK);
    if (at >= 0) {
      const rest = line.slice(at + MARK.length);
      const space = rest.indexOf(" ");
      const name = space < 0 ? rest : rest.slice(0, space);
      const arg = space < 0 ? "" : rest.slice(space + 1).trim();
      // cgroup files share one marker name; key them by file.
      const key = name === "cgroup" ? `cgroup ${arg}` : name;
      current = { arg, body: [] };
      sections.set(key, current);
      continue;
    }
    current?.body.push(line);
  }
  const arg = (name: string) => sections.get(name)?.arg ?? "";
  const body = (name: string) => sections.get(name)?.body.join("\n") ?? null;
  const num = (value: string | undefined | null): number | null => {
    if (value === undefined || value === null || value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const [osName = "", arch] = arg("os").split(/\s+/);
  const os = osName.toLowerCase() || "unknown";
  const hostCpus = num(arg("nproc"));

  const quotaCpus = parseCpuMax(body("cgroup cpu.max"));
  const memMax = parseCgroupNumber(body("cgroup memory.max"));
  const memCurrent = parseCgroupNumber(body("cgroup memory.current"));
  const cgroupUsage = parseCgroupCpuUsage(body("cgroup cpu.stat"));

  let cpuSample: CpuSample | null = null;
  if (quotaCpus !== null && cgroupUsage !== null) cpuSample = { kind: "cgroup", usageUsec: cgroupUsage };
  else {
    const stat = body("stat");
    const parsed = stat ? parseProcStatCpu(stat) : null;
    if (parsed) cpuSample = { kind: "proc", times: parsed.total };
  }

  let memTotalBytes: number | null = null;
  let memUsedBytes: number | null = null;
  const meminfoText = body("meminfo");
  const meminfo = meminfoText ? parseMeminfo(meminfoText) : null;
  if (meminfo) {
    memTotalBytes = meminfo.totalBytes;
    memUsedBytes = meminfo.totalBytes - meminfo.availableBytes;
  } else if (os === "darwin") {
    memTotalBytes = num(arg("memsize"));
    memUsedBytes = parseMacVmStat(body("vmstat") ?? "")?.usedBytes ?? null;
  }
  // A limit above the host's memory is no limit.
  const memLimited = memMax !== null && (memTotalBytes === null || memMax < memTotalBytes);
  if (memLimited && memMax !== null) {
    memTotalBytes = memMax;
    // Page cache the kernel can drop counts in memory.current; leave it out
    // the way MemAvailable does.
    const inactiveFile = parseMemoryStatField(body("cgroup memory.stat"), "inactive_file") ?? 0;
    memUsedBytes = memCurrent === null ? null : Math.max(0, memCurrent - inactiveFile);
  }

  const df = (body("df") ?? "").trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const diskTotalBytes = df.length >= 6 ? kib(num(df[1])) : null;
  const diskFreeBytes = df.length >= 6 ? kib(num(df[3])) : null;

  const load1 = num(arg("loadavg").split(/\s+/)[0]);

  const clis = arg("clis")
    .split(/\s+/)
    .filter((name): name is MachineCli => (MACHINE_CLIS as readonly string[]).includes(name));

  const sessions: Omit<MachineAgentSession, "attached" | "paneId">[] = [];
  for (const line of sections.get("tmux")?.body ?? []) {
    const [name, created, ...command] = line.trim().split(/\s+/);
    if (!name?.startsWith("codara-")) continue;
    const createdSec = num(created);
    sessions.push({
      name,
      createdAt: createdSec === null ? null : createdSec * 1000,
      command: command.join(" ") || null,
    });
  }

  return {
    os,
    arch: arch || null,
    hostCpus,
    quotaCpus,
    cpuSample,
    psCpuPercent: os === "darwin" ? num(arg("pscpu")) : null,
    memTotalBytes,
    memUsedBytes,
    memLimited,
    diskTotalBytes,
    diskFreeBytes,
    load1,
    clis,
    sessions,
    complete: sections.has("end"),
  };
}

/**
 * The stats a row shows. CPU share comes from the change since the previous
 * reading of the same machine; ps' figure on macOS stands alone.
 */
export function machineStatsFrom(
  reading: MachineProbeReading,
  previous: { sample: CpuSample | null; at: number } | null,
  now: number,
): MachineStats {
  const effectiveCpus =
    reading.quotaCpus !== null
      ? Math.min(reading.quotaCpus, reading.hostCpus ?? reading.quotaCpus)
      : reading.hostCpus;
  let cpuPercent: number | null = null;
  const sample = reading.cpuSample;
  const prior = previous?.sample;
  if (sample && prior && sample.kind === prior.kind) {
    if (sample.kind === "proc" && prior.kind === "proc") {
      const total = sample.times.total - prior.times.total;
      const idle = sample.times.idle - prior.times.idle;
      if (total > 0 && idle >= 0) cpuPercent = ((total - idle) / total) * 100;
    } else if (sample.kind === "cgroup" && prior.kind === "cgroup" && previous && effectiveCpus) {
      const wallUsec = (now - previous.at) * 1000;
      const used = sample.usageUsec - prior.usageUsec;
      if (wallUsec > 0 && used >= 0) cpuPercent = (used / (wallUsec * effectiveCpus)) * 100;
    }
  } else if (reading.psCpuPercent !== null && effectiveCpus) {
    cpuPercent = reading.psCpuPercent / effectiveCpus;
  }
  return {
    os: reading.os,
    arch: reading.arch,
    cpus: effectiveCpus,
    cpuLimited: reading.quotaCpus !== null && (reading.hostCpus === null || reading.quotaCpus < reading.hostCpus),
    cpuPercent: cpuPercent === null ? null : Math.max(0, Math.min(100, Math.round(cpuPercent))),
    memTotalBytes: reading.memTotalBytes,
    memUsedBytes: reading.memUsedBytes,
    memLimited: reading.memLimited,
    diskTotalBytes: reading.diskTotalBytes,
    diskFreeBytes: reading.diskFreeBytes,
    load1: reading.load1,
    clis: reading.clis,
    readAt: now,
  };
}

function kib(value: number | null): number | null {
  return value === null ? null : value * 1024;
}

/** `max 100000` or `200000 100000`: quota and period in microseconds. */
function parseCpuMax(text: string | null): number | null {
  const [quota, period] = (text ?? "").trim().split(/\s+/);
  const q = Number(quota);
  const p = Number(period);
  if (!quota || quota === "max" || !Number.isFinite(q) || !Number.isFinite(p) || p <= 0) return null;
  return Math.round((q / p) * 100) / 100;
}

function parseCgroupNumber(text: string | null): number | null {
  const value = (text ?? "").trim();
  if (!value || value === "max") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCgroupCpuUsage(text: string | null): number | null {
  return parseMemoryStatField(text, "usage_usec");
}

function parseMemoryStatField(text: string | null, field: string): number | null {
  const match = new RegExp(`^${field}\\s+(\\d+)$`, "m").exec(text ?? "");
  return match ? Number(match[1]) : null;
}
