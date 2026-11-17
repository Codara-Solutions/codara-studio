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

let stopsFile: string | null = null;
// Names of stopped agents, for Settings and the popup to offer "Give back".
const names = new Map<string, string>();

function saveStops(): void {
  if (!stopsFile) return;
  const rows: { linkId: string; tabId: number; keys: { key: string; name: string | null }[] }[] = [];
  for (const [tabId, byLink] of stops) {
    for (const [linkId, keys] of byLink) {
      if (keys.size) rows.push({ linkId, tabId, keys: [...keys].map((key) => ({ key, name: names.get(key) ?? null })) });
    }
  }
  try {
    mkdirSync(dirname(stopsFile), { recursive: true });
    writeFileSync(stopsFile, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  } catch {
    // Memory still holds them; the next change writes again.
  }
}

/**
 * Stops outlive a reconnect and a Codara restart: the browser's link id is
 * stable while it stays paired, and a stopped agent must stay stopped until
 * the user gives the tab back, unshares or closes it, or unpairs.
 */
export function loadChromeStops(path: string): void {
  stopsFile = path;
  stops.clear();
  try {
    const rows = JSON.parse(readFileSync(path, "utf8"));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.linkId !== "string" || !Number.isInteger(row?.tabId) || !Array.isArray(row?.keys)) continue;
      for (const entry of row.keys) {
        if (typeof entry?.key === "string") stopChromeDriver(row.linkId, row.tabId, entry.key, true, typeof entry.name === "string" ? entry.name : undefined, false);
      }
    }
  } catch {
    // No file yet.
  }
}

export function stopChromeDriver(linkId: string, tabId: number, key: string, stopped: boolean, name?: string, persist = true): void {
  let byLink = stops.get(tabId);
  if (stopped) {
    if (!byLink) stops.set(tabId, (byLink = new Map()));
    const keys = byLink.get(linkId) ?? new Set<string>();
    keys.add(key);
    byLink.set(linkId, keys);
    if (name) names.set(key, name.slice(0, 80));
  } else {
    byLink?.get(linkId)?.delete(key);
    if (byLink?.get(linkId)?.size === 0) byLink.delete(linkId);
    if (byLink?.size === 0) stops.delete(tabId);
  }
  if (persist) saveStops();
}

/** The agents stopped on a browser's tabs: tabId -> [{ key, name }]. */
export function chromeStops(linkId: string): Map<number, { key: string; name: string }[]> {
  const out = new Map<number, { key: string; name: string }[]>();
  for (const [tabId, byLink] of stops) {
    const keys = byLink.get(linkId);
    if (keys?.size) out.set(tabId, [...keys].map((key) => ({ key, name: names.get(key) ?? "An agent" })));
  }
  return out;
}

/** The browser was unpaired: its stops go with it. */
export function forgetChromeStops(linkId: string): void {
  let changed = false;
  for (const [tabId, byLink] of stops) {
    changed = byLink.delete(linkId) || changed;
    if (byLink.size === 0) stops.delete(tabId);
  }
  if (changed) saveStops();
}

/** The browser's shared tabs now: a stop on a tab no longer shared (closed or unshared) ends. */
export function keepChromeStopsFor(linkId: string, sharedTabIds: Iterable<number>): void {
  const shared = new Set(sharedTabIds);
  let changed = false;
  for (const [tabId, byLink] of stops) {
    if (shared.has(tabId) || !byLink.has(linkId)) continue;
    byLink.delete(linkId);
    if (byLink.size === 0) stops.delete(tabId);
    changed = true;
  }
  if (changed) saveStops();
}

/** A link went down: a reconnect keeps the stops; an unpaired browser loses them. */
export function chromeLinkDown(linkId: string, stillPaired: boolean): void {
  if (!stillPaired) forgetChromeStops(linkId);
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
