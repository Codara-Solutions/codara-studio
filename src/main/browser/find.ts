// codara_preview_find: "the search button" -> ranked element references.
//
// Deterministic scoring in the page, no model call: each word of the query
// (and its common synonyms: search ~ magnifier, close ~ x, settings ~ gear)
// is looked up in the element's accessible name, aria-label, title,
// placeholder, alt, nearby label, icon names (svg titles, sprite ids, icon
// classes), visible text, ids and test ids, class names and link target; a
// role word in the query ("button", "link", "field") must agree with the
// element's role. The returned @references are the snapshot's, so click and
// type take them directly.

import { createPreviewDOM } from "../../shared/preview-dom";
import { createPreviewLocator } from "../../shared/preview-locator";
import { createPreviewNames } from "../../shared/preview-names";
import type { PreviewLocator } from "./locator";
import type { BrowserTarget } from "./targets";

export const FIND_DEFAULT_LIMIT = 5;
export const FIND_MAX_LIMIT = 20;

export interface FindCandidate {
  ref: string;
  selector: string;
  role: string;
  name: string;
  score: number;
  why: string;
  text?: string;
  target?: string;
  box: { x: number; y: number; width: number; height: number; inViewport: boolean };
}

export interface FindResult {
  query: string;
  count: number;
  candidates: FindCandidate[];
}

// Stringified into the page: it may use only its arguments and page globals.
export function findProbe(
  args: { query: string; limit: number },
  locator: PreviewLocator,
  names: ReturnType<typeof createPreviewNames>,
): FindResult {
  const STOP = new Set(["the", "a", "an", "to", "of", "on", "in", "for", "with", "that", "this", "my", "your", "its", "which", "is", "at", "by", "and", "or", "please", "element", "thing", "one", "where", "says", "labelled", "labeled", "called", "named"]);
  const ROLE_WORDS: Record<string, string[]> = {
    button: ["button", "btn"],
    link: ["link", "anchor", "url"],
    textbox: ["input", "field", "textbox", "textarea"],
    checkbox: ["checkbox", "tickbox"],
    radio: ["radio"],
    combobox: ["dropdown", "select", "combobox", "picker"],
    tab: ["tab"],
    heading: ["heading", "headline"],
    image: ["image", "img", "picture", "photo", "logo"],
    switch: ["switch", "toggle"],
    slider: ["slider"],
    dialog: ["dialog", "modal", "popup"],
    navigation: ["nav", "navigation", "navbar"],
    menuitem: ["menuitem"],
  };
  const ROLE_FAMILY: Record<string, string[]> = {
    button: ["button", "menuitem", "tab", "switch"],
    textbox: ["textbox", "searchbox", "combobox", "spinbutton"],
    link: ["link"],
    checkbox: ["checkbox", "switch"],
    combobox: ["combobox", "listbox"],
  };
  const SYNONYMS = [
    ["search", "find", "magnifier", "magnifying", "lookup", "query"],
    ["close", "dismiss", "x", "×", "exit"],
    ["menu", "hamburger", "bars", "kebab", "ellipsis", "more"],
    ["submit", "send", "go", "confirm", "ok", "apply"],
    ["delete", "remove", "trash", "bin", "discard"],
    ["settings", "preferences", "gear", "cog", "config"],
    ["profile", "account", "user", "avatar"],
    ["cart", "basket", "bag", "checkout"],
    ["login", "signin", "sign-in", "log-in"],
    ["logout", "signout", "sign-out", "log-out"],
    ["signup", "register", "join"],
    ["next", "forward", "continue"],
    ["previous", "prev", "back"],
    ["add", "plus", "new", "create"],
    ["edit", "pencil", "modify", "rename"],
    ["home", "house"],
    ["help", "question", "support", "faq"],
    ["download", "save"],
    ["upload", "attach", "paperclip"],
    ["notifications", "notification", "bell", "alerts"],
    ["filter", "funnel"],
    ["copy", "duplicate", "clone"],
    ["refresh", "reload", "sync", "retry"],
    ["email", "mail", "envelope"],
    ["like", "heart", "favorite", "favourite", "star"],
    ["theme", "moon", "sun", "dark", "light"],
    ["language", "globe", "translate", "locale"],
  ];
  // "sign in" and "log out" are one word to the matcher.
  const phrase = args.query.toLowerCase().replace(/\b(sign|log)\s+(in|out|up)\b/g, "$1$2");
  const rawTokens = phrase.split(/[^\p{L}\p{N}×]+/u).filter((token) => token && !STOP.has(token));
  // The role is the last role word ("the search field button" is a button).
  let roleIntent: string | null = null;
  let roleToken = -1;
  for (let index = 0; index < rawTokens.length; index++) {
    const role = Object.keys(ROLE_WORDS).find((key) => ROLE_WORDS[key].includes(rawTokens[index]));
    if (role) {
      roleIntent = role;
      roleToken = index;
    }
  }
  const contentTokens = rawTokens.filter((_token, index) => index !== roleToken);
  if (!contentTokens.length && rawTokens.length) {
    contentTokens.push(...rawTokens);
    roleIntent = null;
  }
  const variants = (token: string) => {
    const group = SYNONYMS.find((words) => words.includes(token));
    return { exact: token, others: group ? group.filter((word) => word !== token) : [] };
  };
  const wordsOf = (text: string) => text.toLowerCase().replace(/\b(sign|log)\s+(in|out|up)\b/g, "$1$2").split(/[^\p{L}\p{N}×]+/u).filter(Boolean);

  const INTERACTIVE = "a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=textbox], [role=searchbox], [role=combobox], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1']), [onclick]";
  const OTHER = "h1, h2, h3, h4, h5, h6, img, label, [role], [aria-label], [title], [data-testid], svg[aria-label], nav, dialog";
  const elements = Array.from(document.querySelectorAll(`${INTERACTIVE}, ${OTHER}`)).slice(0, 4000);
  const dom = locator.dom;

  function nearbyLabel(el: Element): string {
    const parts: string[] = [];
    const wrapping = el.closest("label");
    if (wrapping && wrapping !== el) parts.push(wrapping.textContent ?? "");
    const described = (el.getAttribute("aria-describedby") || "").split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent : "")).join(" ");
    parts.push(described);
    const legend = el.closest("fieldset")?.querySelector("legend")?.textContent;
    if (legend) parts.push(legend);
    let previous = el.previousElementSibling;
    if (!previous && el.parentElement && el.parentElement.children.length <= 3) previous = el.parentElement.previousElementSibling;
    if (previous && (previous.textContent ?? "").length < 80) parts.push(previous.textContent ?? "");
    return names.clean(parts.join(" "));
  }

  type Scored = { el: Element; score: number; why: string[]; role: string; name: string; interactive: boolean };
  const scored: Scored[] = [];
  for (const el of elements) {
    if (!dom.visible(el)) continue;
    const interactive = el.matches(INTERACTIVE);
    let role = locator.role(el);
    if (el instanceof HTMLInputElement && el.type === "search") role = "searchbox";
    const ownName = locator.accessibleName(el);
    const icon = names.iconHint(el);
    const name = ownName || (interactive ? names.fallbackName(el) : "");
    const text = names.clean((el as HTMLElement).innerText ?? "").slice(0, 400);
    const target = el.matches("a[href]") ? names.linkTarget(el) ?? "" : "";
    const fields: Array<[string, string, number]> = [
      ["name", name, 4],
      ["aria-label", el.getAttribute("aria-label") ?? "", 3.5],
      ["title", el.getAttribute("title") ?? "", 3.5],
      ["placeholder", el.getAttribute("placeholder") ?? "", 3.5],
      ["alt", el.getAttribute("alt") ?? "", 3.5],
      ["icon", icon, 3],
      ["label", interactive ? nearbyLabel(el) : "", 2.5],
      ["text", text.length <= 200 ? text : "", 2],
      ["id", `${el.id} ${el.getAttribute("name") ?? ""} ${el.getAttribute("data-testid") ?? ""}`, 2],
      ["type", el instanceof HTMLInputElement ? el.type : "", 2],
      ["class", typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "", 1.5],
      ["href", target, 1.5],
    ];
    const fieldWords = fields.map(([field, value, weight]) => [field, wordsOf(value), weight] as const);
    let score = 0;
    let matched = 0;
    const why: string[] = [];
    for (const token of contentTokens) {
      const { exact, others } = variants(token);
      let best = 0;
      let bestField = "";
      for (const [field, words, weight] of fieldWords) {
        let value = 0;
        if (words.includes(exact)) value = weight;
        else if (exact.length >= 3 && words.some((word) => word.startsWith(exact))) value = weight * 0.8;
        else if (others.some((other) => words.includes(other))) value = weight * 0.7;
        if (value > best) {
          best = value;
          bestField = field;
        }
      }
      if (best > 0) {
        matched += 1;
        score += best;
        why.push(`${token}~${bestField}`);
      }
    }
    if (!matched) continue;
    if (matched === contentTokens.length) score += 2;
    const query = contentTokens.join(" ");
    if (query.length > 2 && contentTokens.length > 1 && (name.toLowerCase().includes(query) || text.toLowerCase().includes(query))) score += 2;
    if (roleIntent) {
      const family = ROLE_FAMILY[roleIntent] ?? [roleIntent];
      const roleMatches = family.includes(role) || (roleIntent === "button" && el instanceof HTMLInputElement && /^(submit|button|reset|image)$/.test(el.type));
      if (roleMatches) {
        score += 3;
        why.push(`role ${role}`);
      } else score -= interactive ? 2 : 3;
    } else if (interactive) score += 1;
    if (text.length > 300) score -= 2;
    if (locator.box(el).inViewport) score += 0.5;
    if (score < 1.5) continue;
    scored.push({ el, score, why, role, name, interactive });
  }
  scored.sort((a, b) => b.score - a.score || Number(b.interactive) - Number(a.interactive));
  const picked: Scored[] = [];
  for (const entry of scored) {
    // A label and its control, or a button and the icon inside it, are one
    // answer: keep the better scored, preferring the actionable one.
    const related = picked.find((other) => other.el.contains(entry.el) || entry.el.contains(other.el));
    if (related) {
      if (!related.interactive && entry.interactive && entry.score >= related.score - 1) picked[picked.indexOf(related)] = entry;
      continue;
    }
    picked.push(entry);
    if (picked.length >= args.limit) break;
  }
  const candidates = picked.map((entry): FindCandidate => {
    const box = locator.box(entry.el);
    const text = names.clean((entry.el as HTMLElement).innerText ?? "").slice(0, 80);
    const target = entry.el.matches("a[href]") ? names.linkTarget(entry.el) : null;
    return {
      ref: dom.ref(entry.el),
      selector: locator.uniqueSelector(entry.el),
      role: entry.role,
      name: entry.name.slice(0, 120),
      score: Math.round(entry.score * 10) / 10,
      why: entry.why.join(", "),
      ...(text && text !== entry.name ? { text } : {}),
      ...(target ? { target } : {}),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), inViewport: box.inViewport },
    };
  });
  return { query: args.query, count: candidates.length, candidates };
}

export function findExpression(query: string, limit: number): string {
  return `(${findProbe.toString()})(${JSON.stringify({ query, limit })}, (${createPreviewLocator.toString()})(${createPreviewDOM.toString()}), (${createPreviewNames.toString()})())`;
}

export async function findElements(target: BrowserTarget, query: string, limit = FIND_DEFAULT_LIMIT): Promise<FindResult> {
  const bounded = Math.max(1, Math.min(FIND_MAX_LIMIT, Math.round(limit)));
  return target.evaluate<FindResult>(findExpression(query, bounded));
}
