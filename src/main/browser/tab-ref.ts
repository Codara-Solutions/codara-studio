// The tab ids agents pass as `tabId`. A Codara browser tab keeps the bare id
// it always had (`preview:<id>` is accepted too); a tab of the user's own
// Chrome, reached through the Codara extension, is `chrome:<tabId>`, or
// `chrome:<link>/<tabId>` when more than one browser is connected and the
// numeric id alone is ambiguous. No tabId means the caller's own Codara tab:
// a Chrome tab is only ever used when an agent names it.

export type BrowserTabRef =
  | { kind: "preview"; tabId: string }
  | { kind: "chrome"; tabId: number; linkId: string | null };

const CHROME = /^chrome:(?:([a-z0-9][a-z0-9-]{0,31})\/)?(\d{1,10})$/i;

export class BrowserTabRefError extends Error {}

/** Null when no tab is named. Throws for a malformed Chrome id. */
export function parseTabRef(value: unknown): BrowserTabRef | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^chrome:/i.test(raw)) {
    const match = CHROME.exec(raw);
    if (!match) {
      throw new BrowserTabRefError(
        `"${raw}" is not a Chrome tab id. Use the id codara_preview_list returns, such as chrome:123.`,
      );
    }
    return { kind: "chrome", tabId: Number(match[2]), linkId: match[1] ? match[1].toLowerCase() : null };
  }
  if (/^preview:/i.test(raw)) return { kind: "preview", tabId: raw.slice("preview:".length) };
  return { kind: "preview", tabId: raw };
}

export function formatTabRef(ref: BrowserTabRef): string {
  if (ref.kind === "preview") return ref.tabId;
  return ref.linkId ? `chrome:${ref.linkId}/${ref.tabId}` : `chrome:${ref.tabId}`;
}

export function isChromeTabRef(value: unknown): boolean {
  return typeof value === "string" && /^chrome:/i.test(value.trim());
}
