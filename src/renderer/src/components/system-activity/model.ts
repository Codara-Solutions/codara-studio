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

// The System activity popover's model: one row per pane with everything
// running under it, named the way the user knows it, and how each resource
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

type Measured = Pick<SystemProcessGroup, "cpuPercent" | "memoryBytes" | "gpuMemoryBytes" | "swapBytes">;

/** A row's figure for one resource: CPU in percent of one core, the rest in bytes. */
export function valueOf(entry: Measured, resource: SystemResource): number | null {
  if (resource === "cpu") return entry.cpuPercent;
  if (resource === "memory") return entry.memoryBytes;
  if (resource === "gpu") return entry.gpuMemoryBytes;
  return entry.swapBytes;
}

export function formatValue(entry: Measured, resource: SystemResource): string {
  const value = valueOf(entry, resource);
  return resource === "cpu" ? formatPercent(value) : formatBytes(value);
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

export interface GroupView {
  key: string;
  kind: SystemProcessGroup["owner"];
  /** The agent's task, else the agent, else where the pane sits; "Codara"; "Other apps". */
  name: string;
  /** The workspace the pane belongs to. */
  workspace: string | null;
  /** Where in the workspace, when the name does not already say it. */
  place: string | null;
  color: string | null;
  runtime: string | null;
  /** Where a click goes; null for Codara itself and other apps. */
  target: NavigationTarget | null;
  group: SystemProcessGroup;
}

function oneLine(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? line : null;
}

export function describeGroup(
  group: SystemProcessGroup,
  panes: ReadonlyMap<string, PaneOwner>,
  workspaces: readonly Pick<Workspace, "id" | "name" | "color">[],
): GroupView {
  const key = group.paneId ? `pane:${group.paneId}` : group.owner;
  const base = { key, group, workspace: null, place: null, color: null, runtime: null, target: null };
  if (group.owner === "codara") return { ...base, kind: "codara", name: "Codara" };
  if (group.owner === "outside" || !group.paneId) return { ...base, kind: "outside", name: "Other apps" };
  const known = panes.get(group.paneId);
  const runtime = group.runtime ?? known?.runtime ?? null;
  const workspace = known
    ? { name: known.workspaceName, color: known.workspaceColor }
    : (() => {
        const entry = group.workspaceId ? workspaces.find((candidate) => candidate.id === group.workspaceId) : undefined;
        return entry ? { name: entry.name, color: entry.color ?? null } : null;
      })();
  const place = known?.place ?? (group.serverId ? `Dev server ${group.serverId}` : null);
  const name = oneLine(known?.task) ?? oneLine(group.task) ?? runtimeLabel(runtime) ?? place ?? "Terminal";
  const workspaceId = known?.workspaceId ?? group.workspaceId;
  const tabId = known?.tabId ?? group.tabId;
  return {
    key,
    kind: "pane",
    name,
    workspace: workspace?.name ?? null,
    place: place && place !== name ? place : null,
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

// Video memory and swap list only the panes that use some; a pane at 0% CPU
// still shows, so every agent can be found under CPU.
const MIN_LISTED_BYTES = 1024 * 1024;

/** The pane rows for one resource, heaviest first. */
export function paneRows(views: readonly GroupView[], resource: SystemResource): GroupView[] {
  const value = (view: GroupView) => valueOf(view.group, resource) ?? 0;
  return views
    .filter((view) => view.kind === "pane")
    .filter((view) => resource === "cpu" || resource === "memory" || value(view) >= MIN_LISTED_BYTES)
    .sort((left, right) => value(right) - value(left) || left.name.localeCompare(right.name));
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
