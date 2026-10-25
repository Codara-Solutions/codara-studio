# Browser code mode (`codara_browser_use`)

Agents drive Studio's browser by writing a few lines of JavaScript against a
browser API in a persistent session, instead of one MCP call per click. Every
existing `codara_preview_*` tool keeps working; the code tool is built on
them.

```js
const tab = await browser.tab();
await tab.goto("http://localhost:5173/login");
await tab.getByLabel("Email").fill("ana@example.com");
await tab.getByLabel("Password").fill("secret");
await tab.getByRole("button", { name: "Sign in" }).click();
await tab.waitFor({ text: "Welcome" });
return await tab.snapshot();
```

## Why

A flow such as "log in, open settings, change a field, save, check the toast"
costs 8 to 15 tool calls today, each one a model round trip that re-sends the
context. `codara_preview_run` batches steps but is a fixed list: it cannot
branch on what it reads, loop over table rows, or keep a handle for the next
turn. OpenAI's Browser Use shows the better shape: one code tool, a
Playwright-style API, documentation served on demand so the tool description
stays short, and bindings that survive between calls.

## The tool

`codara_browser_use { code, timeoutMs?, reset? }`, socket method
`browser.use`.

- `code` runs with top-level `await`. Top-level `const`, `let`, `var`,
  `function` and `class` declarations become session globals, so a later
  call can use `tab` again. A redeclaration replaces the old value (REPL
  semantics), so rerunning a snippet never fails on "already declared".
- The value of the last expression statement, or an explicit `return`, is the
  result. `console.log` lines come back as `logs`. Screenshots taken with
  `tab.screenshot()` come back as image blocks (at most 6 per call).
- `browser.documentation()` returns the full API reference; the tool
  description only says it exists.
- `reset: true` drops the session first. `timeoutMs` defaults to 30 s, at
  most 110 s (the MCP client gives up after 120 s).

The tool was first called `codara_preview_code`; it was renamed before any
release, with no alias. It is the one browser tool outside the
`codara_preview_` prefix, so the places that key on that prefix name it as
well: Cora's browser family (`tool-families.ts`), the worker roster and
fences (`worker-policy.ts`), and the MCP server's caller scoping
(`isBrowserRpc` in `server.js`).

## API, briefly

`browser`: `tab(id?)` (this session's own tab, or a listed one), `tabs()`,
`chrome.open(url)`, `chrome.status()`, `documentation()`, `call(tool, args)`
(any `codara_preview_*` tool by its short name, the escape hatch).

`Tab`: `goto`, `reload`, `back`, `forward`, `url`, `title`, `snapshot`,
`screenshot`, `evaluate(fn | string, arg)`, `find(description)`, `waitFor`,
`waitForURL`, `waitForLoadState`, `waitForTimeout`, `keyboard.press/type`,
`mouse.click/move/wheel`, `console`, `network` (list, get, waitForResponse,
har, clear), `cdp` (send, on, waitForEvent), `dialog`, `close`, and the
locator builders `locator(css)`, `getByRole`, `getByText`, `getByLabel`,
`getByPlaceholder`, `getByTestId`, `getByAltText`, `getByTitle`, `ref(@ref)`.
Shorthands `tab.click(sel)`, `tab.fill(sel, text)` and `tab.press(key)` take
an `@reference`, a CSS selector or a locator.

`Locator`: `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `check`,
`uncheck`, `selectOption`, `scrollIntoView`, `waitFor({ state })`, `count`,
`all`, `first`, `last`, `nth`, `filter({ hasText, visible })`, chained
`locator`/`getBy*`, `textContent`, `innerText`, `inputValue`,
`getAttribute`, `isVisible`, `isEnabled`, `isChecked`, `allTextContents`,
`allInnerTexts`, `boundingBox`, `evaluate(fn, arg)`, `describe`.

Locators are strict like Playwright's: an action on a locator that matches
several elements fails and lists the first few, unless `first()`, `last()` or
`nth()` narrows it. Actions wait up to 5 s (or `{ timeout }`) for the element
to exist; the existing click and type code then waits for it to be visible,
enabled and not covered.

## How it runs

```
agent ── MCP stdio ──▶ server.js ── agent socket ──▶ main: browser.use
                                                        │
                                   session manager ─────┤ one kernel per agent session
                                                        ▼
                         kernel worker thread: QuickJS (WebAssembly), 64 MB heap,
                         no fs, network, require, process or host objects
                           └─ the browser API (prelude.ts), JSON in and out
                               │ every API call is one message to main
                               ▼
                main: runPreviewTool(method, args + the caller's identity)
                (the same scoping, workspace, Chrome, block-list and
                dialog checks as a single tool call)
```

1. **Transform (main).** `src/main/browser/code/transform.ts` parses the
   snippet with acorn and rewrites top-level declarations into session
   globals and the last expression into a `return`, inside an async
   function. A syntax error comes back with its line and column.
2. **Kernel (worker thread).** The same sandbox shape as workflows
   (`workflow-sandbox-worker.ts`): `kernel-worker.ts` runs QuickJS compiled
   to WebAssembly in a worker thread started from source text with an empty
   environment. The guest has the JS built-ins, the browser API, `console`
   and timers, nothing else: no file system, network, `require`, `import`,
   `process` or host object. A 64 MB guest heap, a stack limit, and an
   interrupt for synchronous code that runs 5 s without awaiting. Unlike a
   workflow, the context lives on between snippets: that is the session.
   The host functions the API needs (`__cbCall`, `__cbSleep`, `__cbLog`,
   `__cbDone`) are captured by the prelude and deleted from the global
   object before any snippet runs, and they exchange strings only.
3. **Calls (main).** A guest call can only name a `preview.*` method, so
   never `browser.use` itself. Main adds the identity the outer call carried
   (`runId`, `workspaceId`, `callerPaneId`, `callerPid`), overriding anything
   the snippet passed, and calls `runPreviewTool`, the function the socket
   uses for every browser tool. Workspace scoping, a run's own tabs,
   `chrome:` tab access, the user's block list and the dialog guard all
   apply per call. Each call carries the id of the snippet that was running
   when the guest made it, and main answers only calls of the snippet it is
   waiting for. When a snippet ends or times out, the kernel drops every
   browser call and sleep it left waiting without settling them, so an
   unawaited loop or timer stays suspended for good and never acts while a
   later snippet runs. Inside the kernel, an error is cut at 4,000
   characters and a console line over 1 MB is dropped. `browser.use` itself is refused for an
   imported pull-request run. Cora's worker fences treat it like
   `codara_preview_evaluate`, and also block it whenever a worker's
   `blockedTools` names any other browser tool, since a snippet reaches
   every browser tool through `browser.call`.
4. **Sessions.** A session is keyed by the caller's resolved workspace, its
   run or pane, and a random id the MCP server process picks at startup, so a
   new agent session starts clean and two agents never share bindings, even
   in one pane. Snippets in one session run one at a time. A session ends
   when its agent's MCP process exits (checked every minute), after 20 idle
   minutes, on `reset`, or when the kernel thread dies (out of memory). A
   timeout stops the snippet and keeps the session's bindings. At most 16
   sessions live at once: the least recently used idle one goes first, and
   when all 16 are running a snippet a new session is refused.
5. **Locators.** `preview.locate` (main, any tab kind) resolves a locator
   chain in the page with `src/shared/preview-query.ts`, built on the shared
   `preview-locator.ts`, and returns the element's `@reference`. Actions
   then call the existing tools with that reference, so a locator click is
   exactly a `codara_preview_click`, with its visible, enabled and
   not-covered checks.
6. **Screenshots** stay in main: the guest gets `{ image: n }` and the
   pixels ride on the tool result as image blocks, at most six per call.

## DevTools access

`tab.network` and `tab.cdp` close the gap with a raw DevTools protocol
client for network debugging, without handing an agent the whole browser.

- `tab.network` wraps `codara_preview_network`: `list(filter)`, `get(id)`
  (headers, timings, initiator, request and response bodies),
  `waitForResponse(match)` (the next finished request after the call),
  `har()` and `clear()`. `tab.network(options)` still answers like the tool.
- `tab.cdp.send(method, params)` is one hidden `preview.cdp` call, and
  `tab.cdp.on(events)` a subscription (`preview.cdp_events`) read with
  `next({ filter, timeout })` or `take({ wait, max })` from a buffer of the
  latest 500 events (an event over 64 KB is replaced by a note). Subscribe
  before the action that fires the event. `waitForEvent(name)` is on, next
  and close in one call.

Both are ordinary `preview.*` calls on the tab's shared session
(`cdp-session.ts`), so workspace scoping, a run's own tabs, Chrome access,
the extension's own checks and the dialog guard apply to each, as for any
browser tool. `src/main/preview-tools/cdp.ts` adds:

- **An allowlist** (`src/main/browser/cdp-policy.ts`), by method, not by
  domain, so a protocol version that adds commands adds nothing callable:
  Network (bodies, search, cache and service-worker bypass, throttling, extra
  headers, blocked URLs, user agent, replay), Page (navigate, reload,
  history, frame and resource trees, resource content, layout metrics,
  lifecycle events, screenshot, isolated worlds), Runtime, DOM and CSS (read
  and edit), Accessibility, Overlay highlights, Performance metrics,
  Emulation, Log, and Debugger read-only (script sources and search).
  Everything allowed acts on the one tab and is no stronger than a browser
  tool that already exists.
- **Refusals with a reason**: Browser, Target, SystemInfo, IO, Tethering,
  Extensions, PWA and ServiceWorker reach past the tab or onto the machine;
  Storage reaches site data beyond the tab (`codara_preview_storage` covers
  the tab's own); profile-wide cookie and cache commands,
  `Network.loadNetworkResource` (any URL with the profile's cookies, past
  CORS), `Page.setDownloadBehavior`, `DOM.setFileInputFiles` and
  `DOM.getFileInfo` (files and paths on the machine), Security (ignoring
  certificate errors), Input (synthetic input would skip the visible cursor
  and the dialog guard), `Page.addScriptToEvaluateOnNewDocument` (it would
  keep running for whoever uses the tab next) and `Page.handleJavaScriptDialog`
  (the dialog guard answers dialogs). `Page.navigate` opens http, https and
  about:blank only: a file: page would hand Runtime the machine's files.
- **Parameters too.** No command may take `scriptToEvaluateOnLoad` (script
  in every frame, past the Runtime refusal in the user's Chrome) or
  `grantUniveralAccess` (a world that ignores the same-origin rules). The
  allowed commands that take a script, a URL or an access flag
  (`Page.navigate`, `Page.reload`, `Page.createIsolatedWorld`) accept only
  the parameters the policy names.
- **Fetch is refused on purpose.** `Fetch.enable` pauses every matching
  request until the client continues it, and a snippet's calls die with the
  snippet, so one that ends or times out would leave the tab hanging. In the
  user's Chrome it would also rewrite responses inside signed-in sessions.
  `Network.setBlockedURLs`, `Network.setExtraHTTPHeaders` and
  `Network.emulateNetworkConditions` cover blocking, adding headers and
  throttling, and the recorder already reads bodies.
- **Counted domains.** The session is shared with Codara's recorders, so a
  snippet's `Domain.enable` takes a counted hold and `Domain.disable` gives
  that hold back; `Network.disable` never stops the network recorder.
  Subscribing holds the event's domain. Holds and subscriptions belong to
  the code session that made them, so two agents in one pane never share
  them (code.ts passes the session key on a symbol that neither a snippet
  nor tool JSON can set; another session's subscription id reads as
  unknown). They end after 10 idle minutes, on close, or with the tab.
  The read-only Debugger is enabled with pauses skipped, so a `debugger;`
  statement never freezes the page.
- **Bounded results.** A command result over 1 MB is saved as a browser
  artifact and its path returned; a `Page.captureScreenshot` comes back as an
  image like `tab.screenshot()`.
- **The user's Chrome.** The extension relays commands through
  `chrome.debugger` with its own rules (blocked sites, the per-tab cookie and
  storage permission, child sessions refused), and main also redacts cookie
  and authorization headers from results and events, as
  `codara_preview_network` does there. The extension checks the tab's site,
  never the sites of frames inside it, and protocol script and DOM edits can
  pick any frame's context past the same-origin rules, so on a `chrome:` tab
  Runtime, Debugger, `Page.createIsolatedWorld`, `DOM.resolveNode` and DOM or
  CSS edits are refused: `tab.evaluate` runs in the page's top frame there.
  Reading the DOM, styles, accessibility tree and network stays open.
- **Workers.** The hidden `preview.cdp` tools are not in any roster, so an
  agent reaches them only through a snippet, and a Cora worker whose config
  blocks any browser tool (evaluate, network or any other) loses
  `codara_browser_use` and with it every DevTools command.

`scripts/test-browser-cdp-access.cjs` covers the policy and drives all of
this on a real Chromium page; `tests/e2e/browser-code.spec.ts` runs it in
the built app.

## Page model

The snapshot stays the DOM outline (`codara_preview_snapshot`), whose
`@references` every tool accepts and which already diffs with `since`.
`tests/e2e/browser-code.spec.ts` measures it against an accessibility-tree
snapshot of the same pages (CDP `Accessibility.getFullAXTree`, one line per
role and name, ignored and generic nodes left out):

| Page | Outline | AX tree, compact | AX tree, raw JSON |
|---|---:|---:|---:|
| Sign-in form | 496 chars | 407 chars | 13,014 chars |
| Customer form | 975 | 788 | 29,255 |
| 240-row table | 13,824 | 48,322 | 1,151,391 |
| Webmail with compose dialog | 1,370 | 2,047 | 46,118 |

The compact tree is a little shorter on small forms and three to four times
longer on a big page, and its lines carry no reference an action can use.
The outline stays the default; code mode makes the question smaller anyway,
since a snippet can read the rows it needs instead of a whole snapshot.

## Not in this change

- Several own tabs per session (the preview keeps one tab per agent; listed
  and Chrome tabs work by id).
- Per-turn cleanup hooks like OpenAI's `turn_ended`: MCP gives the server no
  turn boundary for Claude Code, so sessions end on process exit and idle
  time instead.
