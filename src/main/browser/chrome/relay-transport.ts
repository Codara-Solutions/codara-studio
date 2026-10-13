// A CdpTransport over the extension link: chrome.debugger on one shared tab,
// relayed through the extension. The shared CdpSession, its recorders and
// every browser tool then work on the Chrome tab as on a Codara tab.

import type { CdpTransport } from "../cdp-session";
import type { ChromeLink } from "./link";

export interface ChromeRelayTransport extends CdpTransport {
  /** Why the tab detached last (canceled_by_user, target_closed, blocked_site, unshared, link_closed). */
  readonly lastDetachReason: string | null;
}

export function chromeRelayTransport(link: ChromeLink, tabId: number): ChromeRelayTransport {
  let attached = false;
  let lastDetachReason: string | null = null;
  const detachListeners = new Set<(reason: string) => void>();
  const notifyDetach = (reason: string) => {
    if (!attached && lastDetachReason === reason) return;
    attached = false;
    lastDetachReason = reason;
    for (const listener of detachListeners) listener(reason);
  };
  link.onDetached((detachedTab, reason) => {
    if (detachedTab === tabId) notifyDetach(reason);
  });
  link.onClose(() => notifyDetach("link_closed"));
  return {
    get lastDetachReason() {
      return lastDetachReason;
    },
    async attach() {
      if (attached && link.isOpen) return;
      await link.request("attach", { tabId });
      attached = true;
      lastDetachReason = null;
    },
    isAttached: () => attached && link.isOpen,
    detach() {
      if (!attached) return;
      attached = false;
      void link.request("detach", { tabId }).catch(() => {});
    },
    send: (method, params) => link.request("cdp", { tabId, method, params: params ?? {} }),
    onEvent(listener) {
      return link.onEvent((eventTab, method, params) => {
        if (eventTab === tabId) listener(method, params);
      });
    },
    onDetach(listener) {
      detachListeners.add(listener);
      return () => detachListeners.delete(listener);
    },
    // Re-attaching on its own would undo the user's choice (Cancel on
    // Chrome's debugging bar, a stop in the popup, a blocked site) or fail
    // (a closed tab, a closed link). The next call that needs the tab asks
    // the extension again, which refuses with the reason.
    reattachAfter: () => false,
  };
}
