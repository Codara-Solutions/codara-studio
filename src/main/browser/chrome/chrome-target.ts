// The "chrome" BrowserTarget backend: tabs the user shared from a connected
// browser. Each tab gets one CdpSession over the extension link, created on
// first use (which attaches chrome.debugger and shows the browser's own
// "started debugging" bar), with the same console and network recorders a
// Codara tab has.

import { CdpSession } from "../cdp-session";
import { startConsoleRecorder } from "../recorders/console";
import { startNetworkRecorder } from "../recorders/network";
import { formatTabRef, type BrowserTabRef } from "../tab-ref";
import {
  evaluateOverCdp,
  type BrowserTabSummary,
  type BrowserTarget,
  type BrowserTargetBackend,
  type BrowserTargetInfo,
} from "../targets";
import type { ChromeLink } from "./link";
import type { ChromeTabInfo } from "./protocol";
import { chromeRelayTransport, type ChromeRelayTransport } from "./relay-transport";

export interface ChromeLinkSource {
  links(): ChromeLink[];
}

export interface ChromeTabSummary extends BrowserTabSummary {
  kind: "chrome";
  browser: string;
  /** An agent's debugger is attached right now. */
  attached: boolean;
  /** The user allowed cookie and storage access for this tab. */
  storage: boolean;
  openedByAgent: boolean;
}

interface SessionEntry {
  link: ChromeLink;
  tabId: number;
  session: CdpSession;
  transport: ChromeRelayTransport;
}

const VIEWPORT_CAPTURE_MS = 5_000;
const BEYOND_VIEWPORT_CAPTURE_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The visible viewport as PNG. A background tab in a visible browser may
 * not paint for a plain capture; capturing "beyond the viewport" clipped to
 * the visible area makes Chromium produce a frame without activating the
 * tab, which Codara never does on its own.
 */
export async function captureChromeViewport(session: CdpSession): Promise<Buffer> {
  try {
    const shot = await withTimeout(
      session.send<{ data: string }>("Page.captureScreenshot", { format: "png" }),
      VIEWPORT_CAPTURE_MS,
      "viewport capture timed out",
    );
    return Buffer.from(shot.data, "base64");
  } catch (error) {
    if (!(error instanceof Error) || !/timed out/.test(error.message)) throw error;
  }
  const view = await evaluateOverCdp<{ x: number; y: number; width: number; height: number }>(
    session,
    "({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })",
  );
  const shot = await withTimeout(
    session.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: view.x, y: view.y, width: view.width, height: view.height, scale: 1 },
    }),
    BEYOND_VIEWPORT_CAPTURE_MS,
    "The browser did not paint the tab in time. Bring its window forward once, or retry.",
  );
  return Buffer.from(shot.data, "base64");
}

export class ChromeTargetBackend implements BrowserTargetBackend {
  readonly kind = "chrome" as const;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly stopReasons = new Map<string, string>();

  constructor(private readonly source: ChromeLinkSource) {}

  /** The id agents pass back: the bare tab id while one browser is connected. */
  refFor(link: ChromeLink, tabId: number): string {
    return formatTabRef({ kind: "chrome", tabId, linkId: this.source.links().length > 1 ? link.linkId : null });
  }

  async list(): Promise<ChromeTabSummary[]> {
    return this.summaries();
  }

  summaries(): ChromeTabSummary[] {
    const out: ChromeTabSummary[] = [];
    for (const link of this.source.links()) {
      for (const tab of link.tabs.values()) {
        if (tab.blocked) continue;
        out.push({
          id: this.refFor(link, tab.tabId),
          kind: "chrome",
          title: tab.title,
          url: tab.url,
          isActive: tab.active,
          browser: link.browser.name,
          attached: tab.attached,
          storage: tab.storage,
          openedByAgent: tab.openedByAgent,
        });
      }
    }
    return out;
  }

  /** The connected browser and shared tab a chrome: id names, or a refusal that says why. */
  locate(ref: Extract<BrowserTabRef, { kind: "chrome" }>): { link: ChromeLink; tab: ChromeTabInfo } {
    const links = this.source.links();
    const id = formatTabRef(ref);
    if (links.length === 0) {
      throw new Error("No browser is connected to Codara. The user connects one from the Codara extension's popup.");
    }
    let candidates: ChromeLink[];
    if (ref.linkId) {
      const link = links.find((entry) => entry.linkId === ref.linkId);
      if (!link) throw new Error(`No connected browser has the id ${ref.linkId}. codara_preview_list shows the current tab ids.`);
      candidates = [link];
    } else {
      candidates = links.length === 1 ? links : links.filter((link) => link.tabs.has(ref.tabId));
      if (candidates.length > 1) {
        throw new Error(`Several connected browsers have a tab ${ref.tabId}. Use the full id from codara_preview_list, such as chrome:${candidates[0].linkId}/${ref.tabId}.`);
      }
    }
    const link = candidates[0];
    const tab = link?.tabs.get(ref.tabId);
    if (!link || !tab) {
      const reason = link ? this.stopReasons.get(`${link.linkId}/${ref.tabId}`) : undefined;
      if (reason === "canceled_by_user") {
        throw new Error(`The user stopped agents in ${id} from the browser's debugging bar. They can share it again from the Codara extension popup.`);
      }
      throw new Error(`${id} is not shared with agents, or it is closed. The user shares a tab from the Codara extension popup; codara_preview_list shows the shared ones.`);
    }
    if (tab.blocked) throw new Error(`${id} is on a site the user blocked for agents.`);
    return { link, tab };
  }

  async resolve(ref: BrowserTabRef | null, params: Record<string, unknown>): Promise<BrowserTarget> {
    if (ref?.kind !== "chrome") throw new Error("Name the Chrome tab to use, as chrome:<tabId> from codara_preview_list.");
    const { link, tab } = this.locate(ref);
    const entry = this.session(link, tab.tabId);
    const session = entry.session;
    const target: BrowserTarget = {
      kind: "chrome",
      ref: this.refFor(link, tab.tabId),
      session,
      workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null,
      async info(): Promise<BrowserTargetInfo> {
        const page = await evaluateOverCdp<{ url: string; title: string; width: number; height: number; dpr: number }>(
          session,
          "({ url: location.href, title: document.title, width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
        ).catch(() => null);
        const current = link.tabs.get(tab.tabId) ?? tab;
        return {
          ref: target.ref,
          kind: "chrome",
          url: page?.url ?? current.url,
          title: page?.title ?? current.title,
          viewport: page ? { width: page.width, height: page.height } : null,
          devicePixelRatio: page?.dpr || 1,
        };
      },
      evaluate: (expression, options) => evaluateOverCdp(session, expression, options),
      captureViewport: () => captureChromeViewport(session),
      // The browser's own debugging bar and the extension's badge show the
      // tab is controlled; there is no in-page cursor to move.
      async showActivity() {},
      storageAllowed: () => (link.tabs.get(tab.tabId) ?? tab).storage === true,
    };
    return target;
  }

  /** The browser went away: its sessions end without a detach (there is nobody to send it to). */
  forgetLink(link: ChromeLink): void {
    for (const [key, entry] of this.sessions) {
      if (entry.link !== link) continue;
      this.drop(key, entry);
    }
  }

  /** Drop the sessions of tabs the browser no longer shares (closed, stopped, blocked). */
  syncTabs(link: ChromeLink): void {
    for (const [key, entry] of this.sessions) {
      if (entry.link !== link) continue;
      const tab = link.tabs.get(entry.tabId);
      if (tab && !tab.blocked) continue;
      this.drop(key, entry);
    }
  }

  dispose(): void {
    for (const [key, entry] of this.sessions) this.drop(key, entry);
  }

  private drop(key: string, entry: SessionEntry): void {
    entry.session.dispose({ detach: false });
    entry.transport.release();
    this.sessions.delete(key);
  }

  private session(link: ChromeLink, tabId: number): SessionEntry {
    const key = `${link.linkId}/${tabId}`;
    const existing = this.sessions.get(key);
    if (existing && existing.link === link && !existing.session.isDisposed) return existing;
    if (existing) this.drop(key, existing);
    const transport = chromeRelayTransport(link, tabId);
    const session = new CdpSession(`chrome:${key}`, transport);
    session.onDetach((reason) => this.stopReasons.set(key, reason));
    this.stopReasons.delete(key);
    startConsoleRecorder(session);
    startNetworkRecorder(session);
    const entry = { link, tabId, session, transport };
    this.sessions.set(key, entry);
    return entry;
  }
}
