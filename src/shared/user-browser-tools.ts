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

/** How the extension reaches each browser today: not a tool, the first row of the table. */
export const USER_BROWSER_DISTRIBUTION: { chrome: string; firefox: string } = {
  chrome: "Loaded unpacked from Settings, Browser (a Chrome Web Store listing is prepared).",
  firefox:
    "Temporary install only today (about:debugging, Load Temporary Add-on): Firefox removes it when it restarts, so the user loads it again each time. Mozilla allows the userScripts API this add-on runs on for user script managers only, so it is not on addons.mozilla.org.",
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
    firefox: { status: "degraded", how: "Only what the extension answers: Page (navigate, frame tree, layout, screenshot), Network (bodies) and Log; the rest is refused with the reason." },
  },
  codara_preview_cdp_events: {
    chrome: { status: "degraded", how: "Events of the allowlisted domains, Debugger excepted." },
    firefox: { status: "degraded", how: "Network, Page, Log and console events only." },
  },
  codara_preview_chrome: {
    chrome: { status: "works", how: "Status, open a tab (in a tab group), close, activate." },
    firefox: {
      status: "degraded",
      how: "Status and activate work; agents cannot open or close tabs yet.",
      unavailable: {
        open: "Opening tabs is not available in Firefox yet: the user opens the tab and shares it from the Codara extension's popup.",
        close: "Closing tabs is not available in Firefox yet: the user closes it.",
      },
    },
    modeParam: "action",
  },
  codara_preview_click: {
    chrome: { status: "works", how: "Clicks the element in the page." },
    firefox: { status: "works", how: "Clicks the element in the page; the page does not count it as a user gesture." },
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
    firefox: { status: "not available", how: `Emulation needs the DevTools protocol, and ${NO_DEBUGGER}.` },
  },
  codara_preview_evaluate: {
    chrome: { status: "works", how: "Runs in the page." },
    firefox: { status: "works", how: "Runs in the page through Firefox's user scripts, once the user allowed scripts in pages from the popup." },
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
    chrome: { status: "works", how: "Requests, responses, timing and bodies." },
    firefox: { status: "degraded", how: "Requests and responses with headers and text bodies; no initiator, timing or sizes." },
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
    chrome: { status: "works", how: "Site storage; cookies read only, all with the tab's cookie switch on." },
    firefox: { status: "works", how: "Site storage; cookies of the tab's own site and store, read only, with the tab's cookie switch on." },
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
    chrome: { status: "works", how: "Waits for text, an element or a condition." },
    firefox: { status: "works", how: "Waits for text, an element or a condition." },
  },
};

/** The tool's name for a preview.* method (preview.snapshot is codara_preview_snapshot; browser.use is codara_browser_use). */
export function toolNameOf(method: string): string {
  return method === "browser.use" ? "codara_browser_use" : `codara_${method.replace(".", "_")}`;
}

/** Why this tool (or the mode its params pick) is not available on a Firefox tab, or null when it runs. */
export function firefoxRefusal(method: string, params: Record<string, unknown>): string | null {
  const name = toolNameOf(method);
  const row = USER_BROWSER_TOOLS[name];
  if (!row) return null;
  if (row.firefox.status === "not available") return `${name} is not available on a Firefox tab: ${row.firefox.how}`;
  const mode = row.modeParam ? params[row.modeParam] : undefined;
  const reason = typeof mode === "string" ? row.firefox.unavailable?.[mode] : undefined;
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
  const rows = Object.entries(USER_BROWSER_TOOLS).map(
    ([name, row]) => `| \`${name}\` | ${STATUS_LABEL[row.chrome.status]}: ${row.chrome.how} | ${STATUS_LABEL[row.firefox.status]}: ${row.firefox.how} |`,
  );
  const distribution = `| Distribution | ${USER_BROWSER_DISTRIBUTION.chrome} | ${USER_BROWSER_DISTRIBUTION.firefox} |`;
  return ["| Tool | Chrome, Edge, Brave | Firefox |", "|---|---|---|", distribution, ...rows].join("\n");
}
