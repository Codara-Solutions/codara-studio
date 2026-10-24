// Playwright-style locators for codara_preview_code, resolved in the page.
// Stringified into the browser guest with the shared locator: keep every
// dependency inside the factory.

import type { createPreviewLocator, ElementDescription } from "./preview-locator";

/** A string matches as a case-insensitive substring unless exact; a pattern is a RegExp's source and flags. */
export type TextMatch = string | { re: string; flags?: string };

export type LocatorStep =
  | { css: string }
  | { ref: string }
  | { role: string; name?: TextMatch; exact?: boolean; checked?: boolean; level?: number; includeHidden?: boolean }
  | { text: TextMatch; exact?: boolean; includeHidden?: boolean }
  | { label: TextMatch; exact?: boolean; includeHidden?: boolean }
  | { placeholder: TextMatch; exact?: boolean; includeHidden?: boolean }
  | { altText: TextMatch; exact?: boolean; includeHidden?: boolean }
  | { title: TextMatch; exact?: boolean; includeHidden?: boolean }
  | { testId: string }
  | { nth: number }
  | { filter: { hasText?: TextMatch; hasNotText?: TextMatch; visible?: boolean } };

export type LocatorOp =
  | { op: "count" }
  | { op: "resolve"; timeoutMs?: number }
  | { op: "wait"; state?: "attached" | "detached" | "visible" | "hidden"; timeoutMs?: number }
  | { op: "read"; prop: "textContent" | "innerText" | "inputValue" | "attribute" | "visible" | "enabled" | "checked" | "box"; name?: string; timeoutMs?: number }
  | { op: "texts"; inner?: boolean }
  | { op: "refs" };

export interface ResolvedElement extends ElementDescription {
  count: number;
}

export function createPreviewQuery(locator: ReturnType<typeof createPreviewLocator>) {
  const dom = locator.dom;
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  // Roles the shared locator leaves generic, and Playwright's names for two it spells differently.
  const EXTRA_ROLES: Record<string, string> = {
    p: "paragraph", section: "region", article: "article", aside: "complementary", hr: "separator",
    progress: "progressbar", option: "option", fieldset: "group", menu: "list", output: "status",
  };
  const ROLE_ALIASES: Record<string, string> = { img: "image", image: "img" };

  function matches(value: string, match: TextMatch, exact?: boolean): boolean {
    const text = clean(value);
    if (typeof match !== "string") return new RegExp(match.re, match.flags ?? "").test(text);
    const wanted = clean(match);
    return exact ? text === wanted : text.toLowerCase().includes(wanted.toLowerCase());
  }

  function describeMatch(match: TextMatch): string {
    return typeof match === "string" ? JSON.stringify(match) : `/${match.re}/${match.flags ?? ""}`;
  }

  /** Every element under root, inside open shadow roots too, in document order. */
  function everything(root: ParentNode): Element[] {
    const out: Element[] = [];
    const visit = (node: ParentNode) => {
      for (const el of Array.from(node.children)) {
        if (SKIPPED.has(el.tagName)) continue;
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(root);
    return out;
  }

  function cssUnder(root: ParentNode, selector: string): Element[] {
    const out = Array.from(root.querySelectorAll(selector));
    for (const el of everything(root)) if (el.shadowRoot) out.push(...Array.from(el.shadowRoot.querySelectorAll(selector)));
    return out;
  }

  function role(el: Element): string {
    const found = locator.role(el);
    if (found !== "generic") return found;
    const tag = el.tagName.toLowerCase();
    if (tag === "section" && !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) return "generic";
    return EXTRA_ROLES[tag] ?? found;
  }

  function checked(el: Element): boolean | undefined {
    if (el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type)) return el.checked;
    const aria = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected");
    return aria === null ? undefined : aria === "true";
  }

  function level(el: Element): number | undefined {
    const aria = Number(el.getAttribute("aria-level"));
    if (aria) return aria;
    const heading = /^H([1-6])$/.exec(el.tagName);
    return heading ? Number(heading[1]) : undefined;
  }

  function labelTexts(el: Element): string[] {
    const texts: string[] = [];
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent : "")).filter(Boolean).join(" ");
    if (labelledBy) texts.push(labelledBy);
    if ("labels" in el) {
      for (const label of Array.from((el as HTMLInputElement).labels ?? [])) {
        const copy = label.cloneNode(true) as Element;
        copy.querySelectorAll("input, select, textarea, button").forEach((node) => node.remove());
        texts.push(copy.textContent ?? "");
      }
    }
    const aria = el.getAttribute("aria-label");
    if (aria) texts.push(aria);
    return texts;
  }

  function textOf(el: Element): string {
    return el instanceof HTMLElement && dom.visible(el) ? el.innerText : el.textContent ?? "";
  }

  /** The innermost elements whose text matches: a button and its label span are one answer, the span. */
  function byText(root: ParentNode, match: TextMatch, exact?: boolean): Element[] {
    const plain = typeof match === "string" && !exact ? clean(match).toLowerCase() : null;
    const hits = everything(root).filter((el) => {
      if (plain !== null && !clean(el.textContent).toLowerCase().includes(plain)) return false;
      return matches(textOf(el), match, exact);
    });
    const set = new Set(hits);
    return hits.filter((el) => !Array.from(el.querySelectorAll("*")).some((child) => set.has(child)));
  }

  function shown(list: Element[], includeHidden?: boolean): Element[] {
    return includeHidden ? list : list.filter((el) => dom.visible(el));
  }

  function apply(scopes: ParentNode[], step: LocatorStep): Element[] {
    if ("nth" in step) return [];
    const out: Element[] = [];
    for (const root of scopes) {
      if ("css" in step) out.push(...cssUnder(root, step.css));
      else if ("ref" in step) {
        const el = dom.find(step.ref, true);
        if (el && (root === document || root.contains(el))) out.push(el);
      } else if ("role" in step) {
        const wanted = step.role.toLowerCase();
        out.push(...shown(everything(root), step.includeHidden).filter((el) => {
          const actual = role(el);
          if (actual !== wanted && ROLE_ALIASES[wanted] !== actual) return false;
          if (step.name !== undefined && !matches(locator.accessibleName(el), step.name, step.exact)) return false;
          if (step.checked !== undefined && checked(el) !== step.checked) return false;
          if (step.level !== undefined && level(el) !== step.level) return false;
          return true;
        }));
      } else if ("text" in step) out.push(...shown(byText(root, step.text, step.exact), step.includeHidden));
      else if ("label" in step) {
        out.push(...shown(everything(root), step.includeHidden).filter((el) => labelTexts(el).some((text) => matches(text, step.label, step.exact))));
      } else if ("placeholder" in step) {
        out.push(...shown(cssUnder(root, "[placeholder]"), step.includeHidden).filter((el) => matches(el.getAttribute("placeholder") ?? "", step.placeholder, step.exact)));
      } else if ("altText" in step) {
        out.push(...shown(cssUnder(root, "[alt]"), step.includeHidden).filter((el) => matches(el.getAttribute("alt") ?? "", step.altText, step.exact)));
      } else if ("title" in step) {
        out.push(...shown(cssUnder(root, "[title]"), step.includeHidden).filter((el) => matches(el.getAttribute("title") ?? "", step.title, step.exact)));
      } else if ("testId" in step) {
        out.push(...cssUnder(root, `[data-testid=${JSON.stringify(step.testId)}]`));
      }
    }
    return [...new Set(out)];
  }

  function resolveChain(chain: LocatorStep[]): Element[] {
    let current: Element[] | null = null;
    for (const step of chain) {
      if ("nth" in step) {
        const list: Element[] = current ?? [];
        const el = step.nth < 0 ? list[list.length + step.nth] : list[step.nth];
        current = el ? [el] : [];
      } else if ("filter" in step) {
        const { hasText, hasNotText, visible } = step.filter;
        const list: Element[] = current ?? [];
        current = list.filter((el) =>
          (hasText === undefined || matches(textOf(el), hasText)) &&
          (hasNotText === undefined || !matches(textOf(el), hasNotText)) &&
          (visible === undefined || dom.visible(el) === visible),
        );
      } else {
        current = apply(current ?? [document], step);
      }
    }
    return current ?? [];
  }

  function describeChain(chain: LocatorStep[]): string {
    return chain.map((step) => {
      if ("css" in step) return `locator(${JSON.stringify(step.css)})`;
      if ("ref" in step) return `ref(${JSON.stringify(step.ref)})`;
      if ("role" in step) return `getByRole(${JSON.stringify(step.role)}${step.name !== undefined ? `, { name: ${describeMatch(step.name)} }` : ""})`;
      if ("text" in step) return `getByText(${describeMatch(step.text)})`;
      if ("label" in step) return `getByLabel(${describeMatch(step.label)})`;
      if ("placeholder" in step) return `getByPlaceholder(${describeMatch(step.placeholder)})`;
      if ("altText" in step) return `getByAltText(${describeMatch(step.altText)})`;
      if ("title" in step) return `getByTitle(${describeMatch(step.title)})`;
      if ("testId" in step) return `getByTestId(${JSON.stringify(step.testId)})`;
      if ("nth" in step) return step.nth === 0 ? "first()" : step.nth === -1 ? "last()" : `nth(${step.nth})`;
      return `filter(${JSON.stringify(step.filter)})`;
    }).join(".");
  }

  function short(el: Element): string {
    const d = locator.describe(el);
    return `${d.role} ${d.ref}${d.name ? ` ${JSON.stringify(d.name.slice(0, 60))}` : ""}`;
  }

  async function poll<T>(timeoutMs: number | undefined, check: () => T | undefined): Promise<T | undefined> {
    const deadline = Date.now() + Math.min(30_000, Math.max(0, timeoutMs ?? 5000));
    for (;;) {
      const value = check();
      if (value !== undefined || Date.now() >= deadline) return value;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  /** The one element the chain names, waiting for it to exist; several matches fail like Playwright's strict mode. */
  async function strict(chain: LocatorStep[], timeoutMs?: number): Promise<Element> {
    let found: Element[] = [];
    await poll(timeoutMs, () => {
      found = resolveChain(chain);
      return found.length ? true : undefined;
    });
    if (!found.length) throw new Error(`${describeChain(chain)} matched no element within ${timeoutMs ?? 5000} ms. Read the page with tab.snapshot().`);
    if (found.length > 1) {
      const listed = found.slice(0, 4).map(short).join("; ");
      throw new Error(`${describeChain(chain)} matched ${found.length} elements (${listed}${found.length > 4 ? "; ..." : ""}). Narrow it, or use first(), last() or nth(i).`);
    }
    return found[0];
  }

  async function run(chain: LocatorStep[], request: LocatorOp): Promise<unknown> {
    switch (request.op) {
      case "count":
        return resolveChain(chain).length;
      case "resolve": {
        const el = await strict(chain, request.timeoutMs);
        return { ...locator.describe(el), count: 1 } satisfies ResolvedElement;
      }
      case "wait": {
        const state = request.state ?? "visible";
        const met = await poll(request.timeoutMs, () => {
          const list = resolveChain(chain);
          const anyVisible = list.some((el) => dom.visible(el));
          const ok = state === "attached" ? list.length > 0 : state === "detached" ? list.length === 0 : state === "visible" ? anyVisible : !anyVisible;
          return ok ? true : undefined;
        });
        if (!met) throw new Error(`${describeChain(chain)} did not become ${state} within ${request.timeoutMs ?? 5000} ms.`);
        return { state };
      }
      case "read": {
        if (request.prop === "visible") {
          const list = resolveChain(chain);
          return list.length === 1 ? dom.visible(list[0]) : list.length > 1 ? (await strict(chain, 0), false) : false;
        }
        const el = await strict(chain, request.timeoutMs);
        switch (request.prop) {
          case "textContent": return el.textContent;
          case "innerText": return el instanceof HTMLElement ? el.innerText : el.textContent;
          case "inputValue": {
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
              throw new Error(`${describeChain(chain)} is not an input, textarea or select.`);
            }
            return el instanceof HTMLInputElement && el.type === "password" ? "[redacted]" : el.value;
          }
          case "attribute": return el.getAttribute(request.name ?? "");
          case "enabled": return !el.matches(':disabled, [aria-disabled="true"]');
          case "checked": return checked(el) === true;
          case "box": {
            const box = locator.box(el);
            return box.visible ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
          }
        }
        return null;
      }
      case "texts":
        return resolveChain(chain).map((el) => clean(request.inner ? textOf(el) : el.textContent));
      case "refs":
        return resolveChain(chain).map((el) => dom.ref(el));
    }
    throw new Error("unknown locator op");
  }

  return { resolveChain, describeChain, run };
}
