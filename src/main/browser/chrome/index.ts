// Boot and IPC entry of the Chrome extension link (the loopback server, the
// pairing prompt, the "chrome" browser backend). index.ts and ipc.ts call
// these once, so the work behind them never edits either shared file. The
// renderer side is window.spark.chromeLink (src/preload/areas/chrome-link.ts).
//
// Nothing here writes into a browser profile or any configuration outside
// Codara's own home: the pairings and the activity log live in
// <codara home>/chrome-link/, and the extension the user loads is a copy in
// <codara home>/chrome-extension/, so its path survives app updates. That copy
// changes only when the user asks (extension-update.ts).

import { app, BrowserWindow, shell } from "electron";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ChromeLinkIncompatibleExtension, ChromeLinkState, ChromePresenceSettings, SeparateBrowserTool } from "../../../shared/chrome-link";
import { codaraHome, LEGACY_DIR_NAMES } from "../../codara-home";
import type { IpcHandle } from "../../ipc";
import { paneAgentRuntime } from "../../pane-agent-runtime";
import { runtimeDisplayName } from "../agent-driver";
import { registerBrowserBackend } from "../targets";
import {
  onChromeActivity,
  recentChromeActivity,
  setChromeActivityFile,
  setChromeAgentLabeler,
  setChromeUsageSink,
} from "./activity";
import { ChromeTargetBackend } from "./chrome-target";
import {
  ensureExtensionFolder,
  extensionManifestVersion,
  extensionUpdateState,
  syncExtensionFolder,
  unpackedExtensionIds,
  type ExtensionUpdateAsk,
} from "./extension-update";
import type { ChromeLink } from "./link";
import { ChromeLinkServer } from "./link-server";
import { applyKeepAgentsInChrome } from "./keep-agents-in-chrome";
import { ChromeLinkStore } from "./link-store";
import { adoptPresenceSettings, chromeLinkDown, chromePausedTabs, chromeStopList, chromeStops, setChromeConnectedLinks, forgetChromeStops, keepChromeStopsFor, loadChromeStops, loadPresenceSettings, presenceSettings, setChromeStopsListener, stopChromeDriver } from "./presence";
import { CHROME_LINK_PORTS, CHROME_LINK_PROTOCOL } from "./protocol";
import { setChromeLinkRuntime } from "./runtime";

let server: ChromeLinkServer | null = null;
let store: ChromeLinkStore | null = null;
let backend: ChromeTargetBackend | null = null;
let unregisterBackend: (() => void) | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
// The updates the user asked for in this run, by link: the version and when.
// A reload is sent only from here, never because a browser connected.
const reloadAsks = new Map<string, ExtensionUpdateAsk>();
// Protocol-refused extensions whose folder the user already updated.
const copiedFor = new Set<string>();
// How long a reload may take before Settings tells the user to do it.
const RELOAD_GRACE_MS = 15_000;
// How long Settings lists an extension refused for its protocol; it retries every 30 s.
const REFUSED_SHOWN_MS = 5 * 60_000;

/** "Codex in pane 3f2a" for the activity log and the extension's popup. */
function agentLabel(params: Record<string, unknown>): string {
  const runId = typeof params.runId === "string" ? params.runId : "";
  if (runId) return `Cora run ${runId.slice(0, 8)}`;
  const paneId = typeof params.callerPaneId === "string" ? params.callerPaneId : "";
  if (!paneId) return "An agent outside Codara's terminals";
  const name = runtimeDisplayName(paneAgentRuntime(paneId)) ?? "Agent";
  return `${name} in pane ${paneId.slice(-6)}`;
}

function linkPorts(): readonly number[] {
  const raw = process.env.CODARA_CHROME_LINK_PORTS?.trim();
  if (!raw) return CHROME_LINK_PORTS;
  const ports = raw.split(",").map((part) => Number(part.trim())).filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return ports.length ? ports : CHROME_LINK_PORTS;
}

function bundledExtensionDir(): string | null {
  if (app.isPackaged) return join(process.resourcesPath, "chrome-extension");
  let current = app.getAppPath();
  for (let depth = 0; depth <= 4; depth += 1) {
    const candidate = join(current, "extensions", "chrome");
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function extensionFolder(): string {
  return join(codaraHome(), "chrome-extension");
}

function shippedExtensionDir(): string {
  const source = bundledExtensionDir();
  if (!source) throw new Error("This Codara build does not include the browser extension.");
  return source;
}

// The version in Codara's folder, read once and again after Codara copies into it.
let folderVersionCache: string | null | undefined;

function folderVersion(): string | null {
  if (folderVersionCache === undefined) folderVersionCache = extensionManifestVersion(extensionFolder());
  return folderVersionCache;
}

/** The folder for Load unpacked, copied there the first time only: a copy the user already loaded changes only through Update extension. */
export function prepareExtensionFolder(): string {
  const target = extensionFolder();
  try {
    ensureExtensionFolder(shippedExtensionDir(), target);
  } finally {
    folderVersionCache = undefined;
  }
  return target;
}

/** The user pressed Update extension: the folder gets the files this Codara ships. */
function refreshExtensionFolder(): void {
  try {
    syncExtensionFolder(shippedExtensionDir(), extensionFolder());
  } finally {
    folderVersionCache = undefined;
  }
}

let folderIds: { folder: string; ids: Set<string> } | null = null;

/**
 * Whether Chrome loaded this extension from Codara's folder, by the id an
 * unpacked load of that folder gets. A home moved by an older Codara left a
 * link at its old path, and Chrome keeps the path it was given.
 */
function fromCodaraFolder(extensionId: string): boolean {
  const folder = extensionFolder();
  if (folderIds?.folder !== folder) {
    let real: string;
    try {
      real = realpathSync.native(folder);
    } catch {
      // Not copied yet: its resolved path is unknown, so nothing is kept for later.
      return unpackedExtensionIds([folder]).has(extensionId);
    }
    const linked = LEGACY_DIR_NAMES.map((name) => join(homedir(), name, "chrome-extension")).filter((candidate) => {
      try {
        return candidate !== folder && realpathSync.native(candidate) === real;
      } catch {
        return false;
      }
    });
    folderIds = { folder, ids: unpackedExtensionIds([folder, ...linked]) };
  }
  return folderIds.ids.has(extensionId);
}

let shippedVersion: string | null | undefined;

/** The version of the extension this Codara ships, read once. */
function shippedExtensionVersion(): string | null {
  if (shippedVersion === undefined) {
    const source = bundledExtensionDir();
    shippedVersion = source ? extensionManifestVersion(source) : null;
  }
  return shippedVersion;
}

/** What Settings says about a connected extension older than the one Codara ships. */
function updateStateOf(link: ChromeLink | undefined): ChromeLinkState["browsers"][number]["extensionUpdate"] {
  if (!link) return null;
  return extensionUpdateState({
    running: link.extensionVersion,
    features: link.extensionFeatures,
    shipped: shippedExtensionVersion(),
    fromCodaraFolder: fromCodaraFolder(link.extensionId),
    asked: reloadAsks.get(link.linkId),
    folderVersion: folderVersion(),
    now: Date.now(),
    graceMs: RELOAD_GRACE_MS,
  });
}

function incompatibleExtensions(): ChromeLinkIncompatibleExtension[] {
  return (server?.refusedExtensions(REFUSED_SHOWN_MS) ?? []).map((refused) => ({
    extensionId: refused.extensionId,
    version: refused.version,
    browser: refused.browser,
    update: refused.protocol > CHROME_LINK_PROTOCOL ? "codara" : "extension",
    fromCodaraFolder: fromCodaraFolder(refused.extensionId),
    copied: copiedFor.has(refused.extensionId),
  }));
}

/**
 * The user pressed Update extension, or Reload extension. For a connected
 * browser: the folder gets the new files (unless it already holds them) and
 * that browser's extension, only that one, is asked to reload itself.
 * For an extension refused for its protocol: the folder gets the new files
 * and Settings says to press reload in the browser.
 */
function updateExtension(which: { linkId?: unknown; extensionId?: unknown }): void {
  const shipped = shippedExtensionVersion();
  if (!shipped) throw new Error("This Codara build does not include the browser extension.");
  if (typeof which.linkId === "string") {
    const link = server?.link(which.linkId);
    if (!link) throw new Error("That browser is not connected. Open it, then press Update extension again.");
    const state = updateStateOf(link);
    if (state === null) return;
    if (state === "elsewhere") throw new Error("This extension was not loaded from Codara's folder, so Codara does not update it.");
    // "reload": another browser's Update already put the new version in the shared folder.
    if (state !== "reload") refreshExtensionFolder();
    reloadAsks.set(link.linkId, { version: shipped, at: Date.now() });
    if (link.extensionFeatures.includes("reload")) link.send({ type: "reload", version: shipped });
    // Settings says "updating" until the extension is back or the grace ends.
    setTimeout(broadcast, RELOAD_GRACE_MS + 100).unref?.();
    broadcast();
    return;
  }
  const refused = incompatibleExtensions().find((entry) => entry.extensionId === which.extensionId);
  if (!refused) throw new Error("That extension is no longer trying to connect.");
  if (refused.update !== "extension" || !refused.fromCodaraFolder) throw new Error("Codara cannot update this extension from here.");
  refreshExtensionFolder();
  copiedFor.add(refused.extensionId);
  broadcast();
}

export function chromeLinkState(): ChromeLinkState {
  const live = new Map((server?.links() ?? []).map((link) => [link.linkId, link]));
  const refFor = (linkId: string, tabId: number) => {
    const link = live.get(linkId);
    return link && backend ? backend.refFor(link, tabId) : `chrome:${tabId}`;
  };
  return {
    enabled: server !== null,
    port: server?.port ?? null,
    error: server?.error ?? null,
    extensionFolder: extensionFolder(),
    shippedExtensionVersion: shippedExtensionVersion(),
    browsers: (store?.list() ?? []).map((paired) => {
      const link = live.get(paired.linkId);
      const stopped = chromeStops(paired.linkId);
      const paused = chromePausedTabs(paired.linkId);
      return {
        linkId: paired.linkId,
        browser: paired.browser,
        extensionId: paired.extensionId,
        pairedAt: paired.pairedAt,
        lastSeenAt: paired.lastSeenAt,
        connected: Boolean(link),
        extensionVersion: link?.extensionVersion || null,
        extensionUpdate: updateStateOf(link),
        extensionReloads: link?.extensionFeatures.includes("reload") ?? false,
        allowOpen: link?.allowOpen ?? false,
        tabs: link
          ? [...link.tabs.values()].map((tab) => ({
              id: refFor(paired.linkId, tab.tabId),
              title: tab.title,
              url: tab.url,
              active: tab.active,
              attached: tab.attached,
              storage: tab.storage,
              blocked: tab.blocked,
              openedByAgent: tab.openedByAgent,
              stopped: stopped.get(tab.tabId) ?? [],
              paused: paused === "all" || paused.includes(tab.tabId),
            }))
          : [],
      };
    }),
    incompatible: incompatibleExtensions(),
    pending: server?.pendingPairings().map(({ id, code, browser, extensionId, expiresAt }) => ({ id, code, browser, extensionId, expiresAt })) ?? [],
    activity: recentChromeActivity(50),
    presence: presenceSettings(),
  };
}

function sendPresenceSettings(except?: ChromeLink): void {
  for (const link of server?.links() ?? []) {
    if (link !== except) link.send({ type: "presence_settings", ...presenceSettings() });
  }
}

/** What the extension tells Codara about the agent's presence on its tabs. */
function onPresenceMessage(link: ChromeLink, message: Record<string, unknown>): void {
  if (message.type === "presence_settings") {
    if (adoptPresenceSettings(message)) {
      sendPresenceSettings(link);
      broadcast();
    } else if (presenceSettings().at > (typeof message.at === "number" ? message.at : 0)) {
      link.send({ type: "presence_settings", ...presenceSettings() });
    }
    return;
  }
  if (message.type !== "presence_stop" && message.type !== "presence_allow") return;
  const acked = typeof message.id === "string" && /^[\w-]{1,64}$/.test(message.id) ? message.id : null;
  if (typeof message.tabId === "number" && typeof message.key === "string" && message.key) {
    // Stop (on the page or in the popup) refuses that agent's next calls on
    // that tab only, until the user gives the tab back from the popup or Settings.
    // A tab that is no longer shared has nothing to stop. A Stop sent right
    // after a reconnect comes before the tab list: kept, and the list that
    // follows ends it if that tab is no longer shared.
    const stop = message.type === "presence_stop";
    const session = typeof message.session === "string" && /^[\w-]{8,64}$/.test(message.session) ? message.session : link.session;
    if (!stop || !link.tabsReported || link.tabs.has(message.tabId)) {
      stopChromeDriver(link.linkId, message.tabId, message.key, stop, typeof message.name === "string" ? message.name : undefined, session);
    }
  }
  // The extension shows a stop only once Codara confirms it with its list.
  sendStops(link, acked);
  broadcast();
}

/** Codara owns the stop list; the extension replaces its copy with this. */
function sendStops(link: ChromeLink, acked: string | null = null): void {
  link.send({ type: "presence_stops", stops: chromeStopList(link.linkId), paused: chromePausedTabs(link.linkId), ...(acked ? { acked } : {}) });
}

function broadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const state = chromeLinkState();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("chromeLink:changed", state);
      } catch {
        // A renderer may close between enumeration and send.
      }
    }
  }, 100);
}

/** After the agent socket and the window exist. */
export function startChromeLink(): void {
  if (server || process.env.CODARA_CHROME_LINK === "0") return;
  const dir = join(codaraHome(), "chrome-link");
  store = new ChromeLinkStore(join(dir, "links.json"));
  setChromeActivityFile(join(dir, "activity.jsonl"));
  setChromeAgentLabeler(agentLabel);
  loadPresenceSettings(join(dir, "presence.json"));
  loadChromeStops(join(dir, "presence-stops.json"), store.list().map((paired) => paired.linkId));
  setChromeConnectedLinks(() => server?.links().map((link) => link.linkId) ?? []);
  setChromeStopsListener((linkId) => {
    const link = server?.links().find((candidate) => candidate.linkId === linkId);
    if (link) sendStops(link);
    broadcast();
  });
  const linkServer = new ChromeLinkServer({ store, app: { name: "Codara", version: app.getVersion() }, ports: linkPorts() });
  const chromeBackend = new ChromeTargetBackend(linkServer);
  server = linkServer;
  backend = chromeBackend;
  setChromeLinkRuntime({ server: linkServer, backend: chromeBackend });
  linkServer.onLinkUp((link) => {
    link.onTabs(() => {
      chromeBackend.syncTabs(link);
      keepChromeStopsFor(link.linkId, link.session, link.tabs.keys());
    });
    link.onMessage((message) => onPresenceMessage(link, message));
    link.send({ type: "presence_settings", ...presenceSettings() });
    sendStops(link);
    unregisterBackend ??= registerBrowserBackend(chromeBackend);
  });
  linkServer.onLinkDown((link) => {
    chromeBackend.forgetLink(link);
    chromeLinkDown(link.linkId, Boolean(store?.list().some((paired) => paired.linkId === link.linkId)));
    if (linkServer.links().length === 0) {
      unregisterBackend?.();
      unregisterBackend = null;
    }
  });
  linkServer.onPairingRequest(() => {
    // The prompt is in the window; make sure the user notices it.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.isFocused()) window.flashFrame(true);
    }
  });
  linkServer.onChange(broadcast);
  onChromeActivity(broadcast);
  setChromeUsageSink((entry, ref, driver) => {
    const links = linkServer.links();
    const link = ref.linkId ? linkServer.link(ref.linkId) : links.find((candidate) => candidate.tabs.has(ref.tabId));
    link?.send({
      type: "usage",
      tabId: ref.tabId,
      agent: entry.agent,
      tool: entry.tool,
      at: Date.parse(entry.at),
      ...(driver ? { key: driver.key, name: driver.name, runtime: driver.runtime } : {}),
    });
  });
  void linkServer.start().then((port) => {
    if (port === null) console.warn(`[chrome-link] ${linkServer.error}`);
  });
  app.once("will-quit", () => {
    chromeBackend.dispose();
    void linkServer.stop();
  });
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerChromeLinkIpc(handle: IpcHandle): void {
  handle("chromeLink:state", async (): Promise<ChromeLinkState> => chromeLinkState());
  handle("chromeLink:approve", async (_event, id: unknown): Promise<boolean> => (typeof id === "string" ? server?.approve(id) ?? false : false));
  handle("chromeLink:deny", async (_event, id: unknown): Promise<boolean> => (typeof id === "string" ? server?.deny(id) ?? false : false));
  handle("chromeLink:disconnect", async (_event, linkId: unknown): Promise<boolean> => {
    if (typeof linkId !== "string") return false;
    forgetChromeStops(linkId);
    return server?.unpair(linkId) ?? false;
  });
  // Give a tab back to an agent the user stopped there from the page.
  handle("chromeLink:giveBack", async (_event, linkId: unknown, tabId: unknown, key: unknown): Promise<boolean> => {
    if (typeof linkId !== "string" || typeof tabId !== "number" || typeof key !== "string") return false;
    // The extension's copy follows from the list Codara sends (now, or when it reconnects).
    stopChromeDriver(linkId, tabId, key, false);
    return true;
  });
  // Reading the list also re-applies it, so a tool the user added since boot
  // is off for the next session once Settings shows it.
  handle("chromeLink:separateBrowserTools", async (): Promise<SeparateBrowserTool[]> => applyKeepAgentsInChrome());
  handle("chromeLink:setPresence", async (_event, patch: unknown): Promise<ChromePresenceSettings> => {
    const changes = patch && typeof patch === "object" ? (patch as Partial<ChromePresenceSettings>) : {};
    const current = presenceSettings();
    const next = {
      overlay: typeof changes.overlay === "boolean" ? changes.overlay : current.overlay,
      glow: typeof changes.glow === "boolean" ? changes.glow : current.glow,
      at: Math.max(Date.now(), current.at + 1),
    };
    if (adoptPresenceSettings(next)) {
      sendPresenceSettings();
      broadcast();
    }
    return presenceSettings();
  });
  handle("chromeLink:prepareExtension", async (): Promise<string> => prepareExtensionFolder());
  handle("chromeLink:revealExtension", async (): Promise<string> => {
    const folder = prepareExtensionFolder();
    const failure = await shell.openPath(folder);
    if (failure) shell.showItemInFolder(join(folder, "manifest.json"));
    return folder;
  });
  handle("chromeLink:updateExtension", async (_event, which: unknown): Promise<void> => {
    if (!which || typeof which !== "object") throw new Error("Which extension to update is missing.");
    updateExtension(which as { linkId?: unknown; extensionId?: unknown });
  });
}
