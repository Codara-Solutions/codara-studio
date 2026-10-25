// Bridge ops for logged-out tabs (codara_preview_storage actions fresh and
// discard). Main picks the partition and wipes it (src/main/browser/
// fresh-tabs.ts); the renderer opens the tab in it and closes it again.

import { isFreshPartition } from "@shared/browser-partition";
import { tabGroupNameOf } from "../../tabs/tabGroupBridge";
import { closePreviewTab, openIsolatedPreviewTab, pickPreviewTab, previewTabsInPartition } from "./registry";

function text(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value ? value : null;
}

export async function openIsolatedTab(params: Record<string, unknown>): Promise<unknown> {
  const url = text(params, "url") ?? "about:blank";
  const partition = text(params, "partition");
  if (!isFreshPartition(partition)) throw new Error("open_isolated needs a fresh-tab partition");
  const tab = await openIsolatedPreviewTab(
    url,
    partition,
    text(params, "runId"),
    text(params, "workspaceId"),
    text(params, "callerPaneId"),
    text(params, "group"),
    { sessionId: text(params, "callerSessionId"), process: text(params, "callerProcess") },
  );
  const started = Date.now();
  while (!tab.handle.isReady()) {
    if (Date.now() - started > 15_000) throw new Error("timed out waiting for the logged-out tab to load");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const group = tabGroupNameOf(tab.id);
  return { tabId: tab.id, url: tab.handle.getURL() || url, ...(group ? { group } : {}) };
}

export async function closeIsolatedTab(params: Record<string, unknown>): Promise<unknown> {
  const tabId = text(params, "tabId");
  const tab = pickPreviewTab(tabId, null, text(params, "workspaceId"), text(params, "callerPaneId"));
  if (!tab) throw new Error(`preview tab not found: ${tabId ?? ""}`);
  // Only a logged-out tab is closed here; main checks the partition before wiping it.
  if (!tab.partition) return { tabId: tab.id, partition: null };
  // Wiping the partition would leave any other tab in it on an empty session.
  const closed = previewTabsInPartition(tab.partition);
  for (const id of closed) closePreviewTab(id);
  return { tabId: tab.id, partition: tab.partition, closed };
}
