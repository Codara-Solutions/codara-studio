import { promises as fs, constants as fsConstants } from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { delimiter, join } from "node:path";
import type { TerminalAgentActivity } from "@shared/agent-board";
import {
  MACHINE_CLIS,
  type MachineAgentSession,
  type MachineCli,
  type MachineRow,
  type MachinesSnapshot,
  type MachineStats,
} from "@shared/machines";
import { isRemotePath, parseRemotePath, type RemoteConnectionStatus, type RemoteHostConfig } from "@shared/remote";
import type { CpuTimes } from "../system-metrics-linux";
import { buildMachineProbe, machineStatsFrom, parseMachineProbe, type CpuSample } from "./machine-probe";
import { SESSION_STOPPED, buildRemoteAgentSessionKill, remoteAgentSessionName } from "./remote-agents";

// The Machines page: this computer and every SSH host, with size, load, the
// CLIs agents need, and the agents running there. A host is probed only while
// it is connected: listing machines never opens or reopens a connection. Each
// probe is one exec (machine-probe.ts); a reading younger than MIN_PROBE_MS is
// reused so two windows polling do not double the load.

const MIN_PROBE_MS = 4_000;
const PROBE_TIMEOUT_MS = 10_000;
const LOCAL_CLIS_TTL_MS = 60_000;

export interface MachinesDeps {
  listHosts(): Promise<RemoteHostConfig[]>;
  connectionStatus(hostId: string): RemoteConnectionStatus;
  /** Runs a command on a connected host. */
  exec(hostId: string, command: string, timeoutMs: number): Promise<{ stdout: string; code: number | null }>;
  agentActivity(): TerminalAgentActivity[];
  /** Live terminal sessions and their cwd. */
  sessions(): Array<{ id: string; cwd: string | null }>;
  localStats(previous: CpuTimes | null): Promise<{ stats: MachineStats; cpu: CpuTimes }>;
  now(): number;
}

interface HostReading {
  stats: MachineStats;
  sample: CpuSample | null;
  sessions: Omit<MachineAgentSession, "attached" | "paneId">[];
  at: number;
}

export function createMachinesService(deps: MachinesDeps) {
  const readings = new Map<string, HostReading>();
  const inFlight = new Map<string, Promise<HostReading | null>>();
  let localCpu: CpuTimes | null = null;

  const probeHost = (hostId: string): Promise<HostReading | null> => {
    const fresh = readings.get(hostId);
    if (fresh && deps.now() - fresh.at < MIN_PROBE_MS) return Promise.resolve(fresh);
    const running = inFlight.get(hostId);
    if (running) return running;
    const run = (async () => {
      try {
        const { stdout } = await deps.exec(hostId, buildMachineProbe(), PROBE_TIMEOUT_MS);
        const reading = parseMachineProbe(stdout);
        if (!reading.complete) return readings.get(hostId) ?? null;
        const now = deps.now();
        const previous = readings.get(hostId);
        const next: HostReading = {
          stats: machineStatsFrom(reading, previous ? { sample: previous.sample, at: previous.at } : null, now),
          sample: reading.cpuSample,
          sessions: reading.sessions,
          at: now,
        };
        readings.set(hostId, next);
        return next;
      } catch {
        return readings.get(hostId) ?? null;
      } finally {
        inFlight.delete(hostId);
      }
    })();
    inFlight.set(hostId, run);
    return run;
  };

  async function snapshot(): Promise<MachinesSnapshot> {
    const hosts = await deps.listHosts();
    const activity = deps.agentActivity();
    const sessions = deps.sessions();
    const cwdById = new Map(sessions.map((s) => [s.id, s.cwd]));
    const hostOf = (paneId: string): string | null => {
      const cwd = cwdById.get(paneId) ?? null;
      if (!cwd || !isRemotePath(cwd)) return null;
      return parseRemotePath(cwd)?.hostId ?? null;
    };

    const local = await deps.localStats(localCpu);
    localCpu = local.cpu;
    const rows: MachineRow[] = [
      {
        id: "local",
        kind: "local",
        label: "This computer",
        address: null,
        source: null,
        state: "connected",
        error: null,
        hostKeyChange: null,
        stats: local.stats,
        agents: activity.filter((a) => cwdById.has(a.paneId) && hostOf(a.paneId) === null),
        orphanSessions: [],
      },
    ];

    const known = new Set(hosts.map((h) => h.id));
    for (const hostId of [...readings.keys()]) if (!known.has(hostId)) readings.delete(hostId);

    const hostRows = await Promise.all(
      hosts.map(async (host): Promise<MachineRow> => {
        const status = deps.connectionStatus(host.id);
        const reading = status.state === "connected" ? await probeHost(host.id) : null;
        if (status.state !== "connected") readings.delete(host.id);
        // Sessions of this host's live panes, by the tmux name each would use.
        const paneBySession = new Map<string, string>();
        for (const s of sessions) {
          if (s.cwd && hostOf(s.id) === host.id) paneBySession.set(remoteAgentSessionName(s.id), s.id);
        }
        return {
          id: host.id,
          kind: host.source === "codara-cloud" ? "codara-cloud" : "ssh",
          label: host.id,
          address: `${host.username}@${host.host}:${host.port}`,
          source: host.source,
          state: status.state,
          error: status.error ?? null,
          hostKeyChange: status.hostKeyChange ?? null,
          stats: reading?.stats ?? null,
          agents: activity.filter((a) => hostOf(a.paneId) === host.id),
          orphanSessions: (reading?.sessions ?? [])
            .filter((session) => !paneBySession.has(session.name))
            .map((session) => ({ ...session, paneId: null, attached: false })),
        };
      }),
    );
    rows.push(...hostRows);
    return { machines: rows, readAt: deps.now() };
  }

  /**
   * Ends an agent session no pane on this computer shows (one the user closed
   * while offline), never one another computer has open.
   */
  async function stopSession(hostId: string, sessionName: string): Promise<boolean> {
    const command = buildRemoteAgentSessionKill(sessionName);
    if (!command || deps.connectionStatus(hostId).state !== "connected") return false;
    const attached = deps.sessions().some((s) => {
      const parts = s.cwd && isRemotePath(s.cwd) ? parseRemotePath(s.cwd) : null;
      return parts?.hostId === hostId && remoteAgentSessionName(s.id) === sessionName;
    });
    // A session a pane still shows is ended by closing that pane.
    if (attached) return false;
    if (readings.get(hostId)?.sessions.some((s) => s.name === sessionName && s.openElsewhere)) return false;
    const result = await deps.exec(hostId, command, PROBE_TIMEOUT_MS);
    readings.delete(hostId);
    return result.stdout.includes(SESSION_STOPPED);
  }

  return { snapshot, stopSession };
}

export type MachinesService = ReturnType<typeof createMachinesService>;

// ── This computer ────────────────────────────────────────────────────────────

let localClis: { at: number; clis: MachineCli[] } | null = null;

/** Agent CLIs on this process's PATH, the one local panes inherit. */
async function findLocalClis(now: number): Promise<MachineCli[]> {
  if (localClis && now - localClis.at < LOCAL_CLIS_TTL_MS) return localClis.clis;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const found: MachineCli[] = [];
  for (const cli of MACHINE_CLIS) {
    let present = false;
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        try {
          await fs.access(join(dir, cli + suffix), fsConstants.X_OK);
          present = true;
          break;
        } catch {
          /* not here */
        }
      }
      if (present) break;
    }
    if (present) found.push(cli);
  }
  localClis = { at: now, clis: found };
  return found;
}

export async function readLocalStats(
  previous: CpuTimes | null,
  readCpu: () => CpuTimes,
): Promise<{ stats: MachineStats; cpu: CpuTimes }> {
  const now = Date.now();
  const cpu = readCpu();
  let cpuPercent: number | null = null;
  if (previous) {
    const total = cpu.total - previous.total;
    const idle = cpu.idle - previous.idle;
    if (total > 0 && idle >= 0) cpuPercent = Math.round(((total - idle) / total) * 100);
  }
  let diskTotalBytes: number | null = null;
  let diskFreeBytes: number | null = null;
  try {
    const disk = await fs.statfs(homedir());
    diskTotalBytes = disk.blocks * disk.bsize;
    diskFreeBytes = disk.bavail * disk.bsize;
  } catch {
    /* statfs is missing on old Node builds and some filesystems */
  }
  const total = totalmem();
  return {
    cpu,
    stats: {
      os: process.platform,
      arch: process.arch,
      cpus: cpus().length || null,
      cpuLimited: false,
      cpuPercent,
      memTotalBytes: total,
      memUsedBytes: Math.max(0, total - freemem()),
      memLimited: false,
      diskTotalBytes,
      diskFreeBytes,
      load1: process.platform === "win32" ? null : (loadavg()[0] ?? null),
      clis: await findLocalClis(now),
      readAt: now,
    },
  };
}
