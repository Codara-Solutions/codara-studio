// Which browser tabs may sleep, and the words the tabs view uses for them.
// Dependency-free so scripts/test-browser-tab-sleep.cjs bundles this file as is.
//
// A sleeping tab has no page process: its webview is removed and comes back
// with the same URL when the tab is shown again or an agent calls it. Back and
// forward history and unsaved page state are lost, so a tab someone is using
// never sleeps: one on screen, one recording, one an agent acted on recently,
// and a logged-out tab, whose temporary session would go with its last page.

export const AUTO_SLEEP_AFTER_MS = 30 * 60_000;

// An agent that acted this recently is still using the tab.
export const AGENT_ACTIVE_MS = 10 * 60_000;

export type SleepBlocker = "visible" | "isolated" | "recording" | "agent";

export interface SleepCandidate {
  id: string;
  asleep: boolean;
  visible: boolean;
  /** When the tab was last on screen, or when it opened if it never was. */
  lastSeenAt: number;
  isolated: boolean;
  recording: boolean;
  /** When an agent last acted on the tab, or null. */
  agentActiveAt: number | null;
}

export function sleepBlocker(tab: SleepCandidate, now: number): SleepBlocker | null {
  if (tab.visible) return "visible";
  if (tab.recording) return "recording";
  if (tab.agentActiveAt !== null && now - tab.agentActiveAt < AGENT_ACTIVE_MS) return "agent";
  if (tab.isolated) return "isolated";
  return null;
}

export function sleepBlockerText(blocker: SleepBlocker): string {
  switch (blocker) {
    case "visible":
      return "This tab is on screen";
    case "recording":
      return "This tab is recording";
    case "agent":
      return "An agent is using this tab";
    case "isolated":
      return "A logged-out tab would lose its session";
  }
}

/** The awake tabs auto-sleep puts to sleep now. */
export function tabsToAutoSleep(
  tabs: readonly SleepCandidate[],
  now: number,
  options: { enabled: boolean; afterMs?: number },
): string[] {
  if (!options.enabled) return [];
  const afterMs = options.afterMs ?? AUTO_SLEEP_AFTER_MS;
  return tabs
    .filter((tab) => !tab.asleep && now - tab.lastSeenAt >= afterMs && sleepBlocker(tab, now) === null)
    .map((tab) => tab.id);
}

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(mb))} MB`;
}

export function formatAsleepFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "asleep";
  if (minutes < 60) return `asleep ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `asleep ${hours} h`;
  return `asleep ${Math.floor(hours / 24)} d`;
}

// Full screen fills the Codara window first; F11 there takes the whole
// display. Esc, the button and F11 on the whole display all leave.
export type FullScreenMode = "off" | "window" | "display";

export function nextFullScreenMode(mode: FullScreenMode, input: "F11" | "Escape" | "button"): FullScreenMode {
  if (input === "Escape") return "off";
  if (input === "button") return mode === "off" ? "window" : "off";
  if (mode === "off") return "window";
  if (mode === "window") return "display";
  return "off";
}

/** "localhost:5173/dashboard" for the second line of a tab row. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}
