// Names for elements that have no text: icon-only links and buttons get one
// from an svg <title>, an icon's <use href="#icon-search">, icon class names
// (fa-search, lucide-search, bi-search, material icon ligatures) or, for a
// link, where it goes. Shared by the page outline (domSnapshot.ts) and "find
// by description" (src/main/browser/find.ts). Stringified into the page like
// createPreviewDOM, so keep every dependency inside the factory.

export function createPreviewNames() {
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

  // Icon-set prefixes in class names and sprite ids: the rest is the icon's
  // name ("fa-magnifying-glass" -> "magnifying glass").
  const ICON_CLASS = /^(?:fa[srlbd]?|fa-solid|fa-regular|bi|lucide|icon|icons|ico|ic|i|ti|tabler|ri|mdi|material-icons?|material-symbols(?:-\w+)?|glyphicon|octicon|feather|heroicon|hero|ph|la|las|lab|iconify|codicon|ion|ionicon)-(.+)$/i;
  const NOT_AN_ICON = /^(?:sm|md|lg|xl|xs|\d+x?|\d+|solid|regular|light|outline|filled|rounded|sharp|thin|bold|duotone|fw|spin|pulse|button|btn|wrapper|container|left|right)$/i;
  const LIGATURE_CLASS = /\b(?:material-icons|material-icons-\w+|material-symbols(?:-\w+)?)\b/;

  function words(raw: string): string {
    return clean(raw.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")).toLowerCase();
  }

  /** A short name for the icon inside (or on) an element, or "". */
  function iconHint(el: Element): string {
    const nodes = [el, ...Array.from(el.querySelectorAll("svg, i, span, img, use, [data-icon], [class*='icon']")).slice(0, 12)];
    for (const node of nodes) {
      const title = node.tagName.toLowerCase() === "svg" ? node.querySelector(":scope > title")?.textContent : null;
      if (clean(title)) return clean(title);
      const label = node !== el && node.tagName.toLowerCase() === "svg" ? node.getAttribute("aria-label") : null;
      if (clean(label)) return clean(label);
      const dataIcon = node.getAttribute("data-icon") || node.getAttribute("data-lucide") || node.getAttribute("icon");
      if (dataIcon) return words(dataIcon.replace(/^.*[:/]/, ""));
      if (node.tagName.toLowerCase() === "use") {
        const ref = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
        const id = ref.split("#").pop() ?? "";
        if (id) return words(id.replace(/^(?:icon|ico|ic|i|svg|sprite)[-_]/i, ""));
      }
      if (node !== el && node instanceof HTMLImageElement && clean(node.alt)) return clean(node.alt);
      const className = typeof (node as HTMLElement).className === "string" ? (node as HTMLElement).className : node.getAttribute("class") ?? "";
      if (LIGATURE_CLASS.test(className) && clean(node.textContent)) return words(clean(node.textContent));
      for (const name of className.split(/\s+/)) {
        const match = ICON_CLASS.exec(name);
        if (match && !NOT_AN_ICON.test(match[1])) return words(match[1]);
      }
    }
    return "";
  }

  // A data: or long signed URL in an href would otherwise fill an agent's
  // context with one attribute.
  const TARGET_MAX = 200;
  const bounded = (target: string) => (target.length > TARGET_MAX ? `${target.slice(0, TARGET_MAX)}...` : target);

  /** Where a link goes, short: a same-origin path, else the full URL, capped. */
  function linkTarget(el: Element): string | null {
    const anchor = el.closest("a[href]");
    const raw = anchor?.getAttribute("href");
    if (!raw || /^\s*javascript:/i.test(raw)) return null;
    try {
      const url = new URL(raw, location.href);
      if (url.origin === location.origin && /^https?:$/.test(url.protocol)) {
        return bounded(`${url.pathname}${url.search}${url.hash}` || "/");
      }
      return bounded(url.href);
    } catch {
      return bounded(raw);
    }
  }

  /** A readable name from a link target: "github.com", or a path's last segment. */
  function hrefName(target: string): string {
    if (/^mailto:/i.test(target)) return target.slice(7);
    if (/^tel:/i.test(target)) return target.slice(4);
    if (target.startsWith("#")) return words(target.slice(1));
    try {
      const url = new URL(target, location.href);
      if (url.origin !== location.origin) return url.hostname.replace(/^www\./, "");
      const segment = url.pathname.split("/").filter(Boolean).pop();
      return segment ? words(decodeURIComponent(segment).replace(/\.[a-z0-9]{1,5}$/i, "")) : url.hash ? words(url.hash.slice(1)) : "home";
    } catch {
      return "";
    }
  }

  /** The name to show for a control that has no text of its own. */
  function fallbackName(el: Element): string {
    const icon = iconHint(el);
    if (icon) return icon;
    const target = el.matches("a[href], a[href] *") ? linkTarget(el) : null;
    return target ? hrefName(target) : "";
  }

  return { clean, iconHint, linkTarget, hrefName, fallbackName };
}
