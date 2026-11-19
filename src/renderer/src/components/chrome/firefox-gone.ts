// Which paired Firefoxes really went away (closed or restarted, so the
// temporary add-on is gone), for the notice in FirefoxReload.tsx. A paired
// Firefox that drops counts only when it stays away goneAfterMs, longer than
// the add-on's own reconnect steps (its 30 s wake alarm and first 30 s
// reconnect delay), so a blink is never called a restart. Once per
// disconnect: back connected, a later drop counts again. Never for a browser
// the user unpaired or disconnected: it leaves the list, and a drop it was
// waiting on is forgotten.

export interface FirefoxLinkView {
  linkId: string;
  connected: boolean;
  browser: { name: string };
}

export interface GoneTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const isFirefox = (name: string) => /firefox/i.test(name);

export class GoneFirefoxTracker {
  private readonly timers = new Map<string, unknown>();
  private readonly wasConnected = new Set<string>();
  private gone: string[] = [];

  constructor(
    private readonly goneAfterMs: number,
    private readonly onChange: (gone: string[]) => void,
    private readonly clock: GoneTimers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  ) {}

  /** The link's browsers as they are now. */
  update(browsers: readonly FirefoxLinkView[]): void {
    const firefoxes = browsers.filter((browser) => isFirefox(browser.browser.name));
    const present = new Set(firefoxes.map((browser) => browser.linkId));
    let gone = this.gone;
    for (const browser of firefoxes) {
      if (browser.connected) {
        this.wasConnected.add(browser.linkId);
        this.cancel(browser.linkId);
        gone = gone.filter((id) => id !== browser.linkId);
      } else if (this.wasConnected.has(browser.linkId) && !this.timers.has(browser.linkId)) {
        // It dropped while Codara watched: it counts if it stays away.
        this.wasConnected.delete(browser.linkId);
        const linkId = browser.linkId;
        this.timers.set(linkId, this.clock.set(() => {
          this.timers.delete(linkId);
          if (!this.gone.includes(linkId)) this.set([...this.gone, linkId]);
        }, this.goneAfterMs));
      }
    }
    // Unpaired or disconnected by the user: no notice, now or later.
    for (const linkId of [...this.timers.keys()]) if (!present.has(linkId)) this.cancel(linkId);
    for (const linkId of [...this.wasConnected]) if (!present.has(linkId)) this.wasConnected.delete(linkId);
    gone = gone.filter((id) => present.has(id));
    if (gone.length !== this.gone.length || gone.some((id, index) => id !== this.gone[index])) this.set(gone);
  }

  /** Stops every wait (the notice went away). */
  dispose(): void {
    for (const linkId of [...this.timers.keys()]) this.cancel(linkId);
  }

  private cancel(linkId: string): void {
    if (!this.timers.has(linkId)) return;
    this.clock.clear(this.timers.get(linkId));
    this.timers.delete(linkId);
  }

  private set(gone: string[]): void {
    this.gone = gone;
    this.onChange(gone);
  }
}
