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

export function tabShowsPathInside(tab: Tab, folders: readonly string[]): boolean {
  if (!tab || typeof tab !== "object") return false;
  if (tab.kind === "editor") return typeof tab.path === "string" && pathIsInside(tab.path, folders);
  if (tab.kind === "preview") {
    const file = typeof tab.url === "string" ? fileUrlPath(tab.url) : null;
    return file !== null && pathIsInside(file, folders);
  }
  return false;
}

export function tabsShowPathInside(tabs: readonly Tab[], folders: readonly string[]): boolean {
  return folders.length > 0 && tabs.some((tab) => tabShowsPathInside(tab, folders));
}
