import type {
  NavigationTarget,
  SystemAppUsage,
  SystemProcessGroup,
  SystemProcessSnapshot,
  SystemResource,
  Workspace,
} from "@shared/types";
import { collectLeaves } from "../../tabs/paneTree";
import { visibleWorkerChip } from "../../tabs/terminalAgentState";
import type { Tab } from "../../tabs/types";
import { runtimeLabel } from "../../routing/agent-destinations";

// The System activity popover's model: one ranked list of who is using the
// machine, each row named by its agent and workspace, and how each resource
// reads. Pure functions of plain data, so scripts/test-system-activity-model.cjs
// runs them without React.

export { HISTORY_WINDOW_MS, seriesOf, type HistoryPoint, type SeriesPoint } from "./history";

export const RESOURCES: readonly SystemResource[] = ["cpu", "memory", "gpu", "swap"];

export const RESOURCE_LABELS: Record<SystemResource, string> = {
  cpu: "CPU",
  memory: "RAM",
  gpu: "GPU",
  swap: "Swap",
};

// Figures are binary multiples labelled GB/MB, as the title bar always has.
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number | null | undefined): string {
  return bytesPerSecond === null || bytesPerSecond === undefined ? "n/a" : `${formatBytes(bytesPerSecond)}/s`;
}

/** Whole numbers from 10 up; one decimal below, where a quiet process lives. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value >= 9.95 || value === 0 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

/**
 * Percent of the whole machine, the scale of the CPU headline. The sampler
 * counts 100% per core and windows can overlap, so a share is capped at all of it.
 */
export function cpuShare(cpuPercent: number, cores: number): number {
  return Math.min(100, cpuPercent / Math.max(1, cores));
}

export function formatShare(share: number | null | undefined): string {
  if (share !== null && share !== undefined && share > 0 && share < 0.05) return "<0.1%";
  return formatPercent(share);
}

type Measured = Pick<SystemProcessGroup, "cpuPercent" | "memoryBytes" | "gpuMemoryBytes" | "swapBytes">;

/** A row's figure for one resource: CPU in percent of one core, the rest in bytes. */
export function valueOf(entry: Measured, resource: SystemResource): number | null {
  if (resource === "cpu") return entry.cpuPercent;
  if (resource === "memory") return entry.memoryBytes;
  if (resource === "gpu") return entry.gpuMemoryBytes;
  return entry.swapBytes;
}

/** A row's figure as shown: CPU as a share of the machine, the rest in bytes. */
export function formatValue(entry: Measured, resource: SystemResource, cores: number): string {
  if (resource === "cpu") return formatShare(cpuShare(entry.cpuPercent, cores));
  return formatBytes(valueOf(entry, resource));
}

export interface PaneOwner {
  workspaceId: string;
  workspaceName: string;
  workspaceColor: string | null;
  tabId: string;
  /** Where the pane sits: "terminals", "terminals pane 2". */
  place: string;
  /** A Cora worker's task title. */
  task: string | null;
  runtime: string | null;
}

export interface OwnerLayout {
  workspaceId: string;
  tabs: readonly Tab[];
}

/**
 * Every terminal pane the window knows, active and parked workspaces alike.
 * Overlays (a temporary terminal covering a pane) count as their host pane.
 */
export function paneOwnerIndex(
  workspaces: readonly Pick<Workspace, "id" | "name" | "color">[],
  layouts: readonly OwnerLayout[],
  overlays: ReadonlyMap<string, { paneId: string; hostPaneId: string }> = new Map(),
): Map<string, PaneOwner> {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const index = new Map<string, PaneOwner>();
  for (const layout of layouts) {
    const workspace = byId.get(layout.workspaceId);
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal") continue;
      const cells = collectLeaves(tab.root).filter((leaf) => leaf.content?.type !== "tab");
      cells.forEach((leaf, position) => {
        const chip = visibleWorkerChip(leaf.worker);
        const title = tab.title || "Terminal";
        index.set(leaf.paneId, {
          workspaceId: layout.workspaceId,
          workspaceName: workspace?.name ?? "Workspace",
          workspaceColor: workspace?.color ?? null,
          tabId: tab.id,
          place: cells.length > 1 ? `${title} pane ${position + 1}` : title,
          task: chip?.source === "spark" ? (chip.title ?? null) : null,
          runtime: chip?.runtime ?? (leaf.agentSession?.active ? leaf.agentSession.runtime : null) ?? null,
        });
      });
    }
  }
  for (const [hostPaneId, overlay] of overlays) {
    const host = index.get(hostPaneId);
    if (host && !index.has(overlay.paneId)) index.set(overlay.paneId, host);
  }
  return index;
}

type WorkspaceRef = Pick<Workspace, "id" | "name" | "color"> & Partial<Pick<Workspace, "cwd">>;

export interface GroupView {
  key: string;
  kind: SystemProcessGroup["owner"];
  /** "Claude Code · codara-studio"; "Codara"; "Other apps". What a closed pane left is named by rowName. */
  name: string;
  /** The workspace the row belongs to. */
  workspace: string | null;
  /** Where in the workspace; what names an idle pane. */
  place: string | null;
  /** What the agent was asked, kept for the row's detail: it is not a name. */
  note: string | null;
  color: string | null;
  runtime: string | null;
  /** Where a click goes; null for Codara itself, other apps and closed panes. */
  target: NavigationTarget | null;
  group: SystemProcessGroup;
}

function oneLine(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? line : null;
}

/** The workspace whose folder holds this one; the deepest wins, so a worktree beats its parent. */
export function workspaceOfFolder<T extends WorkspaceRef>(folder: string | null, workspaces: readonly T[]): T | null {
  if (!folder) return null;
  let best: T | null = null;
  for (const workspace of workspaces) {
    const root = workspace.cwd?.replace(/\/+$/, "");
    if (!root || (folder !== root && !folder.startsWith(`${root}/`))) continue;
    if (!best || root.length > (best.cwd?.length ?? 0)) best = workspace;
  }
  return best;
}

export function describeGroup(
  group: SystemProcessGroup,
  panes: ReadonlyMap<string, PaneOwner>,
  workspaces: readonly WorkspaceRef[],
): GroupView {
  const key = group.paneId ? `${group.owner}:${group.paneId}` : group.owner;
  const base = { key, group, workspace: null, place: null, note: null, color: null, runtime: null, target: null };
  if (group.owner === "codara") return { ...base, kind: "codara", name: "Codara" };
  if (group.owner === "left-running") {
    const workspace = workspaceOfFolder(group.cwd, workspaces);
    return {
      ...base,
      kind: "left-running",
      name: "Left running",
      workspace: workspace?.name ?? null,
      color: workspace?.color ?? null,
      runtime: group.runtime,
    };
  }
  if (group.owner === "outside" || !group.paneId) return { ...base, kind: "outside", name: "Other apps" };
  const known = panes.get(group.paneId);
  const runtime = group.runtime ?? known?.runtime ?? null;
  const workspace = known
    ? { name: known.workspaceName, color: known.workspaceColor }
    : (() => {
        const entry = group.workspaceId ? workspaces.find((candidate) => candidate.id === group.workspaceId) : undefined;
        return entry ? { name: entry.name, color: entry.color ?? null } : null;
      })();
  const server = group.serverId ? `Dev server ${group.serverId}` : null;
  const owner = runtimeLabel(runtime) ?? (server ? "Dev server" : "Terminal");
  const task = oneLine(known?.task);
  const prompt = oneLine(group.task);
  const workspaceId = known?.workspaceId ?? group.workspaceId;
  const tabId = known?.tabId ?? group.tabId;
  return {
    key,
    kind: "pane",
    name: workspace ? `${owner} · ${workspace.name}` : owner,
    workspace: workspace?.name ?? null,
    place: known?.place ?? server,
    note: task ? `Task: ${task}` : prompt ? `Last prompt: ${prompt}` : null,
    color: workspace?.color ?? null,
    runtime,
    target:
      workspaceId && tabId
        ? { type: "terminal", workspaceId, tabId, paneId: group.paneId }
        : workspaceId
          ? { type: "workspace", workspaceId }
          : null,
    group,
  };
}

// Video memory and swap list only what holds some.
const MIN_LISTED_BYTES = 1024 * 1024;
// A pane under 1% of one core is sitting idle; a shell's prompt costs that.
const IDLE_CPU_PERCENT = 1;
// A closed pane can leave a shell or a clipboard helper holding a few MB:
// worth a count, not a row of its own.
const MIN_LEFT_RUNNING_BYTES = 64 * 1024 * 1024;

/**
 * Everything by one resource, heaviest first in a single list: what counts is
 * what is heavy, not whether it is an agent. Idle rows fold away but stay
 * findable. While CPU has no reading yet nothing can be called idle.
 */
export function rankedRows(
  views: readonly GroupView[],
  resource: SystemResource,
  cpuMeasured = true,
): { busy: GroupView[]; idle: GroupView[] } {
  const value = (view: GroupView) => valueOf(view.group, resource) ?? 0;
  const ranked = [...views].sort(
    (left, right) => value(right) - value(left) || left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
  );
  if (resource === "cpu") {
    if (!cpuMeasured) return { busy: ranked, idle: [] };
    return {
      busy: ranked.filter((view) => value(view) >= IDLE_CPU_PERCENT),
      idle: ranked.filter((view) => value(view) < IDLE_CPU_PERCENT),
    };
  }
  if (resource === "memory") {
    const small = (view: GroupView) => view.kind === "left-running" && value(view) < MIN_LEFT_RUNNING_BYTES;
    return { busy: ranked.filter((view) => !small(view)), idle: ranked.filter(small) };
  }
  return { busy: ranked.filter((view) => value(view) >= MIN_LISTED_BYTES), idle: [] };
}

export function idleLabel(idle: readonly GroupView[]): string {
  const panes = idle.every((view) => view.kind === "pane");
  return `${idle.length} ${panes ? `idle pane${idle.length === 1 ? "" : "s"}` : "idle"}`;
}

/** Over half the machine on one row. */
const ALARM_SHARE = 50;
/** A full core nobody is watching. */
const ALARM_LEFT_RUNNING_CPU = 100;

/** CPU only: memory has its own warning, and the other two are not spent the same way. */
export function isAlarm(view: GroupView, resource: SystemResource, cores: number): boolean {
  if (resource !== "cpu") return false;
  const cpu = view.group.cpuPercent;
  return cpuShare(cpu, cores) >= ALARM_SHARE || (view.kind === "left-running" && cpu >= ALARM_LEFT_RUNNING_CPU);
}

/** "sh ×24" */
export function programLabel(app: Pick<SystemAppUsage, "name" | "processCount">): string {
  return app.processCount > 1 ? `${app.name} ×${app.processCount}` : app.name;
}

/** What a closed pane left is known by what it is. */
export function rowName(view: GroupView, resource: SystemResource): string {
  if (view.kind !== "left-running") return view.name;
  const heaviest = topApps(view.group, resource, 1)[0] ?? view.group.apps[0];
  return heaviest ? `${programLabel(heaviest)} left running` : view.name;
}

const WHERE_PROGRAMS = 3;

/** The row's second line: what is heavy in it, or for a closed pane who it came from. */
export function rowWhere(view: GroupView, resource: SystemResource): string {
  if (view.kind === "left-running") {
    return [runtimeLabel(view.runtime), view.workspace, "no open terminal"].filter(Boolean).join(" · ");
  }
  const count = view.group.processCount;
  const processes = `${count} process${count === 1 ? "" : "es"}`;
  if (view.kind === "codara") return processes;
  const programs = topApps(view.group, resource, WHERE_PROGRAMS).map(programLabel).join(", ");
  return programs || (view.kind === "outside" ? processes : (view.place ?? "Codara terminal"));
}

/** A group's heaviest processes for one resource. */
export function topProcesses(
  group: SystemProcessGroup,
  resource: SystemResource,
  count: number,
): SystemProcessSnapshot[] {
  return [...group.processes]
    .filter((entry) => resource === "cpu" || resource === "memory" || (valueOf(entry, resource) ?? 0) > 0)
    .sort((left, right) => (valueOf(right, resource) ?? 0) - (valueOf(left, resource) ?? 0))
    .slice(0, count);
}

/** Other apps' heaviest programs for one resource. */
export function topApps(group: SystemProcessGroup, resource: SystemResource, count: number): SystemAppUsage[] {
  return [...group.apps]
    .filter((app) => (valueOf(app, resource) ?? 0) > 0)
    .sort((left, right) => (valueOf(right, resource) ?? 0) - (valueOf(left, resource) ?? 0))
    .slice(0, count);
}
