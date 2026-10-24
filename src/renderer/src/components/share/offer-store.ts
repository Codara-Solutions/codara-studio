// Share prompts an agent asked for (codara_share_offer), waiting for the
// file's editor to mount, and the workspace folders a shared page may embed
// local files from. Opening a file and showing its prompt are separate steps:
// the tab may not exist yet, and its toolbar mounts only after the file loads.

export const SHARE_OFFER_EVENT = "spark:share-offer";

// An offer the user never saw (the file failed to open) must not pop up the
// next time they open that file by hand.
const OFFER_TTL_MS = 60_000;

const pending = new Map<string, number>();
let workspaceRoots: string[] = [];

export function requestShareOffer(path: string): void {
  pending.set(path, Date.now());
  window.dispatchEvent(new CustomEvent(SHARE_OFFER_EVENT, { detail: { path } }));
}

/**
 * True while a fresh offer of `path` waits. It stays until the prompt closes
 * (clearShareOffer), so a toolbar that remounts while the file loads opens
 * the prompt again instead of losing it.
 */
export function pendingShareOffer(path: string): boolean {
  const at = pending.get(path);
  if (at === undefined) return false;
  if (Date.now() - at < OFFER_TTL_MS) return true;
  pending.delete(path);
  return false;
}

export function clearShareOffer(path: string): void {
  pending.delete(path);
}

export function setShareWorkspaceRoots(roots: string[]): void {
  workspaceRoots = roots.filter((root) => typeof root === "string" && root.length > 0);
}

export function shareWorkspaceRoots(): readonly string[] {
  return workspaceRoots;
}
