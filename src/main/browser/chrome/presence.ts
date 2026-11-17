// The agent's presence on tabs of the user's own browser, Codara's side: the
// overlay settings the extension and Settings > Browser share (pointer and
// Stop pill on or off, the page-edge glow on or off), and the agents the user
// stopped from the pill. A stop refuses that agent's next calls on that tab
// only, as Stop does on a Codara tab (DESIGN.md "The agent's hand").

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChromePresenceSettings } from "../../../shared/chrome-link";

const DEFAULTS: ChromePresenceSettings = { overlay: true, glow: true, at: 0 };

let file: string | null = null;
let current: ChromePresenceSettings = DEFAULTS;

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

// ── Agents the user stopped ────────────────────────────────────────────────
//
// Codara owns this list; the extension holds a copy it replaces with every
// list Codara sends. A stop belongs to one browser session of one paired
// browser (the extension's per-session id), so a tab id reused after the
// browser restarts is never refused by an old stop.

interface StopRecord {
  key: string;
  name: string;
  session: string | null;
}

// linkId -> tabId -> key -> stop.
const stops = new Map<string, Map<number, Map<string, StopRecord>>>();
// linkId -> the browser session id from its latest tab report.
const sessions = new Map<string, string | null>();
let stopsFile: string | null = null;
// After an unreadable stops file Codara cannot know who was stopped, so it
// fails closed for the browsers paired then: per link, the tabs it reports
// first stay refused to every agent until the user shares them again (null:
// not reported yet, every tab refused). A browser paired later is unaffected,
// and it switches off once no paused tab is left. null when the file was read.
let failsafe: Map<string, Set<number> | null> | null = null;
let connectedLinks: () => string[] = () => [];

/** The link ids connected now, to place a tab ref without a link id (one browser). */
export function setChromeConnectedLinks(list: () => string[]): void {
  connectedLinks = list;
}

function settleFailsafe(): void {
  if (failsafe && [...failsafe.values()].every((tabs) => tabs !== null && tabs.size === 0)) failsafe = null;
}

/** Tabs of a browser paused after an unreadable stops file: "all" before its first report. */
export function chromePausedTabs(linkId: string): "all" | number[] {
  const tabs = failsafe?.get(linkId);
  return tabs === null ? "all" : [...(tabs ?? [])];
}
let onStopsChanged: ((linkId: string) => void) | null = null;

/** Called with a link id whenever that browser's stop list changed (to send it the new list). */
export function setChromeStopsListener(listener: ((linkId: string) => void) | null): void {
  onStopsChanged = listener;
}

function changed(linkId: string): void {
  saveStops();
  try {
    onStopsChanged?.(linkId);
  } catch {
    // Sending the copy is best effort; Codara's own list already holds it.
  }
}

function saveStops(): void {
  if (!stopsFile) return;
  const rows: { linkId: string; tabId: number; key: string; name: string; session: string | null }[] = [];
  for (const [linkId, tabs] of stops) {
    for (const [tabId, keys] of tabs) {
      for (const record of keys.values()) rows.push({ linkId, tabId, ...record });
    }
  }
  const file = {
    version: 2,
    stops: rows,
    failsafe: failsafe ? Object.fromEntries([...failsafe].map(([linkId, tabs]) => [linkId, tabs ? [...tabs] : null])) : null,
  };
  try {
    mkdirSync(dirname(stopsFile), { recursive: true });
    // Written aside and renamed: a crash mid-write never leaves half a list.
    const temp = `${stopsFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(temp, stopsFile);
  } catch {
    // Memory still holds them; the next change writes again.
  }
}

function put(linkId: string, tabId: number, record: StopRecord): void {
  let tabs = stops.get(linkId);
  if (!tabs) stops.set(linkId, (tabs = new Map()));
  let keys = tabs.get(tabId);
  if (!keys) tabs.set(tabId, (keys = new Map()));
  keys.set(record.key, record);
}

function readRows(value: unknown): { rows: unknown[]; failsafe: unknown } {
  // Version 1 was a bare list without sessions.
  if (Array.isArray(value)) return { rows: value, failsafe: null };
  if (value && typeof value === "object" && Array.isArray((value as { stops?: unknown }).stops)) {
    return { rows: (value as { stops: unknown[] }).stops, failsafe: (value as { failsafe?: unknown }).failsafe ?? null };
  }
  throw new Error("not a stop list");
}

/**
 * Stops outlive a reconnect and a Codara restart. A missing file is an empty
 * list; an unreadable one is kept aside as .corrupt and Codara fails closed.
 */
export function loadChromeStops(path: string, pairedLinkIds: string[] = []): void {
  stopsFile = path;
  stops.clear();
  sessions.clear();
  failsafe = null;
  if (!existsSync(path)) return;
  try {
    const { rows, failsafe: saved } = readRows(JSON.parse(readFileSync(path, "utf8")));
    for (const row of rows as Record<string, unknown>[]) {
      if (typeof row?.linkId !== "string" || !Number.isInteger(row?.tabId)) throw new Error("bad row");
      const session = typeof row.session === "string" ? row.session : null;
      // Version 1 rows hold keys: [{ key, name }].
      const entries = Array.isArray(row.keys) ? (row.keys as Record<string, unknown>[]) : [row];
      for (const entry of entries) {
        if (typeof entry?.key !== "string") throw new Error("bad row");
        put(row.linkId, row.tabId as number, { key: entry.key, name: typeof entry.name === "string" ? entry.name.slice(0, 80) : "An agent", session });
      }
    }
    if (saved && typeof saved === "object") {
      failsafe = new Map(Object.entries(saved as Record<string, unknown>).map(([linkId, tabs]) => [linkId, Array.isArray(tabs) ? new Set(tabs.filter(Number.isInteger)) : null]));
      settleFailsafe();
    }
  } catch (error) {
    stops.clear();
    try {
      renameSync(path, `${path}.corrupt`);
    } catch {
      // Left in place; the failsafe below still holds.
    }
    console.warn(`[chrome-link] could not read ${path} (${error instanceof Error ? error.message : String(error)}); kept it as .corrupt and refusing agents on browser tabs until they are shared again.`);
    // Only the browsers paired now can have had stops.
    failsafe = new Map(pairedLinkIds.map((linkId) => [linkId, null]));
    settleFailsafe();
    saveStops();
  }
}

export function stopChromeDriver(linkId: string, tabId: number, key: string, stopped: boolean, name?: string, session?: string | null): void {
  if (stopped) {
    put(linkId, tabId, { key, name: (name || "An agent").slice(0, 80), session: session === undefined ? (sessions.get(linkId) ?? null) : session });
  } else {
    const tabs = stops.get(linkId);
    tabs?.get(tabId)?.delete(key);
    if (tabs?.get(tabId)?.size === 0) tabs.delete(tabId);
    if (tabs?.size === 0) stops.delete(linkId);
  }
  changed(linkId);
}

/** The agents stopped on a browser's tabs: tabId -> [{ key, name }]. */
export function chromeStops(linkId: string): Map<number, { key: string; name: string }[]> {
  const out = new Map<number, { key: string; name: string }[]>();
  for (const [tabId, keys] of stops.get(linkId) ?? []) out.set(tabId, [...keys.values()].map(({ key, name }) => ({ key, name })));
  return out;
}

/** The list Codara sends the extension, which replaces its copy with it. */
export function chromeStopList(linkId: string): { tabId: number; key: string; name: string }[] {
  return [...chromeStops(linkId)].flatMap(([tabId, agents]) => agents.map((agent) => ({ tabId, ...agent })));
}

/** The browser was unpaired: its stops go with it. */
export function forgetChromeStops(linkId: string): void {
  const had = stops.delete(linkId);
  const hadFailsafe = failsafe?.delete(linkId) ?? false;
  settleFailsafe();
  sessions.delete(linkId);
  if (had || hadFailsafe) changed(linkId);
}

/**
 * A browser's tab report: its session id and the tabs shared now. A stop on
 * a tab no longer shared (closed or unshared), or from another browser
 * session, ends.
 */
export function keepChromeStopsFor(linkId: string, session: string | null, sharedTabIds: Iterable<number>): void {
  sessions.set(linkId, session);
  const shared = new Set(sharedTabIds);
  let dirty = false;
  const tabs = stops.get(linkId);
  for (const [tabId, keys] of tabs ?? []) {
    for (const [key, record] of keys) {
      if (shared.has(tabId) && record.session === session) continue;
      keys.delete(key);
      dirty = true;
    }
    if (keys.size === 0) tabs!.delete(tabId);
  }
  if (tabs?.size === 0) stops.delete(linkId);
  if (failsafe?.has(linkId)) {
    const suspect = failsafe.get(linkId);
    if (suspect === null) {
      failsafe.set(linkId, new Set(shared));
    } else {
      for (const tabId of suspect ?? []) if (!shared.has(tabId)) suspect!.delete(tabId);
    }
    settleFailsafe();
    dirty = true;
  }
  if (dirty) changed(linkId);
}

/** A link went down: a reconnect keeps the stops; an unpaired browser loses them. */
export function chromeLinkDown(linkId: string, stillPaired: boolean): void {
  if (!stillPaired) forgetChromeStops(linkId);
}

function failsafeRefuses(ref: { tabId: number; linkId: string | null }): boolean {
  if (!failsafe) return false;
  // A ref without a link id means one browser is connected.
  const connected = connectedLinks();
  const linkId = ref.linkId ?? (connected.length === 1 ? connected[0] : null);
  if (!linkId) return [...failsafe.values()].some((tabs) => tabs === null || tabs.has(ref.tabId));
  if (!failsafe.has(linkId)) return false;
  const tabs = failsafe.get(linkId);
  return tabs === null || tabs!.has(ref.tabId);
}

/** Throws the message the agent reads when the user stopped it on this tab from the page. */
export function assertChromeDriverAllowed(ref: { tabId: number; linkId: string | null }, tabRef: string, driver: unknown): void {
  if (failsafeRefuses(ref)) {
    throw new ChromeDriverStoppedError(
      `Shared tabs were paused after a problem reading saved stops: browser tab ${tabRef} is refused to agents until the user shares it again ` +
        "(switch it off and on in the Codara popup). Do not retry; ask the user.",
    );
  }
  const key = driver && typeof driver === "object" ? (driver as { key?: unknown }).key : null;
  if (typeof key !== "string") return;
  const stopped = ref.linkId
    ? stops.get(ref.linkId)?.get(ref.tabId)?.has(key)
    : [...stops.values()].some((tabs) => tabs.get(ref.tabId)?.has(key));
  if (!stopped) return;
  const name = (driver as { name?: unknown }).name;
  throw new ChromeDriverStoppedError(
    `The user stopped ${typeof name === "string" && name ? name : "this agent"} from using browser tab ${tabRef} and took it back. ` +
      "Do not use this tab again or retry the call; ask the user if you still need it.",
  );
}
