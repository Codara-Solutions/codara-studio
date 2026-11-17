// Short lines an agent reads in a browser tool's result or error, shared by
// Codara's tabs (renderer previewRpc.ts) and the user's Chrome tabs (main
// browser/chrome/). Each says what a call did, or which tabs a call could
// have used, so the agent does not call again only to find out.

export interface PageState {
  url: string;
  title: string;
  loading?: boolean;
}

export interface TabChoice {
  id: string;
  title: string;
  url: string;
  current?: boolean;
  yours?: boolean;
}

const URL_MAX = 60;
const TITLE_MAX = 40;
const CHOICES_MAX = 6;

// Page text reaches agents inside errors and results: control and
// direction-changing characters go, and titles and addresses are quoted as
// JSON strings so a page cannot end the sentence around them.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function clip(text: string, max: number): string {
  const clean = text.replace(UNSAFE_CHARACTERS, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function quoted(text: string, max: number): string {
  return JSON.stringify(clip(text, max));
}

/** host/path for http, the last two path parts for a file. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return clip(decodeURIComponent(parsed.pathname).split("/").slice(-2).join("/"), URL_MAX);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return clip(url, URL_MAX);
    return clip(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`, URL_MAX);
  } catch {
    return clip(url, URL_MAX);
  }
}

/** The same page address, read the way the browser writes it back (a bare origin gains its slash). */
export function sameUrl(a: string, b: string): boolean {
  const normal = (url: string) => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };
  return normal(a) === normal(b);
}

export function describePage(state: PageState): string {
  const title = clip(state.title, TITLE_MAX);
  return `${JSON.stringify(shortUrl(state.url))}${title ? ` (title ${JSON.stringify(title)})` : ""}${state.loading ? ", still loading" : ""}`;
}

/** What a click, a typed value or a key did to the page, judged from its address, title and DOM updates. */
export function describeChange(before: PageState, after: PageState, mutations?: number | null): string {
  if (!sameUrl(before.url, after.url)) return `Now on ${describePage(after)}.`;
  if (before.title !== after.title) return `Title is now ${quoted(after.title, TITLE_MAX)}; same URL.`;
  if (typeof mutations === "number" && mutations > 0) return `The page updated (${mutations} DOM change${mutations === 1 ? "" : "s"}); same URL and title.`;
  if (mutations === 0) return "Nothing on the page changed yet; same URL and title.";
  return "Same URL and title.";
}

/** What a type call left in its field; a password field's value comes back masked by the probe. */
export function describeTyped(result: unknown): string {
  const value = result && typeof result === "object" ? (result as { value?: unknown }).value : undefined;
  return typeof value === "string" ? `The field now holds ${quoted(value, URL_MAX)}.` : "Typed into the element.";
}

// Read in the page after a click: the DOM updates counted since the click
// probe started watching (domActions.ts), then the watch stops. A page that
// navigated has no watch and reports null.
export const CHANGES_STOP_EXPRESSION =
  "(() => { const watch = window.__codaraChanges; return { changes: watch && typeof watch.stop === \"function\" ? watch.stop() : null }; })()";

// Where the page is and the HTTP status its document arrived with.
export const PAGE_LOAD_CHECK_EXPRESSION =
  "(() => { const entry = performance.getEntriesByType(\"navigation\")[0]; return { href: location.href, status: entry && typeof entry.responseStatus === \"number\" ? entry.responseStatus : null }; })()";

/**
 * Whether a page-load check (location and the navigation's HTTP status) shows
 * the page at url loaded: on its own address, not Chromium's error page, and
 * for http with a status below 400. A file has no status.
 */
export function pageAnsweredFine(page: unknown, url: string): boolean {
  if (!page || typeof page !== "object") return false;
  const { href, status } = page as { href?: unknown; status?: unknown };
  if (typeof href !== "string" || !sameUrl(href, url)) return false;
  if (!/^https?:/i.test(href)) return href.startsWith("file:");
  return typeof status === "number" && status >= 200 && status < 400;
}

/** A navigate to the page the tab already shows: how its title moved since this agent's last navigate there. */
export function describeAlreadyThere(now: PageState, last: { title: string; at: number } | null, nowMs = Date.now()): string {
  const since = last ? ` since your navigate ${Math.max(0, Math.round((nowMs - last.at) / 1000))} s ago` : "";
  const title = !last ? "" : last.title !== now.title ? `; title changed from ${quoted(last.title, TITLE_MAX)}${since}` : `; title unchanged${since}`;
  return `Already on ${describePage(now)}${title}. Not reloaded: pass reload: true to reload.`;
}

/** The tabs a call could have used, for an error that names a missing one. */
export function describeTabChoices(tabs: TabChoice[]): string {
  if (tabs.length === 0) return "none";
  const shown = tabs.slice(0, CHOICES_MAX).map((tab) => {
    const marks = [tab.yours ? "yours" : "", tab.current ? "current" : ""].filter(Boolean).join(", ");
    const title = clip(tab.title, TITLE_MAX) && tab.title !== tab.url ? ` ${quoted(tab.title, TITLE_MAX)}` : "";
    return `${tab.id}${title} ${JSON.stringify(shortUrl(tab.url))}${marks ? ` (${marks})` : ""}`;
  });
  return shown.join("; ") + (tabs.length > CHOICES_MAX ? `; ${tabs.length - CHOICES_MAX} more in codara_preview_list` : "");
}
