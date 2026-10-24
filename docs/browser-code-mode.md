# Browser code mode (`codara_preview_code`)

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

`codara_preview_code { code, timeoutMs?, reset? }`, socket method
`preview.code`.

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

The name keeps the `codara_preview_` prefix on purpose: Cora's browser
family, the worker fences and the Capability Center all key on it.

## API, briefly

`browser`: `tab(id?)` (this session's own tab, or a listed one), `tabs()`,
`chrome.open(url)`, `chrome.status()`, `documentation()`, `call(tool, args)`
(any `codara_preview_*` tool by its short name, the escape hatch).

`Tab`: `goto`, `reload`, `back`, `forward`, `url`, `title`, `snapshot`,
`screenshot`, `evaluate(fn | string, arg)`, `find(description)`, `waitFor`,
`waitForURL`, `waitForLoadState`, `waitForTimeout`, `keyboard.press/type`,
`mouse.click/move/wheel`, `console`, `network`, `dialog`, `close`, and the
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
agent ── MCP stdio ──▶ server.js ── agent socket ──▶ main: preview.code
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
3. **Calls (main).** A guest call can only name a `preview.*` method, not
   `preview.code` itself. Main adds the identity the outer call carried
   (`runId`, `workspaceId`, `callerPaneId`, `callerPid`), overriding anything
   the snippet passed, and calls `runPreviewTool`, the function the socket
   uses for every browser tool. Workspace scoping, a run's own tabs,
   `chrome:` tab access, the user's block list and the dialog guard all
   apply per call. A call made after its snippet ended (an unawaited timer)
   is refused. `preview.code` itself is refused for an imported pull-request
   run, and Cora's worker fences treat it like `codara_preview_evaluate`.
4. **Sessions.** A session is keyed by the caller's resolved workspace, its
   run or pane, and a random id the MCP server process picks at startup, so a
   new agent session starts clean and two agents never share bindings, even
   in one pane. Snippets in one session run one at a time. A session ends
   when its agent's MCP process exits (checked every minute), after 20 idle
   minutes, on `reset`, or when the kernel thread dies (out of memory). A
   timeout keeps the session: main stops waiting and refuses the late calls.
   At most 16 sessions live at once; the least recently used idle one goes
   first.
5. **Locators.** `preview.locate` (main, any tab kind) resolves a locator
   chain in the page with `src/shared/preview-query.ts`, built on the shared
   `preview-locator.ts`, and returns the element's `@reference`. Actions
   then call the existing tools with that reference, so a locator click is
   exactly a `codara_preview_click`, with its visible, enabled and
   not-covered checks.
6. **Screenshots** stay in main: the guest gets `{ image: n }` and the
   pixels ride on the tool result as image blocks, at most six per call.

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
