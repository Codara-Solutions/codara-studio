// The wire format between Codara and its browser extension
// (extensions/chrome/). One WebSocket per browser profile at
// ws://127.0.0.1:<port>/codara-chrome; every frame is one JSON object.
//
//   ext -> {type:"hello", protocol, browser, extension, token?, pair}
//   codara -> {type:"welcome", protocol, linkId, app}          known token
//   codara -> {type:"pairing", code}                           pair asked, no token
//   codara -> {type:"paired", token, linkId, app}              the user allowed it
//   codara -> {type:"denied", message} | {type:"unpaired"}     then close
//
// After that the extension reports the tabs the user shared ("tabs"),
// relays chrome.debugger events ("cdp_event", "detached") and answers
// Codara's requests ({id, type, ...} -> {id, result} | {id, error}). Codara
// tells it which agent used a tab ("usage") and can revoke the pairing.

export const CHROME_LINK_PROTOCOL = 1;
export const CHROME_LINK_PORTS: readonly number[] = [47615, 47616, 47617, 47618, 47619];
export const CHROME_LINK_PATH = "/codara-chrome";
/** chrome-extension://<32 letters a-p>; Edge, Brave and the other Chromium browsers send the same. */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
export const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export interface ChromeBrowserInfo {
  name: string;
  version: string;
}

/** A tab the user shared, as the extension reports it. A blocked tab carries no URL or title. */
export interface ChromeTabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  attached: boolean;
  blocked: boolean;
  /** The user allowed cookie and storage access for this tab. */
  storage: boolean;
  openedByAgent: boolean;
}

export type ChromeRequestType = "attach" | "detach" | "cdp" | "open" | "close" | "activate";

export interface ExtensionHello {
  type: "hello";
  protocol: number;
  browser: ChromeBrowserInfo;
  extension: { id: string; version: string };
  token?: string;
  pair?: boolean;
}

/** "483 921": six digits, grouped so both screens read the same at a glance. */
export function pairingCode(random: () => number = Math.random): string {
  const digits = String(Math.floor(random() * 1_000_000)).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** A short id for one paired browser, used in chrome:<linkId>/<tabId>. */
export function linkIdFor(browserName: string, taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const base = browserName.toLowerCase().replace(/^(google|microsoft)\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "browser";
  for (;;) {
    const id = `${base}-${Math.floor(random() * 0x10000).toString(16).padStart(4, "0")}`;
    if (!taken.has(id)) return id;
  }
}

export function sanitizeBrowserInfo(value: unknown): ChromeBrowserInfo {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (input: unknown, max: number) => (typeof input === "string" ? input.replace(/[^\w .()-]/g, "").slice(0, max) : "");
  return { name: text(raw.name, 40) || "Chromium", version: text(raw.version, 24) };
}

export function sanitizeTabs(value: unknown): ChromeTabInfo[] {
  if (!Array.isArray(value)) return [];
  const out: ChromeTabInfo[] = [];
  for (const raw of value.slice(0, 1000)) {
    if (!raw || typeof raw !== "object") continue;
    const tab = raw as Record<string, unknown>;
    if (typeof tab.tabId !== "number" || !Number.isInteger(tab.tabId) || tab.tabId < 0) continue;
    out.push({
      tabId: tab.tabId,
      windowId: typeof tab.windowId === "number" ? tab.windowId : -1,
      url: typeof tab.url === "string" ? tab.url.slice(0, 4096) : "",
      title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "",
      active: tab.active === true,
      attached: tab.attached === true,
      blocked: tab.blocked === true,
      storage: tab.storage === true,
      openedByAgent: tab.openedByAgent === true,
    });
  }
  return out;
}
