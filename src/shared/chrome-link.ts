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
