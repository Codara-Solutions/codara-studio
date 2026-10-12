import { shell, type WebContents } from "electron";
import { isSystemBrowserUrl, openLink, type LinkRoute } from "./link-routing";
import { getPreferenceCached } from "./preferences-store";

export async function openInSystemBrowser(url: string): Promise<void> {
  if (!isSystemBrowserUrl(url)) return;
  try {
    await shell.openExternal(url);
  } catch {
    /* shell.openExternal rejects when no handler is registered; ignore. */
  }
}

// `host` is the app window's webContents, which owns the Codara browser tabs.
export function openLinkFromApp(
  url: string,
  host: WebContents | null | undefined,
): Promise<LinkRoute> {
  return openLink(url, {
    target: getPreferenceCached("linkOpenTarget") ?? "system",
    openInStudio: (target) => {
      if (host && !host.isDestroyed()) host.send("app:open-browser-url", target);
    },
    openInSystem: openInSystemBrowser,
  });
}
