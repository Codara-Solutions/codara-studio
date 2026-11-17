// The agent's presence on tabs of the user's own browser, Codara's side: the
// overlay settings the extension and Settings > Browser share (pointer and
// Stop pill on or off, the page-edge glow on or off), and the agents the user
// stopped from the pill. A stop refuses that agent's next calls on that tab
// only, as Stop does on a Codara tab (DESIGN.md "The agent's hand").

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChromePresenceSettings } from "../../../shared/chrome-link";

const DEFAULTS: ChromePresenceSettings = { overlay: true, glow: true, at: 0 };

let file: string | null = null;
let current: ChromePresenceSettings = DEFAULTS;
// tabId -> linkId -> keys of the agents the user stopped there.
const stops = new Map<number, Map<string, Set<string>>>();

export class ChromeDriverStoppedError extends Error {}

/** The settings with defaults filled in, from anything the extension or the file holds. */
export function readPresenceSettings(value: unknown): ChromePresenceSettings {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    overlay: record.overlay !== false,
    glow: record.glow !== false,
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
  };
}

export function loadPresenceSettings(path: string): void {
  file = path;
  try {
    current = readPresenceSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    current = DEFAULTS;
  }
}

export function presenceSettings(): ChromePresenceSettings {
  return current;
}

/**
 * Adopt settings if they are newer than the ones held, by when the user
 * changed them. Returns true when they were adopted.
 */
export function adoptPresenceSettings(value: unknown): boolean {
  const next = readPresenceSettings(value);
  if (next.at <= current.at) return false;
  current = next;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
    } catch {
      // The extension keeps its own copy; the next change writes again.
    }
  }
  return true;
}

export function stopChromeDriver(linkId: string, tabId: number, key: string, stopped: boolean): void {
  let byLink = stops.get(tabId);
  if (stopped) {
    if (!byLink) stops.set(tabId, (byLink = new Map()));
    const keys = byLink.get(linkId) ?? new Set<string>();
    keys.add(key);
    byLink.set(linkId, keys);
    return;
  }
  byLink?.get(linkId)?.delete(key);
}

/** A browser that disconnects forgets its stops: its tab ids may be reused. */
export function forgetChromeStops(linkId: string): void {
  for (const [tabId, byLink] of stops) {
    byLink.delete(linkId);
    if (byLink.size === 0) stops.delete(tabId);
  }
}

/** Throws the message the agent reads when the user stopped it on this tab from the page. */
export function assertChromeDriverAllowed(ref: { tabId: number; linkId: string | null }, tabRef: string, driver: unknown): void {
  const key = driver && typeof driver === "object" ? (driver as { key?: unknown }).key : null;
  if (typeof key !== "string") return;
  const byLink = stops.get(ref.tabId);
  if (!byLink) return;
  const stopped = ref.linkId ? byLink.get(ref.linkId)?.has(key) : [...byLink.values()].some((keys) => keys.has(key));
  if (!stopped) return;
  const name = (driver as { name?: unknown }).name;
  throw new ChromeDriverStoppedError(
    `The user stopped ${typeof name === "string" && name ? name : "this agent"} from using browser tab ${tabRef} and took it back. ` +
      "Do not use this tab again or retry the call; ask the user if you still need it.",
  );
}
