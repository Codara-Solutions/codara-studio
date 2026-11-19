// What Settings and the pairing prompt show about the browser extension
// link (src/main/browser/chrome/), over window.spark.chromeLink.

export interface ChromeLinkTabState {
  /** The id agents pass as tabId. */
  id: string;
  title: string;
  url: string;
  active: boolean;
  attached: boolean;
  storage: boolean;
  blocked: boolean;
  openedByAgent: boolean;
  /** Agents the user stopped on this tab from the page; "Give back" lets them in again. */
  stopped: { key: string; name: string }[];
  /** Refused to agents after Codara could not read its saved stops, until the user shares it again. */
  paused: boolean;
}

export interface ChromeLinkBrowserState {
  linkId: string;
  browser: { name: string; version: string };
  extensionId: string;
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
  extensionVersion: string | null;
  /**
   * The connected extension is older than the one Codara ships. Codara
   * changes it only after the user presses Update extension: "available"
   * until then, "updating" while it reloads itself after that, "manual" when
   * the user has to press reload in the browser's extensions page. "reload":
   * the folder already holds the new version (another browser's Update put it
   * there) and this browser still runs the old one: Reload extension asks it
   * to reload, nothing is copied. "elsewhere": the browser did not load it
   * from Codara's folder (the Chrome Web Store, or a folder Codara does not
   * manage), so Codara leaves it alone. Null when it is current or not
   * connected.
   */
  extensionUpdate: "available" | "reload" | "updating" | "manual" | "elsewhere" | null;
  /** The connected extension can reload itself when asked; before 1.1.0 the user reloads it in the browser. */
  extensionReloads: boolean;
  allowOpen: boolean;
  tabs: ChromeLinkTabState[];
}

/** Where an extension Codara does not manage gets its updates, in one sentence. */
export const NOT_FROM_CODARA_FOLDER =
  "if it came from the Chrome Web Store, Chrome updates it by itself; if you loaded it from another folder, update that folder, then press the reload button on Codara in chrome://extensions.";

/**
 * What Settings > Browser says about a connected extension older than the
 * one Codara ships: a status line, an optional line of detail, and the one
 * button it offers ("update" copies and reloads, "reload" only reloads).
 */
export function extensionUpdateNotice(
  browser: Pick<ChromeLinkBrowserState, "extensionUpdate" | "extensionVersion" | "extensionReloads">,
  shipped: string,
): { status: string; detail: string | null; action: "update" | "reload" | null } | null {
  const running = browser.extensionVersion ?? "an older version";
  const versions = `This browser runs extension ${running}, Codara ships ${shipped}.`;
  switch (browser.extensionUpdate) {
    case "available":
      return {
        status: versions,
        detail: browser.extensionReloads
          ? `Update extension copies ${shipped} into Codara's extension folder, which every browser that loaded it uses, and restarts the extension in this browser; until you do, ${running} keeps working.`
          : `Update extension copies ${shipped} into Codara's extension folder, which every browser that loaded it uses; then press the reload button on Codara in chrome://extensions. Until you do, ${running} keeps working.`,
        action: "update",
      };
    case "reload":
      return {
        status: `Codara's extension folder now holds ${shipped}: reload the extension in this browser.`,
        detail: `This browser still runs ${running}. Reload extension restarts it with the new files, keeping the folder as it is.`,
        action: "reload",
      };
    case "updating":
      return { status: `Updating the extension to ${shipped}.`, detail: null, action: null };
    case "manual":
      return {
        status: `Codara's extension folder holds ${shipped}, but this browser still runs ${running}. Open chrome://extensions and press the reload button on Codara.`,
        detail: null,
        action: null,
      };
    case "elsewhere":
      return { status: `${versions} This browser did not load it from Codara's folder: ${NOT_FROM_CODARA_FOLDER}`, detail: null, action: null };
    default:
      return null;
  }
}

export interface ChromeLinkPairing {
  id: string;
  code: string;
  browser: { name: string; version: string };
  extensionId: string;
  expiresAt: string;
}

export interface ChromeLinkIncompatibleExtension {
  extensionId: string;
  version: string;
  browser: { name: string; version: string };
  update: "extension" | "codara";
  /** Loaded from Codara's folder, so Update extension can copy the new version there. */
  fromCodaraFolder: boolean;
  /** The user pressed Update extension: the folder holds the new version, the browser still has to reload it. */
  copied: boolean;
}

export interface ChromeLinkActivity {
  at: string;
  tool: string;
  tab: string | null;
  agent: string;
  workspaceId: string | null;
  detail?: string;
}

/**
 * How an agent shows on a shared tab of the user's browser: the pointer and
 * Stop pill (overlay) and the page-edge glow. The extension's popup and
 * Settings > Browser change the same values; the newer change (at, epoch ms)
 * wins when they meet.
 */
export interface ChromePresenceSettings {
  overlay: boolean;
  glow: boolean;
  at: number;
}

export interface ChromeLinkState {
  /** False when Codara runs with its Chrome link turned off. */
  enabled: boolean;
  /** The loopback port browsers connect to, or null when none was free. */
  port: number | null;
  error: string | null;
  /** The folder to choose in the browser's "Load unpacked". */
  extensionFolder: string;
  /** The version of the extension in that folder, as this Codara ships it. */
  shippedExtensionVersion: string | null;
  browsers: ChromeLinkBrowserState[];
  /**
   * Extensions that tried to connect lately and speak another link protocol,
   * so they cannot connect until one side is updated. "extension": it is the
   * older one; "codara": this Codara is.
   */
  incompatible: ChromeLinkIncompatibleExtension[];
  pending: ChromeLinkPairing[];
  activity: ChromeLinkActivity[];
  presence: ChromePresenceSettings;
}

/**
 * A browser tool in the user's own Claude Code or Codex config that starts a
 * Chrome of its own (separate profile, "controlled by automated test
 * software") instead of using theirs. While "Keep agents in your Chrome" is
 * on, the sessions Codara starts get it turned off on their command line.
 */
export interface SeparateBrowserTool {
  /** A Claude Code plugin, or an MCP server in a Claude Code or Codex config. */
  kind: "claude-plugin" | "claude-mcp" | "codex-mcp";
  /** The plugin id (name@marketplace) or the server name. */
  name: string;
  launcher: "chrome-devtools-mcp" | "playwright" | "puppeteer";
  /** The config file it was found in. */
  source: string;
}

/** The steps of connecting a browser, in order (Settings > Browser and first run). */
/** "offline": browsers are paired, none is connected now. */
export type ChromeConnectStep = "add" | "pair" | "offline" | "share" | "done";

/**
 * Where the user is in connecting a browser, from what Codara can see: an
 * extension asking to pair (it was added and Connect was pressed), a paired
 * browser, then a tab shared with agents. A pairing request always comes
 * first, so a second browser's code shows even after the first is set up.
 */
export function chromeConnectProgress(state: Pick<ChromeLinkState, "browsers" | "pending">): {
  step: ChromeConnectStep;
  /** Paired browsers connected now: only these count toward share and done. */
  paired: number;
  shared: number;
  /** Names of paired browsers that are not connected now. */
  offline: string[];
} {
  const connected = state.browsers.filter((browser) => browser.connected);
  const offline = state.browsers.filter((browser) => !browser.connected).map((browser) => browser.browser.name || "A browser");
  const paired = connected.length;
  const shared = connected.reduce((sum, browser) => sum + browser.tabs.filter((tab) => !tab.blocked).length, 0);
  const step: ChromeConnectStep =
    state.pending.length > 0 ? "pair" : paired === 0 ? (offline.length > 0 ? "offline" : "add") : shared === 0 ? "share" : "done";
  return { step, paired, shared, offline };
}
