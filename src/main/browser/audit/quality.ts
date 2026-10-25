// Page-quality checks in the spirit of Lighthouse's performance,
// best-practices and SEO categories, measured on the page as it is: no
// reload, no throttling, no DevTools window. Full Lighthouse is not used: it
// needs a browser-level DevTools endpoint (a remote-debugging port would
// expose every Codara window to local processes), it navigates, throttles
// and clears storage on the tab it audits, and it costs hundreds of
// megabytes in the main process. The findings come from the page's DOM,
// resource timing and the tab's console and network recorders.

import { writeBrowserArtifact } from "../artifacts";
import type { PreviewLocator } from "../locator";
import { consoleRing } from "../recorders/console";
import { networkRing } from "../recorders/network";
import type { BrowserTarget } from "../targets";
import { refsForSelectors, runWorldLocator } from "./world";

export type CheckStatus = "pass" | "warn" | "fail";
export type QualityCategory = "performance" | "bestPractices" | "seo";

export interface CheckItem {
  ref?: string;
  selector?: string;
  url?: string;
  note?: string;
}

export interface QualityCheck {
  id: string;
  category: QualityCategory;
  status: CheckStatus;
  title: string;
  detail?: string;
  items?: CheckItem[];
  more?: number;
}

interface ProbeItem {
  selector?: string;
  url?: string;
  note?: string;
}

interface ProbeList {
  count: number;
  items: ProbeItem[];
}

export interface QualityProbe {
  url: string;
  protocol: string;
  local: boolean;
  timeOrigin: number;
  viewportWidth: number;
  dom: { elements: number; depth: number; maxChildren: number; maxChildrenSelector: string | null };
  nav: { ttfb: number | null; status: number | null; domContentLoaded: number | null; load: number | null; fcp: number | null };
  resources: { requests: number; bytes: number; biggest: ProbeItem[] };
  blocking: { totalMs: number; items: ProbeItem[]; count: number };
  uncompressed: ProbeList;
  mixedContent: ProbeList;
  images: { oversized: ProbeList; wastedBytes: number; unsized: ProbeList; offscreenEager: ProbeList; distorted: ProbeList; missingAlt: ProbeList };
  head: {
    doctype: boolean;
    standardsMode: boolean;
    charsetDeclared: boolean;
    characterSet: string;
    viewport: string | null;
    title: string;
    description: string | null;
    lang: string;
    robots: string | null;
    canonical: string[];
    jsonLd: { count: number; invalid: number };
  };
  links: { generic: ProbeList; uncrawlable: ProbeList };
  smallText: { ratio: number; sampled: number };
}

// Runs in the insight world. Stringified: it may use only its arguments
// and page globals.
function qualityProbe(args: { itemsKept: number }, locator: PreviewLocator): QualityProbe {
  const keep = args.itemsKept;
  const list = (): ProbeList => ({ count: 0, items: [] });
  const add = (target: ProbeList, item: ProbeItem) => {
    target.count += 1;
    if (target.items.length < keep) target.items.push(item);
  };
  const sel = (el: Element) => {
    try {
      return locator.uniqueSelector(el);
    } catch {
      return el.tagName.toLowerCase();
    }
  };
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(location.hostname) || location.hostname.endsWith(".localhost") || location.protocol === "file:";

  let elements = 0;
  let depth = 0;
  let maxChildren = 0;
  let maxChildrenEl: Element | null = null;
  // Iterative: a pathological page nests deeper than the call stack allows.
  const stack: Array<[Element, number]> = document.documentElement ? [[document.documentElement, 1]] : [];
  while (stack.length) {
    const [el, level] = stack.pop()!;
    elements += 1;
    if (level > depth) depth = level;
    if (el.children.length > maxChildren) {
      maxChildren = el.children.length;
      maxChildrenEl = el;
    }
    for (const child of Array.from(el.children)) stack.push([child, level + 1]);
  }

  type NavTiming = PerformanceNavigationTiming & { responseStatus?: number; activationStart?: number };
  const nav = performance.getEntriesByType("navigation")[0] as NavTiming | undefined;
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const round = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
  const activation = nav?.activationStart ?? 0;

  type ResourceTiming = PerformanceResourceTiming & { renderBlockingStatus?: string; responseStatus?: number };
  const resources = performance.getEntriesByType("resource") as ResourceTiming[];
  const all = nav ? [nav as unknown as ResourceTiming, ...resources] : resources;
  const size = (entry: ResourceTiming) => Math.max(entry.transferSize || 0, entry.encodedBodySize || 0);
  let bytes = 0;
  for (const entry of all) bytes += size(entry);
  const biggest = [...all].sort((a, b) => size(b) - size(a)).filter((entry) => size(entry) > 0).slice(0, 3)
    .map((entry) => ({ url: entry.name, note: `${Math.round(size(entry) / 1024)} KB` }));

  const blocking = { totalMs: 0, items: [] as ProbeItem[], count: 0 };
  const blockingUrls = new Set<string>();
  for (const entry of resources) {
    if (entry.renderBlockingStatus !== "blocking") continue;
    blockingUrls.add(entry.name);
    blocking.count += 1;
    blocking.totalMs += entry.duration;
    if (blocking.items.length < keep) blocking.items.push({ url: entry.name, note: `${Math.round(entry.duration)} ms` });
  }
  for (const script of Array.from(document.head?.querySelectorAll("script[src]") ?? [])) {
    const el = script as HTMLScriptElement;
    if (el.async || el.defer || el.type === "module" || blockingUrls.has(el.src)) continue;
    blocking.count += 1;
    if (blocking.items.length < keep) blocking.items.push({ url: el.src, note: "synchronous script in <head>" });
  }
  blocking.totalMs = Math.round(blocking.totalMs);

  const uncompressed = list();
  const textLike = /\.(m?js|css|json|html?|svg|xml|txt|map)(\?|$)/i;
  for (const entry of all) {
    const textual = textLike.test(entry.name) || ["script", "link", "css", "xmlhttprequest", "fetch", "navigation"].includes(entry.initiatorType);
    if (!textual || entry.decodedBodySize <= 1400 || entry.encodedBodySize <= 0) continue;
    if (entry.encodedBodySize >= entry.decodedBodySize) add(uncompressed, { url: entry.name, note: `${Math.round(entry.decodedBodySize / 1024)} KB` });
  }

  const mixedContent = list();
  if (location.protocol === "https:") {
    for (const entry of resources) if (entry.name.startsWith("http:")) add(mixedContent, { url: entry.name });
  }

  const sizeOf = new Map(resources.map((entry) => [entry.name, size(entry)]));
  const oversized = list();
  const unsized = list();
  const offscreenEager = list();
  const distorted = list();
  const missingAlt = list();
  let wastedBytes = 0;
  const dpr = devicePixelRatio || 1;
  for (const img of Array.from(document.images)) {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const shown = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    if (!img.hasAttribute("alt") && img.getAttribute("role") !== "presentation") add(missingAlt, { selector: sel(img) });
    if (!shown || !img.complete || !img.naturalWidth) continue;
    const source = img.currentSrc || img.src;
    const isSvg = /\.svg(\?|$)/i.test(source) || source.startsWith("data:image/svg");
    const naturalArea = img.naturalWidth * img.naturalHeight;
    const shownArea = rect.width * rect.height * dpr * dpr;
    if (!isSvg && img.naturalWidth > 64 && naturalArea > shownArea * 2.25) {
      const imageBytes = sizeOf.get(source) ?? 0;
      const wasted = imageBytes ? Math.round(imageBytes * (1 - shownArea / naturalArea)) : 0;
      wastedBytes += wasted;
      add(oversized, {
        selector: sel(img),
        note: `${img.naturalWidth}x${img.naturalHeight} shown at ${Math.round(rect.width)}x${Math.round(rect.height)}${wasted ? `, about ${Math.round(wasted / 1024)} KB wasted` : ""}`,
      });
    }
    const sizedByAttributes = img.hasAttribute("width") && img.hasAttribute("height");
    const sizedByStyle = (img.style.width && img.style.height) || (style.aspectRatio && style.aspectRatio !== "auto" && !/^auto\s/.test(style.aspectRatio));
    if (!sizedByAttributes && !sizedByStyle && style.position !== "absolute" && style.position !== "fixed") add(unsized, { selector: sel(img) });
    if (rect.top + scrollY > innerHeight * 2 && img.loading !== "lazy") add(offscreenEager, { selector: sel(img) });
    if (!isSvg && (style.objectFit === "fill" || !style.objectFit) && rect.height > 0) {
      const shownRatio = rect.width / rect.height;
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      if (Math.abs(shownRatio - naturalRatio) / naturalRatio > 0.05) {
        add(distorted, { selector: sel(img), note: `${img.naturalWidth}x${img.naturalHeight} shown at ${Math.round(rect.width)}x${Math.round(rect.height)}` });
      }
    }
  }

  const meta = (name: string) => document.querySelector(`meta[name="${name}" i]`)?.getAttribute("content") ?? null;
  const jsonLd = { count: 0, invalid: 0 };
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    jsonLd.count += 1;
    try {
      JSON.parse(script.textContent ?? "");
    } catch {
      jsonLd.invalid += 1;
    }
  }

  const generic = list();
  const uncrawlable = list();
  const genericText = /^(click here|click|here|more|read more|learn more|go|this|link|start|continue|right here)$/i;
  for (const link of Array.from(document.querySelectorAll("a"))) {
    const href = link.getAttribute("href");
    const text = (link.textContent ?? "").replace(/\s+/g, " ").trim();
    if (href !== null && genericText.test(text) && !link.getAttribute("aria-label")) add(generic, { selector: sel(link), note: text });
    if (href !== null && /^\s*javascript:/i.test(href)) add(uncrawlable, { selector: sel(link), note: href.slice(0, 60) });
    else if (href === null && (link.hasAttribute("onclick") || link.getAttribute("role") === "link")) add(uncrawlable, { selector: sel(link), note: "no href" });
  }

  let smallChars = 0;
  let totalChars = 0;
  let sampled = 0;
  const walker = document.body ? document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT) : null;
  const sizes = new Map<Element, number>();
  for (let node = walker?.nextNode(); node && sampled < 3000; node = walker?.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (!text || !parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
    let fontSize = sizes.get(parent);
    if (fontSize === undefined) {
      if (!parent.getClientRects().length) continue;
      fontSize = parseFloat(getComputedStyle(parent).fontSize) || 16;
      sizes.set(parent, fontSize);
    }
    sampled += 1;
    totalChars += text.length;
    if (fontSize < 12) smallChars += text.length;
  }

  return {
    url: location.href,
    protocol: location.protocol,
    local,
    timeOrigin: performance.timeOrigin,
    viewportWidth: innerWidth,
    dom: { elements, depth, maxChildren, maxChildrenSelector: maxChildrenEl ? sel(maxChildrenEl) : null },
    nav: {
      ttfb: nav ? round(Math.max(0, nav.responseStart - activation)) : null,
      status: nav && nav.responseStatus ? nav.responseStatus : null,
      domContentLoaded: nav ? round(nav.domContentLoadedEventEnd) : null,
      load: nav && nav.loadEventEnd ? round(nav.loadEventEnd) : null,
      fcp: fcp ? round(Math.max(0, fcp.startTime - activation)) : null,
    },
    resources: { requests: all.length, bytes, biggest },
    blocking,
    uncompressed,
    mixedContent,
    images: { oversized, wastedBytes, unsized, offscreenEager, distorted, missingAlt },
    head: {
      doctype: document.doctype?.name.toLowerCase() === "html",
      standardsMode: document.compatMode === "CSS1Compat",
      charsetDeclared: Boolean(document.querySelector("meta[charset], meta[http-equiv='content-type' i]")),
      characterSet: document.characterSet,
      viewport: meta("viewport"),
      title: (document.title ?? "").trim(),
      description: meta("description"),
      lang: document.documentElement?.getAttribute("lang") ?? "",
      robots: [meta("robots"), meta("googlebot")].filter(Boolean).join(", ") || null,
      canonical: Array.from(document.querySelectorAll("link[rel='canonical' i]")).map((link) => link.getAttribute("href") ?? ""),
      jsonLd,
    },
    links: { generic, uncrawlable },
    smallText: { ratio: totalChars ? smallChars / totalChars : 0, sampled },
  };
}

const ITEMS_KEPT = 5;

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function since<T extends { at: string }>(entries: readonly T[], timeOrigin: number): T[] {
  // A little slack: the recorder stamps entries on arrival in main.
  return entries.filter((entry) => Date.parse(entry.at) >= timeOrigin - 1_000);
}

export interface SessionEvidence {
  consoleErrors: Array<{ message: string; source: string | null }>;
  deprecations: Array<{ message: string }>;
  failedRequests: Array<{ url: string; status: number | null; errorText: string | null }>;
}

export function sessionEvidence(target: BrowserTarget, timeOrigin: number): SessionEvidence {
  const consoleEntries = since(consoleRing(target.session).toArray(), timeOrigin);
  const networkEntries = since(networkRing(target.session).toArray(), timeOrigin);
  return {
    consoleErrors: consoleEntries.filter((entry) => entry.level === "error").map((entry) => ({ message: entry.message, source: entry.source })),
    deprecations: consoleEntries.filter((entry) => entry.level !== "error" && /deprecat/i.test(entry.message)).map((entry) => ({ message: entry.message })),
    failedRequests: networkEntries
      .filter((entry) => entry.failed || (typeof entry.status === "number" && entry.status >= 400))
      .map((entry) => ({ url: entry.url, status: entry.status, errorText: entry.errorText })),
  };
}

function check(
  id: string,
  category: QualityCategory,
  title: string,
  status: CheckStatus,
  detail?: string,
  list?: ProbeList | { count: number; items: ProbeItem[] },
): QualityCheck {
  const result: QualityCheck = { id, category, status, title };
  if (status !== "pass" && detail) result.detail = detail;
  if (status !== "pass" && list?.items.length) {
    result.items = list.items.map((item) => ({ ...item }));
    if (list.count > list.items.length) result.more = list.count - list.items.length;
  }
  return result;
}

function listOf<T>(values: readonly T[], map: (value: T) => ProbeItem): ProbeList {
  return { count: values.length, items: values.slice(0, ITEMS_KEPT).map(map) };
}

/** Turn the page probe and the tab's recorders into scored checks. Pure, for tests. */
export function evaluateQuality(probe: QualityProbe, evidence: SessionEvidence): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const devNote = probe.local ? " (a local dev server; production builds usually differ)" : "";

  const ttfb = probe.nav.ttfb;
  checks.push(check("server-response", "performance", "Server responds quickly", ttfb === null || ttfb < 600 ? "pass" : ttfb < 1800 ? "warn" : "fail", `Time to first byte ${ttfb} ms.`));
  checks.push(check(
    "render-blocking", "performance", "No render-blocking resources",
    probe.blocking.count === 0 || probe.blocking.totalMs < 100 ? "pass" : probe.blocking.totalMs < 500 ? "warn" : "fail",
    `${probe.blocking.count} resource${probe.blocking.count === 1 ? " blocks" : "s block"} the first paint for ${probe.blocking.totalMs} ms; defer scripts and inline critical CSS.`,
    probe.blocking,
  ));
  const dom = probe.dom;
  checks.push(check(
    "dom-size", "performance", "DOM size is reasonable",
    dom.elements > 1400 ? "fail" : dom.elements > 800 || dom.depth > 32 || dom.maxChildren > 60 ? "warn" : "pass",
    `${dom.elements} elements, ${dom.depth} levels deep, up to ${dom.maxChildren} children on one element.`,
    dom.maxChildren > 60 && dom.maxChildrenSelector ? { count: 1, items: [{ selector: dom.maxChildrenSelector, note: `${dom.maxChildren} children` }] } : undefined,
  ));
  const images = probe.images;
  checks.push(check(
    "image-sizing", "performance", "Images are not larger than shown",
    images.oversized.count === 0 ? "pass" : images.wastedBytes > 100 * 1024 ? "fail" : "warn",
    `${images.oversized.count} image${images.oversized.count === 1 ? " is" : "s are"} much larger than displayed${images.wastedBytes ? `, about ${kb(images.wastedBytes)} wasted` : ""}.`,
    images.oversized,
  ));
  checks.push(check("unsized-images", "performance", "Images have explicit width and height", images.unsized.count ? "warn" : "pass", "Images without width and height (or aspect-ratio) shift the layout when they load.", images.unsized));
  checks.push(check("offscreen-images", "performance", "Off-screen images load lazily", images.offscreenEager.count ? "warn" : "pass", 'Add loading="lazy" to images far below the fold.', images.offscreenEager));
  checks.push(check(
    "text-compression", "performance", "Text resources are compressed",
    probe.uncompressed.count === 0 ? "pass" : probe.local ? "warn" : "fail",
    `${probe.uncompressed.count} text response${probe.uncompressed.count === 1 ? " is" : "s are"} served without gzip or brotli${devNote}.`,
    probe.uncompressed,
  ));
  const weight = probe.resources.bytes;
  checks.push(check(
    "page-weight", "performance", "Total page weight is reasonable",
    weight < 1.6 * 1024 * 1024 ? "pass" : weight < 4 * 1024 * 1024 ? "warn" : "fail",
    `${kb(weight)} over ${probe.resources.requests} requests${devNote}.`,
    { count: probe.resources.biggest.length, items: probe.resources.biggest },
  ));

  checks.push(check("https", "bestPractices", "Uses HTTPS", probe.protocol === "https:" || probe.local || probe.protocol === "file:" ? "pass" : "fail", "The page is served over plain HTTP."));
  checks.push(check("mixed-content", "bestPractices", "No mixed content", probe.mixedContent.count ? "fail" : "pass", "An HTTPS page loads resources over HTTP.", probe.mixedContent));
  checks.push(check(
    "console-errors", "bestPractices", "No errors in the console",
    evidence.consoleErrors.length ? "fail" : "pass",
    `${evidence.consoleErrors.length} error${evidence.consoleErrors.length === 1 ? "" : "s"} since the page loaded (codara_preview_console has them all).`,
    listOf(evidence.consoleErrors, (entry) => ({ note: entry.message.split("\n")[0].slice(0, 200), ...(entry.source ? { url: entry.source } : {}) })),
  ));
  checks.push(check(
    "failed-requests", "bestPractices", "No failed requests",
    evidence.failedRequests.length ? "fail" : "pass",
    `${evidence.failedRequests.length} request${evidence.failedRequests.length === 1 ? "" : "s"} failed since the page loaded.`,
    listOf(evidence.failedRequests, (entry) => ({ url: entry.url, note: entry.status ? `HTTP ${entry.status}` : entry.errorText ?? "failed" })),
  ));
  checks.push(check("deprecations", "bestPractices", "No deprecated APIs", evidence.deprecations.length ? "warn" : "pass", "The browser reported deprecated APIs.", listOf(evidence.deprecations, (entry) => ({ note: entry.message.slice(0, 200) }))));
  const head = probe.head;
  checks.push(check("doctype", "bestPractices", "Has an HTML doctype", head.doctype && head.standardsMode ? "pass" : "fail", "Without <!doctype html> the page renders in quirks mode."));
  checks.push(check("charset", "bestPractices", "Declares a character set", head.charsetDeclared ? "pass" : "warn", `No <meta charset>; the page decoded as ${head.characterSet}.`));
  const viewport = head.viewport ?? "";
  const maximumScale = Number(/maximum-scale\s*=\s*([\d.]+)/i.exec(viewport)?.[1] ?? 5);
  const zoomBlocked = /user-scalable\s*=\s*(no|0)/i.test(viewport) || maximumScale < 5;
  checks.push(check(
    "viewport", "bestPractices", "Has a mobile viewport that allows zoom",
    !/width\s*=\s*device-width/i.test(viewport) ? "fail" : zoomBlocked ? "warn" : "pass",
    !viewport ? 'No <meta name="viewport" content="width=device-width, initial-scale=1">.' : zoomBlocked ? "The viewport blocks pinch zoom." : `The viewport meta is "${viewport}".`,
  ));
  checks.push(check("image-aspect-ratio", "bestPractices", "Images keep their aspect ratio", images.distorted.count ? "warn" : "pass", "Images are stretched; use object-fit or matching dimensions.", images.distorted));

  checks.push(check("document-title", "seo", "Has a title", head.title ? "pass" : "fail", "The page has no <title>."));
  checks.push(check("meta-description", "seo", "Has a meta description", head.description?.trim() ? "pass" : "fail", 'No <meta name="description">.'));
  const status = probe.nav.status;
  checks.push(check("http-status", "seo", "Page loads with a success status", status !== null && status >= 400 ? "fail" : "pass", `The page answered HTTP ${status}.`));
  checks.push(check("crawlable", "seo", "Page is not blocked from indexing", head.robots && /noindex|none/i.test(head.robots) ? "fail" : "pass", `Robots meta says "${head.robots}".`));
  checks.push(check("html-lang", "seo", "Has a valid lang attribute", /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(head.lang) ? "pass" : "fail", head.lang ? `lang="${head.lang}" is not a language tag.` : "<html> has no lang attribute."));
  checks.push(check("link-text", "seo", "Links have descriptive text", probe.links.generic.count ? "warn" : "pass", 'Links named only "click here", "more" and the like.', probe.links.generic));
  checks.push(check("crawlable-anchors", "seo", "Links are crawlable", probe.links.uncrawlable.count ? "warn" : "pass", "Anchors without a real href.", probe.links.uncrawlable));
  const canonicalInvalid = head.canonical.length > 1 || head.canonical.some((href) => {
    try {
      new URL(href, probe.url);
      return !href.trim();
    } catch {
      return true;
    }
  });
  checks.push(check("canonical", "seo", "Canonical link is valid", canonicalInvalid ? "fail" : "pass", head.canonical.length > 1 ? `${head.canonical.length} canonical links.` : "The canonical link is not a valid URL."));
  checks.push(check("structured-data", "seo", "Structured data parses", head.jsonLd.invalid ? "fail" : "pass", `${head.jsonLd.invalid} of ${head.jsonLd.count} JSON-LD blocks are not valid JSON.`));
  checks.push(check("image-alt", "seo", "Images have alt text", images.missingAlt.count ? "warn" : "pass", "Images without an alt attribute.", images.missingAlt));
  checks.push(check(
    "font-size", "seo", "Text is legible",
    probe.smallText.ratio > 0.4 ? (probe.viewportWidth < 600 ? "fail" : "warn") : "pass",
    `${Math.round(probe.smallText.ratio * 100)}% of the text is smaller than 12px.`,
  ));
  return checks;
}

export function scoreChecks(checks: readonly QualityCheck[]): Record<QualityCategory, number> {
  const scores = {} as Record<QualityCategory, number>;
  for (const category of ["performance", "bestPractices", "seo"] as const) {
    const own = checks.filter((entry) => entry.category === category);
    const points = own.reduce((sum, entry) => sum + (entry.status === "pass" ? 1 : entry.status === "warn" ? 0.5 : 0), 0);
    scores[category] = own.length ? Math.round((points / own.length) * 100) : 100;
  }
  return scores;
}

const CATEGORY_LABEL: Record<QualityCategory, string> = { performance: "performance", bestPractices: "best practices", seo: "SEO" };

export function qualitySummary(checks: readonly QualityCheck[], scores: Record<QualityCategory, number>): string {
  const parts = (Object.keys(CATEGORY_LABEL) as QualityCategory[]).map((category) => {
    const failing = checks.filter((entry) => entry.category === category && entry.status === "fail").length;
    return `${CATEGORY_LABEL[category]} ${scores[category]}/100${failing ? ` (${failing} failing)` : ""}`;
  });
  const failed = checks.filter((entry) => entry.status === "fail").map((entry) => entry.id);
  const warned = checks.filter((entry) => entry.status === "warn").map((entry) => entry.id);
  return `${parts.join(", ")}.${failed.length ? ` Failing: ${failed.join(", ")}.` : ""}${warned.length ? ` Warnings: ${warned.join(", ")}.` : ""}`;
}

export interface QualityAudit {
  tabId: string;
  url: string;
  kind: "quality";
  summary: string;
  engine: string;
  scores: Record<QualityCategory, number>;
  metrics: Record<string, number | null>;
  failed: QualityCheck[];
  warnings: QualityCheck[];
  passed: string[];
  path: string | null;
}

export async function auditQuality(target: BrowserTarget): Promise<QualityAudit> {
  const probe = await runWorldLocator(target.session, qualityProbe, { itemsKept: ITEMS_KEPT });
  const evidence = sessionEvidence(target, probe.timeOrigin);
  const checks = evaluateQuality(probe, evidence);
  const flagged = checks.filter((entry) => entry.status !== "pass");
  const selectors = flagged.flatMap((entry) => (entry.items ?? []).map((item) => item.selector ?? null));
  const refs = await refsForSelectors(target, selectors);
  let cursor = 0;
  for (const entry of flagged) {
    for (const item of entry.items ?? []) {
      const found = refs[cursor++];
      if (found) {
        item.ref = found.ref;
        item.selector = found.selector;
      }
    }
  }
  const scores = scoreChecks(checks);
  const path = await writeBrowserArtifact(target.workspaceId, "audits", {
    label: "quality",
    ext: "json",
    data: JSON.stringify({ url: probe.url, scores, checks, probe, evidence }, null, 1),
  }).catch(() => null);
  return {
    tabId: target.ref,
    url: probe.url,
    kind: "quality",
    summary: qualitySummary(checks, scores),
    engine: "Codara page checks (not Lighthouse; no reload or throttling)",
    scores,
    metrics: {
      ttfbMs: probe.nav.ttfb,
      fcpMs: probe.nav.fcp,
      loadMs: probe.nav.load,
      requests: probe.resources.requests,
      transferKB: Math.round(probe.resources.bytes / 1024),
      domElements: probe.dom.elements,
    },
    failed: checks.filter((entry) => entry.status === "fail"),
    warnings: checks.filter((entry) => entry.status === "warn"),
    passed: checks.filter((entry) => entry.status === "pass").map((entry) => entry.id),
    path,
  };
}
