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
}

const entries = new Map<string, RegistryEntry>();
let activeId: string | null = null;

export function registerPreviewTab(input: {
  id: string;
  handle: BrowserPaneHandle;
  url: string;
}): void {
  entries.set(input.id, input);
}

export function updatePreviewTabUrl(id: string, url: string): void {
  const entry = entries.get(id);
  if (entry) entry.url = url;
}

export function unregisterPreviewTab(id: string): void {
  entries.delete(id);
  if (activeId === id) activeId = null;
}

export function setActivePreviewTab(id: string | null): void {
  activeId = id && entries.has(id) ? id : null;
}

export function pickPreviewTab(tabId?: string | null): RegistryEntry | null {
  if (tabId) return entries.get(tabId) ?? null;
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

// Pick an existing preview tab if one is open, otherwise create a fresh one
// pointing at `url` and wait briefly for PreviewStack to register its
// BrowserPaneHandle. Used by previewRpc.navigate so a sub-agent doesn't have
// to ask the user to "please open a preview tab".
export async function ensurePreviewTab(url: string, runId?: string | null): Promise<RegistryEntry> {
  const existing = pickPreviewTab(null);
  if (existing) return existing;
  if (!openPreviewTabFn) {
    throw new Error(
      "Codara is not ready to open preview tabs yet (renderer not mounted). Retry in a moment.",
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
