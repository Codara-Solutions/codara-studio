// Which DevTools protocol commands and events a codara_browser_use snippet
// may reach through tab.cdp (preview-tools/cdp.ts). The list is an
// allowlist: a method that is not named here is refused, so a protocol
// version that adds commands adds nothing an agent can call.
//
// Everything allowed acts on the one tab the call names and is no stronger
// than a browser tool that already exists (Runtime and Debugger are
// codara_preview_evaluate, Network is codara_preview_network, and so on). A
// Cora worker whose config blocks any browser tool loses codara_browser_use
// and these commands with it (resources/pi-cora/worker-policy.ts).
// Refused outright: anything that reaches past the tab or the machine
// (Browser, Target, SystemInfo, IO, Storage, downloads, file paths), the
// profile-wide cookie and cache commands (codara_preview_storage covers the
// tab's own site), synthetic input (it would skip the visible cursor and the
// dialog guard; tab.mouse and tab.keyboard send trusted input), and Fetch.
//
// Fetch (request interception) is refused on purpose. Fetch.enable pauses
// every matching request until the client answers it, and a snippet's calls
// die with the snippet, so one that ends or times out would leave the tab
// hanging on requests nobody will continue. In the user's Chrome it would also
// let an agent rewrite responses inside signed-in sessions. The common needs
// have safer commands: Network.setBlockedURLs, Network.setExtraHTTPHeaders and
// Network.emulateNetworkConditions, and the recorder already reads bodies.

const DOMAINS: Readonly<Record<string, readonly string[]>> = {
  Network: [
    "enable", "disable", "getResponseBody", "getRequestPostData", "searchInResponseBody",
    "setCacheDisabled", "setBypassServiceWorker", "emulateNetworkConditions", "setExtraHTTPHeaders",
    "setUserAgentOverride", "setBlockedURLs", "replayXHR", "getCertificate", "getSecurityIsolationStatus",
    "setAttachDebugStack",
  ],
  Page: [
    "enable", "disable", "navigate", "reload", "stopLoading", "getNavigationHistory", "navigateToHistoryEntry",
    "getFrameTree", "getResourceTree", "getResourceContent", "searchInResource", "getLayoutMetrics",
    "getAppManifest", "setLifecycleEventsEnabled", "captureScreenshot", "createIsolatedWorld",
  ],
  Runtime: [
    "enable", "disable", "evaluate", "callFunctionOn", "awaitPromise", "getProperties", "releaseObject",
    "releaseObjectGroup", "compileScript", "runScript", "queryObjects", "globalLexicalScopeNames",
    "getHeapUsage", "getExceptionDetails", "discardConsoleEntries", "setAsyncCallStackDepth",
  ],
  // Read-only: scripts and their sources. Breakpoints, stepping and live
  // edits are refused, and pauses are skipped (see cdp.ts), so a `debugger;`
  // statement in the page never freezes the tab.
  Debugger: ["enable", "disable", "getScriptSource", "searchInContent", "getPossibleBreakpoints"],
  DOM: [
    "enable", "disable", "getDocument", "querySelector", "querySelectorAll", "describeNode", "getOuterHTML",
    "getAttributes", "getBoxModel", "getContentQuads", "getNodeForLocation", "resolveNode", "requestNode",
    "requestChildNodes", "pushNodesByBackendIdsToFrontend", "performSearch", "getSearchResults",
    "discardSearchResults", "scrollIntoViewIfNeeded", "focus", "setAttributeValue", "setAttributesAsText",
    "removeAttribute", "setNodeValue", "setOuterHTML", "removeNode",
  ],
  CSS: [
    "enable", "disable", "getComputedStyleForNode", "getMatchedStylesForNode", "getInlineStylesForNode",
    "getStyleSheetText", "getPlatformFontsForNode", "getMediaQueries", "collectClassNames", "getBackgroundColors",
    "forcePseudoState", "startRuleUsageTracking", "stopRuleUsageTracking", "takeCoverageDelta",
    "setStyleTexts", "setStyleSheetText", "addRule", "createStyleSheet",
  ],
  Accessibility: ["enable", "disable", "getFullAXTree", "getPartialAXTree", "getRootAXNode", "queryAXTree", "getChildAXNodes", "getAXNodeAndAncestors"],
  Overlay: [
    "enable", "disable", "highlightNode", "highlightQuad", "highlightRect", "hideHighlight", "setShowPaintRects",
    "setShowLayoutShiftRegions", "setShowScrollBottleneckRects", "setShowFPSCounter", "setShowGridOverlays",
    "setShowFlexOverlays",
  ],
  Performance: ["enable", "disable", "getMetrics"],
  Emulation: [
    "setDeviceMetricsOverride", "clearDeviceMetricsOverride", "setUserAgentOverride", "setTouchEmulationEnabled",
    "setEmulatedMedia", "setEmulatedVisionDeficiency", "setCPUThrottlingRate", "setGeolocationOverride",
    "clearGeolocationOverride", "setTimezoneOverride", "setLocaleOverride", "setIdleOverride", "clearIdleOverride",
    "setFocusEmulationEnabled", "setScrollbarsHidden", "setDefaultBackgroundColorOverride", "setAutoDarkModeOverride",
  ],
  Log: ["enable", "disable", "clear", "startViolationsReport", "stopViolationsReport"],
};

const ALLOWED = new Map<string, Set<string>>(Object.entries(DOMAINS).map(([domain, methods]) => [domain, new Set(methods)]));

// Why a known-dangerous command or domain is refused, so the agent learns the
// reason and the tool that does the safe part instead of a bare "not allowed".
const REFUSED_DOMAINS: Readonly<Record<string, string>> = {
  Browser: "it controls the whole browser, not this tab",
  Target: "it reaches other tabs, frames and workers",
  SystemInfo: "it describes the machine, not this tab",
  IO: "it reads streams and files outside the page",
  Storage: "it reaches site data beyond this tab's page; use codara_preview_storage for the tab's own cookies and storage",
  Fetch: "request interception holds every matching request until the client answers, and would leave the tab hanging once the snippet ends; use Network.setBlockedURLs, Network.setExtraHTTPHeaders or Network.emulateNetworkConditions",
  Input: "synthetic input skips the visible cursor and the dialog guard; use tab.mouse, tab.keyboard or a Locator action",
  Tethering: "it opens ports on the machine",
  Extensions: "it reaches the browser's extensions",
  PWA: "it installs apps on the machine",
  ServiceWorker: "service workers outlive the tab",
  BackgroundService: "it records background services of the whole profile",
  HeadlessExperimental: "it is not this tab's page",
  Security: "it can tell the tab to ignore certificate errors",
};

const REFUSED_METHODS: Readonly<Record<string, string>> = {
  "Page.setDownloadBehavior": "it points downloads at a folder on the machine",
  "Page.close": "it closes the tab; use tab.close()",
  "Page.crash": "it crashes the tab",
  "Page.bringToFront": "it takes the user's focus",
  "Page.setBypassCSP": "it switches off the page's own security policy",
  "Page.printToPDF": "use codara_preview_screenshot or tab.screenshot()",
  "Page.startScreencast": "use codara_preview_record",
  "Page.handleJavaScriptDialog": "use tab.dialog({ accept }), which the dialog guard knows about",
  "Page.addScriptToEvaluateOnNewDocument": "the script would keep running in the tab after the snippet, for whoever uses it next; run tab.evaluate after each navigation instead",
  "DOM.setFileInputFiles": "it reads files from the machine; use codara_preview_upload",
  "DOM.getFileInfo": "it reveals file paths on the machine",
  "Network.getCookies": "use codara_preview_storage for the tab's own cookies",
  "Network.getAllCookies": "it reads the whole profile's cookies",
  "Network.setCookie": "use codara_preview_storage for the tab's own cookies",
  "Network.setCookies": "use codara_preview_storage for the tab's own cookies",
  "Network.deleteCookies": "use codara_preview_storage for the tab's own cookies",
  "Network.clearBrowserCookies": "it clears the whole profile's cookies",
  "Network.clearBrowserCache": "it clears the whole profile's cache",
  "Network.loadNetworkResource": "it loads any URL with the profile's cookies, past CORS",
  "Network.setRequestInterception": "request interception is refused (see Fetch)",
  "Runtime.addBinding": "page bindings outlive the snippet",
  "Debugger.pause": "the Debugger domain is read-only here",
  "Debugger.setScriptSource": "the Debugger domain is read-only here",
  "Debugger.evaluateOnCallFrame": "the Debugger domain is read-only here",
  "Debugger.setSkipAllPauses": "pauses always stay skipped so the tab never freezes",
  "Debugger.setBreakpointsActive": "the Debugger domain is read-only here",
};

// In the user's own Chrome the extension checks the tab's site against the
// blocked sites, never the sites of the frames inside it. Protocol script
// and DOM edits can pick any frame's context (contextId, a node's objectId),
// past the same-origin rules, so there they stay with tab.evaluate, which
// runs in the page's own top frame. Reading the DOM, styles and the network
// stays open: codara_preview_network already shows every frame's responses.
const USER_BROWSER_REFUSED_DOMAINS = new Set(["Runtime", "Debugger"]);
const USER_BROWSER_REFUSED_METHODS = new Set([
  "Page.createIsolatedWorld",
  "DOM.resolveNode",
  "DOM.focus",
  "DOM.setAttributeValue",
  "DOM.setAttributesAsText",
  "DOM.removeAttribute",
  "DOM.setNodeValue",
  "DOM.setOuterHTML",
  "DOM.removeNode",
  "CSS.setStyleTexts",
  "CSS.setStyleSheetText",
  "CSS.addRule",
  "CSS.createStyleSheet",
]);
const USER_BROWSER_REASON = "in your own Chrome, protocol script and DOM edits could act inside the page's frames, whose sites the blocked-sites list never checked; use tab.evaluate, which runs in the page itself";

export interface CdpContext {
  /** The tab is in the user's own Chrome (a chrome: tab). */
  userBrowser?: boolean;
}

export type CdpDecision = { ok: true; domain: string } | { ok: false; reason: string };

/** The domain of a method name, or null when it is not `Domain.method`. */
export function cdpDomain(method: string): string | null {
  const match = /^([A-Z][A-Za-z]*)\.([a-z][A-Za-z0-9]*)$/.exec(method);
  return match ? match[1] : null;
}

/** Whether a snippet may send this command to its tab. */
export function checkCdpCommand(method: unknown, context: CdpContext = {}): CdpDecision {
  if (typeof method !== "string" || !method) return { ok: false, reason: "cdp.send needs a method such as \"Network.getResponseBody\"." };
  const domain = cdpDomain(method);
  if (!domain) return { ok: false, reason: `${method} is not a DevTools protocol method name (Domain.method).` };
  const refused = REFUSED_METHODS[method] ?? REFUSED_DOMAINS[domain];
  if (refused) return { ok: false, reason: `${method} is not available to agents: ${refused}.` };
  const name = method.slice(domain.length + 1);
  if (!ALLOWED.get(domain)?.has(name)) {
    return { ok: false, reason: `${method} is not on Codara's DevTools allowlist. Allowed domains: ${Object.keys(DOMAINS).join(", ")}; browser.documentation() lists the methods.` };
  }
  if (context.userBrowser && (USER_BROWSER_REFUSED_DOMAINS.has(domain) || USER_BROWSER_REFUSED_METHODS.has(method))) {
    return { ok: false, reason: `${method} is not available on a tab of your own browser: ${USER_BROWSER_REASON}.` };
  }
  return { ok: true, domain };
}

/**
 * Why the parameters of an allowed command are refused, or null. A
 * navigation stays on web pages: a file: or browser-internal URL would hand
 * the page, and with it Runtime, the machine's files.
 */
export function cdpParamsError(method: string, params: Record<string, unknown>): string | null {
  if (method !== "Page.navigate") return null;
  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (/^about:blank$/i.test(url)) return null;
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    return "Page.navigate needs an absolute http or https url.";
  }
  return protocol === "http:" || protocol === "https:" ? null : `Page.navigate opens http and https pages only, not ${protocol} URLs; use tab.goto for anything else Codara supports.`;
}

/** Whether a snippet may subscribe to this event: one of an allowed domain's events. */
export function checkCdpEvent(event: unknown, context: CdpContext = {}): { ok: true; domain: string } | { ok: false; reason: string } {
  if (typeof event !== "string" || !event) return { ok: false, reason: "cdp.on needs an event name such as \"Network.responseReceived\"." };
  const domain = cdpDomain(event);
  if (!domain) return { ok: false, reason: `${event} is not a DevTools protocol event name (Domain.event).` };
  if (!ALLOWED.has(domain)) return { ok: false, reason: `Events of ${domain} are not available to agents. Allowed domains: ${Object.keys(DOMAINS).join(", ")}.` };
  // Subscribing enables the domain, and the Debugger domain is refused there.
  if (context.userBrowser && domain === "Debugger") return { ok: false, reason: `Debugger events are not available on a tab of your own browser: ${USER_BROWSER_REASON}.` };
  return { ok: true, domain };
}

/** The allowlist by domain, for the documentation and the tests. */
export function cdpAllowlist(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(DOMAINS).map(([domain, methods]) => [domain, [...methods]]));
}
