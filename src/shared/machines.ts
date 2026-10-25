// Machines: the computers agents can run on. This computer, and every SSH
// host Studio knows (manual, ~/.ssh/config, Codara Cloud boxes). Shared by
// main (src/main/remote/machines.ts) and the Settings, Machines page.

import type { HostKeyChange, RemoteConnectionState } from "./remote";
import type { TerminalAgentActivity } from "./agent-board";

/** CLIs the probe looks for on a machine's login PATH. */
export const MACHINE_CLIS = ["claude", "codex", "grok", "pi", "tmux", "git", "node", "docker"] as const;
export type MachineCli = (typeof MACHINE_CLIS)[number];

export interface MachineStats {
  /** `uname -s` lowercased: linux, darwin, freebsd... */
  os: string;
  arch: string | null;
  /** CPUs this machine may use: the cgroup quota when one is set. */
  cpus: number | null;
  /** True when a cgroup limits CPUs below what the host has. */
  cpuLimited: boolean;
  /** Busy share of `cpus` since the previous reading; null on the first one. */
  cpuPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  /** True when a cgroup memory limit is the total. */
  memLimited: boolean;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  load1: number | null;
  clis: MachineCli[];
  readAt: number;
}

/** An agent's tmux session on a machine (remote/remote-agents.ts). */
export interface MachineAgentSession {
  /** `codara-<paneId>`. */
  name: string;
  /** The pane id it was started for, when the name is Studio's own. */
  paneId: string | null;
  createdAt: number | null;
  /** What runs in it now (`claude`, `node`...). */
  command: string | null;
  /** True when a pane in Studio shows it. */
  attached: boolean;
  /**
   * A tmux client is attached although no pane here shows it: Codara on
   * another computer, or someone's own ssh, has it open.
   */
  openElsewhere: boolean;
}

export type MachineKind = "local" | "ssh" | "codara-cloud";

export interface MachineRow {
  /** "local" for this computer, else the SSH host id. */
  id: string;
  kind: MachineKind;
  label: string;
  /** `user@host:port` for SSH machines. */
  address: string | null;
  /** Where the entry came from, for SSH machines. */
  source: "ssh-config" | "manual" | "codara-cloud" | null;
  state: RemoteConnectionState;
  error: string | null;
  /** Set when the host key changed: Studio refuses until the user trusts the new one. */
  hostKeyChange: HostKeyChange | null;
  stats: MachineStats | null;
  /** Agents in Studio panes on this machine, with their live state. */
  agents: TerminalAgentActivity[];
  /** Agent sessions on the machine with no pane showing them. */
  orphanSessions: MachineAgentSession[];
}

export interface MachinesSnapshot {
  machines: MachineRow[];
  readAt: number;
}
