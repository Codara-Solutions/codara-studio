import { BrowserWindow, type WebContents } from "electron";

// Where a page inside the in-app browser may open a new window. A guest has
// no window-open handler of its own unless one is set here, and Electron's
// default gives every target=_blank link a full, unparented BrowserWindow.

export type GuestPopupDecision =
  | { kind: "tab"; background: boolean }
  | { kind: "window" }
  | { kind: "deny" };

// Features that ask for a sized popup rather than a tab. noopener and
// noreferrer are left out: "open in a new tab" code passes them on its own.
const POPUP_FEATURES = new Set([
  "popup",
  "width",
  "height",
  "innerwidth",
  "innerheight",
  "left",
  "top",
  "screenx",
  "screeny",
]);

function asksForPopup(features: string): boolean {
  return features
    .split(",")
    .map((entry) => entry.split("=")[0]?.trim().toLowerCase() ?? "")
    .some((key) => POPUP_FEATURES.has(key));
}

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

// Links and plain window.open calls become in-app browser tabs. A scripted
// popup that sizes itself (a sign-in window) or starts blank and is filled by
// its opener keeps a real window, because the page drives it through
// window.opener, which a separate tab cannot give it. A web page may not open
// a local file: Chromium would refuse that navigation, and a tab must not be a
// way around it.
export function decideGuestPopup(input: {
  url: string;
  disposition: string;
  features: string;
  openerUrl: string;
}): GuestPopupDecision {
  if (input.url === "" || input.url === "about:blank") return { kind: "window" };
  const protocol = protocolOf(input.url);
  const web = protocol === "http:" || protocol === "https:";
  const localFile = protocol === "file:" && protocolOf(input.openerUrl) === "file:";
  if (!web && !localFile) return { kind: "deny" };
  if (asksForPopup(input.features)) return { kind: "window" };
  return { kind: "tab", background: input.disposition === "background-tab" };
}

// `host` is the app window's webContents, which owns the browser tabs. Popup
// windows are parented to the app window so they stay in its space instead of
// opening as their own full-screen window, and their links follow these rules
// too.
export function routeGuestPopups(
  contents: WebContents,
  host: () => WebContents | null | undefined,
): void {
  contents.setWindowOpenHandler((details) => {
    const decision = decideGuestPopup({
      url: details.url,
      disposition: details.disposition,
      features: details.features,
      openerUrl: contents.getURL(),
    });
    if (decision.kind === "deny") return { action: "deny" };
    const owner = host();
    if (decision.kind === "tab") {
      if (owner && !owner.isDestroyed()) {
        owner.send("app:open-browser-url", details.url, {
          forceNew: true,
          background: decision.background,
        });
      }
      return { action: "deny" };
    }
    const parent =
      (contents.getType() === "window" ? BrowserWindow.fromWebContents(contents) : null) ??
      (owner && !owner.isDestroyed() ? BrowserWindow.fromWebContents(owner) : null);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...(parent ? { parent } : {}),
        // window.open sizes are the page's, not the frame's.
        useContentSize: true,
        fullscreen: false,
        fullscreenable: false,
        autoHideMenuBar: true,
      },
    };
  });
  contents.on("did-create-window", (window) => routeGuestPopups(window.webContents, host));
}
