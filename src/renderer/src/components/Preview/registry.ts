// Module-level registry of live preview tabs. PreviewStack registers each
// mounted <BrowserPane>'s handle here; the previewRpc handler resolves a
// target tab from incoming bridge requests by id or "active".
//
// We can't reach React state from main → ipcRenderer.send dispatch paths
// without a hidden context dance, so a plain module singleton is the
// cheapest correct option. Lives for the renderer process lifetime.

import type { BrowserPaneHandle } from "./BrowserPane";

interface RegistryEntry {
  id: string;
  handle: BrowserPaneHandle;
  url: string;
  // Owning run id for agent-spawned previews; null for tabs the user opened
  // (TabBar picker, Codara browser, restored-from-disk previews — useTabs
  // strips runId on persist). Ownership is what keeps a run's probes off the
  // user's own preview tabs.
  runId: string | null;
}

const entries = new Map<string, RegistryEntry>();
let activeId: string | null = null;

export function registerPreviewTab(input: {
  id: string;
  handle: BrowserPaneHandle;
  url: string;
  runId?: string | null;
}): void {
  entries.set(input.id, { ...input, runId: input.runId ?? null });
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
}

export function setActivePreviewTab(id: string | null): void {
  activeId = id && entries.has(id) ? id : null;
}

// `tabId` is trusted: an explicit target is honored whoever asks for it.
// Without one, a caller that carries a run identity may only be given a tab
// that RUN owns — implicit picking must never hand a run the user's preview
// tab (or another run's). Callers with no run identity (user-facing agents)
// keep the historical "active, else first" behavior.
export function pickPreviewTab(tabId?: string | null, runId?: string | null): RegistryEntry | null {
  if (tabId) return entries.get(tabId) ?? null;
  if (runId) {
    const active = activeId ? entries.get(activeId) : undefined;
    if (active && active.runId === runId) return active;
    for (const entry of entries.values()) {
      if (entry.runId === runId) return entry;
    }
    return null;
  }
  if (activeId) return entries.get(activeId) ?? null;
  // Fall back to the first registered tab — better to drive *something*
  // than to fail because the user clicked away from the preview.
  return entries.values().next().value ?? null;
}

export function listPreviewTabs(): Array<{ id: string; url: string; isActive: boolean }> {
  return [...entries.values()].map((entry) => ({
    id: entry.id,
    url: entry.url,
    isActive: entry.id === activeId,
  }));
}

// Adapter injected by App.tsx so the spark-preview MCP bridge can spawn a
// preview tab without a manual user action. Returns the new tab id. `runId` is
// the CALLING run's id (threaded from the MCP server's SPARK_RUN_ID stamp) so
// the minted tab is attributed to the run that is driving it, not whichever
// run the user has selected.
type OpenPreviewTabFn = (url: string, runId?: string | null) => Promise<string> | string;
let openPreviewTabFn: OpenPreviewTabFn | null = null;

export function setOpenPreviewTabFn(fn: OpenPreviewTabFn | null): void {
  openPreviewTabFn = fn;
}

// Resolve the preview tab a navigate should drive, minting one when needed,
// and wait briefly for PreviewStack to register its BrowserPaneHandle. Used by
// previewRpc.navigate so a sub-agent doesn't have to ask the user to "please
// open a preview tab".
//
// With a runId, only that run's own tab is reusable: a run gets a fresh tab
// rather than commandeering the user's (or a sibling run's) preview. Without
// one, any open preview is fair game, as before.
export async function ensurePreviewTab(url: string, runId?: string | null): Promise<RegistryEntry> {
  const existing = pickPreviewTab(null, runId ?? null);
  if (existing) return existing;
  if (!openPreviewTabFn) {
    throw new Error(
      "Codara is not ready to open browser tabs yet (renderer not mounted). Retry in a moment.",
    );
  }
  const id = await Promise.resolve(openPreviewTabFn(url, runId));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = entries.get(id);
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the new preview tab ${id} to register.`);
}
