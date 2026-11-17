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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
  const title = state.title.trim();
  return `${shortUrl(state.url)}${title ? ` ("${clip(title, TITLE_MAX)}")` : ""}${state.loading ? ", still loading" : ""}`;
}

/** What a click, a typed value or a key did to the page, judged from its address, title and DOM updates. */
export function describeChange(before: PageState, after: PageState, mutations?: number | null): string {
  if (!sameUrl(before.url, after.url)) return `Now on ${describePage(after)}.`;
  if (before.title !== after.title) return `Title is now "${clip(after.title, TITLE_MAX)}"; same URL.`;
  if (typeof mutations === "number" && mutations > 0) return `The page updated (${mutations} DOM change${mutations === 1 ? "" : "s"}); same URL and title.`;
  if (mutations === 0) return "Nothing on the page changed yet; same URL and title.";
  return "Same URL and title.";
}

/** What a type call left in its field; a password field's value comes back masked by the probe. */
export function describeTyped(result: unknown): string {
  const value = result && typeof result === "object" ? (result as { value?: unknown }).value : undefined;
  return typeof value === "string" ? `The field now holds "${clip(value, URL_MAX)}".` : "Typed into the element.";
}

// Read in the page after a click: the DOM updates counted since the click
// probe started watching (domActions.ts), then the watch stops. A page that
// navigated has no watch and reports null.
export const CHANGES_STOP_EXPRESSION =
  "(() => { const watch = window.__codaraChanges; return { changes: watch && typeof watch.stop === \"function\" ? watch.stop() : null }; })()";

/** A navigate to the page the tab already shows: what changed since this agent's last navigate there. */
export function describeAlreadyThere(now: PageState, last: { title: string; at: number } | null, nowMs = Date.now()): string {
  const since = last ? ` since your navigate ${Math.max(0, Math.round((nowMs - last.at) / 1000))} s ago` : "";
  const changed = last && last.title !== now.title ? `; title changed from "${clip(last.title, TITLE_MAX)}"` : last ? "; nothing changed" + since : "";
  return `Already on ${describePage(now)}${changed}. Not reloaded: pass reload true to reload.`;
}

/** The tabs a call could have used, for an error that names a missing one. */
export function describeTabChoices(tabs: TabChoice[]): string {
  if (tabs.length === 0) return "none";
  const shown = tabs.slice(0, CHOICES_MAX).map((tab) => {
    const marks = [tab.yours ? "yours" : "", tab.current ? "current" : ""].filter(Boolean).join(", ");
    const title = tab.title.trim() && tab.title !== tab.url ? ` "${clip(tab.title.trim(), TITLE_MAX)}"` : "";
    return `${tab.id}${title} ${shortUrl(tab.url)}${marks ? ` (${marks})` : ""}`;
  });
  return shown.join("; ") + (tabs.length > CHOICES_MAX ? `; ${tabs.length - CHOICES_MAX} more in codara_preview_list` : "");
}
