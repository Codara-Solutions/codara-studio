# MCP tools

Codara Studio ships one MCP server, `codara-studio`, that lets agents use the
app: drive the built-in browser, open and read terminals, edit a chat's board
and whiteboard, and, for Cora, run workers and automations. This page explains
who gets the server, which tool set each kind of agent sees, and what every
tool does. The tool definitions are the source of truth: browser tools live
in per-area modules under `resources/codara-studio-mcp/tools/`, the rest in
`resources/codara-studio-mcp/server.js`. The Capability Center reads the
server's own manifest (`toolManifest()`), so it never lists a stale set.
Update this page when a tool is added or renamed.

Adding a browser tool means adding an entry to a module in `tools/` (the
contract is at the top of `tools/index.cjs`) and a handler to the matching
table in `src/main/preview-tools/`. Every session re-sends the tool list on
each request, so each module declares a character `budget` and
`test-mcp-tool-manifest` caps their sum; it also fails when a tool that
changes the page is not fenced for read-only workers.

## Who gets it

- **Claude Code, Codex and Grok.** Every session Codara starts gets the
  server on its own command line (`claude --mcp-config`, `codex -c
  mcp_servers.codara-studio=...`, a managed Grok home's private config), so the
  CLIs' own configs are not changed. Each CLI has its own on/off switch in the
  Capability Center (the **Tools** button in the Cora composer), under Tools
  (MCP servers). Only the opt-in **Codara tools in other apps** writes entries
  into `~/.claude.json`, `~/.codex/config.toml` and Grok's `config.toml`, so
  sessions started outside Codara get them too.
- **Cora and its Pi workers.** They load the same tools in-process, so there
  is nothing to install.
- **Agents without MCP support** (aider, opencode, amp, gemini, droid, a
  script). In any Codara terminal, `cora tool list` shows the tools,
  `cora tool help <name>` describes one, and `cora tool <name> '{"arg":1}'` or
  `--arg value` calls it. It loads the same server module, so the tool set,
  the caller's workspace and the results are those of an MCP call; images are
  saved to files and their paths printed.

Every runtime gets the same tool set for the same kind of session;
`test-agent-launch-integration` holds the Claude and Codex launches to the
same server command and environment.

**Startup flags** (Settings > Accounts) adds flags of your own to each Claude
Code, Codex, Grok or Pi launch from Codara, after Codara's own, and nowhere
else: they are kept in `<codara home>/agent-launch-args.json` and never written
into a CLI's config. A field takes flags only, quoted values allowed; shell
syntax (`;`, `|`, `$(...)`, backticks) and the flags Codara sets itself
(`--settings`, `--mcp-config`, `--resume` and the like, Codex's
`mcp_servers.codara-studio` and `notify` keys) are refused. **Connect to
Chrome** starts Claude Code with `--chrome`, its own link to your Chrome. Codex,
Grok and Pi have no such flag; they reach a browser through Codara's browser
tools and the Chrome extension.

The managed entries carry a version marker; when it changes, Codara rewrites
them on the next launch. The Codex entry also sets `tool_timeout_sec = 660`
and `startup_timeout_sec = 20`, because Codex gives up on a tool after 60
seconds by default and `codara_terminal_run` may wait up to ten minutes.

Every call is forwarded to the running app over its loopback socket. If the
app is closed, or a crash left a stale handshake behind, a tool returns a
"Codara appears to be offline" error instead of hanging. For the next 30
seconds a call no longer waits for the app to start, so an agent that retries
hears the answer at once; the first call after Codara is back works. A token
Codara no longer accepts reads as "Codara rejected this session's
credentials" rather than a bare HTTP 401.

## Protocol behavior

- `initialize` negotiates the protocol version (2025-06-18, 2025-03-26 or
  2024-11-05) and returns `instructions`: a few lines on how the tool families
  fit together, limited to the families in the roster. `serverInfo.version`
  is the app version.
- Every tool carries annotations: a title, and `readOnlyHint`,
  `destructiveHint`, `idempotentHint` and `openWorldHint` where they apply, so
  clients can auto-approve reads and warn before destructive calls.
- Results are compact JSON. Errors are tool results with `isError: true` and a
  message saying what to do next; socket errors keep their code, for example
  `(Codara error -32003: not allowed for this agent)`.
- `notifications/cancelled` aborts the HTTP request behind a call (a long
  wait, a terminal run) and the call gets no reply. Long calls with a
  `progressToken` send a progress heartbeat every 10 seconds;
  `codara_preview_run` reports each step.
- A request body is limited to 64 KB, or 1 MB for whiteboard and board
  updates. The server refuses a larger call before sending it, and the socket
  answers an oversized one with a JSON-RPC error rather than a reset.
- Tools never take a `runId`. The chat comes from the environment Codara
  launched the agent with, and a call that names another run is refused.

## Tool sets

The server picks one tool set when it starts, from the `SPARK_MCP_MODE`
environment variable that Codara sets for the agent:

| Set | Who sees it | What it adds |
|---|---|---|
| `studio` (default) | Agents you run yourself in any terminal | Browser, terminals, `codara_notify_user`, `codara_workspace_status`, the task list tools, `codara_session_search`, `codara_share_offer` and the worktree tools; whiteboard and board only inside a Cora chat |
| `worker` | Workers in automation passes | `studio` with the whiteboard and board read-only, plus `codara_ask_user` and `codara_request_next_iteration` |
| `execute` | A Cora chat that orchestrates work | `studio`, plus orchestration, automation management, the task list tools, `codara_session_search`, the worktree tools and `codara_share_offer` |
| `automation` | The chat that designs automations | `studio`, plus automation management, `codara_ask_user` and `codara_name_chat` |

A Cora chat that answers directly, without workers, gets `studio` plus
`codara_remember`, `codara_share_offer` and the worktree tools, with the whiteboard and board
read-only. Cora's chat workers and Talk chats do not get the worktree tools. Requests to draw
on the whiteboard, change the board or schedule work therefore go to the
orchestrating chat, and a direct chat hands over to it when a follow-up needs
those tools. The whiteboard and board belong to a chat, so they are only
listed when Codara started the agent for one (`SPARK_RUN_ID` is set); an
agent you run yourself does not see them, and a call without a chat fails
with "only works inside a Cora chat". When Cora works on an imported pull request from an
untrusted source, it only gets the orchestration tools that spawn, wait for,
and message workers, ask you, name the chat and complete the run: no browser,
terminal, memory or automation tools.

Inside Cora's own runtime (Pi), the browser, terminal, whiteboard, board,
automation and worktree tools start inactive in the orchestrating chat and are loaded on
demand with `codara_tools`, which also returns how to use them. A request that
plainly needs a family loads it on the first turn. This keeps every request
smaller. Cora and her workers also have `fetch_url`, which reads one web page
as text, next to `web_search` and the free `deep_search`.

## Browser

Tools for the built-in Chromium browser tabs (called "preview" in tool names).
In every set.

Browser tools work in the caller's workspace, even when you are looking at
another one. A Cora run uses its run's workspace and only the tabs it opened. A
Claude, Codex or other agent running in a Studio terminal uses the workspace of
that terminal: a navigate reuses only a tab that agent opened (or opens a new
background one), and other calls fall back to the user's tab in that workspace,
never a run's tab or another agent's. Only a caller outside every Studio
terminal, such as an agent started from another terminal app, works in the
workspace on screen.

| Tool | What it does |
|---|---|
| `codara_preview_list` | Lists the browser tabs in the workspace, with id, title, URL, tab group and which one is active. |
| `codara_preview_navigate` | Loads a URL (http, https or file) in a tab, creating one for the run if needed. `group` puts a tab it opens in a tab group; with `tabId` it moves that tab into the group, and `url` may then be left out. |
| `codara_preview_close` | Closes a browser tab: this session's own by default, or the `tabId` given. A `chrome:` tabId closes a Chrome tab an agent opened or the user shared. |
| `codara_preview_snapshot` | Reads the page as a compact outline with `@references` that other tools accept as selectors, link targets (`-> /path`) and names for icon-only links and buttons. Can return only what changed since a previous snapshot. |
| `codara_preview_click` | Clicks one element by `@reference` or unique CSS selector. |
| `codara_preview_type` | Types into a field, or picks an option in a native dropdown. |
| `codara_preview_press_key` | Sends a key (Enter, Escape, Tab, arrows, a character) to the focused element or a selector. |
| `codara_preview_evaluate` | Runs JavaScript in the page and returns the result. |
| `codara_preview_wait_for` | Waits for page conditions: a selector (optionally only elements added since the last action), a URL, a committed navigation, load or network idle, a quiet DOM, or a finished dev-server hot update. A timeout says what it saw. |
| `codara_preview_find` | Finds elements by description ("the search button") and returns ranked `@references` with role, name and box. |
| `codara_preview_screenshot` | Captures the tab, the full page, one element or a zoomed region as a compact image (JPEG, quality 70, at most 1280 px wide unless asked otherwise), with the scale needed to turn image pixels into page coordinates. The image is also saved under Codara's workspace data folder and its `path` returned. |
| `codara_preview_compare` | Before/after visual diffs (save a named baseline, then get the percent changed, the changed regions as boxes and a highlighted image) and several screen sizes side by side in one image, in light, dark or both. |
| `codara_preview_record` | Records the tab to a GIF, or an MP4 or WebM video (nothing to install), for a pull request: call once to start, drive the flow, call with `stop: true` for the file's path. |
| `codara_preview_mouse` | Trusted mouse input (click, double-click, right-click, down, up) at a selector or coordinates. |
| `codara_preview_scroll` | Scrolls with a trusted mouse-wheel event. |
| `codara_preview_hover` | Moves the mouse over an element, triggering real hover styles and tooltips. |
| `codara_preview_drag` | Trusted drag from one point or element to another. |
| `codara_preview_key` | Trusted keyboard input: a key, a character or a chord such as `Control+K` or `Mod+Shift+P`. Only the page receives it, never Codara's own shortcuts. |
| `codara_preview_dialog` | Lists the page's open alert, confirm, prompt and beforeunload dialogs, answers one, or sets the tab's policy for dialogs nobody answers. |
| `codara_preview_upload` | Sets the files of an `<input type=file>`. |
| `codara_preview_console` | Reads the tab's console messages, recorded since the tab opened, filtered by level. |
| `codara_preview_network` | Lists the tab's network requests, recorded since the tab opened, with filters; shows one request in full (headers, timings, initiator, body); exports HAR 1.2. |
| `codara_preview_emulate` | Emulates color scheme, reduced motion, network speed, CPU slowdown and a device (viewport, pixel ratio, mobile, touch, user agent) for one tab, until reset. |
| `codara_preview_storage` | Reads, sets and clears the tab's cookies, localStorage, sessionStorage, IndexedDB and Cache Storage; opens and discards a logged-out tab. |
| `codara_preview_resize` | Resizes the viewport, for example to test a mobile layout. |
| `codara_preview_audit` | Audits the page: `kind: "accessibility"` (axe-core) or `kind: "quality"` (performance, best-practice and SEO checks). |
| `codara_preview_performance` | Core Web Vitals, traced page loads and interactions, and memory with heap snapshots. |
| `codara_preview_inspect` | Describes one element (an `@reference`, a unique selector, or `x`,`y` in viewport CSS pixels) for editing it: selector, role, name and text, box model, the computed styles that matter, the CSS rules that set them with their stylesheet, the DOM path, the component names and the source file and line, and a cropped image (also saved as a file, its `path` returned). |
| `codara_preview_inbox` | Reads what the user queued for this agent from Codara (picked elements, page comments, screenshots): text, source tab and URL, and attached file paths. Read items are removed, except when a Cora run reads the workspace's items: those stay for the agent the user works with. |
| `codara_preview_run` | Runs a batch of the steps above in one call. |
| `codara_preview_chrome` | The user's own browser through the Codara extension: `status` (connected browsers and their shared `chrome:` tabs), `open` a URL in a new tab (in a Chrome tab group with `group`), `close` a tab an agent opened or the user shared, `activate` a shared tab. |

Every browser tool takes a `tabId`: a Codara tab's id as `codara_preview_list`
returns it (`preview:<id>` is accepted too), or `chrome:<tabId>` for a tab of
the user's own Chrome reached through the Codara extension. Without a
`tabId` a call uses the caller's own Codara tab, never a Chrome tab, and an
imported pull request's run may not use Chrome tabs at all. Every result that
acted on one tab names it in a `tabId` field, so an agent that called without
one learns the id to pass next time. The user copies a tab's id from the tab
id button in the browser's address bar (its menu also copies the URL and who
drives the tab) or from the tab's context menu.

### Pointing at the page

The user can show an agent what they mean instead of describing it:

- **Point at an element** (the crosshair button, or Ctrl/Cmd+Shift+E). Hovering
  draws the element's box model (margin, border, padding, content) and its
  tag. A click picks it; Shift-click picks several; Up and Down walk to the
  parent and the first child; the Outline button lists the page as a tree to
  pick from without the mouse. The popover shows each element's crop and its
  source file, takes a note, and sends to any agent pane, a Cora chat or the
  inbox.
- **Comment on the page** (the speech-bubble button, or Ctrl/Cmd+Shift+X).
  Boxes, arrows and freehand marks over the live page, or over a frozen
  screenshot of it, each with its own note.

The agent receives plain text that reads the same in every runtime, with the
images as files: a pick gives one block per element (selector, source
`file:line`, box, styles, rules, text, `@reference`) and the path of a JSON
file with everything the blocks summarize (every style, each rule's
declarations, all source candidates), a comment gives each
mark's page coordinates, its note and the elements under it, and one
annotated screenshot whose numbers match the list. A send to a terminal pane
is a bracketed paste into the agent's prompt; **Paste** leaves it unsent for
the user to add to, **Send** also presses Enter. A send to the inbox waits
for `codara_preview_inbox`.

Where a source file comes from, in order: React's `_debugSource` (React 18 and
earlier), React 19 owner stacks mapped through the dev server's source maps,
Vue's component `__file`, Svelte's `__svelte_meta`, Angular's
`ng.getOwningComponent`, `data-*` attributes that dev plugins add
(react-dev-inspector, LocatorJS, `data-source`, `data-file`, `data-loc`),
and, when the page reports nothing, a search of the workspace for the
component name, the element's id, test id, label, text and classes (reported
as "likely" candidates). Positions in served code are mapped through the
script's source map, inline or fetched from the dev server.

### The user's own browser

With the Codara extension loaded in Chrome, Edge, Brave or another Chromium
browser and paired (Settings > Browser > Chrome extension, see
`extensions/chrome/README.md`), every tool above that takes a `tabId` also
works on a tab the user shared from the extension's popup: the snapshot's
`@references`, typing, trusted input, waits, screenshots, console, network
and resize behave as on a Codara tab, with the user's signed-in sessions.
`codara_preview_list` adds the shared tabs (`kind: "chrome"`) after Codara's
own. With two browsers paired, ids carry the browser:
`chrome:<linkId>/<tabId>`.

- A tab that is not shared, a tab on the extension's blocked-sites list and
  browser pages are refused with a message saying why; so is navigating a
  shared tab to a blocked site.
- Cookie and site-storage reads through the DevTools protocol (including
  HttpOnly cookies) need the user's per-tab permission in the popup and
  reach only that tab's site; without it cookie headers are removed from
  network events. Profile-wide cookie reads, credentialed loads of other
  URLs, download redirection and commands that reach other tabs are always
  refused. Page
  script from `codara_preview_evaluate` sees only what the page's own
  scripts see.
- Readonly Pi workers may look at a shared tab but not navigate, resize or
  close it.
- `codara_preview_chrome` `open` needs the popup's "Let agents open new
  tabs", and `close` (or `codara_preview_close` with a `chrome:` tabId)
  closes only a tab an agent opened or the user shared, never one on a
  blocked site. Without `group` the
  tab goes in a group named after the caller's workspace, so it never lands
  loose among the user's own tabs.
- **Keep agents in your Chrome** (Settings > Browser > Chrome extension, on
  by default) keeps agents off browser tools that start a Chrome of their
  own, with a separate profile and the "controlled by automated test
  software" bar. For the Claude Code sessions Codara starts, its `--settings`
  file sets `enabledPlugins` to false for the chrome-devtools-mcp and
  Playwright plugins (and any other enabled plugin whose server runs one of
  these) and lists matching plain servers in `deniedMcpServers`, so none of
  them starts. Codex sessions get `-c mcp_servers.<name>={command=...,
  enabled=false}` for each matching server. A server matches on its command
  and arguments: chrome-devtools-mcp, `@playwright/mcp` or a puppeteer MCP
  server, unless told to attach to a running browser. The user's configs are
  only read, Settings names every tool it turned off, and the Capability
  Center marks such servers "Off in Codara". The browser-use plugin, which
  drives the user's running Chrome, stays on. The studio server's
  instructions tell agents to use `codara_preview_chrome` for the user's
  Chrome and never to start a separate browser.
- Every call is logged with the agent that made it, in Settings and in
  `<codara home>/chrome-link/activity.jsonl`; the popup shows which agent
  used each tab last.
- An imported pull request's run may not use the user's browser at all, and
  Pi workers that may not change the app do not get `codara_preview_chrome`.

Large results stay out of the agent's context: images and long bodies are
written under `<codara home>/workspace-data/<workspace>/`, never into the
repository, and the result gives the path.

### Network, emulation and storage

These work on background and hidden tabs and with the window unfocused or
minimized, like every browser tool.

`codara_preview_network` keeps the last 500 requests of a tab, from the
moment the tab opened. A list row is compact (`id`, method, status, type, URL,
time, size). Filters combine: `filter` (URL substring), `type` (comma list
such as `xhr,fetch`), `status` (`404`, `4xx`, `400-499`, `>=400`) and
`failed` (network errors and status 400 and up). `id` returns one request in
full: request and response headers, timings (`blocked`, `dns`, `connect`,
`ssl`, `send`, `wait`, `receive` in ms, -1 for a phase that did not happen),
the initiator, the request body and the response body (`body: false` leaves
the response body out). Text
and JSON bodies are decoded and cut to a few thousand characters, with the
full text saved to a file; a binary body is saved to a file and summarized.
Each hop of a redirect is its own request, and a request the page left
unfinished by navigating away is listed as failed with
`net::ERR_ABORTED (the page navigated away)` instead of staying pending. `har: true` writes a HAR 1.2 file
of the filtered requests (bodies included up to 1 MB each) and returns its
path. Cookie, Set-Cookie, Authorization and Proxy-Authorization headers are
replaced with `[redacted]` in details and HAR files unless `redact: false` is
passed. `clear: true` empties the recording.

`codara_preview_emulate` changes only what a call names and returns
everything in force:

- `colorScheme`: `light`, `dark` or `none`; `reducedMotion`: true or false.
- `network`: `offline`, `slow3g`, `fast3g`, `4g`, `none`, or a custom
  `"latency/download/upload"` in ms and kbit/s (`"300/1600/750"`).
- `cpu`: a slowdown factor from 1 to 20.
- `device`: `phone`, `tablet`, `desktop`, `laptop`, `iphone-se`, `iphone-15`,
  `iphone-15-pro-max`, `pixel-8`, `galaxy-s23`, `ipad-mini`, `ipad-pro` or
  `none`. A device sets viewport, pixel ratio, mobile, touch and user agent;
  `deviceScaleFactor`, `mobile` and `touch` refine it in the same call.
- `reset: true` removes every override.

Emulation lasts until reset or the tab closes, survives navigation, and is
put back when the tab's view is resized or shown again. The emulated viewport
is the page's layout viewport; on screen the page is drawn at the top left of
the tab and may be cut off when the tab is smaller. A screenshot of the tab
shows exactly the emulated viewport, whether or not it fits on screen.

`codara_preview_storage` works on the tab's current origin. `action: "get"`
reads one `area` or all of them (`cookies`, `local`, `session`, `indexeddb`,
`cache`); values that look like secrets (keys such as token, auth, session,
or JWT-shaped values, and every cookie value) are masked unless
`redact: false`. `set` writes a cookie or a local or session item (`name`,
`value`). `clear` removes one item by `name` or empties an area, or every
area without one. `fresh` opens `url` in a new logged-out tab: an in-memory
browser session shared with no other tab, which agent calls never pick unless
given its `tabId`, in the tab group `group` names. Pages it opens in new tabs
share its session. `discard` closes those tabs and wipes the session. On a
Chrome tab, cookies are read-only and only local and session storage can be
cleared. The live sign-ins of the user's own browser are never handed out:
on a Chrome tab, HttpOnly cookie values and the cookie and authorization
headers of its requests stay redacted even with `redact: false`.

### Audits and performance

Both tools work on a background tab, with Codara's window unfocused or
hidden, and never select the tab or show the window. Each result starts with
a one-line `summary`; the full report or the raw file is written under
`<codara home>/workspace-data/<workspace>/browser/` and returned as `path`.

`codara_preview_audit` with `kind: "accessibility"` (the default) runs
axe-core 4.13 in an isolated world the page cannot reach, against WCAG 2.0 to
2.2 A and AA plus best practices. Failures are grouped by rule (most severe
first, up to 12 rules and 5 elements each) with each element's `@reference`,
selector and, for contrast, the measured ratio and colors (`2.32:1, needs
4.5:1 (#aaaaaa on #ffffff, 9.0pt (12px), normal)`). Rules axe could not
decide are under `review`. Cross-origin iframes are not audited.

`kind: "quality"` is not Lighthouse: Lighthouse needs a browser-wide
DevTools endpoint, reloads and throttles the page and clears its storage, and
weighs hundreds of megabytes, so Codara runs its own checks on the page as it
is, from the DOM, resource timing and the tab's console and network records.
It scores three groups out of 100 (pass 1, warning 0.5): performance (server
response, render-blocking resources, DOM size, image sizing and dimensions,
offscreen images, text compression, page weight), best practices (HTTPS,
mixed content, console errors, failed requests, deprecations, doctype,
charset, viewport, image aspect ratio) and SEO (title, meta description, HTTP
status, robots, `lang`, link text, crawlable links, canonical, structured
data, image alt, legible font sizes). Each failure names the offending items.

`codara_preview_performance` takes an `action`:

| Action | What it does |
|---|---|
| `vitals` | LCP with its element, CLS with the elements that shifted, INP with the slowest interaction and its phases, FCP and TTFB, and long tasks, for the current document. |
| `load` | Reloads the tab while tracing it, then reports the vitals, main-thread time by category, long tasks with their cause and the slowest scripts. `ms` caps the wait for the load event (default 15000). |
| `start`, then `stop` | Traces an interaction: start, drive the page with the other tools, then stop for INP, layout shifts and long tasks in that window. A trace stops by itself after 60 s. |
| `memory` | JS heap use sampled over `ms` (up to 30000) with garbage collection at both ends, plus DOM node, listener and document counts. `snapshot: true` also saves a `.heapsnapshot` and summarizes it: largest classes, top retainers with their path from the window, and detached DOM nodes. |

Trace files (`.json`) and heap snapshots open in Chrome DevTools (Performance
and Memory panels). Each workspace keeps its newest ones, up to 2 GB together;
older files are deleted as new ones arrive. A background tab renders no frames, so while a load or
interaction is measured Codara lets it render without showing it; paint times
can then run later than in a foreground tab, and the result says so. Chromium
reports no event timing for a tab that is not on screen, so INP there is
measured in the page (input to the next animation frame) and marked
`estimated`. A tab in a window that is hidden while the tab is the selected
one, or a background tab of Chrome, may paint nothing during a load; the
result then has no LCP or FCP and a note says why.

`codara_preview_url` is no longer listed (`codara_preview_list` returns every
tab's URL and title) but stays callable for agents that still use it. Outside
a Cora chat, browser calls act on the workspace of the terminal the agent runs
in, not on whichever workspace is on screen.
Tips for agents: call `codara_preview_navigate` first, read the page with
`codara_preview_snapshot` and act on its `@references`, and prefer
`codara_preview_run` for multi-step flows. The trusted tools (`mouse`,
`scroll`, `hover`, `drag`, `key`) produce input the page cannot tell apart
from a real user's.

### Keys, waits, dialogs and finding elements

- **Keys.** `codara_preview_key` takes `key: "Control+K"` (or `key: "k"` with
  `modifiers: ["control"]`). `Mod` is Meta on macOS and Control elsewhere.
  Chords an agent sends go only to the page, so a page's own Ctrl+K palette
  opens and Codara's does not, with the window hidden or unfocused too. When
  the user presses a chord inside a page, the page sees it first; Codara acts
  on it only when the page did not handle it (did not call
  `preventDefault`), except Ctrl+W (Cmd+W on macOS) and Ctrl+Tab, which stay
  Codara's.
- **Waits.** `codara_preview_wait_for` conditions combine, and all must hold:
  - `selector` with `state` (`visible` by default, `attached`, `hidden`), and
    `fresh: true` to count only elements added since the agent's last action
    or whose text changed since then, so `h1` cannot match the page a click
    is leaving, also when a framework re-renders the same `h1` in place.
    Text changes are tracked for headings, controls, labels and live regions,
    then for elements with a short text of their own (up to 300 characters),
    for at most 20,000 elements per page. With `text`, `fresh` also counts an
    element whose text was nowhere on the page at the last action, so
    `text: "Saved", fresh: true` waits for a new "Saved";
  - `text`: the matched element's text contains this, or matches `/regex/`
    (alone it watches the whole page), for example `selector: "h1"` with
    `text: "Pricing"`;
  - `url`: exact URL, a path on the same origin, a `*` glob, or `/regex/`
    (read as a regex only when it holds a regex character such as `.`, `\`,
    `^` or `(`, so `/dashboard/` is the path);
  - `navigation: true`: a navigation committed since the last action;
  - `load`: `domcontentloaded`, `load`, or `networkidle` (loaded, then 500 ms
    without requests; open WebSockets and EventSources do not count);
  - `stableMs`: no DOM change for that long;
  - `hmr: true`: the dev server's hot update or reload finished and the page
    settled (Vite, webpack, Next.js Fast Refresh and Parcel client messages
    and update requests). A build error the dev server reports, or its error
    overlay, ends the wait with the error, even when the dev client logs the
    update as done afterwards (Vite does). Each `hmr` wait reports an update
    no earlier wait reported, so save, wait, save, wait waits for the second
    update; it also looks back 10 s for an update that landed before the call.

  The timeout is 5 s by default, 15 s with `navigation`, `load` or `hmr`, and
  at most 50 s. A timeout returns `ok: false` with what it saw, for example
  `Seen: h1 is not visible (fresh): 1 element match but all existed before
  your last action`.
- **Dialogs.** A page's alert, confirm, prompt or beforeunload never leaves a
  call hanging. A call that opens one returns at once with the dialog in
  `dialogs`. While it is open, calls that need the page fail and name it.
  Every result also carries `dialogsAnswered` for dialogs the user or the
  policy answered since the agent last heard. `codara_preview_dialog` with no
  arguments lists open dialogs and the policy; `accept: true|false` (and
  `promptText`) answers the oldest, or the one named by `id`. The default
  policy `ask` shows the dialog over the tab for the user and dismisses it
  after `autoMs` (30 s); `accept` and `dismiss` answer at once. A
  beforeunload under `ask` lets an agent's own navigation leave the page and
  keeps the page otherwise.
- **Find.** `codara_preview_find` scores visible elements against the words
  of `query` (accessible name, role, text, placeholder, aria and title,
  nearby label, icon names such as svg titles and icon classes, ids and test
  ids, link targets), with common synonyms (search and magnifier, close and
  x, settings and gear). A role word in the query (button, link, field)
  must agree with the element. It returns up to `limit` (5) candidates with
  `ref`, `selector`, `role`, `name`, `box` and `why`; pass the `ref` to click
  or type.
- **Console.** The console tool reports what the page logged. Electron's own
  security and deprecation warnings and messages from isolated worlds (Codara's
  preload, extensions) are left out.

Agents without MCP run the same tools from a Codara terminal with
`cora tool preview_find '{"query":"the search button"}'`,
`cora tool preview_wait_for --url /done --load networkidle` or
`cora tool preview_dialog --accept true`.

### Screenshots, visual diffs, sizes and recordings

All four work on any tab, including one in the background, a hidden
workspace's tab or a tab of a minimized window, and on a shared Chrome tab.
Files go under `<codara home>/workspace-data/<workspace>/browser/`
(`screenshots/`, `baselines/`, `diffs/`, `recordings/`), never into the
repository.

- **Screenshot options.** `format` is `jpeg` (default), `png` or `webp`, with
  `quality` (1 to 100). `maxWidth` caps the image width (default 1280);
  `scale` sets image pixels per CSS pixel, so `clip` plus `scale: 2` zooms
  into a region; the region is rendered at that zoom, not enlarged
  afterwards. `fullPage: true` captures the whole page (up to 16,384 CSS
  pixels tall) with its own viewport, so a `100vh` section stays one screen
  tall, `selector` (an `@ref` from a snapshot or a unique CSS selector) one
  element, `clip` (`{x, y, width, height}` in CSS pixels) one region. The
  result's `scale` maps image pixels back to CSS pixels for the mouse tools.
  A Codara tab only renders the area its pane gives it, so a full page is
  scrolled through one screen at a time at the pane's width and stitched;
  fixed and sticky elements show once, and the scroll position is put back.
- **Before/after diff.** `codara_preview_compare` with `mode: "baseline"`
  saves a lossless capture, named by `name` or by default after the page
  and viewport (`host/path@1280x800`). After the change, `mode: "diff"` (the
  default) captures again and returns `summary`, `percent`, `changedPixels`,
  up to 12 `regions` (CSS pixel boxes, largest first) and a highlighted
  image: the new capture faded, changed pixels in magenta, each region
  boxed. `threshold` (0 to 1, default 0.1) sets how different a color must
  be to count. Baselines survive reloads and restarts (one taken by `@ref`
  keeps the element's CSS selector); `mode: "list"` lists the newest 30.
  `fullPage`, `selector` and `clip` choose what is compared.
- **Sizes side by side.** `mode: "sizes"` lays the same tab out at each size
  in turn (`sizes`: `phone` 390x844, `tablet` 820x1180, `desktop` 1440x900,
  or `WIDTHxHEIGHT`; the three presets by default), optionally in
  `colorScheme` `light`, `dark` or `both`, and returns one labeled image of
  all of them with each tile's box. Only one renderer does the work, and the
  tab's own size, scroll position and color scheme are put back afterwards.
  A size larger than the tab's pane is shrunk to fit it, so its tile has the
  pane's resolution.
- **Recording.** `codara_preview_record` starts recording (`format` `gif`,
  the default, `mp4` or `webm`; `fps` up to 30, default 15 for a GIF and 30
  for a video; `maxWidth` up to 2560, default 1280 for a GIF and 1920 for a
  video; `maxSeconds` default 30, at most 120, after which it stops itself).
  Call it again with `stop: true` to encode and get `path`, `mimeType`,
  `bytes`, `frames`, `durationMs`, `size` and `encodeMs`. Frames come from
  the page's own paint events, so a still page costs nothing. A GIF stores
  only what changed between frames, with its own 256 colors per frame and
  dithering only where the page is smooth, so gradients do not band and still
  areas never shimmer. MP4 (H.264) and WebM (VP9) are encoded by the app's
  own Chromium encoder, nothing to install: sharper and much smaller than a
  GIF, and the better choice for anything longer than a few seconds. Where
  the system cannot encode H.264, `mp4` saves a WebM; if no video can be
  encoded, `ffmpeg` on `PATH` (or `CODARA_FFMPEG`) writes the WebM, and
  without it the recording is saved as a GIF. The result's `note` says when
  any of that happened.

The user has the same features in the browser pane's toolbar: the
responsive view (phone, tablet and desktop side by side, sizes editable, one
light/dark switch, scrolling and navigation kept in step) and the record
button, which records an MP4 video by default; its menu switches to a GIF,
and the choice is remembered. When a recording is saved, the button offers
Save as, Copy and Show in folder. A recording an agent started shows on the
same button.

## Terminals

In every set, except `codara_spawn_terminals`, which is only in `execute`.

| Tool | What it does |
|---|---|
| `codara_terminal_create` | Opens a new terminal tab owned by the agent, tinted so you can see an agent drives it, in the tab group `group` names. Temporary terminals close when the run finishes; `retention: "service"` keeps one (a dev server, say) until the run is deleted. |
| `codara_terminal_run` | Runs one command in a terminal the agent created, or in a new one, and waits for it: returns the exit code, the output and a `cursor`. With Codara's shell integration the shell reports when the command ended; otherwise the call returns once output has been quiet. A command still running at `timeoutMs` (default 30 seconds, at most 10 minutes) keeps running. Refuses a pane that is busy, including one another `codara_terminal_run` call is still using. `group` puts a new terminal in a tab group, or moves the tab of `paneId` into it. |
| `codara_terminal_list` | Lists the terminal panes in the agent's workspace: title, tab group, cwd, which agent CLI runs there and its state, whether the shell is running a command, which pane is the caller's and which ones it may write to. |
| `codara_terminal_write` | Types into a terminal the agent created, or into the session of a dev server Codara keeps (to answer its prompts), submitting with Enter by default. |
| `codara_terminal_read` | Reads a terminal pane without escape codes. Returns a `cursor`; pass it back as `since` to get only output written after it. `mode: "screen"` renders what a full-screen program (an agent CLI, vim, top) shows instead of the raw stream. |
| `codara_terminal_close` | Closes a terminal the agent created. It cannot close yours or another run's. |
| `codara_spawn_terminals` | Opens one tab split into Claude Code, Codex, Grok or Pi panes for you to drive, launched the way the **+** menu launches them. An optional model and effort apply to each group; for Pi they become `--model` and `--thinking`. |

### Tab groups

The tools that open a tab take an optional `group`: `codara_preview_navigate`,
`codara_preview_storage` (`fresh`), each `navigate` step of
`codara_preview_run`, `codara_terminal_create` and `codara_terminal_run`. It
names a tab group in the caller's workspace, as in Chrome: a named, colored
run of adjacent tabs the user can collapse. A name already used there, in any
case and ignoring extra spaces, joins that group; a new name starts one with
the next free color. Names are cut to 48 characters, and a number (as
`cora tool` sends `--group 2024`) is read as its digits. Without `group` a tab
opens as before. The tab never takes focus and never lands in another
workspace, and the result names the group it joined. An agent passes the same
short name for the tabs and terminals of one task, so they stay together.
Groups are the user's too: they can rename, recolor, ungroup or close them, and
`codara_preview_list` and `codara_terminal_list` report each tab's group.
`codara_spawn_terminals` takes no `group` yet. In the user's own browser,
`codara_preview_chrome` `open` with `group` puts the new tab in a Chrome tab
group the extension made with that title in the same window, or starts one;
it never groups a tab the user shared or joins a group the user made. Without
`group` it uses the workspace's name, cleaned the same way.

### Dev servers

`codara_terminal_servers` (socket method `terminal.servers`) is in every set
that has the terminal tools, and the `cora server` command runs the same tool
from a shell. It acts on the caller's workspace: the one its pane sits in, or
the workspace on screen for a caller outside every pane. It is refused to a
Cora run on an imported pull request from an untrusted source, since it starts
commands.

A server it starts runs in a terminal session that Codara's main process owns,
not in the agent's pane or process tree and not tied to a Cora run. Restarting,
closing or ending the agent therefore leaves it running, and the next agent, a
restarted one included, reaches it by id and can read and answer it in that
session with `codara_terminal_read` and `codara_terminal_write`. Quitting
Codara stops it. The initialize instructions tell every agent to start its dev
servers here rather than in its own shell, whose children end with it.

| `action` | What it does |
|---|---|
| `list` | Every remembered server of the workspace: `id`, `state` (`running`, `pane` when it runs in a terminal pane, `stopped`, `exited` with `exitCode`), `health` (a TCP connect to its port: `up`, `down`, `unknown`), `url`, `port`, `command`, `cwd`, `envNames`, `missingEnv` and `paneId`. |
| `start` | Starts a saved server by `id`, or a new one from `command` with optional `cwd` (relative to the workspace), `port`, `url`, `env` and `autoStart`. A server already running under that id or with the same command and folder comes back with `alreadyRunning: true` instead of a second copy, also when two callers start it at the same moment. A port something else answers on is refused with what holds it: another server of the workspace, a process in one of your terminal panes, or a pid. Waits up to 15 seconds for the port or the printed URL and reports `ready`; when the process ends first, `output` holds its last lines. |
| `stop`, `restart` | Stops a server (a learned one by ending its process, leaving the pane's shell or agent alone) or stops and starts it again. |
| `logs` | Output without escape codes and a `cursor`; pass it back as `since` for only what came after. Cursors keep growing across restarts of the server, so a reader following one gets the new process's output from its start. A reply holds at most 4,000 characters; longer output is written to `<codara home>/workspace-data/<workspace>/servers/<id>.log` and its path returned. |
| `save` | Edits a saved server: `command`, `cwd`, `port`, `url`, `autoStart`. |
| `forget` | Stops a server and removes it from the list. |

What is remembered lives in Codara's own data folder
(`<codara home>/workspace-data/<workspace>/servers/servers.json`), never in the
repository: commands, folders, ports, URLs and the NAMES of the environment
variables a server was started with. Values passed in `env`, or typed before
the command (`API_KEY=... pnpm dev` is saved as `pnpm dev` with the name
`API_KEY`), stay in memory for that app session only; after a restart,
`missingEnv` names what a start would lack. The URL is learned from the server's own output and can be edited with
`save` or in the status view.

Servers started by hand or by an agent in a terminal pane are learned too: when
a local URL appears in a pane's output and the process listening on that port
runs in that pane, the server is listed with state `pane`. Its command comes
from the shell's report (zsh and PowerShell send one) or from the listening
process's command line (bash, or an agent CLI's own shell tool). A pane an agent
opened with `codara_terminal_create` then belongs to the workspace instead of
the agent's run: the run finishing no longer closes it, and it stays writable
by that run and by agents without a run. A `pane` server is never started a
second time while it answers.

A server marked `autoStart` starts the first time its workspace opens in an
app session.

When `codara_preview_navigate` is pointed at a local port that does not
answer, its error names the saved server for that port and the call that
starts it (or, when none is saved, how to start one that outlives the agent).

In an SSH workspace, `localhost:<port>` means that port on the host: the
navigation forwards it over the workspace's SSH connection (when the host
answers on it) and opens the local port the forward got, which is the same
number unless that one is taken on this computer. When nothing listens there,
the error says so. See
[SSH port forwarding](./codebase-tour.md#ssh-port-forwarding).

The status view in the status bar (the **STATUS** chip) shows the same servers
with their health, which agents in the workspace's panes reached Codara's
tools (each codara-studio server reports itself once its client has
initialized), the browser tabs each agent or run drives, and recordings in
progress, with open, stop, start, restart, logs, edit and copy-id actions.

## Notifications

Only in `studio` outside a Cora chat (a Cora run announces its own outcome).

| Tool | What it does |
|---|---|
| `codara_notify_user` | Sends a Codara notification from the agent's own pane: `done` when it finished a long task, `needs_input` when it is blocked on you. Clicking it opens the pane, and nothing shows while you are already looking at that pane. When Codara already reads the agent's own turn signals in that pane (Claude Code hooks or status reports, the Codex notify program or its session file), the call returns `published: false` with `reason: "announced_by_codara"`, because an alert sent mid-turn would arrive before the real end and displace the exact one. Otherwise it shares the pane's notification key with Codara's own end-of-turn alert, so the two arrive as one. At most one per kind every 5 seconds. An agent outside a Codara terminal, or with Codara closed, gets `published: false` back rather than an error. |

## Workspace status

Only in `studio` outside a Cora chat (a Cora chat already shows its own state
on the workspace's row).

| Tool | What it does |
|---|---|
| `codara_workspace_status` | Reads (no arguments) or sets the status and one-line progress note of the agent's own workspace, which the rail shows under the workspace's name. `status` is one of `todo`, `in_progress`, `in_review`, `done` and `blocked`; `note` is one plain line of at most 140 characters (longer text is cut and the result says `noteTruncated`, an empty note clears it); `clear: true` removes both. The result carries the current state, who set it and the five latest checkpoints, newest first, so an agent picking up another session's work can read where it stands. |

The workspace is always the caller's own, found from the terminal pane the
agent runs in, never named by the call. An agent outside a Codara terminal
gets `updated: false` with `reason: "not_in_codara_workspace"`, one whose
workspace was removed gets `reason: "workspace_gone"`, and with Codara closed
the call returns `reason: "codara_offline"` rather than an error. Imported
pull request runs cannot call it. The server's instructions ask agents to set
`in_progress` with a short note when they start, a new note at each
milestone, `in_review` or `done` when they finish, and `blocked` with the
reason when they need you. You set, change or clear a status yourself from the
row's menu (**Set status…**, or right-click the row); an agent and you can
each overwrite the other's latest value, and every change is kept as a
checkpoint. Statuses live in `<codaraHome>/workspace-status.json` and are
dropped when their workspace is deleted. Agents without MCP use
`cora tool workspace_status --status in_progress --note "..."`.

## Task list

In `studio` outside a Cora chat and in `execute`. Each workspace keeps one
task list and inbox that its agents, Cora and you share. It lives in
`<codaraHome>/cos/<workspaceId>/`: `tasks.jsonl` is the event log and
`TASKS.md` beside it is rewritten after every change for anyone to read.

| Tool | What it does |
|---|---|
| `codara_task_add` | Adds a task with a `title` and `done_when` lines (how anyone can tell it is finished; at least one). It starts in `inbox`, or in `ready` or `dispatched` when `state` says so. `kind` is `code`, `browser_op`, `research` or `chore`. `from_inbox` turns an inbox item into the task, which keeps the item's source. |
| `codara_task_update` | Moves or edits a task (`T1`, ...): `state`, `title`, `done_when`, `assignee` (`cli`, `model`, `branch` and `worktree`, an absolute path). `needs_you` takes a one-sentence `reason`. For an inbox item (`I1`, ...), `state: "dropped"` drops it and `merge_into` folds it into a task. |
| `codara_task_list` | The count line ("3 running · 1 needs you · 5 done today"), the oldest task that needs you and why, the open tasks with the evidence of their latest verify run, the inbox items nobody triaged, and the `TASKS.md` path. `state` filters; `all` adds every done and dropped task. |
| `codara_inbox_add` | Files `text` (with an optional `link` and `source`) in the inbox without making it a task. |

The states are `inbox`, `ready`, `dispatched`, `verifying`, `needs_you`,
`done` and `dropped`. No tool moves a task to `done`: moving it to
`verifying` starts the verify gate (`src/main/cos/verify-gate.ts`), which
runs the repository's own checks from `.codara/verify.json` in the task's
`assignee.worktree`, or in the workspace's folder. Each check is a shell
command with optional `when` globs (it runs when the change touches a
matching file) and `timeoutSec`; `base` lists the refs the change is
measured from, and the commands see the merge base as `CODARA_VERIFY_BASE`.
They run through `codara-heavy`, one at a time machine-wide and
memory-capped, with each check's full output kept as a log. Every check
green closes the task with the exit codes and log paths as evidence. A red
run sends it back to `dispatched`; the third red run in a row, a missing or
broken `verify.json`, or an unknown folder sends it to `needs_you` with one
sentence. Preview steps are not run yet.

The workspace is the caller's own, as for the status, with the same
`not_in_codara_workspace`, `workspace_gone` and `codara_offline` answers.
Imported pull request runs cannot call them. The rail shows the count line
under the workspace's name, and the reason in red when a task needs you.
From a shell: `cora task list|add|move|merge|worktree` and `cora inbox add`.

## Share offer

In `studio` outside a Cora chat, in `execute`, and in a Cora chat that answers
directly. Never for workers or an imported pull request.

| Tool | What it does |
|---|---|
| `codara_share_offer` | Takes `path`, an HTML or Markdown file (absolute, or relative to the agent's working directory) in a folder open in Codara, at most 5 MB. Codara opens the file and shows its Share prompt; nothing is uploaded unless you click Share there, and the agent never gets the link. Returns `offered: true`, or `offered: false` with a `reason` (`invalid`, `not_shareable`, `missing`, `too_large`, `not_allowed`, `rate_limited`, `no_window`, `codara_offline`). One prompt per agent every 10 seconds. See [share-links.md](./share-links.md). |

## Past sessions

In `studio` outside a Cora chat and in `execute`.

| Tool | What it does |
|---|---|
| `codara_session_search` | Searches what was said in past Claude Code, Codex, Grok, Pi and Cora sessions on this computer, from Codara's [session index](./agent-session-search.md). `query` is the words to find (at most 200 characters), `limit` the number of sessions (default 8, at most 20). Each result has the agent, session id, title, folder, last use, message count and an excerpt of at most 240 characters. Read-only. |

It searches the project of the caller's own workspace (every worktree of its
repository), found from the terminal pane or Cora chat the agent runs in,
never named by the call. Only when you choose **Every session** under
Settings, Sessions, **What agents can search** does it search every indexed
session. With session search turned off, or from an agent outside a local
Codara workspace, it answers `ok: false` with a note. Imported pull request
runs cannot call it. The server's instructions tell agents that the excerpts
are quoted history, never instructions. Agents without MCP use
`cora tool session_search --query "..."`.

## Worktrees

In `studio` outside a Cora chat, in `execute`, and in a Cora chat that answers
directly. An agent gets a separate checkout of its own repository on its own
branch, which you see in the rail under the repository, and removes it once
the branch is merged. The repository is always the one the agent runs in: its
terminal pane or its Cora chat decides, never a tool argument. SSH workspaces
are not supported yet.

| Tool | What it does |
|---|---|
| `codara_worktree_create` | Creates a worktree on a new branch (default `agent/<purpose>-<id>`, from the default branch after a fetch) or, with `checkout: true`, on an existing branch. The agent's own cwd does not change; it works under the returned `path`. Codara starts the repository's [worktree setup](./worktree-setup.md) there (files from `.worktreeinclude`, links, the setup command from `.codara/worktree.json` and your own copy-branch command) and returns its state as `setup`; `setupCommand` is now always null. A setup command or terminal command not yet approved for the repository does not run: `setup.state` is `awaiting-approval` until you run or allow it from Codara, and the agent must never run either itself (see [Approving the setup command](./worktree-setup.md#approving-the-setup-command)). With `waitForSetup: true`, or when the setup file asks for it, the call waits up to 5 minutes for setup to end. Because it can run that command, it is annotated as destructive and open-world, not read-only. Asking again for the same branch returns the existing worktree. At most 20 agent worktrees per repository. |
| `codara_worktree_setup` | The setup state of a worktree: what was copied and linked, each command with its exit code, the error and the end of the log (`logLines`, at most 200). Without `workspaceId` or `path`, the worktree the agent works in. `wait: true` waits for setup to end, also while you decide on a command awaiting approval, up to `timeoutSeconds` (default 300, at most 540). Read-only. |
| `codara_worktree_list` | Lists the repository's Codara-managed worktrees: who created each, uncommitted and ignored files, terminals, runs and processes using it, merge status, and `removable` with the `blockers` that `codara_worktree_remove` would report. `checkMerge: true` fetches and asks GitHub, so it is slower. Worktrees Codara does not manage are listed under `unmanaged` and are never touched. |
| `codara_worktree_remove` | Removes a worktree and, by default, the branch it created. `dryRun: true` only checks. |
| `codara_worktree_cleanup` | **Clean up worktrees** for an agent, across every repository behind your workspaces. See [Cleaning up worktrees](#cleaning-up-worktrees). |

`codara_worktree_remove` never forces anything. It removes a worktree only
when all of these hold, and otherwise returns an error result with a `code`,
the `blockers` and a `hint`:

- an agent created it, unless you turned on **Let agents remove worktrees I
  created** in Settings > Git; GitHub issue and pull-request workspaces
  are removed from the rail only;
- its exact last commit is merged into the target (its base, or `target`):
  the target contains it, a merged pull request from the same repository has
  it as head, or merging it into the target changes nothing (a squash merge).
  A `target` the agent names must be another local or remote-tracking
  branch, never the worktree's own branch, its pushed copy or a commit id;
- it has no uncommitted or untracked files (edits hidden by
  `assume-unchanged` or `skip-worktree` count), no merge or rebase in
  progress, and no ignored files beyond build output and caches
  (`node_modules/`, `dist/`, `.venv/` and similar, plus the patterns you add
  for the repository in Settings, and the files worktree setup copied or
  linked while they are unchanged); `discardIgnoredFiles: true` deletes the
  rest;
- no submodule or nested repository is checked out in it, and no other
  checkout or worktree sits inside it, ignored folders included. The search
  through ignored folders visits at most 50,000 folders; when it runs out,
  or a folder cannot be read, removal is refused with
  `WORKTREE_NESTED_SCAN_INCOMPLETE` and the folder it gave up on, because an
  unfinished search cannot rule a nested checkout out. The agent can delete
  that folder itself if it only holds build output or dependencies, such as
  `node_modules/`, and try again;
- no other owner may still be working in it: a worktree another Cora run
  created is kept while that run is active, and one an agent in another
  terminal created is kept while that terminal is open, because such an
  agent works there through absolute paths and `git -C` and no usage check
  can see it;
- no terminal, active Cora run or process uses it, and the caller is not
  inside it.

The `code` is the first blocker; `blockers` lists them all, and a dry run or
`codara_worktree_list` reports the same codes without removing anything:

| Code | Meaning | What the agent should do |
|---|---|---|
| `WORKTREE_USER_CREATED` | You created it and agents may not remove your worktrees. | Ask you. |
| `WORKTREE_ORIGIN_MANAGED` | It is a GitHub issue or pull-request workspace. | Leave it; you remove it from the rail. |
| `WORKTREE_OWNED_BY_ACTIVE_RUN` | Another Cora run created it and is still active (`details.ownerRunId`). | Leave it to that run; ask you if it must go now. |
| `WORKTREE_OWNED_BY_LIVE_AGENT` | An agent in another terminal created it and that terminal is still open (`details.ownerPaneId`). | Leave it to that agent, or ask you. |
| `WORKTREE_NOT_MANAGED` | The folder cannot be read, so it may still hold work, or it is no longer a git worktree in Codara's worktrees folder. | Ask you. |
| `WORKTREE_LOCKED` | `git worktree lock` protects it. | Ask you. |
| `WORKTREE_DETACHED_HEAD`, `WORKTREE_BRANCH_MISMATCH` | It is not on the branch Codara recorded. | Check out that branch again, or ask you. |
| `WORKTREE_DIRTY` | Uncommitted, untracked or hidden (`assume-unchanged`, `skip-worktree`) changes. | Commit or discard them yourself. |
| `WORKTREE_OPERATION_IN_PROGRESS` | A merge, rebase, cherry-pick or similar is in progress. | Finish or abort it. |
| `WORKTREE_IGNORED_FILES` | Ignored files that are not build output or caches. | Move them, or pass `discardIgnoredFiles: true`. |
| `WORKTREE_SUBMODULES` | A submodule or committed nested repository is checked out. | Ask you. |
| `WORKTREE_NESTED_REPOSITORY` | Another checkout or worktree sits inside it (`details.nestedRepositories`). | Move or remove it first, or ask you. |
| `WORKTREE_NESTED_SCAN_INCOMPLETE` | The search for nested checkouts could not finish (`details.unscannedFolder`). | Delete that folder if it only holds build output or dependencies, then retry; otherwise ask you. |
| `WORKTREE_NOT_MERGED` | The last commit is not merged into the target. | Push and merge it, or ask you to delete it from the rail. |
| `WORKTREE_TARGET_NOT_FOUND` | The merge target does not exist or cannot be a target. | Pass `target`, the branch it was merged into. |
| `WORKTREE_RUNNING_PANES` | Terminals are open in it. | Close your own with `codara_terminal_close`; otherwise wait or ask you. |
| `WORKTREE_ACTIVE_RUNS` | Active Cora runs work in it. | Wait for them to finish, or ask you. |
| `WORKTREE_RUNNING_PROCESSES` | Processes run in it. | Stop them, or wait or ask you. |
| `WORKTREE_CALLER_INSIDE` | The caller runs inside it. | Call from the source workspace, or ask you to delete it from the rail. |

Before deleting anything Codara saves the last commit as
`refs/codara/removed-worktrees/<date>/<workspace id>`, kept for 30 days, and
the result carries `recoverWith`, the command that restores the worktree. The
branch is deleted only if it still points at the commit that was checked.
Every create and removal, refused or not, is logged to
`~/.codarastudio/logs/worktree-audit.jsonl`. **Let agents create and remove
worktrees** in Settings turns creating and removing off; listing still works.

### Cleaning up worktrees

`codara_worktree_cleanup` gives an agent what the **Clean up worktrees** screen
shows, so it can recommend what to remove and ask you.

- `action: "scan"` (the default) only reads. For every worktree of every
  repository behind your workspaces (not the main checkouts) it returns the
  repository, branch, path, workspace, size on disk, last activity, uncommitted
  files, ignored files a fresh checkout would not bring back, the full check's
  blockers, what is running in it, the merge state, the pull request (open,
  merged or closed) and whether the branch is on the remote, plus a
  `recommendation` with a `reason`: **safe to remove** (merged, clean and
  idle), **review** (merged but holding ignored files such as `.env.local`, or
  not merged but pushed and idle for `staleDays`, default 14), or **keep**
  (unsaved changes, in use, an open pull request, commits that are not
  pushed). The list is sorted safe first, then by size, and `totals` says how
  much the safe removals free. `checkMerge: true` asks GitHub and the remote
  now (`git ls-remote`) instead of using the last fetch. SSH workspaces are
  listed under `notCovered`: their worktrees live on the remote host.
- `action: "remove"` with `paths` opens an approval dialog in Codara that says
  which agent asks and lists each worktree with its repository, branch, size,
  recommendation and reason. Only the safe ones start ticked. A worktree with
  unsaved changes or something running in it cannot be ticked; you remove
  those yourself from the screen. A separate, unticked choice per worktree
  also deletes its branch on the remote with your own git sign-in (`git push
  --delete` with a lease on the commit the dialog showed), offered only when
  a merged pull request covers that branch's remote tip, no open pull request
  uses it, and it is not a default or long-lived branch. `deleteRemoteBranch`
  or `deleteRemoteBranchFor` only mark that choice as suggested. The tool
  waits up to 5 minutes for your answer and returns what was removed, what
  was skipped and why, and what happened to each remote branch.

The removal is the screen's own: the full check again under the repository
lock, a recovery ref for the last commit, and a refusal if anything changed
since the dialog showed it. A worktree whose only local work is ignored files
can be removed once you tick it, since the dialog listed those files; a
branch with commits that are not merged always stays. Read-only and edit-only
Pi workers may scan but not remove, and imported pull-request runs do not get
the tool.

## Whiteboard and board

Every Cora chat has a whiteboard (a free-form canvas) and a board (a kanban of
task cards). Both are shared with you, so the tools check revisions and never
overwrite your edits. [whiteboard-review.md](./whiteboard-review.md) explains
the review workflow.

| Tool | What it does | Sets |
|---|---|---|
| `codara_whiteboard_get` | Reads the chat's whiteboard, its revision and your latest edits. | all |
| `codara_whiteboard_update` | Creates, replaces, extends or clears the whiteboard. Every edit is a draft. | not `worker` |
| `codara_whiteboard_arrange` | Lays the cards out automatically. | not `worker` |
| `codara_whiteboard_inspect` | Renders the whiteboard to a PNG with layout and source-reference checks. | all |
| `codara_whiteboard_review` | Records Cora's review of the exact revision it inspected. | not `worker` |
| `codara_board_get` | Reads the chat's board: cards, lanes and revision. | all |
| `codara_board_update` | Creates, moves and edits cards. Cards you wrote can only be deleted by you. | not `worker` |

Updates answer with the new revision and counts, not the whole graph or
board; call the get tool to read it back.

## Orchestration

Only in `execute`, except where noted.

| Tool | What it does |
|---|---|
| `codara_spawn_workers` | Hands one or more focused tasks to Cora workers, with optional runtime, model and effort hints. |
| `codara_wait_for_workers` | Waits until the listed workers finish, then returns their reports, why any of them failed, and what a slow one is doing. |
| `codara_get_worker_status` | A one-off status check of one worker. |
| `codara_message_workers` | Sends a message to one worker or all of them. |
| `codara_check_messages` | Reads messages workers sent to Cora. |
| `codara_ask_user` | Asks you a question, with options, when Cora cannot decide safely. Also in `worker` and `automation`. |
| `codara_complete` | Marks the run complete once workers finished and their work was verified. With `accept_unverified` (a reason and the task ids of every blocking verifier), Cora can overrule a verdict she judged out of contract; the run lands as completed but unverified and the reason is added to the summary you see. |
| `codara_plan_update` | Records Cora's plan for multi-phase work: your request, milestones with status, decisions and next steps. The plan survives compaction and restarts, and `codara_complete` is refused while a milestone is still open. |
| `codara_name_chat` | Gives the chat a better title when the one derived from your first message is wrong or the topic shifts. Also in `automation`. |
| `codara_remember` | Saves a lasting fact to Cora's memory, for you or for this workspace. Workers in chat runs get a read-only copy of the memory; automation workers do not. |
| `codara_request_next_iteration` | In an automation loop, decides whether another pass runs. Also in `worker`. |

## Automations

In `execute` and `automation`. Changes that enable, edit or delete an
automation are shown to you for approval in the chat first.

| Tool | What it does |
|---|---|
| `codara_list_automations` | Lists the workspace's automations and their state. |
| `codara_get_automation` | Reads one automation's full definition. |
| `codara_create_automation` | Creates an automation in this chat's workspace. |
| `codara_update_automation` | Changes an automation (asks you first). |
| `codara_run_automation` | Runs an automation now. |
| `codara_wait_for_automation` | Waits for an automation's current pass to finish. |
| `codara_set_automation_enabled` | Turns an automation's trigger on or off (asks you first). |
| `codara_pause_automation` | Pauses a running automation loop. |
| `codara_resume_automation` | Resumes a paused loop. |
| `codara_stop_automation` | Stops the current loop; the automation stays. |
| `codara_delete_automation` | Deletes an automation (asks you first). |

`codara_create_automation` and `codara_update_automation` also take
`precheck` (`{command, timeoutSeconds, shell}`: a shell command of at most
4000 characters that must exit 0 for a trigger or cadence pass to run) and `missed_runs` (`{policy: "skip" |
"runOnce", graceMinutes}`: what happens to a cron or interval time missed while
Codara was closed or the computer slept). In an update, an empty command or
`null` removes the precheck, and `null` restores the default policy, skip. The
approval shows the full precheck command, since it runs on your machine.
`codara_list_automations` and `codara_get_automation` report both, with the
latest skipped passes.

## Workflows

Only in `execute`, and never for an imported pull request. A workflow is a
script that fans work out to many agents; see Workflows in
[architecture.md](architecture.md#orchestration-cora).

| Tool | What it does |
|---|---|
| `codara_workflow_list` | Lists saved workflows. |
| `codara_workflow_get` | Reads one saved workflow's source. |
| `codara_workflow_check` | Checks a script without running it: syntax, `meta`, and an estimate of agents and tokens. |
| `codara_workflow_run` | Runs a saved workflow or an inline script, with optional caps. Asks you first. |
| `codara_workflow_status` | A workflow run's progress tree, and its result once it finished. |
| `codara_workflow_wait` | Waits until a workflow run finishes, stops or needs you. |
| `codara_workflow_stop` | Stops a workflow run; it can be resumed. |
| `codara_workflow_resume` | Resumes it; agents that finished are answered from the journal. Switching the run to an edited saved script asks you first. |
| `codara_workflow_save` | Saves a script for you or the project. Asks you first. |
