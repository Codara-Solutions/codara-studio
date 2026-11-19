// Codara's page commands, answered with what Firefox gives extensions:
// Runtime.evaluate through userScripts.execute in the page's own world,
// Page.captureScreenshot through tabs.captureTab, Page.getLayoutMetrics
// through a script that only measures. And the Firefox permissions each
// one needs, which the user grants from the popup (access.js) and never at
// install.

/** The page commands this extension answers, beyond the domain toggles. */
export const PAGE_METHODS = Object.freeze(["Page.captureScreenshot", "Page.getLayoutMetrics", "Runtime.evaluate"]);

// ── Permissions ─────────────────────────────────────────────────────────────

// What each command needs: the tab's site, scripts in pages (Firefox's
// userScripts permission), or all sites (tabs.captureTab exists only with it).
const NEEDS = {
  "Runtime.evaluate": ["site", "scripts"],
  "Page.getLayoutMetrics": ["site"],
  "Page.captureScreenshot": ["allSites"],
};

export function accessNeeds(method) {
  return NEEDS[method] ?? [];
}

/** The match pattern for a web page's site, without its port (Firefox's patterns take none). */
export function sitePattern(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if ((protocol !== "http:" && protocol !== "https:") || !hostname) return null;
    return `${protocol}//${hostname}/*`;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname || "this site";
  } catch {
    return "this site";
  }
}

/** The permissions.request / permissions.contains argument for a need. */
export function accessRequest(need, url) {
  if (need === "scripts") return { permissions: ["userScripts"] };
  if (need === "allSites") return { origins: ["<all_urls>"] };
  const pattern = sitePattern(url);
  return pattern ? { origins: [pattern] } : null;
}

/** The key under which the extension remembers that the user was asked. */
export function accessKey(need, url) {
  return need === "site" ? `site:${sitePattern(url) ?? ""}` : need;
}

/** The tool error when a need is not granted; `asked` when the user was asked and did not allow it. */
export function accessError(need, url, asked) {
  const host = hostOf(url);
  if (need === "site") {
    return asked
      ? `The user did not allow Codara to use ${host} in Firefox, so agents cannot read or act on this tab. Ask them to allow ${host} in the Codara extension popup on this tab, or use another tab.`
      : `Firefox has not let Codara use ${host} yet. Ask the user to open the Codara extension popup on this tab and allow ${host}.`;
  }
  if (need === "scripts") {
    return asked
      ? "The user did not allow Codara to run scripts in Firefox tabs, so agents cannot read or act on pages there. Ask them to allow scripts in the Codara extension popup."
      : 'Reading and acting on pages in Firefox needs the user\'s OK to run scripts in shared tabs. Ask the user to open the Codara extension popup on this tab and click "Allow scripts".';
  }
  return asked
    ? "The user did not allow screenshots in Firefox (Firefox lets an extension capture tabs only with access to all sites). Read the page with codara_preview_snapshot instead, or ask them to allow screenshots in the Codara extension popup."
    : 'Screenshots in Firefox need access to all sites (Firefox lets an extension capture tabs only with it). Ask the user to open the Codara extension popup and click "Allow screenshots".';
}

function allSitesForReach(asked) {
  return {
    need: "allSites",
    text: asked.allSites
      ? "You did not allow all sites, so agents get an error on tabs of sites you have not allowed and cannot take screenshots."
      : "Agents may use more than one tab here; Firefox lets Codara read them, and take screenshots, only with access to all sites.",
    button: "Allow all sites",
  };
}

/**
 * The popup's rows for a tab: what is still missing, one plain sentence and
 * a button each. `has` says what is granted; `asked` what the user was
 * already asked (and so said no, or closed the question).
 */
export function accessRows({ url, reach, has, asked }) {
  const host = hostOf(url);
  const wide = reach === "window" || reach === "all";
  const rows = [];
  if (wide && !has.allSites) rows.push(allSitesForReach(asked));
  // The site alone is enough to read the tab, also after a no to all sites.
  if (!has.site) {
    rows.push({
      need: "site",
      text: asked.site ? `You did not allow ${host}, so agents get an error on this tab.` : `Agents can see this tab, but Firefox lets Codara read it only once you allow ${host}.`,
      button: `Allow ${host}`,
    });
  }
  if (!has.scripts) {
    rows.push({
      need: "scripts",
      text: asked.scripts
        ? "You did not allow scripts, so agents cannot read or act on pages."
        : 'To read and act on pages, agents run scripts in the tabs you share; Firefox calls them "unverified third-party scripts".',
      button: "Allow scripts",
    });
  }
  if (!wide && !has.allSites) {
    rows.push({
      need: "allSites",
      text: asked.allSites
        ? "You did not allow screenshots, so agents read pages as text only."
        : "Screenshots need access to all sites, the only way Firefox lets an extension capture a tab; agents still use only the tabs you share.",
      button: "Allow screenshots",
    });
  }
  return rows;
}

// ── Runtime.evaluate ────────────────────────────────────────────────────────

// Both run in the page as source text, so they use nothing from this module.
// A value comes back as Codara's protocol sends it with returnByValue, ready
// for JSON: Firefox would return a thrown error empty and refuse DOM nodes.
export function encodeValue(value) {
  const type = typeof value;
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "object", subtype: "null", value: null };
  if (type === "bigint") return { type: "bigint", unserializableValue: `${value}n` };
  if (type === "symbol") return { type: "symbol", description: String(value) };
  if (type === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { type: "number", unserializableValue: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (type === "function") return { type: "function", value: {} };
  if (type !== "object") return { type, value };
  const json = JSON.stringify(value);
  return { type: "object", value: json === undefined ? {} : JSON.parse(json) };
}

export function describeThrown(error) {
  if (error !== null && typeof error === "object" && typeof error.message === "string") {
    const name = typeof error.name === "string" && error.name ? error.name : "Error";
    const stack = typeof error.stack === "string" && error.stack ? `\n${error.stack}` : "";
    return { type: "object", subtype: "error", className: name, description: `${name}: ${error.message}${stack}` };
  }
  const type = typeof error;
  const plain = type === "string" || type === "number" || type === "boolean";
  return { type, value: plain ? error : String(error) };
}

/** A URL without its fragment: a #hash change keeps the document. */
export function documentUrl(url) {
  return String(url ?? "").split("#")[0];
}

/** The tool error when the tab left the page that was checked before anything ran there. */
export const MOVED_ERROR = "The tab went to another page while the agent's command was on its way; it was not answered. Read the tab again and retry.";

// Run first in the page, in the same script as the agent's code: the code
// runs only in the document the extension checked (shared, not blocked).
// `location` cannot be shadowed by a page's own declarations.
const inDocument = (url) => `location.href.split("#")[0] === ${JSON.stringify(documentUrl(url))}`;

/**
 * The code that evaluates an expression in the page and returns
 * { value }, { thrown } or { moved }. Nothing in it can fail before the
 * expression runs, so an error from Firefox for it means it did not compile.
 */
export function expressionScript(expression, { awaitPromise = false, url = "" } = {}) {
  return [
    // Names the expression cannot mean: it sees the page's globals, not these.
    `(${awaitPromise ? "async " : ""}() => {`,
    `  if (!(${inDocument(url)})) return { moved: true };`,
    `  const __codaraEncode = ${encodeValue.toString()};`,
    `  const __codaraDescribe = ${describeThrown.toString()};`,
    "  try {",
    `    let __codaraValue = (${expression}\n);`,
    awaitPromise ? "    __codaraValue = await __codaraValue;" : "",
    "    return { value: __codaraEncode(__codaraValue) };",
    "  } catch (__codaraError) {",
    "    return { thrown: __codaraDescribe(__codaraError) };",
    "  }",
    "})()",
  ].join("\n");
}

/** Code that only compiles the expression (or, `asScript`, the statements as they will run), and runs none of it. */
export function compileCheck(code, { asScript = false, awaitPromise = false } = {}) {
  const body = asScript ? `\n${statementsScript(code, "check")}\n` : ` return (${code}\n);`;
  return `void ${awaitPromise ? "async " : ""}function () {${body}};`;
}

// A leading "use strict" stays the script's directive, outside the try block.
const STRICT = /^\s*(['"])use strict\1/;

/** Statements whose last value is the result, as Runtime.evaluate allows; a throw, or another page, comes back under `marker`. */
export function statementsScript(code, marker, { url = "" } = {}) {
  const key = JSON.stringify(marker);
  return [
    STRICT.test(code) ? '"use strict";' : "",
    `if (!(${inDocument(url)})) ({ ${key}: { moved: true } });`,
    `else try {\n${code}\n} catch (__codaraError) { ({ ${key}: { thrown: (${describeThrown.toString()})(__codaraError) } }) }`,
  ].join("\n");
}

function exception(thrown) {
  return { result: thrown, exceptionDetails: { exceptionId: 1, text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: thrown } };
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Runtime.evaluate's answer from an expressionScript run's value. */
export function expressionAnswer(out) {
  if (plainObject(out) && out.moved === true) throw new Error(MOVED_ERROR);
  if (plainObject(out) && plainObject(out.thrown)) return exception(out.thrown);
  if (plainObject(out) && plainObject(out.value)) return { result: out.value };
  throw new Error("The page gave no answer to the script.");
}

/** Whether userScripts.execute gave an error for a frame (Firefox gives `error: null`, even for a syntax error). */
export function frameFailed(frame) {
  return !frame || frame.error !== undefined || !("result" in frame);
}

/** Runtime.evaluate's answer from a statementsScript run: its frame result, or the error Firefox gave. */
export function statementsAnswer(frame, marker) {
  if (frameFailed(frame)) {
    return exception({ type: "string", value: "Firefox did not report this script's error (a rejected promise or a syntax error). Write the code as one expression, such as (() => { ... })(), to see it." });
  }
  const value = frame?.result;
  if (plainObject(value) && plainObject(value[marker])) {
    if (value[marker].moved === true) throw new Error(MOVED_ERROR);
    if (plainObject(value[marker].thrown)) return exception(value[marker].thrown);
  }
  return { result: encodeValue(value) };
}

export const SYNTAX_ERROR = exception({
  type: "object",
  subtype: "error",
  className: "SyntaxError",
  description: "SyntaxError: the code is neither an expression nor statements Firefox can compile.",
});

// ── Screenshots and layout ──────────────────────────────────────────────────

/** tabs.captureTab options for Page.captureScreenshot's parameters. */
export function captureOptions(params = {}) {
  const format = params?.format === "jpeg" ? "jpeg" : "png";
  const options = { format };
  if (format === "jpeg" && Number.isFinite(params.quality)) options.quality = Math.min(100, Math.max(0, Math.round(params.quality)));
  const clip = params?.clip;
  const numbers = clip && ["x", "y", "width", "height"].every((key) => Number.isFinite(clip[key]));
  if (numbers && clip.width > 0 && clip.height > 0) {
    // Page coordinates in CSS pixels, as in Chrome.
    options.rect = { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
    if (Number.isFinite(clip.scale) && clip.scale > 0 && clip.scale !== 1) options.scale = clip.scale;
  }
  return options;
}

/** Page.captureScreenshot's answer from captureTab's data URL. */
export function screenshotAnswer(dataUrl) {
  const match = /^data:image\/(?:png|jpeg);base64,(.*)$/s.exec(String(dataUrl ?? ""));
  if (!match) throw new Error("Firefox returned no image for the tab.");
  return { data: match[1] };
}

/** Runs in the page's isolated world through scripting.executeScript; measures only, and only the expected document. */
export function measureLayout(expected) {
  if (location.href.split("#")[0] !== expected) return { moved: true };
  const root = document.documentElement;
  const body = document.body;
  const view = window.visualViewport;
  return {
    scrollX,
    scrollY,
    clientWidth: root.clientWidth,
    clientHeight: root.clientHeight,
    contentWidth: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, root.clientWidth),
    contentHeight: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, root.clientHeight),
    visual: view ? { offsetX: view.offsetLeft, offsetY: view.offsetTop, pageX: view.pageLeft, pageY: view.pageTop, width: view.width, height: view.height, scale: view.scale } : null,
    dpr: devicePixelRatio,
  };
}

/** Page.getLayoutMetrics's answer from measureLayout: the css* fields in CSS pixels, the others in device pixels. */
export function layoutMetrics(measured) {
  if (!plainObject(measured)) throw new Error("The page did not report its size.");
  if (measured.moved === true) throw new Error(MOVED_ERROR);
  const n = (value) => (Number.isFinite(value) ? value : 0);
  const dpr = n(measured.dpr) || 1;
  const visual = measured.visual ?? { offsetX: 0, offsetY: 0, pageX: n(measured.scrollX), pageY: n(measured.scrollY), width: n(measured.clientWidth), height: n(measured.clientHeight), scale: 1 };
  const cssLayoutViewport = { pageX: n(measured.scrollX), pageY: n(measured.scrollY), clientWidth: n(measured.clientWidth), clientHeight: n(measured.clientHeight) };
  const cssVisualViewport = {
    offsetX: n(visual.offsetX),
    offsetY: n(visual.offsetY),
    pageX: n(visual.pageX),
    pageY: n(visual.pageY),
    clientWidth: n(visual.width),
    clientHeight: n(visual.height),
    scale: n(visual.scale) || 1,
    zoom: 1,
  };
  const cssContentSize = { x: 0, y: 0, width: n(measured.contentWidth), height: n(measured.contentHeight) };
  const device = (rect, keys) => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, keys.includes(key) ? value * dpr : value]));
  return {
    cssLayoutViewport,
    cssVisualViewport,
    cssContentSize,
    layoutViewport: device(cssLayoutViewport, ["clientWidth", "clientHeight"]),
    visualViewport: device(cssVisualViewport, ["clientWidth", "clientHeight"]),
    contentSize: device(cssContentSize, ["width", "height"]),
  };
}
