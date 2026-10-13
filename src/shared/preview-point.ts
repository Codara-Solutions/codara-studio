import type { ElementDescription, LocatorBox } from "./preview-locator";
import type { createPreviewLocator } from "./preview-locator";

// Pointing at the page: what an agent needs about an element the user picked
// (or an agent inspects) to change it in the source. Two probes run in the
// page's main world, where framework dev data lives (React fibers, Vue
// instances, Svelte metadata are expando properties an isolated world cannot
// see):
//
//   pointProbe  the full description: locator fields, box model, the styles
//               that matter for layout and look, the CSS rules that set them,
//               the DOM path, component names and source hints. Main maps
//               the hints to files (src/main/browser/point/).
//   hoverProbe  a small installable helper the picker overlay calls on every
//               pointer move: the hovered element's boxes and label.
//
// Both are stringified, so everything they use lives inside them.

export type PointEdges = [number, number, number, number];

export interface PointBoxModel {
  margin: PointEdges;
  border: PointEdges;
  padding: PointEdges;
  /** Content box size in CSS pixels. */
  content: { width: number; height: number };
}

export interface PointRule {
  selector: string;
  /** Stylesheet URL or file (a dev server's style tag names its file), or "inline". */
  source: string | null;
  declarations: string;
}

/** Where an element may come from in the source, as the page knows it. */
export interface PointSourceHint {
  /** A path, a URL, or a bundler URL such as webpack-internal:///./src/App.tsx. */
  file: string;
  line?: number;
  column?: number;
  /** react, react-stack, vue, svelte, data-attribute, angular. */
  via: string;
  component?: string;
  /** The position is in served code; main maps it through the script's source map. */
  generated?: boolean;
}

export interface PointElement extends ElementDescription {
  /** Short ancestor path, outermost first: "main > section.hero > button.cta". */
  path: string;
  boxModel: PointBoxModel;
  styles: Record<string, string>;
  rules: PointRule[];
  /** Framework component names, outermost first. */
  components: string[];
  framework: string | null;
  sources: PointSourceHint[];
  /** What a workspace search can look for when no source hint resolves. */
  hints: { classes: string[]; text: string; id?: string; testId?: string; label?: string };
}

export interface PointRegionInput {
  /** Viewport CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointRegionHit {
  index: number;
  /** Viewport and page CSS pixels of the region. */
  box: { x: number; y: number; width: number; height: number; pageX: number; pageY: number };
  /** The smallest element that holds the region, then the elements inside it. */
  elements: Array<Pick<PointElement, "ref" | "selector" | "tag" | "role" | "name" | "components" | "sources"> & { box: LocatorBox; contains: boolean }>;
}

export interface PointProbeArgs {
  selectors?: string[];
  regions?: PointRegionInput[];
  /** An attribute the picker set on elements; removed once they are found. */
  clearAttribute?: string;
}

export interface PointProbeResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  elements: PointElement[];
  regions: PointRegionHit[];
  /** Selectors that matched nothing, with the reason. */
  missing: Array<{ selector: string; error: string }>;
}

export function pointProbe(args: PointProbeArgs, locator: ReturnType<typeof createPreviewLocator>): PointProbeResult {
  const clean = (text: unknown, max = 200) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const px = (value: string) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const anyWindow = window as unknown as Record<string, unknown>;

  function stableClasses(el: Element, limit: number): string[] {
    return Array.from(el.classList)
      .filter((name) => /^[A-Za-z][\w-]{1,40}$/.test(name) && !/\d{3,}|^(css|sc|jsx|emotion|tw)-/i.test(name) && !name.startsWith("__codara"))
      .slice(0, limit);
  }

  function segment(el: Element): string {
    let out = el.tagName.toLowerCase();
    if (el.id && el.id.length <= 40) out += `#${el.id}`;
    const classes = stableClasses(el, 2);
    if (classes.length) out += `.${classes.join(".")}`;
    return out;
  }

  function domPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 7) {
      parts.unshift(segment(node));
      if (node.id && node !== el) break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function edges(style: CSSStyleDeclaration, prefix: string, suffix = ""): PointEdges {
    return ["top", "right", "bottom", "left"].map((side) => px(style.getPropertyValue(`${prefix}-${side}${suffix}`))) as PointEdges;
  }

  function boxModel(el: Element, style: CSSStyleDeclaration): PointBoxModel {
    const rect = el.getBoundingClientRect();
    const border = edges(style, "border", "-width");
    const padding = edges(style, "padding");
    return {
      margin: edges(style, "margin"),
      border,
      padding,
      content: {
        width: Math.max(0, Math.round((rect.width - border[1] - border[3] - padding[1] - padding[3]) * 100) / 100),
        height: Math.max(0, Math.round((rect.height - border[0] - border[2] - padding[0] - padding[2]) * 100) / 100),
      },
    };
  }

  function shorthand(values: PointEdges): string {
    const [t, r, b, l] = values.map((v) => `${v}px`);
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    return `${t} ${r} ${b} ${l}`;
  }

  // The properties that decide layout and look, each only when it differs
  // from what nearly every element has, so the list stays short.
  function styles(el: Element, style: CSSStyleDeclaration): Record<string, string> {
    const out: Record<string, string> = {};
    const put = (key: string, value: string, skip: RegExp | null = null) => {
      const v = clean(value, 160);
      if (v && !(skip && skip.test(v))) out[key] = v;
    };
    put("display", style.display);
    put("position", style.position, /^static$/);
    if (style.position !== "static") {
      for (const side of ["top", "right", "bottom", "left"]) put(side, style.getPropertyValue(side), /^auto$/);
    }
    const rect = el.getBoundingClientRect();
    out.size = `${Math.round(rect.width * 100) / 100}x${Math.round(rect.height * 100) / 100}`;
    put("width", style.width);
    put("height", style.height);
    for (const key of ["min-width", "min-height"]) put(key, style.getPropertyValue(key), /^(auto|0px)$/);
    for (const key of ["max-width", "max-height"]) put(key, style.getPropertyValue(key), /^none$/);
    const margin = edges(style, "margin");
    if (margin.some(Boolean)) out.margin = shorthand(margin);
    const padding = edges(style, "padding");
    if (padding.some(Boolean)) out.padding = shorthand(padding);
    const border = edges(style, "border", "-width");
    if (border.some(Boolean)) out.border = `${shorthand(border)} ${style.borderTopStyle} ${style.borderTopColor}`;
    put("border-radius", style.borderRadius, /^0px$/);
    put("box-sizing", style.boxSizing, /^content-box$/);
    if (/flex/.test(style.display)) {
      put("flex-direction", style.flexDirection, /^row$/);
      put("flex-wrap", style.flexWrap, /^nowrap$/);
      put("justify-content", style.justifyContent, /^normal$/);
      put("align-items", style.alignItems, /^normal$/);
      put("gap", style.gap, /^normal$/);
    }
    if (/grid/.test(style.display)) {
      put("grid-template-columns", style.gridTemplateColumns, /^none$/);
      put("grid-template-rows", style.gridTemplateRows, /^none$/);
      put("gap", style.gap, /^normal$/);
    }
    const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
    if (parent && /flex|grid/.test(parent.display)) {
      put("flex", style.flex, /^0 1 auto$/);
      put("align-self", style.alignSelf, /^auto$/);
    }
    put("font-family", style.fontFamily.split(",").slice(0, 2).join(","));
    put("font-size", style.fontSize);
    put("font-weight", style.fontWeight);
    put("line-height", style.lineHeight, /^normal$/);
    put("letter-spacing", style.letterSpacing, /^normal$/);
    put("text-align", style.textAlign, /^(start|left)$/);
    put("text-transform", style.textTransform, /^none$/);
    put("color", style.color);
    put("background-color", style.backgroundColor, /^rgba\(0, 0, 0, 0\)$|^transparent$/);
    put("background-image", style.backgroundImage, /^none$/);
    put("opacity", style.opacity, /^1$/);
    put("z-index", style.zIndex, /^auto$/);
    put("box-shadow", style.boxShadow, /^none$/);
    put("overflow", style.overflow, /^visible$/);
    put("transform", style.transform, /^none$/);
    return out;
  }

  // Rules from readable stylesheets that match the element, in cascade
  // order; the last ones win. A dev server's style tags name their file
  // (Vite's data-vite-dev-id), which beats an anonymous "inline".
  function rules(el: Element): PointRule[] {
    const out: PointRule[] = [];
    const sourceOf = (sheet: CSSStyleSheet): string | null => {
      if (sheet.href) {
        try {
          const url = new URL(sheet.href);
          return url.origin === location.origin ? url.pathname : sheet.href;
        } catch {
          return sheet.href;
        }
      }
      const owner = sheet.ownerNode as Element | null;
      const devId = owner?.getAttribute?.("data-vite-dev-id") || owner?.getAttribute?.("data-href") || owner?.getAttribute?.("data-source");
      return devId || "inline";
    };
    const visit = (list: CSSRuleList, source: string | null, depth: number) => {
      if (depth > 4) return;
      for (const rule of Array.from(list)) {
        if (out.length > 200) return;
        if (rule instanceof CSSStyleRule) {
          let matches = false;
          try {
            matches = el.matches(rule.selectorText);
          } catch {
            matches = false;
          }
          if (matches) out.push({ selector: clean(rule.selectorText, 160), source, declarations: clean(rule.style.cssText, 240) });
          if ((rule as unknown as { cssRules?: CSSRuleList }).cssRules?.length) visit((rule as unknown as { cssRules: CSSRuleList }).cssRules, source, depth + 1);
        } else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText || rule.media.mediaText).matches) visit(rule.cssRules, source, depth + 1);
        } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
          visit((rule as CSSGroupingRule).cssRules, source, depth + 1);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList | null = null;
      try {
        list = sheet.cssRules;
      } catch {
        list = null;
      }
      if (list) visit(list, sourceOf(sheet), 0);
    }
    for (const sheet of (document as unknown as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []) {
      try {
        visit(sheet.cssRules, "adopted", 0);
      } catch {
        /* unreadable */
      }
    }
    const inline = el.getAttribute("style");
    if (inline) out.push({ selector: "style attribute", source: "inline", declarations: clean(inline, 240) });
    return out.slice(-10);
  }

  type Fiber = {
    type?: unknown;
    return?: Fiber | null;
    _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
    _debugStack?: { stack?: string } | string | null;
    _debugOwner?: Fiber | null;
  };

  function componentName(type: unknown): string | null {
    if (!type) return null;
    if (typeof type === "function") {
      const fn = type as { displayName?: string; name?: string };
      return fn.displayName || fn.name || null;
    }
    if (typeof type === "object") {
      const obj = type as { displayName?: string; render?: unknown; type?: unknown };
      return obj.displayName || componentName(obj.render) || componentName(obj.type);
    }
    return null;
  }

  // The first frame of a React 19 owner stack that belongs to the app, not
  // React or a prebundled dependency.
  function stackFrame(stack: string): { file: string; line: number; column: number } | null {
    for (const line of stack.split("\n").slice(1)) {
      const match = /(?:\(|@|at )((?:https?|file|webpack-internal|webpack|turbopack):\/\/[^\s)]+?|\/[^\s)]+?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
      if (!match) continue;
      const file = match[1];
      if (/\/node_modules\/|\/\.vite\/deps\/|react-dom|react_jsx|react-stack|scheduler|\/_next\/static\/chunks\/(?:framework|main|webpack|react)/.test(file)) continue;
      return { file, line: Number(match[2]), column: Number(match[3]) };
    }
    return null;
  }

  function reactInfo(el: Element, sources: PointSourceHint[], components: string[]): boolean {
    const key = Object.keys(el).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
    if (!key) return false;
    const host = (el as unknown as Record<string, Fiber>)[key];
    const names: string[] = [];
    let ownerName: string | null = null;
    for (let fiber: Fiber | null | undefined = host?.return, depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
      if (typeof fiber.type === "string") continue;
      const name = componentName(fiber.type);
      if (name && !/^(Fragment|Suspense|StrictMode|Provider|Consumer)$/.test(name)) {
        names.unshift(name);
        if (!ownerName) ownerName = name;
      }
      if (names.length >= 8) break;
    }
    components.push(...names.slice(-6));
    const add = (fiber: Fiber | null | undefined, component: string | null) => {
      if (!fiber) return;
      const debug = fiber._debugSource;
      if (debug?.fileName) {
        sources.push({ file: debug.fileName, line: debug.lineNumber, column: debug.columnNumber, via: "react", ...(component ? { component } : {}) });
        return;
      }
      const raw = fiber._debugStack;
      const stack = typeof raw === "string" ? raw : raw?.stack;
      const frame = stack ? stackFrame(stack) : null;
      if (frame) sources.push({ ...frame, via: "react-stack", generated: true, ...(component ? { component } : {}) });
    };
    const owner = host?._debugOwner ? componentName(host._debugOwner.type) : ownerName;
    add(host, owner);
    for (let fiber: Fiber | null | undefined = host?.return, depth = 0; fiber && depth < 60 && sources.length < 3; fiber = fiber.return, depth++) {
      if (typeof fiber.type === "string" || !componentName(fiber.type)) continue;
      add(fiber, componentName(fiber.type));
    }
    return true;
  }

  type VueInstance = { type?: { __file?: string; name?: string; __name?: string }; parent?: VueInstance | null };
  function vueInfo(el: Element, sources: PointSourceHint[], components: string[]): boolean {
    let node: Element | null = el;
    let instance: VueInstance | null = null;
    while (node && !instance) {
      instance = (node as unknown as { __vueParentComponent?: VueInstance }).__vueParentComponent ?? null;
      node = node.parentElement;
    }
    if (instance) {
      const names: string[] = [];
      for (let current: VueInstance | null | undefined = instance, depth = 0; current && depth < 30; current = current.parent, depth++) {
        const name = current.type?.name || current.type?.__name || current.type?.__file?.split("/").pop()?.replace(/\.vue$/, "");
        if (name) names.unshift(name);
        if (current.type?.__file && sources.length < 3) sources.push({ file: current.type.__file, via: "vue", ...(name ? { component: name } : {}) });
      }
      components.push(...names.slice(-6));
      return true;
    }
    node = el;
    while (node) {
      const legacy = (node as unknown as { __vue__?: { $options?: { __file?: string; name?: string } } }).__vue__;
      if (legacy?.$options) {
        if (legacy.$options.name) components.push(legacy.$options.name);
        if (legacy.$options.__file) sources.push({ file: legacy.$options.__file, via: "vue", ...(legacy.$options.name ? { component: legacy.$options.name } : {}) });
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  type SvelteMeta = { loc?: { file?: string; line?: number; column?: number }; parent?: unknown };
  function svelteInfo(el: Element, sources: PointSourceHint[]): boolean {
    for (let node: Element | null = el, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      const meta = (node as unknown as { __svelte_meta?: SvelteMeta }).__svelte_meta;
      if (!meta?.loc?.file) continue;
      // Svelte 4 counts lines from 0; Svelte 5 (whose metadata has a parent) from 1.
      const line = typeof meta.loc.line === "number" ? meta.loc.line + ("parent" in meta ? 0 : 1) : undefined;
      const column = typeof meta.loc.column === "number" ? meta.loc.column + 1 : undefined;
      sources.push({ file: meta.loc.file, line, column, via: "svelte" });
      return true;
    }
    return false;
  }

  function angularInfo(el: Element, components: string[]): boolean {
    const ng = anyWindow.ng as { getComponent?: (el: Element) => unknown; getOwningComponent?: (el: Element) => unknown } | undefined;
    if (!ng?.getOwningComponent) return false;
    try {
      const component = ng.getComponent?.(el) || ng.getOwningComponent(el);
      const name = (component as { constructor?: { name?: string } } | null)?.constructor?.name;
      if (name) components.push(name.replace(/^_+/, ""));
      return Boolean(name);
    } catch {
      return false;
    }
  }

  // Attributes common dev plugins stamp on elements: react-dev-inspector,
  // vite-plugin-vue-inspector, code-inspector-plugin, LocatorJS, and generic
  // data-source / data-file / data-loc ones.
  function attributeInfo(el: Element, sources: PointSourceHint[]): void {
    const pathLine = /^(.+?\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?|html?|php|erb|hbs|liquid))(?::(\d+))?(?::(\d+))?/i;
    for (let node: Element | null = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const relative = node.getAttribute("data-inspector-relative-path");
      if (relative) {
        sources.push({
          file: relative,
          line: Number(node.getAttribute("data-inspector-line")) || undefined,
          column: Number(node.getAttribute("data-inspector-column")) || undefined,
          via: "data-attribute",
        });
        return;
      }
      const locator = node.getAttribute("data-locatorjs-id") || node.getAttribute("data-locatorjs");
      if (locator) {
        const [file, id] = locator.split("::");
        const data = (anyWindow.__LOCATOR_DATA__ as Record<string, { expressions?: Array<{ loc?: { start?: { line?: number; column?: number } } }> }> | undefined)?.[file];
        const start = data?.expressions?.[Number(id)]?.loc?.start;
        sources.push({ file, line: start?.line, column: typeof start?.column === "number" ? start.column + 1 : undefined, via: "data-attribute" });
        return;
      }
      for (const attr of Array.from(node.attributes)) {
        if (!/^data-.*(source|file|loc|path|inspector|insp)/i.test(attr.name)) continue;
        const match = pathLine.exec(attr.value.trim());
        if (!match) continue;
        sources.push({ file: match[1], line: match[2] ? Number(match[2]) : undefined, column: match[3] ? Number(match[3]) : undefined, via: "data-attribute" });
        return;
      }
    }
  }

  function provenance(el: Element): { sources: PointSourceHint[]; components: string[]; framework: string | null } {
    const sources: PointSourceHint[] = [];
    const components: string[] = [];
    attributeInfo(el, sources);
    let framework: string | null = null;
    if (reactInfo(el, sources, components)) framework = "react";
    else if (vueInfo(el, sources, components)) framework = "vue";
    else if (svelteInfo(el, sources)) framework = "svelte";
    else if (angularInfo(el, components)) framework = "angular";
    return { sources: sources.slice(0, 4), components, framework };
  }

  function ownText(el: Element): string {
    const direct = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" ");
    return clean(direct, 80) || clean((el as HTMLElement).innerText, 80);
  }

  function describe(el: Element): PointElement {
    const style = getComputedStyle(el);
    const base = locator.describe(el);
    const { sources, components, framework } = provenance(el);
    const classes: string[] = [];
    for (let node: Element | null = el, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      for (const name of stableClasses(node, 3)) if (!classes.includes(name)) classes.push(name);
    }
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy") || undefined;
    const label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") || undefined;
    return {
      ...base,
      path: domPath(el),
      boxModel: boxModel(el, style),
      styles: styles(el, style),
      rules: rules(el),
      components,
      framework,
      sources,
      hints: {
        classes: classes.slice(0, 6),
        text: ownText(el),
        ...(el.id ? { id: el.id } : {}),
        ...(testId ? { testId } : {}),
        ...(label ? { label: clean(label, 80) } : {}),
      },
    };
  }

  function regionHit(region: PointRegionInput, index: number): PointRegionHit {
    const x = Math.max(0, region.x);
    const y = Math.max(0, region.y);
    const right = Math.min(innerWidth, region.x + region.width);
    const bottom = Math.min(innerHeight, region.y + region.height);
    const box = { x: region.x, y: region.y, width: region.width, height: region.height, pageX: region.x + scrollX, pageY: region.y + scrollY };
    const seen = new Set<Element>();
    if (right > x && bottom > y) {
      for (const fx of [0.5, 0.15, 0.85]) {
        for (const fy of [0.5, 0.15, 0.85]) {
          const hit = locator.at(x + (right - x) * fx, y + (bottom - y) * fy);
          if (hit) seen.add(hit);
        }
      }
    }
    const area = Math.max(1, region.width * region.height);
    const overlap = (rect: DOMRect) => {
      const w = Math.min(rect.right, region.x + region.width) - Math.max(rect.left, region.x);
      const h = Math.min(rect.bottom, region.y + region.height) - Math.max(rect.top, region.y);
      return w > 0 && h > 0 ? w * h : 0;
    };
    const skip = (el: Element) => el === document.documentElement || el === document.body;
    // The innermost element holding (nearly) the whole region.
    let container: Element | null = null;
    for (const hit of seen) {
      for (let node: Element | null = hit; node; node = node.parentElement) {
        if (skip(node)) break;
        if (overlap(node.getBoundingClientRect()) >= area * 0.9) {
          const rect = node.getBoundingClientRect();
          const best = container?.getBoundingClientRect();
          if (!best || rect.width * rect.height < best.width * best.height) container = node;
          break;
        }
      }
    }
    // Elements mostly inside the region, largest first.
    const inside: Element[] = [];
    for (const hit of seen) {
      for (let node: Element | null = hit; node && !skip(node); node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        const own = Math.max(1, rect.width * rect.height);
        if (overlap(rect) >= own * 0.6 && node !== container && !inside.includes(node)) inside.push(node);
      }
    }
    inside.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const top = inside.filter((el, i) => !inside.slice(0, i).some((outer) => outer.contains(el))).slice(0, 3);
    const light = (el: Element, contains: boolean) => {
      const base = locator.describe(el);
      const { sources, components } = provenance(el);
      return { ref: base.ref, selector: base.selector, tag: base.tag, role: base.role, name: clean(base.name, 80), box: base.box, components: components.slice(-2), sources: sources.slice(0, 1), contains };
    };
    return {
      index,
      box,
      elements: [...(container ? [light(container, true)] : []), ...top.map((el) => light(el, false))],
    };
  }

  const found: Element[] = [];
  const missing: Array<{ selector: string; error: string }> = [];
  for (const selector of args.selectors ?? []) {
    try {
      found.push(locator.resolve(selector));
    } catch (error) {
      missing.push({ selector, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (args.clearAttribute) {
    for (const el of Array.from(document.querySelectorAll(`[${args.clearAttribute}]`))) el.removeAttribute(args.clearAttribute);
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    devicePixelRatio: devicePixelRatio || 1,
    elements: found.map(describe),
    regions: (args.regions ?? []).map(regionHit),
    missing,
  };
}

/** What the picker overlay draws for the element under the pointer. */
export interface HoverInfo {
  ref: string;
  label: string;
  /** CSS pixels of the page viewport. */
  rect: { x: number; y: number; width: number; height: number };
  margin: PointEdges;
  border: PointEdges;
  padding: PointEdges;
  /** Page viewport CSS pixels per host pixel, for mapping back onto the overlay. */
  scale: number;
}

export type HoverProbeCall =
  | { op: "at"; x: number; y: number; hostWidth: number }
  | { op: "ref"; ref: string; hostWidth: number }
  | { op: "parent"; ref: string; hostWidth: number }
  | { op: "child"; ref: string; hostWidth: number }
  | { op: "scroll"; x: number; y: number; dx: number; dy: number; hostWidth: number };

/**
 * Installs window.__codaraPointHover once per document and returns it. The
 * overlay calls the helper on every pointer move, so the large factory text
 * crosses the process boundary only after a navigation drops it.
 */
export function installHoverProbe(createLocator: typeof createPreviewLocator, createDOM: Parameters<typeof createPreviewLocator>[0]) {
  const host = window as unknown as { __codaraPointHover?: (call: HoverProbeCall) => HoverInfo | null };
  if (host.__codaraPointHover) return host.__codaraPointHover;
  const locator = createLocator(createDOM);
  const px = (value: string) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  const sides = (style: CSSStyleDeclaration, prefix: string, suffix = "") =>
    ["top", "right", "bottom", "left"].map((side) => px(style.getPropertyValue(`${prefix}-${side}${suffix}`))) as PointEdges;
  const info = (el: Element | null, scale: number): HoverInfo | null => {
    if (!el || el === document.documentElement) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const classes = Array.from(el.classList).filter((name) => /^[A-Za-z][\w-]{0,40}$/.test(name)).slice(0, 2);
    const label = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (classes.length ? `.${classes.join(".")}` : "");
    return {
      ref: locator.ref(el),
      label,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      margin: sides(style, "margin"),
      border: sides(style, "border", "-width"),
      padding: sides(style, "padding"),
      scale,
    };
  };
  const scaleFor = (hostWidth: number) => (hostWidth > 0 ? innerWidth / hostWidth : 1);
  const find = (ref: string): Element | null => {
    try {
      return locator.dom.find(ref, true);
    } catch {
      return null;
    }
  };
  const helper = (call: HoverProbeCall): HoverInfo | null => {
    const scale = scaleFor(call.hostWidth);
    if (call.op === "at") return info(locator.at(call.x * scale, call.y * scale), scale);
    if (call.op === "scroll") {
      let node: Element | null = locator.at(call.x * scale, call.y * scale);
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const scrollable = /(auto|scroll|overlay)/.test(style.overflowY + style.overflowX) &&
          (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
        if (scrollable) break;
        node = node.parentElement;
      }
      if (node && node !== document.documentElement) node.scrollBy({ left: call.dx * scale, top: call.dy * scale, behavior: "instant" as ScrollBehavior });
      else scrollBy({ left: call.dx * scale, top: call.dy * scale, behavior: "instant" as ScrollBehavior });
      return info(locator.at(call.x * scale, call.y * scale), scale);
    }
    const el = find(call.ref);
    if (call.op === "ref") return info(el, scale);
    if (call.op === "parent") return info(el?.parentElement && el.parentElement !== document.documentElement ? el.parentElement : el, scale);
    return info(el?.firstElementChild ?? el, scale);
  };
  host.__codaraPointHover = helper;
  return helper;
}

/** One row of the picker's outline: an element worth pointing at, indented under the rows that hold it. */
export interface OutlineRow {
  ref: string;
  depth: number;
  /** tag#id.class, as the hover label shows it. */
  label: string;
  role: string;
  name: string;
}

/**
 * The page as a short tree for picking without the mouse: landmarks,
 * headings, controls, images, list items, elements with an id or their own
 * text, and named containers (a hand-written class around several elements,
 * like a card). Elements the user cannot see are skipped with their subtree.
 */
export function outlineProbe(args: { max?: number }, locator: ReturnType<typeof createPreviewLocator>): { rows: OutlineRow[]; truncated: boolean } {
  const max = Math.max(1, Math.min(1000, args.max ?? 400));
  const rows: OutlineRow[] = [];
  let truncated = false;
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|META|LINK|TEMPLATE|svg|path)$/i;
  const notable = /^(header|nav|main|aside|footer|section|article|form|dialog|h[1-6]|a|button|input|select|textarea|label|img|video|canvas|li|table|figure|summary)$/;
  // Hashed names from CSS modules and CSS-in-JS say nothing about the element.
  const named = (name: string) =>
    /^[A-Za-z][\w-]{1,40}$/.test(name) &&
    !/\d{3}|^(css|sc|jsx|svelte|emotion)-|__[a-zA-Z0-9]{5,}$|[_-](?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{5,}$/i.test(name);
  const walk = (el: Element, depth: number) => {
    if (truncated || skip.test(el.tagName)) return;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    const tag = el.tagName.toLowerCase();
    const ownText = clean(Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(" "));
    const include = locator.dom.visible(el) &&
      (notable.test(tag) || el.id !== "" || el.hasAttribute("role") || el.hasAttribute("data-testid") || ownText.length > 0 ||
        (el.children.length > 1 && Array.from(el.classList).some(named)));
    if (include) {
      if (rows.length >= max) {
        truncated = true;
        return;
      }
      const classes = Array.from(el.classList).filter((name) => /^[A-Za-z][\w-]{0,40}$/.test(name)).slice(0, 2);
      rows.push({
        ref: locator.ref(el),
        depth,
        label: tag + (el.id ? `#${el.id}` : "") + (classes.length ? `.${classes.join(".")}` : ""),
        role: locator.role(el),
        name: (locator.accessibleName(el) || ownText).slice(0, 80),
      });
    }
    for (const child of Array.from(el.children)) walk(child, depth + (include ? 1 : 0));
  };
  walk(document.body, 0);
  return { rows, truncated };
}
