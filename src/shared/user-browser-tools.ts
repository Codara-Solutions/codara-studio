// What each browser tool does on a tab of the user's own browser, reached
// through the Codara extension (a chrome: tabId): in Chrome, Edge, Brave and
// the other Chromium browsers, whose extension relays the DevTools protocol,
// and in Firefox, whose extension has no debugger and answers a part of it
// itself (extensions/firefox/README.md). One table, used three ways: the
// app refuses a tool, or one of its modes, that is not available in Firefox
// with the reason written here (preview-tools/index.ts, and the open
// action in browser/chrome/link-tool.ts); docs/mcp-tools.md shows it
// (scripts/test-user-browser-tools.cjs checks the two agree and that every
// browser tool has a row).

export type ToolStatus = "works" | "degraded" | "not available" | "not applicable";

export interface ToolSupport {
  status: ToolStatus;
  /** How it works there, or why it does not, in one plain sentence. */
  how: string;
  /** Modes (the tool's `action` or `mode`) that are not available, with the reason. */
  unavailable?: Readonly<Record<string, string>>;
}

export interface UserBrowserTool {
  chrome: ToolSupport;
  firefox: ToolSupport;
  /** The parameter that picks a mode, when the tool has modes. */
  modeParam?: "action" | "mode";
}

const NO_DEBUGGER = "Firefox gives extensions no debugger";

/**
 * The DevTools protocol events Firefox's extension sends: equal to its
 * CDP_EVENTS (extensions/firefox/lib/firefox.js), which its own test keeps
 * equal to what its code sends. A subscription to any other event on a
 * Firefox tab would only ever time out, so it is refused.
 */
export const FIREFOX_CDP_EVENTS: readonly string[] = Object.freeze([
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.loadEventFired",
  "Page.navigatedWithinDocument",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
]);

/** How the extension reaches each browser today: not a tool, the first row of the table. */
export const USER_BROWSER_DISTRIBUTION: { chrome: string; firefox: string } = {
  chrome: "Loaded unpacked from Settings, Browser (a Chrome Web Store listing is prepared).",
  firefox:
    "A developer install only: loaded from about:debugging (Load Temporary Add-on), and loaded again after each Firefox restart, which removes it. Firefox Developer Edition, Nightly or ESR can keep it once their signature requirement is turned off (xpinstall.signatures.required; https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). It is not on addons.mozilla.org: Mozilla allows the userScripts API it runs on for user script managers only.",
};

export const USER_BROWSER_TOOLS: Readonly<Record<string, UserBrowserTool>> = {
  codara_browser_use: {
    chrome: { status: "works", how: "Each browser call in the script is the tool of the same name." },
    firefox: { status: "degraded", how: "Each browser call in the script is the tool of the same name, as in its row." },
  },
  codara_preview_audit: {
    chrome: { status: "works", how: "Accessibility and quality checks run in a world of their own beside the page." },
    firefox: { status: "not available", how: `It needs a script world apart from the page's, and ${NO_DEBUGGER} to make one. Use codara_preview_snapshot and codara_preview_evaluate.` },
  },
  codara_preview_cdp: {
    chrome: { status: "degraded", how: "The DevTools protocol allowlist, without Runtime, Debugger or DOM and CSS edits on your own browser." },
    firefox: {
      status: "degraded",
      how: "Only the commands the extension answers and the allowlist above permits: Page.navigate (url only: no frame, no referrer), Page.getFrameTree, Page.getLayoutMetrics, Page.captureScreenshot, Network.getResponseBody, and the Log, Network and Page enable and disable. Any other, or other parameters, is refused with the reason before the tab is touched.",
    },
  },
  codara_preview_cdp_events: {
    chrome: { status: "degraded", how: "Events of the allowlisted domains, Debugger excepted." },
    firefox: { status: "degraded", how: `Only the events the extension sends: ${FIREFOX_CDP_EVENTS.join(", ")}; a subscription to any other is refused.` },
  },
  codara_preview_chrome: {
    chrome: { status: "works", how: "Status, open a tab (in a tab group), close, activate." },
    firefox: {
      status: "degraded",
      how: "Status and activate work; agents cannot open or close tabs yet (open is refused when only Firefox is connected; with Chrome connected too, Chrome opens it).",
      unavailable: {
        open: "Opening tabs is not available in Firefox yet: the user opens the tab and shares it from the Codara extension's popup.",
        close: "Closing tabs is not available in Firefox yet: the user closes it.",
      },
    },
    modeParam: "action",
  },
  codara_preview_click: {
    chrome: { status: "works", how: "Clicks the element in the page." },
    firefox: { status: "degraded", how: "Clicks the element in the page, but the page gets no user activation: what needs a gesture (a popup, the clipboard, fullscreen, media with sound) is refused by the browser." },
  },
  codara_preview_close: {
    chrome: { status: "works", how: "Closes a tab an agent opened or the user shared." },
    firefox: { status: "not available", how: "Closing tabs is not available in Firefox yet: the user closes it." },
  },
  codara_preview_compare: {
    chrome: { status: "works", how: "Baseline, diff, list and screen sizes." },
    firefox: {
      status: "degraded",
      how: "Baseline, diff and list work; screen sizes do not.",
      unavailable: { sizes: `Screen sizes resize the page, and ${NO_DEBUGGER} to do that. Compare at the window's own size.` },
    },
    modeParam: "mode",
  },
  codara_preview_console: {
    chrome: { status: "works", how: "The page's console and errors, with object previews." },
    firefox: { status: "degraded", how: "The page's own console calls and uncaught errors; no browser, security or network messages, no frames' consoles, objects as JSON." },
  },
  codara_preview_dialog: {
    chrome: { status: "works", how: "Sees and answers alert, confirm and prompt." },
    firefox: { status: "not available", how: "Firefox tells extensions nothing about a page's alert, confirm or prompt: the user answers them in Firefox." },
  },
  codara_preview_drag: {
    chrome: { status: "works", how: "Trusted mouse events." },
    firefox: { status: "degraded", how: "Played as page events (trusted: false): HTML drag and drop works, the page sees isTrusted false." },
  },
  codara_preview_emulate: {
    chrome: { status: "works", how: "Device, color scheme, network and CPU throttling." },
    firefox: { status: "not available", how: `Emulation needs the DevTools protocol, and ${NO_DEBUGGER}. Called with no settings it still answers the current state (always none).` },
  },
  codara_preview_evaluate: {
    chrome: { status: "works", how: "Runs in the page." },
    firefox: { status: "degraded", how: "Runs in the page through Firefox's user scripts, once the user allowed scripts in pages from the popup, without user activation: what needs a gesture (a popup, the clipboard, fullscreen) is refused by the browser." },
  },
  codara_preview_find: {
    chrome: { status: "works", how: "Finds elements in the page." },
    firefox: { status: "works", how: "Finds elements in the page." },
  },
  codara_preview_hover: {
    chrome: { status: "works", how: "Trusted mouse move." },
    firefox: { status: "degraded", how: "Played as page events (trusted: false): mouseover and enter fire, CSS :hover does not." },
  },
  codara_preview_inbox: {
    chrome: { status: "not applicable", how: "Reads what the user queued; no tab." },
    firefox: { status: "not applicable", how: "Reads what the user queued; no tab." },
  },
  codara_preview_inspect: {
    chrome: { status: "works", how: "The element, its styles and a crop of it." },
    firefox: { status: "works", how: "The element and its styles; the crop needs access to all sites (asked from the popup)." },
  },
  codara_preview_key: {
    chrome: { status: "works", how: "Trusted key events." },
    firefox: { status: "degraded", how: "Played as page events (trusted: false), typing into the focused field as a browser would." },
  },
  codara_preview_list: {
    chrome: { status: "not applicable", how: "Lists Codara's tabs and the shared ones." },
    firefox: { status: "not applicable", how: "Lists Codara's tabs and the shared ones." },
  },
  codara_preview_locate: {
    chrome: { status: "works", how: "Locators in the page." },
    firefox: { status: "works", how: "Locators in the page." },
  },
  codara_preview_mouse: {
    chrome: { status: "works", how: "Trusted mouse events." },
    firefox: { status: "degraded", how: "Played as page events (trusted: false): no native context menu or select popup." },
  },
  codara_preview_navigate: {
    chrome: { status: "works", how: "Loads the address and waits for it." },
    firefox: { status: "works", how: "Web addresses only; waits for the load event, and a failed load does not say why." },
  },
  codara_preview_network: {
    chrome: { status: "works", how: "Requests, responses, timing and bodies; cookie and authorization values always redacted." },
    firefox: { status: "degraded", how: "Requests and responses with headers and text bodies, and each request's elapsed time; no initiator, per-phase timing or sizes; only requests to sites the user let the extension use, never a blocked site." },
  },
  codara_preview_performance: {
    chrome: { status: "works", how: "Web vitals, load and interaction traces, memory." },
    firefox: { status: "not available", how: `Traces, vitals and heap need the DevTools protocol, and ${NO_DEBUGGER}.` },
  },
  codara_preview_press_key: {
    chrome: { status: "works", how: "Trusted key press." },
    firefox: { status: "degraded", how: "Focus and key played as page events in one go (trusted: false)." },
  },
  codara_preview_record: {
    chrome: { status: "works", how: "Records the tab as a video." },
    firefox: { status: "not available", how: `Recording needs the screencast of the DevTools protocol, and ${NO_DEBUGGER}. Take screenshots instead.` },
  },
  codara_preview_resize: {
    chrome: { status: "works", how: "Sets the page's size." },
    firefox: { status: "not available", how: `Resizing the page needs the DevTools protocol, and ${NO_DEBUGGER}: the user resizes the window.` },
  },
  codara_preview_run: {
    chrome: { status: "not applicable", how: "Runs steps; each is the tool of the same name." },
    firefox: { status: "not applicable", how: "Runs steps; each is the tool of the same name." },
  },
  codara_preview_screenshot: {
    chrome: { status: "works", how: "The view or the full page." },
    firefox: { status: "works", how: "The view or the full page, background tabs too; needs access to all sites (asked from the popup)." },
  },
  codara_preview_scroll: {
    chrome: { status: "works", how: "Trusted wheel." },
    firefox: { status: "degraded", how: "Played as a wheel event in the page (trusted: false); scrolls what is under it unless the page cancels it." },
  },
  codara_preview_snapshot: {
    chrome: { status: "works", how: "The page's structure with references to act on." },
    firefox: { status: "works", how: "The page's structure with references to act on." },
  },
  codara_preview_storage: {
    chrome: {
      status: "works",
      how: "get reads local and session storage, masking values whose key looks like a credential or whose value looks like a token (other values come as they are); the tab's cookie and storage switch is needed for cookies (HttpOnly values stay masked), for redact: false, and for set and clear, which change only local and session storage. Cookies are never changed, IndexedDB and caches never cleared (refused before the tab is touched on Firefox), and fresh and discard are for Codara's own tabs.",
    },
    firefox: {
      status: "works",
      how: "As in Chrome; cookies come only from the tab's own host, scheme and cookie store (a container or private window keeps its own).",
    },
  },
  codara_preview_type: {
    chrome: { status: "works", how: "Types into the field." },
    firefox: { status: "works", how: "Types into the field." },
  },
  codara_preview_upload: {
    chrome: { status: "works", how: "Sets the files on the file input." },
    firefox: { status: "degraded", how: "The files go through the page as File objects, 10 MB in all, only to the page the input was found in." },
  },
  codara_preview_url: {
    chrome: { status: "works", how: "The tab's address and title." },
    firefox: { status: "works", how: "The tab's address and title." },
  },
  codara_preview_wait_for: {
    chrome: { status: "works", how: "Waits for text, an element, a condition or a quiet network." },
    firefox: { status: "degraded", how: "Waits for text, an element or a condition; a quiet network counts only the requests the extension sees (sites the user let it use, never a blocked site), so another request may still be running." },
  },
};

// Page.navigate parameters Firefox's extension takes (extensions/firefox/lib/navigation.js NAVIGATE_PARAMS).
const FIREFOX_NAVIGATE_PARAMS = ["url", "frameId", "referrer", "transitionType", "referrerPolicy"];

/**
 * Why Firefox's extension would refuse these raw command parameters, with
 * its own words, or null: checked before the tab is touched. The extension
 * keeps its checks; scripts/test-user-browser-tools.cjs compares the two.
 */
export function firefoxCdpParamsError(method: string, params: Record<string, unknown>, tabId: number): string | null {
  if (method !== "Page.navigate") return null;
  const extra = Object.keys(params).filter((name) => !FIREFOX_NAVIGATE_PARAMS.includes(name));
  if (extra.length) return `Page.navigate takes only url in Firefox, not ${extra.join(", ")}.`;
  if (params.frameId !== undefined && params.frameId !== `firefox-tab-${tabId}`) {
    return "Page.navigate in a frame is not available in Firefox: agents navigate the tab's own page.";
  }
  if (typeof params.referrer === "string" && params.referrer) return "Firefox cannot load a page with another referrer for an extension.";
  return null;
}

/** The tool's name for a preview.* method (preview.snapshot is codara_preview_snapshot; browser.use is codara_browser_use). */
export function toolNameOf(method: string): string {
  return method === "browser.use" ? "codara_browser_use" : `codara_${method.replace(".", "_")}`;
}

/** Why this tool (or the mode its params pick) is not available on a Firefox tab, or null when it runs. */
export function firefoxRefusal(method: string, params: Record<string, unknown>): string | null {
  const name = toolNameOf(method);
  if (method === "preview.cdp_events" && params.action === "subscribe") {
    const events = typeof params.events === "string" ? [params.events] : Array.isArray(params.events) ? params.events : [];
    const missing = events.filter((event) => typeof event === "string" && !FIREFOX_CDP_EVENTS.includes(event));
    if (missing.length) return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not sent by Codara's extension for Firefox, so a subscription would only time out. It sends ${FIREFOX_CDP_EVENTS.join(", ")}.`;
  }
  const row = USER_BROWSER_TOOLS[name];
  if (!row) return null;
  if (row.firefox.status === "not available") return `${name} is not available on a Firefox tab: ${row.firefox.how}`;
  const mode = row.modeParam ? params[row.modeParam] : undefined;
  const modes = row.firefox.unavailable;
  // Own keys only: a mode such as "toString" is left to the tool's own checks.
  const reason = typeof mode === "string" && modes && Object.hasOwn(modes, mode) ? modes[mode] : undefined;
  return reason ? `${name} ${mode} is not available on a Firefox tab: ${reason}` : null;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  works: "Works",
  degraded: "Works, degraded",
  "not available": "Not available",
  "not applicable": "No tab",
};

/** The table as docs/mcp-tools.md shows it. */
export function userBrowserToolsMarkdown(): string {
  const cell = (support: ToolSupport) =>
    [
      `${STATUS_LABEL[support.status]}: ${support.how}`,
      ...Object.entries(support.unavailable ?? {}).map(([mode, reason]) => `<br>Not available, \`${mode}\`: ${reason}`),
    ].join("");
  const rows = Object.entries(USER_BROWSER_TOOLS).map(([name, row]) => `| \`${name}\` | ${cell(row.chrome)} | ${cell(row.firefox)} |`);
  const distribution = `| Distribution | ${USER_BROWSER_DISTRIBUTION.chrome} | ${USER_BROWSER_DISTRIBUTION.firefox} |`;
  return ["| Tool | Chrome, Edge, Brave | Firefox |", "|---|---|---|", distribution, ...rows].join("\n");
}
