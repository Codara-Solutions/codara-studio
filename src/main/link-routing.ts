import type { LinkOpenTarget } from "@shared/types";

// The one place that decides where a clicked link opens. Every plain link
// click (terminal links, chat and markdown links, GitHub buttons, links and
// window.open from the app window itself) reaches openLink; explicit "open in
// Codara browser" or "open in default browser" actions, agent browser tools,
// pages already inside the Codara browser and sign-in flows do not.

export type LinkRoute = "studio" | "system" | "drop";

// file: never reaches the system browser: shell.openExternal would run the
// file with its default handler (a .bat on Windows), so local files always
// open in Codara's viewer. Anything that is not web, mail or a local file is
// dropped, so a URL printed on a terminal cannot launch an arbitrary handler.
export function routeLink(url: string, target: LinkOpenTarget): LinkRoute {
  if (typeof url !== "string" || url.length === 0) return "drop";
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return "drop";
  }
  if (protocol === "file:") return "studio";
  if (protocol === "mailto:") return "system";
  if (protocol !== "http:" && protocol !== "https:") return "drop";
  return target === "studio" ? "studio" : "system";
}

export function isSystemBrowserUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url);
}

export interface OpenLinkDeps {
  target: LinkOpenTarget;
  openInStudio: (url: string) => void;
  openInSystem: (url: string) => Promise<void> | void;
}

export async function openLink(url: string, deps: OpenLinkDeps): Promise<LinkRoute> {
  const route = routeLink(url, deps.target);
  if (route === "studio") deps.openInStudio(url);
  else if (route === "system") await deps.openInSystem(url);
  return route;
}
