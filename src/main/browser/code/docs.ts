// What browser.documentation() returns inside a codara_preview_code session:
// the whole API, read once per session, so the tool description stays short.
// Keep it in step with prelude.ts.

export const BROWSER_CODE_DOCS = `# Codara browser API (codara_preview_code)

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
- console({ level? }), network({ ... }), dialog({ accept?, promptText?, policy? })
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

## Habits that work
- Do a whole flow in one call: act, wait for the result, then return the
  snapshot (or snapshot({ diff: true })) or the few values you need.
- Prefer getByRole/getByLabel/getByText over CSS; use @references from a
  snapshot when the page has no good labels.
- A failed action throws a BrowserError saying why (not found, several
  matches, covered, disabled). Catch it to branch, or let it end the call.
- Return small values. Large results are cut at 60,000 characters.
- Bindings live until the session ends (the agent exits, 20 idle minutes,
  or reset: true). A timeout keeps the session; a loop that never awaits is
  interrupted after 5 s.
`;
