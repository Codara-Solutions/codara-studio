import type { Tab } from "./types";

// Whether a tab shows a file inside a folder that is about to be removed. A
// worktree's removal asks this of every workspace's tabs: an editor tab on a
// file inside it holds it wherever the tab sits, because an agent's
// codara_open_file opens the file in the agent's own workspace, not the
// worktree's. Terminals are left out: main sees those itself and knows which
// pane belongs to the agent asking.

function normalize(path: string): string {
  let out = path.replace(/\\/g, "/");
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return /^[a-z]:\//i.test(out) ? out.toLowerCase() : out;
}

export function pathIsInside(candidate: string, folders: readonly string[]): boolean {
  const path = normalize(candidate);
  return folders.some((folder) => {
    const root = normalize(folder);
    return root.length > 1 && (path === root || path.startsWith(`${root}/`));
  });
}

function fileUrlPath(url: string): string | null {
  if (!/^file:/i.test(url)) return null;
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/([a-z]:)/i, "$1");
  } catch {
    return null;
  }
}

// The file a tab shows, as the tab spells it: an editor's path or a preview's
// file:// URL. Main resolves symlinks; this side cannot.
export function tabFilePath(tab: Tab): string | null {
  if (!tab || typeof tab !== "object") return null;
  if (tab.kind === "editor") return typeof tab.path === "string" && tab.path ? tab.path : null;
  if (tab.kind === "preview") return typeof tab.url === "string" ? fileUrlPath(tab.url) : null;
  return null;
}

export function tabFilePaths(tabs: readonly Tab[]): string[] {
  const files: string[] = [];
  for (const tab of tabs) {
    const file = tabFilePath(tab);
    if (file) files.push(file);
  }
  return files;
}

export function tabsShowPathInside(tabs: readonly Tab[], folders: readonly string[]): boolean {
  return folders.length > 0 && tabFilePaths(tabs).some((file) => pathIsInside(file, folders));
}
