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
}

export interface ChromeLinkBrowserState {
  linkId: string;
  browser: { name: string; version: string };
  extensionId: string;
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
  extensionVersion: string | null;
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

export interface ChromeLinkState {
  /** False when Codara runs with its Chrome link turned off. */
  enabled: boolean;
  /** The loopback port browsers connect to, or null when none was free. */
  port: number | null;
  error: string | null;
  /** The folder to choose in the browser's "Load unpacked". */
  extensionFolder: string;
  browsers: ChromeLinkBrowserState[];
  pending: ChromeLinkPairing[];
  activity: ChromeLinkActivity[];
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
