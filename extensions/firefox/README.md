# Codara for Firefox

A Manifest V3 extension for Firefox 153 and later. It does for Firefox what
[the Chrome extension](../chrome/README.md) does for Chromium browsers: the
agents you run in Codara use the tabs you share, with your signed-in
sessions, through the same `codara_preview_*` tools. Pairing, the popup, the
blocked sites, the per-tab cookie switch and the log in Codara are the
same; what Firefox cannot do is listed below and refused with the reason.

This folder holds only what differs from Chrome (`manifest.json`,
`background.js`, `access.js`, `lib/firefox.js`, `lib/page-tools.js`). The popup, the options page, the icons
and the link, policy and presence code are the Chrome extension's own files,
listed in `shared.json` and copied in by the assembly, which never writes to
`extensions/chrome`. A shared file that needs other words in Firefox gets a
text patch in `shared.json`; if the Chrome file no longer has that text the
assembly fails instead of shipping Chrome's wording.

## Install (a developer install)

In Codara: Settings > Browser > Firefox walks through these steps. Its folder
is this version's, assembled into Codara's home
(`<codara home>/firefox-extension/<version>/`, by
`src/main/browser/firefox-extension.ts`) the first time Copy path or Reveal
folder is pressed, and never rewritten or deleted: a newer Codara assembles
its version beside it. So each version's files are recorded in
`versions.json`, and the tests fail when the add-on's files (the Chrome files
it shares included) change under the same version: raise `version` in
`manifest.json` and run `node extensions/firefox/build/assemble.mjs
--record-version`. From a checkout:

1. `node extensions/firefox/build/assemble.mjs` writes the extension to
   `extensions/firefox/dist/extension/`.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
   Add-on** and pick `manifest.json` in that folder. Firefox removes a
   temporary add-on when it restarts, so load it again after each restart;
   Codara's Settings shows the browser as paired but not connected, with
   these steps. Removing it can take the add-on's storage with it (its
   pairing, blocked sites and ports): Connect to Codara then pairs it again,
   and Disconnect in Codara's Settings forgets the old pairing.
3. Click the Codara button in the toolbar, **Connect to Codara**, and allow
   the same six-digit code in Codara.
4. Share a tab with its switch, or pick **This window** or **Everything**.

To keep it across restarts, Firefox Developer Edition, Nightly or ESR can
install it unsigned once `xpinstall.signatures.required` is turned off in
`about:config` (Mozilla's [signing
overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)):
zip the folder's contents and choose **Install Add-on From File** in
`about:addons`. Release Firefox installs only add-ons Mozilla signed, and
this one is not on addons.mozilla.org: Mozilla allows the `userScripts` API
it runs on for user script managers only (decided 19 Nov 2026: a developer
install only for now; see `LISTING.txt` in the pack PR).

## How it connects

The same link as Chrome's (`lib/link-client.js`, shared): a WebSocket to
`ws://127.0.0.1:47615-47619/codara-chrome`, an ECDH pairing with a code both
sides show, proofs both ways on every later connect, and AES-GCM frames
after the handshake. Codara accepts the `moz-extension://<uuid>` origin;
Firefox draws that uuid per profile, so a pairing binds to the uuid it was
made with and a token copied to another profile is refused.

Firefox has no service workers for extensions: the background is an event
page. Two things differ from Chrome, both measured (see below):

- Firefox's default MV3 policy adds `upgrade-insecure-requests`, which turns
  `ws://127.0.0.1` into `wss://` and the connection fails (close code 1015).
  The manifest sets `extension_pages` to `script-src 'self'`.
- Traffic on the WebSocket does not keep an event page alive: Firefox
  unloads it after its idle timeout and the socket closes (code 1001). While
  connected, the page makes one call into the browser every 10 seconds
  (`runtime.getPlatformInfo()`), which resets the idle timer, and an alarm
  every 30 seconds reconnects if the page was unloaded anyway.

## How agents act without a debugger

Firefox gives extensions no debugger and no DevTools protocol. Codara's
tools speak that protocol, so the extension answers Codara's `cdp` requests
itself for the commands it can honour and lists them in its hello
(`extension.capabilities.cdp`). Codara refuses any other command before it
is sent, with a plain "`<method>` is not available in Firefox" error, so an
agent learns at once what to do instead.

## What works

Measured on Firefox 158.0 and on ESR 153.7.0 (Linux, headless) on 18
November 2026 with a spike extension and a fake Codara: every measured row
below gave the same result on both. The end-to-end spec
(`tests/e2e/firefox-extension.spec.ts`) checks the rows marked *e2e* on
every pull request, on the current Firefox and on ESR 153 (CI (Linux)); it
also passed locally on Firefox 158.0, 160.0.1 and ESR 153.7.0.
"Not yet" rows come in the next pull requests of this stack; until then Codara refuses them with the reason.

| Capability | Status | How, and what was measured |
|---|---|---|
| Pair, reconnect, unpair | Works (e2e) | Same link as Chrome; moz-extension origin bound at pairing. |
| Share one tab, a window, everything; blocked sites; browser pages refused | Works (e2e) | Popup shared with Chrome. Firefox pages (about:blank too: a page can write into one), local files and Mozilla's add-on and account sites are never shared. Blocked sites written in Unicode match the punycode hosts in tab URLs. Only the popup and the options page can steer the extension, one action at a time. |
| Stay connected while idle | Works (e2e) | Spike: a WebSocket alone was unloaded at the idle timeout (close 1001, at 4 s and at 25 s timeouts); `storage.local.get` per ping did not help; one `runtime.getPlatformInfo()` per ping held 80 s at Firefox's default 30 s. An alarm wakes an unloaded page and it reconnects. The e2e holds the link 40 s at a 15 s timeout with the 10 s keep-alive, and fails with it removed. |
| Refuse what Firefox cannot do, with the reason | Works (e2e) | Codara reads the hello's command list. |
| Read the page, click and type with the default tools, run an agent's script | Works (e2e) | `userScripts.execute` in the page's main world (`lib/page-tools.js`): works on a page with `default-src 'none'` and Trusted Types, sees page globals, awaits promises. Firefox returns a thrown error, and a script that does not compile, as an empty error, so the expression runs once inside a wrapper that returns its value or what it threw, as Chrome's DevTools protocol gives them. Codara sends one expression (its evaluate tool wraps statements itself, deciding which in Codara: a strict page forbids `new Function`). Needs the site and Firefox's `userScripts` permission ("unverified third-party scripts"), each asked from the popup. The script is bound by its document id to the document checked (shared, not blocked), so Firefox refuses to run it anywhere else, a reload included, and a guard that runs first as its own script stops it if that document changed address meanwhile (measured: a throwing first script stops the ones after it, on ESR 153 and 160); its answer leaves only while the tab is still shared. As in Chrome's DevTools evaluate, the agent's code has the page's own reach (a same-origin frame or opener included). Differs from Chrome: the page does not count the script as a user gesture. The e2e reads, types into and clicks a strict page, and checks the declined-permission errors. |
| Screenshots of background tabs, full page | Works (e2e) | `tabs.captureTab`, with `rect` for a full page; `Page.getLayoutMetrics` from a script that only measures (`scripting`, no install prompt line). `captureTab` exists only with access to all sites (`captureTab is not a function` with one site), so screenshots ask for all sites. A capture taken while the tab went to another page is dropped. The e2e captures a background tab, whole. |
| Navigate, page-load events, the frame tree | Works (e2e) | `tabs.update`, no site access needed (`lib/navigation.js`). The address is checked right before Firefox loads it (web pages only, never a blocked site or a page Firefox keeps extensions off); the answer waits for the commit, Firefox's error page or the fragment reached (only after a load started since it was asked; at most 25 s for the whole answer, else an error; a second navigate of the tab while one is on its way is refused, since overlapping loads cannot be told apart; a port Firefox refuses starts no load, so it ends at that limit), and a redirect to a blocked site lets the tab go. Events come from `tabs.onUpdated`, from `Page.enable` on, for a shared tab not on a blocked site: measured on ESR 153 and 160, a new document reports `loading`, then `loading` with its address at commit, then `complete` at its load event (a slow image holds it); a #fragment or `pushState` reports one address change with the tab's status (`loading` while the page still loads), so only the first address change after a load starts is a new document; Firefox's error page reports `complete` with the address and no loading commit (after a load that ended uncommitted, or on another site), so navigate answers it as a failed load and no event names it or says it loaded; a #fragment there only moves the error page's address (measured), so until a new page commits it is answered as the same failed load; navigating to the very address a tab already shows answers at once only for a page the extension saw load, and loads it again otherwise. Differs from Chrome: no DOMContentLoaded (navigate waits for the load event), the error text does not say why, and the frame tree lists the tab's own page only (Firefox lists frames to the `webNavigation` permission, which would add an install question). The e2e waits for a slow load of a page that changes its route while loading, refuses a second navigate before the first commits, moves to a fragment, and checks an unreachable server, a blocked site and a redirect to one. |
| Open and close tabs, tab groups | Not yet; measured | `tabs.group` and `tabGroups` exist in Firefox 158 and ESR 153. Until then opening a tab is refused, the extension tells Codara it cannot open tabs, and the popup hides "Open new tabs in a group". |
| Console | Works (e2e) | `console-hook.js`, a content script registered for document start on the sites the user let the extension use (`lib/console.js`). It wraps the page's console methods with `exportFunction` (each still logs) and listens for Firefox's own uncaught-error events (a page's made-up ones say `isTrusted: false`, measured); it works on a page with `default-src 'none'` (measured on 160). It sends only while the extension says the tab is attached, shared, not on a blocked site and Codara asked (`Runtime.enable`), and the background checks each entry's tab again, and drops an entry whole when its call site or a frame of its error stack is on a blocked site (a same-origin frame on a blocked path can call the page's console); while the tab is attached and shared before that, it keeps the last 50 for the replay, never one logged before the tab's current attachment began, and forgets them when sharing ends. At most 100 entries a second are described, in the page and again per tab in the background. Values are described without running page code (logged values reach the hook as Xrays that show data properties only: no getter or `toJSON` ran, measured), by a bounded walk (depth 4, 100 items, 10 000 characters, 20 arguments); the calling line comes from the hook's own stack, which lists the page's frames (measured), not from the page's `Error`. Differs from Chrome: Firefox's own messages (security, network, CSP) and frames' consoles are missing, objects come as JSON text, not previews. The e2e reads a log, a warning and an uncaught error from the first script of a strict page. |
| Network log with headers | Works (e2e) | `webRequest` (no line in the install question, measured), `lib/network.js`: request headers, redirects (one request id across hops, as measured), status line, response headers, address, cache flag, failures. Only for a tab attached, shared where it is now (a tab moved out of a shared window stops at once) and with `Network.enable`; never a request to a blocked site (stricter than Chrome, which lists a page's requests to any site), nor one from a page or frame on one. A redirect to a blocked site, or to a site the extension may not use (Firefox reports nothing there), ends that request as failed. Cookie and Set-Cookie headers are removed unless the tab's cookie switch is on, by the same code as Chrome (`redactCdpEvent`). Firefox tells an extension only about requests to sites it may use, so with one site allowed the log shows that site's requests; other sites' need all sites. Differs from Chrome: no initiator, no timing, no transfer sizes. The e2e reads a strict page's fetches and a redirect, and checks that no cookie leaves, a redirect's Set-Cookie included. |
| Response bodies | Works (e2e), text only | `webRequest.filterResponseData` copies the body as the page gets it, only for requests in the log of an attached, shared tab Codara records (`lib/bodies.js`); a tab that leaves what is shared stops the copy at once; the page gets every byte first. Only text responses an agent reads are copied: pages, frames, fetch/XHR, scripts, style sheets and other text, decided from the response's own text `Content-Type` (none said: not kept); never images (SVG included), media, fonts, websockets or downloads (any `Content-Disposition` other than `inline`), which Codara is told are not kept. The blocking listener is registered per recorded tab, from `Network.enable` to its end. A body is given only once its row reached Codara and Firefox reported the request completed, and its request is checked again as the log checks it (site, page, origin, frames, the site access still granted); a change to the blocked sites or the site access drops kept bodies. Measured: gzip already decoded, binary as is, a cached load too; a redirect's hop has none; a body can end after `onCompleted`, so `Network.getResponseBody` waits up to 10 s (8 reads at once). The answer is built only when its turn to leave on the link comes, and checked again then and once sealed (the link ends rather than send it if access ended meanwhile). Text comes in its charset. At most 5 MB per body (Codara's cap for Chrome): past it the filter lets go (`disconnect()`) and Firefox carries the rest of the transfer itself, and Codara is told the body is over 5 MB. 20 MB and 1000 bodies in all, counted in 64 KB blocks (oldest dropped first, and their filter lets go), forgotten with the tab, `Network.disable` or detaching. If the filter fails, Codara gets "Body not available: the transfer failed", never part of a body. The filter needs `webRequestBlocking` and `webRequestFilterResponse` granted at install: granted later, it did not start (measured); neither adds a line to the install question. **Known limit (measured on Firefox 160 and ESR 153):** on a tab being recorded, a text response under 5 MB that breaks mid-transfer can look complete to the page (a fetch read 400 of 800 bytes as a success; Firefox's filter cannot pass the failure on). Past the cap the page sees the failure as usual (measured on both). Codara never gets a cut body. The e2e covers all three cases. |
| Cookies and site storage, behind the per-tab switch | Works (e2e), as in Chrome | With the tab's "Read and change cookies and storage here" switch on: `Network.getCookies` from `cookies.getAll` (`lib/cookies.js`), HttpOnly included (measured; Codara keeps HttpOnly values redacted), from the tab's own cookie store (a container or a private window keeps its own; a tab whose store Firefox does not name is refused, never read from the default store); local and session storage read and changed through the page, as in Chrome. Cookies only of the tab's own host and scheme (an http page gets no Secure cookie): Firefox gives extensions no list of public suffixes, so a domain above or below it cannot be told from another site (`a.github.io`, `github.io`); never a URL with credentials, a blocked site or path (a returned cookie of a blocked parent domain or path is left out), or a browser page; Firefox's site access is checked too. The switch, attaching, sharing, the blocked sites, the tab's page and window, site access and the link are checked before the read, after it and when the answer leaves; any change in between, even one undone, refuses it. Changes are stamped per tab (its page, window, attaching, sharing, switch), per window (sharing it) and for all tabs (sharing everything, the blocked sites, site access given or taken back, not scripts in pages, the link), in `lib/access-clock.js`; a read notes the time before its first look at the tab and holds to that look: every later look must find the same view of the tab (its id, window, address and cookie store), and so must the newest view any other request's lookup found, until the answer is sealed, since Firefox may answer a lookup with a move before its event comes (and a lookup answered late never replaces a newer view): another tab loading, moving or closing, or another window shared or closed, does not end the read, and a unit test drives the background page in a fake Firefox to check that every listener that changes access moves the stamp. As in Chrome, Codara never changes or clears cookies, IndexedDB or caches in the user's own browser: Codara refuses those itself, and the extension refuses `Network.setCookie`, `deleteCookies`, `Storage.clearDataForOrigin` and the like with that reason. Network events carry cookie headers only with the switch on. |
| Agent's pointer, glow, Stop | Not yet; measured | Content script world, closed shadow root, constructed style sheet: drawn on a page with `default-src 'none'`. It shows in `captureTab`, so captures hide it, as in Chrome. |
| Mouse, hover, scroll, drag, keys, file upload | Works (e2e), degraded | No trusted input for extensions. Codara plays the same events as a script in the page (`src/main/browser/scripted-input.ts`), through the page's own world, so it works on a strict page: pointer and mouse events in order with hit-testing through open shadow roots and same-site frames, focus on press, click/dblclick/contextmenu, the wheel scrolling what is under it, HTML drag and drop on a draggable element, keys with their legacy `keyCode`, typing into the focused field, Backspace/Delete, Enter sending its form, Space pressing a button, Tab moving focus. Upload reads the files in Codara and sets them on the input as `File` objects, at most 10 MB in all. Each answer of the extension names the document it ran in, and an evaluate that asks for one runs only there: a replay found by selector, and the script carrying an upload's bytes, run only in the page the element was found in, never in one that replaced it. The page sees `isTrusted: false`, gets no `:hover`, no native menu, select popup or file dialog, and a frame of another site is out of reach; every answer says `trusted: false` with that note. |
| Emulation, throttling, tracing, heap, PDF, raw `tab.cdp` | Not available | No extension API in Firefox. Refused with the reason. |

NOT TESTED: background-tab screenshots in a visible or minimized window
(only headless); macOS and Windows; how addons.mozilla.org review treats
`userScripts`; the alarm's minimum period in a signed build; the permission
questions from the real toolbar popup (the e2e opens the popup as a tab and
answers Firefox's own question; a real popup may close when the question
shows, which is why the background records the question before it is asked); a navigation the user or the page starts while an agent's navigate waits, or a route change the old page makes in the moment between the new load's start and its commit (Firefox's tab changes carry no document identity, and telling them apart would need site access): either can answer that navigate.

## Permissions

At install: `tabs`, `storage`, `cookies`, `alarms`, `scripting`,
`webRequest`, `webRequestBlocking` and `webRequestFilterResponse` (only
`tabs` has a line in Firefox's install question, checked by the e2e: the
others do nothing without site access; nothing is ever blocked, the body
filter only copies, and cookies are read only behind the per-tab switch). Nothing
else is asked at install. The rest is asked from a click in the popup,
under "Firefox needs your OK", with one sentence each (`access.js`):

| Asked for | When | Without it |
|---|---|---|
| The tab's site (`http://host/*`, no port: Firefox's patterns take none) | Turning on "share this tab", or its button | Agents get "the user did not allow Codara to use <site>" |
| `userScripts` | Its button. Firefox refuses it together with any other permission, so it is always its own question | Agents cannot read or act on pages, with a plain error |
| All sites | Its button; with "This window" or "Everything" it replaces the per-site question | Screenshots fail with a plain error |

Firefox asks only when `permissions.request` is called from a click before
anything is awaited. The extension remembers each question it asked
(`asked`, forgotten once Firefox grants it): after a no, sharing a tab does
not ask again by itself; only the button does, and the error agents get
says the user declined.

## Development

```sh
node extensions/firefox/test/run.mjs          # firefox rules, manifest, assembly
node extensions/firefox/build/assemble.mjs    # dist/extension/
npm test -- firefox                           # the above plus Codara's side
CODARA_E2E_REQUIRE_FIREFOX=1 npx playwright test tests/e2e/firefox-extension.spec.ts
```

The e2e spec runs Firefox headless on a throwaway profile, installs the
assembled extension as a temporary add-on over WebDriver BiDi (the test's
remote control only; the extension never uses it) and pairs it with a test
Codara on a port of its own. `CODARA_E2E_FIREFOX` points it at another
Firefox binary; `CODARA_E2E_COLOR_SCHEME=dark` takes the popup screenshots
dark.
