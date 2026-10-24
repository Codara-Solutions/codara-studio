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

import type { ChromeLinkState, SeparateBrowserTool } from "../../../shared/chrome-link";
import { latestSessionStart } from "../../agent-session-registry";
import { codaraHome } from "../../codara-home";
import type { IpcHandle } from "../../ipc";
import { terminalAgentStateSnapshot } from "../../terminal-agent-notify";
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

const RUNTIME_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  gemini: "Gemini CLI",
  pi: "Cora",
  opencode: "opencode",
  aider: "aider",
  amp: "Amp",
  droid: "Droid",
};

/** "Codex in pane 3f2a" for the activity log and the extension's popup. */
function agentLabel(params: Record<string, unknown>): string {
  const runId = typeof params.runId === "string" ? params.runId : "";
  if (runId) return `Cora run ${runId.slice(0, 8)}`;
  const paneId = typeof params.callerPaneId === "string" ? params.callerPaneId : "";
  if (!paneId) return "An agent outside Codara's terminals";
  const runtime = terminalAgentStateSnapshot().find((pane) => pane.paneId === paneId)?.runtime ?? latestSessionStart(paneId)?.runtime ?? null;
  const name = runtime ? RUNTIME_NAMES[runtime] ?? runtime : "Agent";
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
            }))
          : [],
      };
    }),
    pending: server?.pendingPairings().map(({ id, code, browser, extensionId, expiresAt }) => ({ id, code, browser, extensionId, expiresAt })) ?? [],
    activity: recentChromeActivity(50),
  };
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
  const linkServer = new ChromeLinkServer({ store, app: { name: "Codara", version: app.getVersion() }, ports: linkPorts() });
  const chromeBackend = new ChromeTargetBackend(linkServer);
  server = linkServer;
  backend = chromeBackend;
  setChromeLinkRuntime({ server: linkServer, backend: chromeBackend });
  linkServer.onLinkUp((link) => {
    link.onTabs(() => chromeBackend.syncTabs(link));
    unregisterBackend ??= registerBrowserBackend(chromeBackend);
    offerExtensionUpdate(link);
  });
  linkServer.onLinkDown((link) => {
    chromeBackend.forgetLink(link);
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
  setChromeUsageSink((entry, ref) => {
    const links = linkServer.links();
    const link = ref.linkId ? linkServer.link(ref.linkId) : links.find((candidate) => candidate.tabs.has(ref.tabId));
    link?.send({ type: "usage", tabId: ref.tabId, agent: entry.agent, tool: entry.tool, at: Date.parse(entry.at) });
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
  handle("chromeLink:disconnect", async (_event, linkId: unknown): Promise<boolean> =>
    typeof linkId === "string" ? server?.unpair(linkId) ?? false : false,
  );
  // Reading the list also re-applies it, so a tool the user added since boot
  // is off for the next session once Settings shows it.
  handle("chromeLink:separateBrowserTools", async (): Promise<SeparateBrowserTool[]> => applyKeepAgentsInChrome());
  handle("chromeLink:prepareExtension", async (): Promise<string> => prepareExtensionFolder(true));
  handle("chromeLink:revealExtension", async (): Promise<string> => {
    const folder = prepareExtensionFolder(true);
    const failure = await shell.openPath(folder);
    if (failure) shell.showItemInFolder(join(folder, "manifest.json"));
    return folder;
  });
}
