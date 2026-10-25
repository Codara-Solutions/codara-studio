// What browser.documentation() returns inside a codara_browser_use session:
// the whole API, read once per session, so the tool description stays short.
// Keep it in step with prelude.ts.

export const BROWSER_CODE_DOCS = `# Codara browser API (codara_browser_use)

Your code runs with top-level await in a persistent session. Top-level const,
let, var, function and class declarations stay defined for your next call
(redeclaring replaces them). The last expression, or a return, is the result;
console.log lines come back too. There is no Node, fs, fetch or import: only
the browser API below, console, timers and plain JavaScript.

Typical first call:
  const tab = browser.tab();               // this session's own tab
  await tab.goto("http://localhost:5173");
  await tab.snapshot();                    // outline with @references

## browser
- browser.tab(id?) -> Tab. No id: this session's own tab (opened by the first
  goto). An id from browser.tabs() or "chrome:<id>" drives that tab.
- await browser.tabs() -> [{ id, kind, title, url, group, isActive }]
- await browser.chrome.status(); await browser.chrome.open(url, { group }) -> Tab
  (the user's own Chrome, through the Codara extension; blocked sites refuse)
- await browser.call("audit", { kind: "accessibility" }): any codara_preview_*
  tool by its short name, with the same arguments
- sleep(ms), setTimeout, setInterval, clearTimeout

## Tab
- goto(url, { waitUntil?: "load" | "domcontentloaded" | "networkidle", group? })
- reload(), back(), forward(), url(), title(), close()
- snapshot({ selector?, maxBytes?, diff? }) -> text outline. Elements carry
  @references usable as selectors. diff: true returns only what changed since
  this tab's previous snapshot.
- screenshot({ selector?, fullPage?, clip?: { x, y, width, height }, format?,
  quality?, maxWidth?, scale? }) -> metadata (path, size, scale); the image
  itself is attached to the tool result (at most 6 per call)
- evaluate(fn, arg) runs fn(arg) in the page and returns its JSON value;
  evaluate("document.title") takes an expression string
- find("the search button") -> ranked matches with @references
- waitFor({ text?, selector?, state?, url?, navigation?, load?, stableMs?, hmr?,
  fresh?, timeout? }): all conditions must hold; text and url accept /regex/
- waitForURL(url | /re/), waitForLoadState(state), waitForTimeout(ms)
- keyboard.press("Enter" | "Control+K" | "a"), keyboard.type("text") (trusted keys
  to the focused element)
- mouse.click(x, y, { button?, clickCount?, modifiers? }), mouse.move(x, y),
  mouse.down/up(x, y), mouse.wheel(dx, dy, { selector? | x, y })
- console({ level? }), dialog({ accept?, promptText?, policy? })
- network and cdp: see "Network and DevTools" below
- click(target), fill(target, text), press(key) or press(target, key): target is
  an @reference, a CSS selector or a Locator
- Locators: locator(css), getByRole(role, { name?, exact?, checked?, level?,
  includeHidden? }), getByText(text), getByLabel(text), getByPlaceholder(text),
  getByAltText(text), getByTitle(text), getByTestId(id), ref("@abc-12")
  Text arguments match a case-insensitive substring; { exact: true } or a
  /RegExp/ is stricter. Role, text, label, placeholder, alt and title locators
  only see visible elements unless { includeHidden: true }.

## Locator
Actions wait up to 5 s for the element ({ timeout: ms } changes it) and fail
when the locator matches several elements: narrow it or use first(), last(),
nth(i).
- click({ button?, clickCount?, modifiers?, trusted? }), dblclick(), hover()
- fill(text) replaces the value, type(text) appends, press(key)
- check(), uncheck(), setChecked(bool), selectOption(value | { label } | { index })
- focus(), scrollIntoView(), waitFor({ state: "visible" | "hidden" | "attached" | "detached" })
- count(), all() -> [Locator], first(), last(), nth(i),
  filter({ hasText?, hasNotText?, visible? }), chained locator()/getBy*()
- textContent(), innerText(), inputValue(), getAttribute(name), isVisible(),
  isEnabled(), isChecked(), boundingBox(), allTextContents(), allInnerTexts()
- evaluate((el, arg) => ..., arg), evaluateAll((els, arg) => ..., arg)
- describe() -> { ref, selector, role, name, text, box }, screenshot()

## Network and DevTools
tab.network reads what the tab requested since it opened (up to 500 rows):
- network.list({ filter?, type?: "xhr,fetch", status?: 404 | "4xx" | ">=400",
  failed?, limit? }) -> [{ id, method, status, type, url, ms, bytes, ... }]
- network.get(id, { body?, redact? }) -> headers, timings, initiator, request
  and response bodies (long bodies are cut; the full text is saved at path)
- network.waitForResponse(urlPart | /re/ | fn, { timeout?, detail?, body? }):
  the next finished request after the call, in detail
- network.har({ filter?, ..., body?, redact? }) -> { har: path, entries }
- network.clear(). Cookie and authorization values are redacted unless
  redact: false (always redacted in the user's own Chrome).

tab.cdp speaks the DevTools protocol to this tab, for what the tools above
do not cover:
- await cdp.send("CSS.getComputedStyleForNode", { nodeId }) -> the result.
  A result over 1 MB is saved to a file ({ path, chars }); a
  Page.captureScreenshot comes back as an image like tab.screenshot().
- const sub = await cdp.on("Network.responseReceived" | [names]) subscribes
  (subscribe BEFORE the action that fires the event); then
  await sub.next({ filter: (params) => ..., timeout? }) -> { method, params } or
  null, await sub.take({ wait?, max? }) -> [events], await sub.close().
  The buffer keeps the latest 500 events; idle subscriptions end after
  10 minutes.
- await cdp.waitForEvent(name, { filter?, timeout? }) -> params, for an event
  that comes on its own later.
- Domain.enable and Domain.disable are counted per caller, so Codara's own
  recorders keep running; subscribing enables the event's domain for you.
  Network, Page, Runtime and Log are always on.
Allowed: Network (bodies, search, cache, throttling, extra headers, blocked
URLs, user agent), Page (navigate to http/https, reload, history, frame and
resource trees, resource content, layout metrics, lifecycle events,
screenshot), Runtime (evaluate, callFunctionOn, properties, heap usage), DOM
and CSS (read and edit nodes, attributes and styles), Accessibility, Overlay
highlights, Performance.getMetrics, Emulation, Log, and Debugger read-only
(script sources and search; the page never pauses).
On a chrome: tab (the user's own Chrome) Runtime, Debugger and DOM or CSS
edits are refused too: use tab.evaluate there.
Refused: Browser, Target, SystemInfo, IO, Storage, Fetch, Input, Security,
ServiceWorker, cookies (use codara_preview_storage), downloads, file inputs
(use codara_preview_upload), Page.addScriptToEvaluateOnNewDocument,
scriptToEvaluateOnLoad and grantUniveralAccess parameters, and breakpoints. A refused call throws a BrowserError that says why.
Settings you change (throttling, headers, emulation) stay on the tab until
you change them back.

## Habits that work
- Do a whole flow in one call: act, wait for the result, then return the
  snapshot (or snapshot({ diff: true })) or the few values you need.
- Prefer getByRole/getByLabel/getByText over CSS; use @references from a
  snapshot when the page has no good labels.
- A failed action throws a BrowserError saying why (not found, several
  matches, covered, disabled). Catch it to branch, or let it end the call.
- Return small values. Large results are cut at 60,000 characters.
- Bindings live until the session ends (the agent exits, 20 idle minutes,
  or reset: true). A timeout stops the snippet and keeps the session; a loop
  that never awaits is interrupted after 5 s. Await what you start: timers and
  calls still waiting when a snippet ends never run.
`;
