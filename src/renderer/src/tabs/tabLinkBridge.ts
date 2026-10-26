// Lets terminalRpc resolve and act on tab links (shared/tab-links.ts) for
// codara_tab. The tabs live in App's store, so App registers the adapter at
// mount, as it does for tabGroupBridge.

import type { TabLinkRef } from "@shared/tab-links";
import type { SplitDirection, TabLinkResolution } from "./tabLinks";
import type { TabLayoutChange } from "./useTabs";

export interface TabLinkBridge {
  resolve: (ref: TabLinkRef) => TabLinkResolution | null;
  // The workspace on screen, whose layout split and unsplit change.
  activeWorkspaceId: () => string | null;
  // Brings the tab or group on screen, as clicking its link does.
  focus: (ref: TabLinkRef) => boolean;
  // Closes these tabs of one workspace like their close buttons; returns the
  // ones it closed.
  close: (workspaceId: string, tabIds: string[]) => string[];
  split: (tabId: string, direction: SplitDirection) => TabLayoutChange;
  unsplit: (tabId: string) => TabLayoutChange;
}

let bridge: TabLinkBridge | null = null;

export function setTabLinkBridge(next: TabLinkBridge | null): void {
  bridge = next;
}

export function tabLinkBridge(): TabLinkBridge {
  if (!bridge) throw new Error("Codara is not ready to act on tabs yet. Retry in a moment.");
  return bridge;
}

// Every click on a tab link, from a terminal, a chat or main, ends here.
export const OPEN_TAB_LINK_EVENT = "spark:open-tab-link";

export function openTabLink(url: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_TAB_LINK_EVENT, { detail: { url } }));
}

// The strip marks the tab or group a link brought on screen for a moment, so
// the eye finds it. The element may only render once the workspace switch or
// group expansion has, so this retries for a few frames.
export function flashTabStripItems(selectors: string[]): void {
  let attempts = 0;
  const run = () => {
    const found = selectors
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null);
    if (found.length === 0) {
      attempts += 1;
      if (attempts < 20) window.requestAnimationFrame(run);
      return;
    }
    found[0].scrollIntoView({ block: "nearest", inline: "nearest" });
    for (const element of found) {
      element.removeAttribute("data-link-flash");
      // Restart the animation when the same link is clicked twice in a row.
      void element.offsetWidth;
      element.setAttribute("data-link-flash", "true");
      window.setTimeout(() => element.removeAttribute("data-link-flash"), 1_800);
    }
  };
  window.requestAnimationFrame(run);
}
