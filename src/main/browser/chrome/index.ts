// Boot and IPC entry of the Chrome extension link (the loopback server, the
// pairing prompt, the "chrome" browser backend). index.ts and ipc.ts call
// these once, so the work behind them never edits either shared file. The
// renderer side is window.spark.chromeLink (src/preload/areas/chrome-link.ts).
//
// Nothing here writes into a browser profile or any configuration outside
// Codara's own home: the pairings and the activity log live in
// <codara home>/chrome-link/, and the extension the user loads is a copy in
// <codara home>/chrome-extension/, so its path survives app updates.

import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChromeLinkState, ChromePresenceSettings, SeparateBrowserTool } from "../../../shared/chrome-link";
import { codaraHome } from "../../codara-home";
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
import { extensionManifestVersion, extensionUpdateAction, syncExtensionFolder } from "./extension-update";
import type { ChromeLink } from "./link";
import { ChromeLinkServer } from "./link-server";
import { applyKeepAgentsInChrome } from "./keep-agents-in-chrome";
import { ChromeLinkStore } from "./link-store";
import { adoptPresenceSettings, chromeLinkDown, chromeStopList, chromeStops, forgetChromeStops, keepChromeStopsFor, loadChromeStops, loadPresenceSettings, presenceSettings, setChromeStopsListener, stopChromeDriver } from "./presence";
import { CHROME_LINK_PORTS } from "./protocol";
import { setChromeLinkRuntime } from "./runtime";

let server: ChromeLinkServer | null = null;
let store: ChromeLinkStore | null = null;
let backend: ChromeTargetBackend | null = null;
let unregisterBackend: (() => void) | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
// The reloads asked for in this run, by link: the version asked for and when.
const reloadAsks = new Map<string, { version: string; at: number }>();
// How long a reload may take before Settings tells the user to do it.
const RELOAD_GRACE_MS = 15_000;

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

/** Copy the extension Codara ships into its own home, where Load unpacked points, unless the copy already matches it. */
export function prepareExtensionFolder(force = false): string {
  const source = bundledExtensionDir();
  const target = extensionFolder();
  if (!source) throw new Error("This Codara build does not include the browser extension.");
  syncExtensionFolder(source, target, force);
  return target;
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

function updateAction(link: ChromeLink): "none" | "reload" | "manual" {
  const shipped = shippedExtensionVersion();
  return extensionUpdateAction(link.extensionVersion, link.extensionFeatures, shipped, reloadAsks.get(link.linkId)?.version === shipped);
}

/** What Settings says about a connected extension older than the one Codara ships. */
function extensionUpdateState(link: ChromeLink | undefined): "updating" | "manual" | null {
  if (!link) return null;
  const action = updateAction(link);
  if (action === "none") return null;
  const asked = reloadAsks.get(link.linkId);
  if (action === "reload" || (asked && Date.now() - asked.at < RELOAD_GRACE_MS)) return "updating";
  return "manual";
}

/** Ask a connected extension older than the copy on disk to reload itself, once per version in this run. */
function offerExtensionUpdate(link: ChromeLink): void {
  const shipped = shippedExtensionVersion();
  if (!shipped || updateAction(link) !== "reload") return;
  reloadAsks.set(link.linkId, { version: shipped, at: Date.now() });
  link.send({ type: "reload", version: shipped });
  // Settings says "updating" until the extension is back or the grace ends.
  setTimeout(broadcast, RELOAD_GRACE_MS + 100).unref?.();
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
      return {
        linkId: paired.linkId,
        browser: paired.browser,
        extensionId: paired.extensionId,
        pairedAt: paired.pairedAt,
        lastSeenAt: paired.lastSeenAt,
        connected: Boolean(link),
        extensionVersion: link?.extensionVersion || null,
        extensionUpdate: extensionUpdateState(link),
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
            }))
          : [],
      };
    }),
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
  link.send({ type: "presence_stops", stops: chromeStopList(link.linkId), ...(acked ? { acked } : {}) });
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
  loadChromeStops(join(dir, "presence-stops.json"));
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
    offerExtensionUpdate(link);
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
  try {
    // Keep a copy the user already loaded current with this Codara: any
    // changed file, not only a new version. The extension reloads itself
    // when it connects (offerExtensionUpdate).
    if (existsSync(extensionFolder())) prepareExtensionFolder();
  } catch (error) {
    console.warn("[chrome-link] could not refresh the extension folder:", error);
  }
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
  handle("chromeLink:prepareExtension", async (): Promise<string> => prepareExtensionFolder(true));
  handle("chromeLink:revealExtension", async (): Promise<string> => {
    const folder = prepareExtensionFolder(true);
    const failure = await shell.openPath(folder);
    if (failure) shell.showItemInFolder(join(folder, "manifest.json"));
    return folder;
  });
}
