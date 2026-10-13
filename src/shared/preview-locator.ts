import type { createPreviewDOM } from "./preview-dom";

// Element references, selectors and boxes, shared by the snapshot, "find by
// description", the element picker, element screenshots and comments on a
// screenshot. Stringified into the page like createPreviewDOM, so keep every
// dependency inside the factory; the DOM factory is passed in, which keeps
// @references identical to the ones a snapshot hands out.
//
//   `(${probe})(${JSON.stringify(args)}, ${createPreviewLocator}, ${createPreviewDOM})`
//   where probe = (args, createLocator, createDOM) => createLocator(createDOM).describe(...)

export interface LocatorBox {
  /** Viewport CSS pixels, as input events and viewport screenshots use. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The same box in page coordinates (full-page screenshots). */
  pageX: number;
  pageY: number;
  /** Rendered and not hidden by CSS, inert or aria-hidden. */
  visible: boolean;
  /** At least partly inside the viewport. */
  inViewport: boolean;
}

export interface ElementDescription {
  ref: string;
  selector: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  box: LocatorBox;
  attributes: Record<string, string>;
  /** Link target, form action, image source: where the element leads. */
  target?: string;
}

export function createPreviewLocator(createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

  function escapeIdent(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/([^\w-])/g, "\\$1").replace(/^(\d)/, "\\3$1 ");
  }

  function isUnique(selector: string, el: Element): boolean {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch {
      return false;
    }
  }

  function stableClasses(el: Element): string[] {
    // Generated class names (css-1x2y3z, sc-abc123, hashes) change between
    // builds; a selector built on them goes stale after the next edit.
    return Array.from(el.classList)
      .filter((name) => /^[A-Za-z][\w-]{1,40}$/.test(name) && !/\d{3,}|^(css|sc|jsx|emotion|tw)-/i.test(name))
      .slice(0, 2);
  }

  function segment(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const sameTag = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
    return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})` : tag;
  }

  /** A CSS selector that matches only this element, preferring ones that survive edits. */
  function uniqueSelector(el: Element): string {
    if (el.id && isUnique(`#${escapeIdent(el.id)}`, el)) return `#${escapeIdent(el.id)}`;
    for (const attr of ["data-testid", "data-test", "data-cy", "data-qa", "name", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 80) continue;
      const selector = `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
      if (isUnique(selector, el)) return selector;
    }
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      if (node !== el && node.id && isUnique(`#${escapeIdent(node.id)}`, node)) {
        parts.unshift(`#${escapeIdent(node.id)}`);
        break;
      }
      const classes = stableClasses(node);
      const withClass = classes.length ? `${node.tagName.toLowerCase()}.${classes.map(escapeIdent).join(".")}` : "";
      const candidate = [withClass || segment(node), ...parts].join(" > ");
      if (withClass && isUnique(candidate, el)) return candidate;
      parts.unshift(segment(node));
      const joined = parts.join(" > ");
      if (isUnique(joined, el)) return joined;
      node = node.parentElement;
    }
    const full = parts.join(" > ");
    return isUnique(full, el) ? full : `html > ${full}`;
  }

  function box(el: Element): LocatorBox {
    const rect = el.getBoundingClientRect();
    const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      pageX: rect.left + scrollX,
      pageY: rect.top + scrollY,
      visible: dom.visible(el),
      inViewport,
    };
  }

  const TAG_ROLES: Record<string, string> = {
    a: "link", button: "button", select: "combobox", textarea: "textbox", nav: "navigation", main: "main",
    header: "banner", footer: "contentinfo", form: "form", h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading", dialog: "dialog", th: "columnheader", td: "cell", tr: "row",
    table: "table", ul: "list", ol: "list", li: "listitem", img: "image", summary: "button", iframe: "frame",
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button",
    reset: "button", image: "button", number: "spinbutton", search: "searchbox",
  };

  function role(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return INPUT_ROLES[(el as HTMLInputElement).type] || "textbox";
    if (tag === "a" && !el.hasAttribute("href")) return "generic";
    return TAG_ROLES[tag] || "generic";
  }

  function accessibleName(el: Element): string {
    const labelledBy = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent : ""))
      .filter(Boolean)
      .join(" ");
    const labels = "labels" in el
      ? Array.from((el as HTMLInputElement).labels ?? []).map((label) => label.textContent).join(" ")
      : "";
    const tag = el.tagName.toLowerCase();
    const buttonValue = tag === "input" && /^(button|submit|reset)$/.test((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "";
    const svgTitle = el.querySelector(":scope > svg title, :scope svg > title")?.textContent;
    const imgAlt = el.querySelector(":scope img[alt]")?.getAttribute("alt");
    return clean(
      el.getAttribute("aria-label") || labelledBy || labels || el.getAttribute("alt") || el.getAttribute("title") ||
      buttonValue || (el as HTMLElement).innerText || el.getAttribute("placeholder") || svgTitle || imgAlt || "",
    ).slice(0, 200);
  }

  function linkTarget(el: Element): string | undefined {
    const href = el.closest("a[href]")?.getAttribute("href");
    if (href) {
      try {
        return new URL(href, location.href).href;
      } catch {
        return href;
      }
    }
    if (el instanceof HTMLFormElement) return el.action || undefined;
    if (el instanceof HTMLImageElement) return el.currentSrc || el.src || undefined;
    return undefined;
  }

  const KEPT_ATTRIBUTES = ["id", "class", "name", "type", "href", "src", "alt", "title", "placeholder", "role", "aria-label", "data-testid"];

  function describe(el: Element): ElementDescription {
    const attributes: Record<string, string> = {};
    for (const attr of KEPT_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value) attributes[attr] = value.slice(0, 200);
    }
    const target = linkTarget(el);
    return {
      ref: dom.ref(el),
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      role: role(el),
      name: accessibleName(el),
      text: clean((el as HTMLElement).innerText ?? el.textContent).slice(0, 300),
      box: box(el),
      attributes,
      ...(target ? { target } : {}),
    };
  }

  /** The element at a viewport point, looking inside open shadow roots. */
  function at(x: number, y: number): Element | null {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** Resolve an @reference or a unique selector, or throw what went wrong. */
  function resolve(selector: string): Element {
    const el = dom.find(selector);
    if (!el) throw new Error(`No element matches ${JSON.stringify(selector)}. Take a new snapshot.`);
    return el;
  }

  return { dom, ref: dom.ref, resolve, uniqueSelector, box, role, accessibleName, describe, at };
}
