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

## Install (temporary add-on, for now)

1. `node extensions/firefox/build/assemble.mjs` writes the extension to
   `extensions/firefox/dist/extension/`.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
   Add-on** and pick `manifest.json` in that folder. Firefox forgets a
   temporary add-on when it quits; a signed build from addons.mozilla.org
   will replace this step.
3. Click the Codara button in the toolbar, **Connect to Codara**, and allow
   the same six-digit code in Codara.
4. Share a tab with its switch, or pick **This window** or **Everything**.

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
| Navigate, page-load events, the frame tree | Works (e2e) | `tabs.update`, no site access needed (`lib/navigation.js`). The address is checked right before Firefox loads it (web pages only, never a blocked site or a page Firefox keeps extensions off); the answer waits for the commit, Firefox's error page or the fragment reached (only after a load started since it was asked; at most 25 s for the whole answer, else an error; a second navigate of the tab while one is on its way is refused, since overlapping loads cannot be told apart; a port Firefox refuses starts no load, so it ends at that limit), and a redirect to a blocked site lets the tab go. Events come from `tabs.onUpdated`, from `Page.enable` on, for a shared tab not on a blocked site: measured on ESR 153 and 160, a new document reports `loading`, then `loading` with its address at commit, then `complete` at its load event (a slow image holds it); a #fragment or `pushState` reports one address change with the tab's status (`loading` while the page still loads), so only the first address change after a load starts is a new document; Firefox's error page reports `complete` with the address and no loading commit (after a load that ended uncommitted, or on another site), so navigate answers it as a failed load and no event names it or says it loaded. Differs from Chrome: no DOMContentLoaded (navigate waits for the load event), the error text does not say why, and the frame tree lists the tab's own page only (Firefox lists frames to the `webNavigation` permission, which would add an install question). The e2e waits for a slow load of a page that changes its route while loading, refuses a second navigate before the first commits, moves to a fragment, and checks an unreachable server, a blocked site and a redirect to one. |
| Open and close tabs, tab groups | Not yet; measured | `tabs.group` and `tabGroups` exist in Firefox 158 and ESR 153. Until then opening a tab is refused, the extension tells Codara it cannot open tabs, and the popup hides "Open new tabs in a group". |
| Console | Not yet | Page script from document start; misses Firefox's own security and network messages. |
| Network log with headers, response bodies | Not yet; measured | `webRequest` events carry tab ids and headers; `filterResponseData` returned bodies in MV3. Needs access to the site. |
| Cookies, HttpOnly included, behind the per-tab switch | Not yet; measured | `cookies.getAll` read an HttpOnly cookie. |
| Agent's pointer, glow, Stop | Not yet; measured | Content script world, closed shadow root, constructed style sheet: drawn on a page with `default-src 'none'`. It shows in `captureTab`, so captures hide it, as in Chrome. |
| Trusted input (mouse, keys, drag) | Not yet; will be degraded | No extension API. Scripted events with the full event sequence; the page sees `isTrusted: false` (measured). Tools say so. |
| Emulation, throttling, tracing, heap, PDF, raw `tab.cdp` | Not available | No extension API in Firefox. Refused with the reason. |

NOT TESTED: background-tab screenshots in a visible or minimized window
(only headless); macOS and Windows; how addons.mozilla.org review treats
`userScripts`; the alarm's minimum period in a signed build; the permission
questions from the real toolbar popup (the e2e opens the popup as a tab and
answers Firefox's own question; a real popup may close when the question
shows, which is why the background records the question before it is asked); a navigation the user or the page starts while an agent's navigate waits, or a route change the old page makes in the moment between the new load's start and its commit (Firefox's tab changes carry no document identity, and telling them apart would need site access): either can answer that navigate.

## Permissions

At install: `tabs`, `storage`, `alarms` and `scripting` (no line in
Firefox's install prompt: it does nothing without site access). Nothing
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
