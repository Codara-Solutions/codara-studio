// Browser tabs on screen at once that show one site share Chromium's one
// zoom for it. When one applies its level, the others on that site take it,
// so their chips agree. Pure, so scripts/test-page-zoom-peers.cjs runs it.

export interface PageZoomPeer {
  /** The page's zoom key while it is on screen, else null. */
  site: () => string | null;
  /** Takes a level at once: a peer read before its next render must not hand back a stale one. */
  adopt: (level: number) => void;
}

export interface PageZoomPeers {
  add: (peer: PageZoomPeer) => () => void;
  /** `from` applied `level` on `site`: every other peer on screen there takes it. */
  share: (from: PageZoomPeer | null, site: string | null, level: number) => void;
}

export function createPageZoomPeers(): PageZoomPeers {
  const peers = new Set<PageZoomPeer>();
  return {
    add(peer) {
      peers.add(peer);
      return () => {
        peers.delete(peer);
      };
    },
    share(from, site, level) {
      if (!site) return;
      for (const other of peers) if (other !== from && other.site() === site) other.adopt(level);
    },
  };
}
