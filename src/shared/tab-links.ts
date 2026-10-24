// Links to a tab or a tab group, which the user copies from the strip and
// agents return from their list tools: codara://tab/<workspace>/<tab> and
// codara://group/<workspace>/<group>. Clicking one in a terminal or a chat
// brings that tab on screen; an agent passes one to codara_tab to act on it.
// The ids are the ones the layout already persists, so a link lives as long
// as its tab, across restarts too.

export const TAB_LINK_SCHEME = "codara:";

export type TabLinkKind = "tab" | "group";

export interface TabLinkRef {
  kind: TabLinkKind;
  workspaceId: string;
  id: string;
}

// Workspace, tab and group ids are made of these (ids.ts, tabGroups.ts).
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

// A link as it appears in running text: a terminal line, a chat answer. The
// trailing class leaves out sentence punctuation, as URL detectors do.
export const TAB_LINK_TEXT_PATTERN = /codara:\/\/(?:tab|group)\/[A-Za-z0-9_.:%-]+\/[A-Za-z0-9_.:%-]*[A-Za-z0-9_%-]/g;

export function tabLink(workspaceId: string, tabId: string): string {
  return `codara://tab/${encodeURIComponent(workspaceId)}/${encodeURIComponent(tabId)}`;
}

export function groupLink(workspaceId: string, groupId: string): string {
  return `codara://group/${encodeURIComponent(workspaceId)}/${encodeURIComponent(groupId)}`;
}

export function isTabLink(value: unknown): boolean {
  return parseTabLink(value) !== null;
}

export function parseTabLink(value: unknown): TabLinkRef | null {
  if (typeof value !== "string") return null;
  const match = /^codara:\/\/(tab|group)\/([^/?#\s]+)\/([^/?#\s]+)\/?$/i.exec(value.trim());
  if (!match) return null;
  let workspaceId: string;
  let id: string;
  try {
    workspaceId = decodeURIComponent(match[2]);
    id = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  if (!ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(id)) return null;
  return { kind: match[1].toLowerCase() as TabLinkKind, workspaceId, id };
}
