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
   * The connected extension is older than the one Codara ships: "updating"
   * while it reloads itself, "manual" when the user has to reload it in the
   * browser's extensions page. Null when it is current or not connected.
   */
  extensionUpdate: "updating" | "manual" | null;
  allowOpen: boolean;
  tabs: ChromeLinkTabState[];
}

export interface ChromeLinkPairing {
  id: string;
  code: string;
  browser: { name: string; version: string };
  extensionId: string;
  expiresAt: string;
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
export type ChromeConnectStep = "add" | "pair" | "share" | "done";

/**
 * Where the user is in connecting a browser, from what Codara can see: an
 * extension asking to pair (it was added and Connect was pressed), a paired
 * browser, then a tab shared with agents. A pairing request always comes
 * first, so a second browser's code shows even after the first is set up.
 */
export function chromeConnectProgress(state: Pick<ChromeLinkState, "browsers" | "pending">): {
  step: ChromeConnectStep;
  paired: number;
  shared: number;
} {
  const paired = state.browsers.length;
  const shared = state.browsers.reduce((sum, browser) => sum + browser.tabs.filter((tab) => !tab.blocked).length, 0);
  const step: ChromeConnectStep = state.pending.length > 0 ? "pair" : paired === 0 ? "add" : shared === 0 ? "share" : "done";
  return { step, paired, shared };
}
