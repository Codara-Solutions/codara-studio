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
// Tabs an agent with no run opened, keyed by tab id, valued by the terminal
// pane that agent runs in. Kept apart from entries so ownership recorded at
// open time survives the tab registering a beat later.
const agentPaneOwners = new Map<string, string>();

type LocatePaneWorkspaceFn = (paneId: string) => string | null;
let locatePaneWorkspaceFn: LocatePaneWorkspaceFn | null = null;

export function setLocatePaneWorkspaceFn(fn: LocatePaneWorkspaceFn | null): void {
  locatePaneWorkspaceFn = fn;
}

// Which workspace an agent call works in. A run's workspace is stamped by
// main. An agent with no run works in the workspace of the pane it runs in,
// never the one on screen: the user may have switched away since it started.
// Only a caller outside every pane (a script, an external CLI) falls back to
// the workspace on screen.
function previewScope(
  runId: string | null | undefined,
  workspaceId: string | null | undefined,
  callerPaneId: string | null | undefined,
): { workspace: string | null; paneId: string | null } {
  if (!runId && callerPaneId) {
    const located = locatePaneWorkspaceFn?.(callerPaneId) ?? null;
    if (located) return { workspace: located, paneId: callerPaneId };
  }
  return { workspace: workspaceId ?? activeWorkspaceId, paneId: null };
}

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
  agentPaneOwners.delete(id);
  if (activeId === id) activeId = null;
  for (const [workspace, tabId] of lastViewed) if (tabId === id) lastViewed.delete(workspace);
}

export function setActivePreviewTab(id: string | null, workspaceId: string | null = null): void {
  activeWorkspaceId = workspaceId;
  activeId = id;
  if (id && entries.get(id)?.workspaceId === workspaceId) lastViewed.set(workspaceId, id);
}

// Explicit IDs can select an existing tab in the caller's workspace. Implicit
// run targeting never commandeers another run's or the user's tab, and an
// agent with no run prefers the tabs it opened and never takes a run's tab or
// another agent's.
export function pickPreviewTab(
  tabId?: string | null,
  runId?: string | null,
  workspaceId?: string | null,
  callerPaneId?: string | null,
): RegistryEntry | null {
  const { workspace, paneId } = previewScope(runId, workspaceId, callerPaneId);
  const eligible = (entry: RegistryEntry) => entry.workspaceId === workspace;
  if (tabId) {
    const entry = entries.get(tabId);
    return entry && eligible(entry) ? entry : null;
  }
  if (paneId) {
    const own = reusablePaneTab(workspace, paneId);
    if (own) return own;
    const free = (entry: RegistryEntry | undefined): entry is RegistryEntry =>
      Boolean(entry && eligible(entry) && !entry.runId && !agentPaneOwners.has(entry.id));
    const active = activeId ? entries.get(activeId) : undefined;
    if (free(active)) return active;
    const viewed = entries.get(lastViewed.get(workspace) ?? "");
    if (free(viewed)) return viewed;
    return [...entries.values()].find(free) ?? null;
  }
  const active = activeId ? entries.get(activeId) : undefined;
  if (active && eligible(active) && (!runId || active.runId === runId)) return active;
  for (const entry of entries.values()) {
    if (eligible(entry) && (!runId || entry.runId === runId)) return entry;
  }
  return null;
}

function reusablePaneTab(workspace: string | null, paneId: string): RegistryEntry | null {
  const own = (entry: RegistryEntry | undefined): entry is RegistryEntry =>
    Boolean(entry && entry.workspaceId === workspace && !entry.runId && agentPaneOwners.get(entry.id) === paneId);
  const active = activeId ? entries.get(activeId) : undefined;
  if (own(active)) return active;
  return [...entries.values()].reverse().find(own) ?? null;
}

// The tab a navigate without a tabId reuses. A run reuses only its own tabs
// and an agent with no run only the tabs it opened, so neither ever navigates
// the user's tab away.
export function findReusablePreviewTab(
  runId?: string | null,
  workspaceId?: string | null,
  callerPaneId?: string | null,
): RegistryEntry | null {
  const { workspace, paneId } = previewScope(runId, workspaceId, callerPaneId);
  if (paneId) return reusablePaneTab(workspace, paneId);
  return pickPreviewTab(null, runId, workspace);
}

export function listPreviewTabs(workspaceId?: string | null, callerPaneId?: string | null) {
  const { workspace } = previewScope(null, workspaceId, callerPaneId);
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

export async function ensurePreviewTab(
  url: string,
  runId?: string | null,
  workspaceId?: string | null,
  callerPaneId?: string | null,
): Promise<RegistryEntry> {
  const { workspace, paneId } = previewScope(runId, workspaceId, callerPaneId);
  const existing = findReusablePreviewTab(runId, workspace, paneId);
  if (existing) return existing;
  if (!openPreviewTabFn) throw new Error("Codara is not ready to open browser tabs yet. Retry in a moment.");
  const id = await Promise.resolve(openPreviewTabFn(url, runId, workspace));
  if (paneId) agentPaneOwners.set(id, paneId);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = entries.get(id);
    if (entry && entry.workspaceId === workspace) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the new browser tab ${id} to register.`);
}

// The tab whose page is the guest with this webContents id, so a link the
// page opens in a new tab lands in that tab's workspace and run.
export function findPreviewTabByWebContentsId(webContentsId: number): RegistryEntry | null {
  for (const entry of entries.values()) {
    if (entry.handle.getWebContentsId() === webContentsId) return entry;
  }
  return null;
}

/** A tab a terminal agent with no run opened and may still be driving. */
export function isAgentOwnedPreviewTab(tabId: string): boolean {
  return agentPaneOwners.has(tabId);
}

// A tab a page opened belongs to whoever owned the page's tab.
export function inheritPreviewTabOwner(tabId: string, sourceTabId: string): void {
  const paneId = agentPaneOwners.get(sourceTabId);
  if (paneId) agentPaneOwners.set(tabId, paneId);
}
