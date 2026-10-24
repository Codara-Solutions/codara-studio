// One connected browser profile, after the handshake: the tabs it shares,
// requests to it with their answers matched by id, and its protocol events.

import type { WebSocket } from "ws";

import { sanitizeTabs, type ChromeBrowserInfo, type ChromeRequestType, type ChromeTabInfo, type LinkSealer } from "./protocol";

const REQUEST_TIMEOUT_MS = 30_000;

export class ChromeLinkClosedError extends Error {}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type EventListener = (tabId: number, method: string, params: Record<string, unknown>, sessionId: string | null) => void;

export class ChromeLink {
  readonly tabs = new Map<number, ChromeTabInfo>();
  allowOpen = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly detachListeners = new Set<(tabId: number, reason: string) => void>();
  private readonly tabsListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  constructor(
    readonly linkId: string,
    readonly browser: ChromeBrowserInfo,
    readonly extensionId: string,
    readonly extensionVersion: string,
    private readonly socket: Pick<WebSocket, "send" | "close" | "readyState">,
    private readonly sealer: LinkSealer,
    /** What the extension's hello said it can do, such as "reload". */
    readonly extensionFeatures: readonly string[] = [],
  ) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  request<T = unknown>(type: ChromeRequestType, payload: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new ChromeLinkClosedError(`${this.browser.name} disconnected from Codara.`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.browser.name} did not answer ${type === "cdp" ? String(payload.method) : type} in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ ...payload, id, type });
    });
  }

  send(message: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.socket.send(this.sealer.seal(message));
    } catch {
      // A socket closing under us reports through close().
    }
  }

  /** A raw frame from the extension after the handshake; throws LinkSealError when it does not open. */
  open(frame: unknown): Record<string, unknown> {
    return this.sealer.open(frame);
  }

  /** A frame from the extension after the handshake, opened. */
  handle(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && !("type" in message)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      const error = message.error as { message?: unknown } | undefined;
      if (error) waiter.reject(new Error(typeof error.message === "string" ? error.message : "The browser refused the request."));
      else waiter.resolve(message.result ?? {});
      return;
    }
    switch (message.type) {
      case "tabs": {
        this.tabs.clear();
        for (const tab of sanitizeTabs(message.tabs)) this.tabs.set(tab.tabId, tab);
        this.allowOpen = message.allowOpen === true;
        for (const listener of this.tabsListeners) listener();
        return;
      }
      case "cdp_event": {
        if (typeof message.tabId !== "number" || typeof message.method !== "string") return;
        const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
        for (const listener of this.eventListeners) listener(message.tabId, message.method, params, sessionId);
        return;
      }
      case "detached": {
        if (typeof message.tabId !== "number") return;
        const tab = this.tabs.get(message.tabId);
        if (tab) tab.attached = false;
        const reason = typeof message.reason === "string" ? message.reason : "detached";
        for (const listener of this.detachListeners) listener(message.tabId, reason);
        return;
      }
      case "ping":
        this.send({ type: "pong" });
        return;
      default:
        return;
    }
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDetached(listener: (tabId: number, reason: string) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  onTabs(listener: () => void): () => void {
    this.tabsListeners.add(listener);
    return () => this.tabsListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** The socket closed (or we close it): fail what is waiting and tell every listener once. */
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new ChromeLinkClosedError(`${this.browser.name} disconnected from Codara.`));
      this.pending.delete(id);
    }
    try {
      if (this.socket.readyState === 1 || this.socket.readyState === 0) this.socket.close(code, reason);
    } catch {
      /* already closed */
    }
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}
