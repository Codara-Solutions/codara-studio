import type { BrowserPaneHandle } from "./BrowserPane";
import type { PreviewControl } from "./PreviewCursor";

interface RegistryEntry {
  id: string;
  handle: BrowserPaneHandle;
  url: string;
  runId: string | null;
  workspaceId: string | null;
  controlRunId?: string | null;
}

const entries = new Map<string, RegistryEntry>();
let activeId: string | null = null;
let activeWorkspaceId: string | null = null;
const lastViewed = new Map<string | null, string>();

export function registerPreviewTab(input: {
  id: string;
  handle: BrowserPaneHandle;
  url: string;
  runId?: string | null;
  workspaceId?: string | null;
}): void {
  const previous = entries.get(input.id);
  entries.set(input.id, { ...previous, ...input, runId: input.runId ?? null, workspaceId: input.workspaceId ?? null });
}

export function updatePreviewTabUrl(id: string, url: string, runId?: string | null): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.url = url;
  if (runId !== undefined) entry.runId = runId;
}

export function unregisterPreviewTab(id: string): void {
  entries.delete(id);
  if (activeId === id) activeId = null;
  for (const [workspace, tabId] of lastViewed) if (tabId === id) lastViewed.delete(workspace);
}

export function setActivePreviewTab(id: string | null, workspaceId: string | null = null): void {
  activeWorkspaceId = workspaceId;
  activeId = id;
  if (id && entries.get(id)?.workspaceId === workspaceId) lastViewed.set(workspaceId, id);
}

// Explicit IDs can select an existing user tab in the caller's workspace.
// Implicit run targeting never commandeers another run's or the user's tab.
export function pickPreviewTab(tabId?: string | null, runId?: string | null, workspaceId?: string | null): RegistryEntry | null {
  const workspace = workspaceId ?? activeWorkspaceId;
  const eligible = (entry: RegistryEntry) => entry.workspaceId === workspace;
  if (tabId) {
    const entry = entries.get(tabId);
    return entry && eligible(entry) ? entry : null;
  }
  const active = activeId ? entries.get(activeId) : undefined;
  if (active && eligible(active) && (!runId || active.runId === runId)) return active;
  for (const entry of entries.values()) {
    if (eligible(entry) && (!runId || entry.runId === runId)) return entry;
  }
  return null;
}

export function listPreviewTabs(workspaceId?: string | null) {
  const workspace = workspaceId ?? activeWorkspaceId;
  return [...entries.values()].filter((entry) => entry.workspaceId === workspace).map((entry) => ({
    id: entry.id,
    title: entry.handle.getTitle() || entry.url,
    url: entry.handle.getURL() || entry.url,
    workspaceId: entry.workspaceId,
    isLastViewed: lastViewed.get(workspace) === entry.id,
    isActive: entry.id === activeId && entry.workspaceId === activeWorkspaceId,
  }));
}

export function showPreviewControl(tab: RegistryEntry, control: PreviewControl): void {
  tab.controlRunId = control.runId;
  tab.handle.showAgentCursor(control);
}

export function clearPreviewControl(runId: string): void {
  for (const entry of entries.values()) {
    if (entry.controlRunId !== runId) continue;
    entry.handle.showAgentCursor(null);
    entry.controlRunId = null;
  }
}

type OpenPreviewTabFn = (url: string, runId?: string | null, workspaceId?: string | null) => Promise<string> | string;
let openPreviewTabFn: OpenPreviewTabFn | null = null;

export function setOpenPreviewTabFn(fn: OpenPreviewTabFn | null): void {
  openPreviewTabFn = fn;
}

export async function ensurePreviewTab(url: string, runId?: string | null, workspaceId?: string | null): Promise<RegistryEntry> {
  const workspace = workspaceId ?? activeWorkspaceId;
  const existing = pickPreviewTab(null, runId, workspace);
  if (existing) return existing;
  if (!openPreviewTabFn) throw new Error("Codara is not ready to open browser tabs yet. Retry in a moment.");
  const id = await Promise.resolve(openPreviewTabFn(url, runId, workspace));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = entries.get(id);
    if (entry && entry.workspaceId === workspace) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the new browser tab ${id} to register.`);
}
