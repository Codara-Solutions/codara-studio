// One DevTools protocol session per browser tab, shared by every feature that
// needs the protocol (trusted input, console and network recording,
// emulation, audits, recording). It knows nothing about Electron: a preview
// tab plugs in webContents.debugger (preview-cdp.ts) and a Chrome tab plugs in
// chrome.debugger relayed over the extension link, behind the same transport.
//
// Several consumers share a domain by reference count: the first enable()
// sends `<Domain>.enable`, the last release sends `<Domain>.disable` (unless
// the domain is sticky, like Network, which records from the moment a tab
// opens). After the transport re-attaches, every domain still held is
// enabled again with the parameters of its first enable.

export type CdpEventListener = (params: Record<string, unknown>, method: string) => void;

export interface CdpTransport {
  /**
   * Attach if needed. Idempotent; throws (or rejects) when the target refuses
   * a client. Electron attaches synchronously, chrome.debugger does not.
   */
  attach(): void | Promise<void>;
  isAttached(): boolean;
  /** Our own detach. A target that is gone needs none. */
  detach(): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Protocol events; returns the unsubscribe. */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  /** The transport lost its client (target closed, another client took over, crash). */
  onDetach(listener: (reason: string) => void): () => void;
  /**
   * Whether the session may attach again on its own after this detach. When
   * the user dismissed the browser's debugging bar, attaching again would
   * undo their choice, so a transport answers false and the next call that
   * needs the protocol decides instead. Omitted means always.
   */
  reattachAfter?(reason: string): boolean;
}

/** A bounded, insertion-ordered buffer; the oldest entries fall off. */
export class RingBuffer<T> {
  private items: T[] = [];
  private droppedCount = 0;

  constructor(readonly capacity: number) {}

  push(item: T): T | undefined {
    this.items.push(item);
    if (this.items.length <= this.capacity) return undefined;
    this.droppedCount += 1;
    return this.items.shift();
  }

  toArray(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  /** How many entries fell off since the last clear. */
  get dropped(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.items = [];
    this.droppedCount = 0;
  }

  /**
   * Carry another buffer's entries over (a tab whose page process was
   * replaced). They are older than anything recorded here, so they go first
   * and are the first to fall off.
   */
  adopt(other: RingBuffer<T>): void {
    const merged = [...other.items, ...this.items];
    const excess = Math.max(0, merged.length - this.capacity);
    this.items = merged.slice(excess);
    this.droppedCount += other.droppedCount + excess;
  }
}

interface DomainState {
  count: number;
  params?: Record<string, unknown>;
  enabled: Promise<void> | null;
}

export interface CdpSessionOptions {
  /** Domains never disabled once enabled. */
  stickyDomains?: readonly string[];
  /** How long to wait for a re-attach after an unexpected detach. */
  reattachDelayMs?: number;
}

export class CdpSession {
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly anyListeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private readonly domains = new Map<string, DomainState>();
  private readonly rings = new Map<string, RingBuffer<unknown>>();
  private readonly sticky: Set<string>;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly detachListeners = new Set<(reason: string) => void>();
  private readonly disposeListeners = new Set<() => void>();
  private readonly reattachDelayMs: number;
  private disposed = false;
  private lastAttachError: string | null = null;
  private attaching: Promise<boolean> | null = null;
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly key: string,
    private readonly transport: CdpTransport,
    options: CdpSessionOptions = {},
  ) {
    this.sticky = new Set(options.stickyDomains ?? ["Network", "Page", "Runtime", "Log"]);
    this.reattachDelayMs = options.reattachDelayMs ?? 50;
    this.unsubscribe.push(transport.onEvent((method, params) => this.dispatch(method, params)));
    this.unsubscribe.push(transport.onDetach((reason) => this.handleDetach(reason)));
    void this.tryAttach();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Why the last attach failed, or null while the session is usable. */
  get unavailableReason(): string | null {
    return this.transport.isAttached() ? null : this.lastAttachError;
  }

  isAttached(): boolean {
    return !this.disposed && this.transport.isAttached();
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureAttached();
    return (await this.transport.send(method, params)) as T;
  }

  /**
   * Hold a domain enabled. Resolves once the enable command answered (which,
   * for a tab that has not loaded a page yet, is after its first navigation),
   * and returns the release.
   */
  async enable(domain: string, params?: Record<string, unknown>): Promise<() => Promise<void>> {
    const state = this.domains.get(domain) ?? { count: 0, enabled: null };
    if (!this.domains.has(domain)) this.domains.set(domain, state);
    state.count += 1;
    if (state.count === 1 && params) state.params = params;
    if (!state.enabled) state.enabled = this.sendEnable(domain, state);
    try {
      await state.enabled;
    } catch (error) {
      state.count -= 1;
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      state.count -= 1;
      if (state.count > 0 || this.sticky.has(domain) || this.disposed) return;
      state.enabled = null;
      this.domains.delete(domain);
      if (this.transport.isAttached()) await this.transport.send(`${domain}.disable`).catch(() => {});
    };
  }

  /** Enable a domain for the life of the session without awaiting it. */
  hold(domain: string, params?: Record<string, unknown>): void {
    void this.enable(domain, params).catch(() => {});
  }

  on(method: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set?.delete(listener);
  }

  onAny(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  /** Fires after an unexpected detach, before any re-attach. */
  onDetach(listener: (reason: string) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  /** Fires once when the session ends for good: its tab closed or its page was replaced. */
  onDispose(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.disposeListeners.add(listener);
    return () => this.disposeListeners.delete(listener);
  }

  /** A named buffer that lives as long as the session (and moves with the tab). */
  ring<T>(name: string, capacity: number): RingBuffer<T> {
    let ring = this.rings.get(name);
    if (!ring) this.rings.set(name, (ring = new RingBuffer<unknown>(capacity)));
    return ring as RingBuffer<T>;
  }

  /** Move another session's buffers into this one (a guest replaced under the same tab). */
  adoptRings(from: ReadonlyMap<string, RingBuffer<unknown>>): void {
    for (const [name, ring] of from) this.ring(name, ring.capacity).adopt(ring);
  }

  ringsSnapshot(): ReadonlyMap<string, RingBuffer<unknown>> {
    return new Map(this.rings);
  }

  dispose(options: { detach?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reattachTimer) clearTimeout(this.reattachTimer);
    for (const off of this.unsubscribe.splice(0)) off();
    this.listeners.clear();
    this.anyListeners.clear();
    this.detachListeners.clear();
    this.domains.clear();
    if (options.detach !== false && this.transport.isAttached()) {
      try {
        this.transport.detach();
      } catch {
        /* the target may already be gone */
      }
    }
    // Last, so what a listener sends fails at once instead of reaching a
    // target that is going away.
    const ending = [...this.disposeListeners];
    this.disposeListeners.clear();
    for (const listener of ending) {
      try {
        listener();
      } catch {
        /* one listener's failure does not keep the others from running */
      }
    }
  }

  private async ensureAttached(): Promise<void> {
    if (this.disposed) throw new Error("This browser tab closed.");
    if (this.transport.isAttached()) return;
    if (!(await this.tryAttach())) {
      throw new Error(
        `Codara could not attach the DevTools protocol to this tab (${this.lastAttachError}). ` +
        "Close any other debugger attached to it, then retry.",
      );
    }
  }

  private tryAttach(): Promise<boolean> {
    if (this.attaching) return this.attaching;
    const attempt = (async () => {
      try {
        await this.transport.attach();
        this.lastAttachError = null;
      } catch (error) {
        this.lastAttachError = error instanceof Error ? error.message : String(error);
        return false;
      }
      // Whatever path attached (the re-attach timer or a call after a failed
      // attempt), the held domains must be enabled again, or the recorders
      // stay silent on a session that looks healthy.
      this.restoreDomains();
      return true;
    })();
    this.attaching = attempt;
    void attempt.finally(() => {
      if (this.attaching === attempt) this.attaching = null;
    });
    return attempt;
  }

  private async sendEnable(domain: string, state: DomainState): Promise<void> {
    try {
      await this.ensureAttached();
      await this.transport.send(`${domain}.enable`, state.params);
    } catch (error) {
      state.enabled = null;
      throw error;
    }
  }

  private dispatch(method: string, params: Record<string, unknown>): void {
    if (this.disposed) return;
    for (const listener of this.anyListeners) listener(method, params);
    const set = this.listeners.get(method);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(params, method);
      } catch (error) {
        console.warn(`[cdp-session] ${method} listener failed:`, error);
      }
    }
  }

  private handleDetach(reason: string): void {
    if (this.disposed) return;
    for (const listener of this.detachListeners) listener(reason);
    for (const state of this.domains.values()) state.enabled = null;
    if (this.reattachTimer) clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
    if (this.transport.reattachAfter?.(reason) === false) return;
    // A target that is still alive lost its client (a crash, another
    // debugger taking over): attach again and restore what consumers hold.
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      void this.restore();
    }, this.reattachDelayMs);
    if (typeof this.reattachTimer === "object" && this.reattachTimer && "unref" in this.reattachTimer) {
      this.reattachTimer.unref();
    }
  }

  private async restore(): Promise<void> {
    if (!this.disposed) await this.tryAttach();
  }

  private restoreDomains(): void {
    if (this.disposed) return;
    for (const [domain, state] of this.domains) {
      if ((state.count > 0 || this.sticky.has(domain)) && !state.enabled) {
        state.enabled = this.sendEnable(domain, state).catch(() => {});
      }
    }
  }
}
