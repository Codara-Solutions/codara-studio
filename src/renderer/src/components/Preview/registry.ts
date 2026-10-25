import type { BrowserPaneHandle } from "./BrowserPane";
import { clearDriver, forgetPresenceTab } from "./agent-presence/store";
import { tabLink } from "@shared/tab-links";
import { tabGroupNameOf } from "../../tabs/tabGroupBridge";

interface RegistryEntry {
  id: string;
  handle: BrowserPaneHandle;
  url: string;
  runId: string | null;
  workspaceId: string | null;
  // A logged-out tab's own temporary partition. Such a tab is only ever
  // driven by its id: an implicit pick never lands an agent in it.
  partition?: string | null;
}

const entries = new Map<string, RegistryEntry>();
let activeId: string | null = null;
let activeWorkspaceId: string | null = null;
const lastViewed = new Map<string | null, string>();
// Tabs an agent with no run opened, keyed by tab id, valued by the terminal
// pane that agent runs in. Kept apart from entries so ownership recorded at
// open time survives the tab registering a beat later.
const agentPaneOwners = new Map<string, string>();
// The agent CLI session and process of that agent when the tab opened, as
// main stamped them, so a new agent started in the same pane does not
// inherit the tab.
export interface AgentOpenerIdentity {
  sessionId: string | null;
  process: string | null;
}
const agentIdentityOwners = new Map<string, AgentOpenerIdentity>();

function recordAgentOpener(id: string, paneId: string | null, identity: AgentOpenerIdentity | null | undefined): void {
  if (!paneId) return;
  agentPaneOwners.set(id, paneId);
  if (identity?.sessionId || identity?.process) agentIdentityOwners.set(id, identity);
  else agentIdentityOwners.delete(id);
}

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
  partition?: string | null;
}): void {
  const previous = entries.get(input.id);
  entries.set(input.id, {
    ...previous,
    ...input,
    runId: input.runId ?? null,
    workspaceId: input.workspaceId ?? null,
    partition: input.partition ?? null,
  });
}

export function updatePreviewTabUrl(id: string, url: string, runId?: string | null): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.url = url;
  if (runId !== undefined) entry.runId = runId;
}

export function unregisterPreviewTab(id: string): void {
  entries.delete(id);
  forgetPresenceTab(id);
  agentPaneOwners.delete(id);
  agentIdentityOwners.delete(id);
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
  const implicit = (entry: RegistryEntry) => eligible(entry) && !entry.partition;
  if (paneId) {
    const own = reusablePaneTab(workspace, paneId);
    if (own) return own;
    const free = (entry: RegistryEntry | undefined): entry is RegistryEntry =>
      Boolean(entry && implicit(entry) && !entry.runId && !agentPaneOwners.has(entry.id));
    const active = activeId ? entries.get(activeId) : undefined;
    if (free(active)) return active;
    const viewed = entries.get(lastViewed.get(workspace) ?? "");
    if (free(viewed)) return viewed;
    return [...entries.values()].find(free) ?? null;
  }
  const active = activeId ? entries.get(activeId) : undefined;
  if (active && implicit(active) && (!runId || active.runId === runId)) return active;
  for (const entry of entries.values()) {
    if (implicit(entry) && (!runId || entry.runId === runId)) return entry;
  }
  return null;
}

function reusablePaneTab(workspace: string | null, paneId: string): RegistryEntry | null {
  const own = (entry: RegistryEntry | undefined): entry is RegistryEntry =>
    Boolean(entry && entry.workspaceId === workspace && !entry.runId && !entry.partition && agentPaneOwners.get(entry.id) === paneId);
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
  return [...entries.values()].filter((entry) => entry.workspaceId === workspace).map((entry) => {
    const group = tabGroupNameOf(entry.id);
    return {
      id: entry.id,
      ...(entry.workspaceId ? { link: tabLink(entry.workspaceId, entry.id) } : {}),
      title: entry.handle.getTitle() || entry.url,
      url: entry.handle.getURL() || entry.url,
      workspaceId: entry.workspaceId,
      isLastViewed: lastViewed.get(workspace) === entry.id,
      isActive: entry.id === activeId && entry.workspaceId === activeWorkspaceId,
      ...(entry.partition ? { isolated: true } : {}),
      ...(group ? { group } : {}),
    };
  });
}

/** A run ended: its tabs stop showing it as driving. */
export function clearPreviewControl(runId: string): void {
  clearDriver(`run:${runId}`);
}

type OpenPreviewTabFn = (
  url: string,
  runId?: string | null,
  workspaceId?: string | null,
  options?: { partition?: string; group?: string },
) => Promise<string> | string;
let openPreviewTabFn: OpenPreviewTabFn | null = null;

export function setOpenPreviewTabFn(fn: OpenPreviewTabFn | null): void {
  openPreviewTabFn = fn;
}

type ClosePreviewTabFn = (id: string) => void;
let closePreviewTabFn: ClosePreviewTabFn | null = null;

export function setClosePreviewTabFn(fn: ClosePreviewTabFn | null): void {
  closePreviewTabFn = fn;
}

/** Every tab running in one logged-out partition: the one an agent opened and the pages it opened in new tabs. */
export function previewTabsInPartition(partition: string): string[] {
  return [...entries.values()].filter((entry) => entry.partition === partition).map((entry) => entry.id);
}

/** Who opened a browser tab: the run, or the terminal pane, agent session and process of an agent with no run. */
export function previewTabOpener(id: string): AgentOpenerIdentity & { runId: string | null; paneId: string | null } {
  return {
    runId: entries.get(id)?.runId ?? null,
    paneId: agentPaneOwners.get(id) ?? null,
    sessionId: agentIdentityOwners.get(id)?.sessionId ?? null,
    process: agentIdentityOwners.get(id)?.process ?? null,
  };
}

/** Whether any workspace has this browser tab open. */
export function hasPreviewTab(id: string): boolean {
  return entries.has(id);
}

export function closePreviewTab(id: string): void {
  if (!closePreviewTabFn) throw new Error("Codara is not ready to close browser tabs yet. Retry in a moment.");
  closePreviewTabFn(id);
}

async function waitForRegisteredTab(id: string, workspace: string | null): Promise<RegistryEntry> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = entries.get(id);
    if (entry && entry.workspaceId === workspace) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the new browser tab ${id} to register.`);
}

/** Always a new tab, in its own partition, owned like any tab the caller opens. */
export async function openIsolatedPreviewTab(
  url: string,
  partition: string,
  runId?: string | null,
  workspaceId?: string | null,
  callerPaneId?: string | null,
  group?: string | null,
  callerIdentity?: AgentOpenerIdentity | null,
): Promise<RegistryEntry> {
  const { workspace, paneId } = previewScope(runId, workspaceId, callerPaneId);
  if (!openPreviewTabFn) throw new Error("Codara is not ready to open browser tabs yet. Retry in a moment.");
  const id = await Promise.resolve(
    openPreviewTabFn(url, runId, workspace, { partition, ...(group ? { group } : {}) }),
  );
  recordAgentOpener(id, paneId, callerIdentity);
  return waitForRegisteredTab(id, workspace);
}

// `group` only applies when a tab is opened; a reused tab stays where the
// user or an earlier call put it.
export async function ensurePreviewTab(
  url: string,
  runId?: string | null,
  workspaceId?: string | null,
  callerPaneId?: string | null,
  group?: string | null,
  callerIdentity?: AgentOpenerIdentity | null,
): Promise<{ tab: RegistryEntry; opened: boolean }> {
  const { workspace, paneId } = previewScope(runId, workspaceId, callerPaneId);
  const existing = findReusablePreviewTab(runId, workspace, paneId);
  if (existing) return { tab: existing, opened: false };
  if (!openPreviewTabFn) throw new Error("Codara is not ready to open browser tabs yet. Retry in a moment.");
  const id = await Promise.resolve(
    openPreviewTabFn(url, runId, workspace, group ? { group } : undefined),
  );
  recordAgentOpener(id, paneId, callerIdentity);
  return { tab: await waitForRegisteredTab(id, workspace), opened: true };
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

/** Who drives a tab: the run it belongs to, or the terminal pane whose agent opened it. */
export function previewTabOwner(tabId: string): { runId: string | null; paneId: string | null } | null {
  const runId = entries.get(tabId)?.runId ?? null;
  const paneId = agentPaneOwners.get(tabId) ?? null;
  return runId || paneId ? { runId, paneId } : null;
}

// A tab a page opened belongs to whoever owned the page's tab.
export function inheritPreviewTabOwner(tabId: string, sourceTabId: string): void {
  const paneId = agentPaneOwners.get(sourceTabId);
  if (paneId) recordAgentOpener(tabId, paneId, agentIdentityOwners.get(sourceTabId));
}

/** The workspace's browser tabs with who drives them: a run, a terminal agent's pane, or nobody. */
export function previewTabOwners(workspaceId: string | null): Array<{
  id: string;
  title: string;
  url: string;
  runId: string | null;
  ownerPaneId: string | null;
}> {
  return [...entries.values()]
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => ({
      id: entry.id,
      title: entry.handle.getTitle() || entry.url,
      url: entry.handle.getURL() || entry.url,
      runId: entry.runId,
      ownerPaneId: agentPaneOwners.get(entry.id) ?? null,
    }));
}
